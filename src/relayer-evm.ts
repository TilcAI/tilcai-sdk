import { RelayerError, TilcaiError, invalidInput } from "./errors.js";
import type { FetchLike } from "./http.js";
import { isEvmAddress } from "./strkey.js";

export interface EvmRelayerOptions {
  /** Base URL of the OpenZeppelin Relayer TilcAI runs, e.g. `http://relayer.internal:8080`. Defaults to `TILCAI_RELAYER_URL`. */
  url?: string;
  /** The relayer's API key (not a TilcAI API key). Defaults to `TILCAI_RELAYER_API_KEY`. */
  apiKey?: string;
  /** The EVM relayer to use, e.g. `monad-testnet-relayer` or `avalanche-fuji-relayer`. */
  relayerId: string;
  timeoutMs?: number;
  fetch?: FetchLike;
}

export type RelayedStatus = "pending" | "sent" | "submitted" | "mined" | "confirmed" | "failed" | "expired" | "canceled" | (string & {});

export interface RelayedTransaction {
  /** The relayer's id for the submission. Not the chain hash: the relayer may re-price or replace a transaction. */
  id: string;
  status: RelayedStatus;
  /** Chain hash. Trust it only when `status` is `confirmed`. */
  hash: string | null;
  statusReason: string | null;
}

export interface SendCall {
  to: string;
  /** ABI-encoded calldata, `0x…`. */
  data: string;
  /** Wei sent with the call. Default 0. */
  value?: bigint | number;
  /** Explicit gas limit. Needed on chains that bill the limit, not the gas used (Monad). */
  gasLimit?: number;
  speed?: "safeLow" | "average" | "fast" | "fastest";
}

export interface WaitForTransactionOptions {
  timeoutMs?: number;
  intervalMs?: number;
  signal?: AbortSignal;
}

/**
 * Sends contract calls through one of TilcAI's EVM relayers. The relayer's own account is the
 * `msg.sender` and pays the gas, so a caller whose contract authenticates by a signature in the
 * calldata (an attestor's EIP-712 verdict, an EIP-3009 authorization) needs no gas or key of its own.
 *
 * What the relayer is allowed to be asked is up to its operator: this client gives whoever holds
 * the relayer's API key the ability to submit any call. Keep that key on the server.
 */
export class EvmRelayer {
  readonly relayerId: string;
  private readonly base: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private account: `0x${string}` | null = null;

  constructor(opts: EvmRelayerOptions) {
    const url = (opts.url ?? process.env.TILCAI_RELAYER_URL ?? "").trim().replace(/\/+$/, "");
    if (!url) throw new TilcaiError({ status: 0, code: "NO_BASE_URL", message: "the relayer url is required (or set TILCAI_RELAYER_URL)", recovery: "FIX_REQUEST" });
    this.apiKey = opts.apiKey ?? process.env.TILCAI_RELAYER_API_KEY ?? "";
    if (!this.apiKey) throw new TilcaiError({ status: 0, code: "NO_API_KEY", message: "the relayer apiKey is required (or set TILCAI_RELAYER_API_KEY)", recovery: "AUTHENTICATE" });
    if (!opts.relayerId) throw invalidInput("relayerId is required");
    this.relayerId = opts.relayerId;
    this.base = `${url}/api/v1/relayers/${encodeURIComponent(opts.relayerId)}`;
    this.timeoutMs = opts.timeoutMs ?? 35_000;
    this.fetchImpl = opts.fetch ?? ((i, init) => fetch(i, init));
  }

  /** The relayer's address: the `msg.sender` of every call it sends. */
  async address(): Promise<`0x${string}`> {
    if (!this.account) {
      const relayer = await this.call<{ address?: string }>("GET", "");
      if (!relayer.address || !isEvmAddress(relayer.address)) {
        throw new TilcaiError({ status: 0, code: "NOT_EVM_RELAYER", message: `relayer ${this.relayerId} has no EVM address`, recovery: "FIX_REQUEST" });
      }
      this.account = relayer.address;
    }
    return this.account;
  }

