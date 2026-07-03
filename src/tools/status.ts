import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hw } from "../api.js";
import { jsonResult } from "../util.js";

export function registerStatusTools(server: McpServer) {
  server.registerTool(
    "my_offers",
    {
      title: "List your own offers (seller)",
      description:
        "List all offers created by this server's seller identity (pubkey-signed). " +
        "Shows each offer's status, capacity usage, and activation window — use manage_offer for details/renewal.",
      inputSchema: {
        status: z.string().optional().describe("Filter by offer status"),
      },
    },
    async ({ status }) =>
      jsonResult(await hw("/api/offers/list", { method: "GET", signed: true, query: { status } }))
  );

  server.registerTool(
    "list_sales",
    {
      title: "List your sales (seller reconciliation)",
      description:
        "List settled/pending sales for this seller identity (pubkey-signed). kind=offers → Path 3b payment " +
        "intents (via /api/offers/list-payments, filterable by offer_id); kind=invoices → Path 3a invoices " +
        "(via /api/offers/list-invoices). Returns payment_hash/preimage per sale — the authoritative way to " +
        "reconcile missed execution_webhook deliveries.",
      inputSchema: {
        kind: z.enum(["offers", "invoices"]),
        offer_id: z.string().uuid().optional().describe("Filter to one offer (kind=offers only)"),
        status: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    async ({ kind, offer_id, status, limit, offset }) => {
      const path = kind === "offers" ? "/api/offers/list-payments" : "/api/offers/list-invoices";
      return jsonResult(
        await hw(path, {
          method: "GET",
          signed: true,
          query: { status, limit, offset, ...(kind === "offers" ? { offer_id } : {}) },
        })
      );
    }
  );

  server.registerTool(
    "get_receipt",
    {
      title: "Fetch a settlement receipt for a past purchase",
      description:
        "Retrieve the durable settlement record for a purchase you made. For an offer purchase (Path 3b) pass " +
        "payment_intent_id + payer_secret (both returned by buy_offer). For an invoice (Path 2/3a) pass " +
        "invoice_id + preimage (pay_invoice returned the preimage).",
      inputSchema: {
        payment_intent_id: z.string().uuid().optional(),
        payer_secret: z.string().optional().describe("Required with payment_intent_id"),
        invoice_id: z.string().optional(),
        preimage: z
          .string()
          .regex(/^[0-9a-fA-F]{64}$/)
          .optional()
          .describe("Required with invoice_id"),
      },
    },
    async ({ payment_intent_id, payer_secret, invoice_id, preimage }) => {
      if (payment_intent_id) {
        if (!payer_secret) throw new Error("payer_secret is required with payment_intent_id");
        return jsonResult(
          await hw(`/api/offers/payment-intent/${payment_intent_id}/receipt`, { query: { secret: payer_secret } })
        );
      }
      if (invoice_id) {
        if (!preimage) throw new Error("preimage is required with invoice_id");
        return jsonResult(
          await hw(`/api/invoice/${invoice_id}/receipt`, { query: { preimage: preimage.toLowerCase() } })
        );
      }
      throw new Error("pass payment_intent_id+payer_secret (offer) or invoice_id+preimage (invoice)");
    }
  );

  server.registerTool(
    "check_payment",
    {
      title: "Check settlement/unlock status of a purchase",
      description:
        "Non-destructive status check. For an offer purchase (Path 3b) pass payment_intent_id + payer_secret — " +
        "returns status and the claim_token once settled. For invoices (Path 2/3a) pass invoice_ids — returns " +
        "unlock status per invoice.",
      inputSchema: {
        payment_intent_id: z.string().uuid().optional(),
        payer_secret: z.string().optional().describe("Required with payment_intent_id"),
        invoice_ids: z.array(z.string()).optional().describe("Invoice ids to check (Path 2/3a)"),
      },
    },
    async ({ payment_intent_id, payer_secret, invoice_ids }) => {
      if (payment_intent_id) {
        if (!payer_secret) throw new Error("payer_secret is required with payment_intent_id");
        return jsonResult(
          await hw(`/api/offers/payment-intent/${payment_intent_id}/status`, { query: { secret: payer_secret } })
        );
      }
      if (invoice_ids?.length) {
        return jsonResult(await hw("/api/get-unlock-status", { body: { invoice_ids } }));
      }
      throw new Error("pass payment_intent_id+payer_secret (offer) or invoice_ids (invoices)");
    }
  );
}
