/** Follows TilcAI's event log live (the same feed the dashboard in tilcai-web renders). Operator key only. */
import { Tilcai } from "tilcai-sdk";

const tilcai = Tilcai.fromEnv();
const stop = new AbortController();
process.on("SIGINT", () => stop.abort());

for await (const e of tilcai.monitor.stream({ signal: stop.signal })) {
  console.log(`#${e.seq} ${e.severity.padEnd(7)} ${e.type.padEnd(34)} ${e.summary}`);
}
