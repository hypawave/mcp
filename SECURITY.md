# Security

## What this package is

A **local stdio MCP server** for Hypawave's accountless Lightning paths (3a/3b). It runs on the operator's machine as a subprocess of their agent client. There is **no hosted component and no custody here** — the server is a pure client of the public Hypawave API; buyers pay creators directly over Lightning.

## Trust model

**What stays on your machine (never transmitted):**
- **Your seller signing key** — `HYPAWAVE_PRIVKEY` or the auto-generated `~/.hypawave/identity.json` (written with `0600` permissions). Used only locally to sign seller requests with secp256k1/DER (`@noble/curves`). No Hypawave endpoint accepts a private key. **Back it up — it IS your identity and controls your offers.**
- **Your wallet credentials** — the `NWC_URL` connection string. The server speaks NIP-47 directly to your wallet over its Nostr relay; the string is never sent to Hypawave.
- **Plaintext files** — encryption and decryption are local AES-256-GCM. Hypawave stores only ciphertext.

**What Hypawave's server sees:** ordinary API requests — offer terms, signed request headers (public key + signatures), preimages submitted as settlement proof, and encrypted blobs. Nothing that lets anyone spend from your wallet or impersonate your identity.

## Spending guardrails (and their limits)

- **Per-payment cap, enforced in code before paying:** `HYPAWAVE_MAX_SPEND_SATS` if set, otherwise derived live from the platform's own maximum invoice size. The bolt11 amount is additionally cross-checked against the server's quote; undecodable or zero-amount invoices are refused.
- Tools accept a per-call `expected_max_sats` bound for tighter, task-level limits.
- **What the cap does NOT do:** it is per-payment, not a daily budget — a compromised or misbehaving agent could make many cap-sized payments. Bound total exposure at the wallet layer: fund the wallet with a working balance only, and use your wallet's own NWC budget controls (e.g. a connection-level `max_amount`) as the outer wall.
- Hypawave enforces no spending limits server-side. The cap, your wallet balance, and your wallet's NWC budget are the only guardrails.

## Payment and delivery integrity

- **Settlement is the only gate.** A verified Lightning preimage (`SHA-256(preimage) == payment_hash`) is the proof that unlocks a purchase. Settlement is final — there are no refunds.
- **Content commitment verified before decrypt.** Downloaded ciphertext is checked against the seller's `ciphertext_sha256` commitment; a mismatch aborts before decryption. Server-supplied filenames are sanitized before writing to disk.
- **`payment_count` on marketplace offers is settled-sales volume, not a trust score.** Settlement releases delivery regardless of buyer satisfaction — evaluate offer terms before paying.

## Custodial-wallet tradeoff

The recommended buyer setup (a custodial NWC wallet such as Coinos) means the wallet provider holds those funds and can freeze or censor them. Keep only a small working balance there. Sellers are unaffected: payouts go directly to whatever Lightning Address you control.

## Dependencies

Runtime dependencies are pinned, widely-used libraries: `@modelcontextprotocol/sdk` (MCP transport), `@getalby/sdk` (NIP-47 client), `@noble/curves`/`@noble/hashes` (audited cryptography), `zod`, `ws`. The only network destinations at runtime are the Hypawave API over HTTPS, your wallet's Nostr relay, and presigned storage URLs returned by the API.

## Verifying

```bash
npm test    # 32 unit tests, including the signer against Hypawave's published llms.txt test vector
```

## Reporting a vulnerability

Email **security@hypawave.com** (or support@hypawave.com). Please do not open a public issue for security-sensitive reports. We aim to acknowledge within a few business days.
