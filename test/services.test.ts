import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { after, before, test } from "node:test";
import { Keypair } from "@stellar/stellar-sdk";
import { PaymentError, Tilcai, TilcaiError, ed25519Owner, passkeyOwner } from "../src/index.js";
import { MockTilcai, OPERATOR_KEY, TENANT_KEY } from "./support/mock-tilcai.js";

const mock = new MockTilcai();
let operator: Tilcai;
let tenant: Tilcai;
const passkey = () =>
  passkeyOwner({ publicKey: generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "der", type: "spki" }), credentialId: Buffer.from("cred"), rpId: "optus.example" });

before(async () => {
  await mock.listen();
  operator = new Tilcai({ baseUrl: mock.url, apiKey: OPERATOR_KEY, retries: 0 });
  tenant = new Tilcai({ baseUrl: mock.url, apiKey: TENANT_KEY, retries: 0 });
});
after(() => mock.close());

for (const network of ["avalanche", "monad", "stellar"] as const) {
  test(`SCA on ${network}: issue with a passkey, address is final, ACTIVE after deployment, same ref → same account`, async () => {
    const owner = passkey();
    const created = await tenant.accounts.create({ network, externalRef: `user-${network}`, owner, idempotencyKey: `acc-${network}` });
    assert.equal(created.replayed, false);
    assert.equal(created.account.state, "DEPLOYING");
    assert.ok(created.account.address);
    const sent = mock.requests.filter((r) => r.path === "/v1/accounts" && r.method === "POST").at(-1)!;
    assert.equal(sent.body.network, { avalanche: "eip155:43113", monad: "eip155:10143", stellar: "stellar:testnet" }[network]);
    assert.deepEqual(sent.body.owner, owner);

    const again = await tenant.accounts.create({ network, externalRef: `user-${network}`, owner, idempotencyKey: `acc-${network}` });
    assert.equal(again.replayed, true);
    assert.equal(again.account.id, created.account.id);

    const active = await tenant.accounts.waitForActive(created.account.id, { intervalMs: 1 });
    assert.equal(active.account.state, "ACTIVE");
    assert.ok(active.links.deployTx);
    assert.deepEqual((await tenant.accounts.list({ externalRef: `user-${network}` })).map((a) => a.id), [created.account.id]);
  });
}

test("SCA: Stellar accounts also take an Ed25519 owner; EVM accounts do not (checked before the request)", async () => {
  const kp = Keypair.random();
  const ok = await tenant.accounts.create({ network: "stellar", externalRef: "ed-owner", owner: ed25519Owner(kp.publicKey()) });
  assert.equal(ok.account.owner.kind, "ed25519");
  const before = mock.requests.length;
  await assert.rejects(tenant.accounts.create({ network: "monad", externalRef: "bad", owner: ed25519Owner(kp.publicKey()) }), (e: TilcaiError) => e.code === "INVALID_INPUT" && /passkey/.test(e.message));
  assert.equal(mock.requests.length, before);
});

test("vault: status per network, disburse with idempotency, wait for CONFIRMED", async () => {
  for (const [alias, id] of [["avalanche", "eip155:43113"], ["monad", "eip155:10143"], ["stellar", "stellar:testnet"]] as const) {
    assert.equal((await operator.vault.status(alias)).network, id);
  }
  const to = "0x" + "cd".repeat(20);
  const d = await operator.vault.disburse({ network: "monad", to, amount: "1.5", reference: "purchase-9", idempotencyKey: "dis-1" });
  assert.equal(d.replayed, false);
  assert.equal(d.disbursement.state, "REQUESTED");
  assert.equal((await operator.vault.disburse({ network: "monad", to, amount: "1.5", reference: "purchase-9", idempotencyKey: "dis-1" })).replayed, true);
  const done = await operator.vault.waitForConfirmation(d.disbursement.id, { intervalMs: 1 });
  assert.equal(done.state, "CONFIRMED");
  assert.ok(done.txHash);
  // An address of the wrong family is caught locally.
  await assert.rejects(operator.vault.disburse({ network: "stellar", to, amount: "1" }), (e: TilcaiError) => e.code === "INVALID_INPUT");
  await assert.rejects(operator.vault.disburse({ network: "monad", to: Keypair.random().publicKey(), amount: "1" }), (e: TilcaiError) => e.code === "INVALID_INPUT");
  const stuck = mock.disbursements.get(d.disbursement.id)!;
  stuck.state = "FAILED";
  await assert.rejects(operator.vault.waitForConfirmation(d.disbursement.id, { intervalMs: 1 }), (e: PaymentError) => e instanceof PaymentError && !e.uncertain);
});

test("monitor: events page by position and prefix; the stream delivers new events and resumes", async () => {
  mock.emit("system.started", "arriba");
  mock.emit("vault.disbursement.transition", "payout", { subject: "disb_1" });
  mock.emit("crosschain.payment.transition", "pago");
  const page = await operator.monitor.events({ type: "vault." });
  assert.equal(page.schema, "tilcai-monitor-v1");
  assert.deepEqual(page.events.map((e) => e.type), ["vault.disbursement.transition"]);
  const after1 = await operator.monitor.events({ after: 1 });
  assert.deepEqual(after1.events.map((e) => e.seq), [2, 3]);

  const ac = new AbortController();
  const seen: string[] = [];
  const consumer = (async () => {
    for await (const e of operator.monitor.stream({ after: 0, signal: ac.signal })) {
      seen.push(e.summary);
      if (seen.length === 4) ac.abort();
    }
  })();
  setTimeout(() => mock.emit("qr.paid", "después"), 80);
  await consumer;
  assert.deepEqual(seen, ["arriba", "payout", "pago", "después"]);
  assert.equal((await operator.monitor.resources()).alerts.length, 0);
  assert.equal((await operator.relayer.status()).up, true);
});
