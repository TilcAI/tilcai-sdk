#!/usr/bin/env node
/**
 * Packs the package and installs the tarball into an empty project, then loads it the way a
 * consumer would: ESM, CommonJS and the `./x402` and `./core` subpaths. Run by `prepublishOnly`.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const work = mkdtempSync(join(tmpdir(), "tilcai-sdk-smoke-"));
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

try {
  const packDir = join(work, "pack");
  mkdirSync(packDir);
  run("npm", ["pack", "--silent", "--pack-destination", packDir], root);
  const tarball = join(packDir, readdirSync(packDir).find((f) => f.endsWith(".tgz")));

  const app = join(work, "app");
  mkdirSync(app);
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "smoke", private: true, type: "module" }));
  run("npm", ["install", "--no-audit", "--no-fund", "--silent", tarball], app);

  const check = `
    const sdk = IMPORT_SDK;
    const x402 = IMPORT_X402;
    const core = IMPORT_CORE;
    const assert = (c, m) => { if (!c) throw new Error("smoke: " + m); };
    assert(typeof sdk.Tilcai === "function", "Tilcai");
    assert(sdk.resolveNetwork("monad").id === "eip155:10143", "monad");
    assert(sdk.resolveNetwork("avalanche").id === "eip155:43113", "avalanche");
    assert(sdk.resolveNetwork("stellar").id === "stellar:testnet", "stellar");
    assert(sdk.decimalToAtomic("1.5", 6) === 1500000n, "amount");
    assert(sdk.x402.buildRequirements === x402.buildRequirements, "x402 namespace");
    assert(x402.buildRequirements({ network: "monad", amount: "1", payTo: "0x" + "11".repeat(20) }).extra.name === "USDC", "requirements");
    assert(core.evaluateIntent({ id: "1", network: "n", asset: "a", resource: "r", payTo: "p", amountMicros: 1 }, { network: "n", asset: "a", allowedResources: ["r"], allowedPayTo: ["p"], maxPaymentMicros: 5, remainingMicros: 5, paused: false, expiresAtMs: 10 }, new Set(), 1).outcome === "ALLOW", "policy");
    const t = new sdk.Tilcai({ baseUrl: "http://127.0.0.1:1", apiKey: "k" });
    assert(typeof t.payments.pay === "function" && typeof t.accounts.create === "function" && typeof t.vault.disburse === "function", "namespaces");
    console.log("ok");
  `;
  writeFileSync(join(app, "esm.mjs"), check
    .replace("IMPORT_SDK", `await import("tilcai-sdk")`)
    .replace("IMPORT_X402", `await import("tilcai-sdk/x402")`)
    .replace("IMPORT_CORE", `await import("tilcai-sdk/core")`));
  writeFileSync(join(app, "cjs.cjs"), `(async () => {` + check
    .replace("IMPORT_SDK", `require("tilcai-sdk")`)
    .replace("IMPORT_X402", `require("tilcai-sdk/x402")`)
    .replace("IMPORT_CORE", `require("tilcai-sdk/core")`) + `})().catch((e) => { console.error(e); process.exit(1); });`);

  for (const f of ["esm.mjs", "cjs.cjs"]) {
    const out = run("node", [f], app).trim();
    if (out !== "ok") throw new Error(`${f} printed ${JSON.stringify(out)}`);
    console.log(`smoke ${f}: ok`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
