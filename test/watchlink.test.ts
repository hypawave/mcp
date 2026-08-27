import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PRIVKEY = "1".repeat(64);
const PEER_A = "02c7a52b5730927d0dbdb4a263043d9352332ceb04f86078a1f7c61397772a190d";
const PEER_B = "03f66a38f61cb7c58049966a647d0d5c7d4cf9f80eac5314e638a775b0819db0dd";

const mockFetch = vi.fn();
let home: string;
let tools: Record<string, any>;
let config: typeof import("../src/config.js");

/** A fresh Response per call — a Response body can only be read once. */
const json = (body: unknown) => () =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const payload = (res: any) => JSON.parse(res.content[0].text);

/** Identity present, notification hint already spent — isolates the watch-link nudge. */
function seed(opts: { hooked?: boolean } = {}) {
  mkdirSync(join(home, ".hypawave"), { recursive: true });
  writeFileSync(join(home, ".hypawave", "identity.json"), JSON.stringify({ privkey: PRIVKEY }));
  writeFileSync(
    join(home, ".hypawave", "inbox-cursor.json"),
    JSON.stringify({ announced_at: "2026-01-01T00:00:00Z", hook_hint_at: "2026-01-01T00:00:00Z" })
  );
  if (opts.hooked) mkdirSync(join(home, ".claude"), { recursive: true });
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "hw-watchlink-"));
  vi.stubEnv("HOME", home);
  delete process.env.HYPAWAVE_PRIVKEY;
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockReset();
  vi.resetModules();
  config = await import("../src/config.js");
  const mod = await import("../src/tools/waves.js");
  tools = {};
  mod.registerWaveTools({
    registerTool: (name: string, _d: unknown, handler: any) => {
      tools[name] = handler;
    },
  } as any);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

describe("watch link hint", () => {
  it("offers once after a first send, then never again for that peer", async () => {
    seed();
    mockFetch.mockImplementation(json({ id: "m1", created_at: "2026-08-27T00:00:00Z" }));

    const first = payload(await tools.send_wave({ to: PEER_A, body: "hi" }));
    expect(first.watch_link_hint).toContain("get_wave_link");
    expect(first.watch_link_hint).toContain("READ-ONLY");

    const second = payload(await tools.send_wave({ to: PEER_A, body: "again" }));
    expect(second.watch_link_hint).toBeUndefined();
  });

  it("offers separately for a different peer", async () => {
    seed();
    mockFetch.mockImplementation(json({ id: "m1", created_at: "2026-08-27T00:00:00Z" }));
    await tools.send_wave({ to: PEER_A, body: "hi" });
    const other = payload(await tools.send_wave({ to: PEER_B, body: "hi" }));
    expect(other.watch_link_hint).toContain("get_wave_link");
  });

  it("offers on the RECEIVING side too — the case nothing else covers", async () => {
    seed();
    mockFetch.mockImplementation(json({ messages: [{ sender_side: PEER_A }], pending_transfers: [] }));
    const res = payload(await tools.check_inbox({}));
    expect(res.watch_link_hint).toContain("get_wave_link");
  });

  it("never stacks two nudges — notifications win, watch link waits its turn", async () => {
    seed({ hooked: true });
    // Clear the spent notification hint so it fires this call.
    config.saveInboxState({ announced_at: "2026-01-01T00:00:00Z" });
    mockFetch.mockImplementation(json({ messages: [{ sender_side: PEER_A }], pending_transfers: [] }));

    const first = payload(await tools.check_inbox({}));
    expect(first.notifications_hint).toBeTruthy();
    expect(first.watch_link_hint).toBeUndefined();

    // Not consumed by the suppressed turn — it is still owed.
    const second = payload(await tools.check_inbox({}));
    expect(second.notifications_hint).toBeUndefined();
    expect(second.watch_link_hint).toContain("get_wave_link");
  });

  it("ignores senders that are not valid pubkeys", async () => {
    seed();
    mockFetch.mockImplementation(json({ messages: [{ sender_side: "../etc/passwd" }], pending_transfers: [] }));
    expect(payload(await tools.check_inbox({})).watch_link_hint).toBeUndefined();
  });

  it("a hint failure never breaks the send", async () => {
    seed();
    mockFetch.mockImplementation(json({ id: "m1" }));
    vi.spyOn(config, "saveInboxState").mockImplementation(() => {
      throw new Error("disk full");
    });
    const res = payload(await tools.send_wave({ to: PEER_A, body: "hi" }));
    expect(res.id).toBe("m1");
  });
});
