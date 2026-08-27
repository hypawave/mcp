import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { jsonResult } from "../util.js";
import { readInboxState, saveInboxState } from "../config.js";

// Wave notifications: register `hypawave inbox` as a client lifecycle hook so
// inbound waves surface in the operator's session instead of waiting until
// someone thinks to check.
//
// Why a tool and not automatic on server start: this writes to the operator's
// harness config. An MCP server that silently rewrites settings.json is
// exactly the behaviour people rightly distrust. Routing it through a tool
// call means the host's permission prompt gates it and the operator sees it.
//
// npx (not an absolute path to this bundle) because the bundle path moves on
// reinstall and a stale path fails silently — costs ~150ms per invocation.

const HOOK_COMMAND = "npx -y @hypawave/mcp inbox";
const CURSOR_HOOK_COMMAND = `${HOOK_COMMAND} --format=cursor`;
const GEMINI_HOOK_COMMAND = `${HOOK_COMMAND} --format=gemini`;
/** Identifies our entries for idempotent re-writes and clean removal. */
const HOOK_MARKER = "@hypawave/mcp inbox";
const HOOK_TIMEOUT_SEC = 10;

// The hook tells the agent to call check_inbox. That tool only exists where
// this MCP server is registered, and registration is per-project in most
// clients — so a global hook plus a project-scoped server means the agent gets
// told to call a tool it does not have, and (because the inbox cursor advances
// on read) nothing re-announces it. Register the server at USER scope wherever
// we install the hook, so the announcement and the ability to act on it always
// travel together.
const MCP_SERVER_NAME = "hypawave";
const MCP_COMMAND = "npx";
const MCP_ARGS = ["-y", "@hypawave/mcp"];
/** Delimits our block in Codex's TOML, so we never touch anything outside it. */
const TOML_BEGIN = "# >>> hypawave mcp (managed by enable_wave_notifications) >>>";
const TOML_END = "# <<< hypawave mcp <<<";

type ClientId = "claude-code" | "codex" | "cursor" | "gemini";

interface Target {
  id: ClientId;
  label: string;
  /** Presence of this directory means the client is installed for this user. */
  markerDir: string;
  configPath: string;
  events: string;
  /** Where this client keeps USER-scope MCP server registrations. */
  serverPath: string;
  serverFormat: "json" | "toml";
  /** Claude Code records an explicit transport; the others infer stdio. */
  serverTyped?: boolean;
}

function targets(): Target[] {
  const home = homedir();
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      markerDir: join(home, ".claude"),
      configPath: join(home, ".claude", "settings.json"),
      events: "SessionStart + UserPromptSubmit",
      // Hooks and MCP servers live in different files here: settings.json holds
      // the hook, ~/.claude.json holds user-scope `mcpServers`.
      serverPath: join(home, ".claude.json"),
      serverFormat: "json",
      serverTyped: true,
    },
    {
      id: "codex",
      label: "Codex",
      markerDir: join(home, ".codex"),
      configPath: join(home, ".codex", "hooks.json"),
      events: "SessionStart + UserPromptSubmit",
      serverPath: join(home, ".codex", "config.toml"),
      serverFormat: "toml",
    },
    {
      id: "cursor",
      label: "Cursor",
      markerDir: join(home, ".cursor"),
      configPath: join(home, ".cursor", "hooks.json"),
      serverPath: join(home, ".cursor", "mcp.json"),
      serverFormat: "json",
      events:
        "sessionStart only (beforeSubmitPrompt cannot inject context). NOTE: Cursor currently drops " +
        "additional_context before it reaches the model — a confirmed, unfixed bug on their side, so this " +
        "is written ready for the fix rather than working today.",
    },
    {
      id: "gemini",
      label: "Gemini CLI",
      markerDir: join(home, ".gemini"),
      configPath: join(home, ".gemini", "settings.json"),
      events: "SessionStart only (requires a recent build — context injection was added late)",
      // Only client where the hook and the server share one file.
      serverPath: join(home, ".gemini", "settings.json"),
      serverFormat: "json",
    },
  ];
}

function readConfig(path: string): { ok: true; data: any } | { ok: false; reason: string } {
  if (!existsSync(path)) return { ok: true, data: {} };
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (!raw) return { ok: true, data: {} };
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, reason: "file is not a JSON object" };
    }
    return { ok: true, data: parsed };
  } catch (e: any) {
    // Never overwrite a file we could not parse — it may hold config we would
    // destroy, and a hand-edited comment or trailing comma is common.
    return { ok: false, reason: `not valid JSON (${e?.message || e})` };
  }
}

