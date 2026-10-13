import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** Just enough Soroban RPC for payload building: `getLatestLedger`. */
export class MockSorobanRpc {
  readonly server: Server;
  url = "";
  ledger = 1_234_567;

  constructor() {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const rpc = JSON.parse(raw || "{}");
        res.writeHead(200, { "content-type": "application/json" });
        const result = rpc.method === "getLatestLedger" ? { id: "x", protocolVersion: 23, sequence: this.ledger } : {};
        res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
      });
    });
  }

  async listen(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}
