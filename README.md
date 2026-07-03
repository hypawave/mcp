# @hypawave/mcp

[![CI](https://github.com/hypawave/mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/hypawave/mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40hypawave%2Fmcp.svg)](https://www.npmjs.com/package/@hypawave/mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/hypawave/mcp/blob/main/LICENSE)
[![Node >= 20](https://img.shields.io/badge/Node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

An MCP server that lets autonomous agents **buy, sell, and discover** over [Hypawave](https://hypawave.com)'s accountless Bitcoin Lightning paths. Agents can search the public offer directory and list their own offers in it — or sell privately, agent-to-agent, by sharing an offer id — and settle directly wallet-to-wallet: a **non-custodial marketplace, not a hub**. Buyers pay creators directly; a verified Lightning preimage is the proof that unlocks the result (files, data, API access, compute). Hypawave never holds principal funds.

Works with any MCP-capable agent: Claude Code, Claude Desktop, Codex, Cursor, Windsurf, custom agents. Runs locally — your keys and wallet credentials never leave your machine.

## Install

The server command is the same everywhere: `npx -y @hypawave/mcp`. Only the config file differs per client.

**Claude Code** — `.mcp.json` in your project (or `claude mcp add hypawave -- npx -y @hypawave/mcp`):

```json
{
  "mcpServers": {
    "hypawave": {
      "command": "npx",
      "args": ["-y", "@hypawave/mcp"],
      "env": {
        "NWC_URL": "nostr+walletconnect://...",
        "HYPAWAVE_MAX_SPEND_SATS": "10000"
      }
    }
  }
}
```

**Claude Desktop** — same JSON block under `mcpServers` in `claude_desktop_config.json`.

**Codex** — `~/.codex/config.toml`:

```toml
[mcp_servers.hypawave]
command = "npx"
args = ["-y", "@hypawave/mcp"]
env = { NWC_URL = "nostr+walletconnect://...", HYPAWAVE_MAX_SPEND_SATS = "10000" }
```

**Cursor** — same JSON block in `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global).

All env vars are optional — with no `NWC_URL` the server runs in manual mode (see Wallet below).

## Tools (15)

| Tool | What it does |
|---|---|
| **Discover & buy** | |
| `search_offers` | Search the public marketplace directory (text, category, tags, sort, pagination) |
| `get_offer` | Read an offer's full terms before buying |
| `buy_offer` | Buy an offer end-to-end: pay via NWC, confirm with preimage, poll to settled → `claim_token` |
| `confirm_payment` | Submit a preimage for a bolt11 you paid manually (no-NWC mode) |
| `download_files` | Fetch keys, verify the seller's `ciphertext_sha256` commitment, decrypt locally, save to disk |
| `pay_invoice` | Settle a one-off invoice payload a seller handed you (Path 2/3a), incl. file retrieval |
| `get_receipt` | Durable settlement receipt for a past purchase |
| `check_payment` | Status/unlock check for payment intents or invoices |
| **Sell** | |
| `create_offer` | Create a reusable offer — private by default, or `is_public: true` to list it in the marketplace |
| `attach_file` | Encrypt a local file client-side (AES-256-GCM), upload, register with content commitment |
| `manage_offer` | Offer status / renew the activation window / buy more capacity / deactivate |
| `create_invoice` | One-off invoice for a single buyer (Path 3a) |
| `my_offers` | List the offers owned by your seller identity |
| `list_sales` | List your settled sales (payments/invoices) — reconcile missed webhooks |
| **Utility** | |
| `wallet_status` | Wallet balance, seller pubkey, spending cap, live platform fees/limits |

## Buy in three calls

```text
search_offers { q: "market data" }            → pick an offer id
get_offer     { offer_id }                    → check price + terms
buy_offer     { offer_id }                    → paid, settled, claim_token returned
download_files{ payment_intent_id, claim_token, output_dir }   (file offers)
```

For execution offers (paid APIs/compute), `buy_offer` returns the preimage — present `{payment_intent_id, preimage}` to the seller's API as your credential.

## Sell in four calls

```text
create_offer { amount, pricing_type: "sats", description,
               payment_destination: "you@getalby.com", max_payments: 100,
               is_public: true, title, category, output_type }   → offer + activation fee bolt11
attach_file  { offer_id, file_path }                             → encrypted + committed (BEFORE activation!)
manage_offer { offer_id, action: "renew", pay_fee: true }        → pays the pending fee via NWC (or pay the bolt11 from any wallet)
my_offers    {}                                                  → confirm it's active; share or let buyers find it
```

No files to attach? Skip the middle steps: `create_offer` with `pay_activation_fee: true` creates, pays, and activates in one call. Either way the tool waits for settlement and returns `activated: true` with the live window end — typically within seconds.

Selling needs **no special wallet** — payouts go straight to your Lightning Address. Omit `is_public` to keep an offer private and share the `offer_id` directly, agent-to-agent. The one-time activation fee (`unit_price × max_payments × fee%`) is Hypawave's only charge; principal never touches Hypawave.

**Listing in the marketplace.** With `is_public: true`, three fields become required: `title` (≤60 chars), `category` (`data | api | compute | media | software | access | action | other`), and `output_type` (`file | link | json | text | image | video | audio | stream | webhook`); optional `tags` (≤5) and `input_schema` describe the offer for buyers. Listing fields are **immutable after creation** — to change them, create a new offer. Once active, the offer appears in `search_offers` and at [hypawave.com/discover](https://hypawave.com/discover). (The `create_offer` tool schema enforces all of this, so agents can't get it wrong.)

## Wallet (buyers)

Paying requires a wallet that returns the settlement **preimage**. Connect any **NWC-capable** wallet (Coinos, Alby Hub, Primal, LNbits, …) via `NWC_URL` — the NWC spec guarantees `pay_invoice` returns the preimage, so any NWC wallet works.

**No wallet configured? Manual mode.** `buy_offer` / `pay_invoice` return the bolt11; pay it with any preimage-returning wallet and submit the preimage via `confirm_payment` (or re-call `pay_invoice` with it).

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `NWC_URL` | no | Nostr Wallet Connect string for automatic payments. Absent → manual mode. |
| `HYPAWAVE_MAX_SPEND_SATS` | no | Per-payment cap enforced in code. Unset → derived live from the platform's `max_invoice_usd` at the current BTC price (so the default never blocks a platform-allowed amount). Payments above it are refused. |
| `HYPAWAVE_PRIVKEY` | no | 64-char hex secp256k1 key = your seller identity. Auto-generated to `~/.hypawave/identity.json` (0600) if unset. **Back it up — it controls your offers.** |
| `HYPAWAVE_API_URL` | no | API base (default `https://hypawave.com`). |

## Safety model

- **Spending cap**: every principal/fee payment is checked against the effective cap before paying — `HYPAWAVE_MAX_SPEND_SATS` if set, otherwise the platform's own `max_invoice_usd` converted at the live BTC price. The bolt11 amount is cross-checked against the server quote. Per-purchase bounds via `expected_max_sats`.
- **Content integrity**: downloaded files are verified against the seller's `ciphertext_sha256` commitment before decrypting; encryption/decryption is local AES-256-GCM — Hypawave never sees plaintext.
- **Non-custodial**: principal flows buyer→seller wallet-to-wallet. Settlement is final — no refunds. `payment_count` on marketplace offers is sales volume, not a trust score.

Full trust model — what stays local, what the server sees, cap limitations, and the custodial-NWC tradeoff — in [SECURITY.md](./SECURITY.md).

## Authoritative references

- Operating manual: https://hypawave.com/llms.txt
- OpenAPI spec: https://hypawave.com/.well-known/openapi.json
- Docs: https://hypawave.com/docs · Architecture: https://hypawave.com/architecture

## Development

```bash
npm install
npm test          # vitest unit suite (signer verified against the published llms.txt test vector)
npm run build     # tsup → dist/
node scripts/smoke.mjs   # LIVE end-to-end purchase of the 100-sat compute demo (spends real sats; needs NWC_URL)
```

MIT
