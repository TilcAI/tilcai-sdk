import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { Keypair } from "@stellar/stellar-sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { X402Error, evmSignerFromViem } from "../src/index.js";
import {
  HEADER_REQUIRED,
  HEADER_SIGNATURE,
  Paywall,
  X402Facilitator,
  buildRequirements,
  createEvmPayload,
  createPaymentPayload,
  createStellarPayload,
  decodeHeader,
  encodeHeader,
  x402Fetch,
  type PaymentRequired,
} from "../src/x402/index.js";
import { MockFacilitator, RELAYER_KEY } from "./support/mock-facilitator.js";
import { MockSorobanRpc } from "./support/mock-soroban-rpc.js";

const facilitatorMock = new MockFacilitator();
const rpc = new MockSorobanRpc();
let facilitator: X402Facilitator;
const evmPayer = privateKeyToAccount(generatePrivateKey());
const evmMerchant = privateKeyToAccount(generatePrivateKey()).address;
const stellarPayer = Keypair.random();
const stellarMerchant = Keypair.random().publicKey();

before(async () => {
  await facilitatorMock.listen();
  await rpc.listen();
  facilitator = new X402Facilitator({ url: facilitatorMock.url, apiKey: RELAYER_KEY });
});
after(async () => {
  await facilitatorMock.close();
  await rpc.close();
});

test("facilitator: /supported lists every network the SDK knows; a bad key is a typed 401", async () => {
  const s = await facilitator.supported();
  const nets = s.kinds.map((k) => k.network);
  for (const n of ["eip155:43113", "eip155:10143", "stellar:testnet"]) assert.ok(nets.includes(n), n);
  assert.ok(s.kinds.every((k) => k.x402Version === 2 && k.scheme === "exact"));
  await assert.rejects(new X402Facilitator({ url: facilitatorMock.url, apiKey: "nope" }).supported(), (e: X402Error) => e instanceof X402Error && e.status === 401 && e.code === "UNAUTHENTICATED");
  await assert.rejects(new X402Facilitator({ url: "http://127.0.0.1:1", apiKey: "k", timeoutMs: 500 }).supported(), (e: X402Error) => e.code === "UNREACHABLE");
});

test("requirements: per-network EIP-712 domain, atomic amounts by decimals, Stellar fee sponsorship", () => {
  const fuji = buildRequirements({ network: "avalanche", amount: "0.01", payTo: evmMerchant });
  assert.deepEqual(fuji, { scheme: "exact", network: "eip155:43113", amount: "10000", asset: "0x5425890298aed601595a70AB815c96711a31Bc65", payTo: evmMerchant, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } });
  const monad = buildRequirements({ network: "monad", amount: "0.01", payTo: evmMerchant });
  assert.equal(monad.network, "eip155:10143");
  assert.deepEqual(monad.extra, { name: "USDC", version: "2" });
  const stellar = buildRequirements({ network: "stellar", amount: "0.01", payTo: stellarMerchant });
  assert.equal(stellar.amount, "100000", "Stellar USDC has 7 decimals");
  assert.equal(stellar.asset, "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA");
  assert.deepEqual(stellar.extra, { areFeesSponsored: true });
  assert.throws(() => buildRequirements({ network: "monad", amount: "1", payTo: evmMerchant, asset: "0x" + "12".repeat(20) }), /tokenName and tokenVersion/);
  assert.throws(() => buildRequirements({ network: "monad", payTo: evmMerchant }), /amount/);
});

for (const network of ["avalanche", "monad"] as const) {
  test(`x402 on ${network}: the signed EIP-3009 payload verifies and settles; a replay does not pay twice`, async () => {
    const requirements = buildRequirements({ network, amount: "0.05", payTo: evmMerchant });
    const payload = await createEvmPayload({ requirements, signer: evmSignerFromViem(evmPayer) });
    assert.equal(payload.x402Version, 2);
    const v = await facilitator.verify(payload, requirements);
    assert.deepEqual(v, { isValid: true, payer: evmPayer.address });
    const s = await facilitator.settle(payload, requirements);
    assert.equal(s.success, true);
    assert.equal(s.network, requirements.network);
    assert.match(s.transaction, /^[0-9a-f]{64}$/);
    const again = await facilitator.settle(payload, requirements);
    assert.equal(again.success, false, "the same authorization is never settled twice");
  });
}

test("x402 EVM: the domain matters — Fuji's token name on Monad's requirement fails signature recovery", async () => {
  const monad = buildRequirements({ network: "monad", amount: "0.05", payTo: evmMerchant });
  const wrongName = { ...monad, extra: { name: "USD Coin", version: "2" } };
  const payload = await createEvmPayload({ requirements: wrongName, signer: evmSignerFromViem(evmPayer) });
  // The facilitator checks against the requirements the seller holds (Monad's real domain).
  const v = await facilitator.verify({ ...payload, accepted: monad }, monad);
  assert.equal(v.isValid, false);
  assert.equal(v.invalidReason, "invalid_exact_evm_payload_signature");
});

