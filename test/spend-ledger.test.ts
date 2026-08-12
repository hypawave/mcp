import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The ledger path is resolved from config at import time, so point HOME at a
// scratch dir before importing anything that touches it.
const scratch = mkdtempSync(join(tmpdir(), "hypawave-ledger-"));
process.env.HOME = scratch;

const { reserveSpend, spentInWindow, _resetSpendLedger } = await import("../src/spend-ledger.js");
const { LEDGER_FILE } = await import("../src/config.js");

describe("cumulative spend guardrail", () => {
  beforeEach(() => {
    process.env.HYPAWAVE_MAX_SPEND_SATS_PER_WINDOW = "10000";
    process.env.HYPAWAVE_SPEND_WINDOW_HOURS = "24";
    _resetSpendLedger();
  });

  afterEach(() => {
    delete process.env.HYPAWAVE_MAX_SPEND_SATS_PER_WINDOW;
    delete process.env.HYPAWAVE_SPEND_WINDOW_HOURS;
  });

  it("allows a payment inside the window cap", () => {
    const r = reserveSpend(3000, "buy_offer a");
    r.settle();
    expect(spentInWindow()).toBe(3000);
  });

  it("refuses the payment that would cross the cap", () => {
    reserveSpend(9000, "buy_offer a").settle();
    expect(() => reserveSpend(2000, "buy_offer b")).toThrow(/cumulative cap/);
    expect(spentInWindow()).toBe(9000);
  });

  it("blocks the drain-by-small-payments case the per-payment cap misses", () => {
    // Ten payments of 1,500 sats each: every one is individually well under a
    // 50,000-sat per-payment cap, and together they exceed the 10,000 window.
    let paid = 0;
    let refused = 0;
    for (let i = 0; i < 10; i++) {
      try {
        reserveSpend(1500, `buy_offer ${i}`).settle();
        paid += 1500;
      } catch {
        refused++;
      }
    }
    expect(paid).toBeLessThanOrEqual(10000);
    expect(refused).toBeGreaterThan(0);
  });

  it("reserves before paying, so two concurrent buys cannot both pass", () => {
    // The check-then-act gap: without reservation both calls read the same
    // total, both pass, and both pay.
    const first = reserveSpend(6000, "buy_offer a"); // in flight, not settled
    expect(() => reserveSpend(6000, "buy_offer b")).toThrow(/cumulative cap/);
    first.settle();
  });

  it("releases headroom when the payment fails", () => {
    const r = reserveSpend(9000, "buy_offer a");
    r.release(); // payment threw
    expect(spentInWindow()).toBe(0);
    expect(() => reserveSpend(9000, "buy_offer b")).not.toThrow();
  });

  it("frees spend once the window rolls past", () => {
    const now = Date.now();
    reserveSpend(9000, "old", now - 25 * 3_600_000).settle();
    expect(spentInWindow(now)).toBe(0);
    expect(() => reserveSpend(9000, "new", now)).not.toThrow();
  });

  it("survives a restart — the ledger is on disk, not in memory", () => {
    reserveSpend(8000, "before restart").settle();
    // The state a restarted process would read back: the file itself, with no
    // help from module-level memory.
    const onDisk = JSON.parse(readFileSync(LEDGER_FILE, "utf8"));
    expect(onDisk.entries.reduce((n: number, e: { sats: number }) => n + e.sats, 0)).toBe(8000);
    expect(spentInWindow()).toBe(8000);
    expect(() => reserveSpend(5000, "after restart")).toThrow(/cumulative cap/);
  });

  it("does nothing when the operator has not set a cumulative cap", () => {
    delete process.env.HYPAWAVE_MAX_SPEND_SATS_PER_WINDOW;
    expect(() => reserveSpend(1_000_000, "uncapped")).not.toThrow();
  });

  it("fails closed on a corrupt ledger rather than reading it as zero spent", () => {
    writeFileSync(LEDGER_FILE, "{ not json");
    expect(() => reserveSpend(100, "after corruption")).toThrow(/Corrupt spend ledger/);
  });
});

afterEach(() => {
  /* keep the scratch dir until the process exits */
});

process.on("exit", () => {
  rmSync(scratch, { recursive: true, force: true });
});
