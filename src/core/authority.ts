// Mirrors tilcai-core/src/authority.ts (tilcai-shared-v1 contracts, proposal pending team review).
import { createHash } from "node:crypto";
import {
  parseId, createContractError,
  type PrincipalId, type AgentId, type BusinessId, type ServiceId,
  type QuoteId, type OrderId, type IntentId, type MandateId, type ContractError,
} from "./contracts.js";

export const INTENT_SCHEMA = "tilcai-intent-v1";
export const MANDATE_SCHEMA = "tilcai-mandate-v1";
export const APPROVAL_SCHEMA = "tilcai-approval-v1";
export type StellarNetwork = "stellar:testnet" | "stellar:mainnet";
declare const valueBrand: unique symbol;
type Value<K extends string> = string & { readonly [valueBrand]: K };
export type AtomicAmount = Value<"atomicAmount">;
export type UtcInstant = Value<"utcInstant">;
export type ResourceRef = Value<"resourceRef">;
export type Sha256Digest = Value<"sha256Digest">;
export type IdempotencyKey = Value<"idempotencyKey">;

export interface PurchaseTerms {
  readonly quantity: number;
  readonly amountAtomic: AtomicAmount;
  readonly network: StellarNetwork;
  readonly assetId: ResourceRef;
  readonly payTo: ResourceRef;
  readonly termsHash: Sha256Digest;
  readonly quoteExpiresAt: UtcInstant;
}

export type IntentAuthorization =
  | { readonly mode: "PER_PURCHASE" }
  | { readonly mode: "DELEGATED"; readonly mandateId: MandateId; readonly mandateRevision: number };

export interface Intent {
  readonly schema: typeof INTENT_SCHEMA;
  readonly id: IntentId;
  readonly principalId: PrincipalId;
  readonly agentId: AgentId;
  readonly businessId: BusinessId;
  readonly serviceId: ServiceId;
  readonly quoteId: QuoteId;
  readonly orderId: OrderId;
  readonly accountRef: ResourceRef;
  readonly quoteHash: Sha256Digest;
  readonly purchase: PurchaseTerms;
  readonly policyVersion: number;
  readonly authorization: IntentAuthorization;
  readonly createdAt: UtcInstant;
  readonly expiresAt: UtcInstant;
}

export interface Mandate {
  readonly schema: typeof MANDATE_SCHEMA;
  readonly id: MandateId;
  readonly revision: number;
  readonly principalId: PrincipalId;
  readonly agentId: AgentId;
  readonly accountRef: ResourceRef;
  readonly network: StellarNetwork;
  readonly assetId: ResourceRef;
  readonly businesses: readonly BusinessId[];
  readonly services: readonly ServiceId[];
  readonly recipients: readonly ResourceRef[];
  readonly limits: {
    readonly maxPerPurchaseAtomic: AtomicAmount;
    readonly maxPerPeriodAtomic: AtomicAmount;
    readonly periodSeconds: number;
    readonly periodAnchor: UtcInstant;
  };
  readonly budgetRef: ResourceRef;
  readonly parentMandateId?: MandateId;
  readonly requiresConfirmation: boolean;
  readonly policyVersion: number;
  readonly validFrom: UtcInstant;
  readonly expiresAt: UtcInstant;
  readonly status: "ACTIVE" | "PAUSED" | "REVOKED";
}

// Metadata from a trusted approval store, never an agent-supplied signature.
export interface ApprovalBinding {
  readonly schema: typeof APPROVAL_SCHEMA;
  readonly intentId: IntentId;
  readonly principalId: PrincipalId;
  readonly accountRef: ResourceRef;
  readonly commitment: Sha256Digest;
  readonly financialActionHash: Sha256Digest;
  readonly approvedAt: UtcInstant;
  readonly expiresAt: UtcInstant;
}

export class ContractValidationError extends TypeError {
  readonly contractError: ContractError;
  constructor(code: "INVALID_INPUT" | "UNSUPPORTED_VERSION") {
    const error = createContractError(code);
    super(error.message);
    this.name = "ContractValidationError";
    this.contractError = error;
  }
}

function invalid(code: "INVALID_INPUT" | "UNSUPPORTED_VERSION" = "INVALID_INPUT"): never {
  throw new ContractValidationError(code);
}

// Boundary input is JSON-decoded data; unknown fields cannot smuggle approval/keys.
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !keys.includes(key)) invalid();
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !Object.hasOwn(property, "value") || !property.enumerable) invalid();
  }
  return value as Record<string, unknown>;
}

