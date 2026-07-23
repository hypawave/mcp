#!/usr/bin/env node

// src/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// src/tools/discover.ts
import { z } from "zod";

// src/config.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex } from "@noble/hashes/utils";
var API_BASE = process.env.HYPAWAVE_API_URL || "https://hypawave.com";
var FALLBACK_SPEND_CAP_SATS = 5e4;
var KEY_DIR = join(homedir(), ".hypawave");
var KEY_FILE = join(KEY_DIR, "identity.json");
var WALLET_FILE = join(KEY_DIR, "wallet.json");
function getNwcUrl() {
  return process.env.NWC_URL || process.env.HYPAWAVE_NWC_URL || readWalletFile()?.nwc_url;
}
function getNwcSource() {
  if (process.env.NWC_URL || process.env.HYPAWAVE_NWC_URL) return "env";
  if (readWalletFile()) return "wallet_file";
  return null;
}
function readWalletFile() {
  try {
    if (!existsSync(WALLET_FILE)) return void 0;
    const parsed = JSON.parse(readFileSync(WALLET_FILE, "utf8"));
    if (typeof parsed?.nwc_url === "string" && parsed.nwc_url.startsWith("nostr+walletconnect://")) {
      return parsed;
    }
  } catch {
  }
  return void 0;
}
function saveWalletFile(wallet) {
  mkdirSync(KEY_DIR, { recursive: true, mode: 448 });
  writeFileSync(WALLET_FILE, JSON.stringify(wallet, null, 2), { mode: 384 });
  return WALLET_FILE;
}
function walletFileExists() {
  return existsSync(WALLET_FILE);
}
function walletFilePath() {
  return WALLET_FILE;
}
function getMaxSpendSatsEnv() {
  const raw = process.env.HYPAWAVE_MAX_SPEND_SATS;
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}
function getPrivKey() {
  const env = process.env.HYPAWAVE_PRIVKEY;
  if (env) {
    if (!/^[0-9a-fA-F]{64}$/.test(env)) {
      throw new Error("HYPAWAVE_PRIVKEY must be a 32-byte hex string (64 chars)");
    }
    return env.toLowerCase();
  }
  if (existsSync(KEY_FILE)) {
    const saved = JSON.parse(readFileSync(KEY_FILE, "utf8"));
    if (typeof saved.privkey === "string" && /^[0-9a-f]{64}$/.test(saved.privkey)) {
      return saved.privkey;
    }
    throw new Error(`Corrupt identity file at ${KEY_FILE} \u2014 restore it or set $HYPAWAVE_PRIVKEY`);
  }
  const privkey = generatePrivKey();
  mkdirSync(KEY_DIR, { recursive: true, mode: 448 });
  writeFileSync(KEY_FILE, JSON.stringify({ privkey, created_at: (/* @__PURE__ */ new Date()).toISOString() }, null, 2), {
    mode: 384
  });
  return privkey;
}
function getPubKey() {
  return bytesToHex(secp256k1.getPublicKey(getPrivKey(), true));
}
function generatePrivKey() {
  for (; ; ) {
    const candidate = randomBytes(32);
    try {
      secp256k1.getPublicKey(candidate, true);
      return bytesToHex(candidate);
    } catch {
    }
  }
}

// src/signer.ts
import { createHash, randomBytes as randomBytes2 } from "crypto";
import { secp256k1 as secp256k12 } from "@noble/curves/secp256k1";
import { bytesToHex as bytesToHex2, hexToBytes } from "@noble/hashes/utils";
var sha256Hex = (input) => createHash("sha256").update(input).digest("hex");
function signRequest({
  body,
  privKey,
  timestamp,
  nonce
}) {
  const pubKey = bytesToHex2(secp256k12.getPublicKey(privKey, true));
  let fullBody = body;
  let termsHash = null;
  if (body) {
    termsHash = sha256Hex(JSON.stringify(body));
    const termsSig = secp256k12.sign(hexToBytes(termsHash), privKey, { lowS: true });
    fullBody = { ...body, signed_payload_hash: termsHash, signature: termsSig.toDERHex() };
  }
  const bodyStr = fullBody ? JSON.stringify(fullBody) : "";
  const bodyHash = sha256Hex(bodyStr);
  const ts = timestamp ?? Math.floor(Date.now() / 1e3).toString();
  const nce = nonce ?? randomBytes2(16).toString("hex");
  const canonicalHash = sha256Hex(`${bodyHash}:${ts}:${nce}`);
  const authSig = secp256k12.sign(hexToBytes(canonicalHash), privKey, { lowS: true });
  return {
    headers: {
      "Content-Type": "application/json",
      "x-pubkey": pubKey,
      "x-signature": authSig.toDERHex(),
      "x-signed-payload-hash": bodyHash,
      "x-timestamp": ts,
      "x-nonce": nce
    },
    body: bodyStr || void 0,
    debug: { pubKey, termsHash, bodyHash, canonicalHash }
  };
}

// src/api.ts
var HypawaveApiError = class extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "HypawaveApiError";
  }
  status;
  code;
};
async function hw(path, opts = {}) {
  const method = opts.method ?? (opts.body !== void 0 ? "POST" : "GET");
  const url = new URL(path, API_BASE);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== void 0) url.searchParams.set(k, String(v));
  }
  let headers = { "Content-Type": "application/json" };
  let bodyStr;
  if (opts.signed) {
    const signed = signRequest({ body: opts.body ?? null, privKey: getPrivKey() });
    headers = signed.headers;
    bodyStr = signed.body;
  } else if (opts.body !== void 0 && opts.body !== null) {
    bodyStr = JSON.stringify(opts.body);
  }
  const res = await fetch(url, { method, headers, body: bodyStr });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : void 0;
  } catch {
    json = void 0;
  }
  if (!res.ok) {
    const code = json?.error || `http_${res.status}`;
    const message = json?.message || text.slice(0, 300) || res.statusText;
    throw new HypawaveApiError(res.status, code, message);
  }
  return json ?? {};
}
function isApiError(e, code) {
  return e instanceof HypawaveApiError && (code === void 0 || e.code === code);
}

// src/util.ts
import { basename } from "path";

// src/bolt11.ts
var HRP_RE = /^ln(?:bcrt|tbs|tb|bc)(\d+)([munp]?)1/i;
var MULTIPLIER_SATS = {
  // 1 BTC = 1e8 sats; m=1e-3 BTC, u=1e-6, n=1e-9, p=1e-12
  "": 1e8,
  m: 1e5,
  u: 100,
  n: 0.1,
  p: 1e-4
};
function bolt11AmountSats(bolt11) {
  const m = HRP_RE.exec(bolt11.trim());
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  return Math.ceil(value * MULTIPLIER_SATS[m[2].toLowerCase()]);
}