function writeConfig(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) copyFileSync(path, `${path}.hypawave.bak`);
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

/** True when a hook entry (any client's shape) is one of ours. */
function isOurs(entry: any): boolean {
  return typeof entry?.command === "string" && entry.command.includes(HOOK_MARKER);
}

/**
 * Claude Code / Codex shape: hooks[Event] is an array of matcher groups, each
 * holding its own `hooks` array. Strips our entries, drops groups left empty,
 * then appends a fresh group — so repeat calls converge rather than stack.
 */
function applyNestedShape(
  cfg: any,
  events: string[],
  enable: boolean,
  command: string,
  timeout: number
): void {
  cfg.hooks ??= {};
  for (const event of events) {
    const groups: any[] = Array.isArray(cfg.hooks[event]) ? cfg.hooks[event] : [];
    const cleaned = groups
      .map((g) => {
        if (!Array.isArray(g?.hooks)) return g;
        return { ...g, hooks: g.hooks.filter((h: any) => !isOurs(h)) };
      })
      .filter((g) => !Array.isArray(g?.hooks) || g.hooks.length > 0);

    if (enable) {
      cleaned.push({ hooks: [{ type: "command", command, timeout }] });
    }
    if (cleaned.length > 0) cfg.hooks[event] = cleaned;
    else delete cfg.hooks[event];
  }
  if (Object.keys(cfg.hooks).length === 0) delete cfg.hooks;
}

/** Cursor shape: version + hooks.sessionStart = flat array of { command }. */
function applyCursorShape(cfg: any, enable: boolean): void {
  cfg.hooks ??= {};
  const existing: any[] = Array.isArray(cfg.hooks.sessionStart) ? cfg.hooks.sessionStart : [];
  const cleaned = existing.filter((h) => !isOurs(h));
  if (enable) cleaned.push({ command: CURSOR_HOOK_COMMAND });

  if (cleaned.length > 0) {
    cfg.hooks.sessionStart = cleaned;
    cfg.version ??= 1;
  } else {
    delete cfg.hooks.sessionStart;
  }
  if (Object.keys(cfg.hooks).length === 0) delete cfg.hooks;
}

