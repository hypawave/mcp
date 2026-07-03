import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hw, isApiError } from "../api.js";
import { encryptFile } from "../crypto.js";
import { getPubKey } from "../config.js";
import { nwcConfigured, payBolt11 } from "../nwc.js";
import { assertWithinSpendCap, effectiveAmountSats, jsonResult, pollUntil } from "../util.js";

interface Activation {
  fee_bolt11: string;
  fee_payment_hash?: string;
  fee_amount_sats?: number;
  expires_at?: string;
  status?: string;
  terms_hash?: string;
}

/** Pay a Hypawave-issued activation/capacity fee bolt11 (any wallet works — no preimage needed by the server). */
async function payFee(bolt11: string, feeSats: number | undefined, context: string) {
  const amount = effectiveAmountSats(bolt11, feeSats);
  await assertWithinSpendCap(amount, context);
  await payBolt11(bolt11);
  return amount;
}

/**
 * Wait for a paid activation fee to be observed. `offers.status` is a
 * lifecycle column ('active' from creation) — real payability is
 * `activation_window_end`, stamped when the fee settlement lands. The LNbits
 * webhook fires once with no retry, so if it was missed we nudge the /pay
 * gate, whose polling fallback settles lazily.
 */
async function waitForActivation(offerId: string): Promise<{ activated: boolean; window_end: string | null }> {
  const windowEnd = async () => {
    const offer = await hw<{ activation_window_end?: string | null }>(`/api/offers/${offerId}`);
    const we = offer.activation_window_end ?? null;
    return we && new Date(we).getTime() > Date.now() ? we : null;
  };

  let we = await pollUntil(windowEnd, { timeoutMs: 20_000 });
  if (!we) {
    // Webhook likely missed — the /pay gate polls LNbits and settles in-band.
    await hw(`/api/offers/${offerId}/pay`, { body: {} }).catch(() => undefined);
    we = await pollUntil(windowEnd, { timeoutMs: 15_000 });
  }
  return { activated: Boolean(we), window_end: we };
}