// src/util.ts
var cachedDerivedCap = null;
var DERIVED_CAP_TTL_MS = 5 * 6e4;
async function getSpendCapSats() {
  const envCap = getMaxSpendSatsEnv();
  if (envCap !== null) return { cap: envCap, source: "HYPAWAVE_MAX_SPEND_SATS" };
  if (cachedDerivedCap && Date.now() - cachedDerivedCap.fetchedAt < DERIVED_CAP_TTL_MS) {
    return { cap: cachedDerivedCap.value, source: "platform max_invoice_usd (cached)" };
  }
  try {
    const s = await hw("/api/public-settings");
    if (s.max_invoice_usd && s.btc_usd_price && s.btc_usd_price > 0) {
      const cap = Math.ceil(s.max_invoice_usd / s.btc_usd_price * 1e8);
      cachedDerivedCap = { value: cap, fetchedAt: Date.now() };
      return { cap, source: `platform max_invoice_usd ($${s.max_invoice_usd} @ $${s.btc_usd_price}/BTC)` };
    }
  } catch {
  }
  return { cap: FALLBACK_SPEND_CAP_SATS, source: "static fallback (platform settings unreachable)" };
}
async function assertWithinSpendCap(amountSats, context) {
  if (amountSats === null) {
    throw new Error(
      `${context}: could not determine the invoice amount \u2014 refusing to auto-pay. Pay manually and use confirm_payment.`
    );
  }
  const { cap, source } = await getSpendCapSats();
  if (amountSats > cap) {
    throw new Error(
      `${context}: amount ${amountSats} sats exceeds the spending cap of ${cap} sats (${source}). Not paid. Raise HYPAWAVE_MAX_SPEND_SATS or pay manually and use confirm_payment.`
    );
  }
}
function effectiveAmountSats(bolt11, quotedSats) {
  const decoded = bolt11AmountSats(bolt11);
  if (decoded !== null && quotedSats !== void 0 && Math.abs(decoded - quotedSats) > 1) {
    throw new Error(
      `bolt11 amount (${decoded} sats) does not match the quoted amount (${quotedSats} sats) \u2014 refusing to pay`
    );
  }
  return decoded ?? quotedSats ?? null;
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pollUntil(fn, { timeoutMs = 6e4, intervalMs = 2500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (; ; ) {
    const result = await fn();
    if (result !== null) return result;
    if (Date.now() + intervalMs > deadline) return null;
    await sleep(intervalMs);
  }
}
function safeFilename(name, fallback) {
  const base = basename(name || "").replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (!base || base === "." || base === "..") return fallback;
  return base;
}
function jsonResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// src/tools/discover.ts
function registerDiscoverTools(server2) {
  server2.registerTool(
    "search_offers",
    {
      title: "Search the Hypawave public offer directory",
      description: "Browse opt-in public offers (data, APIs, compute, files) purchasable over Bitcoin Lightning. Returns id, title, category, tags, output_type, input_schema, price, and payment_count (settled-sales volume \u2014 NOT a trust or quality guarantee). Buy a result with buy_offer. Note: many offers are private (agent-to-agent by direct offer_id) and never appear here.",
      inputSchema: {
        q: z.string().optional().describe("Free-text search over title/description"),
        category: z.enum(["data", "api", "compute", "media", "software", "access", "action", "other"]).optional(),
        tags: z.string().optional().describe("Comma-separated tags; results must match all"),
        sort: z.enum(["newest", "settled"]).optional().describe("Default newest"),
        limit: z.number().int().min(1).max(50).optional(),
        cursor: z.string().optional().describe("Pagination cursor from next_cursor (newest sort)"),
        offset: z.number().int().min(0).optional().describe("Pagination offset (settled sort)")
      }
    },
    async (args) => jsonResult(await hw("/api/offers/public", { query: { ...args } }))
  );
  server2.registerTool(
    "get_offer",
    {
      title: "Read a Hypawave offer's terms",
      description: "Fetch an offer's full terms before buying: amount, currency, pricing_type, description, creator_pubkey, status, file_count, remaining capacity (max_payments vs payment_count), and metadata. Always read and evaluate the terms before paying.",
      inputSchema: {
        offer_id: z.string().uuid().describe("The offer id")
      }
    },
    async ({ offer_id }) => jsonResult(await hw(`/api/offers/${offer_id}`))
  );
}

// src/tools/buy.ts
import { mkdirSync as mkdirSync2, writeFileSync as writeFileSync2 } from "fs";
import { join as join2, resolve } from "path";
import { z as z2 } from "zod";

// src/crypto.ts
import { createCipheriv, createDecipheriv, createHash as createHash2, randomBytes as randomBytes3 } from "crypto";
function sha256HexOf(data) {
  return createHash2("sha256").update(data).digest("hex");
}
function encryptFile(plaintext) {
  const key = randomBytes3(32);
  const iv = randomBytes3(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return {
    ciphertext,
    keyB64: key.toString("base64"),
    ivHex: iv.toString("hex"),
    ciphertextSha256: sha256HexOf(ciphertext)
  };
}
function decryptFile(ciphertext, keyB64, ivHex) {
  if (ciphertext.length < 16) throw new Error("ciphertext too short \u2014 missing GCM auth tag");
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) throw new Error("encryption key must be 32 bytes (AES-256)");
  const iv = Buffer.from(ivHex, "hex");
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const data = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}
function verifyCommitment(ciphertext, expectedSha256) {
  if (!expectedSha256) return;
  const actual = sha256HexOf(ciphertext);
  if (actual !== expectedSha256.toLowerCase()) {
    throw new Error(
      `content mismatch \u2014 downloaded bytes (sha256 ${actual}) do not match the seller's commitment (${expectedSha256}); aborting before decrypt`
    );
  }
}
function paymentHashFromPreimage(preimageHex) {
  if (!/^[0-9a-fA-F]{64}$/.test(preimageHex)) {
    throw new Error("preimage must be a 32-byte hex string (64 chars)");
  }
  return createHash2("sha256").update(Buffer.from(preimageHex, "hex")).digest("hex");
}

// src/nwc.ts
var clientPromise = null;
function nwcConfigured() {
  return Boolean(getNwcUrl());
}
async function getClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const url = getNwcUrl();
      if (!url) throw new Error("NWC_URL is not set \u2014 wallet payments unavailable (manual mode only)");
      if (typeof globalThis.WebSocket === "undefined") {
        const ws = await import("ws");
        globalThis.WebSocket = ws.default;
      }
      const { nwc } = await import("@getalby/sdk");
      return new nwc.NWCClient({ nostrWalletConnectUrl: url });
    })();
    clientPromise.catch(() => {
      clientPromise = null;
    });
  }
  return clientPromise;
}
async function payBolt11(bolt11) {
  const client = await getClient();
  let result;
  try {
    result = await client.payInvoice({ invoice: bolt11 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/insufficient|balance|not enough|exceeds.*budget|quota/i.test(msg)) {
      throw new Error(
        `${msg} \u2014 the agent wallet balance is too low. Call setup_wallet {action:"funding_options", amount_sats:<needed>} and present the funding options to your operator.`
      );
    }
    throw e;
  }
  if (!result?.preimage || !/^[0-9a-fA-F]{64}$/.test(result.preimage)) {
    throw new Error(
      "wallet paid (or attempted) but returned no valid preimage \u2014 cannot prove settlement; check the payment in your wallet before retrying"
    );
  }
  return { preimage: result.preimage.toLowerCase() };
}
async function getBalanceSats() {
  const client = await getClient();
  const { balance } = await client.getBalance();
  return Math.floor(balance / 1e3);
}

// src/tools/buy.ts
async function confirmAndClaim(paymentIntentId, preimage, payerSecret) {
  const confirm = await hw(`/api/offers/payment-intent/${paymentIntentId}/confirm`, {
    body: { preimage, payer_secret: payerSecret }
  });
  const settled = await pollUntil(async () => {
    const s = await hw(`/api/offers/payment-intent/${paymentIntentId}/status`, {
      query: { secret: payerSecret }
    });
    return s.status === "settled" ? s : null;
  });
  return { confirm, settled };
}
function registerBuyTools(server2) {
  server2.registerTool(
    "buy_offer",
    {
      title: "Buy a Hypawave offer (pay over Lightning)",
      description: "Purchase an offer end-to-end. With an NWC wallet configured (NWC_URL): fetches a creator-direct bolt11, enforces the operator spending cap, pays it, submits the settlement preimage, and polls until settled \u2014 returns a claim_token for download_files (or, for execution offers, the preimage to present to the seller's API as your credential). Without NWC: returns the bolt11 + payer_secret + payment_intent_id; pay it with any preimage-returning wallet, then call confirm_payment. SPENDS REAL BITCOIN \u2014 read the offer terms with get_offer first. Settlement is final; no refunds.",
      inputSchema: {
        offer_id: z2.string().uuid(),
        expected_max_sats: z2.number().int().positive().optional().describe(
          "Refuse to pay if the quoted amount exceeds this (your own per-purchase bound, applied in addition to the operator cap)"
        )
      }
    },
    async ({ offer_id, expected_max_sats }) => {
      const pay = await hw(`/api/offers/${offer_id}/pay`, { body: {} });
      const amount = effectiveAmountSats(pay.bolt11, pay.locked_amount_sats);
      if (expected_max_sats !== void 0 && amount !== null && amount > expected_max_sats) {
        throw new Error(
          `quoted amount ${amount} sats exceeds your expected_max_sats (${expected_max_sats}) \u2014 not paid`
        );
      }
      if (!nwcConfigured()) {
        return jsonResult({
          mode: "manual",
          message: "No NWC wallet configured. Pay this bolt11 with any wallet that returns the preimage, then call confirm_payment with {payment_intent_id, preimage, payer_secret}.",
          payment_intent_id: pay.payment_intent_id,
          bolt11: pay.bolt11,
          amount_sats: amount,
          payer_secret: pay.payer_secret,
          expires_at: pay.expires_at
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
        next: !settled ? "Settlement not yet observed \u2014 poll confirm_payment or retry later with the same preimage (idempotent)." : settled.claim_token ? "File offer: call download_files with {payment_intent_id, claim_token}." : "Settled. No files on this offer (execution offer) \u2014 present {payment_intent_id, preimage} to the seller's API as your credential."
      });
    }
  );
  server2.registerTool(
    "confirm_payment",
    {
      title: "Confirm an offer payment with a preimage (manual mode)",
      description: "Submit the Lightning preimage as settlement proof for an offer purchase made outside NWC (you paid the bolt11 from buy_offer manually). Idempotent \u2014 safe to retry. Returns the claim_token once settled.",
      inputSchema: {
        payment_intent_id: z2.string().uuid(),
        preimage: z2.string().regex(/^[0-9a-fA-F]{64}$/, "64-char hex preimage"),
        payer_secret: z2.string().describe("payer_secret returned by buy_offer")
      }
    },
    async ({ payment_intent_id, preimage, payer_secret }) => {
      const { settled } = await confirmAndClaim(payment_intent_id, preimage.toLowerCase(), payer_secret);
      return jsonResult({
        ok: true,
        settled: Boolean(settled),
        claim_token: settled?.claim_token ?? null,
        claim_token_expires_at: settled?.token_expires_at ?? null
      });
    }
  );
  server2.registerTool(
    "download_files",
    {
      title: "Download and decrypt purchased offer files",
      description: "After a settled purchase (buy_offer / confirm_payment returned a claim_token): fetches each file's key, downloads the encrypted blob, verifies it against the seller's ciphertext_sha256 commitment, decrypts (AES-256-GCM) locally, and writes plaintext files to output_dir. Returns the saved paths.",
      inputSchema: {
        payment_intent_id: z2.string().uuid(),
        claim_token: z2.string(),
        output_dir: z2.string().describe("Absolute directory to save decrypted files into (created if missing)")
      }
    },
    async ({ payment_intent_id, claim_token, output_dir }) => {
      const dir = resolve(output_dir);
      mkdirSync2(dir, { recursive: true });
      const { files } = await hw(
        `/api/offers/payment-intent/${payment_intent_id}/file-key`,
        { query: { claim_token } }
      );
      if (!files?.length) {
        return jsonResult({ ok: true, files: [], message: "No files attached to this offer (execution-only offer?)" });
      }
      const saved = [];
      for (const f of files) {
        const { downloadUrl } = await hw(
          `/api/offers/payment-intent/${payment_intent_id}/download-url`,
          { body: { offer_file_id: f.offer_file_id, claim_token } }
        );
        const res = await fetch(downloadUrl);
        if (!res.ok) throw new Error(`download failed for ${f.offer_file_id}: HTTP ${res.status}`);
        const ciphertext = Buffer.from(await res.arrayBuffer());
        verifyCommitment(ciphertext, f.ciphertext_sha256);
        const plaintext = decryptFile(ciphertext, f.wrapped_key, f.iv_hex);
        const path = join2(dir, safeFilename(f.filename, `${f.offer_file_id}.bin`));
        writeFileSync2(path, plaintext);
        saved.push({ path, bytes: plaintext.length, commitment_verified: Boolean(f.ciphertext_sha256) });
      }
      return jsonResult({ ok: true, files: saved });
    }
  );
}

// src/tools/invoice-buy.ts
import { mkdirSync as mkdirSync3, writeFileSync as writeFileSync3 } from "fs";
import { join as join3, resolve as resolve2 } from "path";
import { z as z3 } from "zod";
async function retrieveInvoiceFiles(invoiceId, token, outputDir) {
  const dir = resolve2(outputDir);
  mkdirSync3(dir, { recursive: true });
  const { files } = await hw("/api/get-invoice-files", {
    body: { invoice_ids: [invoiceId], token }
  });
  const records = Object.values(files ?? {}).flat();
  const saved = [];
  for (const f of records) {
    const key = await hw("/api/get-key", {
      query: { invoice_file_id: f.id, token }
    });
    const { downloadUrl } = await hw("/api/generate-download-url", {
      body: { invoice_file_id: f.id, token }
    });
    const res = await fetch(downloadUrl);
    if (!res.ok) throw new Error(`download failed for ${f.id}: HTTP ${res.status}`);
    const ciphertext = Buffer.from(await res.arrayBuffer());
    verifyCommitment(ciphertext, key.ciphertext_sha256);
    const plaintext = decryptFile(ciphertext, key.encryption_key, key.iv_hex);
    const path = join3(dir, safeFilename(f.file_name, `${f.id}.bin`));
    writeFileSync3(path, plaintext);
    saved.push({ path, bytes: plaintext.length, commitment_verified: Boolean(key.ciphertext_sha256) });
  }
  return saved;
}
function registerInvoiceBuyTools(server2) {
  server2.registerTool(
    "pay_invoice",
    {
      title: "Pay a Hypawave invoice payload (Path 2/3a buyer)",
      description: "Settle a one-off Hypawave invoice a seller handed you (a payload with invoice_id + access_token). With NWC configured: fetches the creator-direct bolt11, enforces the spending cap, pays, confirms with the preimage, then downloads + verifies + decrypts any attached files to output_dir. Without NWC: returns the bolt11 \u2014 pay it manually, then re-call this tool with the preimage to confirm and fetch files. SPENDS REAL BITCOIN. Settlement is final; no refunds.",
      inputSchema: {
        invoice_id: z3.string().describe("Invoice id from the seller's payment payload"),
        access_token: z3.string().describe("access_token from the seller's payment payload"),
        preimage: z3.string().regex(/^[0-9a-fA-F]{64}$/).optional().describe("Only for manual mode: the preimage from paying the bolt11 yourself"),
        output_dir: z3.string().optional().describe("Absolute directory for decrypted files (default: skip file retrieval)"),
        expected_max_sats: z3.number().int().positive().optional().describe("Refuse if the bolt11 exceeds this")
      }
    },
    async ({ invoice_id, access_token, preimage, output_dir, expected_max_sats }) => {
      let settledPreimage = preimage?.toLowerCase();
      if (!settledPreimage) {
        const cb = await hw("/api/paystream-cb", {
          query: { token: access_token }
        });
        const amount = effectiveAmountSats(cb.pr);
        if (expected_max_sats !== void 0 && amount !== null && amount > expected_max_sats) {
          throw new Error(`bolt11 amount ${amount} sats exceeds expected_max_sats (${expected_max_sats}) \u2014 not paid`);
        }
        if (!nwcConfigured()) {
          return jsonResult({
            mode: "manual",
            message: "No NWC wallet configured. Pay this bolt11 with a preimage-returning wallet, then call pay_invoice again with the preimage.",
            invoice_id,
            bolt11: cb.pr,
            amount_sats: amount,
            terms_hash: cb.terms_hash
          });
        }
        await assertWithinSpendCap(amount, `pay_invoice ${invoice_id}`);
        settledPreimage = (await payBolt11(cb.pr)).preimage;
      }
      const paymentHash = paymentHashFromPreimage(settledPreimage);
      const confirm = await hw(`/api/invoice/${invoice_id}/confirm`, {
        body: { payment_hash: paymentHash, preimage: settledPreimage }
      });
      const files = output_dir ? await retrieveInvoiceFiles(invoice_id, access_token, output_dir) : void 0;
      return jsonResult({
        ok: true,
        invoice_id,
        confirm,
        preimage: settledPreimage,
        files: files ?? "not retrieved \u2014 pass output_dir to download and decrypt attached files"
      });
    }
  );
}

// src/tools/sell.ts
import { readFileSync as readFileSync2 } from "fs";
import { basename as basename2 } from "path";
import { z as z4 } from "zod";
async function payFee(bolt11, feeSats, context) {
  const amount = effectiveAmountSats(bolt11, feeSats);
  await assertWithinSpendCap(amount, context);
  await payBolt11(bolt11);
  return amount;
}
async function waitForActivation(offerId) {
  const windowEnd = async () => {
    const offer = await hw(`/api/offers/${offerId}`);
    const we2 = offer.activation_window_end ?? null;
    return we2 && new Date(we2).getTime() > Date.now() ? we2 : null;
  };
  let we = await pollUntil(windowEnd, { timeoutMs: 2e4 });
  if (!we) {
    await hw(`/api/offers/${offerId}/pay`, { body: {} }).catch(() => void 0);
    we = await pollUntil(windowEnd, { timeoutMs: 15e3 });
  }
  return { activated: Boolean(we), window_end: we };
}
function registerSellTools(server2) {
  server2.registerTool(
    "create_offer",
    {
      title: "Create a Hypawave offer (sell files/data/API/compute for Bitcoin)",
      description: "Create a reusable Path 3b offer sold over Lightning. Payments go creator-direct to your payment_destination (a Lightning Address or LNURL-pay URL \u2014 any receiving wallet works; you need NO node and NO preimage support to sell). The offer is inert until you pay the returned activation fee bolt11 (fee = unit_price \xD7 max_payments \xD7 fee% \u2014 Hypawave's only charge; principal never touches Hypawave). Attach files with attach_file BEFORE the fee settles \u2014 content is sealed at activation. Set pay_activation_fee=true to pay it automatically via NWC. By default the offer is PRIVATE (share the offer_id directly, agent-to-agent). To list it in the public marketplace, set is_public=true with title, category, and output_type (immutable after creation).",
      inputSchema: {
        amount: z4.number().positive().describe("Price per sale, in sats (pricing_type=sats) or fiat units"),
        pricing_type: z4.enum(["sats", "fiat"]),
        currency: z4.string().optional().describe("Fiat currency code (e.g. USD) when pricing_type=fiat"),
        description: z4.string().min(1).max(2e3),
        payment_destination: z4.string().describe("YOUR payout destination: Lightning Address (name@domain) or LNURL-pay URL"),
        max_payments: z4.number().int().positive().describe("Unlock capacity N \u2014 how many times the offer can be bought (fee basis; immutable, extend via manage_offer add_capacity)"),
        activation_window: z4.string().optional().describe('Payability window, e.g. "30d" (default), bounds 1d\u2013365d'),
        execution_webhook: z4.string().url().optional().describe("HTTPS endpoint POSTed the settlement proof (for selling execution instead of files)"),
        metadata: z4.record(z4.unknown()).optional(),
        is_public: z4.boolean().optional().describe("List in the public marketplace directory (default false = private)"),
        title: z4.string().max(60).optional().describe("Required when is_public"),
        category: z4.enum(["data", "api", "compute", "media", "software", "access", "action", "other"]).optional().describe("Required when is_public"),
        output_type: z4.enum(["file", "link", "json", "text", "image", "video", "audio", "stream", "webhook"]).optional().describe("Required when is_public"),
        tags: z4.array(z4.string()).max(5).optional(),
        input_schema: z4.union([z4.string(), z4.record(z4.unknown())]).optional(),
        pay_activation_fee: z4.boolean().optional().describe("Pay the activation fee automatically via NWC (default false). Attach files first if the offer has any!")
      }
    },
    async ({ pay_activation_fee, ...body }) => {
      const created = await hw("/api/offers", {
        body: Object.fromEntries(Object.entries(body).filter(([, v]) => v !== void 0)),
        signed: true
      });
      let feePaid = null;
      let activation = null;
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
        next: !pay_activation_fee ? "Offer is INERT until the activation fee_bolt11 is paid (any wallet, no preimage needed). Attach files first via attach_file, then pay the fee." : activation?.activated ? "Offer is ACTIVE and payable. Share the offer_id (private) \u2014 public offers appear in search_offers." : "Fee paid but settlement not yet observed \u2014 check later with manage_offer action=status (activation_window_end set = active)."
      });
    }
  );
  server2.registerTool(
    "attach_file",
    {
      title: "Encrypt and attach a local file to an offer or invoice",
      description: "Encrypts a local file client-side (AES-256-GCM \u2014 Hypawave never sees plaintext), uploads the ciphertext, and registers the file + key with its ciphertext_sha256 content commitment. MUST run before the activation fee settles \u2014 content is sealed at activation. The presigned upload URL lasts 120s. Pass offer_id (Path 3b) or invoice_id (Path 3a), not both.",
      inputSchema: {
        offer_id: z4.string().uuid().optional(),
        invoice_id: z4.string().optional(),
        file_path: z4.string().describe("Absolute path of the plaintext file to sell"),
        content_type: z4.string().optional().describe("MIME type (default application/octet-stream)")
      }
    },
    async ({ offer_id, invoice_id, file_path, content_type }) => {
      if (!offer_id === !invoice_id) throw new Error("pass exactly one of offer_id or invoice_id");
      const plaintext = readFileSync2(file_path);
      const fileName = basename2(file_path);
      const mime = content_type || "application/octet-stream";
      const enc = encryptFile(plaintext);
      const { signedUrl, objectKey } = await hw(
        "/api/offers/upload-url",
        { body: { fileName, contentType: mime, fileSize: enc.ciphertext.length }, signed: true }
      );
      const put = await fetch(signedUrl, {
        method: "PUT",
        headers: { "Content-Type": mime },
        body: new Uint8Array(enc.ciphertext)
      });
      if (!put.ok) throw new Error(`upload failed: HTTP ${put.status} (presigned URL expires after 120s \u2014 retry attach_file)`);
      if (offer_id) {
        const stored2 = await hw("/api/offers/store-file", {
          body: {
            offer_id,
            storage_key: objectKey,
            filename: fileName,
            size: enc.ciphertext.length,
            content_type: mime,
            iv_hex: enc.ivHex,
            ciphertext_sha256: enc.ciphertextSha256
          },
          signed: true
        });
        await hw("/api/offers/store-file-key", {
          body: { offer_file_id: stored2.offer_file_id, wrapped_key: enc.keyB64 },
          signed: true
        });
        return jsonResult({
          ok: true,
          offer_id,
          offer_file_id: stored2.offer_file_id,
          plaintext_bytes: plaintext.length,
          ciphertext_sha256: enc.ciphertextSha256
        });
      }
      const stored = await hw("/api/offers/store-invoice-file", {
        body: {
          invoice_id,
          file_name: fileName,
          encrypted_file_url: objectKey,
          iv_hex: enc.ivHex,
          size: enc.ciphertext.length,
          ciphertext_sha256: enc.ciphertextSha256
        },
        signed: true
      });
      await hw("/api/offers/invoice-file-key", {
        body: { invoice_file_id: stored.id, key_b64: enc.keyB64 },
        signed: true
      });
      return jsonResult({
        ok: true,
        invoice_id,
        invoice_file_id: stored.id,
        plaintext_bytes: plaintext.length,
        ciphertext_sha256: enc.ciphertextSha256
      });
    }
  );
  server2.registerTool(
    "manage_offer",
    {
      title: "Manage an offer: status / renew / add capacity / deactivate",
      description: "status: read the offer (activation state, payments sold vs max_payments, window end). renew: mint a fresh activation fee bolt11 after the window lapsed (402 offer_inactive on pay). add_capacity: buy M more unlock slots (returns a capacity fee bolt11). delete: deactivate the offer permanently. Fee bolt11s are paid automatically via NWC when pay_fee=true, otherwise returned for manual payment (any wallet).",
      inputSchema: {
        offer_id: z4.string().uuid(),
        action: z4.enum(["status", "renew", "add_capacity", "delete"]),
        add_capacity: z4.number().int().positive().optional().describe("Slots to add (action=add_capacity)"),
        activation_window: z4.string().optional().describe('New window for renew, e.g. "30d"'),
        pay_fee: z4.boolean().optional().describe("Pay the returned fee bolt11 automatically via NWC")
      }
    },
    async ({ offer_id, action, add_capacity, activation_window, pay_fee }) => {
      if (action === "status") {
        return jsonResult(await hw(`/api/offers/${offer_id}`));
      }
      if (action === "delete") {
        return jsonResult(await hw(`/api/offers/${offer_id}`, { method: "DELETE", body: null, signed: true }));
      }
      let result;
      let fee;
      if (action === "renew") {
        try {
          result = await hw(`/api/offers/${offer_id}/renew`, {
            body: activation_window ? { activation_window } : {},
            signed: true
          });
          fee = result.activation;
        } catch (e) {
          if (isApiError(e, "activation_not_needed")) {
            return jsonResult({ ok: true, message: "activation window still live \u2014 no renewal needed", detail: e.message });
          }
          throw e;
        }
      } else {
        if (!add_capacity) throw new Error("add_capacity (positive integer) is required for action=add_capacity");
        result = await hw(`/api/offers/${offer_id}/add-capacity`, {
          body: { add_capacity },
          signed: true
        });
        fee = result.topup ?? result.activation;
      }
      let feePaid = null;
      let activation = null;
      if (pay_fee && fee?.fee_bolt11) {
        if (!nwcConfigured()) throw new Error("pay_fee=true but no NWC wallet configured");
        feePaid = await payFee(fee.fee_bolt11, fee.fee_amount_sats, `${action} fee for offer ${offer_id}`);
        if (action === "renew") activation = await waitForActivation(offer_id);
      }
      return jsonResult({
        ...result,
        fee_paid_sats: feePaid,
        ...activation ? { activated: activation.activated, activation_window_end: activation.window_end } : {}
      });
    }
  );
  server2.registerTool(
    "create_invoice",
    {
      title: "Create a one-off Hypawave invoice (Path 3a seller)",
      description: "Create a single-settlement invoice: one buyer pays once, creator-direct to your payment_destination. Returns the buyer payload (invoice_id + access_token \u2014 forward BOTH to the buyer, who settles it with pay_invoice) plus an activation fee bolt11 that must be paid before the invoice goes live. Attach a file first with attach_file(invoice_id=...) if selling a file \u2014 content seals at activation.",
      inputSchema: {
        amount: z4.number().positive(),
        currency: z4.string().optional().describe("Default USD"),
        description: z4.string().optional(),
        payment_destination: z4.string().describe("YOUR Lightning Address or LNURL-pay URL"),
        due_date: z4.string().describe("ISO date the invoice is due, e.g. 2026-07-31"),
        client_email: z4.string().email().describe("Buyer contact email (required by the API)"),
        client_first_name: z4.string(),
        client_last_name: z4.string(),
        company_name: z4.string().optional(),
        expires_in: z4.enum(["1h", "24h", "7d"]).optional(),
        execution_webhook: z4.string().url().optional(),
        pay_activation_fee: z4.boolean().optional().describe("Pay the activation fee automatically via NWC (attach files first!)")
      }
    },
    async ({ pay_activation_fee, ...body }) => {
      const created = await hw(
        "/api/offers/create-invoice",
        { body: Object.fromEntries(Object.entries(body).filter(([, v]) => v !== void 0)), signed: true }
      );
      let feePaid = null;
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
        next: pay_activation_fee ? "Fee paid \u2014 once settled the invoice is live. Forward {invoice_id, access_token} to the buyer." : "Invoice is INERT until the activation fee_bolt11 is paid (any wallet). Attach files first if needed, pay the fee, then forward {invoice_id, access_token} to the buyer."
      });
    }
  );
}

