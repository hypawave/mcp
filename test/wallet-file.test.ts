import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const NWC = `nostr+walletconnect://${"a".repeat(64)}?relay=wss%3A%2F%2Frelay.coinos.io&secret=${"b".repeat(64)}`;

let home: string;
let config: typeof import("../src/config.js");

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "hw-wallet-test-"));
  vi.stubEnv("HOME", home);
  delete process.env.NWC_URL;
  delete process.env.HYPAWAVE_NWC_URL;
  vi.resetModules(); // config resolves ~/.hypawave at import time
  config = await import("../src/config.js");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("wallet file persistence", () => {
  it("save → read roundtrip, 0600 perms, and getNwcUrl fallback", () => {
    expect(config.getNwcUrl()).toBeUndefined();
    expect(config.getNwcSource()).toBeNull();

    const path = config.saveWalletFile({ provider: "coinos", nwc_url: NWC, username: "hwabc" });
    expect(path).toBe(join(home, ".hypawave", "wallet.json"));
    expect(statSync(path).mode & 0o777).toBe(0o600);

    expect(config.readWalletFile()?.username).toBe("hwabc");
    expect(config.getNwcUrl()).toBe(NWC);
    expect(config.getNwcSource()).toBe("wallet_file");
    expect(JSON.parse(readFileSync(path, "utf8")).provider).toBe("coinos");
  });

  it("env NWC_URL wins over the wallet file", () => {
    config.saveWalletFile({ provider: "custom", nwc_url: NWC });
    vi.stubEnv("NWC_URL", "nostr+walletconnect://envwins?secret=x");
    expect(config.getNwcUrl()).toBe("nostr+walletconnect://envwins?secret=x");
    expect(config.getNwcSource()).toBe("env");
  });

  it("corrupt or wrong-shape wallet files read as absent, but still exist", () => {
    const path = join(home, ".hypawave", "wallet.json");
    config.saveWalletFile({ provider: "custom", nwc_url: NWC });
    writeFileSync(path, "{not json");
    expect(config.readWalletFile()).toBeUndefined();
    expect(config.getNwcUrl()).toBeUndefined();
    expect(config.walletFileExists()).toBe(true); // guard against overwriting a funded wallet's file

    writeFileSync(path, JSON.stringify({ nwc_url: "https://not-nwc" }));
    expect(config.readWalletFile()).toBeUndefined();
  });
});
