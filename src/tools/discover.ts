import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hw } from "../api.js";
import { jsonResult } from "../util.js";

export function registerDiscoverTools(server: McpServer) {
  server.registerTool(
    "search_offers",
    {
      title: "Search the Hypawave public offer directory",
      description:
        "Browse opt-in public offers (data, APIs, compute, files) purchasable over Bitcoin Lightning. " +
        "Returns id, title, category, tags, output_type, input_schema, price, and payment_count " +
        "(settled-sales volume — NOT a trust or quality guarantee). Buy a result with buy_offer. " +
        "Note: many offers are private (agent-to-agent by direct offer_id) and never appear here.",
      inputSchema: {
        q: z.string().optional().describe("Free-text search over title/description"),
        category: z
          .enum(["data", "api", "compute", "media", "software", "access", "action", "other"])
          .optional(),
        tags: z.string().optional().describe("Comma-separated tags; results must match all"),
        sort: z.enum(["newest", "settled"]).optional().describe("Default newest"),
        limit: z.number().int().min(1).max(50).optional(),
        cursor: z.string().optional().describe("Pagination cursor from next_cursor (newest sort)"),
        offset: z.number().int().min(0).optional().describe("Pagination offset (settled sort)"),
      },
    },
    async (args) => jsonResult(await hw("/api/offers/public", { query: { ...args } }))
  );

  server.registerTool(
    "get_offer",
    {
      title: "Read a Hypawave offer's terms",
      description:
        "Fetch an offer's full terms before buying: amount, currency, pricing_type, description, " +
        "creator_pubkey, status, file_count, remaining capacity (max_payments vs payment_count), and metadata. " +
        "Always read and evaluate the terms before paying.",
      inputSchema: {
        offer_id: z.string().uuid().describe("The offer id"),
      },
    },
    async ({ offer_id }) => jsonResult(await hw(`/api/offers/${offer_id}`))
  );
}
