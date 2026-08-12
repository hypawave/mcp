import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { LEDGER_FILE, getMaxSpendWindowHours, getMaxSpendSatsPerWindowEnv } from "./config.js";

/**
 * Cumulative spend guardrail — the per-payment cap's missing half.
 *
 * `assertWithinSpendCap` bounds the largest single payment. It cannot bound a
 * pattern: an agent paying `cap - 1` sats a hundred times passes that check a
 * hundred times. Since Hypawave enforces no limits server-side, the only other
 * thing standing between a looping agent and an empty wallet is the balance.
 *
 * This adds a rolling window: at most N sats per H hours, across every payment
 * this machine makes.
 *
 * Two decisions worth stating, because both are load-bearing:
 *
 *   1. **Reserve before paying, commit after.** Checking a running total and
 *      then paying is a time-of-check-to-time-of-use gap: two concurrent
 *      `pay_invoice` calls can both read the same total, both pass, and both
 *      pay. Reserving first closes that window — the second call is refused
 *      while the first is still in flight.
 *
 *   2. **Persisted, not in-memory.** An MCP server restarts. If the ledger
 *      lived in a variable, "10,000 sats per day" would silently become
 *      "10,000 sats per restart", which is not a limit at all.
 *
 * A reservation that is never resolved (process killed mid-payment) simply
 * ages out with the window. That costs the operator conservatism rather than
 * money, which is the right direction to fail.
 */

interface SpendEntry {
  /** Epoch ms when the spend was reserved. */
  at: number;
  sats: number;
  /** Human-readable context, for the refusal message and for auditing. */
  context: string;
  /** false until the payment is known to have gone through. */
  settled: boolean;
}

interface LedgerFile {
  version: 1;
  entries: SpendEntry[];
}

function readLedger(): LedgerFile {
  if (!existsSync(LEDGER_FILE)) return { version: 1, entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(LEDGER_FILE, "utf8"));
    if (parsed?.version === 1 && Array.isArray(parsed.entries)) return parsed as LedgerFile;
  } catch {
    /* fall through */
  }
  // A corrupt ledger must not read as "nothing spent yet" — that would turn a
  // damaged file into an open wallet. Fail closed by treating it as unusable.
  throw new Error(
    `Corrupt spend ledger at ${LEDGER_FILE} — delete it to reset the window, or set HYPAWAVE_MAX_SPEND_SATS_PER_WINDOW=0 to disable the cumulative cap.`
  );
}

/** Atomic write: a half-written ledger after a crash would under-count spend. */
function writeLedger(l: LedgerFile): void {
  mkdirSync(dirname(LEDGER_FILE), { recursive: true, mode: 0o700 });
  const tmp = `${LEDGER_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(l), { mode: 0o600 });
  renameSync(tmp, LEDGER_FILE);
}

function prune(entries: SpendEntry[], windowMs: number, now: number): SpendEntry[] {
  const cutoff = now - windowMs;
  return entries.filter((e) => e.at > cutoff);
}

/** Sats committed or reserved in the current window. */
export function spentInWindow(now = Date.now()): number {
  const windowMs = getMaxSpendWindowHours() * 3_600_000;
  const l = readLedger();
  return prune(l.entries, windowMs, now).reduce((n, e) => n + e.sats, 0);
}

export interface SpendReservation {
  /** The payment went through — keep the spend on the books. */
  settle(): void;
  /** The payment did not happen — give the headroom back. */
  release(): void;
}

/**
 * Reserve headroom for a payment. Throws if it would breach the window cap.
 *
 * Returns a handle the caller must resolve either way. A cumulative cap of 0
 * (or unset) disables this check entirely, preserving today's behaviour for
 * operators who have not opted in.
 */
export function reserveSpend(amountSats: number, context: string, now = Date.now()): SpendReservation {
  const cap = getMaxSpendSatsPerWindowEnv();
  if (cap === null || cap <= 0) {
    return { settle: () => {}, release: () => {} }; // cumulative cap not configured
  }

  const windowHours = getMaxSpendWindowHours();
  const windowMs = windowHours * 3_600_000;
  const l = readLedger();
  const entries = prune(l.entries, windowMs, now);
  const already = entries.reduce((n, e) => n + e.sats, 0);

  if (already + amountSats > cap) {
    const oldest = entries[0]?.at ?? now;
    const freesInMin = Math.max(0, Math.ceil((oldest + windowMs - now) / 60_000));
    throw new Error(
      `${context}: refusing to pay ${amountSats} sats — that would take spend to ${already + amountSats} sats ` +
        `against a cumulative cap of ${cap} sats per ${windowHours}h (${already} already committed). ` +
        `The window frees up in ~${freesInMin} min. Raise HYPAWAVE_MAX_SPEND_SATS_PER_WINDOW or pay manually.`
    );
  }

  const entry: SpendEntry = { at: now, sats: amountSats, context, settled: false };
  entries.push(entry);
  writeLedger({ version: 1, entries });

  const idx = entries.length - 1;
  return {
    settle() {
      const cur = readLedger();
      const e = cur.entries[idx];
      if (e && e.at === entry.at && e.sats === entry.sats) {
        e.settled = true;
        writeLedger(cur);
      }
    },
    release() {
      const cur = readLedger();
      // Remove by identity, not index: another payment may have been recorded
      // in between, and dropping the wrong entry would free someone else's spend.
      const at = entry.at;
      const filtered = cur.entries.filter((e) => !(e.at === at && e.sats === entry.sats && !e.settled));
      writeLedger({ version: 1, entries: filtered });
    },
  };
}

/** Test hook — clears the persisted window. */
export function _resetSpendLedger(): void {
  if (existsSync(LEDGER_FILE)) writeLedger({ version: 1, entries: [] });
}
