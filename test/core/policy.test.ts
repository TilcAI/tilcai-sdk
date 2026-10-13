import assert from "node:assert/strict";
import test from "node:test";
import { evaluateIntent, type PaymentIntent, type Policy } from "../../src/core/policy.js";

const now = 1_000;
const intent: PaymentIntent = {
  id: "purchase-1", network: "stellar:testnet", asset: "USDC",
  resource: "/report", payTo: "G_APPROVED", amountMicros: 50_000,
};
const policy: Policy = {
  network: "stellar:testnet", asset: "USDC", allowedResources: ["/report"],
  allowedPayTo: ["G_APPROVED"], maxPaymentMicros: 100_000,
  remainingMicros: 80_000, paused: false, expiresAtMs: 2_000,
};
const check = (i: PaymentIntent, p: Policy = policy, seen = new Set<string>()) => evaluateIntent(i, p, seen, now);

test("allows an intent within policy", () => assert.deepEqual(check(intent), { outcome: "ALLOW", reason: "POLICY_OK" }));
test("blocks a changed recipient", () => assert.equal(check({ ...intent, payTo: "G_ATTACKER" }).reason, "RECIPIENT"));
test("blocks spending above remaining budget", () => assert.equal(check({ ...intent, amountMicros: 90_000 }).reason, "BUDGET"));
test("blocks duplicate intents", () => assert.equal(check(intent, policy, new Set([intent.id])).reason, "DUPLICATE"));
test("blocks expired policies", () => assert.equal(check(intent, { ...policy, expiresAtMs: now }).reason, "EXPIRED"));
test("blocks invalid amounts", () => assert.equal(check({ ...intent, amountMicros: Number.NaN }).reason, "INVALID_INPUT"));
