/**
 * Sells an HTTP resource for USDC on three networks at once with x402. The buyer picks the
 * network it can pay on; TilcAI's relayer settles and sponsors the gas.
 */
import { createServer } from "node:http";
import { Paywall, X402Facilitator } from "tilcai-sdk/x402";

const paywall = new Paywall({
  facilitator: new X402Facilitator(), // TILCAI_RELAYER_URL + TILCAI_RELAYER_API_KEY
  resource: { description: "Daily market report", mimeType: "application/json" },
  accepts: [
    { network: "avalanche", amount: "0.05", payTo: process.env.EVM_PAY_TO! },
    { network: "monad", amount: "0.05", payTo: process.env.EVM_PAY_TO! },
    { network: "stellar", amount: "0.05", payTo: process.env.STELLAR_PAY_TO! },
  ],
});

// Web-standard handler: works as-is in Hono, Next.js route handlers, Bun, Deno and Workers.
export const handler = paywall.fetchHandler((_req, paid) =>
  Response.json({ report: "…", paidBy: paid.payer, tx: paid.settlement.transaction }),
);

// Express users: app.get("/report", paywall.express(), (req, res) => res.json({ report: "…" }));

createServer(async (req, res) => {
  const out = await handler(new Request(`http://${req.headers.host}${req.url}`, { headers: req.headers as Record<string, string> }));
  res.writeHead(out.status, Object.fromEntries(out.headers));
  res.end(Buffer.from(await out.arrayBuffer()));
}).listen(8402, () => console.log("x402 seller on :8402"));
