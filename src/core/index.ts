/**
 * Offline building blocks of TilcAI's agent commerce, mirrored from `tilcai-core` (pure functions,
 * no network): shared IDs, state machines and error catalog (`tilcai-shared-v1`), the
 * deterministic policy decision, and intents, mandates and approval bindings with their commitment.
 *
 * `ALLOW` and a matching approval binding are *eligibility*, never authority to move funds.
 */
export * from "./contracts.js";
export * from "./authority.js";
export * from "./policy.js";