export function registerSellTools(server: McpServer) {
  server.registerTool(
    "create_offer",
    {
      title: "Create a Hypawave offer (sell files/data/API/compute for Bitcoin)",
      description:
        "Create a reusable Path 3b offer sold over Lightning. Payments go creator-direct to your payment_destination " +
        "(a Lightning Address or LNURL-pay URL — any receiving wallet works; you need NO node and NO preimage support to sell). " +
        "The offer is inert until you pay the returned activation fee bolt11 (fee = unit_price × max_payments × fee% — " +
        "Hypawave's only charge; principal never touches Hypawave). Attach files with attach_file BEFORE the fee settles — " +
        "content is sealed at activation. Set pay_activation_fee=true to pay it automatically via NWC. " +
        "By default the offer is PRIVATE (share the offer_id directly, agent-to-agent). To list it in the public " +
        "marketplace, set is_public=true with title, category, and output_type (immutable after creation).",
      inputSchema: {
        amount: z.number().positive().describe("Price per sale, in sats (pricing_type=sats) or fiat units"),
        pricing_type: z.enum(["sats", "fiat"]),
        currency: z.string().optional().describe("Fiat currency code (e.g. USD) when pricing_type=fiat"),
        description: z.string().min(1).max(2000),
        payment_destination: z
          .string()
          .describe("YOUR payout destination: Lightning Address (name@domain) or LNURL-pay URL"),
        max_payments: z
          .number()
          .int()
          .positive()
          .describe("Unlock capacity N — how many times the offer can be bought (fee basis; immutable, extend via manage_offer add_capacity)"),
        activation_window: z.string().optional().describe('Payability window, e.g. "30d" (default), bounds 1d–365d'),
        execution_webhook: z
          .string()
          .url()
          .optional()
          .describe("HTTPS endpoint POSTed the settlement proof (for selling execution instead of files)"),
        metadata: z.record(z.unknown()).optional(),
        is_public: z.boolean().optional().describe("List in the public marketplace directory (default false = private)"),
        title: z.string().max(60).optional().describe("Required when is_public"),
        category: z
          .enum(["data", "api", "compute", "media", "software", "access", "action", "other"])
          .optional()
          .describe("Required when is_public"),
        output_type: z
          .enum(["file", "link", "json", "text", "image", "video", "audio", "stream", "webhook"])
          .optional()
          .describe("Required when is_public"),
        tags: z.array(z.string()).max(5).optional(),
        input_schema: z.union([z.string(), z.record(z.unknown())]).optional(),
        pay_activation_fee: z
          .boolean()
          .optional()
          .describe("Pay the activation fee automatically via NWC (default false). Attach files first if the offer has any!"),
      },
    },
    async ({ pay_activation_fee, ...body }) => {
      const created = await hw<{ offer_id: string; activation?: Activation }>("/api/offers", {
        body: Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)),
        signed: true,
      });

      let feePaid: number | null = null;
      let activation: { activated: boolean; window_end: string | null } | null = null;
      if (pay_activation_fee && created.activation?.fee_bolt11) {
        if (!nwcConfigured()) throw new Error("pay_activation_fee=true but no NWC wallet configured");
        feePaid = await payFee(
          created.activation.fee_bolt11,
          created.activation.fee_amount_sats,
          `activation fee for offer ${created.offer_id}`
        );
        activation = await waitForActivation(created.offer_id);
      }

      return jsonResult({
        ...created,
        seller_pubkey: getPubKey(),
        activation_fee_paid_sats: feePaid,
        activated: activation?.activated ?? false,
        activation_window_end: activation?.window_end ?? null,
        next: !pay_activation_fee
          ? "Offer is INERT until the activation fee_bolt11 is paid (any wallet, no preimage needed). Attach files first via attach_file, then pay the fee."
          : activation?.activated
            ? "Offer is ACTIVE and payable. Share the offer_id (private) — public offers appear in search_offers."
            : "Fee paid but settlement not yet observed — check later with manage_offer action=status (activation_window_end set = active).",
      });
    }
  );

  server.registerTool(
    "attach_file",
    {
      title: "Encrypt and attach a local file to an offer or invoice",
      description:
        "Encrypts a local file client-side (AES-256-GCM — Hypawave never sees plaintext), uploads the ciphertext, " +
        "and registers the file + key with its ciphertext_sha256 content commitment. MUST run before the " +
        "activation fee settles — content is sealed at activation. The presigned upload URL lasts 120s. " +
        "Pass offer_id (Path 3b) or invoice_id (Path 3a), not both.",
      inputSchema: {
        offer_id: z.string().uuid().optional(),
        invoice_id: z.string().optional(),
        file_path: z.string().describe("Absolute path of the plaintext file to sell"),
        content_type: z.string().optional().describe("MIME type (default application/octet-stream)"),
      },
    },
    async ({ offer_id, invoice_id, file_path, content_type }) => {
      if (!offer_id === !invoice_id) throw new Error("pass exactly one of offer_id or invoice_id");
      const plaintext = readFileSync(file_path);
      const fileName = basename(file_path);
      const mime = content_type || "application/octet-stream";
      const enc = encryptFile(plaintext);

      const { signedUrl, objectKey } = await hw<{ signedUrl: string; objectKey: string }>(
        "/api/offers/upload-url",
        { body: { fileName, contentType: mime, fileSize: enc.ciphertext.length }, signed: true }
      );
      const put = await fetch(signedUrl, {
        method: "PUT",
        headers: { "Content-Type": mime },
        body: new Uint8Array(enc.ciphertext),
      });
      if (!put.ok) throw new Error(`upload failed: HTTP ${put.status} (presigned URL expires after 120s — retry attach_file)`);

      if (offer_id) {
        const stored = await hw<{ offer_file_id: string }>("/api/offers/store-file", {
          body: {
            offer_id,
            storage_key: objectKey,
            filename: fileName,
            size: enc.ciphertext.length,
            content_type: mime,
            iv_hex: enc.ivHex,
            ciphertext_sha256: enc.ciphertextSha256,
          },
          signed: true,
        });
        await hw("/api/offers/store-file-key", {
          body: { offer_file_id: stored.offer_file_id, wrapped_key: enc.keyB64 },
          signed: true,
        });
        return jsonResult({
          ok: true,
          offer_id,
          offer_file_id: stored.offer_file_id,
          plaintext_bytes: plaintext.length,
          ciphertext_sha256: enc.ciphertextSha256,
        });
      }

      const stored = await hw<{ id: string }>("/api/offers/store-invoice-file", {
        body: {
          invoice_id,
          file_name: fileName,
          encrypted_file_url: objectKey,
          iv_hex: enc.ivHex,
          size: enc.ciphertext.length,
          ciphertext_sha256: enc.ciphertextSha256,
        },
        signed: true,
      });
      await hw("/api/offers/invoice-file-key", {
        body: { invoice_file_id: stored.id, key_b64: enc.keyB64 },
        signed: true,
      });
      return jsonResult({
        ok: true,
        invoice_id,
        invoice_file_id: stored.id,
        plaintext_bytes: plaintext.length,
        ciphertext_sha256: enc.ciphertextSha256,
      });
    }
  );

  server.registerTool(
    "manage_offer",
    {
      title: "Manage an offer: status / renew / add capacity / deactivate",
      description:
        "status: read the offer (activation state, payments sold vs max_payments, window end). " +
        "renew: mint a fresh activation fee bolt11 after the window lapsed (402 offer_inactive on pay). " +
        "add_capacity: buy M more unlock slots (returns a capacity fee bolt11). " +
        "delete: deactivate the offer permanently. " +
        "Fee bolt11s are paid automatically via NWC when pay_fee=true, otherwise returned for manual payment (any wallet).",
      inputSchema: {
        offer_id: z.string().uuid(),
        action: z.enum(["status", "renew", "add_capacity", "delete"]),
        add_capacity: z.number().int().positive().optional().describe("Slots to add (action=add_capacity)"),
        activation_window: z.string().optional().describe('New window for renew, e.g. "30d"'),
        pay_fee: z.boolean().optional().describe("Pay the returned fee bolt11 automatically via NWC"),
      },
    },
    async ({ offer_id, action, add_capacity, activation_window, pay_fee }) => {
      if (action === "status") {
        return jsonResult(await hw(`/api/offers/${offer_id}`));
      }
      if (action === "delete") {
        return jsonResult(await hw(`/api/offers/${offer_id}`, { method: "DELETE", body: null, signed: true }));
      }

      let result: Record<string, unknown>;
      let fee: Activation | undefined;
      if (action === "renew") {
        try {
          result = await hw(`/api/offers/${offer_id}/renew`, {
            body: activation_window ? { activation_window } : {},
            signed: true,
          });
          fee = result.activation as Activation | undefined;
        } catch (e) {
          if (isApiError(e, "activation_not_needed")) {
            return jsonResult({ ok: true, message: "activation window still live — no renewal needed", detail: e.message });
          }
          throw e;
        }
      } else {
        if (!add_capacity) throw new Error("add_capacity (positive integer) is required for action=add_capacity");
        result = await hw(`/api/offers/${offer_id}/add-capacity`, {
          body: { add_capacity },
          signed: true,
        });
        fee = (result.topup ?? result.activation) as Activation | undefined;
      }

      let feePaid: number | null = null;
      let activation: { activated: boolean; window_end: string | null } | null = null;
      if (pay_fee && fee?.fee_bolt11) {
        if (!nwcConfigured()) throw new Error("pay_fee=true but no NWC wallet configured");
        feePaid = await payFee(fee.fee_bolt11, fee.fee_amount_sats, `${action} fee for offer ${offer_id}`);
        if (action === "renew") activation = await waitForActivation(offer_id);
      }

      return jsonResult({
        ...result,
        fee_paid_sats: feePaid,
        ...(activation ? { activated: activation.activated, activation_window_end: activation.window_end } : {}),
      });
    }
  );

  server.registerTool(
    "create_invoice",
    {
      title: "Create a one-off Hypawave invoice (Path 3a seller)",
      description:
        "Create a single-settlement invoice: one buyer pays once, creator-direct to your payment_destination. " +
        "Returns the buyer payload (invoice_id + access_token — forward BOTH to the buyer, who settles it with " +
        "pay_invoice) plus an activation fee bolt11 that must be paid before the invoice goes live. " +
        "Attach a file first with attach_file(invoice_id=...) if selling a file — content seals at activation.",
      inputSchema: {
        amount: z.number().positive(),
        currency: z.string().optional().describe("Default USD"),
        description: z.string().optional(),
        payment_destination: z.string().describe("YOUR Lightning Address or LNURL-pay URL"),
        due_date: z.string().describe("ISO date the invoice is due, e.g. 2026-07-31"),
        client_email: z.string().email().describe("Buyer contact email (required by the API)"),
        client_first_name: z.string(),
        client_last_name: z.string(),
        company_name: z.string().optional(),
        expires_in: z.enum(["1h", "24h", "7d"]).optional(),
        execution_webhook: z.string().url().optional(),
        pay_activation_fee: z.boolean().optional().describe("Pay the activation fee automatically via NWC (attach files first!)"),
      },
    },
    async ({ pay_activation_fee, ...body }) => {
      const created = await hw<{ invoice_id: string; access_token: string; activation?: Activation }>(
        "/api/offers/create-invoice",
        { body: Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)), signed: true }
      );

      let feePaid: number | null = null;
      if (pay_activation_fee && created.activation?.fee_bolt11) {
        if (!nwcConfigured()) throw new Error("pay_activation_fee=true but no NWC wallet configured");
        feePaid = await payFee(
          created.activation.fee_bolt11,
          created.activation.fee_amount_sats,
          `activation fee for invoice ${created.invoice_id}`
        );
      }

      return jsonResult({
        ...created,
        activation_fee_paid_sats: feePaid,
        next: pay_activation_fee
          ? "Fee paid — once settled the invoice is live. Forward {invoice_id, access_token} to the buyer."
          : "Invoice is INERT until the activation fee_bolt11 is paid (any wallet). Attach files first if needed, pay the fee, then forward {invoice_id, access_token} to the buyer.",
      });
    }
  );
}
