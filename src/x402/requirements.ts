import { decimalToAtomic } from "../amount.js";
import { invalidInput } from "../errors.js";
import { isEvmNetwork, resolveNetwork, type Environment, type NetworkAlias, type NetworkId } from "../networks.js";
import type { PaymentRequirements } from "./types.js";

export interface RequirementsInput {
  /** CAIP-2 or alias (`"avalanche"`, `"monad"`, `"stellar"`). */
  network: NetworkId | NetworkAlias;
  environment?: Environment;
  /** Decimal USDC, `"0.05"`. Give this or `amountAtomic`. */
  amount?: string;
  amountAtomic?: string | bigint;
  payTo: string;
  /** Token (EVM) or SAC (Stellar). Defaults to the network's USDC. */
  asset?: string;
  /** EVM only: the token's EIP-712 domain, when it is not the network's USDC. */
  tokenName?: string;
  tokenVersion?: string;
  /** Default 60. On Stellar this bounds the auth entry's ledger window (`ceil(seconds / 5)` ledgers). */
  maxTimeoutSeconds?: number;
}

/**
 * `PaymentRequirements` for `exact` payments in USDC (or another asset you name), with the
 * per-network details filled in: Monad's USDC signs under the EIP-712 name `USDC`, Fuji's under
 * `USD Coin`; Stellar needs `areFeesSponsored`.
 */
export function buildRequirements(input: RequirementsInput): PaymentRequirements {
  const net = resolveNetwork(input.network, input.environment ?? "testnet");
  const decimals = net.usdc.decimals;
  const atomic =
    input.amountAtomic !== undefined
      ? BigInt(input.amountAtomic)
      : input.amount !== undefined
        ? decimalToAtomic(input.amount, decimals)
        : (() => {
            throw invalidInput("give amount (decimal) or amountAtomic");
          })();
  if (atomic <= 0n) throw invalidInput("amount must be greater than zero");
  if (!input.payTo) throw invalidInput("payTo is required");
  const maxTimeoutSeconds = input.maxTimeoutSeconds ?? 60;
  if (!Number.isInteger(maxTimeoutSeconds) || maxTimeoutSeconds < 5 || maxTimeoutSeconds > 3600) throw invalidInput("maxTimeoutSeconds must be an integer between 5 and 3600");

  if (isEvmNetwork(net)) {
    const asset = input.asset ?? net.usdc.address;
    const isDefault = asset.toLowerCase() === net.usdc.address.toLowerCase();
    const name = input.tokenName ?? (isDefault ? net.usdc.eip712Name : undefined);
    const version = input.tokenVersion ?? (isDefault ? net.usdc.eip712Version : undefined);
    if (!name || !version) throw invalidInput(`asset ${asset} is not ${net.name}'s USDC: give tokenName and tokenVersion (its EIP-712 domain)`);
    return { scheme: "exact", network: net.id, amount: atomic.toString(), asset, payTo: input.payTo, maxTimeoutSeconds, extra: { name, version } };
  }
  return {
    scheme: "exact",
    network: net.id,
    amount: atomic.toString(),
    asset: input.asset ?? net.usdc.sac,
    payTo: input.payTo,
    maxTimeoutSeconds,
    extra: { areFeesSponsored: true },
  };
}
