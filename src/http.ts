import { TilcaiError } from "./errors.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  baseUrl: string;
  apiKey?: string | undefined;
  timeoutMs: number;
  fetch: FetchLike;
  /** Extra attempts for GETs and for POSTs that carry an idempotency key. */
  retries: number;
  headers?: Record<string, string> | undefined;
}

export interface RequestOptions {
  query?: Record<string, string | number | undefined> | undefined;
  body?: unknown;
  idempotencyKey?: string | undefined;
  /** Send the Bearer key (default true). `/health` is the one open route. */
  auth?: boolean;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    }, { once: true });
  });

export class Http {
  constructor(readonly opts: HttpOptions) {}

  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  url(path: string, query?: RequestOptions["query"]): string {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) qs.set(k, String(v));
    const s = qs.toString();
    return `${this.opts.baseUrl}${path}${s ? `?${s}` : ""}`;
  }

  headers(o: RequestOptions = {}): Record<string, string> {
    const h: Record<string, string> = { accept: "application/json", ...this.opts.headers };
    if (o.auth !== false) {
      if (!this.opts.apiKey) {
        throw new TilcaiError({ status: 0, code: "NO_API_KEY", message: "no apiKey configured for this TilcAI client", recovery: "AUTHENTICATE" });
      }
      h.authorization = `Bearer ${this.opts.apiKey}`;
    }
    if (o.body !== undefined) h["content-type"] = "application/json";
    if (o.idempotencyKey) h["idempotency-key"] = o.idempotencyKey;
    return h;
  }

  async request<T>(method: "GET" | "POST", path: string, o: RequestOptions = {}): Promise<T> {
    return (await this.requestWithStatus<T>(method, path, o)).body;
  }

  /** Like `request`, keeping the HTTP status: creates answer 201, and 200 when an idempotency key replays. */
  async requestWithStatus<T>(method: "GET" | "POST", path: string, o: RequestOptions = {}): Promise<{ status: number; body: T }> {
    const canRetry = method === "GET" || Boolean(o.idempotencyKey);
    const attempts = canRetry ? this.opts.retries + 1 : 1;
    let last: TilcaiError | undefined;
    for (let i = 0; i < attempts; i++) {
      try {
        return await this.once<T>(method, path, o);
      } catch (e) {
        if (!(e instanceof TilcaiError) || !e.retryable || i === attempts - 1) throw e;
        last = e;
        await sleep(250 * 2 ** i, o.signal);
      }
    }
    throw last!;
  }

  private async once<T>(method: string, path: string, o: RequestOptions): Promise<{ status: number; body: T }> {
    const headers = this.headers(o);
    const timeout = AbortSignal.timeout(o.timeoutMs ?? this.opts.timeoutMs);
    const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.opts.fetch(this.url(path, o.query), {
        method,
        headers,
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
        signal,
      });
    } catch (e) {
      if (o.signal?.aborted) throw e;
      const timedOut = timeout.aborted;
      throw new TilcaiError({
        status: 0,
        code: timedOut ? "TIMEOUT" : "UNREACHABLE",
        message: timedOut
          ? `${method} ${path} timed out after ${o.timeoutMs ?? this.opts.timeoutMs} ms`
          : `cannot reach TilcAI at ${this.opts.baseUrl}: ${(e as Error).message}`,
        recovery: "RETRY_READ",
        cause: e,
      });
    }
    const text = await res.text();
    let json: unknown = {};
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text.slice(0, 500) };
      }
    }
    if (!res.ok) throw errorFromResponse(res.status, json, text);
    return { status: res.status, body: json as T };
  }
}

/** Maps a non-2xx answer to a TilcaiError, keeping the API's `tilcai-shared-v1` envelope. */
export function errorFromResponse(status: number, json: unknown, text: string): TilcaiError {
  const body = json as { error?: { code?: string; message?: string; recovery?: string }; detail?: string };
  const env = body.error;
  return new TilcaiError({
    status,
    code: env?.code ?? `HTTP_${status}`,
    message: env?.message ?? (text.slice(0, 300) || `HTTP ${status}`),
    recovery: env?.recovery,
    detail: body.detail,
  });
}
