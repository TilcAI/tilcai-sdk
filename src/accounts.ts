import { randomUUID } from "node:crypto";
import { invalidInput, TilcaiError } from "./errors.js";
import type { Http } from "./http.js";
import { isStellarNetwork, resolveNetwork, type Environment, type NetworkAlias, type NetworkId } from "./networks.js";
import type { AccountView, CreatedAccount, OwnerCredential, SmartAccount } from "./types.js";

const enc = encodeURIComponent;

export interface CreateAccountInput {
  /** Where the account lives: an EVM source (`"avalanche"`, `"monad"`) or `"stellar"`. */
  network: NetworkId | NetworkAlias;
  /** Your id for the holder (a user id). With the owner and your tenant it fixes the address: asking twice returns the same account. */
  externalRef: string;
  /** The holder's credential: `passkeyOwner(...)` (EVM and Stellar) or `ed25519Owner(...)` (Stellar). Public material only. */
  owner: OwnerCredential;
  idempotencyKey?: string | undefined;
}

export interface WaitForAccountOptions {
  timeoutMs?: number;
  intervalMs?: number;
  signal?: AbortSignal;
}

/**
 * Smart-account (SCA) issuance. TilcAI derives the address from the holder's public key, pays the
 * deployment and is never a signer of an account it issues. Needs a tenant key with the scopes
 * `accounts:write` (create) and `accounts:read` (get, list).
 */
export class AccountsApi {
  constructor(
    private readonly http: Http,
    private readonly environment: () => Environment,
  ) {}

  /** Issues an account. The address is final when this returns and can already receive funds; it signs once ACTIVE. */
  async create(input: CreateAccountInput): Promise<CreatedAccount> {
    const net = resolveNetwork(input.network, this.environment());
    if (!input.externalRef || input.externalRef.length > 128) throw invalidInput("externalRef must be 1–128 characters");
    if (!isStellarNetwork(net) && input.owner.kind !== "webauthn-p256") {
      throw invalidInput(`${net.name} accounts are owned by a passkey (webauthn-p256); ed25519 owners are for Stellar`);
    }
    const { status, body } = await this.http.requestWithStatus<Omit<CreatedAccount, "replayed">>("POST", "/v1/accounts", {
      body: { network: net.id, externalRef: input.externalRef, owner: input.owner },
      idempotencyKey: input.idempotencyKey ?? randomUUID(),
    });
    return { ...body, replayed: status === 200 };
  }

  get(accountId: string): Promise<AccountView> {
    return this.http.request<AccountView>("GET", `/v1/accounts/${enc(accountId)}`);
  }

  async list(filter: { network?: NetworkId | NetworkAlias; externalRef?: string; limit?: number } = {}): Promise<SmartAccount[]> {
    const network = filter.network ? resolveNetwork(filter.network, this.environment()).id : undefined;
    const r = await this.http.request<{ accounts: SmartAccount[] }>("GET", "/v1/accounts", {
      query: { network, externalRef: filter.externalRef, limit: filter.limit },
    });
    return r.accounts;
  }

  /** Polls until the account is ACTIVE (deployed, able to sign). Throws if its deployment failed. */
  async waitForActive(accountId: string, opts: WaitForAccountOptions = {}): Promise<AccountView> {
    const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60_000);
    const interval = opts.intervalMs ?? 2000;
    for (;;) {
      if (opts.signal?.aborted) throw opts.signal.reason;
      const view = await this.get(accountId);
      if (view.account.state === "ACTIVE") return view;
      if (view.account.state === "FAILED") {
        throw new TilcaiError({ status: 0, code: "ACCOUNT_FAILED", message: `account ${accountId} failed to deploy${view.account.lastError ? `: ${view.account.lastError}` : ""}`, recovery: "CONTACT_OPERATOR" });
      }
      if (Date.now() >= deadline) {
        throw new TilcaiError({ status: 0, code: "WAIT_TIMEOUT", message: `account ${accountId} is still ${view.account.state}`, recovery: "RETRY_READ" });
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  }
}
