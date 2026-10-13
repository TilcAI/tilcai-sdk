/**
 * An in-process TilcAI API v1, written from tilcai-infrastructure's `src/apps/api/*` and its README
 * (routes, auth scopes, status codes, response shapes). Signatures are verified for real with viem,
 * so a typed-data mistake in the SDK fails here as it would on-chain.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { recoverTypedDataAddress } from "viem";

export const OPERATOR_KEY = "operator-key";
export const TENANT_KEY = "tenant-key";
export const ROUTER: Record<string, string> = {
  "eip155:43113": "0x297ce6a2787484db4bB18A96a8F28A9881Fc163C",
  "eip155:10143": "0x7777777777777777777777777777777777777777",
};
const USDC: Record<string, { address: string; name: string }> = {
  "eip155:43113": { address: "0x5425890298aed601595a70AB815c96711a31Bc65", name: "USD Coin" },
  "eip155:10143": { address: "0x534b2f3A21130d7a60830c2Df862319e593943A3", name: "USDC" },
};
const STELLAR_USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const NOT_FOUND = { error: { schema: "tilcai-shared-v1", code: "NOT_FOUND", message: "Reference is unavailable.", recovery: "CHECK_ACCESS" } };

interface Caller {
  operator: boolean;
  scopes: string[];
}
const KEYS: Record<string, Caller> = {
  [OPERATOR_KEY]: { operator: true, scopes: ["payments"] },
  [TENANT_KEY]: { operator: false, scopes: ["payments", "accounts:read", "accounts:write"] },
};

export interface MockOptions {
  /** `payTo` addresses without a USDC trustline. */
  noTrustline?: Set<string>;
  /** Payments never leave this state (to test wait timeouts). */
  freezeAt?: string;
  /** Fail the next N requests with this status before behaving. */
  failNext?: { count: number; status: number };
}

interface StoredPayment {
  id: string;
  quoteId: string;
  mode: string;
  payer: string | null;
  orderId: string | null;
  state: string;
  burnTxHash: string | null;
  mintTxHash: string | null;
  authorization: { router: string; typedData: Record<string, any> } | null;
  idempotencyKey: string;
  createdAt: string;
}

const NEXT: Record<string, string> = {
  BURN_SUBMITTED: "BURN_CONFIRMED",
  BURN_CONFIRMED: "ATTESTED",
  ATTESTED: "MINT_SUBMITTED",
  MINT_SUBMITTED: "SETTLED",
};

const hex = (n: number, seed = 1) => `0x${(seed.toString(16) + "ab").repeat(n).slice(0, n * 2)}`;

export class MockTilcai {
  readonly server: Server;
  url = "";
  readonly requests: Array<{ method: string; path: string; headers: IncomingMessage["headers"]; body: any }> = [];
  readonly quotes = new Map<string, any>();
  readonly payments = new Map<string, StoredPayment>();
  readonly accounts = new Map<string, any>();
  readonly disbursements = new Map<string, any>();
  readonly events: any[] = [];
  private counter = 0;
  private readonly idem = new Map<string, { status: number; body: unknown }>();

  constructor(readonly opts: MockOptions = {}) {
    this.server = createServer((req, res) => void this.handle(req, res));
  }

  async listen(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  emit(type: string, summary: string, extra: Partial<{ source: string; severity: string; subject: string }> = {}): void {
    const seq = this.events.length + 1;
    this.events.push({ seq, id: `evt_${seq}`, type, source: "tilcai", severity: "info", subject: null, summary, data: {}, at: new Date().toISOString(), ...extra });
  }

  private id(prefix: string) {
    return `${prefix}_${(++this.counter).toString(36).padStart(6, "0")}`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    this.requests.push({ method: req.method ?? "GET", path: path + url.search, headers: req.headers, body });
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(payload));
    };
    const err = (status: number, code: string, message: string, recovery: string, detail?: string) =>
      send(status, { error: { schema: "tilcai-shared-v1", code, message, recovery }, ...(detail ? { detail } : {}) });

    if (this.opts.failNext && this.opts.failNext.count > 0 && path !== "/health") {
      this.opts.failNext.count--;
      return err(this.opts.failNext.status, "SERVICE_UNAVAILABLE", "Read service is temporarily unavailable.", "RETRY_READ");
    }

