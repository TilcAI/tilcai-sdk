import { AccountsApi } from "./accounts.js";
import { TilcaiError } from "./errors.js";
import { Http, type FetchLike } from "./http.js";
import { MonitorApi, RelayerApi } from "./monitor.js";
import { SOURCE_NETWORKS, type Environment, type EvmNetworkId } from "./networks.js";
import { PaymentsApi } from "./payments.js";
import type { Health, Route } from "./types.js";
import { VaultApi } from "./vault.js";

export interface TilcaiOptions {
  /** Base URL of a tilcai-infrastructure instance, e.g. `https://api.example.com`. Defaults to `TILCAI_API_URL`. */
  baseUrl?: string;
  /** Bearer key: an operator key, or a tenant key with the scopes `payments`, `accounts:read`, `accounts:write`. */
  apiKey?: string;
  /** Which TilcAI environment this client expects. Aliases like `"avalanche"` resolve against it. Default `testnet`. */
  environment?: Environment;
  /** Per-request timeout. Default 20 s. */
  timeoutMs?: number;
  /** Extra attempts for GETs and idempotency-keyed POSTs on network errors, 429 and 502–504. Default 2. */
  retries?: number;
  /** Custom `fetch` (proxies, tests). Defaults to the global one. */
  fetch?: FetchLike;
  /** Headers added to every request. */
  headers?: Record<string, string>;
}

/**
 * Client of the TilcAI API v1.
 *
 *     const tilcai = new Tilcai({ baseUrl, apiKey });
 *     await tilcai.payments.pay({ from: "monad", amount: "1.25", payTo: "G…", signer });
 */
export class Tilcai {
  readonly environment: Environment;
  readonly payments: PaymentsApi;
  readonly accounts: AccountsApi;
  readonly vault: VaultApi;
  readonly monitor: MonitorApi;
  readonly relayer: RelayerApi;
  private readonly http: Http;

  constructor(options: TilcaiOptions = {}) {
    const baseUrl = (options.baseUrl ?? process.env.TILCAI_API_URL ?? "").trim().replace(/\/+$/, "");
    if (!baseUrl) {
      throw new TilcaiError({ status: 0, code: "NO_BASE_URL", message: "baseUrl is required (or set TILCAI_API_URL)", recovery: "FIX_REQUEST" });
    }
    if (!/^https?:\/\//.test(baseUrl)) {
      throw new TilcaiError({ status: 0, code: "INVALID_INPUT", message: `baseUrl must be http(s), got ${baseUrl}`, recovery: "FIX_REQUEST" });
    }
    this.environment = options.environment ?? "testnet";
    this.http = new Http({
      baseUrl,
      apiKey: options.apiKey ?? process.env.TILCAI_API_KEY,
      timeoutMs: options.timeoutMs ?? 20_000,
      retries: options.retries ?? 2,
      fetch: options.fetch ?? ((input, init) => fetch(input, init)),
      headers: options.headers,
    });
    const env = () => this.environment;
    this.payments = new PaymentsApi(this.http, env);
    this.accounts = new AccountsApi(this.http, env);
    this.vault = new VaultApi(this.http, env);
    this.monitor = new MonitorApi(this.http);
    this.relayer = new RelayerApi(this.http);
  }

  /** Reads `TILCAI_API_URL`, `TILCAI_API_KEY`, `TILCAI_NETWORK` (`testnet`|`mainnet`) and `TILCAI_TIMEOUT_MS`, like tilcai-mcp. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env, overrides: TilcaiOptions = {}): Tilcai {
    const network = (env.TILCAI_NETWORK ?? "testnet").trim().toLowerCase();
    if (network !== "testnet" && network !== "mainnet") {
      throw new TilcaiError({ status: 0, code: "INVALID_INPUT", message: `TILCAI_NETWORK must be "testnet" or "mainnet", got "${env.TILCAI_NETWORK}"`, recovery: "FIX_REQUEST" });
    }
    return new Tilcai({
      ...(env.TILCAI_API_URL ? { baseUrl: env.TILCAI_API_URL } : {}),
      ...(env.TILCAI_API_KEY ? { apiKey: env.TILCAI_API_KEY } : {}),
      ...(env.TILCAI_TIMEOUT_MS ? { timeoutMs: Number(env.TILCAI_TIMEOUT_MS) } : {}),
      environment: network,
      ...overrides,
    });
  }

  get baseUrl(): string {
    return this.http.baseUrl;
  }

  /** Open route: instance state, relayer and which networks, vaults and account issuance are on. */
  health(): Promise<Health> {
    return this.http.request("GET", "/health", { auth: false });
  }

  /** Throws `ENVIRONMENT_MISMATCH` when the instance serves another environment than this client expects. */
  async verifyEnvironment(): Promise<Health> {
    const h = await this.health();
    if (h.env !== this.environment) {
      throw new TilcaiError({
        status: 0,
        code: "ENVIRONMENT_MISMATCH",
        message: `this client expects ${this.environment} but ${this.baseUrl} serves ${h.env}`,
        recovery: "FIX_REQUEST",
      });
    }
    return h;
  }

  /** One route per source network the instance serves, with the payment modes each supports. */
  async routes(): Promise<Route[]> {
    return (await this.http.request<{ routes: Route[] }>("GET", "/v1/routes")).routes;
  }

  /** The source networks the instance offers, in the order it lists them. */
  async sourceNetworks(): Promise<EvmNetworkId[]> {
    const known = new Set<string>(SOURCE_NETWORKS[this.environment]);
    return (await this.routes()).map((r) => r.source.network).filter((n): n is EvmNetworkId => known.has(n));
  }
}
