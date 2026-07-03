import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1";
import { hexToBytes } from "@noble/hashes/utils";
import { signRequest } from "../src/signer.js";

// Published llms.txt test vector ("Test vector — self-verify before hitting the API")
const VECTOR = {
  privKey: "0000000000000000000000000000000000000000000000000000000000000001",
  body: {
    amount: 0.01,
    pricing_type: "fiat",
    currency: "USD",
    description: "Test offer",
    payment_destination: "https://example.invalid/.well-known/lnurlp/creator",
    activation_window: "30d",
  },
  timestamp: "946684800",
  nonce: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
  expected: {
    pubKey: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    termsHash: "4e5c7c24dd3c9ca598c65699a13084bd687b99365c249d4f2e3fe9363c6f1cac",
    bodyHash: "472412ee78dd3bade6df5ade1733c91b1823f097ab87c377bdb3838b89e6ff51",
    canonicalHash: "2b9e7667542ef23c087884ed1236c907117ad5ed62a3a519fd4024a2b35e3974",
  },
};

describe("signRequest", () => {
  it("matches the published llms.txt test vector", () => {
    const { debug, headers, body } = signRequest({
      body: VECTOR.body,
      privKey: VECTOR.privKey,
      timestamp: VECTOR.timestamp,
      nonce: VECTOR.nonce,
    });
    expect(debug.pubKey).toBe(VECTOR.expected.pubKey);
    expect(debug.termsHash).toBe(VECTOR.expected.termsHash);
    expect(debug.bodyHash).toBe(VECTOR.expected.bodyHash);
    expect(debug.canonicalHash).toBe(VECTOR.expected.canonicalHash);
    expect(headers["x-pubkey"]).toBe(VECTOR.expected.pubKey);
    expect(headers["x-signed-payload-hash"]).toBe(VECTOR.expected.bodyHash);
    // sent bytes must equal signed bytes
    expect(JSON.parse(body!)).toMatchObject({ ...VECTOR.body, signed_payload_hash: VECTOR.expected.termsHash });
  });

  it("produces DER signatures that verify against the canonical hash", () => {
    const { headers, debug } = signRequest({ body: VECTOR.body, privKey: VECTOR.privKey });
    const sigHex = headers["x-signature"];
    expect(sigHex.length).toBeGreaterThan(130); // DER, not 128-char compact
    const sig = secp256k1.Signature.fromDER(sigHex);
    expect(secp256k1.verify(sig, hexToBytes(debug.canonicalHash), debug.pubKey)).toBe(true);
    expect(sig.hasHighS()).toBe(false); // low-S enforced (BIP-62)
  });

  it("body-less requests sign the empty string and send no body", () => {
    const { headers, body, debug } = signRequest({ body: null, privKey: VECTOR.privKey });
    expect(body).toBeUndefined();
    expect(debug.termsHash).toBeNull();
    // sha256("")
    expect(headers["x-signed-payload-hash"]).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  it("timestamp is unix seconds and nonce is 32 hex chars", () => {
    const { headers } = signRequest({ body: null, privKey: VECTOR.privKey });
    expect(Number(headers["x-timestamp"])).toBeCloseTo(Date.now() / 1000, -1);
    expect(headers["x-nonce"]).toMatch(/^[0-9a-f]{32}$/);
  });
});
