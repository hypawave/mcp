import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex } from "@noble/hashes/utils";
import {
  wrapKeyForPubkey,
  unwrapKeyWithPrivkey,
  encryptFile,
  decryptFile,
  WAVE_WRAP_ALGO,
} from "../src/crypto.js";

describe("wave transfer ECIES wrap (ecies-secp256k1-aes256gcm-v1)", () => {
  const recipientPriv = bytesToHex(secp256k1.utils.randomPrivateKey());
  const recipientPub = bytesToHex(secp256k1.getPublicKey(recipientPriv, true));

  it("round-trips a file key", () => {
    const fileKey = randomBytes(32).toString("base64");
    const wrapped = wrapKeyForPubkey(fileKey, recipientPub);
    expect(unwrapKeyWithPrivkey(wrapped, recipientPriv)).toBe(fileKey);
  });

  it("blob layout matches the spec: ephPub(33) || nonce(12) || ct+tag(48)", () => {
    const wrapped = Buffer.from(wrapKeyForPubkey(randomBytes(32).toString("base64"), recipientPub), "base64");
    expect(wrapped.length).toBe(33 + 12 + 32 + 16);
    // Ephemeral pubkey must be a valid compressed point.
    expect([0x02, 0x03]).toContain(wrapped[0]);
    expect(() => secp256k1.Point.fromHex(wrapped.subarray(0, 33))).not.toThrow();
  });

  it("wrong recipient key cannot unwrap (GCM auth failure)", () => {
    const wrapped = wrapKeyForPubkey(randomBytes(32).toString("base64"), recipientPub);
    const otherPriv = bytesToHex(secp256k1.utils.randomPrivateKey());
    expect(() => unwrapKeyWithPrivkey(wrapped, otherPriv)).toThrow();
  });

  it("tampered blob fails closed", () => {
    const wrapped = Buffer.from(wrapKeyForPubkey(randomBytes(32).toString("base64"), recipientPub), "base64");
    wrapped[50] ^= 0xff;
    expect(() => unwrapKeyWithPrivkey(wrapped.toString("base64"), recipientPriv)).toThrow();
  });

  it("full transfer path: encrypt → wrap → unwrap → decrypt", () => {
    const plaintext = Buffer.from("wave transfer payload " + randomBytes(8).toString("hex"));
    const enc = encryptFile(plaintext);
    const wrapped = wrapKeyForPubkey(enc.keyB64, recipientPub);
    const unwrappedKey = unwrapKeyWithPrivkey(wrapped, recipientPriv);
    expect(decryptFile(enc.ciphertext, unwrappedKey, enc.ivHex).equals(plaintext)).toBe(true);
  });

  it("pins the canonical algorithm identifier", () => {
    expect(WAVE_WRAP_ALGO).toBe("ecies-secp256k1-aes256gcm-v1");
  });
});
