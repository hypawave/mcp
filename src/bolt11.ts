/**
 * Minimal bolt11 amount extraction from the human-readable part — enough to
 * enforce the operator spending cap without a full invoice decoder.
 * Grammar: ln(bc|tb|tbs|bcrt)<amount><multiplier>1<data...>
 */
const HRP_RE = /^ln(?:bcrt|tbs|tb|bc)(\d+)([munp]?)1/i;

const MULTIPLIER_SATS: Record<string, number> = {
  // 1 BTC = 1e8 sats; m=1e-3 BTC, u=1e-6, n=1e-9, p=1e-12
  "": 1e8,
  m: 1e5,
  u: 1e2,
  n: 1e-1,
  p: 1e-4,
};

/** Returns the invoice amount in sats (rounded up), or null for zero-amount invoices. */
export function bolt11AmountSats(bolt11: string): number | null {
  const m = HRP_RE.exec(bolt11.trim());
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  return Math.ceil(value * MULTIPLIER_SATS[m[2].toLowerCase()]);
}
