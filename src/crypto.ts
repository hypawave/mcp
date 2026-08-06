import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * AES-256-GCM helpers matching Hypawave's File Attachment spec (llms.txt),
 * which is written against WebCrypto: the 16-byte GCM auth tag is appended
 * to the ciphertext, IV is 12 bytes, key travels as raw base64.
 */

export function sha256HexOf(data: Buffer | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export interface EncryptedFile {
  ciphertext: Buffer;
  keyB64: string;
  ivHex: string;
  ciphertextSha256: string;
}

export function encryptFile(plaintext: Buffer): EncryptedFile {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return {
    ciphertext,
    keyB64: key.toString("base64"),
    ivHex: iv.toString("hex"),
    ciphertextSha256: sha256HexOf(ciphertext),
  };
}

export function decryptFile(ciphertext: Buffer, keyB64: string, ivHex: string): Buffer {
  if (ciphertext.length < 16) throw new Error("ciphertext too short — missing GCM auth tag");
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) throw new Error("encryption key must be 32 bytes (AES-256)");
  const iv = Buffer.from(ivHex, "hex");
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const data = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/** Verify downloaded bytes against the seller's content commitment before decrypting. */
export function verifyCommitment(ciphertext: Buffer, expectedSha256: string | null | undefined): void {
  if (!expectedSha256) return; // legacy files without commitment
  const actual = sha256HexOf(ciphertext);
  if (actual !== expectedSha256.toLowerCase()) {
    throw new Error(
      `content mismatch — downloaded bytes (sha256 ${actual}) do not match the seller's commitment (${expectedSha256}); aborting before decrypt`
    );
  }
}

/** payment_hash = SHA256(hex-decoded preimage) — the core Lightning settlement identity. */
export function paymentHashFromPreimage(preimageHex: string): string {
  if (!/^[0-9a-fA-F]{64}$/.test(preimageHex)) {
    throw new Error("preimage must be a 32-byte hex string (64 chars)");
  }
  return createHash("sha256").update(Buffer.from(preimageHex, "hex")).digest("hex");
}

// ── ECIES key wrapping for wave transfers ────────────────────────────────────
// Canonical wave transfer wrap_algo: "ecies-secp256k1-aes256gcm-v1".
// Spec (mirrored in llms.txt#waves — the two MUST stay in sync):
//   1. Generate an ephemeral secp256k1 keypair.
//   2. shared = secp256k1.getSharedSecret(ephemeralPriv, recipientPub)
//      (33-byte compressed shared point).
//   3. kek = SHA256(shared)  — 32-byte AES key.
//   4. wrapped = AES-256-GCM(kek, nonce=random 12 bytes, plaintext=raw 32-byte
//      file key), auth tag appended.
//   5. wrapped_key = base64( ephemeralPub(33) || nonce(12) || wrapped||tag ).

import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex as b2h, hexToBytes as h2b } from "@noble/hashes/utils";

export const WAVE_WRAP_ALGO = "ecies-secp256k1-aes256gcm-v1";

export function wrapKeyForPubkey(fileKeyB64: string, recipientPubHex: string): string {
  const fileKey = Buffer.from(fileKeyB64, "base64");
  if (fileKey.length !== 32) throw new Error("file key must be 32 bytes");
  const ephPriv = secp256k1.utils.randomPrivateKey();
  const ephPub = secp256k1.getPublicKey(ephPriv, true);
  const shared = secp256k1.getSharedSecret(ephPriv, h2b(recipientPubHex), true);
  const kek = createHash("sha256").update(Buffer.from(shared)).digest();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", kek, nonce);
  const wrapped = Buffer.concat([cipher.update(fileKey), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([Buffer.from(ephPub), nonce, wrapped]).toString("base64");
}

export function unwrapKeyWithPrivkey(wrappedB64: string, privKeyHex: string): string {
  const blob = Buffer.from(wrappedB64, "base64");
  if (blob.length < 33 + 12 + 32 + 16) throw new Error("wrapped_key blob too short");
  const ephPub = blob.subarray(0, 33);
  const nonce = blob.subarray(33, 45);
  const wrapped = blob.subarray(45);
  const shared = secp256k1.getSharedSecret(privKeyHex, ephPub, true);
  const kek = createHash("sha256").update(Buffer.from(shared)).digest();
  const tag = wrapped.subarray(wrapped.length - 16);
  const data = wrapped.subarray(0, wrapped.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", kek, nonce);
  decipher.setAuthTag(tag);
  const fileKey = Buffer.concat([decipher.update(data), decipher.final()]);
  if (fileKey.length !== 32) throw new Error("unwrapped key is not 32 bytes");
  return fileKey.toString("base64");
}

// b2h re-exported for tool code that needs it alongside these helpers.
export { b2h as bytesToHexLocal };
