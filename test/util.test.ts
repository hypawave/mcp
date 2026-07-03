import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetSpendCapCache,
  assertWithinSpendCap,
  effectiveAmountSats,
  getSpendCapSats,
  pollUntil,
  safeFilename,
} from "../src/util.js";

beforeEach(() => {
  _resetSpendCapCache();
});
afterEach(() => {
  delete process.env.HYPAWAVE_MAX_SPEND_SATS;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const settingsResponse = (body: unknown) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
  );

describe("assertWithinSpendCap", () => {
  it("allows amounts within the env cap", async () => {
    process.env.HYPAWAVE_MAX_SPEND_SATS = "500";
    await expect(assertWithinSpendCap(500, "test")).resolves.toBeUndefined();
    await expect(assertWithinSpendCap(1, "test")).resolves.toBeUndefined();
  });

  it("refuses amounts above the env cap with an actionable message", async () => {
    process.env.HYPAWAVE_MAX_SPEND_SATS = "500";
    await expect(assertWithinSpendCap(501, "buy_offer abc")).rejects.toThrow(/exceeds the spending cap of 500/);
  });

  it("refuses unknown amounts outright", async () => {
    await expect(assertWithinSpendCap(null, "test")).rejects.toThrow(/could not determine/);
  });
});

describe("getSpendCapSats (no env cap set)", () => {
  it("derives the cap from platform max_invoice_usd at the live BTC price", async () => {
    settingsResponse({ max_invoice_usd: 25, btc_usd_price: 61414 });
    const { cap, source } = await getSpendCapSats();
    expect(cap).toBe(Math.ceil((25 / 61414) * 1e8)); // ≈ 40,708 sats
    expect(source).toContain("max_invoice_usd");
  });

  it("caches the derived cap (one settings fetch)", async () => {
    settingsResponse({ max_invoice_usd: 25, btc_usd_price: 50000 });
    await getSpendCapSats();
    const second = await getSpendCapSats();
    expect(second.source).toContain("cached");
    expect(vi.mocked(fetch).mock.calls.length).toBe(1);
  });

  it("falls back to the static cap when settings are unreachable or incomplete", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect((await getSpendCapSats()).cap).toBe(50_000);
    _resetSpendCapCache();
    settingsResponse({ max_invoice_usd: 25 }); // no btc price
    expect((await getSpendCapSats()).cap).toBe(50_000);
  });

  it("env cap wins over the platform-derived cap", async () => {
    process.env.HYPAWAVE_MAX_SPEND_SATS = "123";
    settingsResponse({ max_invoice_usd: 25, btc_usd_price: 61414 });
    const { cap, source } = await getSpendCapSats();
    expect(cap).toBe(123);
    expect(source).toBe("HYPAWAVE_MAX_SPEND_SATS");
    expect(vi.mocked(fetch).mock.calls.length).toBe(0);
  });
});

describe("effectiveAmountSats", () => {
  it("cross-checks bolt11 against the server quote", () => {
    expect(effectiveAmountSats("lnbc1u1pexample", 100)).toBe(100);
    expect(() => effectiveAmountSats("lnbc1u1pexample", 5000)).toThrow(/does not match/);
  });
  it("falls back to the quote when the bolt11 has no amount", () => {
    expect(effectiveAmountSats("lnbc1pvjluezzero", 250)).toBe(250);
    expect(effectiveAmountSats("lnbc1pvjluezzero")).toBeNull();
  });
});

describe("safeFilename", () => {
  it("strips directories and control chars, falls back when empty", () => {
    expect(safeFilename("../../etc/passwd", "fb")).toBe("passwd");
    expect(safeFilename("/abs/path/report.pdf", "fb")).toBe("report.pdf");
    expect(safeFilename("evil\u0000name.txt", "fb")).toBe("evilname.txt");
    expect(safeFilename("..", "fb")).toBe("fb");
    expect(safeFilename(undefined, "fb")).toBe("fb");
  });
});

describe("pollUntil", () => {
  it("returns the first non-null result", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const p = pollUntil(async () => (++calls >= 3 ? "done" : null), { intervalMs: 1000, timeoutMs: 10_000 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toBe("done");
    expect(calls).toBe(3);
  });

  it("returns null on timeout", async () => {
    vi.useFakeTimers();
    const p = pollUntil(async () => null, { intervalMs: 1000, timeoutMs: 3500 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toBeNull();
  });
});
