import { invalidInput } from "./errors.js";
import type { TypedData } from "./types.js";

/** Arguments of an EIP-712 signature, in the shape viem's `signTypedData` takes. */
export interface TypedDataArgs {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

/**
 * What the SDK needs from an EVM wallet: its address and an EIP-712 signature. A viem
 * `LocalAccount` already is one; use `evmSignerFromViem` for a WalletClient, or implement it
 * over any wallet (a hardware signer, a KMS, WalletConnect).
 */
export interface EvmSigner {
  readonly address: `0x${string}`;
  signTypedData(args: TypedDataArgs): Promise<`0x${string}`>;
}

const INT_TYPE = /^u?int\d*$/;

/**
 * Typed data as an EIP-712 library wants it: `EIP712Domain` removed from `types` (the library
 * derives it, and viem rejects a duplicate) and every integer field a bigint instead of the
 * decimal string TilcAI's JSON carries.
 */
export function typedDataArgs(td: TypedData): TypedDataArgs {
  const { EIP712Domain: _drop, ...types } = td.types;
  const fields = types[td.primaryType];
  if (!fields) throw invalidInput(`typed data has no definition for primary type ${td.primaryType}`);
  const message: Record<string, unknown> = { ...td.message };
  for (const f of fields) {
    const v = message[f.name];
    if (INT_TYPE.test(f.type) && (typeof v === "string" || typeof v === "number")) message[f.name] = BigInt(v);
  }
  const domain: Record<string, unknown> = { ...td.domain };
  if (domain.chainId !== undefined) domain.chainId = BigInt(domain.chainId as string | number);
  return { domain, types, primaryType: td.primaryType, message };
}

interface ViemLikeAccount {
  address: `0x${string}`;
  signTypedData: (args: never) => Promise<`0x${string}`>;
}
interface ViemLikeWalletClient {
  account?: { address: `0x${string}` } | undefined;
  signTypedData: (args: never) => Promise<`0x${string}`>;
}

/**
 * Wraps a viem account (`privateKeyToAccount`, `mnemonicToAccount`, …) or a WalletClient.
 * For a WalletClient without a hoisted account, pass the address to sign with.
 */
export function evmSignerFromViem(source: ViemLikeAccount | ViemLikeWalletClient, address?: `0x${string}`): EvmSigner {
  // A LocalAccount has `address`; a WalletClient has `account` (possibly undefined) and needs it per call.
  if ("address" in source && typeof source.address === "string") {
    const account = source;
    return { address: account.address, signTypedData: (args) => account.signTypedData(args as never) };
  }
  const client = source as ViemLikeWalletClient;
  const addr = address ?? client.account?.address;
  if (!addr) throw invalidInput("a viem WalletClient needs an account (or pass the address to sign with)");
  return { address: addr, signTypedData: (args) => client.signTypedData({ ...args, account: client.account ?? addr } as never) };
}

/** A signer from a raw private key. Needs the optional peer dependency `viem`. */
export async function evmSignerFromPrivateKey(privateKey: `0x${string}`): Promise<EvmSigner> {
  const { privateKeyToAccount } = await importPeer<typeof import("viem/accounts")>("viem/accounts", "an EVM signer from a private key");
  return evmSignerFromViem(privateKeyToAccount(privateKey) as unknown as ViemLikeAccount);
}

/** Loads an optional peer dependency with a message that says what to install. */
export async function importPeer<T>(specifier: string, why: string): Promise<T> {
  try {
    return (await import(specifier)) as T;
  } catch (cause) {
    const pkg = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!;
    throw new Error(`${why} needs the optional dependency "${pkg}": npm install ${pkg}`, { cause });
  }
}