function version(value: unknown, expected: string): void {
  if (value !== expected) invalid("UNSUPPORTED_VERSION");
}

function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) invalid();
  return value;
}

function network(value: unknown): StellarNetwork {
  if (value !== "stellar:testnet" && value !== "stellar:mainnet") invalid();
  return value;
}

function entity<K extends Parameters<typeof parseId>[0]>(kind: K, value: unknown) {
  try { return parseId(kind, value); } catch { return invalid(); }
}

export function parseAtomicAmount(value: unknown): AtomicAmount {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(value)) invalid();
  return value as AtomicAmount;
}

function positiveAmount(value: unknown): AtomicAmount {
  const amount = parseAtomicAmount(value);
  if (amount === "0") invalid();
  return amount;
}

export function parseUtcInstant(value: unknown): UtcInstant {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) invalid();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) invalid();
  return value as UtcInstant;
}

export function parseResourceRef(value: unknown): ResourceRef {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/.test(value)) invalid();
  return value as ResourceRef;
}

export function parseDigest(value: unknown): Sha256Digest {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) invalid();
  return value as Sha256Digest;
}

export function parseIdempotencyKey(value: unknown): IdempotencyKey {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) invalid();
  return value as IdempotencyKey;
}

export function parsePurchaseTerms(value: unknown): PurchaseTerms {
  const v = record(value, ["quantity", "amountAtomic", "network", "assetId", "payTo", "termsHash", "quoteExpiresAt"]);
  return {
    quantity: positiveInteger(v.quantity), amountAtomic: positiveAmount(v.amountAtomic),
    network: network(v.network), assetId: parseResourceRef(v.assetId),
    payTo: parseResourceRef(v.payTo), termsHash: parseDigest(v.termsHash),
    quoteExpiresAt: parseUtcInstant(v.quoteExpiresAt),
  };
}

export function parseIntent(value: unknown): Intent {
  const v = record(value, ["schema", "id", "principalId", "agentId", "businessId", "serviceId",
    "quoteId", "orderId", "accountRef", "quoteHash", "purchase", "policyVersion", "authorization", "createdAt", "expiresAt"]);
  version(v.schema, INTENT_SCHEMA);
  const a = record(v.authorization, ["mode", "mandateId", "mandateRevision"]);
  let authorization: IntentAuthorization;
  if (a.mode === "PER_PURCHASE") {
    if (Object.hasOwn(a, "mandateId") || Object.hasOwn(a, "mandateRevision")) invalid();
    authorization = { mode: "PER_PURCHASE" };
  } else if (a.mode === "DELEGATED") {
    authorization = { mode: "DELEGATED", mandateId: entity("mandate", a.mandateId), mandateRevision: positiveInteger(a.mandateRevision) };
  } else invalid();
  const purchase = parsePurchaseTerms(v.purchase);
  const createdAt = parseUtcInstant(v.createdAt);
  const expiresAt = parseUtcInstant(v.expiresAt);
  if (expiresAt <= createdAt || expiresAt > purchase.quoteExpiresAt) invalid();
  return {
    schema: INTENT_SCHEMA, id: entity("intent", v.id), principalId: entity("principal", v.principalId),
    agentId: entity("agent", v.agentId), businessId: entity("business", v.businessId),
    serviceId: entity("service", v.serviceId), quoteId: entity("quote", v.quoteId), orderId: entity("order", v.orderId),
    accountRef: parseResourceRef(v.accountRef), quoteHash: parseDigest(v.quoteHash),
    purchase, policyVersion: positiveInteger(v.policyVersion), authorization, createdAt, expiresAt,
  };
}

function list<T>(value: unknown, parse: (value: unknown) => T): readonly T[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1000) invalid();
  const values = Array.from(value, parse);
  if (new Set(values).size !== values.length) invalid();
  return values;
}

