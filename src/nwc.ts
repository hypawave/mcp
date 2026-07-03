import { getNwcUrl } from "./config.js";

type NwcClient = {
  payInvoice(args: { invoice: string }): Promise<{ preimage: string; fees_paid?: number }>;
  getBalance(): Promise<{ balance: number }>; // msats
  close(): void;
};

let clientPromise: Promise<NwcClient> | null = null;

export function nwcConfigured(): boolean {
  return Boolean(getNwcUrl());
}

async function getClient(): Promise<NwcClient> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const url = getNwcUrl();
      if (!url) throw new Error("NWC_URL is not set — wallet payments unavailable (manual mode only)");
      // Node < 22 has no global WebSocket; nostr-tools needs one.
      if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
        const ws = await import("ws");
        (globalThis as { WebSocket?: unknown }).WebSocket = ws.default;
      }
      const { nwc } = await import("@getalby/sdk");
      return new nwc.NWCClient({ nostrWalletConnectUrl: url }) as unknown as NwcClient;
    })();
    clientPromise.catch(() => {
      clientPromise = null; // let a later call retry after a failed init
    });
  }
  return clientPromise;
}

/** Pay a bolt11 via the operator's NWC wallet; returns the settlement preimage. */
export async function payBolt11(bolt11: string): Promise<{ preimage: string }> {
  const client = await getClient();
  const result = await client.payInvoice({ invoice: bolt11 });
  if (!result?.preimage || !/^[0-9a-fA-F]{64}$/.test(result.preimage)) {
    throw new Error(
      "wallet paid (or attempted) but returned no valid preimage — cannot prove settlement; check the payment in your wallet before retrying"
    );
  }
  return { preimage: result.preimage.toLowerCase() };
}

export async function getBalanceSats(): Promise<number> {
  const client = await getClient();
  const { balance } = await client.getBalance();
  return Math.floor(balance / 1000);
}