test("x402 EVM: a payload signed for one price is not valid for another recipient or amount", async () => {
  const cheap = buildRequirements({ network: "monad", amount: "0.01", payTo: evmMerchant });
  const payload = await createEvmPayload({ requirements: cheap, signer: evmSignerFromViem(evmPayer) });
  const dear = { ...cheap, amount: "5000000" };
  const v = await facilitator.verify({ ...payload, accepted: dear }, dear);
  assert.equal(v.isValid, false);
  assert.equal(v.invalidReason, "invalid_exact_evm_payload_authorization_value");
  const elsewhere = { ...cheap, payTo: privateKeyToAccount(generatePrivateKey()).address };
  assert.equal((await facilitator.verify({ ...payload, accepted: elsewhere }, elsewhere)).invalidReason, "invalid_exact_evm_payload_recipient_mismatch");
});

test("x402 on Stellar: the unsigned-envelope transfer with a signed auth entry verifies and settles once", async () => {
  const requirements = buildRequirements({ network: "stellar", amount: "0.01", payTo: stellarMerchant });
  const payload = await createStellarPayload({ requirements, signer: stellarPayer.secret(), rpcUrl: rpc.url });
  assert.ok("transaction" in payload.payload);
  const v = await facilitator.verify(payload, requirements);
  assert.deepEqual(v, { isValid: true, payer: stellarPayer.publicKey() });
  const s = await facilitator.settle(payload, requirements);
  assert.equal(s.success, true);
  assert.equal(s.network, "stellar:testnet");
  const replay = await facilitator.settle(payload, requirements);
  assert.equal(replay.success, false);
  assert.equal(replay.transaction, "", "a rejected replay carries no hash");
});

test("x402 on Stellar: a changed amount or recipient is rejected before anything moves", async () => {
  const requirements = buildRequirements({ network: "stellar", amount: "0.01", payTo: stellarMerchant });
  const payload = await createStellarPayload({ requirements, signer: stellarPayer, rpcUrl: rpc.url });
  const amount = { ...requirements, amount: "999999" };
  assert.equal((await facilitator.verify({ ...payload, accepted: amount }, amount)).invalidReason, "invalid_exact_stellar_payload_wrong_amount");
  const to = { ...requirements, payTo: Keypair.random().publicKey() };
  assert.equal((await facilitator.verify({ ...payload, accepted: to }, to)).invalidReason, "invalid_exact_stellar_payload_wrong_recipient");
  await assert.rejects(createStellarPayload({ requirements: { ...requirements, payTo: "nope" }, signer: stellarPayer, rpcUrl: rpc.url }), /payTo must be a Stellar/);
  await assert.rejects(createStellarPayload({ requirements: buildRequirements({ network: "stellar", environment: "mainnet", amount: "1", payTo: stellarMerchant }), signer: stellarPayer }), /needs rpcUrl/);
});

test("x402 Stellar auth entries use legacy credentials (the format the facilitator was exercised with)", async () => {
  const requirements = buildRequirements({ network: "stellar", amount: "0.01", payTo: stellarMerchant });
  const payload = await createStellarPayload({ requirements, signer: stellarPayer, rpcUrl: rpc.url });
  const { TransactionBuilder } = await import("@stellar/stellar-sdk");
  const tx = TransactionBuilder.fromXDR((payload.payload as { transaction: string }).transaction, "Test SDF Network ; September 2015") as any;
  const creds = tx.operations[0].auth[0].credentials;
  const kind = typeof creds.switch === "function" ? creds.switch().name : creds.type;
  assert.equal(kind, "sorobanCredentialsAddress");
});

// ── seller + buyer, end to end ─────────────────────────────────────────────────────────────────────

async function serve(handler: (req: Request) => Promise<Response>) {
  const server = createServer((req, res) => {
    void (async () => {
      const url = `http://${req.headers.host}${req.url}`;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const out = await handler(new Request(url, { method: req.method, headers }));
      res.writeHead(out.status, Object.fromEntries(out.headers));
      res.end(Buffer.from(await out.arrayBuffer()));
    })();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))) };
}

