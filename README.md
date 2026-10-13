# tilcai-sdk

SDK de Node.js para usar las capacidades de [TilcAI](https://github.com/TilcAI) desde otros proyectos:

- **Pagos crosschain en USDC** desde **Avalanche** y **Monad** hacia **Stellar** (Circle CCTP V2), con gas patrocinado.
- **Emisión de cuentas inteligentes (SCA)** con passkey en Avalanche, Monad y Stellar.
- **x402**: cobrar y pagar recursos HTTP en USDC en las tres redes (comprador, vendedor y cliente del facilitador).
- **Vault de desembolsos** (pagar en cadena compras cobradas fuera de ella), **monitorización** de eventos y estado del relayer.
- **Contratos de `tilcai-core`** sin red: IDs, máquinas de estado, política determinista, intents, mandates y aprobaciones.

Cero dependencias en runtime. `viem` y `@stellar/stellar-sdk` son opcionales y solo se cargan cuando una función los necesita. ESM y CommonJS, con tipos.

```sh
npm install tilcai-sdk
npm install viem                 # firmar con una clave privada / wallet EVM
npm install @stellar/stellar-sdk # pagos x402 desde una cuenta Stellar
```

Requiere Node.js ≥ 18.17 y una instancia de [`tilcai-infrastructure`](https://github.com/TilcAI/tilcai-infrastructure) con una clave API.

## Empezar

```ts
import { Tilcai, evmSignerFromPrivateKey } from "tilcai-sdk";

const tilcai = new Tilcai({
  baseUrl: process.env.TILCAI_API_URL!,   // la instancia
  apiKey: process.env.TILCAI_API_KEY!,    // Bearer
  environment: "testnet",                 // o "mainnet"
});
await tilcai.verifyEnvironment();         // falla si la instancia sirve otro entorno

const signer = await evmSignerFromPrivateKey("0x…");

const { view } = await tilcai.payments.pay({
  from: "monad",                          // "avalanche" | "monad" (o un id CAIP-2)
  amount: "1.25",                         // USDC, cadena decimal
  payTo: "G…",                            // cuenta Stellar con trustline de USDC
  signer,                                 // la wallet firma una autorización EIP-3009; el relayer paga el gas
});
console.log(view.payment.state, view.links.burn, view.links.mint);   // SETTLED
```

`Tilcai.fromEnv()` lee `TILCAI_API_URL`, `TILCAI_API_KEY`, `TILCAI_NETWORK` (`testnet`|`mainnet`) y `TILCAI_TIMEOUT_MS`, los mismos nombres que [`tilcai-mcp`](https://github.com/TilcAI/tilcai-mcp).

## Redes

| Alias | Id CAIP-2 | Entorno | Rol | USDC | Dominio CCTP |
| --- | --- | --- | --- | --- | --- |
| `avalanche` | `eip155:43113` (Fuji) | testnet | origen | `0x5425…Bc65` · EIP-712 `USD Coin` | 1 |
| `avalanche` | `eip155:43114` (C-Chain) | mainnet | origen | `0xB97E…a6E` · EIP-712 `USD Coin` | 1 |
| `monad` | `eip155:10143` | testnet | origen | `0x534b…43A3` · EIP-712 **`USDC`** | 15 |
| `stellar` | `stellar:testnet` | testnet | destino | SAC `CBIE…QDAMA` (7 decimales) | 27 |
| `stellar` | `stellar:pubnet` | mainnet | destino | SAC `CCW6…MI75` (7 decimales) | 27 |

Monad solo existe en testnet. Un alias toma el entorno del cliente: `resolveNetwork("avalanche", "mainnet")` es C-Chain. El registro completo está en `NETWORKS`.

## Pagos crosschain

Un pago quema USDC en el origen, Circle atestigua y el `CctpForwarder` acuña en Stellar y reenvía al destinatario. `payments.pay()` hace el recorrido completo; los pasos sueltos están en `payments.quote / create / submitAuthorization / submitBurn / get / reconcile / wait`.

Tres modos, según quién firma:

```ts
// 1. gasless — una wallet EVM firma EIP-3009; el relayer paga el gas en las dos redes
await tilcai.payments.pay({ from: "avalanche", amount: "2", payTo, signer });

// 2. account — el pagador es una SCA emitida por TilcAI; su dueño firma con passkey
await tilcai.payments.pay({
  from: "monad", amount: "2", payTo,
  payer: account.address,
  passkey: async ({ challengeBase64Url }) => navigator.credentials.get({
    publicKey: { challenge: base64urlToBytes(challengeBase64Url), rpId, userVerification: "required" },
  }) as Promise<PublicKeyCredential>,   // se acepta la aserción tal cual la devuelve el navegador
});

// 3. external — la wallet difunde approve + burn y paga su gas
await tilcai.payments.pay({
  from: "avalanche", amount: "2", payTo, payer: wallet.address,
  sendTransaction: async (call) => (await wallet.sendTransaction({ to: call.to, data: call.data, value: BigInt(call.value) })).hash,
});
```

Lo que hace por ti, y por qué:

- **No firma nada que no sea este pago.** Antes de pedir la firma comprueba que el mensaje es de la cadena y el USDC de origen, que el remitente es el pagador, que el receptor es el router que TilcAI nombró y que el importe es exactamente el quemado cotizado (`UNSAFE_AUTHORIZATION` si algo no cuadra).
- **No paga a una cuenta que no recibiría los fondos.** Si el destinatario no tiene trustline de USDC lanza `RECIPIENT_NOT_READY` antes de crear nada (`allowUnreadyRecipient` lo omite).
- **`approve(quote)`** es la última palabra antes de firmar; devolver `false` detiene todo.
- **Idempotencia.** Cada creación lleva `Idempotency-Key` (la que pases en `idempotencyKey`, o una generada). Repetir la misma llamada devuelve el mismo pago (`replayed: true`); no hay un segundo burn.
- **Incertidumbre honesta.** `wait()` lanza `PaymentError` con `uncertain: true` si se agota el tiempo: el dinero puede estar en vuelo. Consulta con `payments.get(id)`; **no** crees otro pago. `FAILED` lanza `PaymentError` con `uncertain: false`.

Un `payTo` es una cuenta `G…` (o contrato `C…`) válida; el SDK comprueba el checksum antes de enviar. Una cotización respalda un solo intento de pago.

## Cuentas inteligentes (SCA)

TilcAI deriva la dirección de la clave pública del dueño, paga el despliegue y **nunca es firmante**. Necesita una clave de tercero con los scopes `accounts:write` y `accounts:read`.

```ts
import { passkeyOwner, ed25519Owner } from "tilcai-sdk";

const owner = passkeyOwner({
  publicKey: credential.response.getPublicKey(),   // SPKI DER, punto crudo de 65 bytes o COSE_Key
  credentialId: credential.rawId,
  rpId: "app.example.com",
});

const { account } = await tilcai.accounts.create({ network: "monad", externalRef: "user-1842", owner });
// account.address es definitiva y ya puede recibir fondos
await tilcai.accounts.waitForActive(account.id);   // ahora puede firmar
```

- `network`: `"avalanche"`, `"monad"` o `"stellar"`. Las cuentas EVM tienen como dueño una passkey; en Stellar también sirve una clave Ed25519 (`ed25519Owner("G…")`).
- Pedir lo mismo con la misma clave devuelve la misma cuenta. `accounts.get` y `accounts.list({ externalRef, network })` consultan.
- Una cuenta `ACTIVE` paga con `payments.pay({ passkey, payer: account.address })`.
- Para un agente o un servidor sin autenticador de persona, `SoftwarePasskey.generate({ rpId })` da un dueño (`.owner`) y firma los retos (`.assertion(challenge)`). Quien tenga esa clave controla la cuenta: para personas, usa una passkey de plataforma o de hardware.

## x402

TilcAI liquida x402 v2 (esquema `exact`) con el plugin facilitador de su OpenZeppelin Relayer, en Avalanche, Monad y Stellar. El facilitador es una API **distinta** de la de TilcAI: necesita la URL y la clave del relayer (`TILCAI_RELAYER_URL`, `TILCAI_RELAYER_API_KEY`).

```ts
import { Paywall, X402Facilitator, x402Fetch } from "tilcai-sdk/x402";
```

**Vender** (`Paywall`): arma el 402 con una red o varias, verifica con el facilitador y liquida antes de servir.

```ts
const paywall = new Paywall({
  facilitator: new X402Facilitator(),
  accepts: [
    { network: "avalanche", amount: "0.05", payTo: evmAddress },
    { network: "monad",     amount: "0.05", payTo: evmAddress },
    { network: "stellar",   amount: "0.05", payTo: stellarAddress },
  ],
});
app.get("/report", paywall.express(), (req, res) => res.json({ report: "…" }));      // Express / Connect
export const GET = paywall.fetchHandler(() => Response.json({ report: "…" }));       // Next.js, Hono, Bun, Deno, Workers
```

El facilitador siempre recibe **tus** requisitos, nunca los que el payload dice haber aceptado: un pagador no puede abaratar el precio editando `accepted`.

**Comprar** (`x402Fetch`): un `fetch` que paga.

```ts
const pay = x402Fetch({
  wallet: { evm: signer, stellar: "S…" },
  prefer: ["eip155:10143"],
  maxAmountAtomic: 100_000n,            // tope por llamada
  approve: (req) => confirm(`Pagar ${req.amount} en ${req.network}?`),
});
const res = await pay("https://api.example.com/report");
res.settlement;                         // { success, transaction, network, payer }
```

**Piezas sueltas**: `buildRequirements`, `createEvmPayload`, `createStellarPayload`, `X402Facilitator.supported / verify / settle`.

Detalles que importan:

- El dominio EIP-712 del token **difiere por red** (Fuji `USD Coin`, Monad `USDC`). `buildRequirements` lo rellena; con otro token hay que pasar `tokenName` y `tokenVersion`.
- En Stellar, el pagador solo firma la *auth entry* de Soroban; el sobre va sin firmas y el relayer paga la comisión. El SDK usa credenciales *legacy* (`authV2: false`), el formato con el que se probó el facilitador.
- Un rechazo de negocio **no** es un error HTTP: `verify` responde `isValid:false` y `settle` responde `success:false`, con 200. Lee el cuerpo.
- Si `settle` agota el tiempo (504), la transacción pudo salir: concilia por hash; **no** firmes un payload nuevo.

## Vault, monitorización y relayer

Solo con claves de operador (`TILCAI_API_KEYS` del servidor).

```ts
await tilcai.vault.status("stellar");                                   // saldo, topes, pausa, dueño, operador
const { disbursement } = await tilcai.vault.disburse({ network: "monad", to: "0x…", amount: "5", reference: "compra-42" });
await tilcai.vault.waitForConfirmation(disbursement.id);

await tilcai.monitor.events({ type: "vault.", after: 5500 });
for await (const e of tilcai.monitor.stream({ signal })) console.log(e.summary);   // SSE, reanuda solo
await tilcai.monitor.resources();                                       // proceso, base, colas, relayer, vault, alertas
await tilcai.relayer.status();                                          // x402 /supported y el relayer Stellar
```

## Llamadas a contratos por el relayer (`EvmRelayer`)

Para contratos que autentican por una firma dentro del calldata (el veredicto EIP-712 de un atestador, una autorización EIP-3009) y no por `msg.sender`: el relayer de TilcAI envía la llamada y paga el gas.

```ts
import { EvmRelayer } from "tilcai-sdk";

const relayer = new EvmRelayer({ url: RELAYER_URL, apiKey: RELAYER_API_KEY, relayerId: "monad-testnet-relayer" });
const { hash } = await relayer.sendAndWait({ to: escrow, data: encodeFunctionData({ abi, functionName: "resolve", args }) });
```

`waitForConfirmation` solo devuelve el hash cuando el relayer reporta `confirmed` (puede reemplazar la transacción); `failed`/`expired`/`canceled` lanzan `RelayerError`, y agotar el tiempo lo lanza con `uncertain: true`. Quien tenga la clave del relayer puede enviar cualquier llamada: guárdala en el servidor.

## Núcleo offline (`tilcai-sdk/core`)

Funciones puras reflejadas de `tilcai-core` (`tilcai-shared-v1`), sin red:

```ts
import { evaluateIntent, parseIntent, intentCommitment, canTransition, budgetResolution } from "tilcai-sdk/core";
```

`ALLOW` y una aprobación que coincide son **elegibilidad**, nunca autoridad para mover fondos. Estos contratos están, en `tilcai-core`, como propuesta pendiente de revisión del equipo.

## Errores

Todo fallo es un `TilcaiError` con `status` (0 si no llegó a salir una petición), `code`, `message`, `recovery` y `detail`. Las respuestas de la API conservan su envelope `tilcai-shared-v1`: `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `QUOTE_EXPIRED`, `IDEMPOTENCY_CONFLICT`, `DUPLICATE`, `BUDGET`, `PAYMENT_LIMIT`… `PaymentError` (con `uncertain`) y `X402Error` (con `reason`) lo extienden. `e.retryable` indica si repetir la misma petición tiene sentido; el cliente ya reintenta GET y POST con `Idempotency-Key` ante errores de red, 429 y 502–504 (`retries`, 2 por defecto).

## Verificación

Estado a **2026-10-13**, en testnet, con fondos reales (importes de 0.01 USDC). Todo lo marcado se comprobó contra la cadena (saldos, recibos y transferencias), no solo contra la respuesta de la API.

| Capacidad | Avalanche Fuji | Monad Testnet | Stellar Testnet |
| --- | --- | --- | --- |
| Pago crosschain *gasless* wallet EVM → cuenta Stellar, hasta `SETTLED` (CCTP V2) | ✔ | ✔ | recibe ✔ |
| Pago crosschain desde una SCA firmando con passkey (`account`), hasta `SETTLED` | ✔ | ✔ | recibe ✔ |
| Emisión de SCA y despliegue en cadena | ✔ | ✔ | ✔ passkey y ✔ dueño Ed25519 |
| Desembolso del vault a tus cuentas | ✔ | ✔ | ✔ |
| x402 `/settle` real: pagar y cobrar (ida y vuelta entre dos cuentas), `Transfer` verificado en el recibo | ✔ | ✔ | ✔ **XLM**, con tu clave Stellar, ida y vuelta (comisión del relayer, no del pagador) |
| x402 en USDC de Stellar (`/settle`) | — | — | ✘ el facilitador responde `unsupported_asset`: el SAC de USDC no está en la lista de activos del plugin |
| Cuenta Stellar de contrato (SCA) recibiendo fondos por x402 (`payTo = C…`) | — | — | ✔ XLM |
| x402 `/verify` con control negativo: un dominio EIP-712 equivocado da `invalid_exact_evm_payload_signature` | ✔ | ✔ | — |
| Cotización, preflight, typed data real firmado en local, llamadas `external`, estado del vault, monitor y relayer | ✔ | ✔ | ✔ |

Cuentas: una wallet EVM (la misma dirección en Fuji y Monad, con USDC y sin AVAX) y una cuenta Stellar con USDC. Tras todas las pruebas, los saldos cuadran exactamente con lo esperado (desembolsos − pagos crosschain − fondeo de las SCA + lo recibido en Stellar).

Sobre x402 en Stellar: el SDK construye y firma el payload de USDC igual que el de XLM, pero el relayer de la instancia de prueba solo tiene en la lista del plugin el activo nativo y el SAC de XLM. Para pagar USDC en Stellar hay que añadir `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` a `plugins[x402].config.networks[stellar:testnet].assets` en la configuración del relayer; `npm run e2e:wallet` lo ejercita (ida y vuelta) en cuanto esté.

No cubierto: **mainnet**; pagos *desde* Stellar hacia una red EVM (la ruta de TilcAI solo tiene a Stellar como destino); y la ruta pública de emisión de SCA contra la instancia compartida (la clave de operador no tiene los scopes `accounts:*`; se emitió contra una copia local de `tilcai-infrastructure` con el relayer y los contratos reales de testnet).

Los scripts que lo hicieron están en el repositorio. Los que mueven fondos son opt-in:

```sh
npm run live                  # solo lectura + intentos sin firmar: instancia, rutas, typed data, vault, monitor, x402 verify
npm run e2e:wallet            # envía y recibe USDC entre tus cuentas, x402 settle, vault (TEST_EVM_SECRET_KEY, TEST_STELLAR_ADDRESS y, opcional, TEST_STELLAR_SECRET_KEY)
npm run e2e:sca               # emite SCA en las tres redes, las fondea y paga desde ellas con passkey (necesita una clave de tercero)
```

## Seguridad

- El SDK **nunca maneja claves**: firma a través del `EvmSigner` o del signer Stellar que le des (una cuenta viem, una wallet, un KMS).
- Una clave API es un secreto; no la incluyas en código de navegador. En frontend usa tu backend como intermediario.
- Los contratos de TilcAI no están auditados (ver `tilcai-infrastructure`). En mainnet, comprueba `transactionsEnabled` en `health()`.
- Un pago liquidado prueba el **pago**, no la entrega: la confirmación comercial es otro evento.

## Desarrollo

```sh
npm install
npm test            # 75 pruebas, sin red: servidor TilcAI y facilitador x402 simulados
npm run typecheck
npm run build       # ESM + CJS + .d.ts con tsup
npm run smoke       # empaqueta, instala el tarball en un proyecto vacío y lo carga en ESM y CJS
```

`prepublishOnly` encadena typecheck, tests, build y smoke.

## Licencia

MIT
