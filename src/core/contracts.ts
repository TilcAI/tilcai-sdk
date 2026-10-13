// Mirrors tilcai-core/src/contracts.ts (tilcai-shared-v1 contracts, proposal pending team review).
// Shared domain contracts. No signing, persistence or transport dependencies.
export const SHARED_SCHEMA = "tilcai-shared-v1";

export function isSharedSchema(value: unknown): value is typeof SHARED_SCHEMA {
  return value === SHARED_SCHEMA;
}

export interface SharedEnvelope {
  readonly schema: typeof SHARED_SCHEMA;
}

export const ID_PREFIXES = Object.freeze({
  principal: "principal",
  agent: "agent",
  business: "business",
  service: "service",
  quote: "quote",
  order: "order",
  mandate: "mandate",
  intent: "intent",
  paymentAttempt: "payment_attempt",
  budgetReservation: "budget_reservation",
  decisionReceipt: "decision_receipt",
  paymentReceipt: "payment_receipt",
  fulfillmentReceipt: "fulfillment_receipt",
} as const);

export type IdKind = keyof typeof ID_PREFIXES;
declare const idBrand: unique symbol;
export type EntityId<K extends IdKind> = string & { readonly [idBrand]: K };
export type PrincipalId = EntityId<"principal">;
export type AgentId = EntityId<"agent">;
export type BusinessId = EntityId<"business">;
export type ServiceId = EntityId<"service">;
export type QuoteId = EntityId<"quote">;
export type OrderId = EntityId<"order">;
export type MandateId = EntityId<"mandate">;
export type IntentId = EntityId<"intent">;
export type PaymentAttemptId = EntityId<"paymentAttempt">;
export type BudgetReservationId = EntityId<"budgetReservation">;
export type DecisionReceiptId = EntityId<"decisionReceipt">;
export type PaymentReceiptId = EntityId<"paymentReceipt">;
export type FulfillmentReceiptId = EntityId<"fulfillmentReceipt">;
export type ReceiptId = DecisionReceiptId | PaymentReceiptId | FulfillmentReceiptId;

/** Format only: the backend still verifies ownership, existence and uniqueness. */
export function parseId<K extends IdKind>(kind: K, value: unknown): EntityId<K> {
  if (!Object.hasOwn(ID_PREFIXES, kind) || typeof value !== "string") {
    throw new TypeError("Invalid entity ID.");
  }
  const prefix = `${ID_PREFIXES[kind]}_`;
  const suffix = value.slice(prefix.length);
  if (!value.startsWith(prefix) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(suffix)) {
    throw new TypeError("Invalid entity ID.");
  }
  return value as EntityId<K>;
}

export interface OperationReferences extends SharedEnvelope {
  readonly principalId: PrincipalId;
  readonly agentId: AgentId;
  readonly businessId: BusinessId;
  readonly serviceId: ServiceId;
  readonly quoteId: QuoteId;
  readonly orderId: OrderId;
  readonly intentId: IntentId;
  readonly mandateId?: MandateId;
}

export type ReceiptReference = SharedEnvelope & (
  | { readonly kind: "decision"; readonly id: DecisionReceiptId;
      readonly orderId: OrderId; readonly intentId: IntentId }
  | { readonly kind: "payment"; readonly id: PaymentReceiptId;
      readonly orderId: OrderId; readonly paymentAttemptId: PaymentAttemptId }
  | { readonly kind: "fulfillment"; readonly id: FulfillmentReceiptId;
      readonly orderId: OrderId; readonly businessId: BusinessId }
);

// The three machines from product report §17.1, independent of policy outcomes.
export const COMMERCE_STATES = ["DRAFT", "QUOTED", "PREPARED", "CONFIRMED", "DELIVERED"] as const;
export const PAYMENT_STATES = ["NOT_ATTEMPTED", "PREPARED", "SENT", "SETTLED", "FAILED", "UNCERTAIN"] as const;
export const BUDGET_STATES = ["NOT_RESERVED", "HELD", "CONSUMED", "RELEASED"] as const;
export type CommerceState = typeof COMMERCE_STATES[number];
export type PaymentState = typeof PAYMENT_STATES[number];
export type BudgetState = typeof BUDGET_STATES[number];
export type DecisionOutcome = "ALLOW" | "DENY" | "REQUIRE_APPROVAL";
export type FulfillmentStatus = "PENDING" | "CONFIRMED" | "FAILED";

export interface OperationState extends SharedEnvelope {
  readonly orderId: OrderId;
  readonly commerce: CommerceState;
  readonly payment: PaymentState;
  readonly budget: BudgetState;
  // Independent observations: a settled payment can have pending fulfillment.
  readonly decision?: DecisionOutcome;
  readonly fulfillment: FulfillmentStatus;
}

export const COMMERCE_TRANSITIONS = {
  DRAFT: ["QUOTED"], QUOTED: ["PREPARED"], PREPARED: ["CONFIRMED"],
  CONFIRMED: ["DELIVERED"], DELIVERED: [],
} as const satisfies Record<CommerceState, readonly CommerceState[]>;

export const PAYMENT_TRANSITIONS = {
  NOT_ATTEMPTED: ["PREPARED"], PREPARED: ["SENT", "FAILED"],
  SENT: ["SETTLED", "FAILED", "UNCERTAIN"], UNCERTAIN: ["SETTLED", "FAILED"],
  SETTLED: [], FAILED: [],
} as const satisfies Record<PaymentState, readonly PaymentState[]>;