    if (path === "/health") {
      return send(200, { ok: true, env: "testnet", transactionsEnabled: true, relayer: "up", vault: "on", networks: ["eip155:43113", "eip155:10143", "stellar:testnet"], vaultStellar: "on", accounts: "on", qrMock: "off", monitor: "local" });
    }

    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const caller = bearer ? KEYS[bearer] : undefined;
    if (!caller) return err(401, "UNAUTHENTICATED", "Authentication is required.", "AUTHENTICATE");
    const method = req.method ?? "GET";
    const isAccounts = path === "/v1/accounts" || path.startsWith("/v1/accounts/");
    const operatorOnly = ["/v1/vault", "/v1/monitor", "/v1/relayer"].some((p) => path === p || path.startsWith(`${p}/`));
    const scope = isAccounts ? (method === "GET" ? "accounts:read" : "accounts:write") : "payments";
    if ((operatorOnly && !caller.operator) || !caller.scopes.includes(scope)) return err(403, "FORBIDDEN", "Access is not permitted.", "CHECK_ACCESS");

    // ── crosschain ────────────────────────────────────────────────────────────
    if (path === "/v1/routes") {
      return send(200, {
        routes: ["eip155:43113", "eip155:10143"].map((n) => ({
          protocol: "cctp-v2",
          source: { network: n, asset: USDC[n]!.address, domain: n === "eip155:10143" ? 15 : 1 },
          destination: { network: "stellar:testnet", asset: STELLAR_USDC_SAC, domain: 27 },
          finality: "standard",
          mintSubmitter: "relayer",
          transactionsEnabled: true,
          gasless: true,
          account: true,
          vault: true,
        })),
      });
    }

    if (method === "POST" && path === "/v1/crosschain/quotes") {
      const { sourceNetwork, destinationNetwork, amount, payTo } = body ?? {};
      if (!USDC[sourceNetwork] || destinationNetwork !== "stellar:testnet" || typeof amount !== "string" || typeof payTo !== "string") {
        return err(400, "INVALID_INPUT", "Invalid request data.", "FIX_REQUEST", "sourceNetwork");
      }
      const dec = /^(\d+)(?:\.(\d{1,7}))?$/.exec(amount);
      if (!dec) return err(400, "INVALID_INPUT", "Invalid request data.", "FIX_REQUEST", "amount");
      const frac = (dec[2] ?? "").padEnd(7, "0");
      const dest = BigInt(dec[1]! + frac);
      const burn = dest / 10n;
      const id = this.id("quote");
      const q = {
        id,
        route: { protocol: "cctp-v2", source: sourceNetwork, destination: destinationNetwork, sourceDomain: sourceNetwork === "eip155:10143" ? 15 : 1, destinationDomain: 27 },
        payTo,
        destination: { asset: "USDC", amountAtomic: dest.toString(), amount, decimals: 7 },
        burn: { asset: USDC[sourceNetwork]!.address, amountAtomic: burn.toString(), amount: amount, decimals: 6 },
        fees: { protocolBpsHundredths: "0", maxFeeAtomic: "0", destinationGas: "sponsored by TilcAI relayer" },
        finality: "standard",
        cctp: {},
        preflight: { payToExists: true, payToTrustline: !this.opts.noTrustline?.has(payTo), payToAuthorized: true },
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      };
      this.quotes.set(id, q);
      return send(201, { quote: q });
    }
    const quoteMatch = /^\/v1\/crosschain\/quotes\/([^/]+)$/.exec(path);
    if (method === "GET" && quoteMatch) {
      const q = this.quotes.get(decodeURIComponent(quoteMatch[1]!));
      return q ? send(200, { quote: q }) : send(404, NOT_FOUND);
    }

