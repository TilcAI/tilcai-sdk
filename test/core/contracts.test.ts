import assert from "node:assert/strict";
import test from "node:test";
import {
  SHARED_SCHEMA, isSharedSchema, ID_PREFIXES, parseId, canTransition, budgetResolution,
  createContractError, ERROR_CATALOG, PAYMENT_STATES,
  type IdKind, type EntityId, type OrderId, type PrincipalId,
  type PaymentState, type ReceiptReference, type OperationState, type ErrorCode,
} from "../../src/core/contracts.js";
import { evaluateIntent, type Decision } from "../../src/core/policy.js";

test("consumers reject missing and unsupported shared schema versions", () => {
  assert.equal(isSharedSchema(SHARED_SCHEMA), true);
  for (const schema of [undefined, null, 1, {}, "tilcai-shared-v2", "tilcai-shared-v1 "]) {
    assert.equal(isSharedSchema(schema), false);
  }
});

test("IDs survive JSON round trips and enforce each entity namespace", () => {
  for (const kind of Object.keys(ID_PREFIXES) as IdKind[]) {
    const id = parseId(kind, `${ID_PREFIXES[kind]}_123e4567-e89b-42d3-a456-426614174000`);
    assert.equal(parseId(kind, JSON.parse(JSON.stringify(id))), id);
    for (const otherKind of Object.keys(ID_PREFIXES) as IdKind[]) {
      if (kind !== otherKind) assert.throws(() => parseId(otherKind, id), TypeError);
    }
  }
});

test("IDs reject missing, oversized, private-data and malformed suffixes", () => {
  const invalid = [undefined, null, 42, {}, "", "order_", "order_-bad", "order_ bad",
    "order_person@example.com", "order_ñ", "order_ok\n", `order_${"a".repeat(129)}`];
  for (const value of invalid) assert.throws(() => parseId("order", value), TypeError);
  assert.equal(parseId("order", `order_${"a".repeat(128)}`).length, 134);
  assert.throws(() => parseId("toString" as IdKind, "toString_a"), TypeError);
});

test("commerce cannot skip preparation or infer delivery from a quote", () => {
  assert.equal(canTransition("commerce", "DRAFT", "DELIVERED"), false);
  assert.equal(canTransition("commerce", "QUOTED", "CONFIRMED"), false);
  assert.equal(canTransition("commerce", "CONFIRMED", "DELIVERED"), true);
  assert.equal(canTransition("commerce", "DELIVERED", "DRAFT"), false);
});

test("an uncertain attempt reconciles without resubmitting payment", () => {
  assert.equal(canTransition("payment", "PREPARED", "SENT"), true);
  assert.equal(canTransition("payment", "SENT", "UNCERTAIN"), true);
  assert.equal(canTransition("payment", "UNCERTAIN", "PREPARED"), false);
  assert.equal(canTransition("payment", "UNCERTAIN", "SENT"), false);
  assert.equal(canTransition("payment", "UNCERTAIN", "SETTLED"), true);
  assert.equal(canTransition("payment", "UNCERTAIN", "FAILED"), true);
  for (const terminal of ["SETTLED", "FAILED"] as const) {
    for (const next of PAYMENT_STATES) assert.equal(canTransition("payment", terminal, next), false);
  }
});

test("invalid external state values fail closed", () => {
  assert.equal(canTransition("payment", "toString" as PaymentState, "SENT"), false);
  assert.equal(canTransition("payment", "__proto__" as PaymentState, "SENT"), false);
  assert.equal(canTransition("payment", "SENT", "unknown" as PaymentState), false);
});

test("budget stays held for pending or uncertain payment and authority in flight", () => {
  for (const payment of ["PREPARED", "SENT", "UNCERTAIN"] as const) {
    assert.equal(budgetResolution(payment, false), "KEEP_HELD");
    assert.equal(budgetResolution(payment, true), "KEEP_HELD");
  }
  for (const payment of ["NOT_ATTEMPTED", "FAILED"] as const) {
    assert.equal(budgetResolution(payment, true), "KEEP_HELD");
    assert.equal(budgetResolution(payment, false), "RELEASE");
  }
  assert.equal(budgetResolution("SETTLED", false), "CONSUME");
  assert.equal(budgetResolution("SETTLED", true), "CONSUME");
  assert.equal(budgetResolution("unknown" as PaymentState, false), "KEEP_HELD");
  assert.equal(budgetResolution("FAILED", undefined as unknown as boolean), "KEEP_HELD");
  assert.equal(canTransition("budget", "CONSUMED", "RELEASED"), false);
  assert.equal(canTransition("budget", "RELEASED", "HELD"), false);
});