// src/tools/setup-wallet.ts
import { z as z5 } from "zod";

// src/coinos.ts
import { randomBytes as randomBytes4 } from "crypto";
var COINOS_API = process.env.COINOS_API_URL || "https://coinos.io/api";
async function coinos(path, opts = {}) {
  const res = await fetch(`${COINOS_API}${path}`, {
    method: opts.body ? "POST" : "GET",
    headers: {
      "content-type": "application/json",
      ...opts.token ? { authorization: `Bearer ${opts.token}` } : {}
    },
    body: opts.body ? JSON.stringify(opts.body) : void 0
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`coinos ${path}: HTTP ${res.status}${text ? ` \u2014 ${text.slice(0, 200)}` : ""}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`coinos ${path}: non-JSON response`);
  }
}
async function createCoinosWallet() {
  const username = `hw${randomBytes4(6).toString("hex")}`;
  const password = randomBytes4(24).toString("base64url");
  const { token } = await coinos("/register", {
    body: { user: { username, password } }
  });
  if (!token) throw new Error("coinos /register returned no auth token");
  const apps = await coinos("/apps", { token });
  const nwc = apps?.find((a) => typeof a?.nwc === "string")?.nwc;
  if (!nwc || !nwc.startsWith("nostr+walletconnect://")) {
    throw new Error("coinos returned no NWC connection for the new account");
  }
  return {
    provider: "coinos",
    username,
    password,
    token,
    nwc_url: nwc,
    lightning_address: `${username}@${new URL(COINOS_API).host}`,
    created_at: (/* @__PURE__ */ new Date()).toISOString()
  };
}
async function createFundingInvoice(token, amountSats) {
  const inv = await coinos("/invoice", {
    token,
    body: { invoice: { type: "lightning", amount: Math.floor(amountSats) } }
  });
  if (!inv?.hash || !inv.hash.toLowerCase().startsWith("ln")) {
    throw new Error("coinos returned no bolt11 for the funding invoice");
  }
  return inv.hash;
}
async function getOnchainAddress(token) {
  const inv = await coinos("/invoice", {
    token,
    body: { invoice: { type: "bitcoin", amount: 0 } }
  });
  if (!inv?.hash || !/^(bc1|[13])[a-zA-Z0-9]{20,}$/.test(inv.hash)) {
    throw new Error("coinos returned no on-chain deposit address");
  }
  return inv.hash;
}
async function getFundingOptions(amountSats) {
  const wallet = readWalletFile();
  if (!wallet || wallet.provider !== "coinos" || !wallet.token) {
    return {
      present_to_operator: [
        "Fund the agent's Lightning wallet using its own receive/deposit flow (open the wallet app and create a receive invoice or address).",
        "Instant options once you have an invoice: pay it from Cash App, Coinbase, or any Lightning wallet.",
        wallet?.lightning_address ? `Or send sats to the wallet's Lightning address: ${wallet.lightning_address}` : ""
      ].filter(Boolean).join("\n"),
      ...wallet?.lightning_address ? { lightning_address: wallet.lightning_address } : {}
    };
  }
  const result = { present_to_operator: "" };
  const lines = [
    amountSats ? `The agent wallet needs a top-up (~${amountSats} sats). Two ways to fund it:` : "Two ways to fund the agent wallet:"
  ];
  if (amountSats && amountSats >= 1) {
    try {
      result.lightning_invoice = await createFundingInvoice(wallet.token, amountSats);
    } catch {
    }
  }
  lines.push(
    result.lightning_invoice ? `1. INSTANT \u2014 pay this Lightning invoice from Cash App, Coinbase, or any Lightning wallet (settles in seconds):
${result.lightning_invoice}` : `1. INSTANT \u2014 send sats from any Lightning wallet to the agent's Lightning address: ${wallet.lightning_address}
   (If your app needs an exact-amount invoice \u2014 Cash App, Coinbase \u2014 ask the agent for one: setup_wallet {action:'funding_options', amount_sats:N}.)`
  );
  result.lightning_address = wallet.lightning_address;
  try {
    result.onchain_address = await getOnchainAddress(wallet.token);
    lines.push(
      `2. FROM AN EXCHANGE WITHOUT LIGHTNING (e.g. Robinhood) \u2014 send BTC on-chain to:
${result.onchain_address}
   Arrives after confirmation (~10\u201360 min). Minimum 300 sats; mining fees apply, so best for larger top-ups.`
    );
  } catch {
    lines.push(
      "2. FROM AN EXCHANGE WITHOUT LIGHTNING (e.g. Robinhood) \u2014 an on-chain deposit address could not be fetched right now; log in at coinos.io to get one, or use the Lightning option."
    );
  }
  lines.push("The agent will detect the funds and continue automatically.");
  result.present_to_operator = lines.join("\n");
  return result;
}

