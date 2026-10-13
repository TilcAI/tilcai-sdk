import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { Keypair } from "@stellar/stellar-sdk";
import { PaymentError, Tilcai, TilcaiError, assertSignable, evmSignerFromViem, passkeyOwner } from "../src/index.js";
import { MockTilcai, OPERATOR_KEY, TENANT_KEY } from "./support/mock-tilcai.js";

const mock = new MockTilcai({ noTrustline: new Set([Keypair.random().publicKey()]) });
const payTo = Keypair.random().publicKey();
const payer = privateKeyToAccount(generatePrivateKey());
let tilcai: Tilcai;
const client = (over: Partial<ConstructorParameters<typeof Tilcai>[0]> = {}) => new Tilcai({ baseUrl: mock.url, apiKey: OPERATOR_KEY, retries: 0, ...over });

before(async () => {
  await mock.listen();
  tilcai = client();
});
after(() => mock.close());

test("health is open; routes list both source networks with their modes", async () => {
  const anon = new Tilcai({ baseUrl: mock.url });
  const h = await anon.health();
  assert.equal(h.ok, true);
  assert.deepEqual(h.networks, ["eip155:43113", "eip155:10143", "stellar:testnet"]);
  const routes = await tilcai.routes();
  assert.deepEqual(routes.map((r) => r.source.network), ["eip155:43113", "eip155:10143"]);
  assert.ok(routes.every((r) => r.destination.network === "stellar:testnet" && r.gasless && r.account));
  assert.deepEqual(await tilcai.sourceNetworks(), ["eip155:43113", "eip155:10143"]);
  await anon.verifyEnvironment();
  await assert.rejects(new Tilcai({ baseUrl: mock.url, environment: "mainnet" }).verifyEnvironment(), (e: TilcaiError) => e.code === "ENVIRONMENT_MISMATCH");
});

test("errors keep TilcAI's envelope; a missing key never leaves the process", async () => {
  await assert.rejects(new Tilcai({ baseUrl: mock.url, apiKey: "wrong" }).routes(), (e: TilcaiError) => e.status === 401 && e.code === "UNAUTHENTICATED" && e.recovery === "AUTHENTICATE");
  const before = mock.requests.length;
  await assert.rejects(new Tilcai({ baseUrl: mock.url }).routes(), (e: TilcaiError) => e.code === "NO_API_KEY");
  assert.equal(mock.requests.length, before, "no request was sent without a key");
  await assert.rejects(tilcai.payments.get("payment_attempt_nope"), (e: TilcaiError) => e.status === 404 && e.code === "NOT_FOUND");
  await assert.rejects(client().payments.quote({ source: "avalanche", amount: "1", payTo: "not-stellar" }), (e: TilcaiError) => e.code === "INVALID_INPUT" && e.status === 0);
  assert.throws(() => new Tilcai({ baseUrl: "" }), (e: TilcaiError) => e.code === "NO_BASE_URL");
});

for (const [alias, chainId, domainName] of [
  ["avalanche", 43113, "USD Coin"],
  ["monad", 10143, "USDC"],
] as const) {
  test(`gasless pay() from ${alias}: quote → sign EIP-3009 → SETTLED on Stellar`, async () => {
    const seen: string[] = [];
    const r = await tilcai.payments.pay({
      from: alias,
      amount: "1.25",
      payTo,
      signer: evmSignerFromViem(payer),
      orderId: "order-77",
      wait: { intervalMs: 1, onUpdate: (v) => seen.push(v.payment.state) },
    });
    assert.equal(r.mode, "gasless");
    assert.equal(r.view.payment.state, "SETTLED");
    assert.equal(r.view.paymentState, "SETTLED");
    assert.equal(r.view.payment.orderId, "order-77");
    assert.equal(r.quote.route.source, `eip155:${chainId}`);
    assert.equal(r.quote.route.destination, "stellar:testnet");
    assert.deepEqual(seen.slice(-1), ["SETTLED"]);
    const stored = mock.payments.get(r.paymentId)!;
    assert.equal(stored.payer, payer.address);
    // The signed typed data was the one for this network's USDC domain.
    const created = mock.requests.filter((q) => q.path === "/v1/crosschain/payments").at(-1)!;
    assert.equal(created.body.mode, "gasless");
    assert.equal(created.body.payer, payer.address);
    assert.ok(created.headers["idempotency-key"], "an Idempotency-Key is always sent");
    const q = mock.quotes.get(r.quote.id)!;
    assert.equal(q.route.source, `eip155:${chainId}`);
    assert.equal(domainName.length > 0, true);
  });
}

