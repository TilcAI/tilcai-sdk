import { randomUUID } from "node:crypto";
import { invalidInput, PaymentError } from "./errors.js";
import type { Http } from "./http.js";
import { resolveNetwork, type Environment, type NetworkAlias, type NetworkId } from "./networks.js";
import { isEvmAddress, isStellarAccount, isStellarContract } from "./strkey.js";
import type { CreatedDisbursement, Disbursement, VaultStatus } from "./types.js";

const enc = encodeURIComponent;

export interface DisburseInput {
  /** Which network's vault pays. Without it TilcAI uses its primary Avalanche vault. */
  network?: NetworkId | NetworkAlias | undefined;
  /** Recipient: `0x…` on EVM networks, `G…` or `C…` on Stellar. */
  to: string;
  /** Decimal USDC string. */
  amount: string;
  /** Your purchase id. One reference, one payout: a second request is refused while the first has not failed. */
  reference?: string | undefined;
  idempotencyKey?: string | undefined;
}

export interface WaitForDisbursementOptions {
  timeoutMs?: number;
  intervalMs?: number;
  signal?: AbortSignal;
}

/**
 * Payouts from TilcAI's on-chain vaults (TilcaiVault on EVM, tilcai_vault on Soroban): pay in USDC
 * a purchase that was collected off-chain. Operator keys only (`TILCAI_API_KEYS`).
 */
export class VaultApi {
  constructor(
    private readonly http: Http,
    private readonly environment: () => Environment,
  ) {}

  async status(network?: NetworkId | NetworkAlias): Promise<VaultStatus> {
    const n = network ? resolveNetwork(network, this.environment()).id : undefined;
    return (await this.http.request<{ vault: VaultStatus }>("GET", "/v1/vault", { query: { network: n } })).vault;
  }

  async disburse(input: DisburseInput): Promise<CreatedDisbursement> {
    const net = input.network ? resolveNetwork(input.network, this.environment()) : undefined;
    const evm = net ? net.family === "evm" : isEvmAddress(input.to);
    if (evm ? !isEvmAddress(input.to) : !(isStellarAccount(input.to) || isStellarContract(input.to))) {
      throw invalidInput(`to is not an address of ${net?.name ?? "the vault's network"}: ${input.to}`);
    }
    const { status, body } = await this.http.requestWithStatus<Omit<CreatedDisbursement, "replayed">>("POST", "/v1/vault/disbursements", {
      body: { ...(net ? { network: net.id } : {}), to: input.to, amount: input.amount, ...(input.reference ? { reference: input.reference } : {}) },
      idempotencyKey: input.idempotencyKey ?? randomUUID(),
    });
    return { ...body, replayed: status === 200 };
  }

  async get(id: string): Promise<{ disbursement: Disbursement; links: Record<string, unknown>; events: Array<Record<string, unknown>> }> {
    return this.http.request("GET", `/v1/vault/disbursements/${enc(id)}`);
  }

  async reconcile(id: string): Promise<Disbursement> {
    return (await this.http.request<{ disbursement: Disbursement }>("POST", `/v1/vault/disbursements/${enc(id)}/reconcile`, { body: {} })).disbursement;
  }

  /** Polls until CONFIRMED. FAILED throws; running out of time throws `uncertain` — never pay again before looking. */
  async waitForConfirmation(id: string, opts: WaitForDisbursementOptions = {}): Promise<Disbursement> {
    const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60_000);
    const interval = opts.intervalMs ?? 2000;
    for (;;) {
      if (opts.signal?.aborted) throw opts.signal.reason;
      const { disbursement: d } = await this.get(id);
      if (d.state === "CONFIRMED") return d;
      if (d.state === "FAILED") {
        throw new PaymentError({ status: 0, code: d.failureCode ?? "DISBURSEMENT_FAILED", message: `disbursement ${id} failed${d.lastError ? `: ${d.lastError}` : ""}`, recovery: "CONTACT_OPERATOR", payment: d });
      }
      if (Date.now() >= deadline) {
        throw new PaymentError({ status: 0, code: "WAIT_TIMEOUT", message: `disbursement ${id} is still ${d.state}`, recovery: "RECONCILE", payment: d, uncertain: true });
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  }
}
