#!/usr/bin/env -S npx tsx
/**
 * SCA end-to-end with real testnet funds: issues smart accounts on Avalanche Fuji, Monad Testnet
 * and Stellar Testnet, funds the EVM ones from your wallet, and pays from each one to your Stellar
 * account with a passkey signature (account mode, CCTP V2). Opt-in: it deploys contracts and moves
 * 0.01 USDC per payment.
 *
 * Needs an instance with account issuance on and a tenant key with the scopes payments,
 * accounts:read and accounts:write:
 *   TILCAI_SCA_URL (default TILCAI_API_URL), TILCAI_TENANT_KEY
 * plus, as in wallet-e2e: TEST_EVM_SECRET_KEY, TEST_STELLAR_ADDRESS and, optionally, TEST_STELLAR_SECRET_KEY (.env or E2E_ENV_FILE),
 * TILCAI_RELAYER_URL and TILCAI_RELAYER_API_KEY (to fund the Avalanche account through x402).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Account, Address, Asset, Contract, Networks, TransactionBuilder, nativeToScVal, rpc as stellarRpc, scValToNative } from "@stellar/stellar-sdk";
import { createPublicClient, createWalletClient, defineChain, formatUnits, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { SoftwarePasskey, Tilcai, TilcaiError, decimalToAtomic, ed25519Owner, evmSignerFromViem } from "../src/index.js";
import { Paywall, X402Facilitator, x402Fetch } from "../src/x402/index.js";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const AMOUNT = "0.01";
const atomic6 = decimalToAtomic(AMOUNT, 6);
const atomic7 = decimalToAtomic(AMOUNT, 7);

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(resolve(process.env.E2E_ENV_FILE ?? ".env"), "utf8").split("\n")) {
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
const stellarSecret = env.TEST_STELLAR_SECRET_KEY;
const stellarAddress = need("TEST_STELLAR_ADDRESS");
const tilcai = new Tilcai({ baseUrl: env.TILCAI_SCA_URL ?? need("TILCAI_API_URL"), apiKey: need("TILCAI_TENANT_KEY"), environment: "testnet", timeoutMs: 90_000 });
const facilitator = new X402Facilitator({ url: need("TILCAI_RELAYER_URL"), apiKey: need("TILCAI_RELAYER_API_KEY"), timeoutMs: 120_000 });

const CHAINS = {
  avalanche: { rpc: env.RPC_AVALANCHE_FUJI ?? "https://api.avax-test.network/ext/bc/C/rpc", usdc: "0x5425890298aed601595a70AB815c96711a31Bc65" as const, id: 43113, name: "Avalanche Fuji" },
  monad: { rpc: env.RPC_MONAD_TESTNET ?? "https://testnet-rpc.monad.xyz", usdc: "0x534b2f3A21130d7a60830c2Df862319e593943A3" as const, id: 10143, name: "Monad Testnet" },
} as const;
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"]);
const pub = (c: keyof typeof CHAINS) => createPublicClient({ transport: http(CHAINS[c].rpc) });
const balance = async (c: keyof typeof CHAINS, who: `0x${string}`) => (await pub(c).readContract({ address: CHAINS[c].usdc, abi: ERC20, functionName: "balanceOf", args: [who] })) as bigint;
async function stellarUsdc(address: string): Promise<bigint> {
  const a = (await (await fetch(`https://horizon-testnet.stellar.org/accounts/${address}`)).json()) as { balances: Array<{ asset_code?: string; balance: string }> };
  return BigInt((a.balances.find((b) => b.asset_code === "USDC")?.balance ?? "0").replace(".", ""));
}

type Row = { status: "PASS" | "FAIL" | "SKIP"; step: string; detail?: unknown };
const rows: Row[] = [];
async function step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  const t0 = Date.now();
  try {
    const r = await fn();
    rows.push({ status: "PASS", step: name, detail: r });
    console.log(`PASS ${name} — ${JSON.stringify(r)} (${Math.round((Date.now() - t0) / 1000)}s)`);
    return r;
  } catch (e) {
    if (e instanceof Error && /"error":"unsupported_asset"/.test(e.message)) {
      rows.push({ status: "SKIP", step: name, detail: "the facilitator's allow-list does not include the asset (unsupported_asset)" });
      console.log(`SKIP ${name} — the facilitator's allow-list does not include the asset (unsupported_asset); trying the next one`);
      return undefined;
    }
    const d = e instanceof TilcaiError ? `${e.code}${e.status ? ` HTTP ${e.status}` : ""}: ${e.message}${e.detail ? ` [${e.detail}]` : ""}` : e instanceof Error ? e.message : String(e);
    rows.push({ status: "FAIL", step: name, detail: d });
    console.log(`FAIL ${name} — ${d}`);
    return undefined;
  }
}
function must(c: unknown, m: string): asserts c {
  if (!c) throw new Error(m);
}

console.log(`\nSCA e2e · ${tilcai.baseUrl} · wallet ${wallet.address} · Stellar ${stellarAddress}\n`);
const h = await tilcai.health();
must(h.accounts === "on", "this instance has account issuance off");

// ── issue ──────────────────────────────────────────────────────────────────────────────────────
const stamp = Date.now();
const passkey = SoftwarePasskey.generate({ rpId: "sdk-e2e.tilcai.test" });
const accounts: Partial<Record<"avalanche" | "monad" | "stellar" | "stellar-ed25519", { id: string; address: string }>> = {};

for (const network of ["avalanche", "monad", "stellar"] as const) {
  await step(`issue SCA on ${network} (passkey owner), wait ACTIVE`, async () => {
    const ref = `sdk-e2e-${stamp}-${network}`;
    const created = await tilcai.accounts.create({ network, externalRef: ref, owner: passkey.owner, idempotencyKey: ref });
    must(created.account.address, "no address");
    const view = await tilcai.accounts.waitForActive(created.account.id, { timeoutMs: 5 * 60_000, intervalMs: 3000 });
    accounts[network] = { id: view.account.id, address: view.account.address };
    // The same request again is the same account, not a second deployment.
    const again = await tilcai.accounts.create({ network, externalRef: ref, owner: passkey.owner, idempotencyKey: ref });
    must(again.replayed && again.account.id === created.account.id, "idempotent replay did not return the same account");
    return { address: view.account.address, deployTx: view.links.deployTx };
  });
}

await step("issue SCA on stellar owned by your Stellar account (ed25519 owner)", async () => {
  const ref = `sdk-e2e-${stamp}-ed25519`;
  const created = await tilcai.accounts.create({ network: "stellar", externalRef: ref, owner: ed25519Owner(stellarAddress), idempotencyKey: ref });
  const view = await tilcai.accounts.waitForActive(created.account.id, { timeoutMs: 5 * 60_000, intervalMs: 3000 });
  accounts["stellar-ed25519"] = { id: view.account.id, address: view.account.address };
  return { address: view.account.address, deployTx: view.links.deployTx };
});

// The chain is the witness: the issued addresses have code.
for (const network of ["avalanche", "monad"] as const) {
  const a = accounts[network];
  if (!a) continue;
  await step(`${network}: SCA address has contract code on-chain`, async () => {
    const code = await pub(network).getCode({ address: a.address as `0x${string}` });
    must(code && code !== "0x", "no code at the address");
    return { address: a.address, bytes: (code.length - 2) / 2 };
  });
}
for (const key of ["stellar", "stellar-ed25519"] as const) {
  const a = accounts[key];
  if (!a) continue;
  await step(`stellar: ${key} contract exists on-chain`, async () => {
    const server = new stellarRpc.Server("https://soroban-testnet.stellar.org");
    const entries = await server.getLedgerEntries(...[new Contract(a.address).getFootprint()]);
    must(entries.entries.length > 0, "no contract instance in the ledger");
    return { address: a.address };
  });
}

// ── Stellar: the account owned by your Stellar key receives USDC through x402 ──────────────────────
const SAC_USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const SAC_XLM = Asset.native().contractId(Networks.TESTNET);
async function sacBalance(holder: string, sac: string): Promise<bigint> {
  const server = new stellarRpc.Server("https://soroban-testnet.stellar.org");
  const source = await server.getAccount(stellarAddress);
  const tx = new TransactionBuilder(new Account(stellarAddress, source.sequenceNumber()), { fee: "100000", networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(sac).call("balance", Address.fromString(holder).toScVal()))
    .setTimeout(30)
    .build();
  const sim = (await server.simulateTransaction(tx)) as { result?: { retval: unknown }; error?: string };
  if (!sim.result) throw new Error(`balance simulation failed: ${sim.error ?? "no result"}`);
  return BigInt(scValToNative(sim.result.retval as never) as bigint | number | string);
}
if (stellarSecret && accounts["stellar-ed25519"]) {
  const c = accounts["stellar-ed25519"].address;
  // USDC first; the facilitator only settles assets in its allow-list, so fall back to XLM and say which one worked.
  for (const [name, sac, amount] of [["USDC", SAC_USDC, atomic7], ["XLM", SAC_XLM, atomic7]] as const) {
    const done = await step(`stellar: your account funds the ed25519-owned SCA with ${AMOUNT} ${name} through x402 (payTo = C…)`, async () => {
      const before = await sacBalance(c, sac);
      const paywall = new Paywall({ facilitator, accepts: [{ network: "stellar", amount: AMOUNT, payTo: c, asset: sac }] });
      const handler = paywall.fetchHandler((_r, p) => Response.json({ tx: p.settlement.transaction }));
      const server = createServer((req, res) => {
        void (async () => {
          const out = await handler(new Request(`http://${req.headers.host}${req.url}`, { headers: req.headers as Record<string, string> }));
          res.writeHead(out.status, Object.fromEntries(out.headers));
          res.end(Buffer.from(await out.arrayBuffer()));
        })();
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      try {
        const res = await x402Fetch({ wallet: { stellar: stellarSecret }, maxAmountAtomic: amount })(`http://127.0.0.1:${(server.address() as AddressInfo).port}/fund`);
        must(res.status === 200 && res.settlement?.success, `x402 funding failed: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
        await new Promise((r) => setTimeout(r, 3000));
        const after = await sacBalance(c, sac);
        must(after - before === amount, `the SCA's ${name} moved by ${Number(after - before) / 1e7}, expected ${AMOUNT}`);
        return { account: c, asset: name, tx: res.settlement.transaction, balance: Number(after) / 1e7 };
      } finally {
        server.closeAllConnections();
        server.close();
      }
    });
    if (done) break;
  }
}

// ── fund the EVM accounts, then pay from them with the passkey ─────────────────────────────────
const before = await stellarUsdc(stellarAddress);

async function payFrom(network: "avalanche" | "monad") {
  const a = accounts[network];
  if (!a) return;
  const addr = a.address as `0x${string}`;
  // 1. fund it from your wallet
  const funded = await step(`${network}: fund the SCA with ${AMOUNT} USDC from your wallet`, async () => {
    if (network === "monad") {
      const chain = defineChain({ id: CHAINS.monad.id, name: CHAINS.monad.name, nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [CHAINS.monad.rpc] } } });
      const wc = createWalletClient({ account: wallet, chain, transport: http(CHAINS.monad.rpc) });
      const hash = await wc.writeContract({ address: CHAINS.monad.usdc, abi: ERC20, functionName: "transfer", args: [addr, atomic6] });
      const rc = await pub("monad").waitForTransactionReceipt({ hash, timeout: 90_000 });
      must(rc.status === "success", "transfer reverted");
      return { via: "ERC-20 transfer (wallet pays MON)", tx: hash };
    }
    // Fuji: the wallet has no AVAX, so it pays the account with an x402 authorization the relayer submits.
    const paywall = new Paywall({ facilitator, accepts: [{ network: "avalanche", amount: AMOUNT, payTo: addr }] });
    const handler = paywall.fetchHandler((_r, p) => Response.json({ tx: p.settlement.transaction }));
    const server = createServer((req, res) => {
      void (async () => {
        const out = await handler(new Request(`http://${req.headers.host}${req.url}`, { headers: req.headers as Record<string, string> }));
        res.writeHead(out.status, Object.fromEntries(out.headers));
        res.end(Buffer.from(await out.arrayBuffer()));
      })();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const res = await x402Fetch({ wallet: { evm: evmSignerFromViem(wallet) }, maxAmountAtomic: atomic6 })(`http://127.0.0.1:${(server.address() as AddressInfo).port}/fund`);
      must(res.status === 200 && res.settlement?.success, `x402 funding failed: HTTP ${res.status}`);
      return { via: "x402 EIP-3009 (relayer pays gas)", tx: res.settlement.transaction };
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
  if (!funded) return;
  const funds = await balance(network, addr);
  await step(`${network}: SCA holds the USDC it was funded with`, async () => {
    must(funds >= atomic6, `SCA balance ${formatUnits(funds, 6)} < ${AMOUNT}`);
    return { balance: formatUnits(funds, 6) };
  });

  // 2. pay to your Stellar account, authorized by the passkey (ERC-1271 through the router v2)
  await step(`${network}: SCA pays ${AMOUNT} USDC → Stellar account, signed by its passkey`, async () => {
    const r = await tilcai.payments.pay({
      from: network,
      amount: AMOUNT,
      payTo: stellarAddress,
      payer: addr,
      passkey: async ({ challengeBase64Url }) => passkey.assertion(challengeBase64Url),
      orderId: `sdk-e2e-sca-${stamp}-${network}`,
      wait: { timeoutMs: 25 * 60_000, intervalMs: 5000, onUpdate: (v) => console.log(`     … ${network}: ${v.payment.state}`) },
    });
    must(r.view.payment.state === "SETTLED", `state ${r.view.payment.state}`);
    must(r.view.payment.mode === "account", `mode ${r.view.payment.mode}`);
    const left = await balance(network, addr);
    must(funds - left === atomic6, `SCA balance moved by ${formatUnits(funds - left, 6)}, expected ${AMOUNT}`);
    return { payment: r.paymentId, burn: r.view.links.burn, mint: r.view.links.mint };
  });
}

await Promise.all([payFrom("monad"), payFrom("avalanche")]);

await step("books: your Stellar account received both SCA payments", async () => {
  const okPayments = rows.filter((r) => r.status === "PASS" && / SCA pays /.test(r.step)).length;
  const after = await stellarUsdc(stellarAddress);
  must(after - before === BigInt(okPayments) * atomic7, `Stellar moved by ${(Number(after - before) / 1e7).toFixed(7)} USDC for ${okPayments} settled payment(s)`);
  return { payments: okPayments, received: formatUnits(after - before, 7) };
});

mkdirSync("results", { recursive: true });
const file = `results/sca-e2e-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), instance: tilcai.baseUrl, accounts, rows }, null, 2));
const fails = rows.filter((r) => r.status === "FAIL").length;
console.log(`\n${rows.length - fails} PASS · ${fails} FAIL → ${file}`);
process.exit(fails ? 1 : 0);