export function parseMandate(value: unknown): Mandate {
  const v = record(value, ["schema", "id", "revision", "principalId", "agentId", "accountRef",
    "network", "assetId", "businesses", "services", "recipients", "limits", "budgetRef",
    "parentMandateId", "requiresConfirmation", "policyVersion", "validFrom", "expiresAt", "status"]);
  version(v.schema, MANDATE_SCHEMA);
  const limits = record(v.limits, ["maxPerPurchaseAtomic", "maxPerPeriodAtomic", "periodSeconds", "periodAnchor"]);
  const maxPerPurchaseAtomic = positiveAmount(limits.maxPerPurchaseAtomic);
  const maxPerPeriodAtomic = positiveAmount(limits.maxPerPeriodAtomic);
  if (BigInt(maxPerPurchaseAtomic) > BigInt(maxPerPeriodAtomic)) invalid();
  const validFrom = parseUtcInstant(v.validFrom);
  const expiresAt = parseUtcInstant(v.expiresAt);
  const periodAnchor = parseUtcInstant(limits.periodAnchor);
  if (expiresAt <= validFrom || periodAnchor > validFrom) invalid();
  if (typeof v.requiresConfirmation !== "boolean") invalid();
  if (v.status !== "ACTIVE" && v.status !== "PAUSED" && v.status !== "REVOKED") invalid();
  const id = entity("mandate", v.id);
  const parent = Object.hasOwn(v, "parentMandateId") ? entity("mandate", v.parentMandateId) : undefined;
  if (parent === id) invalid();
  return {
    schema: MANDATE_SCHEMA, id, revision: positiveInteger(v.revision),
    principalId: entity("principal", v.principalId), agentId: entity("agent", v.agentId),
    accountRef: parseResourceRef(v.accountRef), network: network(v.network), assetId: parseResourceRef(v.assetId),
    businesses: list(v.businesses, value => entity("business", value)),
    services: list(v.services, value => entity("service", value)), recipients: list(v.recipients, parseResourceRef),
    limits: { maxPerPurchaseAtomic, maxPerPeriodAtomic, periodSeconds: positiveInteger(limits.periodSeconds), periodAnchor },
    budgetRef: parseResourceRef(v.budgetRef), ...(parent === undefined ? {} : { parentMandateId: parent }),
    requiresConfirmation: v.requiresConfirmation, policyVersion: positiveInteger(v.policyVersion), validFrom, expiresAt, status: v.status,
  };
}

export function parseApprovalBinding(value: unknown): ApprovalBinding {
  const v = record(value, ["schema", "intentId", "principalId", "accountRef", "commitment", "financialActionHash", "approvedAt", "expiresAt"]);
  version(v.schema, APPROVAL_SCHEMA);
  const approvedAt = parseUtcInstant(v.approvedAt);
  const expiresAt = parseUtcInstant(v.expiresAt);
  if (expiresAt <= approvedAt) invalid();
  return {
    schema: APPROVAL_SCHEMA, intentId: entity("intent", v.intentId), principalId: entity("principal", v.principalId),
    accountRef: parseResourceRef(v.accountRef), commitment: parseDigest(v.commitment),
    financialActionHash: parseDigest(v.financialActionHash), approvedAt, expiresAt,
  };
}

/** Own versioned commitment, not a signature or payment authorization. */
export function intentCommitment(value: Intent): Sha256Digest {
  const i = parseIntent(value);
  const p = i.purchase;
  const a = i.authorization;
  const encoded = JSON.stringify([
    "tilcai-intent-commitment-v1", i.schema, i.id, i.principalId, i.agentId,
    i.businessId, i.serviceId, i.quoteId, i.orderId, i.accountRef, i.quoteHash,
    p.quantity, p.amountAtomic, p.network, p.assetId, p.payTo, p.termsHash, p.quoteExpiresAt,
    i.policyVersion, a.mode, a.mode === "DELEGATED" ? a.mandateId : null,
    a.mode === "DELEGATED" ? a.mandateRevision : null, i.createdAt, i.expiresAt,
  ]);
  return parseDigest(`sha256:${createHash("sha256").update(encoded, "utf8").digest("hex")}`);
}

/** Metadata comparison ONLY. The caller must authenticate approval and authority. */
export function matchesApprovalBinding(
  value: Intent, binding: ApprovalBinding, financialActionHash: Sha256Digest, now: UtcInstant,
): boolean {
  try {
    const i = parseIntent(value);
    const a = parseApprovalBinding(binding);
    const at = parseUtcInstant(now);
    return a.intentId === i.id && a.principalId === i.principalId && a.accountRef === i.accountRef &&
      a.commitment === intentCommitment(i) && a.financialActionHash === parseDigest(financialActionHash) &&
      a.approvedAt >= i.createdAt && a.approvedAt <= at && a.expiresAt <= i.expiresAt && at < a.expiresAt;
  } catch { return false; }
}
