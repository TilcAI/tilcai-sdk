import assert from "node:assert/strict";
import test from "node:test";
import {
  parseIntent, parseMandate, parseApprovalBinding, parseAtomicAmount, parseUtcInstant,
  parseResourceRef, parseIdempotencyKey, parseDigest, intentCommitment, matchesApprovalBinding,
  ContractValidationError, APPROVAL_SCHEMA, type Intent, type Mandate,
} from "../../src/core/authority.js";
import { intentFixture, mandateFixture } from "./fixtures/authority.js";

function rejects(fn: () => unknown, code = "INVALID_INPUT") {
  assert.throws(fn, (error: unknown) => error instanceof ContractValidationError && error.contractError.code === code);
}

test("intent and mandate fixtures survive JSON serialization without numeric money conversion", () => {
  const intent = parseIntent(intentFixture());
  const mandate = parseMandate(mandateFixture());
  assert.deepEqual(parseIntent(JSON.parse(JSON.stringify(intent))), intent);
  assert.deepEqual(parseMandate(JSON.parse(JSON.stringify(mandate))), mandate);
  assert.equal(intent.purchase.amountAtomic, "8000000");
  assert.equal(mandate.requiresConfirmation, true);
});

test("atomic amounts reject precision loss, alternate encodings and oversized input", () => {
  assert.equal(parseAtomicAmount("9007199254740993"), "9007199254740993");
  assert.equal(parseAtomicAmount("0"), "0");
  assert.equal(parseAtomicAmount("9".repeat(78)).length, 78);
  for (const amount of [1, 1.2, NaN, "01", "-1", "+1", "1e6", "0.1", " 1", "1\n", "9".repeat(79)]) {
    rejects(() => parseAtomicAmount(amount));
  }
  rejects(() => parseIntent({ ...intentFixture(), purchase: { ...intentFixture().purchase, amountAtomic: "0" } }));
});

test("dates must be real canonical UTC instants, not offsets or normalized invalid days", () => {
  assert.equal(parseUtcInstant("2024-02-29T00:00:00.000Z"), "2024-02-29T00:00:00.000Z");
  for (const time of ["2026-02-29T00:00:00.000Z", "2026-02-30T00:00:00.000Z",
    "2026-10-02T00:00:00Z", "2026-10-02T00:00:00.000-04:00", "2026-10-02T24:00:00.000Z", 123]) {
    rejects(() => parseUtcInstant(time));
  }
  const raw = intentFixture();
  rejects(() => parseIntent({ ...raw, expiresAt: raw.createdAt }));
  rejects(() => parseIntent({ ...raw, expiresAt: "2026-10-02T13:00:00.000Z" }));
});

test("unknown versions, financial networks and cross-entity identifiers are rejected", () => {
  const raw = intentFixture();
  rejects(() => parseIntent({ ...raw, schema: "tilcai-intent-v2" }), "UNSUPPORTED_VERSION");
  rejects(() => parseMandate({ ...mandateFixture(), schema: "tilcai-mandate-v2" }), "UNSUPPORTED_VERSION");
  rejects(() => parseIntent({ ...raw, principalId: raw.agentId }));
  rejects(() => parseIntent({ ...raw, purchase: { ...raw.purchase, network: "unknown" } }));
  rejects(() => parseIntent({ ...raw, policyVersion: 0 }));
});

test("unexpected fields cannot smuggle approval or secrets into authority records", () => {
  const secret = "SYNTHETIC_SECRET_MUST_NOT_APPEAR";
  for (const field of ["approved", "seedPhrase", "privateKey"]) {
    const raw = { ...intentFixture(), [field]: secret };
    try { parseIntent(raw); assert.fail("Unexpected field accepted"); }
    catch (error) {
      assert.ok(error instanceof ContractValidationError);
      assert.equal(error.message.includes(secret), false);
      assert.equal(JSON.stringify(error.contractError).includes(secret), false);
    }
  }
  rejects(() => parseMandate({ ...mandateFixture(), limits: { ...mandateFixture().limits, remainingAtomic: "100" } }));
  const raw = intentFixture();
  rejects(() => parseIntent({ ...raw, purchase: { ...raw.purchase, approved: true } }));
  const accessor = Object.defineProperty(raw, "id", { enumerable: true, get() { throw new Error(secret); } });
  rejects(() => parseIntent(accessor));
});

