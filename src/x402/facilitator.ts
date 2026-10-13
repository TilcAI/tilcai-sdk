import { TilcaiError, X402Error } from "../errors.js";
import type { FetchLike } from "../http.js";
import type { FacilitatorRequest, PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "./types.js";
import { X402_VERSION } from "./types.js";

export interface FacilitatorOptions {
  /** Base URL of the OpenZeppelin Relayer that runs the x402 plugin, e.g. `http://relayer.internal:8080`. */
  url?: string;
  /** The relayer's API key (not a TilcAI key). */
  apiKey?: string;
  /** Plugin id in the relayer's config. Default `x402`. */
  pluginId?: string;
  timeoutMs?: number;
  fetch?: FetchLike;
}

/**
 * Client of the x402 facilitator plugin (`/verify`, `/settle`, `/supported`) that TilcAI's
 * OpenZeppelin Relayer exposes. A business rejection is **not** an HTTP error: `verify` answers
 * `isValid:false` and `settle` answers `success:false`, both with HTTP 200 — read the body.
 */
export class X402Facilitator {
  private readonly base: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(opts: FacilitatorOptions = {}) {
    const url = (opts.url ?? process.env.TILCAI_RELAYER_URL ?? "").trim().replace(/\/+$/, "");
    if (!url) throw new TilcaiError({ status: 0, code: "NO_BASE_URL", message: "the relayer url is required (or set TILCAI_RELAYER_URL)", recovery: "FIX_REQUEST" });
    this.apiKey = opts.apiKey ?? process.env.TILCAI_RELAYER_API_KEY ?? "";
    if (!this.apiKey) throw new TilcaiError({ status: 0, code: "NO_API_KEY", message: "the relayer apiKey is required (or set TILCAI_RELAYER_API_KEY)", recovery: "AUTHENTICATE" });
    this.base = `${url}/api/v1/plugins/${encodeURIComponent(opts.pluginId ?? "x402")}/call`;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetchImpl = opts.fetch ?? ((i, init) => fetch(i, init));
  }

  supported(): Promise<SupportedResponse> {
    return this.call<SupportedResponse>("GET", "/supported");
  }

  verify(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<VerifyResponse> {
    return this.call<VerifyResponse>("POST", "/verify", this.body(paymentPayload, paymentRequirements));
  }

  /** Verifies again, then submits. An unknown outcome (timeout, 504) means the payment may be in flight: reconcile by hash, never sign a new payload. */
  settle(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<SettleResponse> {
    return this.call<SettleResponse>("POST", "/settle", this.body(paymentPayload, paymentRequirements));
  }

  private body(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): FacilitatorRequest {
    return { x402Version: X402_VERSION, paymentPayload, paymentRequirements };
  }

  private async call<T>(method: "GET" | "POST", route: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${route}`, {
        method,
        headers: { authorization: `Bearer ${this.apiKey}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      const timedOut = (cause as Error).name === "TimeoutError" || (cause as Error).name === "AbortError";
      throw new X402Error({
        status: 0,
        code: timedOut ? "TIMEOUT" : "UNREACHABLE",
        message: timedOut ? `x402 ${route} timed out after ${this.timeoutMs} ms` : `cannot reach the x402 facilitator: ${(cause as Error).message}`,
        recovery: route === "/settle" ? "RECONCILE" : "RETRY_READ",
        cause,
      });
    }
    const text = await res.text();
    let json: unknown = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text.slice(0, 300) };
    }
    if (!res.ok) {
      const j = json as { error?: unknown; code?: unknown; message?: unknown };
      const code = res.status === 504 ? "TIMEOUT" : res.status === 401 ? "UNAUTHENTICATED" : `HTTP_${res.status}`;
      throw new X402Error({
        status: res.status,
        code,
        message: `x402 ${route} → HTTP ${res.status}: ${typeof j.error === "string" ? j.error : typeof j.message === "string" ? j.message : text.slice(0, 200)}`,
        recovery: res.status === 504 && route === "/settle" ? "RECONCILE" : res.status === 401 ? "AUTHENTICATE" : "RETRY_READ",
      });
    }
    return json as T;
  }
}
