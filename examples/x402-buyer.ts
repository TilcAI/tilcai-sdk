/**
 * `fetch` that pays. On an HTTP 402 it signs once, retries with PAYMENT-SIGNATURE and hands back
 * the settlement. The wallet holds one signer per network family; `prefer` orders the choice.
 */
import { evmSignerFromPrivateKey } from "tilcai-sdk";
import { x402Fetch } from "tilcai-sdk/x402";

const pay = x402Fetch({
  wallet: {
    evm: await evmSignerFromPrivateKey(process.env.PAYER_PRIVATE_KEY as `0x${string}`),
    stellar: process.env.STELLAR_SECRET, // optional S… key
  },
  prefer: ["eip155:10143", "stellar:testnet"],
  maxAmountAtomic: 100_000n, // never pay more than 0.10 USDC per call
  approve: (req) => {
    console.log(`paying ${req.amount} atomic units on ${req.network} to ${req.payTo}`);
    return true;
  },
});

const res = await pay("http://localhost:8402/report");
console.log(res.status, await res.json(), res.settlement);
