#!/usr/bin/env -S npx tsx
/**
 * End-to-end test of the SDK with real testnet funds: sends and receives USDC between your own
 * accounts on Avalanche Fuji, Monad Testnet and Stellar Testnet, settles x402 payments and
 * issues smart accounts. It moves money (0.01 USDC per step by default), so it is opt-in.
 *
 * Reads, from the file in E2E_ENV_FILE (default ./.env) or the process environment:
 *   TEST_EVM_SECRET_KEY      0x… EVM key (same address on Avalanche and Monad; needs USDC, no gas)
 *                            (TEST_WALLET_SECRET_KEY is accepted too); TEST_EVM_ADDRESS is checked against it
 *   TEST_STELLAR_ADDRESS     G… account that receives USDC (needs a USDC trustline)
 *   TEST_STELLAR_SECRET_KEY  optional S…: lets the Stellar account pay too (x402 in USDC, round trip)
 * and the instance: TILCAI_API_URL, TILCAI_API_KEY (+ TILCAI_TENANT_KEY for SCA issuance),
 * TILCAI_RELAYER_URL and TILCAI_RELAYER_API_KEY for x402.
 *
 * Secrets are never printed or written. Results go to results/wallet-e2e-<time>.json (gitignored).
 * Flags: --only=vault,crosschain,x402,accounts · --amount=0.01
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { createPublicClient, formatUnits, http, parseAbi, parseEventLogs } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Tilcai, TilcaiError, decimalToAtomic, evmSignerFromViem, isStellarAccount, passkeyOwner, type PaymentView } from "../src/index.js";
import { Paywall, X402Facilitator, x402Fetch } from "../src/x402/index.js";

// ── setup ──────────────────────────────────────────────────────────────────────────────────────
const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.slice(2).split("=") as [string, string | undefined]));
const only = new Set((args.only ?? "vault,crosschain,x402,accounts").split(","));
const AMOUNT = args.amount ?? "0.01";

function loadEnv(): Record<string, string> {
  const file = resolve(process.env.E2E_ENV_FILE ?? ".env");
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
    }
  } catch {}
  return { ...out, ...(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>) };
}
const env = loadEnv();
const need = (k: string) => {
  const v = env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
};

const wallet = privateKeyToAccount((env.TEST_EVM_SECRET_KEY ?? need("TEST_WALLET_SECRET_KEY")) as `0x${string}`);
if (env.TEST_EVM_ADDRESS && env.TEST_EVM_ADDRESS.toLowerCase() !== wallet.address.toLowerCase()) throw new Error("TEST_EVM_ADDRESS does not belong to the EVM secret key");
const stellarAddress = need("TEST_STELLAR_ADDRESS");
if (!isStellarAccount(stellarAddress)) throw new Error("TEST_STELLAR_ADDRESS is not a valid Stellar account");
const stellarSecret = env.TEST_STELLAR_SECRET_KEY;
if (stellarSecret && Keypair.fromSecret(stellarSecret).publicKey() !== stellarAddress) throw new Error("TEST_STELLAR_SECRET_KEY does not belong to TEST_STELLAR_ADDRESS");

const tilcai = new Tilcai({ baseUrl: need("TILCAI_API_URL"), apiKey: need("TILCAI_API_KEY"), environment: "testnet", timeoutMs: 60_000 });
const signer = evmSignerFromViem(wallet);

const CHAINS = {
  avalanche: { rpc: env.RPC_AVALANCHE_FUJI ?? "https://api.avax-test.network/ext/bc/C/rpc", usdc: "0x5425890298aed601595a70AB815c96711a31Bc65" as const, id: "eip155:43113" },
  monad: { rpc: env.RPC_MONAD_TESTNET ?? "https://testnet-rpc.monad.xyz", usdc: "0x534b2f3A21130d7a60830c2Df862319e593943A3" as const, id: "eip155:10143" },
} as const;
const HORIZON = env.HORIZON_STELLAR_TESTNET ?? "https://horizon-testnet.stellar.org";
const STELLAR_USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)", "event Transfer(address indexed from, address indexed to, uint256 value)"]);
const clients = Object.fromEntries(Object.entries(CHAINS).map(([k, c]) => [k, createPublicClient({ transport: http(c.rpc) })])) as Record<keyof typeof CHAINS, ReturnType<typeof createPublicClient>>;

const evmUsdc = async (chain: keyof typeof CHAINS, who: `0x${string}`) =>
  (await clients[chain].readContract({ address: CHAINS[chain].usdc, abi: ERC20, functionName: "balanceOf", args: [who] })) as bigint;
async function stellarBalances(address: string) {
  const r = await fetch(`${HORIZON}/accounts/${address}`);
  if (!r.ok) throw new Error(`Horizon ${r.status} for ${address}`);
  const a = (await r.json()) as { balances: Array<{ asset_type: string; asset_code?: string; asset_issuer?: string; balance: string }> };
  const stroops = (s: string) => BigInt(s.replace(".", ""));
  return {
    usdc: stroops(a.balances.find((b) => b.asset_code === "USDC" && b.asset_issuer === STELLAR_USDC_ISSUER)?.balance ?? "0.0000000"),
    xlm: stroops(a.balances.find((b) => b.asset_type === "native")?.balance ?? "0.0000000"),
  };
}
const fmt = (v: bigint, d: number) => formatUnits(v, d);

// ── reporting ──────────────────────────────────────────────────────────────────────────────────
type Row = { status: "PASS" | "FAIL" | "SKIP"; step: string; detail?: unknown };
const rows: Row[] = [];
function note(status: Row["status"], step: string, detail?: unknown) {
  rows.push({ status, step, ...(detail === undefined ? {} : { detail }) });
  const d = detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
  console.log(`${status.padEnd(4)} ${step}${d}`);
}
async function step<T>(name: string, fn: () => Promise<T>, show?: (r: T) => unknown): Promise<T | undefined> {
  const t0 = Date.now();
  try {
    const r = await fn();
    note("PASS", name, { ...(show ? ({ result: show(r) } as object) : {}), seconds: Math.round((Date.now() - t0) / 1000) });
    return r;
  } catch (e) {
    // The facilitator settles only the assets in its allow-list. That is the deployment's choice, not the SDK's: report it, do not fail on it.
    if (e instanceof Error && /"error":"unsupported_asset"/.test(e.message)) {
      note("SKIP", name, "the facilitator's allow-list for this network does not include the asset (unsupported_asset); add its SAC to the x402 plugin config");
      return undefined;
    }
    const detail = e instanceof TilcaiError ? `${e.code}${e.status ? ` (HTTP ${e.status})` : ""}: ${e.message}${e.detail ? ` [${e.detail}]` : ""}` : e instanceof Error ? e.message : String(e);
    note("FAIL", name, detail);
    return undefined;
  }
}
function must(c: unknown, m: string): asserts c {
  if (!c) throw new Error(m);
}

// ── snapshot before ────────────────────────────────────────────────────────────────────────────
interface Snapshot {
  fuji: bigint;
  monad: bigint;
  stellarUsdc: bigint;
}
async function snapshot(): Promise<Snapshot> {
  const [fuji, monad, st] = await Promise.all([evmUsdc("avalanche", wallet.address), evmUsdc("monad", wallet.address), stellarBalances(stellarAddress)]);
  return { fuji, monad, stellarUsdc: st.usdc };
}
console.log(`\nTilcAI SDK wallet e2e · ${tilcai.baseUrl}\nEVM wallet ${wallet.address} · Stellar ${stellarAddress}${stellarSecret ? " (with secret)" : " (receive-only)"}\n`);
const before = await snapshot();
console.log(`before: Fuji ${fmt(before.fuji, 6)} USDC · Monad ${fmt(before.monad, 6)} USDC · Stellar ${fmt(before.stellarUsdc, 7)} USDC\n`);
const atomic6 = decimalToAtomic(AMOUNT, 6);
const atomic7 = decimalToAtomic(AMOUNT, 7);
let expected: Snapshot = { ...before };

// ── 1. vault payouts to your accounts (receiving) ──────────────────────────────────────────────
if (only.has("vault")) {
  for (const [network, to] of [
    ["avalanche", wallet.address],
    ["monad", wallet.address],
    ["stellar", stellarAddress],
  ] as const) {
    await step(`vault ${network}: disburse ${AMOUNT} USDC → ${to.slice(0, 8)}…`, async () => {
      const reference = `sdk-e2e-${Date.now()}-${network}`;
      const created = await tilcai.vault.disburse({ network, to, amount: AMOUNT, reference, idempotencyKey: reference });
      const done = await tilcai.vault.waitForConfirmation(created.disbursement.id, { timeoutMs: 5 * 60_000 });
      return { id: done.id, tx: done.txHash };
    });
    // Each payout is checked against the chain, not against the API's own answer.
    if (network === "avalanche") expected.fuji += atomic6;
    if (network === "monad") expected.monad += atomic6;
    if (network === "stellar") expected.stellarUsdc += atomic7;
  }
  const now = await snapshot();
  await step("vault: balances moved by exactly the payouts", async () => {
    must(now.fuji === expected.fuji, `Fuji ${fmt(now.fuji, 6)} ≠ expected ${fmt(expected.fuji, 6)}`);
    must(now.monad === expected.monad, `Monad ${fmt(now.monad, 6)} ≠ expected ${fmt(expected.monad, 6)}`);
    must(now.stellarUsdc === expected.stellarUsdc, `Stellar ${fmt(now.stellarUsdc, 7)} ≠ expected ${fmt(expected.stellarUsdc, 7)}`);
    return { fuji: fmt(now.fuji, 6), monad: fmt(now.monad, 6), stellar: fmt(now.stellarUsdc, 7) };
  });
}

// ── 2. crosschain payments: EVM wallet → Stellar (starts now, settles in the background) ───────
const crosschain: Array<Promise<PaymentView | undefined>> = [];
if (only.has("crosschain")) {
  for (const from of ["avalanche", "monad"] as const) {
    crosschain.push(
      step(`crosschain ${from}: pay ${AMOUNT} USDC wallet → Stellar account (gasless, CCTP V2)`, async () => {
        const r = await tilcai.payments.pay({
          from,
          amount: AMOUNT,
          payTo: stellarAddress,
          signer,
          orderId: `sdk-e2e-${Date.now()}-${from}`,
          wait: { timeoutMs: 25 * 60_000, intervalMs: 5000, onUpdate: (v) => console.log(`     … ${from}: ${v.payment.state}`) },
        });
        return r.view;
      }, (v) => ({ payment: v.payment.id, state: v.payment.state, burn: v.links.burn, mint: v.links.mint, receipt: v.receipt ? "yes" : "no" })),
    );
    if (from === "avalanche") expected.fuji -= atomic6;
    else expected.monad -= atomic6;
    expected.stellarUsdc += atomic7;
  }
}

// ── 3. x402 with the real facilitator ──────────────────────────────────────────────────────────
if (only.has("x402")) {
  const facilitator = new X402Facilitator({ url: need("TILCAI_RELAYER_URL"), apiKey: need("TILCAI_RELAYER_API_KEY"), timeoutMs: 120_000 });

  async function serve(paywall: Paywall) {
    const handler = paywall.fetchHandler((_r, paid) => Response.json({ ok: true, payer: paid.payer, tx: paid.settlement.transaction }));
    const server = createServer((req, res) => {
      void (async () => {
        const out = await handler(new Request(`http://${req.headers.host}${req.url}`, { headers: req.headers as Record<string, string> }));
        res.writeHead(out.status, Object.fromEntries(out.headers));
        res.end(Buffer.from(await out.arrayBuffer()));
      })();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/resource`, close: () => (server.closeAllConnections(), server.close()) };
  }

  // 3a. EVM: a round trip between the wallet and a second account, so both send and receive.
  const secondKey = generatePrivateKey();
  const second = privateKeyToAccount(secondKey);
  for (const network of ["avalanche", "monad"] as const) {
    const chain = CHAINS[network];
    const leg = async (label: string, from: ReturnType<typeof privateKeyToAccount>, to: `0x${string}`) =>
      step(`x402 ${network}: ${label} ${AMOUNT} USDC via the real facilitator`, async () => {
        const paywall = new Paywall({ facilitator, accepts: [{ network, amount: AMOUNT, payTo: to }], resource: { description: "sdk e2e" } });
        const srv = await serve(paywall);
        try {
          const pay = x402Fetch({ wallet: { evm: evmSignerFromViem(from) }, maxAmountAtomic: atomic6 });
          const res = await pay(srv.url);
          must(res.status === 200, `HTTP ${res.status}: ${await res.text()}`);
          const s = res.settlement;
          must(s?.success, `settlement ${JSON.stringify(s)}`);
          must(s.payer?.toLowerCase() === from.address.toLowerCase(), "payer in the settlement is not the signer");
          // The chain, not the facilitator, is the witness.
          const hash = (s.transaction.startsWith("0x") ? s.transaction : `0x${s.transaction}`) as `0x${string}`;
          const receipt = await clients[network].waitForTransactionReceipt({ hash, timeout: 90_000 });
          must(receipt.status === "success", `transaction ${hash} reverted`);
          const transfers = parseEventLogs({ abi: ERC20, logs: receipt.logs, eventName: "Transfer" }).filter((l) => l.address.toLowerCase() === chain.usdc.toLowerCase());
          must(transfers.some((l) => l.args.from.toLowerCase() === from.address.toLowerCase() && l.args.to.toLowerCase() === to.toLowerCase() && l.args.value === atomic6), "no matching USDC Transfer in the receipt");
          return { tx: hash, from: from.address.slice(0, 8), to: to.slice(0, 8) };
        } finally {
          srv.close();
        }
      });
    const out = await leg("wallet → second account", wallet, second.address);
    if (out) {
      const back = await leg("second account → wallet", second, wallet.address);
      if (!back) {
        // Do not strand funds silently: keep the throwaway key (testnet, gitignored) so they can be recovered.
        mkdirSync("results", { recursive: true });
        const file = `results/stranded-${network}-${Date.now()}.json`;
        writeFileSync(file, JSON.stringify({ network, address: second.address, privateKey: secondKey }), { mode: 0o600 });
        note("FAIL", `x402 ${network}: ${AMOUNT} USDC stayed at ${second.address} (return leg failed); key saved to ${file}`);
      }
    }
  }

  // 3b. Stellar: payer and merchant are funded by Friendbot, so no real funds are at stake. XLM, as the facilitator's asset list allows.
  await step("x402 stellar: settle 0.01 XLM payer → merchant via the real facilitator", async () => {
    const payer = Keypair.random();
    const merchant = Keypair.random();
    for (const kp of [payer, merchant]) must((await fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`)).ok, "Friendbot refused");
    await new Promise((r) => setTimeout(r, 6000));
    const xlm = Asset.native().contractId(Networks.TESTNET);
    const [pb, mb] = await Promise.all([stellarBalances(payer.publicKey()), stellarBalances(merchant.publicKey())]);
    const paywall = new Paywall({ facilitator, accepts: [{ network: "stellar", amount: "0.01", payTo: merchant.publicKey(), asset: xlm }] });
    const srv = await serve(paywall);
    try {
      const res = await x402Fetch({ wallet: { stellar: payer.secret() } })(srv.url);
      must(res.status === 200, `HTTP ${res.status}: ${await res.text()}`);
      const s = res.settlement;
      must(s?.success, `settlement ${JSON.stringify(s)}`);
      await new Promise((r) => setTimeout(r, 3000));
      const [pa, ma] = await Promise.all([stellarBalances(payer.publicKey()), stellarBalances(merchant.publicKey())]);
      must(ma.xlm - mb.xlm === 100_000n, `merchant received ${ma.xlm - mb.xlm} stroops, expected 100000`);
      must(pb.xlm - pa.xlm === 100_000n, `payer paid ${pb.xlm - pa.xlm} stroops (a fee leaked to the payer?)`);
      const tx = (await (await fetch(`${HORIZON}/transactions/${s.transaction}`)).json()) as { successful: boolean; fee_account: string };
      must(tx.successful, "transaction not successful on Horizon");
      must(tx.fee_account !== payer.publicKey(), "the payer paid the fee");
      return { tx: s.transaction, feeAccount: tx.fee_account.slice(0, 8) };
    } finally {
      srv.close();
    }
  });

  // 3c. Stellar USDC, both ways: your Stellar account pays a fresh account that has a USDC trustline, which pays it back.
  if (!stellarSecret) {
    note("SKIP", "x402 stellar: USDC paid from your Stellar account", "TEST_STELLAR_SECRET_KEY not provided (the address alone can only receive)");
  } else {
    const merchant = Keypair.random();
    const usdcAsset = new Asset("USDC", STELLAR_USDC_ISSUER);
    await step("x402 stellar: prepare a recipient (Friendbot XLM + USDC trustline)", async () => {
      must((await fetch(`https://friendbot.stellar.org/?addr=${merchant.publicKey()}`)).ok, "Friendbot refused");
      await new Promise((r) => setTimeout(r, 5000));
      const acc = (await (await fetch(`${HORIZON}/accounts/${merchant.publicKey()}`)).json()) as { sequence: string };
      const tx = new TransactionBuilder(new Account(merchant.publicKey(), acc.sequence), { fee: "1000", networkPassphrase: Networks.TESTNET })
        .addOperation(Operation.changeTrust({ asset: usdcAsset }))
        .setTimeout(60)
        .build();
      tx.sign(merchant);
      const r = await fetch(`${HORIZON}/transactions`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ tx: tx.toXDR() }) });
      must(r.ok, `changeTrust failed: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
      return { merchant: merchant.publicKey() };
    });
    const assets = {
      usdc: { name: "USDC", contract: usdcAsset.contractId(Networks.TESTNET), amount: atomic7 },
      xlm: { name: "XLM", contract: Asset.native().contractId(Networks.TESTNET), amount: atomic7 },
    } as const;
    const leg = (asset: keyof typeof assets, label: string, payerSecret: string, payer: string, to: string) =>
      step(`x402 stellar ${assets[asset].name}: ${label} ${AMOUNT} ${assets[asset].name} via the real facilitator`, async () => {
        const a = assets[asset];
        const [pb, tb] = await Promise.all([stellarBalances(payer), stellarBalances(to)]);
        const paywall = new Paywall({ facilitator, accepts: [{ network: "stellar", amount: AMOUNT, payTo: to, asset: a.contract }] });
        const srv = await serve(paywall);
        try {
          const res = await x402Fetch({ wallet: { stellar: payerSecret }, maxAmountAtomic: a.amount })(srv.url);
          must(res.status === 200, `HTTP ${res.status}: ${await res.text()}`);
          const st = res.settlement;
          must(st?.success, `settlement ${JSON.stringify(st)}`);
          must(st.payer === payer, "payer in the settlement is not the signer");
          await new Promise((r) => setTimeout(r, 3000));
          const [pa, ta] = await Promise.all([stellarBalances(payer), stellarBalances(to)]);
          const moved = (x: { usdc: bigint; xlm: bigint }, y: { usdc: bigint; xlm: bigint }) => (asset === "usdc" ? x.usdc - y.usdc : x.xlm - y.xlm);
          must(moved(pb, pa) === a.amount, `payer ${a.name} moved by ${fmt(moved(pb, pa), 7)}`);
          must(moved(ta, tb) === a.amount, `recipient ${a.name} moved by ${fmt(moved(ta, tb), 7)}`);
          // XLM is also what fees are paid in: the payer's XLM moving by the amount alone proves the relayer paid the fee.
          if (asset === "usdc") must(pb.xlm === pa.xlm, `payer XLM moved by ${fmt(pb.xlm - pa.xlm, 7)}: the payer must not pay the fee`);
          const tx = (await (await fetch(`${HORIZON}/transactions/${st.transaction}`)).json()) as { successful: boolean; fee_account: string };
          must(tx.successful && tx.fee_account !== payer, "transaction not successful or fee paid by the payer");
          return { tx: st.transaction, feeAccount: tx.fee_account.slice(0, 8) };
        } finally {
          srv.close();
        }
      });
    // USDC needs the facilitator to list its SAC; if it does not, the XLM pair still exercises your key against the real facilitator.
    const usdcOut = await leg("usdc", "your account → fresh account", stellarSecret, stellarAddress, merchant.publicKey());
    if (usdcOut) await leg("usdc", "fresh account → your account", merchant.secret(), merchant.publicKey(), stellarAddress);
    if (await leg("xlm", "your account → fresh account", stellarSecret, stellarAddress, merchant.publicKey())) {
      await leg("xlm", "fresh account → your account", merchant.secret(), merchant.publicKey(), stellarAddress);
    }
  }
}

// ── 4. smart accounts ──────────────────────────────────────────────────────────────────────────
if (only.has("accounts")) {
  const tenantKey = env.TILCAI_TENANT_KEY;
  const issuer = tenantKey ? new Tilcai({ baseUrl: tilcai.baseUrl, apiKey: tenantKey, environment: "testnet", timeoutMs: 60_000 }) : tilcai;
  const probe = await issuer.accounts.list({ limit: 1 }).then(() => true, (e) => (e instanceof TilcaiError && e.status === 403 ? false : Promise.reject(e)));
  if (!probe) {
    note("SKIP", "accounts: issue SCA on avalanche, monad and stellar", "this API key has no accounts:read/write scopes (HTTP 403); set TILCAI_TENANT_KEY");
  } else {
    const publicKey = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "der", type: "spki" });
    for (const network of ["avalanche", "monad", "stellar"] as const) {
      await step(`accounts ${network}: issue SCA and wait for ACTIVE`, async () => {
        const created = await issuer.accounts.create({ network, externalRef: `sdk-e2e-${Date.now()}`, owner: passkeyOwner({ publicKey, credentialId: "sdk-e2e", rpId: "localhost" }) });
        const view = await issuer.accounts.waitForActive(created.account.id, { timeoutMs: 4 * 60_000 });
        return { id: view.account.id, address: view.account.address, deployTx: view.links.deployTx };
      });
    }
  }
}

// ── 5. settle the background payments and check the books ──────────────────────────────────────
if (crosschain.length) {
  console.log("\nwaiting for the crosschain payments…");
  await Promise.all(crosschain);
}
if (only.has("crosschain") || only.has("vault")) {
  const after = await snapshot();
  await step("books: balances equal start + payouts − crosschain payments (+ x402 round trips net zero)", async () => {
    const lines = {
      fuji: [fmt(after.fuji, 6), fmt(expected.fuji, 6)],
      monad: [fmt(after.monad, 6), fmt(expected.monad, 6)],
      stellar: [fmt(after.stellarUsdc, 7), fmt(expected.stellarUsdc, 7)],
    };
    const failedCross = rows.some((r) => r.status === "FAIL" && r.step.startsWith("crosschain"));
    if (failedCross) return { note: "a crosschain payment did not settle; books not compared", ...lines };
    must(after.fuji === expected.fuji, `Fuji ${lines.fuji[0]} ≠ ${lines.fuji[1]}`);
    must(after.monad === expected.monad, `Monad ${lines.monad[0]} ≠ ${lines.monad[1]}`);
    must(after.stellarUsdc === expected.stellarUsdc, `Stellar ${lines.stellar[0]} ≠ ${lines.stellar[1]}`);
    return lines;
  });
}

mkdirSync("results", { recursive: true });
const file = `results/wallet-e2e-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), instance: tilcai.baseUrl, evm: wallet.address, stellar: stellarAddress, amount: AMOUNT, rows }, null, 2));
const c = (s: string) => rows.filter((r) => r.status === s).length;
console.log(`\n${c("PASS")} PASS · ${c("FAIL")} FAIL · ${c("SKIP")} SKIP → ${file}`);
process.exit(c("FAIL") > 0 ? 1 : 0);
