import { invalidInput, TilcaiError } from "../errors.js";
import { NETWORKS, isStellarNetwork } from "../networks.js";
import { importPeer } from "../signers.js";
import { isStellarAccount, isStellarContract } from "../strkey.js";
import type { PaymentPayload, PaymentRequirements, ResourceInfo } from "./types.js";
import { X402_VERSION } from "./types.js";

/** A Stellar secret key (`S…`) or a `Keypair`-like object from @stellar/stellar-sdk. */
export type StellarSigner = string | { publicKey(): string; sign(data: Uint8Array): Uint8Array };

export interface StellarPayloadOptions {
  requirements: PaymentRequirements;
  signer: StellarSigner;
  resource?: ResourceInfo;
  /** Soroban RPC. Defaults to the public Testnet endpoint; required for `stellar:pubnet`. */
  rpcUrl?: string;
}

/**
 * Builds the x402 `exact` payload for Stellar: one `invokeHostFunction` that calls the asset
 * contract's `transfer(payer, payTo, amount)`, with only the payer's Soroban authorization entry
 * signed. The envelope stays unsigned and the facilitator rebuilds it with its own account as
 * source, so the payer pays no fee. Needs the optional peer dependency `@stellar/stellar-sdk`.
 */
export async function createStellarPayload(o: StellarPayloadOptions): Promise<PaymentPayload> {
  const r = o.requirements;
  const net = NETWORKS[r.network as keyof typeof NETWORKS];
  if (!net || !isStellarNetwork(net)) throw invalidInput(`${r.network} is not a Stellar network the SDK knows`);
  if (!(isStellarAccount(r.payTo) || isStellarContract(r.payTo))) throw invalidInput(`payTo must be a Stellar G… or C… address, got ${r.payTo}`);
  if (!isStellarContract(r.asset)) throw invalidInput(`asset must be a Soroban contract id (C…), got ${r.asset}`);
  if (!/^[1-9][0-9]*$/.test(r.amount)) throw invalidInput("amount must be a positive integer string in atomic units");
  const rpcUrl = o.rpcUrl ?? net.defaultRpcUrl;
  if (!rpcUrl) throw invalidInput(`${net.name} needs rpcUrl: no public Soroban RPC is built in for it`);

  const sdk = await importPeer<typeof import("@stellar/stellar-sdk")>("@stellar/stellar-sdk", "x402 payments on Stellar");
  const { Account, Address, Keypair, Operation, TransactionBuilder, authorizeInvocation, nativeToScVal, xdr } = sdk;
  const keypair = typeof o.signer === "string" ? Keypair.fromSecret(o.signer) : (o.signer as unknown as InstanceType<typeof Keypair>);
  const payer = keypair.publicKey();

  const latest = await latestLedger(rpcUrl);
  // The facilitator accepts an expiration in (current, current + ceil(maxTimeoutSeconds / 5)] ledgers.
  const maxOffset = Math.ceil(r.maxTimeoutSeconds / 5);
  const validUntil = latest + Math.max(1, Math.floor(maxOffset / 2));

  const invokeArgs = new xdr.InvokeContractArgs({
    contractAddress: Address.fromString(r.asset).toScAddress(),
    functionName: "transfer",
    args: [Address.fromString(payer).toScVal(), Address.fromString(r.payTo).toScVal(), nativeToScVal(BigInt(r.amount), { type: "i128" })],
  });
  const root = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(invokeArgs),
    subInvocations: [],
  });
  const signedAuth = await authorizeInvocation({
    signer: keypair,
    validUntilLedgerSeq: validUntil,
    invocation: root,
    publicKey: payer,
    networkPassphrase: net.passphrase,
    // Legacy credentials: the format the facilitator's verifier was exercised with.
    authV2: false,
  });
  const op = Operation.invokeHostFunction({ func: xdr.HostFunction.hostFunctionTypeInvokeContract(invokeArgs), auth: [signedAuth] });
  const placeholder = new Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "0");
  const tx = new TransactionBuilder(placeholder, { fee: "1000000", networkPassphrase: net.passphrase }).addOperation(op).setTimeout(30).build();
  return {
    x402Version: X402_VERSION,
    ...(o.resource ? { resource: o.resource } : {}),
    accepted: r,
    payload: { transaction: tx.toXDR() },
  };
}

/** `getLatestLedger` over plain JSON-RPC: only the sequence is needed, so the XDR header is never parsed. */
async function latestLedger(rpcUrl: string): Promise<number> {
  let res: Response;
  try {
    res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestLedger" }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (cause) {
    throw new TilcaiError({ status: 0, code: "UNREACHABLE", message: `cannot reach the Soroban RPC at ${rpcUrl}: ${(cause as Error).message}`, recovery: "RETRY_READ", cause });
  }
  const body = (await res.json().catch(() => ({}))) as { result?: { sequence?: number }; error?: { message?: string } };
  const sequence = body.result?.sequence;
  if (!res.ok || typeof sequence !== "number") {
    throw new TilcaiError({ status: res.status, code: "RPC_ERROR", message: `Soroban RPC getLatestLedger failed: ${body.error?.message ?? `HTTP ${res.status}`}`, recovery: "RETRY_READ" });
  }
  return sequence;
}
