import { randomUUID } from "node:crypto";
import { invalidInput, PaymentError, TilcaiError } from "./errors.js";
import type { Http } from "./http.js";
import {
  DESTINATION_NETWORK,
  resolveEvmNetwork,
  resolveStellarNetwork,
  type Environment,
  type EvmNetworkInfo,
  type NetworkAlias,
  type NetworkId,
} from "./networks.js";
import { typedDataArgs, type EvmSigner } from "./signers.js";
import { isEvmAddress, isStellarAccount, isStellarContract } from "./strkey.js";
import type { CreatedPayment, Payment, PaymentAuthorization, PaymentMode, PaymentView, Quote, UnsignedCall } from "./types.js";
import { webauthnPayload, type WebAuthnAssertion } from "./webauthn.js";

const enc = encodeURIComponent;

export interface QuoteInput {
  /** Source network: CAIP-2 or alias (`"avalanche"`, `"monad"`). */
  source: NetworkId | NetworkAlias;
  /** Destination Stellar network. Defaults to the environment's (`stellar:testnet` / `stellar:pubnet`). */
  destination?: NetworkId | NetworkAlias | undefined;
  /** Decimal string, what the merchant receives: `"1.25"`. */
  amount: string;
  /** Stellar `G…` account (or `C…` contract) that receives the USDC. */
  payTo: string;
}

export interface CreatePaymentInput {
  quoteId: string;
  mode: PaymentMode;
  /** EVM address of the payer. Required for `external`, `gasless` and `account` (the account's address). */
  payer?: string | undefined;
  /** Your own order reference; it travels with the payment. */
  orderId?: string | undefined;
  /** Makes the call repeatable. Generated when absent: pass your own to resume after a crash. */
  idempotencyKey?: string | undefined;
}

export interface WaitOptions {
  /** Give up after this long (default 15 minutes: Circle's attestation can take minutes). */
  timeoutMs?: number;
  intervalMs?: number;
  /** Ask TilcAI to run a reconciliation step on every poll (the worker also does, on its own cadence). */
  reconcile?: boolean;
  signal?: AbortSignal;
  onUpdate?: (view: PaymentView) => void;
}

export interface PayOptions {
  /** Source network. */
  from: NetworkId | NetworkAlias;
  to?: NetworkId | NetworkAlias | undefined;
  amount: string;
  payTo: string;
  orderId?: string | undefined;
  idempotencyKey?: string | undefined;
  /**
   * How the payer authorizes. Give exactly one:
   *  - `signer`: an EVM wallet signs an EIP-3009 authorization (`gasless`: TilcAI's relayer pays the gas on both chains).
   *  - `passkey`: a smart account issued by TilcAI (`account` mode); `payer` is the account address.
   *  - `sendTransaction`: the payer's wallet broadcasts approve + burn itself (`external`, pays gas).
   */
  signer?: EvmSigner;
  passkey?: (challenge: { challenge: string; challengeBase64Url: string }) => Promise<WebAuthnAssertion | { response: WebAuthnAssertion }>;
  sendTransaction?: (call: UnsignedCall) => Promise<string>;
  /** Payer address: the account for `passkey`, the wallet for `sendTransaction`. `signer` supplies its own. */
  payer?: string | undefined;
  /** Last word before anything is signed. Return false to stop. */
  approve?: (quote: Quote) => boolean | Promise<boolean>;
  /** Pay even when TilcAI reports that `payTo` has no USDC trustline (the funds would not arrive). */
  allowUnreadyRecipient?: boolean;
  /** Wait for SETTLED (default true). With false, `pay` returns once the burn was handed over. */
  wait?: boolean | WaitOptions;
  signal?: AbortSignal;
}

export interface PayResult {
  quote: Quote;
  paymentId: string;
  mode: PaymentMode;
  view: PaymentView;
}

export class PaymentsApi {
  constructor(
    private readonly http: Http,
    private readonly environment: () => Environment,
  ) {}

  /** Quotes `amount` USDC from `source` to `payTo` on Stellar and checks the recipient's trustline. */
  async quote(input: QuoteInput): Promise<Quote> {
    const env = this.environment();
    const source = resolveEvmNetwork(input.source, env);
    const destination = input.destination ? resolveStellarNetwork(input.destination, env) : resolveStellarNetwork(DESTINATION_NETWORK[source.environment], env);
    assertPayTo(input.payTo);
    const r = await this.http.request<{ quote: Quote }>("POST", "/v1/crosschain/quotes", {
      body: { sourceNetwork: source.id, destinationNetwork: destination.id, amount: input.amount, payTo: input.payTo },
    });
    return r.quote;
  }

  async getQuote(quoteId: string): Promise<Quote> {
    return (await this.http.request<{ quote: Quote }>("GET", `/v1/crosschain/quotes/${enc(quoteId)}`)).quote;
  }

