import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hw } from "../api.js";
import { decryptFile, verifyCommitment } from "../crypto.js";
import { nwcConfigured, payBolt11 } from "../nwc.js";
import { assertWithinSpendCap, effectiveAmountSats, jsonResult, pollUntil, safeFilename } from "../util.js";

interface PayOfferResponse {
  payment_intent_id: string;
  bolt11: string;
  payment_hash: string;
  locked_amount_sats: number;
  locked_currency: string;
  expires_at?: string;
  payer_secret: string;
}

interface IntentStatus {
  status: string;
  claim_token?: string;
  token_expires_at?: string;
}

interface OfferFileKey {
  offer_file_id: string;
  filename?: string;
  iv_hex: string;
  ciphertext_sha256?: string | null;
  wrapped_key: string;
}

async function confirmAndClaim(paymentIntentId: string, preimage: string, payerSecret: string) {
  const confirm = await hw(`/api/offers/payment-intent/${paymentIntentId}/confirm`, {
    body: { preimage, payer_secret: payerSecret },
  });
  const settled = await pollUntil<IntentStatus>(async () => {
    const s = await hw<IntentStatus>(`/api/offers/payment-intent/${paymentIntentId}/status`, {
      query: { secret: payerSecret },
    });
    return s.status === "settled" ? s : null;
  });
  return { confirm, settled };
}

export function registerBuyTools(server: McpServer) {
  server.registerTool(
    "buy_offer",
    {
      title: "Buy a Hypawave offer (pay over Lightning)",
      description:
        "Purchase an offer end-to-end. With an NWC wallet configured (NWC_URL): fetches a creator-direct bolt11, " +
        "enforces the operator spending cap, pays it, submits the settlement preimage, and polls until settled — " +
        "returns a claim_token for download_files (or, for execution offers, the preimage to present to the " +
        "seller's API as your credential). Without NWC: returns the bolt11 + payer_secret + payment_intent_id; " +
        "pay it with any preimage-returning wallet, then call confirm_payment. " +
        "SPENDS REAL BITCOIN — read the offer terms with get_offer first. Settlement is final; no refunds.",
      inputSchema: {
        offer_id: z.string().uuid(),
        expected_max_sats: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Refuse to pay if the quoted amount exceeds this (your own per-purchase bound, applied in addition to the operator cap)"
          ),
      },
    },
    async ({ offer_id, expected_max_sats }) => {
      const pay = await hw<PayOfferResponse>(`/api/offers/${offer_id}/pay`, { body: {} });
      const amount = effectiveAmountSats(pay.bolt11, pay.locked_amount_sats);

      if (expected_max_sats !== undefined && amount !== null && amount > expected_max_sats) {
        throw new Error(
          `quoted amount ${amount} sats exceeds your expected_max_sats (${expected_max_sats}) — not paid`
        );
      }

      if (!nwcConfigured()) {
        return jsonResult({
          mode: "manual",
          message:
            "No NWC wallet configured. Pay this bolt11 with any wallet that returns the preimage, then call confirm_payment with {payment_intent_id, preimage, payer_secret}.",
          payment_intent_id: pay.payment_intent_id,
          bolt11: pay.bolt11,
          amount_sats: amount,
          payer_secret: pay.payer_secret,
          expires_at: pay.expires_at,
        });
      }

      await assertWithinSpendCap(amount, `buy_offer ${offer_id}`);
      const { preimage } = await payBolt11(pay.bolt11);
      const { settled } = await confirmAndClaim(pay.payment_intent_id, preimage, pay.payer_secret);

      return jsonResult({
        ok: true,
        settled: Boolean(settled),
        payment_intent_id: pay.payment_intent_id,
        amount_sats: amount,
        claim_token: settled?.claim_token ?? null,
        claim_token_expires_at: settled?.token_expires_at ?? null,
        preimage,
        payer_secret: pay.payer_secret,
        next: !settled
          ? "Settlement not yet observed — poll confirm_payment or retry later with the same preimage (idempotent)."
          : settled.claim_token
            ? "File offer: call download_files with {payment_intent_id, claim_token}."
            : "Settled. No files on this offer (execution offer) — present {payment_intent_id, preimage} to the seller's API as your credential.",
      });
    }
  );

  server.registerTool(
    "confirm_payment",
    {
      title: "Confirm an offer payment with a preimage (manual mode)",
      description:
        "Submit the Lightning preimage as settlement proof for an offer purchase made outside NWC " +
        "(you paid the bolt11 from buy_offer manually). Idempotent — safe to retry. Returns the claim_token once settled.",
      inputSchema: {
        payment_intent_id: z.string().uuid(),
        preimage: z.string().regex(/^[0-9a-fA-F]{64}$/, "64-char hex preimage"),
        payer_secret: z.string().describe("payer_secret returned by buy_offer"),
      },
    },
    async ({ payment_intent_id, preimage, payer_secret }) => {
      const { settled } = await confirmAndClaim(payment_intent_id, preimage.toLowerCase(), payer_secret);
      return jsonResult({
        ok: true,
        settled: Boolean(settled),
        claim_token: settled?.claim_token ?? null,
        claim_token_expires_at: settled?.token_expires_at ?? null,
      });
    }
  );

  server.registerTool(
    "download_files",
    {
      title: "Download and decrypt purchased offer files",
      description:
        "After a settled purchase (buy_offer / confirm_payment returned a claim_token): fetches each file's key, " +
        "downloads the encrypted blob, verifies it against the seller's ciphertext_sha256 commitment, decrypts " +
        "(AES-256-GCM) locally, and writes plaintext files to output_dir. Returns the saved paths.",
      inputSchema: {
        payment_intent_id: z.string().uuid(),
        claim_token: z.string(),
        output_dir: z.string().describe("Absolute directory to save decrypted files into (created if missing)"),
      },
    },
    async ({ payment_intent_id, claim_token, output_dir }) => {
      const dir = resolve(output_dir);
      mkdirSync(dir, { recursive: true });

      const { files } = await hw<{ files: OfferFileKey[] }>(
        `/api/offers/payment-intent/${payment_intent_id}/file-key`,
        { query: { claim_token } }
      );
      if (!files?.length) {
        return jsonResult({ ok: true, files: [], message: "No files attached to this offer (execution-only offer?)" });
      }

      const saved = [];
      for (const f of files) {
        const { downloadUrl } = await hw<{ downloadUrl: string }>(
          `/api/offers/payment-intent/${payment_intent_id}/download-url`,
          { body: { offer_file_id: f.offer_file_id, claim_token } }
        );
        const res = await fetch(downloadUrl);
        if (!res.ok) throw new Error(`download failed for ${f.offer_file_id}: HTTP ${res.status}`);
        const ciphertext = Buffer.from(await res.arrayBuffer());
        verifyCommitment(ciphertext, f.ciphertext_sha256);
        const plaintext = decryptFile(ciphertext, f.wrapped_key, f.iv_hex);
        const path = join(dir, safeFilename(f.filename, `${f.offer_file_id}.bin`));
        writeFileSync(path, plaintext);
        saved.push({ path, bytes: plaintext.length, commitment_verified: Boolean(f.ciphertext_sha256) });
      }
      return jsonResult({ ok: true, files: saved });
    }
  );
}
