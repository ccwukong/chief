import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runProcess, which } from "../util/proc.ts";
import { compareVersions, emptyUsage, slugServer, type AdapterInfo, type AgentAdapter, type AgentRequest, type AgentResult, type ModelChoice } from "./types.ts";

const MIN_VERSION = "2.1.300";

/** Tool-name prefix Claude Code gives a server: `mcp__` + the name with unsafe characters replaced. */
export const claudeToolPrefix = (cliName: string) => "mcp__" + cliName.replace(/[^a-zA-Z0-9_-]/g, "_");

/**
 * Built-in tools that change something, run code, reach the network or start other agents.
 * `ListAgents`, `ReportFindings` and `TaskStop` are deliberately NOT listed: when ToolSearch is the
 * only built-in tool left, Claude Code 2.1.311 stops offering ToolSearch to the model, and with it
 * every MCP connector. Those three are inert in a headless session.
 */
const ACTING_TOOLS = [
  "Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Task", "Workflow", "Skill",
  "Artifact", "ArtifactComments", "ArtifactData", "CronCreate", "CronDelete", "CronList", "DesignSync",
  "EnterWorktree", "ExitWorktree", "Monitor", "PublishPlugin", "PushNotification", "RemoteTrigger",
  "ScheduleWakeup", "SendMessage", "ShareOnboardingGuide",
];
const READ_TOOLS = ["Read", "Grep", "Glob"];

/** Prompt of the throw-away session used to read the server list. The session is killed before it matters. */
export const MCP_PROBE_PROMPT = "chief-mcp-probe: reply with the single word ok";

