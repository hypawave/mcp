import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createCoinosWallet, getFundingOptions } from "../coinos.js";
import {
  getNwcSource,
  getNwcUrl,
  readWalletFile,
  saveWalletFile,
  walletFileExists,
  walletFilePath,
} from "../config.js";
import { getBalanceSats } from "../nwc.js";
import { jsonResult } from "../util.js";

/** Operator-facing options — present verbatim so the human decides with full context. */
const OPERATOR_OPTIONS = [
  "To buy things automatically, your agent needs a Lightning wallet it can spend from. Three options:",
  "1. CREATE ONE NOW (recommended for getting started) — creates a hosted wallet at coinos.io (think prepaid card: funds are held by that service, so keep only small amounts, e.g. $10–20 worth of sats; the operator spending cap applies to every payment). Credentials are generated and stored only on this machine — Hypawave's servers never receive them.",
  "2. CONNECT YOUR OWN WALLET — if you already use an NWC-capable wallet (Alby Hub, Coinos, Primal, LNbits, your own node), tell the agent which one and it will walk you through copying its NWC connection string; no account is created anywhere. Note: self-hosted nodes need channel liquidity even for tiny payments.",
  "3. SKIP — purchases will return a Lightning invoice to pay manually from any wallet (you'll also need the preimage from your wallet to confirm — fine for testing, clunky as a routine).",
].join("\n");

/** Per-wallet steps for finding the NWC connection string — served so the agent doesn't improvise them. */
const NWC_WALLET_GUIDE = [
  "Ask the operator which wallet they use, then give them the matching steps to copy its NWC connection string (starts with nostr+walletconnect://):",
  "- Alby Hub: App Store (or Settings) → Connections → Add connection → set a budget → copy the connection secret.",
  "- Coinos (existing account): coinos.io → Settings → Nostr Wallet Connect (Apps) → create/copy the connection string.",
  "- Primal: Wallet → Settings → Connected apps → New connection → copy the string.",
  "- LNbits: enable the NWC Service extension on your wallet → create a connection → copy the pairing URL.",
  "- Self-hosted node (LND/CLN): run an NWC bridge (e.g. Alby Hub connected to the node) and create a connection there. Reminder: the node needs outbound channel liquidity.",
  "Then re-call setup_wallet with {action:'connect_own', nwc_url:'<the string>'}.",
].join("\n");

const NWC_URI_RE = /^nostr\+walletconnect:\/\/[0-9a-f]{64}\?/i;

