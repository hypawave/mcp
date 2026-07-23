# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.3.0] - 2026-07-22

### Added

- **Operator funding options** — `setup_wallet {action:"funding_options", amount_sats?}` returns operator-facing funding instructions to present verbatim: an exact-amount Lightning invoice (payable from Cash App, Coinbase, or any Lightning wallet) or the wallet's Lightning address, plus an on-chain deposit address for exchanges without Lightning (e.g. Robinhood; 300-sat Coinos dust minimum surfaced). Hosted-wallet creation now returns the same funding block, and insufficient-balance NWC payment errors point the agent at the action.
- **Per-wallet NWC guidance** — `setup_wallet {action:"connect_own"}` without `nwc_url` now returns wallet-specific steps (Alby Hub, Coinos, Primal, LNbits, self-hosted node) for finding the connection string, instead of erroring; operator option 2 tells the agent to ask which wallet the operator uses.
- Coinos registration JWT (no expiry) is persisted in `~/.hypawave/wallet.json` (`token`) to mint funding invoices and on-chain addresses later; new `createFundingInvoice()` / `getOnchainAddress()` client helpers (`POST /invoice`, types `lightning` / `bitcoin`).

## [0.2.0] - 2026-07-06

### Added

- `setup_wallet` tool (16 tools total): agent-driven wallet provisioning. `create_hosted` registers a fresh Coinos account (registration auto-creates the NWC connection; requires explicit operator consent via `confirm: true`) and saves credentials to `~/.hypawave/wallet.json` (0600, local-only — Hypawave servers never receive them). `connect_own` saves an existing NWC string instead and live-verifies it with a balance probe. Called with no arguments, it returns operator-facing options to present verbatim.
- `getNwcUrl()` now falls back to `~/.hypawave/wallet.json` when `NWC_URL` / `HYPAWAVE_NWC_URL` are unset (env always wins). `wallet_status` and the startup log report the config source; manual-mode messages point to `setup_wallet`.
- `COINOS_API_URL` env var (default `https://coinos.io/api`).

### Security

- Wallet file is written 0600 and never overwritten while it exists (it may hold a funded wallet's only credentials); corrupt files degrade to manual mode instead of throwing.

## [0.1.2] - 2026-07-02

### Added

- `server.json` + `mcpName` in package.json — MCP Registry (registry.modelcontextprotocol.io) publication metadata under `io.github.hypawave/mcp`.

## [0.1.1] - 2026-07-02

### Added

- README: "Listing in the marketplace" section — required fields, enums, limits, and immutability when `is_public: true`.
- README: link to SECURITY.md from the Safety model section.

## [0.1.0] - 2026-07-02

### Added

- Initial release: local stdio MCP server exposing the Hypawave accountless paths (3a/3b) as 15 tools.
- Buyer tools: `search_offers`, `get_offer`, `buy_offer`, `confirm_payment`, `download_files`, `pay_invoice`, `get_receipt`, `check_payment`.
- Seller tools: `create_offer`, `attach_file`, `manage_offer`, `create_invoice`, `my_offers`, `list_sales`.
- Utility: `wallet_status`.
- NWC (Nostr Wallet Connect) payment support with automatic preimage capture; manual bolt11 fallback when no wallet is configured.
- Operator spending cap enforced in code with bolt11 amount cross-check: `HYPAWAVE_MAX_SPEND_SATS`, defaulting to the platform's live `max_invoice_usd` (converted at the current BTC price) when unset.
- secp256k1 pubkey-signature auth (llms.txt spec, verified against the published test vector); identity auto-generated to `~/.hypawave/identity.json`.
- Client-side AES-256-GCM encrypt/decrypt with `ciphertext_sha256` content-commitment verification.
- Activation settlement handling: after paying an activation/renewal fee, seller tools wait on `activation_window_end` (the authoritative payability signal) and nudge the settlement fallback if the payment webhook is slow — results report `activated` + `activation_window_end`.
