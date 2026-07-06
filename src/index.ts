#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerDiscoverTools } from "./tools/discover.js";
import { registerBuyTools } from "./tools/buy.js";
import { registerInvoiceBuyTools } from "./tools/invoice-buy.js";
import { registerSellTools } from "./tools/sell.js";
import { registerSetupWalletTools } from "./tools/setup-wallet.js";
import { registerStatusTools } from "./tools/status.js";
import { registerWalletTools } from "./tools/wallet.js";
import { getNwcSource } from "./config.js";

const server = new McpServer({
  name: "hypawave",
  version: "0.2.0",
});

registerDiscoverTools(server);
registerBuyTools(server);
registerInvoiceBuyTools(server);
registerSellTools(server);
registerStatusTools(server);
registerWalletTools(server);
registerSetupWalletTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
// stdio transport: stdout is the protocol channel; log to stderr only.
const nwcSource = getNwcSource();
console.error(
  "hypawave-mcp ready (16 tools; NWC " +
    (nwcSource ? `configured via ${nwcSource}` : "not configured — manual mode; setup_wallet available") +
    ")"
);