test("payment evidence and fulfillment evidence remain independent", () => {
  const orderId = parseId("order", "order_example");
  const state: OperationState = {
    schema: SHARED_SCHEMA, orderId, commerce: "PREPARED", payment: "SETTLED",
    budget: "CONSUMED", decision: "ALLOW", fulfillment: "PENDING",
  };
  const payment: ReceiptReference = {
    schema: SHARED_SCHEMA, kind: "payment", id: parseId("paymentReceipt", "payment_receipt_example"),
    orderId, paymentAttemptId: parseId("paymentAttempt", "payment_attempt_example"),
  };
  const roundTrip = JSON.parse(JSON.stringify({ state, payment }));
  assert.equal(roundTrip.state.fulfillment, "PENDING");
  assert.equal(roundTrip.payment.kind, "payment");
  assert.equal(roundTrip.payment.businessId, undefined);
});

test("financial uncertainty and duplicates never recommend a new transfer", () => {
  assert.equal(createContractError("PAYMENT_UNCERTAIN").recovery, "RECONCILE");
  assert.equal(createContractError("DUPLICATE").recovery, "LOOKUP_EXISTING");
  assert.equal(createContractError("APPROVAL_REQUIRED").recovery, "REQUEST_APPROVAL");
  const error = createContractError("PAYMENT_UNCERTAIN");
  assert.deepEqual(JSON.parse(JSON.stringify(error)), error);
  assert.deepEqual(Object.keys(error).sort(), ["code", "message", "recovery", "schema"]);
  assert.throws(() => createContractError("toString" as ErrorCode), TypeError);
  assert.throws(() => createContractError("POLICY_OK" as ErrorCode), TypeError);
});

test("every legacy policy denial is supported without changing evaluator behavior", () => {
  const reasons: Extract<Decision, { outcome: "DENY" }>["reason"][] = [
    "INVALID_INPUT", "PAUSED", "EXPIRED", "DUPLICATE", "NETWORK_OR_ASSET",
    "RESOURCE", "RECIPIENT", "PAYMENT_LIMIT", "BUDGET",
  ];
  for (const reason of reasons) {
    assert.ok(Object.hasOwn(ERROR_CATALOG, reason));
    assert.equal(createContractError(reason).code, reason);
  }
  const denied = evaluateIntent(
    { id: "legacy-1", network: "stellar:testnet", asset: "USDC", resource: "/report", payTo: "G_CHANGED", amountMicros: 1 },
    { network: "stellar:testnet", asset: "USDC", allowedResources: ["/report"], allowedPayTo: ["G_APPROVED"],
      maxPaymentMicros: 100, remainingMicros: 100, paused: false, expiresAtMs: 2000 },
    new Set(), 1000,
  );
  assert.deepEqual(denied, { outcome: "DENY", reason: "RECIPIENT" });
  if (denied.outcome === "DENY") assert.equal(createContractError(denied.reason).recovery, "REVIEW_POLICY");
});

// Compile-time assertions are also checked by tsc. This function is never run.
function typeAssertions(principal: PrincipalId, order: OrderId) {
  // @ts-expect-error Different entity kinds must not be interchangeable.
  const wrongOrder: OrderId = principal;
  // @ts-expect-error IDs must be parsed at the boundary, not accepted as raw strings.
  const rawOrder: OrderId = "order_raw";
  // @ts-expect-error A payment receipt cannot use a decision receipt ID.
  const wrongReceipt: ReceiptReference = { schema: SHARED_SCHEMA, kind: "payment", id: parseId("decisionReceipt", "decision_receipt_a"), orderId: order, paymentAttemptId: parseId("paymentAttempt", "payment_attempt_a") };
  // @ts-expect-error Payment receipts must identify their financial attempt.
  const missingAttempt: ReceiptReference = { schema: SHARED_SCHEMA, kind: "payment", id: parseId("paymentReceipt", "payment_receipt_a"), orderId: order };
  // @ts-expect-error Machine states cannot be exchanged.
  canTransition("payment", "HELD", "SENT");
  // @ts-expect-error Unknown shared schema versions cannot be represented as v1.
  const wrongVersion: OperationState = { schema: "tilcai-shared-v2", orderId: order, commerce: "DRAFT", payment: "NOT_ATTEMPTED", budget: "NOT_RESERVED", fulfillment: "PENDING" };
  const inferred: EntityId<"order"> = parseId("order", "order_a");
  return [wrongOrder, rawOrder, wrongReceipt, missingAttempt, wrongVersion, inferred];
}
void typeAssertions;
