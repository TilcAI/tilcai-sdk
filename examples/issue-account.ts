/**
 * Issues a smart account (SCA) for one of your users from the public key of their passkey.
 * The passkey never leaves the user's device; TilcAI derives the address, pays the deployment
 * and is never a signer. Needs a tenant key with the scopes accounts:read and accounts:write.
 *
 * In a browser, `publicKey` and `credentialId` come from the WebAuthn registration:
 *   const cred = await navigator.credentials.create({ publicKey: { ...options, pubKeyCredParams: [{ type: "public-key", alg: -7 }] } });
 *   const publicKey = cred.response.getPublicKey();   // SPKI DER, what passkeyOwner takes
 */
import { Tilcai, passkeyOwner } from "tilcai-sdk";

const tilcai = Tilcai.fromEnv();

const owner = passkeyOwner({
  publicKey: process.env.PASSKEY_PUBLIC_KEY_SPKI_B64URL!,
  credentialId: process.env.PASSKEY_CREDENTIAL_ID!,
  rpId: "app.example.com",
});

for (const network of ["avalanche", "monad", "stellar"] as const) {
  const created = await tilcai.accounts.create({ network, externalRef: "user-1842", owner });
  console.log(`${network}: ${created.account.address} (${created.account.state})${created.replayed ? " — already issued" : ""}`);
  // The address is final and can receive funds now. It can sign once the deployment lands:
  const active = await tilcai.accounts.waitForActive(created.account.id);
  console.log(`  ACTIVE · ${active.links.deployTx}`);
}
