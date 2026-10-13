import { invalidInput, TilcaiError, X402Error } from "../errors.js";
import type { FetchLike } from "../http.js";
import { NETWORKS, isEvmNetwork, isStellarNetwork } from "../networks.js";
import type { EvmSigner } from "../signers.js";
import { createEvmPayload } from "./evm.js";
import { HEADER_REQUIRED, HEADER_RESPONSE, HEADER_SIGNATURE, decodeHeader, encodeHeader } from "./headers.js";
import { createStellarPayload, type StellarSigner } from "./stellar.js";
import type { PaymentPayload, PaymentRequired, PaymentRequirements, ResourceInfo, SettleResponse } from "./types.js";

/** Who pays: an EVM wallet for `eip155:*` requirements, a Stellar key for `stellar:*`. Give either or both. */
export interface X402Wallet {
  evm?: EvmSigner;
  stellar?: StellarSigner;
  /** Soroban RPC for Stellar payloads (needed on `stellar:pubnet`). */
  stellarRpcUrl?: string;
}

/** Picks the requirement the wallet can pay, by network family and your preference order. */
export function selectRequirements(accepts: PaymentRequirements[], wallet: X402Wallet, prefer?: string[]): PaymentRequirements | undefined {
  const payable = accepts.filter((a) => {
    const n = NETWORKS[a.network as keyof typeof NETWORKS];
    if (!n || a.scheme !== "exact") return false;
    return (isEvmNetwork(n) && Boolean(wallet.evm)) || (isStellarNetwork(n) && Boolean(wallet.stellar));
  });
  if (prefer) for (const network of prefer) {
    const hit = payable.find((a) => a.network === network);
    if (hit) return hit;
  }
  return payable[0];
}

/** Signs a payment for `requirements` with the right signer for its network. */
export async function createPaymentPayload(requirements: PaymentRequirements, wallet: X402Wallet, resource?: ResourceInfo): Promise<PaymentPayload> {
  const n = NETWORKS[requirements.network as keyof typeof NETWORKS];
  if (!n) throw invalidInput(`unknown x402 network ${requirements.network}`);
  if (isEvmNetwork(n)) {
    if (!wallet.evm) throw invalidInput(`${n.name} needs an EVM signer (wallet.evm)`);
    return createEvmPayload({ requirements, signer: wallet.evm, ...(resource ? { resource } : {}) });
  }
  if (!wallet.stellar) throw invalidInput(`${n.name} needs a Stellar signer (wallet.stellar)`);
  return createStellarPayload({ requirements, signer: wallet.stellar, ...(resource ? { resource } : {}), ...(wallet.stellarRpcUrl ? { rpcUrl: wallet.stellarRpcUrl } : {}) });
}

export interface X402FetchOptions {
  wallet: X402Wallet;
  /** Networks in order of preference when the server offers several. */
  prefer?: string[];
  /**
   * Called before anything is signed, with what the server asks for. Return false to refuse.
   * Without it the wallet pays whatever the server asks: set `maxAmountAtomic` or this.
   */
  approve?: (requirement: PaymentRequirements, resource: ResourceInfo | undefined) => boolean | Promise<boolean>;
  /** Refuse requirements above this many atomic units. */
  maxAmountAtomic?: bigint;
  fetch?: FetchLike;
}

export interface X402Response extends Response {
  /** Present when the server settled a payment for this request. */
  readonly settlement?: SettleResponse;
}

/**
 * `fetch` that pays. On an HTTP 402 it reads the requirements, asks `approve`, signs once and
 * retries with the `PAYMENT-SIGNATURE` header; the settlement the server reports comes back as
 * `response.settlement`. It never pays twice for one call.
 */
export function x402Fetch(options: X402FetchOptions): (input: string | URL, init?: RequestInit) => Promise<X402Response> {
  const base: FetchLike = options.fetch ?? ((i, init) => fetch(i, init));
  return async (input, init) => {
    const url = String(input);
    const first = await base(url, init);
    if (first.status !== 402) return first as X402Response;

    const header = first.headers.get(HEADER_REQUIRED);
    let required: PaymentRequired | undefined;
    if (header) required = decodeHeader<PaymentRequired>(header, HEADER_REQUIRED);
    else {
      try {
        required = (await first.clone().json()) as PaymentRequired;
      } catch {}
    }
    if (!required?.accepts?.length) {
      throw new X402Error({ status: 402, code: "NO_REQUIREMENTS", message: `${url} answered 402 without payment requirements`, recovery: "CONTACT_OPERATOR" });
    }
    const chosen = selectRequirements(required.accepts, options.wallet, options.prefer);
    if (!chosen) {
      throw new X402Error({
        status: 402,
        code: "NO_PAYABLE_REQUIREMENT",
        message: `${url} accepts ${required.accepts.map((a) => a.network).join(", ")}; the wallet has no signer for any of them`,
        recovery: "REVIEW_POLICY",
      });
    }
    if (options.maxAmountAtomic !== undefined && BigInt(chosen.amount) > options.maxAmountAtomic) {
      throw new X402Error({ status: 402, code: "PAYMENT_LIMIT", message: `${url} asks ${chosen.amount} atomic units, above the limit ${options.maxAmountAtomic}`, recovery: "REVIEW_POLICY" });
    }
    if (options.approve && !(await options.approve(chosen, required.resource))) {
      throw new TilcaiError({ status: 402, code: "APPROVAL_DENIED", message: "the payment was not approved; nothing was signed", recovery: "REQUEST_APPROVAL" });
    }
    const payload = await createPaymentPayload(chosen, options.wallet, required.resource);
    const headers = new Headers(init?.headers);
    headers.set(HEADER_SIGNATURE, encodeHeader(payload));
    const paid = (await base(url, { ...init, headers })) as X402Response;
    const settled = paid.headers.get(HEADER_RESPONSE);
    if (settled) Object.defineProperty(paid, "settlement", { value: decodeHeader<SettleResponse>(settled, HEADER_RESPONSE) });
    return paid;
  };
}
