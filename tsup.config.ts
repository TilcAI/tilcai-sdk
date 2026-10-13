import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", x402: "src/x402/index.ts", core: "src/core/index.ts" },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  target: "node18",
  platform: "node",
  sourcemap: false,
  splitting: true,
  // Optional peers are loaded lazily with import(); they must never be bundled.
  external: ["viem", "viem/accounts", "@stellar/stellar-sdk"],
});
