import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hw } from "../api.js";
import { decryptFile, paymentHashFromPreimage, verifyCommitment } from "../crypto.js";
import { nwcConfigured, payBolt11 } from "../nwc.js";
import { assertWithinSpendCap, effectiveAmountSats, jsonResult, safeFilename } from "../util.js";

interface InvoiceFileRecord {
  id: string;
  file_name: string;
}

interface GetKeyResponse {
  encryption_key: string; // base64 raw AES key
  iv_hex: string;
  ciphertext_sha256?: string | null;
}

async function retrieveInvoiceFiles(invoiceId: string, token: string, outputDir: string) {
  const dir = resolve(outputDir);
  mkdirSync(dir, { recursive: true });

  const { files } = await hw<{ files: Record<string, InvoiceFileRecord[]> }>("/api/get-invoice-files", {
    body: { invoice_ids: [invoiceId], token },
  });
  const records = Object.values(files ?? {}).flat();
  const saved = [];
  for (const f of records) {
    const key = await hw<GetKeyResponse>("/api/get-key", {
      query: { invoice_file_id: f.id, token },
    });
    const { downloadUrl } = await hw<{ downloadUrl: string }>("/api/generate-download-url", {
      body: { invoice_file_id: f.id, token },
    });
    const res = await fetch(downloadUrl);
    if (!res.ok) throw new Error(`download failed for ${f.id}: HTTP ${res.status}`);
    const ciphertext = Buffer.from(await res.arrayBuffer());
    verifyCommitment(ciphertext, key.ciphertext_sha256);
    const plaintext = decryptFile(ciphertext, key.encryption_key, key.iv_hex);
    const path = join(dir, safeFilename(f.file_name, `${f.id}.bin`));
    writeFileSync(path, plaintext);
    saved.push({ path, bytes: plaintext.length, commitment_verified: Boolean(key.ciphertext_sha256) });
  }
  return saved;
}

export function registerInvoiceBuyTools(server: McpServer) {
  server.registerTool(
    "pay_invoice",
    {
      title: "Pay a Hypawave invoice payload (Path 2/3a buyer)",
      description:
        "Settle a one-off Hypawave invoice a seller handed you (a payload with invoice_id + access_token). " +
        "With NWC configured: fetches the creator-direct bolt11, enforces the spending cap, pays, confirms with " +
        "the preimage, then downloads + verifies + decrypts any attached files to output_dir. Without NWC: " +
        "returns the bolt11 — pay it manually, then re-call this tool with the preimage to confirm and fetch files. " +
        "SPENDS REAL BITCOIN. Settlement is final; no refunds.",
      inputSchema: {
        invoice_id: z.string().describe("Invoice id from the seller's payment payload"),
        access_token: z.string().describe("access_token from the seller's payment payload"),
        preimage: z
          .string()
          .regex(/^[0-9a-fA-F]{64}$/)
          .optional()
          .describe("Only for manual mode: the preimage from paying the bolt11 yourself"),
        output_dir: z
          .string()
          .optional()
          .describe("Absolute directory for decrypted files (default: skip file retrieval)"),
        expected_max_sats: z.number().int().positive().optional().describe("Refuse if the bolt11 exceeds this"),
      },
    },
    async ({ invoice_id, access_token, preimage, output_dir, expected_max_sats }) => {
      let settledPreimage = preimage?.toLowerCase();

      if (!settledPreimage) {
        const cb = await hw<{ pr: string; terms_hash?: string }>("/api/paystream-cb", {
          query: { token: access_token },
        });
        const amount = effectiveAmountSats(cb.pr);
        if (expected_max_sats !== undefined && amount !== null && amount > expected_max_sats) {
          throw new Error(`bolt11 amount ${amount} sats exceeds expected_max_sats (${expected_max_sats}) — not paid`);
        }
        if (!nwcConfigured()) {
          return jsonResult({
            mode: "manual",
            message:
              "No NWC wallet configured. Pay this bolt11 with a preimage-returning wallet, then call pay_invoice again with the preimage.",
            invoice_id,
            bolt11: cb.pr,
            amount_sats: amount,
            terms_hash: cb.terms_hash,
          });
        }
        await assertWithinSpendCap(amount, `pay_invoice ${invoice_id}`);
        settledPreimage = (await payBolt11(cb.pr)).preimage;
      }

      const paymentHash = paymentHashFromPreimage(settledPreimage);
      const confirm = await hw(`/api/invoice/${invoice_id}/confirm`, {
        body: { payment_hash: paymentHash, preimage: settledPreimage },
      });

      const files = output_dir ? await retrieveInvoiceFiles(invoice_id, access_token, output_dir) : undefined;
      return jsonResult({
        ok: true,
        invoice_id,
        confirm,
        preimage: settledPreimage,
        files: files ?? "not retrieved — pass output_dir to download and decrypt attached files",
      });
    }
  );
}
