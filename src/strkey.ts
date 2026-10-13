/**
 * Minimal Stellar StrKey codec (SEP-0023): validates and converts `G…` accounts and `C…` contracts
 * without pulling in @stellar/stellar-sdk. Only what the SDK needs to check addresses before a
 * request leaves and to turn a `G…` address into the Ed25519 owner key SCA issuance expects.
 */
import { invalidInput } from "./errors.js";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const VERSION = { ed25519PublicKey: 6 << 3, contract: 2 << 3 } as const;

function crc16xmodem(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

function base32Decode(text: string): Uint8Array | null {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function decode(address: string, version: number): Uint8Array | null {
  if (typeof address !== "string" || address.length !== 56 || address !== address.toUpperCase()) return null;
  const raw = base32Decode(address);
  if (!raw || raw.length !== 35 || raw[0] !== version) return null;
  const payload = raw.subarray(0, 33);
  const checksum = raw[33]! | (raw[34]! << 8);
  return crc16xmodem(payload) === checksum ? raw.subarray(1, 33) : null;
}

function encode(version: number, key: Uint8Array): string {
  const payload = new Uint8Array(33);
  payload[0] = version;
  payload.set(key, 1);
  const crc = crc16xmodem(payload);
  const raw = new Uint8Array(35);
  raw.set(payload);
  raw[33] = crc & 0xff;
  raw[34] = crc >> 8;
  return base32Encode(raw);
}

/** `G…` account id with a valid checksum. */
export function isStellarAccount(address: string): boolean {
  return decode(address, VERSION.ed25519PublicKey) !== null;
}

/** `C…` Soroban contract id with a valid checksum. */
export function isStellarContract(address: string): boolean {
  return decode(address, VERSION.contract) !== null;
}

export const isEvmAddress = (value: string): value is `0x${string}` => /^0x[0-9a-fA-F]{40}$/.test(value);

/** The 32 raw bytes of a `G…` address as `0x…` hex: what `owner.publicKey` takes for an Ed25519 owner. */
export function stellarAccountToHex(address: string): `0x${string}` {
  const key = decode(address, VERSION.ed25519PublicKey);
  if (!key) throw invalidInput(`not a valid Stellar account address: ${address}`);
  return `0x${Buffer.from(key).toString("hex")}`;
}

export function hexToStellarAccount(hex: string): string {
  const m = /^(?:0x)?([0-9a-fA-F]{64})$/.exec(hex);
  if (!m) throw invalidInput("an Ed25519 public key is 32 bytes (64 hex characters)");
  return encode(VERSION.ed25519PublicKey, Buffer.from(m[1]!, "hex"));
}

export function hexToStellarContract(hex: string): string {
  const m = /^(?:0x)?([0-9a-fA-F]{64})$/.exec(hex);
  if (!m) throw invalidInput("a contract id is 32 bytes (64 hex characters)");
  return encode(VERSION.contract, Buffer.from(m[1]!, "hex"));
}