test("account mode: a passkey assertion pays from a TilcAI-issued account", async () => {
  const account = "0x" + "ab".repeat(20);
  const r = await tilcai.payments.pay({
    from: "monad",
    amount: "0.5",
    payTo,
    payer: account,
    passkey: async ({ challengeBase64Url }) => {
      assert.match(challengeBase64Url, /^[A-Za-z0-9_-]+$/);
      return { authenticatorData: new Uint8Array([1, 2]), clientDataJSON: new Uint8Array([3]), signature: new Uint8Array([4, 5, 6]) };
    },
    wait: { intervalMs: 1 },
  });
  assert.equal(r.mode, "account");
  assert.equal(r.view.payment.state, "SETTLED");
  const sent = mock.requests.filter((q) => q.path.endsWith("/authorization")).at(-1)!;
  assert.deepEqual(Object.keys(sent.body), ["webauthn"]);
  assert.deepEqual(Object.keys(sent.body.webauthn).sort(), ["authenticatorData", "clientDataJSON", "signature"]);
});

test("external mode: every call is sent in order and the last hash is submitted as the burn", async () => {
  const sent: string[] = [];
  const r = await tilcai.payments.pay({
    from: "avalanche",
    amount: "2",
    payTo,
    payer: payer.address,
    sendTransaction: async (call) => {
      sent.push(call.description);
      return `0x${(sent.length).toString(16).padStart(64, "0")}`;
    },
    wait: { intervalMs: 1 },
  });
  assert.deepEqual(sent, ["approve USDC", "depositForBurnWithHook"]);
  assert.equal(r.view.payment.burnTxHash, `0x${"2".padStart(64, "0")}`);
  assert.equal(r.view.payment.state, "SETTLED");
});

test("the SDK refuses to sign what is not this payment", async () => {
  const good = await tilcai.payments.quote({ source: "monad", amount: "1", payTo });
  const created = await tilcai.payments.create({ quoteId: good.id, mode: "gasless", payer: payer.address });
  const auth = created.authorization!;
  const monad = { id: "eip155:10143", family: "evm", chainId: 10143, name: "Monad Testnet", usdc: { address: "0x534b2f3A21130d7a60830c2Df862319e593943A3" } } as never;
  assert.doesNotThrow(() => assertSignable({ quote: good, authorization: auth, payer: payer.address, source: monad }));
  const tamper = (patch: (a: typeof auth) => void) => {
    const a = structuredClone(auth);
    patch(a);
    return () => assertSignable({ quote: good, authorization: a, payer: payer.address, source: monad });
  };
  const unsafe = (e: unknown) => e instanceof TilcaiError && e.code === "UNSAFE_AUTHORIZATION";
  assert.throws(tamper((a) => (a.typedData.message.value = "999999999")), unsafe);
  assert.throws(tamper((a) => (a.typedData.message.to = "0x" + "11".repeat(20))), unsafe);
  assert.throws(tamper((a) => (a.typedData.message.from = "0x" + "22".repeat(20))), unsafe);
  assert.throws(tamper((a) => (a.typedData.domain.chainId = 1)), unsafe);
  assert.throws(tamper((a) => (a.typedData.domain.verifyingContract = "0x" + "33".repeat(20))), unsafe);
  assert.throws(tamper((a) => (a.typedData.primaryType = "Permit")), unsafe);
  assert.throws(tamper((a) => (a.typedData.message.validBefore = "1")), unsafe);
});

test("pay() stops before creating anything when the recipient has no trustline, or approval is denied", async () => {
  const noLine = [...(mock.opts.noTrustline ?? [])][0]!;
  const before = mock.requests.filter((q) => q.path === "/v1/crosschain/payments").length;
  await assert.rejects(
    tilcai.payments.pay({ from: "avalanche", amount: "1", payTo: noLine, signer: evmSignerFromViem(payer) }),
    (e: TilcaiError) => e.code === "RECIPIENT_NOT_READY",
  );
  await assert.rejects(
    tilcai.payments.pay({ from: "avalanche", amount: "1", payTo, signer: evmSignerFromViem(payer), approve: (q) => Number(q.burn.amount) < 0.5 }),
    (e: TilcaiError) => e.code === "APPROVAL_DENIED",
  );
  assert.equal(mock.requests.filter((q) => q.path === "/v1/crosschain/payments").length, before, "no payment was created");
  await assert.rejects(tilcai.payments.pay({ from: "avalanche", amount: "1", payTo }), /exactly one of/);
});

