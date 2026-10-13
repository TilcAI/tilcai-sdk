import { INTENT_SCHEMA, MANDATE_SCHEMA } from "../../../src/core/authority.js";

// Synthetic registry references; these are neither addresses nor operational assets.
export function intentFixture() {
  return {
    schema: INTENT_SCHEMA, id: "intent_demo", principalId: "principal_demo", agentId: "agent_demo",
    businessId: "business_demo", serviceId: "service_demo", quoteId: "quote_demo", orderId: "order_demo",
    accountRef: "account:test-buyer", quoteHash: `sha256:${"1".repeat(64)}`,
    purchase: {
      quantity: 1, amountAtomic: "8000000", network: "stellar:testnet", assetId: "asset:test-configured",
      payTo: "recipient:test-merchant", termsHash: `sha256:${"2".repeat(64)}`,
      quoteExpiresAt: "2026-10-02T12:00:00.000Z",
    },
    policyVersion: 1, authorization: { mode: "PER_PURCHASE" },
    createdAt: "2026-10-02T11:00:00.000Z", expiresAt: "2026-10-02T11:30:00.000Z",
  };
}

export function mandateFixture() {
  return {
    schema: MANDATE_SCHEMA, id: "mandate_demo", revision: 1, principalId: "principal_demo", agentId: "agent_demo",
    accountRef: "account:test-buyer", network: "stellar:testnet", assetId: "asset:test-configured",
    businesses: ["business_demo"], services: ["service_demo"], recipients: ["recipient:test-merchant"],
    limits: {
      maxPerPurchaseAtomic: "10000000", maxPerPeriodAtomic: "50000000", periodSeconds: 604800,
      periodAnchor: "2026-09-28T00:00:00.000Z",
    },
    budgetRef: "budget:test-root", requiresConfirmation: true, policyVersion: 1,
    validFrom: "2026-09-30T00:00:00.000Z", expiresAt: "2026-10-30T00:00:00.000Z", status: "ACTIVE",
  };
}