function readJson(path: string): any {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

/**
 * Claude Code in headless mode (`claude -p --output-format stream-json`).
 * See docs/adapters/claude-code.md for the spiked contract.
 */
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = "claude-code";
  private bin: string;
  constructor(bin: string = "claude") { this.bin = bin; }

  async info(): Promise<AdapterInfo> {
    const path = existsSync(this.bin) ? this.bin : which(this.bin);
    if (!path) return { name: this.name, found: false, path: null, version: null, minVersion: MIN_VERSION, ok: false, note: "not installed" };
    const r = await runProcess({ argv: [path, "--version"], timeoutMs: 20_000 });
    const version = r.stdout.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
    const ok = !!version && compareVersions(version, MIN_VERSION) >= 0;
    return { name: this.name, found: true, path, version, minVersion: MIN_VERSION, ok, note: ok ? undefined : `needs ${MIN_VERSION} or newer` };
  }

  /**
   * The servers Claude Code itself has, with their connection status, read from the `init` line
   * of a throw-away headless session (about 2 s). The session is ended as soon as that line
   * arrives. chief keeps no MCP configuration of its own: this list is the only source.
   */
  private async probe(cwd: string): Promise<{ name: string; status: string }[] | null> {
    let servers: { name: string; status: string }[] | null = null;
    await runProcess({
      argv: [this.bin, "-p", "--output-format", "stream-json", "--verbose", "--model", "haiku", "--disable-slash-commands", "--permission-prompts", "none"],
      cwd, env: process.env as Record<string, string>, stdin: MCP_PROBE_PROMPT, timeoutMs: 60_000,
      shouldStop: () => (servers ? "cancel" : null),
      onStdoutLine: (line) => {
        if (servers) return;
        try {
          const d = JSON.parse(line);
          if (d.type === "system" && d.subtype === "init" && Array.isArray(d.mcp_servers)) servers = d.mcp_servers.map((m: any) => ({ name: String(m.name), status: String(m.status ?? "unknown") }));
        } catch { /* not a JSON line */ }
      },
    });
    return servers;
  }

  /** Fallback when the session start does not report servers: `claude mcp list` (health-checks every server; can take minutes). */
  private async listCommand(cwd: string): Promise<{ name: string; status: string; detail?: string }[]> {
    const r = await runProcess({ argv: [this.bin, "mcp", "list"], cwd, timeoutMs: 20 * 60_000 });
    if (r.timedOut) throw new Error("claude mcp list did not finish within 20 minutes");
    if (r.spawnError || r.code !== 0) throw new Error(`claude mcp list failed: ${r.spawnError ?? (r.stderr.trim() || `exit code ${r.code}`)}`);
    const out: { name: string; status: string; detail?: string }[] = [];
    for (const line of r.stdout.split("\n")) {
      const m = line.match(/^(.+?): (.+) - (✔|✓|!|✘|✗)\s*(.*)$/);
      if (m) out.push({ name: m[1], status: m[3] === "✔" || m[3] === "✓" ? "connected" : m[3] === "!" ? "needs-auth" : "failed", detail: m[4].slice(0, 300) });
    }
    return out;
  }

  /**
   * Ask Claude Code over its SDK control protocol. A stream-json session answers `control_request`
   * lines without any prompt or model call. `onResponse` returns true when it has what it needs.
   */
  private async control(cwd: string, first: object, onResponse: (response: any, send: (request: object) => void, elapsedMs: number) => boolean, timeoutMs: number): Promise<boolean> {
    let proc: ChildProcess;
    try {
      proc = spawn(this.bin, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"], { cwd, stdio: ["pipe", "pipe", "ignore"] });
    } catch { return false; }
    const stdin = proc.stdin!;
    stdin.on("error", () => { /* the process is gone */ });
    let n = 0;
    const send = (request: object) => { try { stdin.write(JSON.stringify({ type: "control_request", request_id: `chief-${++n}`, request }) + "\n"); } catch { /* the process is gone */ } };
    const t0 = Date.now();
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    let done = false;
    const dec = new TextDecoder();
    let buf = "";
    try {
      send(first);
      outer: for await (const chunk of proc.stdout as AsyncIterable<Buffer>) {
        buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          let d: any;
          try { d = JSON.parse(line); } catch { continue; }
          if (d.type !== "control_response") continue;
          if (onResponse(d.response, send, Date.now() - t0)) { done = true; break outer; }
        }
      }
    } finally { clearTimeout(timer); proc.kill(); }
    return done;
  }

  /**
   * The servers Claude Code has and whether it is connected to each, from the control request
   * `mcp_status`. Servers connect in the background after the session starts, so the first
   * answers can be empty or "pending": the request is repeated until the list has stopped
   * changing and nothing is pending (seen to take about 4 s with 51 servers), at most 12 s.
   */
  private async mcpStatus(cwd: string): Promise<{ name: string; status: string; scope?: string; config?: any }[] | null> {
    let last: any[] | null = null;
    let stable = 0;
    let failed = false;
    const settled = (list: any[]) => list.length > 0 && !list.some((s) => s.status === "pending");
    await this.control(cwd, { subtype: "mcp_status" }, (response, send, elapsed) => {
      if (response?.subtype !== "success" || !Array.isArray(response.response?.mcpServers)) { failed = true; return true; }
      const list: any[] = response.response.mcpServers;
      stable = last && last.length === list.length ? stable + 1 : 0;
      last = list;
      // An empty list is only believed after it has stayed empty for a while.
      if ((settled(list) && stable >= 1) || (list.length === 0 && elapsed > 5000)) return true;
      setTimeout(() => send({ subtype: "mcp_status" }), Number(process.env.CHIEF_MCP_POLL_MS) || 500);
      return false;
    }, 12_000);
    if (failed || last === null) return null;
    return (last as any[]).map((s) => ({ name: String(s.name), status: String(s.status ?? "unknown"), scope: s.scope, config: s.config }));
  }

  async discoverMcp(cwd: string = process.cwd()) {
    // 1. The control protocol: complete and settled. 2. The session's init line: fast, but it can
    // list nothing when the servers have not loaded yet, so an empty answer there is not believed.
    // 3. `claude mcp list`: slow (it health-checks every server), always complete.
    let found: { name: string; status: string; detail?: string; scope?: string; config?: any }[] | null = await this.mcpStatus(cwd);
    if (!found) {
      const probed = await this.probe(cwd);
      found = probed && probed.length ? probed : null;
    }
    if (!found) found = await this.listCommand(cwd);
    // Definitions of servers configured in files, needed to scope them with --strict-mcp-config.
    const defs: Record<string, any> = {};
    const userCfg = readJson(join(homedir(), ".claude.json"));
    Object.assign(defs, userCfg?.mcpServers ?? {}, userCfg?.projects?.[cwd]?.mcpServers ?? {}, readJson(join(cwd, ".mcp.json"))?.mcpServers ?? {});

    const out: { name: string; config: any }[] = [];
    const seen = new Set<string>();
    for (const s of found) {
      const connector = /^claude\.ai\s/i.test(s.name) || s.scope === "claudeai";
      const def = connector ? undefined : (s.config && (s.config.command || s.config.url) ? s.config : defs[s.name]);
      let name = slugServer(s.name);
      while (seen.has(name)) name += "-2";
      seen.add(name);
      out.push({
        name,
        config: {
          cli_name: s.name,
          status: s.status,
          detail: s.detail,
          tool_prefix: claudeToolPrefix(s.name),
          // connector: managed by the claude.ai account, cannot be passed through --mcp-config.
          scope: connector || !def ? "connector" : "config",
          def,
        },
      });
    }
    return out;
  }

  /**
   * Claude Code's own model list, read through its SDK control protocol: an `initialize` control
   * request on a stream-json session returns `models` without any prompt or model call (about 0.2 s).
   */
  async listModels(): Promise<{ models: ModelChoice[]; note?: string }> {
    let models: any[] | null = null;
    await this.control(process.cwd(), { subtype: "initialize" }, (response) => { models = (response?.response ?? response)?.models ?? []; return true; }, 20_000);
    if (!models) return { models: [], note: "Claude Code did not answer the model list request" };
    return {
      models: (models as any[]).map((m) => ({
        value: String(m.value),
        label: m.resolvedModel && m.resolvedModel !== m.value ? `${m.displayName ?? m.value} (${m.resolvedModel})` : String(m.displayName ?? m.value),
        description: m.description,
      })),
    };
  }

  buildArgs(req: AgentRequest): string[] {
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--disable-slash-commands", "--permission-prompts", "none"];
    if (req.model) args.push("--model", req.model);
    if (req.resumeSessionId) args.push("--resume", req.resumeSessionId);
    if (req.permissionMode) args.push("--permission-mode", req.permissionMode);

    const allowed = [...(req.allowedTools ?? [])];
    const disallowed = [...(req.disallowedTools ?? [])];
    const prefix = (s: { config: any }) => s.config?.tool_prefix as string;
    for (const s of req.servers) allowed.push(prefix(s));

    // Only file-configured servers can be passed explicitly. When the node uses nothing else,
    // strict mode keeps every other server (and its tool definitions) out of the session.
    if (req.servers.every((s) => s.config?.scope === "config" && s.config?.def)) {
      const mcpServers = Object.fromEntries(req.servers.map((s) => [s.config.cli_name, s.config.def]));
      args.push("--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers }));
    } else {
      const chosen = new Set(req.servers.map((s) => s.name));
      for (const s of req.allServers) if (!chosen.has(s.name) && prefix(s)) disallowed.push(prefix(s));
    }

    // Built-in tools are hidden with a deny list. `--tools` cannot be used for this: it also
    // removes every MCP server from the session (observed on 2.1.311). Anything the list misses
    // still needs a permission nobody can grant (`--permission-prompts none`).
    if (req.builtinTools !== "default") {
      const keep = req.builtinTools === "none" ? [] : req.builtinTools === "read-only" ? READ_TOOLS : req.builtinTools;
      allowed.push(...keep);
      disallowed.push(...[...ACTING_TOOLS, ...READ_TOOLS].filter((t) => !keep.includes(t)));
    }

    if (allowed.length) args.push("--allowedTools", ...new Set(allowed));
    if (disallowed.length) args.push("--disallowedTools", ...new Set(disallowed));
    return args;
  }

  /**
   * Connectors start as "pending" in headless mode, so their tools are not listed up front and
   * the model may conclude it has none. Telling it which servers it has, and how to load their
   * tools, makes that reliable (observed with the real CLI, case E2.2-5).
   */
  mcpHint(req: AgentRequest): string {
    if (req.resumeSessionId || !req.servers.length) return "";
    const list = req.servers.map((s) => `${s.config?.cli_name ?? s.name} (tool names start with \`${s.config?.tool_prefix}__\`)`).join("; ");
    return `\n\nMCP servers available to you in this session: ${list}. ${req.unrestricted ? "Use the ones the task calls for. " : ""}Their tools may be deferred: if you do not see them yet, load them with the ToolSearch tool (search for the server name) before concluding they are unavailable. No other MCP server may be used.`;
  }

  async run(req: AgentRequest): Promise<AgentResult> {
    const argv = [this.bin, ...this.buildArgs(req)];
    const sent = req.prompt + this.mcpHint(req);
    req.onEvent?.({ type: "sent", argv, prompt: sent });
    let sessionId: string | null = req.resumeSessionId ?? null;
    let result: any = null;
    let lastText = "";

    const r = await runProcess({
      argv,
      cwd: req.cwd,
      env: process.env as Record<string, string>,
      stdin: sent,
      timeoutMs: req.timeoutMs,
      shouldStop: req.shouldStop,
      onSpawn: req.onSpawn,
      onStdoutLine: (line) => {
        let d: any;
        try { d = JSON.parse(line); } catch { return; }
        if (d.session_id) sessionId = d.session_id;
        if (d.type === "system" && d.subtype === "init") {
          req.onEvent?.({ type: "init", session_id: d.session_id, model: d.model, tools: d.tools?.length });
        } else if (d.type === "assistant") {
          for (const c of d.message?.content ?? []) {
            if (c.type === "text") { lastText = c.text; req.onEvent?.({ type: "text", text: c.text }); }
            else if (c.type === "tool_use") req.onEvent?.({ type: "tool_use", name: c.name, input: c.input });
          }
        } else if (d.type === "user") {
          for (const c of d.message?.content ?? []) {
            if (c?.type === "tool_result") req.onEvent?.({ type: "tool_result", is_error: !!c.is_error, content: typeof c.content === "string" ? c.content : JSON.stringify(c.content, null, 2) });
          }
        } else if (d.type === "result") {
          result = d;
          req.onEvent?.({ type: "result", is_error: !!d.is_error, cost_usd: d.total_cost_usd ?? 0 });
        }
      },
    });

    const usage = emptyUsage();
    usage.invocations = 1;
    if (result) {
      const u = result.usage ?? {};
      usage.input_tokens = u.input_tokens ?? 0;
      usage.output_tokens = u.output_tokens ?? 0;
      usage.cache_read_tokens = u.cache_read_input_tokens ?? 0;
      usage.cache_write_tokens = u.cache_creation_input_tokens ?? 0;
      usage.cost_usd = result.total_cost_usd ?? 0;
      usage.model = Object.keys(result.modelUsage ?? {})[0];
    }

    const base = { sessionId, usage, argv, stderr: r.stderr, denials: (result?.permission_denials ?? []).map((d: any) => d.tool_name as string) };
    if (r.stopped === "pause") return { ...base, text: "", error: null, interrupted: true, cancelled: false };
    if (r.stopped === "cancel") return { ...base, text: "", error: "cancelled", interrupted: false, cancelled: true };

    let error: string | null = null;
    if (r.spawnError) error = `could not start ${this.bin}: ${r.spawnError}`;
    else if (r.timedOut) error = "agent timed out";
    else if (!result) error = `agent exited (code ${r.code}) without a result: ${r.stderr.trim().slice(0, 500) || "no output"}`;
    else if (result.is_error) error = `agent reported an error (${result.subtype}): ${String(result.result ?? "").slice(0, 500)}`;
    return { ...base, text: result?.result ?? lastText, error, interrupted: false, cancelled: false };
  }
}
