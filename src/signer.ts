import { createHash, randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

const sha256Hex = (input: string): string => createHash("sha256").update(input).digest("hex");

export interface SignedRequest {
  headers: Record<string, string>;
  body: string | undefined;
  debug: { pubKey: string; termsHash: string | null; bodyHash: string; canonicalHash: string };
}

/**
 * Hypawave pubkey-signature auth (Paths 3a/3b) — faithful port of the
 * reference implementation in llms.txt ("Pubkey Signature Auth").
 *
 * Body-bearing requests carry two signatures: a body-level signature over
 * sha256(JSON.stringify(body)) appended to the body as
 * `signed_payload_hash` + `signature`, and a header-level auth signature
 * over sha256(`${bodyHash}:${timestamp}:${nonce}`). Body-less requests
 * (GET/DELETE) carry the header-level signature only. The server accepts
 * DER-encoded low-S signatures exclusively.
 */
export function signRequest({
  body,
  privKey,
  timestamp,
  nonce,
}: {
  body: Record<string, unknown> | null;
  privKey: string;
  timestamp?: string;
  nonce?: string;
}): SignedRequest {
  const pubKey = bytesToHex(secp256k1.getPublicKey(privKey, true));

  let fullBody = body;
  let termsHash: string | null = null;
  if (body) {
    termsHash = sha256Hex(JSON.stringify(body));
    const termsSig = secp256k1.sign(hexToBytes(termsHash), privKey, { lowS: true });
    fullBody = { ...body, signed_payload_hash: termsHash, signature: termsSig.toDERHex() };
  }

  const bodyStr = fullBody ? JSON.stringify(fullBody) : "";
  const bodyHash = sha256Hex(bodyStr);
  const ts = timestamp ?? Math.floor(Date.now() / 1000).toString();
  const nce = nonce ?? randomBytes(16).toString("hex");
  const canonicalHash = sha256Hex(`${bodyHash}:${ts}:${nce}`);
  const authSig = secp256k1.sign(hexToBytes(canonicalHash), privKey, { lowS: true });

  return {
    headers: {
      "Content-Type": "application/json",
      "x-pubkey": pubKey,
      "x-signature": authSig.toDERHex(),
      "x-signed-payload-hash": bodyHash,
      "x-timestamp": ts,
      "x-nonce": nce,
    },
    body: bodyStr || undefined,
    debug: { pubKey, termsHash, bodyHash, canonicalHash },
  };
}
