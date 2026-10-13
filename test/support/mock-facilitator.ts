/**
 * An x402 facilitator that behaves like the OpenZeppelin Relayer plugin documented in
 * tilcai-core/docs/payment-rail-environment.md: HTTP 200 with `isValid:false` / `success:false` for
 * business rejections, EIP-3009 signatures recovered for real, Soroban transfers decoded for real.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { recoverTypedDataAddress } from "viem";
import { Address, TransactionBuilder, scValToNative, type xdr } from "@stellar/stellar-sdk";
import { NETWORKS } from "../../src/networks.js";

export const RELAYER_KEY = "relayer-api-key";

export class MockFacilitator {
  readonly server: Server;
  url = "";
  readonly verifies: unknown[] = [];
  readonly settles: unknown[] = [];
  private readonly spent = new Set<string>();

  constructor() {
    this.server = createServer((req, res) => {
      void (async () => {
       try {
        let raw = "";
        for await (const c of req) raw += c;
        const send = (status: number, body: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        };
        if (req.headers.authorization !== `Bearer ${RELAYER_KEY}`) return send(401, { success: false, code: 401, error: "Unauthorized" });
        const m = /^\/api\/v1\/plugins\/x402\/call(\/[a-z]*)$/.exec(req.url ?? "");
        if (!m) return send(404, { code: "NOT_FOUND" });
        const route = m[1];
        if (route === "/supported") {
          return send(200, {
            kinds: Object.keys(NETWORKS).map((network) => ({ x402Version: 2, scheme: "exact", network, ...(network.startsWith("stellar") ? { extra: { areFeesSponsored: true } } : {}) })),
            signers: {},
          });
        }
        const body = raw ? JSON.parse(raw) : {};
        const verdict = await this.check(body);
        if (route === "/verify") {
          this.verifies.push(body);
          return send(200, verdict.ok ? { isValid: true, payer: verdict.payer } : { isValid: false, invalidReason: verdict.reason, payer: verdict.payer });
        }
        if (route === "/settle") {
          this.settles.push(body);
          if (!verdict.ok) return send(200, { success: false, errorReason: verdict.reason, transaction: "", network: body.paymentRequirements?.network ?? "", payer: verdict.payer });
          if (this.spent.has(verdict.replayKey)) {
            return send(200, { success: false, errorReason: "invalid_exact_stellar_payload_simulation_failed", transaction: "", network: body.paymentRequirements.network, payer: verdict.payer });
          }
          this.spent.add(verdict.replayKey);
          return send(200, { success: true, transaction: "ab".repeat(32), network: body.paymentRequirements.network, payer: verdict.payer });
        }
        return send(404, { code: "NOT_FOUND" });
       } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `mock facilitator crashed: ${(e as Error).stack}` }));
       }
      })();
    });
  }

  async listen(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private async check(body: any): Promise<{ ok: true; payer: string; replayKey: string } | { ok: false; reason: string; payer?: string }> {
    const req = body?.paymentRequirements;
    const payload = body?.paymentPayload;
    if (body?.x402Version !== 2 || !req || !payload?.payload) return { ok: false, reason: "invalid_exact_payload_malformed" };
    const net = NETWORKS[req.network as keyof typeof NETWORKS];
    if (!net) return { ok: false, reason: "unsupported_network" };
    if (JSON.stringify(payload.accepted) !== JSON.stringify(req)) return { ok: false, reason: "accepted_requirements_mismatch" };

    if (net.family === "evm") {
      const a = payload.payload.authorization;
      const sig = payload.payload.signature;
      if (!a || !sig) return { ok: false, reason: "invalid_exact_evm_payload_malformed" };
      if (a.to.toLowerCase() !== req.payTo.toLowerCase()) return { ok: false, reason: "invalid_exact_evm_payload_recipient_mismatch", payer: a.from };
      if (a.value !== req.amount) return { ok: false, reason: "invalid_exact_evm_payload_authorization_value", payer: a.from };
      const now = Math.floor(Date.now() / 1000);
      if (Number(a.validBefore) < now + 6) return { ok: false, reason: "invalid_exact_evm_payload_authorization_valid_before", payer: a.from };
      if (Number(a.validAfter) > now) return { ok: false, reason: "invalid_exact_evm_payload_authorization_valid_after", payer: a.from };
      const recovered = await recoverTypedDataAddress({
        domain: { name: req.extra?.name, version: req.extra?.version, chainId: net.chainId, verifyingContract: req.asset },
        types: {
          TransferWithAuthorization: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" },
          ],
        },
        primaryType: "TransferWithAuthorization",
        message: { from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce },
        signature: sig,
      });
      if (recovered.toLowerCase() !== a.from.toLowerCase()) return { ok: false, reason: "invalid_exact_evm_payload_signature", payer: a.from };
      return { ok: true, payer: a.from, replayKey: `${req.network}:${a.from}:${a.nonce}` };
    }

    // Stellar: one invokeHostFunction `transfer(from, to, amount)` on the asset, payer's auth entry signed, envelope unsigned.
    let tx;
    try {
      tx = TransactionBuilder.fromXDR(payload.payload.transaction, net.passphrase);
    } catch {
      return { ok: false, reason: "invalid_exact_stellar_payload_malformed" };
    }
    if ((tx as any).signatures?.length) return { ok: false, reason: "invalid_exact_stellar_payload_has_envelope_signatures" };
    const ops = (tx as any).operations as any[];
    if (ops.length !== 1 || ops[0].type !== "invokeHostFunction") return { ok: false, reason: "invalid_exact_stellar_payload_wrong_operation" };
    const fn = member(ops[0].func, "value");
    if (str(member(fn, "functionName")) !== "transfer") return { ok: false, reason: "invalid_exact_stellar_payload_wrong_function_name" };
    if (addressOf(member(fn, "contractAddress")) !== req.asset) return { ok: false, reason: "invalid_exact_stellar_payload_wrong_asset" };
    const [from, to, amount] = (member(fn, "args") as any[]).map((a) => scValToNative(a));
    if (to !== req.payTo) return { ok: false, reason: "invalid_exact_stellar_payload_wrong_recipient", payer: from };
    if (String(amount) !== req.amount) return { ok: false, reason: "invalid_exact_stellar_payload_wrong_amount", payer: from };
    const auth = ops[0].auth as any[];
    if (!auth?.length) return { ok: false, reason: "invalid_exact_stellar_payload_missing_auth_entries", payer: from };
    const creds = member(auth[0], "credentials");
    const credKind = kindOf(creds);
    if (credKind !== "sorobanCredentialsAddress") return { ok: false, reason: `invalid_exact_stellar_payload_unsupported_credential_type:${credKind}`, payer: from };
    const credBody = member(creds, "value") ?? creds;
    if (addressOf(member(credBody, "address")) !== from) return { ok: false, reason: "invalid_exact_stellar_payload_missing_payer_auth", payer: from };
    if (kindOf(member(credBody, "signature")) === "scvVoid") return { ok: false, reason: "invalid_exact_stellar_payload_unsigned_auth_entry", payer: from };
    if ((member(member(auth[0], "rootInvocation"), "subInvocations") as any[]).length > 0) return { ok: false, reason: "invalid_exact_stellar_payload_has_subinvocations", payer: from };
    return { ok: true, payer: from, replayKey: `${req.network}:${from}:${String(member(credBody, "nonce"))}` };
  }
}

// stellar-sdk 17 exposes XDR members as properties; older majors as methods. Read either.
function member(o: any, name: string): any {
  const v = o?.[name];
  return typeof v === "function" ? v.call(o) : v;
}
function kindOf(o: any): string {
  return typeof o?.switch === "function" ? o.switch().name : String(o?.type ?? o?.tag ?? o?.switch);
}
function str(o: any): string {
  if (typeof o === "string") return o;
  if (o?.bytes) return Buffer.from(o.bytes).toString("utf8");
  return typeof o?.toString === "function" ? o.toString() : String(o);
}
function addressOf(sc: any): string {
  return Address.fromScAddress(sc).toString();
}
