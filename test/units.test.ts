import assert from "node:assert/strict";
import { createHash, createVerify, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import {
  NETWORKS,
  SoftwarePasskey,
  atomicToDecimal,
  decimalToAtomic,
  ed25519Owner,
  explorerUrl,
  hexToStellarAccount,
  hexToStellarContract,
  isStellarAccount,
  isStellarContract,
  p256PublicKey,
  passkeyOwner,
  resolveEvmNetwork,
  resolveNetwork,
  stellarAccountToHex,
  typedDataArgs,
  webauthnPayload,
} from "../src/index.js";

test("network registry: CAIP-2 ids, aliases and environments", () => {
  assert.equal(resolveNetwork("avalanche").id, "eip155:43113");
  assert.equal(resolveNetwork("avalanche", "mainnet").id, "eip155:43114");
  assert.equal(resolveNetwork("monad").id, "eip155:10143");
  assert.equal(resolveNetwork("Stellar").id, "stellar:testnet");
  assert.equal(resolveNetwork("stellar", "mainnet").id, "stellar:pubnet");
  assert.equal(resolveNetwork("eip155:10143").id, "eip155:10143");
  assert.throws(() => resolveNetwork("monad", "mainnet"), /no mainnet deployment/);
  assert.throws(() => resolveNetwork("solana"), /unknown network/);
  assert.throws(() => resolveEvmNetwork("stellar"), /not an EVM network/);
});

test("registry values: Monad signs under the EIP-712 name USDC, Fuji under USD Coin; CCTP domains", () => {
  const fuji = NETWORKS["eip155:43113"];
  const monad = NETWORKS["eip155:10143"];
  assert.equal(fuji.family === "evm" && fuji.usdc.eip712Name, "USD Coin");
  assert.equal(monad.family === "evm" && monad.usdc.eip712Name, "USDC");
  assert.equal(monad.family === "evm" && monad.chainId, 10143);
  assert.deepEqual([fuji.cctpDomain, monad.cctpDomain, NETWORKS["stellar:testnet"].cctpDomain], [1, 15, 27]);
  assert.equal(explorerUrl("eip155:10143", "tx", "0xabc"), "https://testnet.monadscan.com/tx/0xabc");
  assert.equal(explorerUrl("stellar:testnet", "contract", "CABC"), "https://stellar.expert/explorer/testnet/contract/CABC");
});

test("amounts are exact: no floats, no silent rounding", () => {
  assert.equal(decimalToAtomic("1.25", 6), 1_250_000n);
  assert.equal(decimalToAtomic("0.0000001", 7), 1n);
  assert.equal(atomicToDecimal(1_250_000n, 6), "1.25");
  assert.equal(atomicToDecimal("10", 6), "0.00001");
  assert.equal(atomicToDecimal(5_000_000n, 6), "5");
  assert.throws(() => decimalToAtomic("0.1234567", 6), /more than 6 decimals/);
  assert.throws(() => decimalToAtomic("0", 6), /greater than zero/);
  assert.throws(() => decimalToAtomic("-1", 6));
  assert.throws(() => decimalToAtomic("1e3", 6));
  assert.throws(() => decimalToAtomic("", 6));
});

test("strkey: agrees with @stellar/stellar-sdk on accounts and contracts, and rejects corrupt ones", () => {
  for (let i = 0; i < 25; i++) {
    const kp = Keypair.random();
    const g = kp.publicKey();
    assert.equal(isStellarAccount(g), true);
    assert.equal(stellarAccountToHex(g), `0x${Buffer.from(kp.rawPublicKey()).toString("hex")}`);
    assert.equal(hexToStellarAccount(stellarAccountToHex(g)), g);
    const c = StrKey.encodeContract(Buffer.from(kp.rawPublicKey()));
    assert.equal(isStellarContract(c), true);
    assert.equal(isStellarAccount(c), false);
    assert.equal(hexToStellarContract(`0x${Buffer.from(kp.rawPublicKey()).toString("hex")}`), c);
    const bad = g.slice(0, -1) + (g.endsWith("A") ? "B" : "A");
    assert.equal(isStellarAccount(bad), false, "checksum must catch a changed last character");
  }
  assert.equal(isStellarAccount(NETWORKS["stellar:testnet"].family === "stellar" ? NETWORKS["stellar:testnet"].usdc.issuer : ""), true);
  assert.equal(isStellarContract(NETWORKS["stellar:pubnet"].family === "stellar" ? NETWORKS["stellar:pubnet"].usdc.sac : ""), true);
  assert.equal(isStellarAccount("not an address"), false);
  assert.throws(() => stellarAccountToHex("GABC"), /not a valid Stellar account/);
});

test("passkey owners: SPKI, raw point and COSE_Key all give the same uncompressed P-256 point", () => {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const point = `0x04${Buffer.from(jwk.x!, "base64url").toString("hex")}${Buffer.from(jwk.y!, "base64url").toString("hex")}`;
  const spki = publicKey.export({ format: "der", type: "spki" });
  assert.equal(p256PublicKey(spki), point);
  assert.equal(p256PublicKey(spki.toString("base64url")), point);
  assert.equal(p256PublicKey(point), point);
  const cose = Buffer.concat([
    Buffer.from("a5010203262001215820", "hex"),
    Buffer.from(jwk.x!, "base64url"),
    Buffer.from("225820", "hex"),
    Buffer.from(jwk.y!, "base64url"),
  ]);
  assert.equal(p256PublicKey(cose), point);
  assert.throws(() => p256PublicKey(Buffer.alloc(10)), /not a P-256 public key/);

  const owner = passkeyOwner({ publicKey: spki, credentialId: Buffer.from("cred-1"), rpId: "optus.example" });
  assert.deepEqual(owner, { kind: "webauthn-p256", publicKey: point, credentialId: Buffer.from("cred-1").toString("base64url"), rpId: "optus.example" });
  assert.throws(() => passkeyOwner({ publicKey: spki, credentialId: "x", rpId: "" }), /rpId/);
});

test("ed25519 owners take a G… address or raw bytes", () => {
  const kp = Keypair.random();
  const hex = `0x${Buffer.from(kp.rawPublicKey()).toString("hex")}`;
  assert.deepEqual(ed25519Owner(kp.publicKey()), { kind: "ed25519", publicKey: hex });
  assert.deepEqual(ed25519Owner(kp.rawPublicKey()), { kind: "ed25519", publicKey: hex });
  assert.throws(() => ed25519Owner(new Uint8Array(5)), /32 bytes/);
});

test("webauthnPayload gives base64url for ArrayBuffers, views and nested `response`", () => {
  const bytes = new Uint8Array([251, 255, 0, 1]);
  const expected = Buffer.from(bytes).toString("base64url");
  const p = webauthnPayload({ authenticatorData: bytes.buffer.slice(0), clientDataJSON: bytes, signature: bytes });
  assert.deepEqual(p, { authenticatorData: expected, clientDataJSON: expected, signature: expected });
  assert.doesNotMatch(expected, /[+/=]/);
  const nested = webauthnPayload({ response: { authenticatorData: bytes, clientDataJSON: bytes, signature: bytes } });
  assert.deepEqual(nested, p);
});

test("typedDataArgs drops EIP712Domain and turns integer fields into bigint", () => {
  const out = typedDataArgs({
    domain: { name: "USDC", version: "2", chainId: 10143, verifyingContract: "0x1" },
    types: {
      EIP712Domain: [{ name: "name", type: "string" }],
      ReceiveWithAuthorization: [
        { name: "from", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "ReceiveWithAuthorization",
    message: { from: "0xabc", value: "1250000", nonce: "0x01" },
  });
  assert.deepEqual(Object.keys(out.types), ["ReceiveWithAuthorization"]);
  assert.equal(out.message.value, 1_250_000n);
  assert.equal(out.message.nonce, "0x01");
  assert.equal(out.domain.chainId, 10143n);
});

test("SoftwarePasskey: assertions have the WebAuthn shape and verify under the public key it registered", () => {
  const pk = SoftwarePasskey.generate({ rpId: "agent.example", origin: "https://agent.example" });
  const owner = pk.owner;
  assert.equal(owner.kind, "webauthn-p256");
  assert.match(owner.publicKey, /^0x04[0-9a-f]{128}$/);
  assert.equal(owner.rpId, "agent.example");

  const challenge = Buffer.from("11".repeat(32), "hex").toString("base64url");
  const a = pk.assertion(challenge);
  assert.equal(Buffer.from(a.authenticatorData.subarray(0, 32)).toString("hex"), createHash("sha256").update("agent.example").digest("hex"));
  assert.equal(a.authenticatorData[32], 0x05, "user present + verified");
  assert.equal(JSON.parse(Buffer.from(a.clientDataJSON).toString()).challenge, challenge);
  assert.equal(JSON.parse(Buffer.from(a.clientDataJSON).toString()).type, "webauthn.get");
  assert.equal(pk.assertion(challenge).authenticatorData.at(-1), 2, "the counter moves on every assertion");

  // Verify with the public key exactly as a relying party (or the account's P-256 verifier) would.
  const spki = Buffer.concat([Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex"), Buffer.from(owner.publicKey.slice(2), "hex")]);
  const ok = createVerify("sha256")
    .update(Buffer.concat([a.authenticatorData, createHash("sha256").update(a.clientDataJSON).digest()]))
    .verify({ key: spki, format: "der", type: "spki" }, a.signature);
  assert.equal(ok, true);
});