// src/tools/setup-wallet.ts
var OPERATOR_OPTIONS = [
  "To buy things automatically, your agent needs a Lightning wallet it can spend from. Three options:",
  "1. CREATE ONE NOW (recommended for getting started) \u2014 creates a hosted wallet at coinos.io (think prepaid card: funds are held by that service, so keep only small amounts, e.g. $10\u201320 worth of sats; the operator spending cap applies to every payment). Credentials are generated and stored only on this machine \u2014 Hypawave's servers never receive them.",
  "2. CONNECT YOUR OWN WALLET \u2014 if you already use an NWC-capable wallet (Alby Hub, Coinos, Primal, LNbits, your own node), tell the agent which one and it will walk you through copying its NWC connection string; no account is created anywhere. Note: self-hosted nodes need channel liquidity even for tiny payments.",
  "3. SKIP \u2014 purchases will return a Lightning invoice to pay manually from any wallet (you'll also need the preimage from your wallet to confirm \u2014 fine for testing, clunky as a routine)."
].join("\n");
var NWC_WALLET_GUIDE = [
  "Ask the operator which wallet they use, then give them the matching steps to copy its NWC connection string (starts with nostr+walletconnect://):",
  "- Alby Hub: App Store (or Settings) \u2192 Connections \u2192 Add connection \u2192 set a budget \u2192 copy the connection secret.",
  "- Coinos (existing account): coinos.io \u2192 Settings \u2192 Nostr Wallet Connect (Apps) \u2192 create/copy the connection string.",
  "- Primal: Wallet \u2192 Settings \u2192 Connected apps \u2192 New connection \u2192 copy the string.",
  "- LNbits: enable the NWC Service extension on your wallet \u2192 create a connection \u2192 copy the pairing URL.",
  "- Self-hosted node (LND/CLN): run an NWC bridge (e.g. Alby Hub connected to the node) and create a connection there. Reminder: the node needs outbound channel liquidity.",
  "Then re-call setup_wallet with {action:'connect_own', nwc_url:'<the string>'}."
].join("\n");
var NWC_URI_RE = /^nostr\+walletconnect:\/\/[0-9a-f]{64}\?/i;
async function tryBalance() {
  try {
    const balance_sats = await Promise.race([
      getBalanceSats(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out after 15s")), 15e3))
    ]);
    return { balance_sats };
  } catch (e) {
    return { balance_sats: null, wallet_error: e instanceof Error ? e.message : String(e) };
  }
}
function registerSetupWalletTools(server2) {
  server2.registerTool(
    "setup_wallet",
    {
      title: "Set up the agent's Lightning wallet",
      description: "One-time wallet setup so purchases can pay automatically. Call with no arguments first: it returns the operator-facing options \u2014 present them to the operator verbatim and let them choose; do not choose for them. Then call {action:'create_hosted', confirm:true} ONLY after the operator explicitly agreed (creates a hosted custodial wallet at coinos.io; credentials are stored locally in ~/.hypawave/wallet.json and never sent to Hypawave), or {action:'connect_own'} to use an existing NWC wallet \u2014 without nwc_url it returns per-wallet steps to help the operator find their connection string. Also: {action:'funding_options', amount_sats?} returns operator-facing funding instructions for the configured wallet (instant Lightning invoice/address + on-chain deposit address for exchanges without Lightning, e.g. Robinhood) \u2014 present them verbatim whenever the wallet needs sats. The NWC_URL env var, when set, always takes precedence over anything configured here.",
      inputSchema: {
        action: z5.enum(["create_hosted", "connect_own", "funding_options"]).optional().describe("Omit to get the options to present to the operator"),
        confirm: z5.boolean().optional().describe("Required true for create_hosted \u2014 set only after the operator explicitly agreed"),
        nwc_url: z5.string().optional().describe("For connect_own: the wallet's NWC connection string"),
        amount_sats: z5.number().int().positive().optional().describe("For funding_options: mint an exact-amount Lightning funding invoice for this many sats")
      }
    },
    async ({ action, confirm, nwc_url, amount_sats }) => {
      const envSet = Boolean(process.env.NWC_URL || process.env.HYPAWAVE_NWC_URL);
      if (action === "funding_options") {
        if (!getNwcUrl()) {
          return jsonResult({
            ok: false,
            message: "No wallet configured yet \u2014 run setup_wallet first, then request funding options."
          });
        }
        const funding2 = await getFundingOptions(amount_sats);
        return jsonResult({ ok: true, ...funding2 });
      }
      if (!action) {
        const configured = Boolean(getNwcUrl());
        return jsonResult({
          configured,
          source: getNwcSource(),
          ...configured ? { message: "A wallet is already configured \u2014 no setup needed. Call wallet_status for the balance." } : { present_to_operator: OPERATOR_OPTIONS }
        });
      }
      if (envSet) {
        return jsonResult({
          ok: false,
          message: "NWC_URL is set in the environment and always takes precedence \u2014 unset it in the MCP config first if you want a different wallet."
        });
      }
      if (action === "connect_own") {
        if (!nwc_url) {
          return jsonResult({
            ok: false,
            needs_nwc_url: true,
            present_to_operator: NWC_WALLET_GUIDE
          });
        }
        if (!NWC_URI_RE.test(nwc_url) || !/[?&]secret=[0-9a-f]{64}/i.test(nwc_url)) {
          throw new Error(
            "connect_own requires a valid NWC connection string: nostr+walletconnect://<64-hex-pubkey>?relay=\u2026&secret=<64-hex>. Call {action:'connect_own'} without nwc_url for per-wallet steps to find it."
          );
        }
        if (walletFileExists()) {
          throw new Error(
            `${walletFilePath()} already exists and may hold a funded wallet's only credentials \u2014 back it up and remove it manually first.`
          );
        }
        const path2 = saveWalletFile({
          provider: "custom",
          nwc_url,
          created_at: (/* @__PURE__ */ new Date()).toISOString()
        });
        const check = await tryBalance();
        return jsonResult({
          ok: true,
          provider: "custom",
          saved_to: path2,
          connection_verified: check.balance_sats !== null,
          ...check,
          next: check.balance_sats !== null ? "Wallet connected \u2014 purchases now pay automatically under the spending cap." : "Saved, but the connection could not be verified yet \u2014 check the NWC string and wallet, then call wallet_status."
        });
      }
      if (walletFileExists()) {
        const existing = readWalletFile();
        return jsonResult({
          ok: true,
          already_exists: true,
          provider: existing?.provider ?? "unknown",
          lightning_address: existing?.lightning_address ?? null,
          credentials_file: walletFilePath(),
          message: "A wallet file already exists \u2014 reusing it. Fund it or remove the file manually to start over."
        });
      }
      if (!confirm) {
        return jsonResult({
          ok: false,
          needs_confirmation: true,
          present_to_operator: OPERATOR_OPTIONS,
          message: "create_hosted opens a custodial account at coinos.io in the operator's name. Present the options above, and retry with confirm:true only after the operator explicitly chose option 1."
        });
      }
      const wallet = await createCoinosWallet();
      const path = saveWalletFile(wallet);
      const funding = await getFundingOptions().catch(() => null);
      return jsonResult({
        ok: true,
        provider: "coinos",
        lightning_address: wallet.lightning_address,
        credentials_file: path,
        ...funding ? { funding } : {},
        next: `Fund it now (start small \u2014 5,000\u201350,000 sats): present the funding options above to the operator verbatim \u2014 instant via Lightning (Cash App, Coinbase, or any Lightning wallet), or on-chain from an exchange without Lightning (e.g. Robinhood; slower, mining fees). Then wallet_status shows the balance and purchases pay automatically under the spending cap.`,
        important: `Custodial wallet \u2014 coinos.io holds the funds; keep only small amounts. ${path} contains the ONLY copy of the credentials: back it up, and never delete it while the wallet holds funds.`
      });
    }
  );
}

// src/tools/status.ts
import { z as z6 } from "zod";
function registerStatusTools(server2) {
  server2.registerTool(
    "my_offers",
    {
      title: "List your own offers (seller)",
      description: "List all offers created by this server's seller identity (pubkey-signed). Shows each offer's status, capacity usage, and activation window \u2014 use manage_offer for details/renewal.",
      inputSchema: {
        status: z6.string().optional().describe("Filter by offer status")
      }
    },
    async ({ status }) => jsonResult(await hw("/api/offers/list", { method: "GET", signed: true, query: { status } }))
  );
  server2.registerTool(
    "list_sales",
    {
      title: "List your sales (seller reconciliation)",
      description: "List settled/pending sales for this seller identity (pubkey-signed). kind=offers \u2192 Path 3b payment intents (via /api/offers/list-payments, filterable by offer_id); kind=invoices \u2192 Path 3a invoices (via /api/offers/list-invoices). Returns payment_hash/preimage per sale \u2014 the authoritative way to reconcile missed execution_webhook deliveries.",
      inputSchema: {
        kind: z6.enum(["offers", "invoices"]),
        offer_id: z6.string().uuid().optional().describe("Filter to one offer (kind=offers only)"),
        status: z6.string().optional(),
        limit: z6.number().int().min(1).max(100).optional(),
        offset: z6.number().int().min(0).optional()
      }
    },
    async ({ kind, offer_id, status, limit, offset }) => {
      const path = kind === "offers" ? "/api/offers/list-payments" : "/api/offers/list-invoices";
      return jsonResult(
        await hw(path, {
          method: "GET",
          signed: true,
          query: { status, limit, offset, ...kind === "offers" ? { offer_id } : {} }
        })
      );
    }
  );
  server2.registerTool(
    "get_receipt",
    {
      title: "Fetch a settlement receipt for a past purchase",
      description: "Retrieve the durable settlement record for a purchase you made. For an offer purchase (Path 3b) pass payment_intent_id + payer_secret (both returned by buy_offer). For an invoice (Path 2/3a) pass invoice_id + preimage (pay_invoice returned the preimage).",
      inputSchema: {
        payment_intent_id: z6.string().uuid().optional(),
        payer_secret: z6.string().optional().describe("Required with payment_intent_id"),
        invoice_id: z6.string().optional(),
        preimage: z6.string().regex(/^[0-9a-fA-F]{64}$/).optional().describe("Required with invoice_id")
      }
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
  server2.registerTool(
    "check_payment",
    {
      title: "Check settlement/unlock status of a purchase",
      description: "Non-destructive status check. For an offer purchase (Path 3b) pass payment_intent_id + payer_secret \u2014 returns status and the claim_token once settled. For invoices (Path 2/3a) pass invoice_ids \u2014 returns unlock status per invoice.",
      inputSchema: {
        payment_intent_id: z6.string().uuid().optional(),
        payer_secret: z6.string().optional().describe("Required with payment_intent_id"),
        invoice_ids: z6.array(z6.string()).optional().describe("Invoice ids to check (Path 2/3a)")
      }
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

// src/tools/wallet.ts
function registerWalletTools(server2) {
  server2.registerTool(
    "wallet_status",
    {
      title: "Wallet, identity, and platform settings",
      description: "Reports the operator wallet state (NWC configured? spendable balance in sats), your seller identity pubkey, the operator spending cap, and Hypawave's live public settings (fee_percent, min_fee_sats, limits, BTC price). Call this first to know whether payments can be made automatically and what fees to expect.",
      inputSchema: {}
    },
    async () => {
      const settings = await hw("/api/public-settings").catch((e) => ({ error: String(e) }));
      let balance_sats = null;
      let wallet_error;
      if (nwcConfigured()) {
        try {
          balance_sats = await getBalanceSats();
        } catch (e) {
          wallet_error = e instanceof Error ? e.message : String(e);
        }
      }
      let seller_pubkey = null;
      let identity_error;
      try {
        seller_pubkey = getPubKey();
      } catch (e) {
        identity_error = e instanceof Error ? e.message : String(e);
      }
      return jsonResult({
        wallet: {
          nwc_configured: nwcConfigured(),
          source: getNwcSource(),
          balance_sats,
          ...wallet_error ? { error: wallet_error } : {},
          mode: nwcConfigured() ? "automatic payments" : "manual mode \u2014 tools return bolt11s to pay externally; call setup_wallet to configure a wallet"
        },
        spending_cap: await getSpendCapSats().catch((e) => ({ error: String(e) })),
        seller_pubkey,
        ...identity_error ? { identity_error } : {},
        platform_settings: settings
      });
    }
  );
}

// src/index.ts
var server = new McpServer({
  name: "hypawave",
  version: "0.2.0"
});
registerDiscoverTools(server);
registerBuyTools(server);
registerInvoiceBuyTools(server);
registerSellTools(server);
registerStatusTools(server);
registerWalletTools(server);
registerSetupWalletTools(server);
var transport = new StdioServerTransport();
await server.connect(transport);
var nwcSource = getNwcSource();
console.error(
  "hypawave-mcp ready (16 tools; NWC " + (nwcSource ? `configured via ${nwcSource}` : "not configured \u2014 manual mode; setup_wallet available") + ")"
);
