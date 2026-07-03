#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerDiscoverTools } from "./tools/discover.js";
import { registerBuyTools } from "./tools/buy.js";
import { registerInvoiceBuyTools } from "./tools/invoice-buy.js";
import { registerSellTools } from "./tools/sell.js";
import { registerStatusTools } from "./tools/status.js";
import { registerWalletTools } from "./tools/wallet.js";

const server = new McpServer({
  name: "hypawave",
  version: "0.1.1",
});

registerDiscoverTools(server);
registerBuyTools(server);
registerInvoiceBuyTools(server);
registerSellTools(server);
registerStatusTools(server);
registerWalletTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
// stdio transport: stdout is the protocol channel; log to stderr only.
console.error("hypawave-mcp ready (15 tools; NWC " + (process.env.NWC_URL || process.env.HYPAWAVE_NWC_URL ? "configured" : "not configured — manual mode") + ")");