    if (method === "POST" && path === "/v1/crosschain/payments") {
      const key = req.headers["idempotency-key"];
      if (typeof key !== "string") return err(400, "INVALID_INPUT", "Invalid request data.", "FIX_REQUEST", "Idempotency-Key header required");
      const prior = this.idem.get(`pay:${key}`);
      if (prior) return send(200, prior.body);
      const { quoteId, mode, payer } = body ?? {};
      const q = this.quotes.get(quoteId);
      if (!q) return send(404, NOT_FOUND);
      if (!/^0x[0-9a-fA-F]{40}$/.test(payer ?? "")) return err(400, "INVALID_INPUT", "Invalid request data.", "FIX_REQUEST", "payer");
      const source: string = q.route.source;
      const p: StoredPayment = { id: this.id("payment_attempt"), quoteId, mode, payer: payer ?? null, orderId: body.orderId ?? null, state: "AWAITING_BURN", burnTxHash: null, mintTxHash: null, authorization: null, idempotencyKey: key, createdAt: new Date().toISOString() };
      let unsignedCalls: unknown[] = [];
      let authorization: Record<string, unknown> | undefined;
      if (mode === "gasless" || mode === "account") {
        const typedData = {
          domain: { name: USDC[source]!.name, version: "2", chainId: Number(source.split(":")[1]), verifyingContract: USDC[source]!.address },
          types: {
            EIP712Domain: [
              { name: "name", type: "string" },
              { name: "version", type: "string" },
              { name: "chainId", type: "uint256" },
              { name: "verifyingContract", type: "address" },
            ],
            ReceiveWithAuthorization: [
              { name: "from", type: "address" },
              { name: "to", type: "address" },
              { name: "value", type: "uint256" },
              { name: "validAfter", type: "uint256" },
              { name: "validBefore", type: "uint256" },
              { name: "nonce", type: "bytes32" },
            ],
          },
          primaryType: "ReceiveWithAuthorization",
          message: { from: payer, to: ROUTER[source], value: q.burn.amountAtomic, validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 3600), nonce: hex(32, this.counter) },
        };
        p.authorization = { router: ROUTER[source]!, typedData };
        authorization = {
          router: ROUTER[source],
          nonce: typedData.message.nonce,
          validBefore: typedData.message.validBefore,
          typedData,
          ...(mode === "account" ? { account: { challenge: hex(32, 9), challengeBase64Url: Buffer.from(hex(32, 9).slice(2), "hex").toString("base64url"), appDomainSeparator: hex(32, 3), contentsHash: hex(32, 4), contentsType: "ReceiveWithAuthorization(...)" } } : {}),
        };
      } else if (mode === "external") {
        const chainId = Number(source.split(":")[1]);
        unsignedCalls = [
          { chainId, to: USDC[source]!.address, data: "0x095ea7b3" + "00".repeat(64), value: "0", description: "approve USDC" },
          { chainId, to: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA", data: "0xb1d9ef10" + "00".repeat(32), value: "0", description: "depositForBurnWithHook" },
        ];
      }
      this.payments.set(p.id, p);
      const out = { payment: this.publicPayment(p), unsignedCalls, ...(authorization ? { authorization } : {}), next: "…" };
      this.idem.set(`pay:${key}`, { status: 201, body: out });
      return send(201, out);
    }

    const payMatch = /^\/v1\/crosschain\/payments\/([^/]+)(?:\/(authorization|burn|reconcile))?$/.exec(path);
    if (payMatch) {
      const p = this.payments.get(decodeURIComponent(payMatch[1]!));
      if (!p) return send(404, NOT_FOUND);
      const action = payMatch[2];
      if (method === "GET" && !action) {
        this.advance(p);
        const q = this.quotes.get(p.quoteId);
        return send(200, {
          payment: this.publicPayment(p),
          paymentState: this.publicPayment(p).paymentState,
          quote: q,
          links: { burn: p.burnTxHash ? `https://explorer.test/tx/${p.burnTxHash}` : null, mint: p.mintTxHash ? `https://stellar.expert/explorer/testnet/tx/${p.mintTxHash}` : null },
          amounts: { destination: `${q.destination.amount} USDC`, burn: `${q.burn.amount} USDC` },
          receipt: p.state === "SETTLED" ? { evidence: { source: { network: q.route.source } } } : null,
          events: [],
        });
      }
      if (method === "POST" && action === "authorization") {
        if (!p.authorization) return err(409, "INVALID_STATE_TRANSITION", "State transition is not permitted.", "LOOKUP_EXISTING");
        if (p.mode === "account") {
          if (!body?.webauthn && !body?.signature) return err(400, "INVALID_INPUT", "Invalid request data.", "FIX_REQUEST");
        } else {
          if (!/^0x[0-9a-fA-F]{130}$/.test(body?.signature ?? "")) return err(400, "INVALID_INPUT", "Invalid request data.", "FIX_REQUEST", "signature");
          const td = p.authorization.typedData;
          const { EIP712Domain: _d, ...types } = td.types;
          const signer = await recoverTypedDataAddress({
            domain: td.domain as never,
            types: types as never,
            primaryType: td.primaryType,
            message: { ...td.message, value: BigInt(td.message.value), validAfter: BigInt(td.message.validAfter), validBefore: BigInt(td.message.validBefore) } as never,
            signature: body.signature,
          });
          if (signer.toLowerCase() !== p.payer!.toLowerCase()) return err(400, "INVALID_INPUT", "Invalid request data.", "FIX_REQUEST", "signature does not match the payer");
        }
        p.authorization = null;
        p.state = "BURN_SUBMITTED";
        p.burnTxHash = hex(32, 5);
        return send(200, { payment: this.publicPayment(p) });
      }
      if (method === "POST" && action === "burn") {
        if (!/^0x[0-9a-fA-F]{64}$/.test(body?.txHash ?? "")) return err(400, "INVALID_INPUT", "Invalid request data.", "FIX_REQUEST");
        p.state = "BURN_SUBMITTED";
        p.burnTxHash = body.txHash;
        return send(200, { payment: this.publicPayment(p) });
      }
      if (method === "POST" && action === "reconcile") {
        this.advance(p);
        return send(200, { payment: this.publicPayment(p) });
      }
    }