test("mandates require explicit nonempty scopes and coherent limits and periods", () => {
  const raw = mandateFixture();
  for (const field of ["businesses", "services", "recipients"] as const) {
    rejects(() => parseMandate({ ...raw, [field]: [] }));
    rejects(() => parseMandate({ ...raw, [field]: [raw[field][0], raw[field][0]] }));
    rejects(() => parseMandate({ ...raw, [field]: Array(1) }));
  }
  rejects(() => parseMandate({ ...raw, limits: { ...raw.limits, maxPerPeriodAtomic: "1" } }));
  rejects(() => parseMandate({ ...raw, limits: { ...raw.limits, periodSeconds: 0 } }));
  rejects(() => parseMandate({ ...raw, limits: { ...raw.limits, periodAnchor: "2026-10-01T00:00:00.000Z" } }));
  rejects(() => parseMandate({ ...raw, parentMandateId: raw.id }));
  rejects(() => parseMandate({ ...raw, requiresConfirmation: "false" }));
  rejects(() => parseMandate({ ...raw, expiresAt: raw.validFrom }));
});

test("paused or revoked mandates are representable but parsing does not enable execution", () => {
  for (const status of ["PAUSED", "REVOKED"] as const) {
    assert.equal(parseMandate({ ...mandateFixture(), status }).status, status);
  }
  assert.equal(parseMandate({ ...mandateFixture(), requiresConfirmation: false }).requiresConfirmation, false);
  rejects(() => parseMandate({ ...mandateFixture(), status: "unknown" }));
});

test("delegation requires an explicit mandate revision and cannot be hidden in per-purchase mode", () => {
  const raw = intentFixture();
  const authorization = { mode: "DELEGATED", mandateId: "mandate_demo", mandateRevision: 2 };
  assert.deepEqual(parseIntent({ ...raw, authorization }).authorization, authorization);
  rejects(() => parseIntent({ ...raw, authorization: { ...authorization, mandateRevision: 0 } }));
  rejects(() => parseIntent({ ...raw, authorization: { mode: "DELEGATED", mandateId: "mandate_demo" } }));
  rejects(() => parseIntent({ ...raw, authorization: { ...authorization, mode: "PER_PURCHASE" } }));
});

test("normalization separates authority records from subsequent mutations of raw input", () => {
  const raw = intentFixture();
  const parsed = parseIntent(raw);
  raw.purchase.payTo = "recipient:changed";
  assert.equal(parsed.purchase.payTo, "recipient:test-merchant");
  const mandateRaw = mandateFixture();
  const mandate = parseMandate(mandateRaw);
  mandateRaw.businesses.push("business_changed");
  assert.deepEqual(mandate.businesses, ["business_demo"]);
});

test("intent commitment is independent of JSON property order", () => {
  const raw = intentFixture();
  const reversed = Object.fromEntries(Object.entries(raw).reverse());
  assert.equal(intentCommitment(parseIntent(reversed)), intentCommitment(parseIntent(raw)));
});

