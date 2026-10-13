# Changelog

## 0.1.0 — 2026-10-13

Primera versión.

- Cliente de la API v1 de TilcAI (`Tilcai`): `health`, `routes`, `verifyEnvironment`, reintentos con `Idempotency-Key`, errores tipados con el envelope `tilcai-shared-v1`.
- Pagos crosschain USDC desde Avalanche (Fuji y C-Chain) y Monad Testnet hacia Stellar (CCTP V2): modos `gasless`, `account` y `external`; `pay()` de extremo a extremo con comprobación de lo que se firma, `wait()` con incertidumbre explícita.
- Emisión de cuentas inteligentes (SCA) con passkey (EVM y Stellar) o Ed25519 (Stellar); utilidades para claves públicas WebAuthn (SPKI, COSE, punto crudo) y aserciones.
- x402 v2 `exact` en Avalanche, Monad y Stellar: cliente del facilitador, payloads EVM (EIP-3009) y Stellar (auth entry Soroban), `x402Fetch` para comprar y `Paywall` (Express y Web Fetch) para vender.
- Vault de desembolsos, eventos y recursos del monitor (con flujo SSE reanudable) y estado del relayer.
- `tilcai-sdk/core`: contratos de `tilcai-core` (IDs, estados, errores, política, intents, mandates, aprobaciones).
- `EvmRelayer`: envía llamadas a contratos por un relayer EVM de TilcAI (la cuenta del relayer es `msg.sender` y paga el gas), con espera de confirmación y errores tipados; para contratos que autentican por una firma en el calldata.
- `SoftwarePasskey`: passkey en memoria para agentes y pruebas, con aserciones que la cuenta acepta igual que las de un navegador.
- Verificado en testnet con fondos reales (`npm run live`, `npm run e2e:wallet`, `npm run e2e:sca`) y con servidores simulados (`npm test`).
