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
