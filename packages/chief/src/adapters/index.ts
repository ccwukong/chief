import type { Store } from "../store/store.ts";
import { AntigravityAdapter } from "./antigravity.ts";
import { ClaudeCodeAdapter } from "./claude-code.ts";
import { CodexAdapter } from "./codex.ts";
import { CursorAdapter } from "./cursor.ts";
import { OpenCodeAdapter } from "./opencode.ts";
import type { AgentAdapter } from "./types.ts";

export const ADAPTER_NAMES = ["claude-code", "codex", "cursor", "antigravity", "opencode"] as const;

const ENV_BIN: Record<string, string> = { "claude-code": "CHIEF_CLAUDE_BIN", codex: "CHIEF_CODEX_BIN", cursor: "CHIEF_CURSOR_BIN", antigravity: "CHIEF_ANTIGRAVITY_BIN", opencode: "CHIEF_OPENCODE_BIN" };
const DEFAULT_BIN: Record<string, string> = { "claude-code": "claude", codex: "codex", cursor: "cursor-agent", antigravity: "agy", opencode: "opencode" };

/** CLI path for an adapter: the `<adapter>.path` setting, then the env override, then PATH. */
export function adapterBin(store: Store, name: string): string {
  return store.getSetting<string | null>(`${name}.path`, null) || process.env[ENV_BIN[name]] || DEFAULT_BIN[name];
}

/**
 * Whether this adapter's program was given by an environment variable (`CHIEF_CLAUDE_BIN` and the like)
 * rather than found. Such a value belongs to the process that set it, so detection must not write it into
 * the settings: doing so made a variable sticky, and a later run without it still found the CLI at a path
 * only the first process knew (task 15.19).
 */
export function adapterFromEnv(name: string): boolean {
  return !!process.env[ENV_BIN[name]];
}

export function getAdapter(store: Store, name: string): AgentAdapter {
  return getAdapterByBin(name, adapterBin(store, name));
}

/** The adapter for a program known by path or name, without asking the settings (detection uses it). */
export function getAdapterByBin(name: string, bin: string): AgentAdapter {
  switch (name) {
    case "claude-code": return new ClaudeCodeAdapter(bin);
    case "codex": return new CodexAdapter(bin);
    case "cursor": return new CursorAdapter(bin);
    case "antigravity": return new AntigravityAdapter(bin);
    case "opencode": return new OpenCodeAdapter(bin);
    default: throw new Error(`unknown agent adapter "${name}" (available: ${ADAPTER_NAMES.join(", ")})`);
  }
}

export function availableAdapters(): string[] { return [...ADAPTER_NAMES]; }

/** Statuses in which the agent CLI cannot use a server. `pending` (still connecting) is fine. */
const UNAVAILABLE: Record<string, string> = { "needs-auth": "it needs authentication", failed: "the connection failed", disabled: "it is disabled" };

/**
 * Resolve the names in a node's `mcp:` list against the servers the agent CLI itself reports
 * (chief has no MCP configuration of its own). A name matches the short name (`slack`), a unique
 * prefix of it (`github` → `github-custom`), or the CLI's own name (`claude.ai Slack`).
 * `unknown` lists names the CLI does not have; `errors` also includes servers it is not connected to.
 *
 * `names` undefined means the node is not restricted: it gets every server the CLI can use right
 * now, and a server that is not connected is simply left out (it is not what the node asked for).
 */
/** The servers a node may use, from what its agent CLI reported for the folder the node runs in. */
export function resolveServers(store: Store, adapter: string, names: string[] | undefined, folder: string) {
  const all = store.mcpServers(adapter, folder);
  if (names === undefined) {
    return { servers: all.filter((s) => !UNAVAILABLE[s.config?.status]), all, errors: [] as string[], unknown: [] as string[], unavailable: [] as string[], unrestricted: true };
  }
  const errors: string[] = [];
  const unknown: string[] = [];
  const unavailable: string[] = [];
  const servers = names.flatMap((n) => {
    const hit = all.find((s) => s.name === n) ?? all.find((s) => s.config?.cli_name === n);
    const pre = hit ? [hit] : all.filter((s) => s.name.startsWith(n + "-"));
    if (pre.length === 1) {
      const why = UNAVAILABLE[pre[0].config?.status];
      if (why) {
        unavailable.push(n);
        errors.push(`${adapter} is not connected to MCP server "${pre[0].config?.cli_name ?? pre[0].name}": ${why}${pre[0].config?.detail ? ` (${pre[0].config.detail})` : ""}`);
      }
      return [pre[0]];
    }
    if (pre.length > 1) errors.push(`MCP server "${n}" is ambiguous for ${adapter} (${pre.map((s) => s.name).join(", ")})`);
    else {
      unknown.push(n);
      errors.push(`${adapter} has no MCP server named "${n}"${all.length ? ` (it has: ${all.map((s) => s.name).join(", ")})` : " (it reports no MCP servers)"}`);
    }
    return [];
  });
  return { servers, all, errors, unknown, unavailable, unrestricted: false };
}