  async create(input: CreatePaymentInput): Promise<CreatedPayment> {
    if (input.payer !== undefined && !isEvmAddress(input.payer)) throw invalidInput(`payer must be an EVM address, got ${input.payer}`);
    const { status, body } = await this.http.requestWithStatus<Omit<CreatedPayment, "replayed">>("POST", "/v1/crosschain/payments", {
      body: { quoteId: input.quoteId, mode: input.mode, ...(input.payer ? { payer: input.payer } : {}), ...(input.orderId ? { orderId: input.orderId } : {}) },
      idempotencyKey: input.idempotencyKey ?? randomUUID(),
    });
    return { ...body, unsignedCalls: body.unsignedCalls ?? [], replayed: status === 200 };
  }

  get(paymentId: string): Promise<PaymentView> {
    return this.http.request<PaymentView>("GET", `/v1/crosschain/payments/${enc(paymentId)}`);
  }

  /** `gasless`: the EIP-3009 signature. `account`: the passkey assertion, or the finished ERC-1271 signature. */
  async submitAuthorization(
    paymentId: string,
    proof: { signature: string } | { webauthn: WebAuthnAssertion | { response: WebAuthnAssertion } },
  ): Promise<Payment> {
    const body = "signature" in proof ? { signature: proof.signature } : { webauthn: webauthnPayload(proof.webauthn) };
    return (await this.http.request<{ payment: Payment }>("POST", `/v1/crosschain/payments/${enc(paymentId)}/authorization`, { body })).payment;
  }

  /** `external`: the hash of the `depositForBurnWithHook` transaction the payer broadcast. */
  async submitBurn(paymentId: string, txHash: string): Promise<Payment> {
    return (await this.http.request<{ payment: Payment }>("POST", `/v1/crosschain/payments/${enc(paymentId)}/burn`, { body: { txHash } })).payment;
  }

  /** Runs one reconciliation step now. Safe to repeat: the CCTP nonce makes the mint idempotent. */
  async reconcile(paymentId: string): Promise<Payment> {
    return (await this.http.request<{ payment: Payment }>("POST", `/v1/crosschain/payments/${enc(paymentId)}/reconcile`, { body: {} })).payment;
  }

