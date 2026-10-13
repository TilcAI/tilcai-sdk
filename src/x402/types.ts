/** x402 v2, scheme `exact`. Shapes follow the facilitator plugin of the OpenZeppelin Relayer TilcAI runs. */
export const X402_VERSION = 2 as const;

export interface PaymentRequirements {
  scheme: "exact";
  /** CAIP-2: `eip155:43113`, `eip155:10143`, `stellar:testnet`, … */
  network: string;
  /** Atomic units as an integer string. Never a float. */
  amount: string;
  /** Token contract (EVM) or SAC contract id (Stellar). */
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  /** EVM: the token's EIP-712 `name` and `version`. Stellar: `areFeesSponsored`. */
  extra?: Record<string, unknown>;
}

export interface ResourceInfo {
  url?: string;
  description?: string;
  mimeType?: string;
}

/** The body (and base64 `PAYMENT-REQUIRED` header) of an HTTP 402. */
export interface PaymentRequired {
  x402Version: typeof X402_VERSION;
  error?: string;
  resource?: ResourceInfo;
  accepts: PaymentRequirements[];
}

export interface EvmExactPayload {
  signature: `0x${string}`;
  authorization: { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: `0x${string}` };
}

export interface StellarExactPayload {
  /** Base64 XDR of an unsigned envelope whose only operation is the SAC `transfer`, with the payer's signed auth entry. */
  transaction: string;
}

export interface PaymentPayload {
  x402Version: typeof X402_VERSION;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: EvmExactPayload | StellarExactPayload;
}

export interface FacilitatorRequest {
  x402Version: typeof X402_VERSION;
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}

export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

export interface SettleResponse {
  success: boolean;
  errorReason?: string;
  /** Transaction hash. May be present even when `success` is false (failure after submission). */
  transaction: string;
  network: string;
  payer?: string;
}

export interface SupportedResponse {
  kinds: Array<{ x402Version: number; scheme: string; network: string; extra?: Record<string, unknown> }>;
  signers: Record<string, string[]>;
}
