import { mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
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
 * Per-payment size bound, checked before paying. This limits how large any
 * single payment may be — not how much an agent may spend in total.
 *
 * The default tracks the platform's own maximum invoice size, so it never
 * refuses an amount Hypawave itself would allow, and it keeps payments in the
 * range Lightning reliably routes. An operator can set HYPAWAVE_MAX_SPEND_SATS
 * lower to tighten it on their own machine.
 *
 * Total spend is bounded at the wallet layer, not here — see SECURITY.md.
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
      `${context}: amount ${amountSats} sats exceeds the per-payment cap of ${cap} sats (${source}). Not paid. Raise HYPAWAVE_MAX_SPEND_SATS or pay manually and use confirm_payment.`
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

/** Strip any path components from a server-supplied filename before writing to disk.
    Leading dots go too, so a peer cannot plant a hidden file (.mcp.json, .bashrc). */
export function safeFilename(name: string | undefined, fallback: string): string {
  const base = basename(name || "").replace(/[\x00-\x1f\x7f]/g, "").trim().replace(/^\.+/, "");
  return base || fallback;
}

/** Write an untrusted file without ever replacing an existing one: a taken
    name gets " (1)", " (2)", … before the extension, like a browser download.
    `wx` makes the existence check and the create one atomic step. */
export function writeUntrustedFile(dir: string, name: string, data: Uint8Array): string {
  mkdirSync(dir, { recursive: true });
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 0; n < 1000; n++) {
    const path = join(dir, n === 0 ? name : `${stem} (${n})${ext}`);
    try {
      writeFileSync(path, data, { flag: "wx" });
      return path;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error(`could not find a free filename for ${name} in ${dir}`);
}

/** Name the executable format of `data` from its leading bytes, whatever the
    filename claims — a "report.pdf" that is really a program is the case this
    exists for. Null for everything else. */
export function detectExecutable(data: Uint8Array): string | null {
  const b = data;
  if (b.length >= 4) {
    const u32 = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
    if (u32 === 0x7f454c46) return "ELF executable (Linux)";
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(u32)) return "Mach-O executable (macOS)";
    if (u32 === 0xcafebabe) return "Mach-O universal binary (macOS) or Java class";
  }
  if (b.length >= 2 && b[0] === 0x4d && b[1] === 0x5a) return "Windows executable (PE/MZ)";
  if (b.length >= 2 && b[0] === 0x23 && b[1] === 0x21) return "script (#! shebang)";
  return null;
}

/** Warning to put in a tool result when a received file is executable. */
export function executableWarning(savedPath: string, kind: string): string {
  return (
    `${savedPath} is a ${kind}, whatever its name suggests. Do not open or run it, and tell your ` +
    "operator before doing anything else with it."
  );
}

/** MCP text-content result envelope. */
export function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