    // ── accounts ──────────────────────────────────────────────────────────────
    if (method === "POST" && path === "/v1/accounts") {
      const key = req.headers["idempotency-key"];
      if (typeof key !== "string") return err(400, "INVALID_INPUT", "Invalid request data.", "FIX_REQUEST", "Idempotency-Key header required");
      const prior = this.idem.get(`acc:${key}`);
      if (prior) return send(200, prior.body);
      const { network, externalRef, owner } = body ?? {};
      const okNet = ["eip155:43113", "eip155:10143", "stellar:testnet"].includes(network);
      const okOwner =
        owner?.kind === "webauthn-p256"
          ? /^0x04[0-9a-fA-F]{128}$/.test(owner.publicKey)
          : owner?.kind === "ed25519" && /^0x[0-9a-fA-F]{64}$/.test(owner.publicKey) && network.startsWith("stellar:");
      if (!okNet || !externalRef || !okOwner) return err(400, "INVALID_INPUT", "Invalid request data.", "FIX_REQUEST");
      const id = this.id("acct");
      const now = new Date().toISOString();
      const account = { id, externalRef, network, address: network.startsWith("stellar:") ? `C${"A".repeat(55)}` : hex(20, this.counter), owner, state: "DEPLOYING", codeRef: "code-v1", deployTxHash: null, lastError: null, createdAt: now, updatedAt: now, polls: 0 };
      this.accounts.set(id, account);
      const out = { account: this.publicAccount(account), links: { address: `https://explorer.test/address/${account.address}`, deployTx: null }, next: "poll until ACTIVE" };
      this.idem.set(`acc:${key}`, { status: 201, body: out });
      return send(201, out);
    }
    const accMatch = /^\/v1\/accounts\/([^/]+)$/.exec(path);
    if (method === "GET" && accMatch) {
      const a = this.accounts.get(decodeURIComponent(accMatch[1]!));
      if (!a) return send(404, NOT_FOUND);
      if (++a.polls >= 2) {
        a.state = "ACTIVE";
        a.deployTxHash = hex(32, 7);
      }
      return send(200, { account: this.publicAccount(a), links: { address: `https://explorer.test/address/${a.address}`, deployTx: a.deployTxHash }, events: [] });
    }
    if (method === "GET" && path === "/v1/accounts") {
      let list = [...this.accounts.values()].map((a) => this.publicAccount(a));
      const ref = url.searchParams.get("externalRef");
      const net = url.searchParams.get("network");
      if (ref) list = list.filter((a) => a.externalRef === ref);
      if (net) list = list.filter((a) => a.network === net);
      return send(200, { accounts: list });
    }

    // ── vault ─────────────────────────────────────────────────────────────────
    if (method === "GET" && path === "/v1/vault") {
      const network = url.searchParams.get("network") ?? "eip155:43113";
      if (!["eip155:43113", "eip155:10143", "stellar:testnet"].includes(network)) return err(400, "INVALID_INPUT", "Invalid request data.", "FIX_REQUEST");
      return send(200, { vault: { network, address: network.startsWith("stellar:") ? `C${"B".repeat(55)}` : hex(20, 2), asset: network.startsWith("stellar:") ? STELLAR_USDC_SAC : USDC[network]!.address, owner: "owner", operator: "operator", relayer: "relayer", operatorIsRelayer: true, paused: false, balance: "10", pending: "0", maxPerDisbursement: "100", dailyLimit: "1000", availableToday: "1000", explorer: "https://explorer.test/vault" } });
    }
    if (method === "POST" && path === "/v1/vault/disbursements") {
      const key = req.headers["idempotency-key"];
      if (typeof key !== "string") return err(400, "INVALID_INPUT", "Invalid request data.", "FIX_REQUEST", "Idempotency-Key header required");
      const prior = this.idem.get(`dis:${key}`);
      if (prior) return send(200, prior.body);
      const id = this.id("disb");
      const now = new Date().toISOString();
      const d = { id, state: "REQUESTED", uncertain: false, network: body.network ?? "eip155:43113", vault: hex(20, 2), to: body.to, asset: "USDC", amountAtomic: String(Math.round(Number(body.amount) * 1e6)), amount: body.amount, reference: body.reference ?? null, submissionId: null, txHash: null, blockNumber: null, attempts: 0, lastError: null, failureCode: null, nextCheckAt: now, createdAt: now, updatedAt: now };
      this.disbursements.set(id, d);
      const out = { disbursement: d, links: { tx: null } };
      this.idem.set(`dis:${key}`, { status: 201, body: out });
      return send(201, out);
    }
    const disMatch = /^\/v1\/vault\/disbursements\/([^/]+)(?:\/(reconcile))?$/.exec(path);
    if (disMatch) {
      const d = this.disbursements.get(decodeURIComponent(disMatch[1]!));
      if (!d) return send(404, NOT_FOUND);
      if (d.state === "REQUESTED") d.state = "SUBMITTED";
      else if (d.state === "SUBMITTED") {
        d.state = "CONFIRMED";
        d.txHash = hex(32, 8);
      }
      return send(200, { disbursement: d, links: { tx: d.txHash }, events: [] });
    }

