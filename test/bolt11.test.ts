import { describe, expect, it } from "vitest";
import { bolt11AmountSats } from "../src/bolt11.js";

describe("bolt11AmountSats", () => {
  it("decodes standard multipliers", () => {
    expect(bolt11AmountSats("lnbc1u1pexample")).toBe(100); // 1 µBTC = 100 sats
    expect(bolt11AmountSats("lnbc100n1pexample")).toBe(10); // 100 nBTC = 10 sats
    expect(bolt11AmountSats("lnbc10m1pexample")).toBe(1_000_000); // 10 mBTC
    expect(bolt11AmountSats("lnbc1000n1p...")).toBe(100);
    expect(bolt11AmountSats("lnbc11pexample")).toBe(100_000_000); // 1 BTC (no multiplier)
  });

  it("rounds sub-sat amounts up (pico)", () => {
    expect(bolt11AmountSats("lnbc1p1pexample")).toBe(1); // 1 pBTC < 1 sat → ceil
  });

  it("handles testnet/regtest/signet prefixes and case", () => {
    expect(bolt11AmountSats("lntb500u1pexample")).toBe(50_000);
    expect(bolt11AmountSats("lnbcrt1u1pexample")).toBe(100);
    expect(bolt11AmountSats("lntbs1u1pexample")).toBe(100);
    expect(bolt11AmountSats("LNBC1U1PEXAMPLE")).toBe(100);
  });

  it("returns null for zero-amount or malformed invoices", () => {
    expect(bolt11AmountSats("lnbc1pvjluezexample")).toBeNull(); // zero-amount invoice shape
    expect(bolt11AmountSats("lnbc1qexample")).toBeNull(); // no separator '1' after amount
    expect(bolt11AmountSats("notaninvoice")).toBeNull();
    expect(bolt11AmountSats("")).toBeNull();
  });
});
