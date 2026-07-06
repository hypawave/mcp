import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hw } from "../api.js";
import { getNwcSource, getPubKey } from "../config.js";
import { getBalanceSats, nwcConfigured } from "../nwc.js";
import { getSpendCapSats, jsonResult } from "../util.js";

export function registerWalletTools(server: McpServer) {
  server.registerTool(
    "wallet_status",
    {
      title: "Wallet, identity, and platform settings",
      description:
        "Reports the operator wallet state (NWC configured? spendable balance in sats), your seller identity pubkey, " +
        "the operator spending cap, and Hypawave's live public settings (fee_percent, min_fee_sats, limits, BTC price). " +
        "Call this first to know whether payments can be made automatically and what fees to expect.",
      inputSchema: {},
    },
    async () => {
      const settings = await hw("/api/public-settings").catch((e) => ({ error: String(e) }));

      let balance_sats: number | null = null;
      let wallet_error: string | undefined;
      if (nwcConfigured()) {
        try {
          balance_sats = await getBalanceSats();
        } catch (e) {
          wallet_error = e instanceof Error ? e.message : String(e);
        }
      }

      let seller_pubkey: string | null = null;
      let identity_error: string | undefined;
      try {
        seller_pubkey = getPubKey();
      } catch (e) {
        identity_error = e instanceof Error ? e.message : String(e);
      }

      return jsonResult({
        wallet: {
          nwc_configured: nwcConfigured(),
          source: getNwcSource(),
          balance_sats,
          ...(wallet_error ? { error: wallet_error } : {}),
          mode: nwcConfigured()
            ? "automatic payments"
            : "manual mode — tools return bolt11s to pay externally; call setup_wallet to configure a wallet",
        },
        spending_cap: await getSpendCapSats().catch((e) => ({ error: String(e) })),
        seller_pubkey,
        ...(identity_error ? { identity_error } : {}),
        platform_settings: settings,
      });
    }
  );
}
