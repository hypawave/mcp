import { basename } from "node:path";
import { FALLBACK_SPEND_CAP_SATS, getMaxSpendSatsEnv } from "./config.js";
import { hw } from "./api.js";
import { bolt11AmountSats } from "./bolt11.js";

interface PublicSettings {
  max_invoice_usd?: number;
  btc_usd_price?: number;
}

let cachedDerivedCap: { value: number; fetchedAt: number } | null = null;
const DERIVED_CAP_TTL_MS = 5 * 60_000;

/** Test hook — resets the derived-cap cache. */
export function _resetSpendCapCache(): void {
  cachedDerivedCap = null;
}

/**
 * Effective per-payment spending cap:
 * 1. $HYPAWAVE_MAX_SPEND_SATS when the operator set one;
 * 2. otherwise derived live from platform settings (max_invoice_usd at the
 *    current BTC price), so the default never blocks an amount the platform
 *    itself allows — and tracks admin changes automatically;
 * 3. static fallback if the settings fetch fails.
 */
export async function getSpendCapSats(): Promise<{ cap: number; source: string }> {
  const envCap = getMaxSpendSatsEnv();
  if (envCap !== null) return { cap: envCap, source: "HYPAWAVE_MAX_SPEND_SATS" };

  if (cachedDerivedCap && Date.now() - cachedDerivedCap.fetchedAt < DERIVED_CAP_TTL_MS) {
    return { cap: cachedDerivedCap.value, source: "platform max_invoice_usd (cached)" };
  }
  try {
    const s = await hw<PublicSettings>("/api/public-settings");
    if (s.max_invoice_usd && s.btc_usd_price && s.btc_usd_price > 0) {
      const cap = Math.ceil((s.max_invoice_usd / s.btc_usd_price) * 1e8);
      cachedDerivedCap = { value: cap, fetchedAt: Date.now() };
      return { cap, source: `platform max_invoice_usd ($${s.max_invoice_usd} @ $${s.btc_usd_price}/BTC)` };
    }
  } catch {
    /* fall through to static fallback */
  }
  return { cap: FALLBACK_SPEND_CAP_SATS, source: "static fallback (platform settings unreachable)" };
}

/**
 * Operator spending guardrail: refuse any payment above the effective cap.
 * Hypawave enforces no limits server-side — this cap and the wallet balance
 * are the only guardrails on what an agent can spend.
 */
export async function assertWithinSpendCap(amountSats: number | null, context: string): Promise<void> {
  if (amountSats === null) {
    throw new Error(
      `${context}: could not determine the invoice amount — refusing to auto-pay. Pay manually and use confirm_payment.`
    );
  }
  const { cap, source } = await getSpendCapSats();
  if (amountSats > cap) {
    throw new Error(
      `${context}: amount ${amountSats} sats exceeds the spending cap of ${cap} sats (${source}). Not paid. Raise HYPAWAVE_MAX_SPEND_SATS or pay manually and use confirm_payment.`
    );
  }
}

/** Cross-check the server-quoted amount against the bolt11 itself before paying. */
export function effectiveAmountSats(bolt11: string, quotedSats?: number): number | null {
  const decoded = bolt11AmountSats(bolt11);
  if (decoded !== null && quotedSats !== undefined && Math.abs(decoded - quotedSats) > 1) {
    throw new Error(
      `bolt11 amount (${decoded} sats) does not match the quoted amount (${quotedSats} sats) — refusing to pay`
    );
  }
  return decoded ?? quotedSats ?? null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll fn every ~2.5s (llms.txt cadence) until it returns non-null, up to timeoutMs. */
export async function pollUntil<T>(
  fn: () => Promise<T | null>,
  { timeoutMs = 60_000, intervalMs = 2_500 }: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await fn();
    if (result !== null) return result;
    if (Date.now() + intervalMs > deadline) return null;
    await sleep(intervalMs);
  }
}

/** Strip any path components from a server-supplied filename before writing to disk. */
export function safeFilename(name: string | undefined, fallback: string): string {
  const base = basename(name || "").replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (!base || base === "." || base === "..") return fallback;
  return base;
}

/** MCP text-content result envelope. */
export function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
