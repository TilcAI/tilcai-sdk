import { errorFromResponse, type Http } from "./http.js";
import { TilcaiError } from "./errors.js";
import type { MonitorEvent, MonitorEventsPage, MonitorResources, MonitorSeverity, MonitorSource, RelayerStatus } from "./types.js";

export interface EventsQuery {
  /** Events after this position (`seq`). Without it, the latest `limit`. */
  after?: number;
  limit?: number;
  /** Exact type or a prefix ending in a dot: `"vault."`. */
  type?: string;
  source?: MonitorSource;
  /** Minimum severity. */
  severity?: MonitorSeverity;
}

export interface StreamOptions {
  /** Resume after this position. Without it the stream starts at the current head. */
  after?: number;
  signal?: AbortSignal;
  /** Reconnect after the server closes the stream (default true), resuming from the last event seen. */
  reconnect?: boolean;
}

/** TilcAI's event log, the one `tilcai-web` renders as its dashboard. Operator keys only. */
export class MonitorApi {
  constructor(private readonly http: Http) {}

  events(query: EventsQuery = {}): Promise<MonitorEventsPage> {
    return this.http.request("GET", "/v1/monitor/events", { query: { ...query } });
  }

  resources(): Promise<MonitorResources> {
    return this.http.request("GET", "/v1/monitor/resources");
  }

  /**
   * Live events as an async iterator (Server-Sent Events). Ends when `signal` aborts.
   *
   *     for await (const e of tilcai.monitor.stream({ signal })) console.log(e.summary);
   */
  async *stream(opts: StreamOptions = {}): AsyncGenerator<MonitorEvent> {
    let cursor = opts.after;
    for (;;) {
      if (opts.signal?.aborted) return;
      const headers = this.http.headers();
      headers.accept = "text/event-stream";
      if (cursor !== undefined) headers["last-event-id"] = String(cursor);
      let res: Response;
      try {
        res = await this.http.opts.fetch(this.http.url("/v1/monitor/stream", cursor !== undefined ? { after: cursor } : undefined), {
          headers,
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
      } catch (e) {
        if (opts.signal?.aborted) return;
        throw new TilcaiError({ status: 0, code: "UNREACHABLE", message: `cannot open the event stream: ${(e as Error).message}`, recovery: "RETRY_READ", cause: e });
      }
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        let json: unknown = {};
        try {
          json = JSON.parse(text);
        } catch {}
        throw errorFromResponse(res.status, json, text);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let cut: number;
          while ((cut = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const data = frame
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trimStart())
              .join("\n");
            if (!data) continue;
            const event = JSON.parse(data) as MonitorEvent;
            cursor = event.seq;
            yield event;
          }
        }
      } catch (e) {
        if (opts.signal?.aborted) return;
        throw e;
      } finally {
        reader.cancel().catch(() => undefined);
      }
      if (opts.reconnect === false) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/** Status of the OpenZeppelin Relayer behind TilcAI: x402 `/supported` and the Stellar relayer account. Operator keys only. */
export class RelayerApi {
  constructor(private readonly http: Http) {}

  status(): Promise<RelayerStatus> {
    return this.http.request("GET", "/v1/relayer/status");
  }
}
