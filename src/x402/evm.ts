import { randomBytes } from "node:crypto";
import { invalidInput } from "../errors.js";
import { NETWORKS, isEvmNetwork } from "../networks.js";
import type { EvmSigner } from "../signers.js";
import { isEvmAddress } from "../strkey.js";
import type { PaymentPayload, PaymentRequirements, ResourceInfo } from "./types.js";
import { X402_VERSION } from "./types.js";

const TRANSFER_WITH_AUTHORIZATION = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
] as const;

export interface EvmPayloadOptions {
  requirements: PaymentRequirements;
  signer: EvmSigner;
  resource?: ResourceInfo;
  /** Unix seconds; injectable for tests. */
  now?: number;
}

/**
 * Builds the x402 `exact` payload for an EVM network: the payer signs an EIP-3009
 * `TransferWithAuthorization` (USDC) that moves exactly `amount` to `payTo`. The facilitator's
 * relayer submits it and pays the gas.
 */
export async function createEvmPayload(o: EvmPayloadOptions): Promise<PaymentPayload> {
  const r = o.requirements;
  const net = NETWORKS[r.network as keyof typeof NETWORKS];
  if (!net || !isEvmNetwork(net)) throw invalidInput(`${r.network} is not an EVM network the SDK knows`);
  if (!isEvmAddress(r.payTo)) throw invalidInput(`payTo must be an EVM address on ${r.network}, got ${r.payTo}`);
  const name = r.extra?.name;
  const version = r.extra?.version;
  if (typeof name !== "string" || typeof version !== "string") throw invalidInput("requirements.extra must carry the token's EIP-712 name and version");

  const now = o.now ?? Math.floor(Date.now() / 1000);
  const authorization = {
    from: o.signer.address,
    to: r.payTo,
    value: r.amount,
    // Ten minutes back absorbs clock skew between payer, facilitator and chain.
    validAfter: String(now - 600),
    validBefore: String(now + r.maxTimeoutSeconds),
    nonce: `0x${randomBytes(32).toString("hex")}` as `0x${string}`,
  };
  const signature = await o.signer.signTypedData({
    domain: { name, version, chainId: BigInt(net.chainId), verifyingContract: r.asset },
    types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION.map((f) => ({ ...f })) },
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  });
  return { x402Version: X402_VERSION, ...(o.resource ? { resource: o.resource } : {}), accepted: r, payload: { signature, authorization } };
}