  async send(call: SendCall): Promise<RelayedTransaction> {
    if (!isEvmAddress(call.to)) throw invalidInput(`to must be an EVM address, got ${call.to}`);
    if (!/^0x([0-9a-fA-F]{2})*$/.test(call.data)) throw invalidInput("data must be 0x-prefixed hex");
    const body = {
      to: call.to,
      data: call.data,
      value: call.value === undefined ? 0 : Number(call.value),
      speed: call.speed ?? "fast",
      ...(call.gasLimit ? { gas_limit: call.gasLimit } : {}),
    };
    return toTx(await this.call<RawTx>("POST", "/transactions", body));
  }

  async get(id: string): Promise<RelayedTransaction> {
    return toTx(await this.call<RawTx>("GET", `/transactions/${encodeURIComponent(id)}`));
  }

  /**
   * Polls until the relayer reports `confirmed` and returns the transaction with its chain hash.
   * `failed`, `expired` and `canceled` throw a `RelayerError`; running out of time throws one with
   * `uncertain: true` (it may still land: look it up again, do not resend blindly).
   */
  async waitForConfirmation(id: string, opts: WaitForTransactionOptions = {}): Promise<RelayedTransaction & { hash: string }> {
    const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
    const interval = opts.intervalMs ?? 1500;
    for (;;) {
      if (opts.signal?.aborted) throw opts.signal.reason;
      const tx = await this.get(id);
      const s = tx.status.toLowerCase();
      if (s === "confirmed" && tx.hash) return { ...tx, hash: tx.hash };
      if (s === "failed" || s === "expired" || s === "canceled") {
        throw new RelayerError({ status: 0, code: `RELAYED_TX_${s.toUpperCase()}`, message: `relayed transaction ${id} ${s}${tx.statusReason ? `: ${tx.statusReason}` : ""}`, recovery: "REVIEW_POLICY", transactionId: id });
      }
      if (Date.now() >= deadline) {
        throw new RelayerError({ status: 0, code: "WAIT_TIMEOUT", message: `relayed transaction ${id} is still ${tx.status}`, recovery: "RECONCILE", transactionId: id, uncertain: true });
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  /** `send` then `waitForConfirmation`. */
  async sendAndWait(call: SendCall, opts?: WaitForTransactionOptions): Promise<RelayedTransaction & { hash: string }> {
    const sent = await this.send(call);
    return this.waitForConfirmation(sent.id, opts);
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.apiKey}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      const timedOut = (cause as Error).name === "TimeoutError" || (cause as Error).name === "AbortError";
      throw new RelayerError({
        status: 0,
        code: timedOut ? "TIMEOUT" : "UNREACHABLE",
        message: timedOut ? `relayer ${method} ${path || "/"} timed out after ${this.timeoutMs} ms` : `cannot reach the relayer: ${(cause as Error).message}`,
        recovery: method === "POST" ? "RECONCILE" : "RETRY_READ",
        // A POST that timed out may have been accepted.
        uncertain: method === "POST",
        cause,
      });
    }
    const text = await res.text();
    let json: { success?: boolean; data?: T; error?: unknown; message?: unknown } = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { error: text.slice(0, 200) };
    }
    if (!res.ok || json.success === false || json.data === undefined) {
      const reason = String(json.error ?? json.message ?? text.slice(0, 200) ?? res.status);
      throw new RelayerError({
        status: res.status,
        code: res.status === 401 ? "UNAUTHENTICATED" : `HTTP_${res.status}`,
        message: `relayer ${method} ${path || "/"} → HTTP ${res.status}: ${reason}`,
        recovery: res.status === 401 ? "AUTHENTICATE" : res.status >= 500 ? "RETRY_READ" : "FIX_REQUEST",
      });
    }
    return json.data;
  }
}

interface RawTx {
  id: string;
  status: string;
  hash?: string | null;
  status_reason?: string | null;
}

function toTx(r: RawTx): RelayedTransaction {
  return { id: r.id, status: r.status, hash: r.hash ?? null, statusReason: r.status_reason ?? null };
}
