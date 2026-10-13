import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { EvmRelayer, RelayerError } from "../src/index.js";

const KEY = "relayer-key";
const ADDRESS = "0xcc0bbfaffb786c8bb1212c3555b8c6d0b195d6f5";
let server: Server;
let url = "";
const txs = new Map<string, { polls: number; outcome: "confirmed" | "failed" | "never"; body: any }>();
let next = 0;

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { success: false, error: "Unauthorized" });
      const m = /^\/api\/v1\/relayers\/([^/]+)(?:\/transactions(?:\/([^/]+))?)?$/.exec(req.url ?? "");
      if (!m || m[1] !== "monad-testnet-relayer") return send(404, { success: false, error: "relayer not found" });
      if (req.method === "GET" && !req.url!.includes("/transactions")) return send(200, { success: true, data: { id: m[1], address: ADDRESS, network: "monad-testnet" } });
      if (req.method === "POST") {
        const body = JSON.parse(raw);
        if (body.to === "0x0000000000000000000000000000000000000bad") return send(400, { success: false, error: "to is not allowed by policy" });
        const id = `tx-${++next}`;
        txs.set(id, { polls: 0, outcome: body.data === "0xdead" ? "failed" : body.data === "0xfeed" ? "never" : "confirmed", body });
        return send(201, { success: true, data: { id, status: "pending", hash: null } });
      }
      const t = txs.get(m[2] ?? "");
      if (!t) return send(404, { success: false, error: "transaction not found" });
      t.polls++;
      if (t.outcome === "never") return send(200, { success: true, data: { id: m[2], status: "submitted", hash: "0x" + "ab".repeat(32) } });
      if (t.polls < 2) return send(200, { success: true, data: { id: m[2], status: "sent", hash: "0x" + "ab".repeat(32) } });
      return send(200, { success: true, data: { id: m[2], status: t.outcome, hash: "0x" + "cd".repeat(32), status_reason: t.outcome === "failed" ? "execution reverted" : null } });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

const relayer = () => new EvmRelayer({ url, apiKey: KEY, relayerId: "monad-testnet-relayer" });

test("the relayer's address is its msg.sender", async () => {
  assert.equal(await relayer().address(), ADDRESS);
});

test("send + wait: the call carries its calldata and gas limit, and only a confirmed hash is returned", async () => {
  const r = relayer();
  const call = { to: "0x3422820Ef9FBC8e0206E4CBcB6369dBd14BE18c4", data: "0x1234abcd", gasLimit: 300_000 };
  const done = await r.sendAndWait(call, { intervalMs: 5 });
  assert.equal(done.status, "confirmed");
  assert.equal(done.hash, "0x" + "cd".repeat(32), "the hash is the one reported once confirmed, not the earlier `sent` one");
  const sent = [...txs.values()].at(-1)!.body;
  assert.deepEqual(sent, { to: call.to, data: call.data, value: 0, speed: "fast", gas_limit: 300_000 });
});

test("a reverted transaction throws a RelayerError that is not uncertain", async () => {
  await assert.rejects(
    relayer().sendAndWait({ to: "0x3422820Ef9FBC8e0206E4CBcB6369dBd14BE18c4", data: "0xdead" }, { intervalMs: 5 }),
    (e: RelayerError) => e instanceof RelayerError && e.code === "RELAYED_TX_FAILED" && !e.uncertain && /execution reverted/.test(e.message),
  );
});

test("running out of time is uncertain and carries the transaction id", async () => {
  await assert.rejects(
    relayer().sendAndWait({ to: "0x3422820Ef9FBC8e0206E4CBcB6369dBd14BE18c4", data: "0xfeed" }, { intervalMs: 5, timeoutMs: 60 }),
    (e: RelayerError) => e.code === "WAIT_TIMEOUT" && e.uncertain && Boolean(e.transactionId) && e.recovery === "RECONCILE",
  );
});

test("policy rejections, bad keys and bad input are typed and nothing is sent for the latter", async () => {
  await assert.rejects(relayer().send({ to: "0x0000000000000000000000000000000000000bad", data: "0x01" }), (e: RelayerError) => e.status === 400 && /policy/.test(e.message));
  await assert.rejects(new EvmRelayer({ url, apiKey: "nope", relayerId: "monad-testnet-relayer" }).address(), (e: RelayerError) => e.status === 401 && e.code === "UNAUTHENTICATED");
  const before = next;
  await assert.rejects(relayer().send({ to: "not-an-address", data: "0x01" }), /EVM address/);
  await assert.rejects(relayer().send({ to: "0x3422820Ef9FBC8e0206E4CBcB6369dBd14BE18c4", data: "zz" }), /hex/);
  assert.equal(next, before);
  assert.throws(() => new EvmRelayer({ url: "", apiKey: "k", relayerId: "x" }), /relayer url is required/);
});