export const BUDGET_TRANSITIONS = {
  NOT_RESERVED: ["HELD"], HELD: ["CONSUMED", "RELEASED"], CONSUMED: [], RELEASED: [],
} as const satisfies Record<BudgetState, readonly BudgetState[]>;

interface StateByMachine {
  commerce: CommerceState;
  payment: PaymentState;
  budget: BudgetState;
}

/** Validates graph edges only; it never verifies authority or financial evidence. */
export function canTransition<M extends keyof StateByMachine>(
  machine: M, from: StateByMachine[M], to: StateByMachine[M],
): boolean {
  const graphs: Record<keyof StateByMachine, Readonly<Record<string, readonly string[]>>> = {
    commerce: COMMERCE_TRANSITIONS, payment: PAYMENT_TRANSITIONS, budget: BUDGET_TRANSITIONS,
  };
  if (!Object.hasOwn(graphs, machine)) return false;
  const graph = graphs[machine];
  return Object.hasOwn(graph, from) && graph[from]?.includes(to) === true;
}

export type BudgetResolution = "KEEP_HELD" | "CONSUME" | "RELEASE";

/** Recommendation for an existing hold tied to this attempt, not a store mutation. */
export function budgetResolution(
  payment: PaymentState, authorizationInFlight: boolean,
): BudgetResolution {
  if (payment === "SETTLED") return "CONSUME";
  if (authorizationInFlight === false && (payment === "NOT_ATTEMPTED" || payment === "FAILED")) {
    return "RELEASE";
  }
  return "KEEP_HELD";
}

export type RecoveryAction =
  | "FIX_REQUEST" | "AUTHENTICATE" | "CHECK_ACCESS" | "REFRESH_QUOTE"
  | "REQUEST_APPROVAL" | "REVIEW_POLICY" | "LOOKUP_EXISTING" | "RECONCILE"
  | "CHECK_FULFILLMENT" | "RETRY_READ" | "CONTACT_OPERATOR";

interface ErrorDefinition {
  readonly message: string;
  readonly recovery: RecoveryAction;
}

export const ERROR_CATALOG = {
  INVALID_INPUT: { message: "Invalid request data.", recovery: "FIX_REQUEST" },
  UNSUPPORTED_VERSION: { message: "Unsupported schema version.", recovery: "FIX_REQUEST" },
  UNAUTHENTICATED: { message: "Authentication is required.", recovery: "AUTHENTICATE" },
  FORBIDDEN: { message: "Access is not permitted.", recovery: "CHECK_ACCESS" },
  NOT_FOUND: { message: "Reference is unavailable.", recovery: "CHECK_ACCESS" },
  INVALID_STATE_TRANSITION: { message: "State transition is not permitted.", recovery: "LOOKUP_EXISTING" },
  QUOTE_EXPIRED: { message: "Quote has expired.", recovery: "REFRESH_QUOTE" },
  QUOTE_INVALID: { message: "Quote could not be verified.", recovery: "REFRESH_QUOTE" },
  APPROVAL_REQUIRED: { message: "Exact purchase approval is required.", recovery: "REQUEST_APPROVAL" },
  APPROVAL_INVALID: { message: "Approval does not match valid purchase conditions.", recovery: "REQUEST_APPROVAL" },
  PAUSED: { message: "Policy is paused.", recovery: "REVIEW_POLICY" },
  EXPIRED: { message: "Policy has expired.", recovery: "REVIEW_POLICY" },
  DUPLICATE: { message: "Intent was already processed.", recovery: "LOOKUP_EXISTING" },
  IDEMPOTENCY_CONFLICT: { message: "Idempotency key belongs to different request conditions.", recovery: "LOOKUP_EXISTING" },
  NETWORK_OR_ASSET: { message: "Network or asset is outside policy.", recovery: "REVIEW_POLICY" },
  RESOURCE: { message: "Resource is outside policy.", recovery: "REVIEW_POLICY" },
  RECIPIENT: { message: "Recipient is outside policy.", recovery: "REVIEW_POLICY" },
  PAYMENT_LIMIT: { message: "Amount exceeds the purchase limit.", recovery: "REVIEW_POLICY" },
  BUDGET: { message: "Available budget is insufficient.", recovery: "REVIEW_POLICY" },
  PAYMENT_FAILED: { message: "Payment attempt failed with a confirmed result.", recovery: "CONTACT_OPERATOR" },
  PAYMENT_UNCERTAIN: { message: "Payment result requires reconciliation.", recovery: "RECONCILE" },
  FULFILLMENT_PENDING: { message: "Business fulfillment is pending.", recovery: "CHECK_FULFILLMENT" },
  FULFILLMENT_FAILED: { message: "Business fulfillment failed.", recovery: "CHECK_FULFILLMENT" },
  SERVICE_UNAVAILABLE: { message: "Read service is temporarily unavailable.", recovery: "RETRY_READ" },
  INTERNAL_ERROR: { message: "Operation requires operator assistance.", recovery: "CONTACT_OPERATOR" },
} as const satisfies Record<string, ErrorDefinition>;

export type ErrorCode = keyof typeof ERROR_CATALOG;
export type ContractError = SharedEnvelope & {
  readonly code: ErrorCode;
  readonly message: string;
  readonly recovery: RecoveryAction;
};

/** Stable public error; never include request payloads or underlying exception text. */
export function createContractError(code: ErrorCode): ContractError {
  if (!Object.hasOwn(ERROR_CATALOG, code)) throw new TypeError("Unknown error code.");
  return { schema: SHARED_SCHEMA, code, ...ERROR_CATALOG[code] };
}