test("paywall + x402Fetch: a 402 with three networks is paid on the one the buyer prefers, once", async () => {
  const paywall = new Paywall({
    facilitator,
    resource: { description: "weather report", mimeType: "application/json" },
    accepts: [
      { network: "avalanche", amount: "0.02", payTo: evmMerchant },
      { network: "monad", amount: "0.02", payTo: evmMerchant },
      { network: "stellar", amount: "0.02", payTo: stellarMerchant },
    ],
  });
  let served = 0;
  const srv = await serve(paywall.fetchHandler((_req, paid) => (served++, new Response(JSON.stringify({ temp: 21, payer: paid.payer }), { headers: { "content-type": "application/json" } }))));
  try {
    const settleBefore = facilitatorMock.settles.length;
    const first = await fetch(`${srv.url}/weather`);
    assert.equal(first.status, 402);
    const required = decodeHeader<PaymentRequired>(first.headers.get(HEADER_REQUIRED)!);
    assert.deepEqual(required.accepts.map((a) => a.network), ["eip155:43113", "eip155:10143", "stellar:testnet"]);
    assert.equal(required.resource?.url, `${srv.url}/weather`);

    const pay = x402Fetch({ wallet: { evm: evmSignerFromViem(evmPayer), stellar: stellarPayer.secret(), stellarRpcUrl: rpc.url }, prefer: ["eip155:10143"] });
    const res = await pay(`${srv.url}/weather`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { temp: 21, payer: evmPayer.address });
    assert.equal(res.settlement?.success, true);
    assert.equal(res.settlement?.network, "eip155:10143");
    assert.equal(served, 1);
    assert.equal(facilitatorMock.settles.length - settleBefore, 1, "exactly one settlement");

    // A Stellar-only buyer is routed to the Stellar requirement.
    const stellarOnly = x402Fetch({ wallet: { stellar: stellarPayer, stellarRpcUrl: rpc.url } });
    const r2 = await stellarOnly(`${srv.url}/weather`);
    assert.equal(r2.status, 200);
    assert.equal(r2.settlement?.network, "stellar:testnet");
    assert.equal(served, 2);
  } finally {
    await srv.close();
  }
});

test("paywall: the seller's price wins over whatever the payload claims it accepted", async () => {
  const paywall = new Paywall({ facilitator, accepts: [{ network: "monad", amount: "1", payTo: evmMerchant }] });
  const cheap = buildRequirements({ network: "monad", amount: "0.000001", payTo: evmMerchant });
  const payload = await createEvmPayload({ requirements: cheap, signer: evmSignerFromViem(evmPayer) });
  const out = await paywall.process({ url: "http://x/y", headers: { [HEADER_SIGNATURE.toLowerCase()]: encodeHeader(payload) } });
  assert.equal(out.paid, false);
  if (!out.paid) assert.equal(out.response.body.error, "payment_does_not_match_requirements");
  const junk = await paywall.process({ url: "http://x/y", headers: { [HEADER_SIGNATURE.toLowerCase()]: "%%%" } });
  assert.equal(junk.paid, false);
});

test("paywall.express(): settles before the handler, attaches the settlement, answers 402 otherwise", async () => {
  const paywall = new Paywall({ facilitator, accepts: [{ network: "avalanche", amount: "0.03", payTo: evmMerchant }] });
  const mw = paywall.express();
  const res402 = fakeRes();
  let nexted = false;
  await mw({ headers: {}, url: "/paid", protocol: "http", get: () => "shop.test" }, res402, () => (nexted = true));
  assert.equal(res402.statusCode, 402);
  assert.equal(nexted, false);
  assert.ok(res402.headers[HEADER_REQUIRED]);

  const payload = await createEvmPayload({ requirements: paywall.requirements[0]!, signer: evmSignerFromViem(evmPayer) });
  const ok = fakeRes();
  const req: any = { headers: { "payment-signature": encodeHeader(payload) }, url: "/paid", protocol: "http", get: () => "shop.test" };
  await mw(req, ok, () => (nexted = true));
  assert.equal(nexted, true);
  assert.ok(ok.headers["PAYMENT-RESPONSE"]);
  assert.equal(req.x402.payer, evmPayer.address);
  assert.equal(req.x402.settlement.success, true);
});

test("x402Fetch guards: price limit, approval, and no payable requirement all stop before signing", async () => {
  const paywall = new Paywall({ facilitator, accepts: [{ network: "monad", amount: "5", payTo: evmMerchant }] });
  const srv = await serve(paywall.fetchHandler(() => new Response("ok")));
  try {
    const before = facilitatorMock.verifies.length;
    const wallet = { evm: evmSignerFromViem(evmPayer) };
    await assert.rejects(x402Fetch({ wallet, maxAmountAtomic: 1_000_000n })(`${srv.url}/a`), (e: X402Error) => e.code === "PAYMENT_LIMIT");
    await assert.rejects(x402Fetch({ wallet, approve: () => false })(`${srv.url}/a`), (e: Error & { code?: string }) => e.code === "APPROVAL_DENIED");
    await assert.rejects(x402Fetch({ wallet: { stellar: stellarPayer, stellarRpcUrl: rpc.url } })(`${srv.url}/a`), (e: X402Error) => e.code === "NO_PAYABLE_REQUIREMENT");
    assert.equal(facilitatorMock.verifies.length, before, "nothing was signed or sent to the facilitator");
    await assert.rejects(createPaymentPayload(paywall.requirements[0]!, {}), /needs an EVM signer/);
  } finally {
    await srv.close();
  }
});

function fakeRes() {
  const r = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    status(code: number) {
      r.statusCode = code;
      return r;
    },
    setHeader(k: string, v: string) {
      r.headers[k] = v;
    },
    json(b: unknown) {
      r.body = b;
    },
  };
  return r;
}
