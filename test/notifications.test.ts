import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let home: string;
let call: (args: any) => Promise<any>;

const claudeSettings = () => join(home, ".claude", "settings.json");
const codexHooks = () => join(home, ".codex", "hooks.json");
const cursorHooks = () => join(home, ".cursor", "hooks.json");

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
/** The tool returns an MCP text envelope wrapping JSON. */
const payload = (res: any) => JSON.parse(res.content[0].text);

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "hw-notif-test-"));
  vi.stubEnv("HOME", home);
  vi.resetModules();
  const mod = await import("../src/tools/notifications.js");
  const handlers: Record<string, any> = {};
  mod.registerNotificationTools({
    registerTool: (name: string, _def: unknown, handler: any) => {
      handlers[name] = handler;
    },
  } as any);
  call = handlers.enable_wave_notifications;
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("enable_wave_notifications", () => {
  it("reports no targets when no client is installed", async () => {
    const out = payload(await call({ action: "enable", client: "auto" }));
    expect(out.changed).toEqual([]);
    expect(out.note).toContain("No supported client config directory");
  });

  it("writes both events for Claude Code in the nested matcher-group shape", async () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const out = payload(await call({ action: "enable", client: "auto" }));

    expect(out.results[0]).toMatchObject({ client: "Claude Code", status: "enabled" });
    const cfg = readJson(claudeSettings());
    for (const event of ["SessionStart", "UserPromptSubmit"]) {
      expect(cfg.hooks[event]).toHaveLength(1);
      expect(cfg.hooks[event][0].hooks[0]).toMatchObject({
        type: "command",
        command: "npx -y @hypawave/mcp inbox",
      });
    }
  });

  it("is idempotent — enabling twice leaves exactly one entry per event", async () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    await call({ action: "enable", client: "auto" });
    await call({ action: "enable", client: "auto" });
    const cfg = readJson(claudeSettings());
    expect(cfg.hooks.SessionStart).toHaveLength(1);
    expect(cfg.hooks.UserPromptSubmit).toHaveLength(1);
  });

  it("preserves unrelated settings and unrelated hooks", async () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      claudeSettings(),
      JSON.stringify({
        model: "opus",
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "echo mine" }] }],
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] }],
        },
      })
    );

    await call({ action: "enable", client: "auto" });

    const cfg = readJson(claudeSettings());
    expect(cfg.model).toBe("opus");
    expect(cfg.hooks.PreToolUse[0].hooks[0].command).toBe("guard.sh");
    const commands = cfg.hooks.SessionStart.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(commands).toContain("echo mine");
    expect(commands).toContain("npx -y @hypawave/mcp inbox");
  });

  it("disable removes only our entries and prunes emptied events", async () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      claudeSettings(),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo mine" }] }] } })
    );
    await call({ action: "enable", client: "auto" });
    await call({ action: "disable", client: "auto" });

    const cfg = readJson(claudeSettings());
    expect(JSON.stringify(cfg)).not.toContain("@hypawave/mcp inbox");
    expect(cfg.hooks.SessionStart[0].hooks[0].command).toBe("echo mine");
    // UserPromptSubmit held only our entry, so the key is removed entirely.
    expect(cfg.hooks.UserPromptSubmit).toBeUndefined();
  });

  it("refuses to touch a config it cannot parse", async () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(claudeSettings(), "{ not json,");
    const out = payload(await call({ action: "enable", client: "auto" }));

    expect(out.results[0]).toMatchObject({ status: "skipped" });
    expect(out.results[0].reason).toContain("not valid JSON");
    expect(readFileSync(claudeSettings(), "utf8")).toBe("{ not json,");
  });

  it("backs up an existing config before writing", async () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(claudeSettings(), JSON.stringify({ model: "opus" }));
    await call({ action: "enable", client: "auto" });
    expect(existsSync(`${claudeSettings()}.hypawave.bak`)).toBe(true);
    expect(readJson(`${claudeSettings()}.hypawave.bak`).model).toBe("opus");
  });

  it("uses Cursor's flat shape, session start only, with the cursor format flag", async () => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    await call({ action: "enable", client: "auto" });

    const cfg = readJson(cursorHooks());
    expect(cfg.version).toBe(1);
    expect(cfg.hooks.sessionStart[0].command).toBe("npx -y @hypawave/mcp inbox --format=cursor");
    expect(cfg.hooks.UserPromptSubmit).toBeUndefined();
    expect(cfg.hooks.beforeSubmitPrompt).toBeUndefined();
  });

  it("writes Codex hooks to ~/.codex/hooks.json", async () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    await call({ action: "enable", client: "auto" });
    const cfg = readJson(codexHooks());
    expect(cfg.hooks.SessionStart[0].hooks[0].command).toBe("npx -y @hypawave/mcp inbox");
    expect(cfg.hooks.UserPromptSubmit).toBeDefined();
  });

  it("writes Gemini's matcher-group shape with a millisecond timeout, SessionStart only", async () => {
    mkdirSync(join(home, ".gemini"), { recursive: true });
    await call({ action: "enable", client: "auto" });
    const cfg = readJson(join(home, ".gemini", "settings.json"));
    // Gemini mirrors Claude Code's nesting — NOT a flat array of hooks.
    expect(cfg.hooks.SessionStart[0].hooks[0]).toMatchObject({
      type: "command",
      command: "npx -y @hypawave/mcp inbox --format=gemini",
      timeout: 10000,
    });
    expect(cfg.hooks.UserPromptSubmit).toBeUndefined();
  });

  it("does not offer Windsurf — no session-start event and hooks cannot surface output", async () => {
    mkdirSync(join(home, ".codeium", "windsurf"), { recursive: true });
    const out = payload(await call({ action: "enable", client: "auto" }));
    expect(out.changed).toEqual([]);
    expect(existsSync(join(home, ".codeium", "windsurf", "hooks.json"))).toBe(false);
  });

  it("preserves an existing Gemini settings.json", async () => {
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(join(home, ".gemini", "settings.json"), JSON.stringify({ theme: "dark" }));
    await call({ action: "enable", client: "auto" });
    const cfg = readJson(join(home, ".gemini", "settings.json"));
    expect(cfg.theme).toBe("dark");
    expect(cfg.hooks.SessionStart[0].hooks).toHaveLength(1);
  });

  it("targets every installed client at once", async () => {
    for (const d of [".claude", ".codex", ".cursor", ".gemini"]) mkdirSync(join(home, d), { recursive: true });
    const out = payload(await call({ action: "enable", client: "auto" }));
    expect(out.results.map((r: any) => r.client).sort()).toEqual([
      "Claude Code",
      "Codex",
      "Cursor",
      "Gemini CLI",
    ]);
  });

  it("status reports state without writing a file", async () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    let out = payload(await call({ action: "status", client: "auto" }));
    expect(out.results[0].status).toBe("not_enabled");
    expect(existsSync(claudeSettings())).toBe(false);

    await call({ action: "enable", client: "auto" });
    out = payload(await call({ action: "status", client: "auto" }));
    expect(out.results[0].status).toBe("enabled");
  });

  it("can target a client whose directory does not exist yet when named explicitly", async () => {
    const out = payload(await call({ action: "enable", client: "codex" }));
    expect(out.results[0]).toMatchObject({ client: "Codex", status: "enabled" });
    expect(existsSync(codexHooks())).toBe(true);
  });
});

describe("consumeNotificationHint", () => {
  let hint: () => string | null;

  beforeEach(async () => {
    const mod = await import("../src/tools/notifications.js");
    hint = mod.consumeNotificationHint;
  });

  it("says nothing when no supported client is installed", () => {
    // Claude Desktop and friends cannot run hooks — offering would be noise.
    expect(hint()).toBeNull();
  });

  it("offers once, naming the detected clients, then never again", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });

    const first = hint();
    expect(first).toContain("Claude Code / Codex");
    expect(first).toContain("enable_wave_notifications");
    expect(hint()).toBeNull();
  });

  it("says nothing once a hook is already installed", async () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    await call({ action: "enable", client: "auto" });
    expect(hint()).toBeNull();
  });

  it("stays silent rather than throwing on an unreadable config", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), "{ not json,");
    // Unparseable → we cannot tell if a hook is there, so we still offer.
    expect(hint()).toContain("enable_wave_notifications");
  });
});
