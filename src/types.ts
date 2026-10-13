import type { NetworkId } from "./networks.js";

/** Shared payment state of `tilcai-shared-v1`. */
export type PaymentState = "NOT_ATTEMPTED" | "PREPARED" | "SENT" | "SETTLED" | "FAILED" | "UNCERTAIN";

/** Detailed CCTP state of a crosschain payment. */
export type CrosschainState = "AWAITING_BURN" | "BURN_SUBMITTED" | "BURN_CONFIRMED" | "ATTESTED" | "MINT_SUBMITTED" | "SETTLED" | "FAILED";

/**
 * external      the payer broadcasts approve + burn from their wallet (pays gas)
 * gasless       the payer signs an EIP-3009 authorization; TilcAI's relayer pays the gas on both chains
 * account       the payer is a smart account issued by TilcAI; its owner signs with a passkey
 * dev_signer / dev_gasless  server-side development key (testnet only, disabled elsewhere)
 */
export type PaymentMode = "external" | "dev_signer" | "gasless" | "dev_gasless" | "account";

export interface Health {
  ok: boolean;
  env: "testnet" | "mainnet";
  transactionsEnabled: boolean;
  relayer: "up" | "down";
  vault: "on" | "off";
  networks: NetworkId[];
  vaultStellar: "on" | "off";
  accounts: "on" | "off";
  qrMock: "on" | "off";
  monitor: "push" | "local";
}

export interface Route {
  protocol: "cctp-v2";
  source: { network: NetworkId; asset: string; domain: number };
  destination: { network: NetworkId; asset: string; domain: number };
  finality: "standard" | "fast";
  mintSubmitter: string;
  transactionsEnabled: boolean;
  /** The source network has TilcaiCctpRouter deployed: `gasless` mode works. */
  gasless: boolean;
  /** …has the account factory and router v2: `account` mode works. */
  account: boolean;
  /** …has a TilcaiVault. */
  vault: boolean;
}

export interface Quote {
  id: string;
  route: { protocol: "cctp-v2"; source: NetworkId; destination: NetworkId; sourceDomain: number; destinationDomain: number };
  payTo: string;
  destination: { asset: "USDC"; amountAtomic: string; amount: string; decimals: number };
  burn: { asset: string; amountAtomic: string; amount: string; decimals: number };
  fees: { protocolBpsHundredths: string; maxFeeAtomic: string; destinationGas: string };
  finality: "standard" | "fast";
  cctp: Record<string, unknown>;
  /** What TilcAI checked about `payTo` on Stellar before quoting. */
  preflight: { payToExists: boolean; payToTrustline: boolean; payToAuthorized: boolean };
  createdAt: string;
  expiresAt: string;
}

export interface Payment {
  id: string;
  quoteId: string;
  orderId: string | null;
  mode: PaymentMode;
  state: CrosschainState;
  paymentState: PaymentState;
  uncertain: boolean;
  payer: string | null;
  burnSubmissionId: string | null;
  burnTxHash: string | null;
  burnBlock: string | null;
  cctpNonce: string | null;
  feeExecutedAtomic: string | null;
  mintSubmitter: string | null;
  mintTxHash: string | null;
  attempts: number;
  lastError: string | null;
  failureCode: string | null;
  nextCheckAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface TypedData {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface UnsignedCall {
  chainId: number;
  to: string;
  data: string;
  value: string;
  description: string;
}

export interface PaymentAuthorization {
  router: string;
  nonce: string;
  validBefore: string | number;
  typedData: TypedData;
  /** `account` mode only: what the owner's passkey signs. */
  account?: {
    challenge: string;
    challengeBase64Url: string;
    appDomainSeparator: string;
    contentsHash: string;
    contentsType: string;
  };
}

export interface CreatedPayment {
  payment: Payment;
  /** Exact calls for the payer's wallet (`external`), in order. */
  unsignedCalls: UnsignedCall[];
  /** `gasless` / `account`: what to sign. */
  authorization?: PaymentAuthorization;
  next: string;
  /** True when the idempotency key had already created this payment (HTTP 200 instead of 201). */
  replayed: boolean;
}

export interface PaymentView {
  payment: Payment;
  paymentState: PaymentState;
  quote: Quote;
  links: { burn: string | null; mint: string | null };
  amounts: { destination: string; burn: string };
  receipt: Record<string, unknown> | null;
  events: Array<Record<string, unknown>>;
}

export type OwnerCredential =
  | { kind: "webauthn-p256"; publicKey: `0x04${string}`; credentialId: string; rpId: string }
  | { kind: "ed25519"; publicKey: `0x${string}` };

export type AccountState = "DEPLOYING" | "ACTIVE" | "FAILED" | (string & {});

export interface SmartAccount {
  id: string;
  externalRef: string;
  network: NetworkId;
  address: string;
  owner: Record<string, unknown>;
  state: AccountState;
  codeRef: string;
  deployTxHash: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreatedAccount {
  account: SmartAccount;
  links: { address: string; deployTx: string | null };
  next: string;
  replayed: boolean;
}

export interface AccountView {
  account: SmartAccount;
  links: { address: string; deployTx: string | null };
  events: Array<Record<string, unknown>>;
}

export interface VaultStatus {
  network: NetworkId;
  address: string;
  asset: string;
  owner: string;
  operator: string;
  relayer: string;
  operatorIsRelayer: boolean;
  paused: boolean;
  balance: string;
  pending: string;
  maxPerDisbursement: string;
  dailyLimit: string;
  availableToday: string;
  explorer: string;
}

export type DisbursementState = "REQUESTED" | "SUBMITTED" | "CONFIRMED" | "FAILED";

export interface Disbursement {
  id: string;
  state: DisbursementState;
  uncertain: boolean;
  network: NetworkId;
  vault: string;
  to: string;
  asset: "USDC";
  amountAtomic: string;
  amount: string;
  reference: string | null;
  submissionId: string | null;
  txHash: string | null;
  blockNumber: string | null;
  attempts: number;
  lastError: string | null;
  failureCode: string | null;
  nextCheckAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreatedDisbursement {
  disbursement: Disbursement;
  links: { tx: string | null };
  replayed: boolean;
}

export type MonitorSeverity = "info" | "warning" | "error";
export type MonitorSource = "tilcai" | "relayer" | "qr-simple";

export interface MonitorEvent {
  seq: number;
  id: string;
  type: string;
  source: MonitorSource;
  severity: MonitorSeverity;
  subject: string | null;
  summary: string;
  data: Record<string, unknown>;
  at: string;
}

export interface MonitorEventsPage {
  schema: string;
  head: number;
  events: MonitorEvent[];
}

export interface MonitorResources {
  schema: string;
  resources: Record<string, unknown>;
  alerts: Array<{ code: string; severity: "warning" | "error"; message: string; since: string }>;
}

export interface RelayerStatus {
  up: boolean;
  authenticated: boolean;
  x402?: X402SupportedBody | { error: string } | { configured: false };
  stellarRelayer?: Record<string, unknown>;
}

export interface X402SupportedBody {
  kinds: Array<{ x402Version: number; scheme: string; network: string; extra?: Record<string, unknown> }>;
  signers: Record<string, string[]>;
}
