/**
 * Network registry. Identifiers are CAIP-2, the same ones TilcAI's API and x402 use.
 * Values mirror tilcai-infrastructure `src/config/networks.ts` (Circle, Stellar, Avalanche and
 * Monad official references). TilcAI-owned contract addresses are never hard-coded here:
 * ask the instance (`tilcai.routes()`, `tilcai.vault.status()`).
 */
import { TilcaiError } from "./errors.js";

export type Environment = "testnet" | "mainnet";
export type EvmNetworkId = "eip155:43113" | "eip155:43114" | "eip155:10143";
export type StellarNetworkId = "stellar:testnet" | "stellar:pubnet";
export type NetworkId = EvmNetworkId | StellarNetworkId;
/** Friendly names accepted wherever a network is expected. */
export type NetworkAlias = "avalanche" | "avalanche-fuji" | "monad" | "monad-testnet" | "stellar";

export interface EvmNetworkInfo {
  id: EvmNetworkId;
  family: "evm";
  name: string;
  environment: Environment;
  chainId: number;
  cctpDomain: number;
  nativeSymbol: string;
  explorer: string;
  usdc: { address: `0x${string}`; decimals: 6; eip712Name: string; eip712Version: string };
}

export interface StellarNetworkInfo {
  id: StellarNetworkId;
  family: "stellar";
  name: string;
  environment: Environment;
  cctpDomain: number;
  nativeSymbol: "XLM";
  explorer: string;
  passphrase: string;
  /** Soroban RPC used by the x402 helpers when none is given. Absent where no public endpoint is documented. */
  defaultRpcUrl?: string;
  usdc: { code: "USDC"; issuer: string; sac: string; decimals: 7 };
}

export type NetworkInfo = EvmNetworkInfo | StellarNetworkInfo;

