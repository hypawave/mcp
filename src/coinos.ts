import { randomBytes } from "node:crypto";
import { readWalletFile } from "./config.js";

/**
 * Minimal Coinos client for hosted-wallet provisioning.
 * Coinos registration auto-creates an NWC connection server-side;
 * GET /apps returns it as a ready-made nostr+walletconnect:// string,
 * so no NWC URI construction happens here.
 */
const COINOS_API = process.env.COINOS_API_URL || "https://coinos.io/api";

export interface HostedWallet {
  provider: "coinos";
  username: string;
  password: string;
  /** Coinos JWT (no expiry) — used to mint funding invoices / deposit addresses. */
  token: string;
  nwc_url: string;
  lightning_address: string;
  created_at: string;
}

async function coinos<T>(
  path: string,
  opts: { token?: string; body?: unknown } = {}
): Promise<T> {
  const res = await fetch(`${COINOS_API}${path}`, {
    method: opts.body ? "POST" : "GET",
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`coinos ${path}: HTTP ${res.status}${text ? ` — ${text.slice(0, 200)}` : ""}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`coinos ${path}: non-JSON response`);
  }
}

/**
 * Register a fresh Coinos account and return its wallet credentials.
 * The username/password pair is the only way to access the account later —
 * the caller is responsible for persisting it.
 */
export async function createCoinosWallet(): Promise<HostedWallet> {
  // Coinos usernames: letters+numbers only, 2–24 chars.
  const username = `hw${randomBytes(6).toString("hex")}`;
  const password = randomBytes(24).toString("base64url");

  const { token } = await coinos<{ token?: string }>("/register", {
    body: { user: { username, password } },
  });
  if (!token) throw new Error("coinos /register returned no auth token");

  const apps = await coinos<Array<{ nwc?: string }>>("/apps", { token });
  const nwc = apps?.find((a) => typeof a?.nwc === "string")?.nwc;
  if (!nwc || !nwc.startsWith("nostr+walletconnect://")) {
    throw new Error("coinos returned no NWC connection for the new account");
  }

  return {
    provider: "coinos",
    username,
    password,
    token,
    nwc_url: nwc,
    lightning_address: `${username}@${new URL(COINOS_API).host}`,
    created_at: new Date().toISOString(),
  };
}

/** Mint an exact-amount Lightning funding invoice on the hosted wallet. */
export async function createFundingInvoice(token: string, amountSats: number): Promise<string> {
  const inv = await coinos<{ hash?: string }>("/invoice", {
    token,
    body: { invoice: { type: "lightning", amount: Math.floor(amountSats) } },
  });
  if (!inv?.hash || !inv.hash.toLowerCase().startsWith("ln")) {
    throw new Error("coinos returned no bolt11 for the funding invoice");
  }
  return inv.hash;
}

/**
 * Mint a fresh any-amount on-chain deposit address for the hosted wallet.
 * Coinos silently drops on-chain deposits below 300 sats (dust filter) —
 * callers must surface that minimum to the operator.
 */
export async function getOnchainAddress(token: string): Promise<string> {
  const inv = await coinos<{ hash?: string }>("/invoice", {
    token,
    body: { invoice: { type: "bitcoin", amount: 0 } },
  });
  if (!inv?.hash || !/^(bc1|[13])[a-zA-Z0-9]{20,}$/.test(inv.hash)) {
    throw new Error("coinos returned no on-chain deposit address");
  }
  return inv.hash;
}

export interface FundingOptions {
  present_to_operator: string;
  lightning_invoice?: string;
  lightning_address?: string;
  onchain_address?: string;
}

/**
 * Operator-facing funding options for the configured wallet. Presents both
 * paths (instant Lightning, slower on-chain) with the raw copyable strings.
 * Degrades gracefully: options that cannot be built (custom wallet, API
 * error) are omitted rather than failing the whole prompt.
 */
export async function getFundingOptions(amountSats?: number): Promise<FundingOptions> {
  const wallet = readWalletFile();

  if (!wallet || wallet.provider !== "coinos" || !wallet.token) {
    return {
      present_to_operator: [
        "Fund the agent's Lightning wallet using its own receive/deposit flow (open the wallet app and create a receive invoice or address).",
        "Instant options once you have an invoice: pay it from Cash App, Coinbase, or any Lightning wallet.",
        wallet?.lightning_address
          ? `Or send sats to the wallet's Lightning address: ${wallet.lightning_address}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
      ...(wallet?.lightning_address ? { lightning_address: wallet.lightning_address } : {}),
    };
  }

  const result: FundingOptions = { present_to_operator: "" };
  const lines: string[] = [
    amountSats
      ? `The agent wallet needs a top-up (~${amountSats} sats). Two ways to fund it:`
      : "Two ways to fund the agent wallet:",
  ];

  if (amountSats && amountSats >= 1) {
    try {
      result.lightning_invoice = await createFundingInvoice(wallet.token, amountSats);
    } catch {
      /* fall through to address-only */
    }
  }

  lines.push(
    result.lightning_invoice
      ? `1. INSTANT — pay this Lightning invoice from Cash App, Coinbase, or any Lightning wallet (settles in seconds):\n${result.lightning_invoice}`
      : `1. INSTANT — send sats from any Lightning wallet to the agent's Lightning address: ${wallet.lightning_address}` +
          "\n   (If your app needs an exact-amount invoice — Cash App, Coinbase — ask the agent for one: setup_wallet {action:'funding_options', amount_sats:N}.)"
  );
  result.lightning_address = wallet.lightning_address;

  try {
    result.onchain_address = await getOnchainAddress(wallet.token);
    lines.push(
      `2. FROM AN EXCHANGE WITHOUT LIGHTNING (e.g. Robinhood) — send BTC on-chain to:\n${result.onchain_address}\n   Arrives after confirmation (~10–60 min). Minimum 300 sats; mining fees apply, so best for larger top-ups.`
    );
  } catch {
    lines.push(
      "2. FROM AN EXCHANGE WITHOUT LIGHTNING (e.g. Robinhood) — an on-chain deposit address could not be fetched right now; log in at coinos.io to get one, or use the Lightning option."
    );
  }

  lines.push("The agent will detect the funds and continue automatically.");
  result.present_to_operator = lines.join("\n");
  return result;
}
