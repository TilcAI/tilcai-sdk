/**
 * Pays USDC from Monad (or Avalanche) to a Stellar address. The payer's wallet signs one EIP-3009
 * message; TilcAI's relayer pays the gas on both chains and the USDC arrives via CCTP V2.
 *
 *   TILCAI_API_URL=… TILCAI_API_KEY=… PAYER_PRIVATE_KEY=0x… PAY_TO=G… npx tsx examples/pay-from-monad.ts
 */
import { Tilcai, evmSignerFromPrivateKey } from "tilcai-sdk";

const tilcai = Tilcai.fromEnv();
await tilcai.verifyEnvironment();

const signer = await evmSignerFromPrivateKey(process.env.PAYER_PRIVATE_KEY as `0x${string}`);
const { quote, view } = await tilcai.payments.pay({
  from: (process.env.FROM as "avalanche" | "monad" | undefined) ?? "monad",
  amount: "0.05",
  payTo: process.env.PAY_TO!,
  signer,
  orderId: `order-${Date.now()}`,
  approve: (q) => {
    console.log(`about to burn ${q.burn.amount} USDC on ${q.route.source}; recipient gets ${q.destination.amount} on ${q.route.destination}`);
    return true;
  },
  wait: { onUpdate: (v) => console.log(`  ${v.payment.state}`) },
});

console.log("settled", { quote: quote.id, burn: view.links.burn, mint: view.links.mint });
