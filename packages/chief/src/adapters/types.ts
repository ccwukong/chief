import type { McpServerRow, Usage } from "../store/types.ts";
import type { ChildIdentity, StopReason } from "../util/proc.ts";

export type AgentEvent =
  /** The exact command line and prompt handed to the CLI, for the run record. */
  | { type: "sent"; argv: string[]; prompt: string }
  | { type: "init"; session_id: string; model?: string; tools?: number }
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input?: unknown }
  | { type: "tool_result"; is_error: boolean; content?: string }
  | { type: "result"; is_error: boolean; cost_usd: number };

export type BuiltinTools = "none" | "read-only" | "default" | string[];

export interface AgentRequest {
  prompt: string;
  /** Continue this CLI session instead of starting a new one. */
  resumeSessionId?: string | null;
  model?: string;
  /** Servers this node may use. */
  servers: McpServerRow[];
  /** True when the node was not restricted: `servers` is simply everything the CLI can use. */
  unrestricted?: boolean;
  /** Every server known for this adapter (the rest are hidden from the node). */
  allServers: McpServerRow[];
  builtinTools: BuiltinTools;
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: string;
  cwd: string;
  timeoutMs?: number;
  onEvent?: (e: AgentEvent) => void;
  shouldStop?: () => StopReason;
  onSpawn?: (child: ChildIdentity) => void;
}

export interface AgentResult {
  /** Final assistant text. */
  text: string;
  sessionId: string | null;
  usage: Usage;
  /** Infrastructure failure: the CLI crashed, timed out or reported an error. */
  error: string | null;
  /** Stopped by pause; the session can be resumed. */
  interrupted: boolean;
  cancelled: boolean;
  denials: string[];
  /** The exact command line, for the run log (the prompt is not part of it). */
  argv: string[];
  /** What the CLI wrote to stderr, for the run record. */
  stderr?: string;
}

export interface ModelChoice { value: string; label: string; description?: string }

export interface AdapterInfo { name: string; found: boolean; path: string | null; version: string | null; minVersion?: string; ok: boolean; note?: string }

/**
 * One change to a CLI's MCP list, expressed in chief's terms rather than that CLI's syntax.
 *
 * chief does not write MCP configuration. Where a CLI has a command for adding or removing a server,
 * chief **runs that command** — the CLI stays the owner of its own file, and the argv is shown to the
 * person before it is executed. A CLI with no such command gets no `mcpWrite` and no button.
 */
export interface McpWriteRequest {
  action: "add" | "remove";
  /** The name the CLI knows the server by. */
  name: string;
  transport?: "stdio" | "http" | "sse";
  /** stdio: the program to run, and its arguments. */
  command?: string;
  args?: string[];
  /** http/sse: the endpoint. */
  url?: string;
  /** `KEY=value` entries, passed through and never stored. */
  env?: string[];
  header?: string[];
  /** A CLI-specific configuration scope: Claude Code's `user` and `local` are different files. */
  scope?: string;
  /** The folder the command runs in: it decides which scope `local` means. */
  cwd: string;
}

/** What will actually be executed, for the person to read before pressing the button. */
export interface McpWritePlan {
  argv: string[];
  /** The same command as one readable line, redacted where a value is a secret. */
  command: string;
  /** Whether this CLI can do it at all, and what it cannot do, in a sentence. */
  note?: string;
}

/**
 * The argv with the *values* of env entries and headers masked, for display.
 *
 * `runProcess` passes argv to `spawn` directly, so a token here is never seen by a shell — but argv is
 * readable by any process via `ps`, which is why a secret is a thing to be careful with rather than a
 * thing to print: the page shows `SLACK_TOKEN=••••` and the real value is only in the process table.
 */
export function redact(argv: string[]): string[] {
  const out = [...argv];
  for (let i = 0; i < out.length - 1; i++) {
    const flag = out[i];
    const next = out[i + 1];
    if ((flag === "-e" || flag === "--env" || flag === "-H" || flag === "--header") && next) {
      const at = next.search(/[=:]/);
      if (at > 0 && at < next.length - 1) out[i + 1] = `${next.slice(0, at + 1)}${"•".repeat(6)}`;
    }
  }
  return out;
}

/**
 * How a CLI authenticates to one of its MCP servers. Two shapes, because OAuth has two:
 * `url` means the CLI prints an authorization URL and takes the redirect back on stdin, so chief can
 * carry the whole flow in its own window; `browser` means the CLI opens the browser itself and chief can
 * only start it and report what happens.
 */
export interface McpAuthPlan {
  argv: string[];
  mode: "url" | "browser";
  /** The same command as one readable line. */
  command: string;
  note?: string;
}

export interface AgentAdapter {
  readonly name: string;
  info(): Promise<AdapterInfo>;
  /** Read the CLI's own MCP configuration. chief never connects to these servers itself. */
  discoverMcp(cwd?: string): Promise<{ name: string; config: any }[]>;
  /**
   * The CLI's own command for adding or removing a server, as argv. Absent when the CLI has no such
   * command (its config file is the only way in), which is what tells the UI to show a snippet instead
   * of a Run button. Building the argv is not running it: the server runs it, and the person sees it first.
   */
  mcpWrite?(req: McpWriteRequest): McpWritePlan;
  /**
   * The CLI's own command for signing in to a server, or out of it. Absent when the CLI has no such
   * command — and, like `mcpWrite`, building the argv is not running it.
   */
  mcpAuth?(req: { action: "login" | "logout"; name: string; cwd: string }): McpAuthPlan | null;
  run(req: AgentRequest): Promise<AgentResult>;
  /** The models this CLI offers, asked from the CLI itself. `note` explains an empty or partial list. */
  listModels(): Promise<{ models: ModelChoice[]; note?: string }>;
}

export const emptyUsage = (): Usage => ({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0, invocations: 0 });

export function addUsage(a: Usage | null | undefined, b: Usage): Usage {
  const x = a ?? emptyUsage();
  return {
    input_tokens: x.input_tokens + b.input_tokens,
    output_tokens: x.output_tokens + b.output_tokens,
    cache_read_tokens: x.cache_read_tokens + b.cache_read_tokens,
    cache_write_tokens: x.cache_write_tokens + b.cache_write_tokens,
    cost_usd: x.cost_usd + b.cost_usd,
    model: b.model ?? x.model,
    invocations: x.invocations + b.invocations,
  };
}

/** `claude.ai Google Drive` → `google-drive`. */
export function slugServer(name: string): string {
  return name.replace(/^claude\.ai\s+/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}
