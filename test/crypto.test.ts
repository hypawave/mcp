import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptFile,
  encryptFile,
  paymentHashFromPreimage,
  sha256HexOf,
  verifyCommitment,
} from "../src/crypto.js";

describe("AES-256-GCM file crypto", () => {
  it("round-trips", () => {
    const plaintext = Buffer.from("hello lightning commerce", "utf8");
    const enc = encryptFile(plaintext);
    expect(enc.ivHex).toMatch(/^[0-9a-f]{24}$/); // 12-byte IV
    expect(enc.ciphertextSha256).toBe(sha256HexOf(enc.ciphertext));
    expect(decryptFile(enc.ciphertext, enc.keyB64, enc.ivHex).equals(plaintext)).toBe(true);
  });

  it("is WebCrypto-compatible (spec in llms.txt is written against subtle)", async () => {
    const plaintext = Buffer.from("cross-implementation check");
    const enc = encryptFile(plaintext);
    // Decrypt our node-crypto output with WebCrypto, as a buyer following llms.txt would.
    const key = await webcrypto.subtle.importKey(
      "raw",
      Buffer.from(enc.keyB64, "base64"),
      { name: "AES-GCM" },
      false,
      ["decrypt"]
    );
    const iv = Buffer.from(enc.ivHex, "hex");
    const out = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv }, key, enc.ciphertext);
    expect(Buffer.from(out).equals(plaintext)).toBe(true);
  });

  it("rejects tampered ciphertext via the GCM tag", () => {
    const enc = encryptFile(Buffer.from("tamper me"));
    const evil = Buffer.from(enc.ciphertext);
    evil[0] ^= 0xff;
    expect(() => decryptFile(evil, enc.keyB64, enc.ivHex)).toThrow();
  });

  it("rejects short ciphertext and wrong key sizes", () => {
    expect(() => decryptFile(Buffer.alloc(4), "AAAA", "00".repeat(12))).toThrow(/too short/);
    const enc = encryptFile(Buffer.from("x"));
    expect(() => decryptFile(enc.ciphertext, Buffer.alloc(16).toString("base64"), enc.ivHex)).toThrow(/32 bytes/);
  });
});

describe("verifyCommitment", () => {
  it("passes on match, throws on mismatch, skips when absent", () => {
    const bytes = Buffer.from("committed bytes");
    expect(() => verifyCommitment(bytes, sha256HexOf(bytes))).not.toThrow();
    expect(() => verifyCommitment(bytes, sha256HexOf(bytes).toUpperCase())).not.toThrow();
    expect(() => verifyCommitment(bytes, "ab".repeat(32))).toThrow(/content mismatch/);
    expect(() => verifyCommitment(bytes, null)).not.toThrow();
    expect(() => verifyCommitment(bytes, undefined)).not.toThrow();
  });
});

describe("paymentHashFromPreimage", () => {
  it("hashes the hex-decoded preimage (not the hex string)", () => {
    // sha256(0x00 * 32)
    expect(paymentHashFromPreimage("00".repeat(32))).toBe(
      "66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925"
    );
  });
  it("rejects non-hex and wrong-length input", () => {
    expect(() => paymentHashFromPreimage("zz".repeat(32))).toThrow();
    expect(() => paymentHashFromPreimage("ab")).toThrow();
  });
});