    // ── monitor / relayer ─────────────────────────────────────────────────────
    if (method === "GET" && path === "/v1/monitor/events") {
      const after = url.searchParams.get("after");
      const limit = Number(url.searchParams.get("limit") ?? 100);
      let list = this.events;
      const type = url.searchParams.get("type");
      if (type) list = list.filter((e) => (type.endsWith(".") ? e.type.startsWith(type) : e.type === type));
      list = after === null ? list.slice(-limit) : list.filter((e) => e.seq > Number(after)).slice(0, limit);
      return send(200, { schema: "tilcai-monitor-v1", head: this.events.length, events: list });
    }
    if (method === "GET" && path === "/v1/monitor/resources") {
      return send(200, { schema: "tilcai-monitor-v1", resources: { takenAt: new Date().toISOString() }, alerts: [] });
    }
    if (method === "GET" && path === "/v1/monitor/stream") {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
      res.write("retry: 3000\n\n");
      let cursor = Number(url.searchParams.get("after") ?? req.headers["last-event-id"] ?? this.events.length);
      const flush = () => {
        for (const e of this.events.filter((x) => x.seq > cursor)) {
          cursor = e.seq;
          res.write(`id: ${e.seq}\nevent: monitor\ndata: ${JSON.stringify(e)}\n\n`);
        }
      };
      flush();
      const t = setInterval(flush, 20);
      res.on("close", () => clearInterval(t));
      return;
    }
    if (method === "GET" && path === "/v1/relayer/status") {
      return send(200, { up: true, authenticated: true, x402: { kinds: [{ network: "eip155:43113", scheme: "exact", x402Version: 2 }, { network: "eip155:10143", scheme: "exact", x402Version: 2 }, { network: "stellar:testnet", scheme: "exact", x402Version: 2, extra: { areFeesSponsored: true } }], signers: {} }, stellarRelayer: { id: "stellar-example", paused: false } });
    }

    return err(404, "NOT_FOUND", "Reference is unavailable.", "CHECK_ACCESS");
  }

  private advance(p: StoredPayment): void {
    if (this.opts.freezeAt && p.state === this.opts.freezeAt) return;
    const next = NEXT[p.state];
    if (next) {
      p.state = next;
      if (next === "SETTLED") p.mintTxHash = hex(32, 6);
    }
  }

  private publicPayment(p: StoredPayment) {
    const paymentState = p.state === "SETTLED" ? "SETTLED" : p.state === "FAILED" ? "FAILED" : p.state === "AWAITING_BURN" ? "PREPARED" : "SENT";
    return {
      id: p.id,
      quoteId: p.quoteId,
      orderId: p.orderId,
      mode: p.mode,
      state: p.state,
      paymentState,
      uncertain: false,
      payer: p.payer,
      burnSubmissionId: null,
      burnTxHash: p.burnTxHash,
      burnBlock: null,
      cctpNonce: null,
      feeExecutedAtomic: null,
      mintSubmitter: "relayer",
      mintTxHash: p.mintTxHash,
      attempts: 0,
      lastError: null,
      failureCode: null,
      nextCheckAt: new Date().toISOString(),
      createdAt: p.createdAt,
      updatedAt: new Date().toISOString(),
    };
  }

  private publicAccount(a: any) {
    const { polls: _p, ...rest } = a;
    return rest;
  }
}