function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) copyFileSync(path, `${path}.hypawave.bak`);
  writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`);
}

function serverEntry(typed: boolean): Record<string, unknown> {
  const entry: Record<string, unknown> = { command: MCP_COMMAND, args: [...MCP_ARGS] };
  return typed ? { type: "stdio", ...entry } : entry;
}

/** JSON clients all key user-scope servers off a top-level `mcpServers` map. */
function applyServerJson(cfg: any, enable: boolean, typed: boolean): void {
  if (enable) {
    cfg.mcpServers ??= {};
    cfg.mcpServers[MCP_SERVER_NAME] = serverEntry(typed);
    return;
  }
  if (cfg.mcpServers && typeof cfg.mcpServers === "object") {
    delete cfg.mcpServers[MCP_SERVER_NAME];
    if (Object.keys(cfg.mcpServers).length === 0) delete cfg.mcpServers;
  }
}

function serverInstalledJson(cfg: any): boolean {
  const entry = cfg?.mcpServers?.[MCP_SERVER_NAME];
  return !!entry && typeof entry === "object";
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripTomlBlock(raw: string): string {
  const re = new RegExp(`\\n?${escapeRe(TOML_BEGIN)}[\\s\\S]*?${escapeRe(TOML_END)}\\n?`, "g");
  return raw.replace(re, "\n");
}

function tomlHasOurBlock(raw: string): boolean {
  return raw.includes(TOML_BEGIN);
}

/**
 * A hand-written [mcp_servers.hypawave] outside our markers. Appending ours
 * would duplicate the key and make the whole file unparseable, so we skip
 * instead — the operator already has what they need.
 */
function tomlHasForeignServer(raw: string): boolean {
  const re = new RegExp(`^\\s*\\[mcp_servers\\.${escapeRe(MCP_SERVER_NAME)}\\]`, "m");
  return re.test(stripTomlBlock(raw));
}

/**
 * Codex uses TOML, and we have no TOML parser. Marker-delimited append keeps
 * this honest: we only ever add or remove text between our own markers and
 * never rewrite the operator's config.
 */
function applyServerToml(raw: string, enable: boolean): string {
  const stripped = stripTomlBlock(raw).replace(/\n{3,}/g, "\n\n");
  if (!enable) return stripped.trimEnd();

  const args = MCP_ARGS.map((a) => JSON.stringify(a)).join(", ");
  const block =
    `${TOML_BEGIN}\n` +
    `[mcp_servers.${MCP_SERVER_NAME}]\n` +
    `command = ${JSON.stringify(MCP_COMMAND)}\n` +
    `args = [${args}]\n` +
    TOML_END;

  const base = stripped.trimEnd();
  return base.length > 0 ? `${base}\n\n${block}` : block;
}

type ServerResult = { config: string; status: string; reason?: string };

/**
 * Register (or remove) the MCP server in its own file. Gemini is handled by the
 * caller instead, because there the server shares a file with the hook and two
 * read-modify-write passes would clobber each other.
 */
function handleServer(t: Target, action: "enable" | "disable" | "status"): ServerResult {
  const path = t.serverPath;

  if (t.serverFormat === "toml") {
    const raw = readText(path);
    if (action === "status") {
      return { config: path, status: tomlHasOurBlock(raw) ? "enabled" : "not_enabled" };
    }
    if (action === "enable" && tomlHasForeignServer(raw)) {
      return {
        config: path,
        status: "skipped",
        reason: `[mcp_servers.${MCP_SERVER_NAME}] is already defined by hand — left untouched`,
      };
    }
    try {
      writeText(path, applyServerToml(raw, action === "enable"));
    } catch (e: any) {
      return { config: path, status: "failed", reason: e?.message || String(e) };
    }
    return { config: path, status: action === "enable" ? "enabled" : "disabled" };
  }

  const read = readConfig(path);
  if (read.ok !== true) return { config: path, status: "skipped", reason: read.reason };
  if (action === "status") {
    return { config: path, status: serverInstalledJson(read.data) ? "enabled" : "not_enabled" };
  }
  applyServerJson(read.data, action === "enable", !!t.serverTyped);
  try {
    writeConfig(path, read.data);
  } catch (e: any) {
    return { config: path, status: "failed", reason: e?.message || String(e) };
  }
  return { config: path, status: action === "enable" ? "enabled" : "disabled" };
}

function hookInstalled(cfg: any, target: Target): boolean {
  const hooks = cfg?.hooks;
  if (!hooks || typeof hooks !== "object") return false;
  const flatten = (v: any): any[] =>
    Array.isArray(v) ? v.flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks : [g])) : [];
  return Object.values(hooks).some((v) => flatten(v).some(isOurs));
}

/**
 * One-time nudge, returned from check_inbox.
 *
 * The problem it solves: an operator who already had the MCP installed never
 * sees the contact card, and the first-run address notice cannot help because
 * it only fires once a hook exists. check_inbox is the one call every existing
 * agent already makes each session, so it is the only place guaranteed to
 * reach the people who need telling.
 *
 * Silent unless a supported client is actually present and has no hook yet —
 * no point offering this to Claude Desktop, which cannot run hooks at all.
 * Said once, then never again: a declined offer must not become nagging.
 */
export function consumeNotificationHint(): string | null {
  try {
    const state = readInboxState();
    if (state.hook_hint_at) return null;

    const present = targets().filter((t) => existsSync(t.markerDir));
    if (present.length === 0) return null;

    const alreadyOn = present.some((t) => {
      const read = readConfig(t.configPath);
      return read.ok === true && hookInstalled(read.data, t);
    });
    if (alreadyOn) return null;

    saveInboxState({ ...state, hook_hint_at: new Date().toISOString() });
    // Written for the AGENT, but the operator is the one who hears it — and
    // an operator who has never used waves does not know what "waves" means.
    // So: explain the capability in plain terms, then give a sentence they
    // can actually be asked.
    return (
      "Hypawave waves let another person's agent reach you directly — messages, encrypted file handoffs, " +
      "and Lightning-settled deliveries — using an address your operator can share like a phone number. " +
      "Right now those arrive silently: nothing surfaces until check_inbox is run. " +
      `enable_wave_notifications fixes that by adding a ${present.map((t) => t.label).join(" / ")} startup hook.\n\n` +
      "Offer it to your operator ONCE, in one line, in plain words — do not use the term \"waves\" unless they " +
      "already have. For example: \"I can be notified when someone else's agent sends you a message or a file, " +
      "instead of only finding out when I check. Want me to turn that on? It adds a line to your client config " +
      "and takes effect after a restart.\"\n\n" +
      "If they say no, drop it and never raise it again — you will not be reminded."
    );
  } catch {
    // A hint is a nicety; never let it break an inbox read.
    return null;
  }
}

export function registerNotificationTools(server: McpServer) {
  server.registerTool(
    "enable_wave_notifications",
    {
      title: "Surface incoming waves in your operator's session",
      description:
        "Register (or remove) a lifecycle hook so new wave messages and pending file transfers are surfaced at " +
        "session start and on the operator's next prompt, instead of sitting unseen until someone runs check_inbox. " +
        "Also registers this MCP server at USER scope for the same clients, so check_inbox exists in every project " +
        "the hook fires in — without that the hook tells the agent to call a tool it does not have. " +
        "Use when your operator asks to be notified about incoming agent messages. This EDITS their client config " +
        "(Claude Code settings.json + ~/.claude.json, Codex hooks.json + config.toml, Cursor hooks.json + mcp.json, " +
        "Gemini settings.json) — ask them first, report exactly what changed, and note that a backup is written " +
        "alongside each file. Run with action='status' to report the current state without writing anything.",
      inputSchema: {
        action: z.enum(["enable", "disable", "status"]).default("enable"),
        client: z
          .enum(["auto", "claude-code", "codex", "cursor", "gemini"])
          .default("auto")
          .describe("'auto' targets every client detected on this machine"),
      },
    },
    async ({ action, client }) => {
      const all = targets();
      const selected = client === "auto" ? all.filter((t) => existsSync(t.markerDir)) : all.filter((t) => t.id === client);

      if (selected.length === 0) {
        return jsonResult({
          action,
          changed: [],
          note:
            client === "auto"
              ? "No supported client config directory found (~/.claude, ~/.codex, ~/.cursor, ~/.gemini). Name a client explicitly to write anyway."
              : `Unknown client "${client}".`,
        });
      }

      const results = selected.map((t) => {
        // Gemini keeps the hook and the server in one file, so both edits must
        // ride on a single read-modify-write.
        const sharedFile = t.serverPath === t.configPath;
        const read = readConfig(t.configPath);
        if (read.ok !== true) {
          return { client: t.label, config: t.configPath, status: "skipped", reason: read.reason };
        }
        const cfg = read.data;

        if (action === "status") {
          return {
            client: t.label,
            config: t.configPath,
            status: hookInstalled(cfg, t) ? "enabled" : "not_enabled",
            events: t.events,
            server: sharedFile
              ? {
                  config: t.serverPath,
                  status: serverInstalledJson(cfg) ? "enabled" : "not_enabled",
                }
              : handleServer(t, action),
          };
        }

        const enable = action === "enable";
        if (t.id === "cursor") {
          applyCursorShape(cfg, enable);
        } else if (t.id === "gemini") {
          // Same nesting as Claude Code, but timeout is milliseconds there.
          applyNestedShape(cfg, ["SessionStart"], enable, GEMINI_HOOK_COMMAND, HOOK_TIMEOUT_SEC * 1000);
        } else {
          applyNestedShape(cfg, ["SessionStart", "UserPromptSubmit"], enable, HOOK_COMMAND, HOOK_TIMEOUT_SEC);
        }
        if (sharedFile) applyServerJson(cfg, enable, !!t.serverTyped);

        try {
          writeConfig(t.configPath, cfg);
        } catch (e: any) {
          return { client: t.label, config: t.configPath, status: "failed", reason: e?.message || String(e) };
        }

        // Only after the hook landed — registering a server for a hook that
        // failed to write would leave the pair half-installed.
        const server: ServerResult = sharedFile
          ? { config: t.serverPath, status: enable ? "enabled" : "disabled" }
          : handleServer(t, action);

        return {
          client: t.label,
          config: t.configPath,
          status: enable ? "enabled" : "disabled",
          events: enable ? t.events : undefined,
          server,
          backup: existsSync(`${t.configPath}.hypawave.bak`) ? `${t.configPath}.hypawave.bak` : undefined,
        };
      });

      return jsonResult({
        action,
        command: HOOK_COMMAND,
        server: { name: MCP_SERVER_NAME, command: MCP_COMMAND, args: MCP_ARGS },
        results,
        note:
          action === "enable"
            ? "Takes effect in NEW sessions — the operator must restart their client. Notifications carry counts and " +
              "sender pubkeys only; call check_inbox to read the actual messages. The server is registered at user " +
              "scope, so check_inbox is available in every project on this machine, but it does not follow the " +
              "operator to another machine — re-run there."
            : undefined,
        unsupported:
          action === "status" || client !== "auto"
            ? undefined
            : "Not reachable by hooks: Claude Desktop (no hook system), Windsurf (no session-start event, and " +
              "show_output does not apply to pre_user_prompt), and Codex's IDE extension / desktop app (hooks fire " +
              "in the CLI only). Those fall back to the agent calling check_inbox.",
      });
    }
  );
}
