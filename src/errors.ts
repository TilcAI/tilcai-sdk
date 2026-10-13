/**
 * Every failure the SDK raises is a TilcaiError. Answers of the TilcAI API keep their
 * `tilcai-shared-v1` envelope (`code`, `message`, `recovery`); failures that happen before a
 * request leaves (bad input, no key, unreachable host) use the same shape with `status: 0`.
 */
export interface TilcaiErrorInit {
  status: number;
  code: string;
  message: string;
  recovery?: string | undefined;
  /** Extra server-side explanation (`detail`) when the API sent one. */
  detail?: string | undefined;
  cause?: unknown;
}

export class TilcaiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly recovery: string | undefined;
  readonly detail: string | undefined;

  constructor(init: TilcaiErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "TilcaiError";
    this.status = init.status;
    this.code = init.code;
    this.recovery = init.recovery;
    this.detail = init.detail;
  }

  /** True when repeating the same request (same idempotency key) is safe and likely to help. */
  get retryable(): boolean {
    return this.code === "UNREACHABLE" || this.code === "TIMEOUT" || this.status === 429 || this.status >= 502 && this.status <= 504;
  }
}

/** A payment that did not settle: carries the last view so the caller can reconcile instead of re-paying. */
export class PaymentError extends TilcaiError {
  readonly payment: unknown;
  /** `true` when the outcome is unknown: reconcile, never create a second payment. */
  readonly uncertain: boolean;

  constructor(init: TilcaiErrorInit & { payment?: unknown; uncertain?: boolean }) {
    super(init);
    this.name = "PaymentError";
    this.payment = init.payment;
    this.uncertain = init.uncertain ?? false;
  }
}

export class X402Error extends TilcaiError {
  /** Facilitator reason code (`invalid_exact_*`, `unsupported_network`, …) when there is one. */
  readonly reason: string | undefined;

  constructor(init: TilcaiErrorInit & { reason?: string | undefined }) {
    super(init);
    this.name = "X402Error";
    this.reason = init.reason;
  }
}

export function invalidInput(message: string): TilcaiError {
  return new TilcaiError({ status: 0, code: "INVALID_INPUT", message, recovery: "FIX_REQUEST" });
}

/** A transaction handed to the relayer that did not confirm. `uncertain` is true when its fate is not known yet. */
export class RelayerError extends TilcaiError {
  readonly transactionId: string | undefined;
  readonly uncertain: boolean;

  constructor(init: TilcaiErrorInit & { transactionId?: string | undefined; uncertain?: boolean }) {
    super(init);
    this.name = "RelayerError";
    this.transactionId = init.transactionId;
    this.uncertain = init.uncertain ?? false;
  }
}
