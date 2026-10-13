// Mirrors tilcai-core/src/policy.ts (tilcai-shared-v1 contracts, proposal pending team review).
// Small, pure policy prototype. Amounts are integer micro-USDC (1 USDC = 1_000_000).
// No wallet, x402 challenge, signature, shared-state reservation or on-chain payment here.
export type PaymentIntent = {
  id: string;
  network: string;
  asset: string;
  resource: string;
  payTo: string;
  amountMicros: number;
};

export type Policy = {
  network: string;
  asset: string;
  allowedResources: readonly string[];
  allowedPayTo: readonly string[];
  maxPaymentMicros: number;
  remainingMicros: number;
  paused: boolean;
  expiresAtMs: number;
};

export type Decision =
  | { outcome: "ALLOW"; reason: "POLICY_OK" }
  | { outcome: "DENY"; reason: "INVALID_INPUT" | "PAUSED" | "EXPIRED" | "DUPLICATE" | "NETWORK_OR_ASSET" | "RESOURCE" | "RECIPIENT" | "PAYMENT_LIMIT" | "BUDGET" };

export function evaluateIntent(
  intent: PaymentIntent,
  policy: Policy,
  seenIntentIds: ReadonlySet<string>,
  nowMs: number,
): Decision {
  const deny = (reason: Extract<Decision, { outcome: "DENY" }>["reason"]): Decision => ({ outcome: "DENY", reason });
  if (!intent.id || !intent.resource || !intent.payTo || !Number.isSafeInteger(intent.amountMicros) || intent.amountMicros <= 0 ||
      !Number.isSafeInteger(policy.maxPaymentMicros) || !Number.isSafeInteger(policy.remainingMicros) ||
      policy.maxPaymentMicros < 0 || policy.remainingMicros < 0 || !Number.isFinite(nowMs)) return deny("INVALID_INPUT");
  if (policy.paused) return deny("PAUSED");
  if (nowMs >= policy.expiresAtMs) return deny("EXPIRED");
  if (seenIntentIds.has(intent.id)) return deny("DUPLICATE");
  if (intent.network !== policy.network || intent.asset !== policy.asset) return deny("NETWORK_OR_ASSET");
  if (!policy.allowedResources.includes(intent.resource)) return deny("RESOURCE");
  if (!policy.allowedPayTo.includes(intent.payTo)) return deny("RECIPIENT");
  if (intent.amountMicros > policy.maxPaymentMicros) return deny("PAYMENT_LIMIT");
  if (intent.amountMicros > policy.remainingMicros) return deny("BUDGET");
  return { outcome: "ALLOW", reason: "POLICY_OK" };
}
