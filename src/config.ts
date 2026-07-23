import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex } from "@noble/hashes/utils";

export const API_BASE = process.env.HYPAWAVE_API_URL || "https://hypawave.com";

/** Fallback per-payment cap if the operator set none AND platform settings are unreachable. */
export const FALLBACK_SPEND_CAP_SATS = 50_000;

const KEY_DIR = join(homedir(), ".hypawave");
const KEY_FILE = join(KEY_DIR, "identity.json");
const WALLET_FILE = join(KEY_DIR, "wallet.json");

export interface WalletFile {
  provider: "coinos" | "custom";
  nwc_url: string;
  username?: string;
  password?: string;
  /** Coinos JWT (no expiry) — lets the agent mint funding invoices / on-chain deposit addresses. */
  token?: string;
  lightning_address?: string;
  created_at?: string;
}

/** Env always wins over the locally provisioned wallet file. */
export function getNwcUrl(): string | undefined {
  return process.env.NWC_URL || process.env.HYPAWAVE_NWC_URL || readWalletFile()?.nwc_url;
}

export function getNwcSource(): "env" | "wallet_file" | null {
  if (process.env.NWC_URL || process.env.HYPAWAVE_NWC_URL) return "env";
  if (readWalletFile()) return "wallet_file";
  return null;
}

/**
 * A corrupt/unreadable wallet file yields undefined (manual mode) rather than
 * throwing — but the file is never overwritten while it exists (see
 * walletFileExists guard in setup_wallet), since it may hold the only copy of
 * a funded wallet's credentials.
 */
export function readWalletFile(): WalletFile | undefined {
  try {
    if (!existsSync(WALLET_FILE)) return undefined;
    const parsed = JSON.parse(readFileSync(WALLET_FILE, "utf8"));
    if (typeof parsed?.nwc_url === "string" && parsed.nwc_url.startsWith("nostr+walletconnect://")) {
      return parsed as WalletFile;
    }
  } catch {
    /* fall through */
  }
  return undefined;
}

export function saveWalletFile(wallet: WalletFile): string {
  mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(WALLET_FILE, JSON.stringify(wallet, null, 2), { mode: 0o600 });
  return WALLET_FILE;
}

export function walletFileExists(): boolean {
  return existsSync(WALLET_FILE);
}

export function walletFilePath(): string {
  return WALLET_FILE;
}

/** Operator-set per-payment cap, or null when unset (a platform-derived default applies — see getSpendCapSats). */
export function getMaxSpendSatsEnv(): number | null {
  const raw = process.env.HYPAWAVE_MAX_SPEND_SATS;
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/**
 * Seller identity key. Resolution order:
 * 1. $HYPAWAVE_PRIVKEY (64-char hex)
 * 2. ~/.hypawave/identity.json — auto-generated on first use and persisted
 *    with 0600 perms. The key IS the identity: it controls the seller's
 *    offers and is separate from the payout wallet.
 */
export function getPrivKey(): string {
  const env = process.env.HYPAWAVE_PRIVKEY;
  if (env) {
    if (!/^[0-9a-fA-F]{64}$/.test(env)) {
      throw new Error("HYPAWAVE_PRIVKEY must be a 32-byte hex string (64 chars)");
    }
    return env.toLowerCase();
  }
  if (existsSync(KEY_FILE)) {
    const saved = JSON.parse(readFileSync(KEY_FILE, "utf8"));
    if (typeof saved.privkey === "string" && /^[0-9a-f]{64}$/.test(saved.privkey)) {
      return saved.privkey;
    }
    throw new Error(`Corrupt identity file at ${KEY_FILE} — restore it or set $HYPAWAVE_PRIVKEY`);
  }
  const privkey = generatePrivKey();
  mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(KEY_FILE, JSON.stringify({ privkey, created_at: new Date().toISOString() }, null, 2), {
    mode: 0o600,
  });
  return privkey;
}

export function getPubKey(): string {
  return bytesToHex(secp256k1.getPublicKey(getPrivKey(), true));
}

function generatePrivKey(): string {
  // Rejection-sample until the scalar is a valid secp256k1 private key.
  for (;;) {
    const candidate = randomBytes(32);
    try {
      secp256k1.getPublicKey(candidate, true);
      return bytesToHex(candidate);
    } catch {
      /* out of curve order — retry */
    }
  }
}