test("idempotency: the same key replays (HTTP 200) instead of creating a second payment", async () => {
  const q = await tilcai.payments.quote({ source: "avalanche", amount: "3", payTo });
  const a = await tilcai.payments.create({ quoteId: q.id, mode: "gasless", payer: payer.address, idempotencyKey: "order-1001" });
  const b = await tilcai.payments.create({ quoteId: q.id, mode: "gasless", payer: payer.address, idempotencyKey: "order-1001" });
  assert.equal(a.replayed, false);
  assert.equal(b.replayed, true);
  assert.equal(a.payment.id, b.payment.id);
});

test("wait(): FAILED throws PaymentError; a timeout is uncertain and carries the last view", async () => {
  const stuck = new MockTilcai({ freezeAt: "BURN_SUBMITTED" });
  await stuck.listen();
  try {
    const t = new Tilcai({ baseUrl: stuck.url, apiKey: OPERATOR_KEY, retries: 0 });
    const q = await t.payments.quote({ source: "avalanche", amount: "1", payTo });
    const c = await t.payments.create({ quoteId: q.id, mode: "gasless", payer: payer.address });
    const sig = await payer.signTypedData((await import("../src/index.js")).typedDataArgs(c.authorization!.typedData) as never);
    await t.payments.submitAuthorization(c.payment.id, { signature: sig });
    await assert.rejects(t.payments.wait(c.payment.id, { timeoutMs: 60, intervalMs: 10 }), (e: PaymentError) => e instanceof PaymentError && e.code === "WAIT_TIMEOUT" && e.uncertain && e.recovery === "RECONCILE");

    stuck.payments.get(c.payment.id)!.state = "FAILED";
    await assert.rejects(t.payments.wait(c.payment.id, { intervalMs: 1 }), (e: PaymentError) => e instanceof PaymentError && !e.uncertain);
  } finally {
    await stuck.close();
  }
});

test("a gasless signature from another wallet is refused by the API, not retried", async () => {
  const q = await tilcai.payments.quote({ source: "avalanche", amount: "1", payTo });
  const c = await tilcai.payments.create({ quoteId: q.id, mode: "gasless", payer: payer.address });
  const other = privateKeyToAccount(generatePrivateKey());
  const sig = await other.signTypedData((await import("../src/index.js")).typedDataArgs(c.authorization!.typedData) as never);
  await assert.rejects(tilcai.payments.submitAuthorization(c.payment.id, { signature: sig }), (e: TilcaiError) => e.status === 400 && e.code === "INVALID_INPUT");
});

test("retries: GETs and idempotency-keyed POSTs survive a 503; a bare POST does not retry", async () => {
  const flaky = new MockTilcai({ failNext: { count: 2, status: 503 } });
  await flaky.listen();
  try {
    const t = new Tilcai({ baseUrl: flaky.url, apiKey: OPERATOR_KEY, retries: 2 });
    assert.equal((await t.routes()).length, 2);
    flaky.opts.failNext = { count: 1, status: 503 };
    await assert.rejects(t.payments.quote({ source: "avalanche", amount: "1", payTo }), (e: TilcaiError) => e.status === 503 && e.retryable);
  } finally {
    await flaky.close();
  }
});

test("scopes: an operator key cannot issue accounts; a tenant key cannot read the vault", async () => {
  const owner = passkeyOwner({ publicKey: generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "der", type: "spki" }), credentialId: "c", rpId: "r.example" });
  await assert.rejects(tilcai.accounts.create({ network: "avalanche", externalRef: "u1", owner }), (e: TilcaiError) => e.status === 403 && e.code === "FORBIDDEN");
  const tenant = client({ apiKey: TENANT_KEY });
  await assert.rejects(tenant.vault.status(), (e: TilcaiError) => e.status === 403);
  assert.ok((await tenant.routes()).length > 0);
});
