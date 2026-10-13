/**
 * Passkey helpers for SCA issuance and `account`-mode payments. A passkey never leaves the
 * holder's device: TilcAI receives its public key and derives the account address from it.
 */
import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { invalidInput } from "./errors.js";
import type { OwnerCredential } from "./types.js";
import { stellarAccountToHex } from "./strkey.js";

type Bytes = ArrayBuffer | ArrayBufferView | string;

export function toBytes(value: Bytes): Uint8Array {
  if (typeof value === "string") {
    if (/^0x[0-9a-fA-F]*$/.test(value)) return Uint8Array.from(Buffer.from(value.slice(2), "hex"));
    return Uint8Array.from(Buffer.from(value, "base64url"));
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

export const toBase64Url = (value: Bytes): string => Buffer.from(toBytes(value)).toString("base64url");
export const toHex = (value: Bytes): `0x${string}` => `0x${Buffer.from(toBytes(value)).toString("hex")}`;

/** Length of a SubjectPublicKeyInfo DER for an uncompressed P-256 key: 26-byte header + 65-byte point. */
const P256_SPKI_LENGTH = 91;
const P256_SPKI_HEADER = "3059301306072a8648ce3d020106082a8648ce3d030107034200";

/**
 * The 65-byte uncompressed point (`0x04 ‖ x ‖ y`) of a P-256 passkey from any of the shapes a
 * browser or an authenticator library produces:
 *  - SPKI DER (`credential.response.getPublicKey()`),
 *  - a COSE_Key map (CBOR) as stored in `authData`,
 *  - the raw 65-byte point, or `0x…` hex of any of those.
 */
export function p256PublicKey(input: Bytes): `0x04${string}` {
  const bytes = toBytes(input);
  if (bytes.length === 65 && bytes[0] === 0x04) return toHex(bytes) as `0x04${string}`;
  if (bytes.length === P256_SPKI_LENGTH && Buffer.from(bytes.subarray(0, 26)).toString("hex") === P256_SPKI_HEADER) {
    return toHex(bytes.subarray(26)) as `0x04${string}`;
  }
  const cose = tryCoseP256(bytes);
  if (cose) return cose;
  throw invalidInput("not a P-256 public key: expected SPKI DER, a COSE_Key, or a 65-byte uncompressed point");
}

/** Reads kty=2 / crv=1 (P-256) x and y out of a COSE_Key without a CBOR dependency. */
function tryCoseP256(bytes: Uint8Array): `0x04${string}` | null {
  // The key is a small definite-length map: a5 01 02 03 26 20 01 21 58 20 <x> 22 58 20 <y>.
  const hex = Buffer.from(bytes).toString("hex");
  const m = /^a5010203262001215820([0-9a-f]{64})225820([0-9a-f]{64})$/.exec(hex);
  return m ? (`0x04${m[1]}${m[2]}` as `0x04${string}`) : null;
}

/** `owner` for an EVM or Stellar account held by a passkey (WebAuthn, ES256). */
export function passkeyOwner(args: { publicKey: Bytes; credentialId: Bytes; rpId: string }): Extract<OwnerCredential, { kind: "webauthn-p256" }> {
  if (!args.rpId) throw invalidInput("rpId is required (the relying party id the passkey was registered under)");
  const credentialId = typeof args.credentialId === "string" && !/^0x/.test(args.credentialId) ? args.credentialId : toBase64Url(args.credentialId);
  return { kind: "webauthn-p256", publicKey: p256PublicKey(args.publicKey), credentialId, rpId: args.rpId };
}

/** `owner` for a Stellar account held by an Ed25519 key: a `G…` address or the raw 32 bytes. */
export function ed25519Owner(keyOrAddress: string | Uint8Array): Extract<OwnerCredential, { kind: "ed25519" }> {
  if (typeof keyOrAddress === "string" && keyOrAddress.startsWith("G")) return { kind: "ed25519", publicKey: stellarAccountToHex(keyOrAddress) };
  const bytes = toBytes(keyOrAddress);
  if (bytes.length !== 32) throw invalidInput("an Ed25519 public key is 32 bytes (or pass the G… address)");
  return { kind: "ed25519", publicKey: toHex(bytes) };
}

/** What `navigator.credentials.get()` returns, or the same three fields from any authenticator library. */
export interface WebAuthnAssertion {
  authenticatorData: Bytes;
  clientDataJSON: Bytes;
  /** DER ECDSA signature, as the browser returns it. */
  signature: Bytes;
}

/** The three base64url fields `POST /v1/crosschain/payments/:id/authorization` takes in `account` mode. */
export function webauthnPayload(a: WebAuthnAssertion | { response: WebAuthnAssertion }): { authenticatorData: string; clientDataJSON: string; signature: string } {
  const r = "response" in a ? a.response : a;
  return { authenticatorData: toBase64Url(r.authenticatorData), clientDataJSON: toBase64Url(r.clientDataJSON), signature: toBase64Url(r.signature) };
}

/**
 * A passkey held in process memory, for agents and servers that own an account without a
 * person's authenticator (and for tests). It produces assertions the account contract accepts
 * exactly as it accepts a browser's: user presence and verification flags set, a monotonic
 * counter, a `webauthn.get` client data naming the challenge, and an ES256 (P-256) signature.
 *
 * The private key lives in this object: whoever holds it controls the account. Use a platform
 * or hardware authenticator for people.
 */
export class SoftwarePasskey {
  readonly rpId: string;
  readonly credentialId: string;
  readonly origin: string;
  private readonly privateKey: KeyObject;
  private readonly spki: Uint8Array;
  private counter = 0;

  private constructor(rpId: string, credentialId: string, origin: string, privateKey: KeyObject, spki: Uint8Array) {
    this.rpId = rpId;
    this.credentialId = credentialId;
    this.origin = origin;
    this.privateKey = privateKey;
    this.spki = spki;
  }

  static generate(opts: { rpId: string; credentialId?: string; origin?: string }): SoftwarePasskey {
    if (!opts.rpId) throw invalidInput("rpId is required");
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const spki = new Uint8Array(publicKey.export({ format: "der", type: "spki" }));
    return new SoftwarePasskey(opts.rpId, opts.credentialId ?? randomBytes(16).toString("base64url"), opts.origin ?? `https://${opts.rpId}`, privateKey, spki);
  }

  /** `owner` to pass to `accounts.create`. */
  get owner(): Extract<OwnerCredential, { kind: "webauthn-p256" }> {
    return passkeyOwner({ publicKey: this.spki, credentialId: this.credentialId, rpId: this.rpId });
  }

  /** Signs the challenge TilcAI returned for an `account`-mode payment (`authorization.account.challengeBase64Url`). */
  assertion(challengeBase64Url: string): { authenticatorData: Uint8Array; clientDataJSON: Uint8Array; signature: Uint8Array } {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(++this.counter);
    // flags 0x05: user present + user verified, which the account contract requires.
    const authenticatorData = Buffer.concat([createHash("sha256").update(this.rpId).digest(), Buffer.from([0x05]), counter]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: challengeBase64Url, origin: this.origin, crossOrigin: false }));
    const signature = createSign("sha256")
      .update(Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]))
      .sign(this.privateKey);
    return { authenticatorData: new Uint8Array(authenticatorData), clientDataJSON: new Uint8Array(clientDataJSON), signature: new Uint8Array(signature) };
  }
}
