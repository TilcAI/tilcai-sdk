import { invalidInput } from "../errors.js";
import type { X402Facilitator } from "./facilitator.js";
import { HEADER_REQUIRED, HEADER_RESPONSE, HEADER_SIGNATURE, decodeHeader, encodeHeader } from "./headers.js";
import { buildRequirements, type RequirementsInput } from "./requirements.js";
import type { PaymentPayload, PaymentRequired, PaymentRequirements, ResourceInfo, SettleResponse } from "./types.js";
import { X402_VERSION } from "./types.js";

export interface PaywallOptions {
  facilitator: Pick<X402Facilitator, "verify" | "settle">;
  /** What you accept. Several networks let the payer choose: `{network:"monad"}`, `{network:"stellar"}`, … */
  accepts: Array<RequirementsInput | PaymentRequirements>;
  resource?: ResourceInfo;
}

export interface ChallengeResponse {
  status: 402;
  headers: Record<string, string>;
  body: PaymentRequired;
}

export type PaywallOutcome =
  | { paid: false; response: ChallengeResponse }
  | {
      paid: true;
      payer: string | undefined;
      requirements: PaymentRequirements;
      payload: PaymentPayload;
      /** Settles on-chain. The facilitator verifies again first. */
      settle(): Promise<SettleResponse>;
    };

const isRequirements = (a: RequirementsInput | PaymentRequirements): a is PaymentRequirements => "scheme" in a && "maxTimeoutSeconds" in a;

/**
 * Seller side of x402. Framework-free: `process()` takes the URL and headers and says either
 * "answer this 402" or "paid: settle, then serve". `express()` and `fetchHandler()` wrap it.
 *
 * The facilitator is always asked about *your* requirements, never about what the payload says
 * it accepted: a payer cannot lower the price by editing `accepted`.
 */
export class Paywall {
  readonly requirements: PaymentRequirements[];
  private readonly facilitator: PaywallOptions["facilitator"];
  private readonly resource: ResourceInfo | undefined;

  constructor(opts: PaywallOptions) {
    if (opts.accepts.length === 0) throw invalidInput("a paywall needs at least one accepted payment");
    this.requirements = opts.accepts.map((a) => (isRequirements(a) ? a : buildRequirements(a)));
    this.facilitator = opts.facilitator;
    this.resource = opts.resource;
  }

  challenge(url: string, error?: string): ChallengeResponse {
    const body: PaymentRequired = {
      x402Version: X402_VERSION,
      ...(error ? { error } : {}),
      resource: { ...this.resource, url },
      accepts: this.requirements,
    };
    return { status: 402, headers: { [HEADER_REQUIRED]: encodeHeader(body), "content-type": "application/json" }, body };
  }

  async process(req: { url: string; headers: Headers | Record<string, string | string[] | undefined> }): Promise<PaywallOutcome> {
    const raw = headerOf(req.headers, HEADER_SIGNATURE);
    if (!raw) return { paid: false, response: this.challenge(req.url) };

    let payload: PaymentPayload;
    try {
      payload = decodeHeader<PaymentPayload>(raw, HEADER_SIGNATURE);
    } catch {
      return { paid: false, response: this.challenge(req.url, "invalid_payment_header") };
    }
    const mine = this.requirements.find((r) => matches(r, payload.accepted));
    if (!mine) return { paid: false, response: this.challenge(req.url, "payment_does_not_match_requirements") };

    const verdict = await this.facilitator.verify(payload, mine);
    if (!verdict.isValid) return { paid: false, response: this.challenge(req.url, verdict.invalidReason ?? "payment_invalid") };
    return {
      paid: true,
      payer: verdict.payer,
      requirements: mine,
      payload,
      settle: () => this.facilitator.settle(payload, mine),
    };
  }

  /**
   * Express/Connect middleware. It settles *before* calling the handler, so a served response is
   * always a paid one; a failed settlement answers 402 and the handler never runs.
   * Need to settle after serving? Use `process()` and call `settle()` yourself.
   */
  express() {
    return async (req: ExpressLikeRequest, res: ExpressLikeResponse, next: (err?: unknown) => void): Promise<void> => {
      try {
        const url = `${req.protocol ?? "http"}://${req.get?.("host") ?? req.headers.host ?? "localhost"}${req.originalUrl ?? req.url}`;
        const outcome = await this.process({ url, headers: req.headers });
        if (!outcome.paid) return void send402(res, outcome.response);
        const settlement = await outcome.settle();
        if (!settlement.success) return void send402(res, this.challenge(url, settlement.errorReason ?? "settlement_failed"));
        res.setHeader(HEADER_RESPONSE, encodeHeader(settlement));
        (req as { x402?: unknown }).x402 = { payer: outcome.payer, settlement, requirements: outcome.requirements };
        next();
      } catch (e) {
        next(e);
      }
    };
  }

  /** Wraps a Web-standard `(Request) => Response` handler (Hono, Next.js route handlers, Bun, Deno, Workers). */
  fetchHandler(handler: (req: Request, paid: { payer: string | undefined; settlement: SettleResponse }) => Response | Promise<Response>) {
    return async (req: Request): Promise<Response> => {
      const outcome = await this.process({ url: req.url, headers: req.headers });
      if (!outcome.paid) return challengeResponse(outcome.response);
      const settlement = await outcome.settle();
      if (!settlement.success) return challengeResponse(this.challenge(req.url, settlement.errorReason ?? "settlement_failed"));
      const res = await handler(req, { payer: outcome.payer, settlement });
      const out = new Response(res.body, res);
      out.headers.set(HEADER_RESPONSE, encodeHeader(settlement));
      return out;
    };
  }
}

export interface ExpressLikeRequest {
  headers: Record<string, string | string[] | undefined>;
  url: string;
  originalUrl?: string;
  protocol?: string;
  get?(name: string): string | undefined;
}
export interface ExpressLikeResponse {
  status(code: number): ExpressLikeResponse;
  setHeader(name: string, value: string): unknown;
  json(body: unknown): unknown;
}

function send402(res: ExpressLikeResponse, c: ChallengeResponse): void {
  for (const [k, v] of Object.entries(c.headers)) if (k !== "content-type") res.setHeader(k, v);
  res.status(402).json(c.body);
}

function challengeResponse(c: ChallengeResponse): Response {
  return new Response(JSON.stringify(c.body), { status: 402, headers: c.headers });
}

function headerOf(headers: Headers | Record<string, string | string[] | undefined>, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const v = headers[name.toLowerCase()] ?? headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function matches(mine: PaymentRequirements, accepted: PaymentRequirements | undefined): boolean {
  return (
    !!accepted &&
    mine.scheme === accepted.scheme &&
    mine.network === accepted.network &&
    mine.asset.toLowerCase() === accepted.asset.toLowerCase() &&
    mine.payTo.toLowerCase() === accepted.payTo.toLowerCase() &&
    mine.amount === accepted.amount
  );
}