  /**
   * Polls until SETTLED. FAILED throws `PaymentError`; so does running out of time, with
   * `uncertain: true`: the money may still be in flight, so look the payment up again — never create another.
   */
  async wait(paymentId: string, opts: WaitOptions = {}): Promise<PaymentView> {
    const deadline = Date.now() + (opts.timeoutMs ?? 15 * 60_000);
    const interval = opts.intervalMs ?? 3000;
    let last = "";
    for (;;) {
      if (opts.signal?.aborted) throw opts.signal.reason;
      if (opts.reconcile) await this.reconcile(paymentId).catch(() => undefined);
      const view = await this.get(paymentId);
      const tag = `${view.payment.state}${view.payment.uncertain ? "!" : ""}`;
      if (tag !== last) {
        last = tag;
        opts.onUpdate?.(view);
      }
      if (view.payment.state === "SETTLED") return view;
      if (view.payment.state === "FAILED") {
        throw new PaymentError({
          status: 0,
          code: view.payment.failureCode ?? "PAYMENT_FAILED",
          message: `payment ${paymentId} failed${view.payment.lastError ? `: ${view.payment.lastError}` : ""}`,
          recovery: "CONTACT_OPERATOR",
          payment: view,
        });
      }
      if (Date.now() >= deadline) {
        throw new PaymentError({
          status: 0,
          code: "WAIT_TIMEOUT",
          message: `payment ${paymentId} is still ${view.payment.state} after the wait; its outcome is not known yet`,
          recovery: "RECONCILE",
          payment: view,
          uncertain: true,
        });
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  /**
   * The whole payment: quote → (approve) → create → authorize → wait for SETTLED.
   *
   * Before a wallet signs anything, the SDK checks that what it is asked to sign is this payment:
   * the source chain and its USDC, the payer as sender, TilcAI's router as receiver and exactly
   * the quoted burn amount. Nothing else is signed.
   */
  async pay(o: PayOptions): Promise<PayResult> {
    const env = this.environment();
    const modes = [o.signer ? "gasless" : null, o.passkey ? "account" : null, o.sendTransaction ? "external" : null].filter(Boolean);
    if (modes.length !== 1) throw invalidInput("pay() needs exactly one of: signer (gasless), passkey (account), sendTransaction (external)");
    const mode = modes[0] as "gasless" | "account" | "external";
    const payer = o.signer?.address ?? o.payer;
    if (!payer) throw invalidInput(`payer is required for ${mode} payments`);
    const source = resolveEvmNetwork(o.from, env);

    const quote = await this.quote({ source: source.id, destination: o.to, amount: o.amount, payTo: o.payTo });
    const isAccount = o.payTo.startsWith("G");
    if (isAccount && !quote.preflight.payToTrustline && !o.allowUnreadyRecipient) {
      throw new TilcaiError({
        status: 0,
        code: "RECIPIENT_NOT_READY",
        message: `${o.payTo} has no USDC trustline on ${quote.route.destination}: the payment would not arrive. Ask the recipient to add it, or pass allowUnreadyRecipient.`,
        recovery: "REVIEW_POLICY",
      });
    }
    if (o.approve && !(await o.approve(quote))) {
      throw new TilcaiError({ status: 0, code: "APPROVAL_DENIED", message: "the payment was not approved; nothing was signed", recovery: "REQUEST_APPROVAL" });
    }

    const created = await this.create({ quoteId: quote.id, mode, payer, orderId: o.orderId, idempotencyKey: o.idempotencyKey });
    const id = created.payment.id;

    if (mode === "gasless") {
      if (!created.authorization) throw new TilcaiError({ status: 0, code: "NO_AUTHORIZATION", message: "TilcAI returned nothing to sign for a gasless payment", recovery: "CONTACT_OPERATOR" });
      assertSignable({ quote, authorization: created.authorization, payer, source });
      const signature = await o.signer!.signTypedData(typedDataArgs(created.authorization.typedData));
      await this.submitAuthorization(id, { signature });
    } else if (mode === "account") {
      const a = created.authorization?.account;
      if (!created.authorization || !a) throw new TilcaiError({ status: 0, code: "NO_AUTHORIZATION", message: "TilcAI returned no passkey challenge for the account payment", recovery: "CONTACT_OPERATOR" });
      assertSignable({ quote, authorization: created.authorization, payer, source });
      const assertion = await o.passkey!({ challenge: a.challenge, challengeBase64Url: a.challengeBase64Url });
      await this.submitAuthorization(id, { webauthn: assertion });
    } else {
      if (created.unsignedCalls.length === 0) throw new TilcaiError({ status: 0, code: "NO_CALLS", message: "TilcAI returned no calls to broadcast", recovery: "CONTACT_OPERATOR" });
      let hash = "";
      for (const call of created.unsignedCalls) {
        assertCallOnSource(call, source);
        hash = await o.sendTransaction!(call);
      }
      await this.submitBurn(id, hash);
    }

    const waitOpts: WaitOptions | undefined = o.wait === false ? undefined : typeof o.wait === "object" ? o.wait : {};
    const view = waitOpts ? await this.wait(id, { ...waitOpts, ...(o.signal ? { signal: o.signal } : {}) }) : await this.get(id);
    return { quote, paymentId: id, mode, view };
  }
}

function assertPayTo(payTo: string): void {
  if (isStellarAccount(payTo) || isStellarContract(payTo)) return;
  if (/^M[A-Z2-7]{68}$/.test(payTo)) return; // muxed account
  throw invalidInput(`payTo must be a Stellar address (G…, C… or M…), got ${JSON.stringify(payTo)}`);
}

const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();

/** What a wallet checks before it signs: the money leaves this payer, on this chain's USDC, toward TilcAI's router, for the quote. */
export function assertSignable(args: { quote: Quote; authorization: PaymentAuthorization; payer: string; source: EvmNetworkInfo }): void {
  const { quote, authorization, payer, source } = args;
  const { domain, message, primaryType } = authorization.typedData;
  const fail = (what: string): never => {
    throw new TilcaiError({ status: 0, code: "UNSAFE_AUTHORIZATION", message: `refusing to sign: ${what}`, recovery: "CONTACT_OPERATOR" });
  };
  if (primaryType !== "ReceiveWithAuthorization") fail(`primaryType is ${primaryType}, not ReceiveWithAuthorization`);
  if (Number(domain.chainId) !== source.chainId) fail(`chainId ${String(domain.chainId)} is not ${source.name}'s ${source.chainId}`);
  if (!same(domain.verifyingContract, source.usdc.address)) fail(`verifyingContract ${String(domain.verifyingContract)} is not ${source.name}'s USDC`);
  if (!same(message.from, payer)) fail("from is not the payer");
  if (!same(message.to, authorization.router)) fail("to is not the router TilcAI named");
  if (String(message.value) !== quote.burn.amountAtomic) fail(`value ${String(message.value)} is not the quoted burn ${quote.burn.amountAtomic}`);
  if (BigInt(String(message.validBefore)) * 1000n < BigInt(Date.now())) fail("the authorization has already expired");
}

function assertCallOnSource(call: UnsignedCall, source: EvmNetworkInfo): void {
  if (call.chainId !== source.chainId) {
    throw new TilcaiError({ status: 0, code: "UNSAFE_CALL", message: `refusing to send: call is for chain ${call.chainId}, not ${source.name} (${source.chainId})`, recovery: "CONTACT_OPERATOR" });
  }
}