async function tryBalance(): Promise<{ balance_sats: number | null; wallet_error?: string }> {
  try {
    const balance_sats = await Promise.race<number>([
      getBalanceSats(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out after 15s")), 15_000)),
    ]);
    return { balance_sats };
  } catch (e) {
    return { balance_sats: null, wallet_error: e instanceof Error ? e.message : String(e) };
  }
}

export function registerSetupWalletTools(server: McpServer) {
  server.registerTool(
    "setup_wallet",
    {
      title: "Set up the agent's Lightning wallet",
      description:
        "One-time wallet setup so purchases can pay automatically. Call with no arguments first: it returns the " +
        "operator-facing options — present them to the operator verbatim and let them choose; do not choose for them. " +
        "Then call {action:'create_hosted', confirm:true} ONLY after the operator explicitly agreed (creates a hosted " +
        "custodial wallet at coinos.io; credentials are stored locally in ~/.hypawave/wallet.json and never sent to " +
        "Hypawave), or {action:'connect_own'} to use an existing NWC wallet — without nwc_url it returns per-wallet " +
        "steps to help the operator find their connection string. " +
        "Also: {action:'funding_options', amount_sats?} returns operator-facing funding instructions for the " +
        "configured wallet (instant Lightning invoice/address + on-chain deposit address for exchanges without " +
        "Lightning, e.g. Robinhood) — present them verbatim whenever the wallet needs sats. " +
        "The NWC_URL env var, when set, always takes precedence over anything configured here.",
      inputSchema: {
        action: z
          .enum(["create_hosted", "connect_own", "funding_options"])
          .optional()
          .describe("Omit to get the options to present to the operator"),
        confirm: z
          .boolean()
          .optional()
          .describe("Required true for create_hosted — set only after the operator explicitly agreed"),
        nwc_url: z.string().optional().describe("For connect_own: the wallet's NWC connection string"),
        amount_sats: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("For funding_options: mint an exact-amount Lightning funding invoice for this many sats"),
      },
    },
    async ({ action, confirm, nwc_url, amount_sats }) => {
      const envSet = Boolean(process.env.NWC_URL || process.env.HYPAWAVE_NWC_URL);

      if (action === "funding_options") {
        if (!getNwcUrl()) {
          return jsonResult({
            ok: false,
            message: "No wallet configured yet — run setup_wallet first, then request funding options.",
          });
        }
        const funding = await getFundingOptions(amount_sats);
        return jsonResult({ ok: true, ...funding });
      }

      if (!action) {
        const configured = Boolean(getNwcUrl());
        return jsonResult({
          configured,
          source: getNwcSource(),
          ...(configured
            ? { message: "A wallet is already configured — no setup needed. Call wallet_status for the balance." }
            : { present_to_operator: OPERATOR_OPTIONS }),
        });
      }

      if (envSet) {
        return jsonResult({
          ok: false,
          message:
            "NWC_URL is set in the environment and always takes precedence — unset it in the MCP config first if you want a different wallet.",
        });
      }

      if (action === "connect_own") {
        if (!nwc_url) {
          return jsonResult({
            ok: false,
            needs_nwc_url: true,
            present_to_operator: NWC_WALLET_GUIDE,
          });
        }
        if (!NWC_URI_RE.test(nwc_url) || !/[?&]secret=[0-9a-f]{64}/i.test(nwc_url)) {
          throw new Error(
            "connect_own requires a valid NWC connection string: nostr+walletconnect://<64-hex-pubkey>?relay=…&secret=<64-hex>. " +
              "Call {action:'connect_own'} without nwc_url for per-wallet steps to find it."
          );
        }
        if (walletFileExists()) {
          throw new Error(
            `${walletFilePath()} already exists and may hold a funded wallet's only credentials — back it up and remove it manually first.`
          );
        }
        const path = saveWalletFile({
          provider: "custom",
          nwc_url,
          created_at: new Date().toISOString(),
        });
        const check = await tryBalance();
        return jsonResult({
          ok: true,
          provider: "custom",
          saved_to: path,
          connection_verified: check.balance_sats !== null,
          ...check,
          next:
            check.balance_sats !== null
              ? "Wallet connected — purchases now pay automatically under the spending cap."
              : "Saved, but the connection could not be verified yet — check the NWC string and wallet, then call wallet_status.",
        });
      }

      // action === "create_hosted"
      if (walletFileExists()) {
        const existing = readWalletFile();
        return jsonResult({
          ok: true,
          already_exists: true,
          provider: existing?.provider ?? "unknown",
          lightning_address: existing?.lightning_address ?? null,
          credentials_file: walletFilePath(),
          message: "A wallet file already exists — reusing it. Fund it or remove the file manually to start over.",
        });
      }
      if (!confirm) {
        return jsonResult({
          ok: false,
          needs_confirmation: true,
          present_to_operator: OPERATOR_OPTIONS,
          message:
            "create_hosted opens a custodial account at coinos.io in the operator's name. Present the options above, and retry with confirm:true only after the operator explicitly chose option 1.",
        });
      }

      const wallet = await createCoinosWallet();
      const path = saveWalletFile(wallet);
      const funding = await getFundingOptions().catch(() => null);
      return jsonResult({
        ok: true,
        provider: "coinos",
        lightning_address: wallet.lightning_address,
        credentials_file: path,
        ...(funding ? { funding } : {}),
        next:
          `Fund it now (start small — 5,000–50,000 sats): present the funding options above to the operator verbatim — ` +
          `instant via Lightning (Cash App, Coinbase, or any Lightning wallet), or on-chain from an exchange without ` +
          `Lightning (e.g. Robinhood; slower, mining fees). Then wallet_status shows the balance and purchases pay ` +
          `automatically under the spending cap.`,
        important: `Custodial wallet — coinos.io holds the funds; keep only small amounts. ${path} contains the ONLY copy of the credentials: back it up, and never delete it while the wallet holds funds.`,
      });
    }
  );
}
