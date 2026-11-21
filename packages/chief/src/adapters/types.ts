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

export interface AgentAdapter {
  readonly name: string;
  info(): Promise<AdapterInfo>;
  /** Read the CLI's own MCP configuration. chief never connects to these servers itself. */
  discoverMcp(cwd?: string): Promise<{ name: string; config: any }[]>;
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
