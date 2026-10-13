/**
 * Pays out a purchase that was collected off-chain (a QR, a bank transfer) from TilcAI's vault.
 * Operator key only. One `reference` pays once; the contract itself refuses a second payout for it.
 */
import { Tilcai } from "tilcai-sdk";

const tilcai = Tilcai.fromEnv();
const vault = await tilcai.vault.status("monad");
console.log(`vault ${vault.address}: ${vault.balance} USDC, ${vault.availableToday} available today${vault.paused ? " (PAUSED)" : ""}`);

const { disbursement } = await tilcai.vault.disburse({
  network: "monad",
  to: process.env.BUYER_ADDRESS!,
  amount: "5",
  reference: "purchase-2026-0042",
  idempotencyKey: "purchase-2026-0042", // safe to retry the whole call
});
const done = await tilcai.vault.waitForConfirmation(disbursement.id);
console.log("paid", done.txHash);
