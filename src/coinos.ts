import { randomBytes } from "node:crypto";

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
    nwc_url: nwc,
    lightning_address: `${username}@${new URL(COINOS_API).host}`,
    created_at: new Date().toISOString(),
  };
}