test("every financial and authority condition is bound into the intent commitment", () => {
  const raw = intentFixture();
  const hash = intentCommitment(parseIntent(raw));
  const changes = [
    { principalId: "principal_changed" }, { agentId: "agent_changed" }, { businessId: "business_changed" },
    { serviceId: "service_changed" }, { quoteId: "quote_changed" }, { orderId: "order_changed" },
    { accountRef: "account:changed" }, { quoteHash: `sha256:${"3".repeat(64)}` }, { policyVersion: 2 },
    { authorization: { mode: "DELEGATED", mandateId: "mandate_demo", mandateRevision: 1 } },
    { expiresAt: "2026-10-02T11:20:00.000Z" },
  ];
  for (const change of changes) assert.notEqual(intentCommitment(parseIntent({ ...raw, ...change })), hash);
  for (const change of [
    { quantity: 2 }, { amountAtomic: "8000001" }, { network: "stellar:mainnet" },
    { assetId: "asset:changed" }, { payTo: "recipient:changed" },
    { termsHash: `sha256:${"4".repeat(64)}` }, { quoteExpiresAt: "2026-10-02T11:45:00.000Z" },
  ]) assert.notEqual(intentCommitment(parseIntent({ ...raw, purchase: { ...raw.purchase, ...change } })), hash);
  const delegated = { ...raw, authorization: { mode: "DELEGATED", mandateId: "mandate_demo", mandateRevision: 1 } };
  assert.notEqual(intentCommitment(parseIntent(delegated)), intentCommitment(parseIntent({
    ...delegated, authorization: { ...delegated.authorization, mandateRevision: 2 },
  })));
});

test("approval metadata matches only exact intent, action and unexpired times", () => {
  const intent = parseIntent(intentFixture());
  const action = parseDigest(`sha256:${"5".repeat(64)}`);
  const binding = parseApprovalBinding({
    schema: APPROVAL_SCHEMA, intentId: intent.id, principalId: intent.principalId,
    accountRef: intent.accountRef, commitment: intentCommitment(intent), financialActionHash: action,
    approvedAt: "2026-10-02T11:05:00.000Z", expiresAt: "2026-10-02T11:25:00.000Z",
  });
  const now = parseUtcInstant("2026-10-02T11:10:00.000Z");
  assert.equal(matchesApprovalBinding(intent, binding, action, now), true);
  assert.equal(matchesApprovalBinding(intent, binding, action, binding.expiresAt), false);
  assert.equal(matchesApprovalBinding(intent, binding, parseDigest(`sha256:${"6".repeat(64)}`), now), false);
  assert.equal(matchesApprovalBinding(intent, binding, action, intent.createdAt), false);
  assert.equal(matchesApprovalBinding(parseIntent({ ...intentFixture(), accountRef: "account:changed" }), binding, action, now), false);
  const changedTerms = parseIntent({ ...intentFixture(), purchase: { ...intentFixture().purchase, amountAtomic: "8000001" } });
  assert.equal(matchesApprovalBinding(changedTerms, binding, action, now), false);
  const tooLong = parseApprovalBinding({ ...binding, expiresAt: "2026-10-02T12:00:00.000Z" });
  assert.equal(matchesApprovalBinding(intent, tooLong, action, now), false);
  rejects(() => parseApprovalBinding({ ...binding, approved: true }));
  rejects(() => parseApprovalBinding({ ...binding, schema: "tilcai-approval-v2" }), "UNSUPPORTED_VERSION");
});

test("public references, hashes and idempotency keys have bounded canonical encodings", () => {
  for (const ref of ["", "recipient with spaces", "ref\n", "x".repeat(257)]) rejects(() => parseResourceRef(ref));
  for (const key of ["", "key with spaces", "k".repeat(129)]) rejects(() => parseIdempotencyKey(key));
  rejects(() => parseDigest("sha256:short"));
  rejects(() => parseDigest(`sha256:${"A".repeat(64)}`));
});

function typeAssertions(intent: Intent, mandate: Mandate) {
  // @ts-expect-error Money is an exact decimal string, never a JS number.
  const amount: Intent["purchase"]["amountAtomic"] = 8000000;
  // @ts-expect-error Unparsed strings cannot be treated as UTC instants.
  const time: Intent["expiresAt"] = "2026-10-02T00:00:00.000Z";
  // @ts-expect-error Intent and mandate schemas must not be exchanged.
  const wrongSchema: Intent = mandate;
  // @ts-expect-error Authority records expose readonly snapshots.
  intent.purchase.payTo = parseResourceRef("recipient:changed");
  return [amount, time, wrongSchema];
}
void typeAssertions;
