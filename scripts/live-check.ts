#!/usr/bin/env -S npx tsx
/**
 * Checks the SDK against a real TilcAI instance on Avalanche, Monad and Stellar.
 *
 * Nothing here moves funds unless you pass --settle:
 *   - quotes and payment attempts are created, but nothing is signed for submission;
 *   - the gasless typed data TilcAI returns is signed locally with a throwaway key and only
 *     verified, never posted;
 *   - x402 is `/supported` + `/verify` (never `/settle`).
 *
 * Environment (same names as `Tilcai.fromEnv`):
 *   TILCAI_API_URL, TILCAI_API_KEY           the instance (operator key unlocks vault / monitor / relayer checks)
 *   TILCAI_RELAYER_URL, TILCAI_RELAYER_API_KEY   the OpenZeppelin Relayer (x402 checks)
 *   E2E_PAY_TO                               Stellar G… recipient (default: the Stellar vault's owner)
 *   E2E_AMOUNT                               default 0.01
 *   E2E_PAYER_PRIVATE_KEY                    only with --settle: a funded payer on the source network
 *
 * Flags: --settle (real payments, needs E2E_PAYER_PRIVATE_KEY) · --issue-accounts (deploys SCAs; costs relayer gas)
 *        --no-friendbot (skip the Stellar x402 check, which funds a throwaway account at Friendbot)
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { verifyTypedData } from "viem";
import { generateKeyPairSync } from "node:crypto";
import { Asset, Keypair, Networks } from "@stellar/stellar-sdk";
import {
  Tilcai,
  TilcaiError,
  assertSignable,
  evmSignerFromViem,
  isStellarAccount,
  passkeyOwner,
  resolveEvmNetwork,
  typedDataArgs,
  type EvmNetworkInfo,
} from "../src/index.js";
import { X402Facilitator, buildRequirements, createEvmPayload, createStellarPayload } from "../src/x402/index.js";

const flags = new Set(process.argv.slice(2));
const amount = process.env.E2E_AMOUNT ?? "0.01";
const tilcai = Tilcai.fromEnv();
const results: Array<{ status: "PASS" | "FAIL" | "SKIP"; name: string; detail?: string }> = [];

function record(status: "PASS" | "FAIL" | "SKIP", name: string, detail?: unknown) {
  const d = detail === undefined ? undefined : typeof detail === "string" ? detail : JSON.stringify(detail);
  results.push({ status, name, ...(d ? { detail: d } : {}) });
  console.log(`${status.padEnd(4)} ${name}${d ? ` — ${d}` : ""}`);
}

async function check<T>(name: string, fn: () => Promise<T>, describe?: (r: T) => unknown): Promise<T | undefined> {
  try {
    const r = await fn();
    record("PASS", name, describe?.(r));
    return r;
  } catch (e) {
    if (e instanceof TilcaiError && (e.status === 403 || e.code === "NO_API_KEY")) {
      record("SKIP", name, `${e.code}: this key cannot do that (${e.message})`);
    } else {
      record("FAIL", name, e instanceof Error ? e.message : String(e));
    }
    return undefined;
  }
}

function must(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

console.log(`TilcAI SDK live check · ${tilcai.baseUrl} · expects ${tilcai.environment}\n`);

// ── instance ─────────────────────────────────────────────────────────────────────────────────────
const health = await check(
  "health",
  async () => {
    const h = await tilcai.verifyEnvironment();
    must(h.ok, "instance reports ok=false");
    return h;
  },
  (h) => ({ env: h.env, relayer: h.relayer, networks: h.networks, accounts: h.accounts, vault: h.vault, vaultStellar: h.vaultStellar }),
);
const routes = await check("routes", () => tilcai.routes(), (r) => r.map((x) => `${x.source.network}→${x.destination.network} gasless=${x.gasless} account=${x.account} vault=${x.vault}`));

const sources: Array<{ alias: "avalanche" | "monad"; net: EvmNetworkInfo }> = [
  { alias: "avalanche", net: resolveEvmNetwork("avalanche", tilcai.environment) },
  { alias: "monad", net: resolveEvmNetwork("monad", tilcai.environment) },
];

// ── recipient ────────────────────────────────────────────────────────────────────────────────────
let payTo = process.env.E2E_PAY_TO ?? "";
if (!payTo) {
  const v = await tilcai.vault.status("stellar").catch(() => undefined);
  payTo = v?.owner ?? "";
}
if (!isStellarAccount(payTo)) {
  record("FAIL", "recipient", `set E2E_PAY_TO to a Stellar G… account (got ${JSON.stringify(payTo)})`);
  process.exit(1);
}
console.log(`\nrecipient ${payTo} · amount ${amount} USDC\n`);

// ── crosschain payments: Avalanche and Monad → Stellar ───────────────────────────────────────────
const throwaway = privateKeyToAccount(generatePrivateKey());
for (const { alias, net } of sources) {
  const route = routes?.find((r) => r.source.network === net.id);
  if (!route) {
    record("SKIP", `${alias}: route`, `${net.id} is not served by this instance`);
    continue;
  }
  const quote = await check(
    `${alias}: quote ${net.id} → stellar:testnet`,
    async () => {
      const q = await tilcai.payments.quote({ source: alias, amount, payTo });
      must(q.route.source === net.id, `route source ${q.route.source}`);
      must(q.route.destination === "stellar:testnet", `route destination ${q.route.destination}`);
      must(q.route.sourceDomain === net.cctpDomain, `source CCTP domain ${q.route.sourceDomain}, registry says ${net.cctpDomain}`);
      must(q.route.destinationDomain === 27, `destination CCTP domain ${q.route.destinationDomain}`);
      must(q.burn.asset.toLowerCase() === net.usdc.address.toLowerCase(), `burn asset ${q.burn.asset} is not ${net.name}'s USDC`);
      return q;
    },
    (q) => ({ id: q.id, burn: q.burn.amount, receives: q.destination.amount, preflight: q.preflight }),
  );
  if (!quote) continue;

  if (route.gasless) {
    await check(
      `${alias}: gasless attempt — typed data is this payment, and signs and verifies locally`,
      async () => {
        const c = await tilcai.payments.create({ quoteId: quote.id, mode: "gasless", payer: throwaway.address });
        const auth = c.authorization;
        must(auth, "no authorization returned");
        assertSignable({ quote, authorization: auth, payer: throwaway.address, source: net });
        must(auth.typedData.domain.name === net.usdc.eip712Name, `EIP-712 name ${String(auth.typedData.domain.name)} ≠ registry ${net.usdc.eip712Name}`);
        const args = typedDataArgs(auth.typedData);
        const signature = await evmSignerFromViem(throwaway).signTypedData(args);
        const ok = await verifyTypedData({ address: throwaway.address, signature, ...(args as object) } as never);
        must(ok, "the signature does not verify against the typed data TilcAI returned");
        return { payment: c.payment.id, state: c.payment.state, router: auth.router, domain: auth.typedData.domain.name };
      },
    );
  } else {
    record("SKIP", `${alias}: gasless`, "no TilcaiCctpRouter deployed on this network");
  }

  await check(
    `${alias}: external attempt — unsigned calls target ${net.name} (chain ${net.chainId})`,
    async () => {
      // A quote backs one payment attempt (a second one is "already processed"): ask for another.
      const q2 = await tilcai.payments.quote({ source: alias, amount, payTo });
      const c = await tilcai.payments.create({ quoteId: q2.id, mode: "external", payer: throwaway.address });
      must(c.unsignedCalls.length === 2, `expected approve + burn, got ${c.unsignedCalls.length} calls`);
      for (const call of c.unsignedCalls) must(call.chainId === net.chainId, `call for chain ${call.chainId}`);
      must(c.unsignedCalls[0]!.to.toLowerCase() === net.usdc.address.toLowerCase(), "approve is not on the USDC contract");
      return { payment: c.payment.id, calls: c.unsignedCalls.map((x) => x.description) };
    },
  );

  if (flags.has("--settle")) {
    const key = process.env.E2E_PAYER_PRIVATE_KEY as `0x${string}` | undefined;
    if (!key) {
      record("FAIL", `${alias}: settle`, "--settle needs E2E_PAYER_PRIVATE_KEY (a funded payer on this network)");
    } else {
      const signer = evmSignerFromViem(privateKeyToAccount(key));
      await check(
        `${alias}: REAL gasless payment ${amount} USDC → ${payTo}`,
        async () => {
          const r = await tilcai.payments.pay({ from: alias, amount, payTo, signer, wait: { timeoutMs: 15 * 60_000, onUpdate: (v) => console.log(`     … ${v.payment.state}`) } });
          return { payment: r.paymentId, burn: r.view.links.burn, mint: r.view.links.mint };
        },
      );
    }
  }
}

// ── Stellar: vault, accounts ─────────────────────────────────────────────────────────────────────
await check("stellar: vault status", () => tilcai.vault.status("stellar"), (v) => ({ address: v.address, balance: v.balance, paused: v.paused, availableToday: v.availableToday }));
for (const { alias } of sources) {
  await check(`${alias}: vault status`, () => tilcai.vault.status(alias), (v) => ({ address: v.address, balance: v.balance, paused: v.paused }));
}

const accountsReadable = await check("accounts: list (needs accounts:read)", () => tilcai.accounts.list({ limit: 1 }), (a) => `${a.length} account(s)`);
if (flags.has("--issue-accounts")) {
  if (accountsReadable === undefined) record("SKIP", "accounts: issue", "this key has no accounts:write scope");
  else {
    const pk = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "der", type: "spki" });
    for (const network of ["avalanche", "monad", "stellar"] as const) {
      await check(`${network}: issue SCA and wait for ACTIVE`, async () => {
        const created = await tilcai.accounts.create({ network, externalRef: `sdk-live-${Date.now()}`, owner: passkeyOwner({ publicKey: pk, credentialId: "sdk-live", rpId: "localhost" }) });
        const view = await tilcai.accounts.waitForActive(created.account.id, { timeoutMs: 3 * 60_000 });
        return { id: view.account.id, address: view.account.address, deployTx: view.links.deployTx };
      });
    }
  }
} else {
  record("SKIP", "accounts: issue SCA on avalanche / monad / stellar", "pass --issue-accounts (it deploys contracts and spends relayer gas)");
}

// ── monitoring ───────────────────────────────────────────────────────────────────────────────────
await check("monitor: events tail", () => tilcai.monitor.events({ limit: 5 }), (p) => ({ head: p.head, last: p.events.at(-1)?.type }));
await check("monitor: resources", () => tilcai.monitor.resources(), (r) => ({ alerts: r.alerts.length }));
const relayer = await check("relayer: status (x402 /supported via TilcAI)", () => tilcai.relayer.status(), (r) => ({ up: r.up, authenticated: r.authenticated }));
if (relayer?.x402 && "kinds" in relayer.x402) {
  const have = new Set(relayer.x402.kinds.map((k) => k.network));
  for (const n of ["eip155:43113", "eip155:10143", "stellar:testnet"]) {
    if (have.has(n)) record("PASS", `x402 facilitator advertises ${n}`);
    else record("FAIL", `x402 facilitator advertises ${n}`, "not in /supported");
  }
}

// ── x402 against the facilitator itself ──────────────────────────────────────────────────────────
if (process.env.TILCAI_RELAYER_URL && process.env.TILCAI_RELAYER_API_KEY) {
  const fac = new X402Facilitator();
  await check("x402: facilitator /supported", () => fac.supported(), (s) => s.kinds.map((k) => k.network).filter((n) => n.startsWith("stellar") || ["eip155:43113", "eip155:10143"].includes(n)));
  const merchant = privateKeyToAccount(generatePrivateKey()).address;
  for (const { alias, net } of sources) {
    await check(`x402 ${alias}: EIP-3009 payload is accepted up to the balance check`, async () => {
      const requirements = buildRequirements({ network: net.id, amount, payTo: merchant });
      const payload = await createEvmPayload({ requirements, signer: evmSignerFromViem(throwaway) });
      const v = await fac.verify(payload, requirements);
      // A throwaway payer has no USDC: with the right EIP-712 domain the facilitator gets past the signature and stops at the
      // balance (`insufficient_funds`); with a wrong domain it answers `invalid_exact_evm_payload_signature`.
      if (v.isValid) return { isValid: true };
      const reason = v.invalidReason ?? "";
      must(reason === "insufficient_funds", `rejected before the balance check: ${reason}`);
      return { isValid: false, invalidReason: reason, payer: v.payer };
    }, (r) => r);
  }
  if (flags.has("--no-friendbot")) {
    record("SKIP", "x402 stellar: payload verifies", "--no-friendbot");
  } else {
    await check("x402 stellar: transfer payload verifies (XLM SAC, Friendbot-funded throwaway payer)", async () => {
      const payer = Keypair.random();
      const merchant = Keypair.random();
      // The recipient must exist too: an XLM transfer cannot create an account below the base reserve.
      for (const kp of [payer, merchant]) {
        const fb = await fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`);
        must(fb.ok, `Friendbot answered ${fb.status}`);
      }
      await new Promise((r) => setTimeout(r, 6000));
      const xlmSac = Asset.native().contractId(Networks.TESTNET);
      const requirements = buildRequirements({ network: "stellar", amount: "0.01", payTo: merchant.publicKey(), asset: xlmSac });
      const payload = await createStellarPayload({ requirements, signer: payer.secret() });
      const v = await fac.verify(payload, requirements);
      must(v.isValid, `verify said ${JSON.stringify(v)}`);
      return { isValid: true, payer: v.payer };
    });
  }
} else {
  record("SKIP", "x402: facilitator checks", "set TILCAI_RELAYER_URL and TILCAI_RELAYER_API_KEY");
}

// ── summary ──────────────────────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => r.status === "FAIL").length;
const counts = ["PASS", "FAIL", "SKIP"].map((s) => `${results.filter((r) => r.status === s).length} ${s}`).join(" · ");
console.log(`\n${counts}${health ? "" : " (instance not reachable)"}`);
process.exit(failed > 0 ? 1 : 0);