export const NETWORKS: Readonly<Record<NetworkId, NetworkInfo>> = Object.freeze({
  "eip155:43113": {
    id: "eip155:43113",
    family: "evm",
    name: "Avalanche Fuji",
    environment: "testnet",
    chainId: 43113,
    cctpDomain: 1,
    nativeSymbol: "AVAX",
    explorer: "https://testnet.snowtrace.io",
    usdc: { address: "0x5425890298aed601595a70AB815c96711a31Bc65", decimals: 6, eip712Name: "USD Coin", eip712Version: "2" },
  },
  "eip155:43114": {
    id: "eip155:43114",
    family: "evm",
    name: "Avalanche C-Chain",
    environment: "mainnet",
    chainId: 43114,
    cctpDomain: 1,
    nativeSymbol: "AVAX",
    explorer: "https://explorer.avax.network/c-chain",
    usdc: { address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", decimals: 6, eip712Name: "USD Coin", eip712Version: "2" },
  },
  "eip155:10143": {
    id: "eip155:10143",
    family: "evm",
    name: "Monad Testnet",
    environment: "testnet",
    chainId: 10143,
    cctpDomain: 15,
    nativeSymbol: "MON",
    explorer: "https://testnet.monadscan.com",
    // Monad's USDC signs its EIP-3009 messages under the domain name "USDC", not Fuji's "USD Coin".
    usdc: { address: "0x534b2f3A21130d7a60830c2Df862319e593943A3", decimals: 6, eip712Name: "USDC", eip712Version: "2" },
  },
  "stellar:testnet": {
    id: "stellar:testnet",
    family: "stellar",
    name: "Stellar Testnet",
    environment: "testnet",
    cctpDomain: 27,
    nativeSymbol: "XLM",
    explorer: "https://stellar.expert/explorer/testnet",
    passphrase: "Test SDF Network ; September 2015",
    defaultRpcUrl: "https://soroban-testnet.stellar.org",
    usdc: {
      code: "USDC",
      issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      sac: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      decimals: 7,
    },
  },
  "stellar:pubnet": {
    id: "stellar:pubnet",
    family: "stellar",
    name: "Stellar Public Network",
    environment: "mainnet",
    cctpDomain: 27,
    nativeSymbol: "XLM",
    explorer: "https://stellar.expert/explorer/public",
    passphrase: "Public Global Stellar Network ; September 2015",
    usdc: {
      code: "USDC",
      issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      sac: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
      decimals: 7,
    },
  },
});

/** Source networks of a CCTP payment per environment (Monad joins in testnet only). */
export const SOURCE_NETWORKS: Readonly<Record<Environment, readonly EvmNetworkId[]>> = {
  testnet: ["eip155:43113", "eip155:10143"],
  mainnet: ["eip155:43114"],
};

export const DESTINATION_NETWORK: Readonly<Record<Environment, StellarNetworkId>> = {
  testnet: "stellar:testnet",
  mainnet: "stellar:pubnet",
};

const ALIASES: Readonly<Record<NetworkAlias, { testnet: NetworkId; mainnet?: NetworkId }>> = {
  avalanche: { testnet: "eip155:43113", mainnet: "eip155:43114" },
  "avalanche-fuji": { testnet: "eip155:43113" },
  monad: { testnet: "eip155:10143" },
  "monad-testnet": { testnet: "eip155:10143" },
  stellar: { testnet: "stellar:testnet", mainnet: "stellar:pubnet" },
};

export function isNetworkId(value: unknown): value is NetworkId {
  return typeof value === "string" && Object.hasOwn(NETWORKS, value);
}

export function isEvmNetwork(info: NetworkInfo): info is EvmNetworkInfo {
  return info.family === "evm";
}

export function isStellarNetwork(info: NetworkInfo): info is StellarNetworkInfo {
  return info.family === "stellar";
}

/**
 * Resolves a CAIP-2 id or an alias (`"avalanche"`, `"monad"`, `"stellar"`) to a network.
 * An alias takes the environment it is asked for: `resolveNetwork("avalanche", "mainnet")` is C-Chain.
 */
export function resolveNetwork(input: string, environment: Environment = "testnet"): NetworkInfo {
  const key = input.trim().toLowerCase();
  if (isNetworkId(key)) return NETWORKS[key];
  const alias = (ALIASES as Record<string, { testnet: NetworkId; mainnet?: NetworkId } | undefined>)[key];
  const id = alias?.[environment];
  if (id) return NETWORKS[id];
  const hint = alias ? ` (no ${environment} deployment of "${input}")` : "";
  throw new TilcaiError({
    status: 0,
    code: "UNKNOWN_NETWORK",
    message: `unknown network "${input}"${hint}; use a CAIP-2 id (${Object.keys(NETWORKS).join(", ")}) or an alias (${Object.keys(ALIASES).join(", ")})`,
    recovery: "FIX_REQUEST",
  });
}

export function resolveEvmNetwork(input: string, environment: Environment = "testnet"): EvmNetworkInfo {
  const n = resolveNetwork(input, environment);
  if (!isEvmNetwork(n)) {
    throw new TilcaiError({ status: 0, code: "UNKNOWN_NETWORK", message: `${n.id} is not an EVM network`, recovery: "FIX_REQUEST" });
  }
  return n;
}

export function resolveStellarNetwork(input: string, environment: Environment = "testnet"): StellarNetworkInfo {
  const n = resolveNetwork(input, environment);
  if (!isStellarNetwork(n)) {
    throw new TilcaiError({ status: 0, code: "UNKNOWN_NETWORK", message: `${n.id} is not a Stellar network`, recovery: "FIX_REQUEST" });
  }
  return n;
}

/** Explorer link for a transaction, an address or a Soroban contract. */
export function explorerUrl(network: NetworkId, kind: "tx" | "address" | "contract", id: string): string {
  const n = NETWORKS[network];
  if (n.family === "stellar") return `${n.explorer}/${kind === "tx" ? "tx" : kind === "address" ? "account" : "contract"}/${id}`;
  return `${n.explorer}/${kind === "tx" ? "tx" : "address"}/${id}`;
}
