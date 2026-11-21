import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runProcess, which } from "../util/proc.ts";
import { parse as parseToml } from "smol-toml";
import { emptyUsage, slugServer, type AdapterInfo, type AgentAdapter, type AgentRequest, type AgentResult, type ModelChoice } from "./types.ts";

/**
 * OpenAI Codex CLI in non-interactive mode (`codex exec --json`).
 * Written from the published documentation; NOT verified against a real CLI (see docs/adapters/codex.md).
 */
export class CodexAdapter implements AgentAdapter {
  readonly name = "codex";
  private bin: string;
  constructor(bin: string = "codex") { this.bin = bin; }

  private configPath() { return join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml"); }

  async info(): Promise<AdapterInfo> {
    const path = existsSync(this.bin) ? this.bin : which(this.bin);
    if (!path) return { name: this.name, found: false, path: null, version: null, ok: false, note: "not installed" };
    const r = await runProcess({ argv: [path, "--version"], timeoutMs: 20_000 });
    const version = r.stdout.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
    return { name: this.name, found: true, path, version, ok: !!version, note: version ? "adapter not verified against a real Codex CLI" : "could not read the version" };
  }

  /** Codex keeps MCP servers in `[mcp_servers.<name>]` tables of its config.toml. */
  async discoverMcp() {
    const file = this.configPath();
    if (!existsSync(file)) return [];
    const cfg = parseToml(readFileSync(file, "utf8")) as any;
    return Object.entries(cfg.mcp_servers ?? {}).map(([cliName, def]: [string, any]) => ({
      name: slugServer(cliName),
      config: { cli_name: cliName, target: def.url ?? [def.command, ...(def.args ?? [])].join(" "), status: def.enabled === false ? "disabled" : "configured", scope: "config", def },
    }));
  }

  /**
   * The Codex CLI has no command that lists models, so the choices are the models named in its
   * own configuration: the default `model` and the `model` of every profile in config.toml.
   */
  async listModels(): Promise<{ models: ModelChoice[]; note?: string }> {
    const file = this.configPath();
    const note = "Codex has no model list command; these are the models named in its config.toml";
    if (!existsSync(file)) return { models: [], note: `${note} (none found)` };
    const cfg = parseToml(readFileSync(file, "utf8")) as any;
    const seen = new Map<string, string>();
    if (typeof cfg.model === "string") seen.set(cfg.model, `${cfg.model} (configured default)`);
    for (const [profile, p] of Object.entries(cfg.profiles ?? {})) {
      const m = (p as any)?.model;
      if (typeof m === "string" && !seen.has(m)) seen.set(m, `${m} (profile ${profile})`);
    }
    return { models: [...seen].map(([value, label]) => ({ value, label })), note };
  }

  buildArgs(req: AgentRequest): string[] {
    const args = ["exec"];
    if (req.resumeSessionId) args.push("resume", req.resumeSessionId);
    args.push("--json", "--skip-git-repo-check");
    if (req.model) args.push("-m", req.model);
    // Codex's own sandbox: read-only unless the node asks for built-in tools.
    if (req.builtinTools === "default" || Array.isArray(req.builtinTools)) args.push("--sandbox", "workspace-write");
    // Per-run scoping: every configured server the node did not ask for is switched off.
    const chosen = new Set(req.servers.map((s) => s.name));
    for (const s of req.allServers) {
      const key = `mcp_servers.${s.config?.cli_name ?? s.name}.enabled`;
      args.push("-c", `${key}=${chosen.has(s.name)}`);
    }
    args.push("-"); // prompt on stdin
    return args;
  }

  async run(req: AgentRequest): Promise<AgentResult> {
    const argv = [this.bin, ...this.buildArgs(req)];
    req.onEvent?.({ type: "sent", argv, prompt: req.prompt });
    let sessionId: string | null = req.resumeSessionId ?? null;
    let text = "";
    let failure: string | null = null;
    let completed = false;
    const usage = emptyUsage();
    usage.invocations = 1;
    usage.model = req.model;

    const r = await runProcess({
      argv, cwd: req.cwd, env: process.env as Record<string, string>, stdin: req.prompt, timeoutMs: req.timeoutMs,
      shouldStop: req.shouldStop, onSpawn: req.onSpawn,
      onStdoutLine: (line) => {
        let d: any;
        try { d = JSON.parse(line); } catch { return; }
        if (d.type === "thread.started") {
          sessionId = d.thread_id ?? sessionId;
          if (sessionId) req.onEvent?.({ type: "init", session_id: sessionId, model: req.model });
        } else if (d.type === "item.started" && ["mcp_tool_call", "command_execution", "file_change", "web_search"].includes(d.item?.type)) {
          req.onEvent?.({ type: "tool_use", name: d.item.type === "mcp_tool_call" ? `${d.item.server ?? "mcp"}.${d.item.tool ?? ""}` : d.item.type, input: d.item.command ?? d.item.arguments });
        } else if (d.type === "item.completed" && d.item?.type === "agent_message") {
          text = d.item.text ?? "";
          req.onEvent?.({ type: "text", text });
        } else if (d.type === "turn.completed") {
          completed = true;
          const u = d.usage ?? {};
          usage.input_tokens += Math.max(0, (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0));
          usage.cache_read_tokens += u.cached_input_tokens ?? 0;
          usage.output_tokens += u.output_tokens ?? 0;
          req.onEvent?.({ type: "result", is_error: false, cost_usd: 0 });
        } else if (d.type === "turn.failed" || d.type === "error") {
          failure = d.error?.message ?? d.message ?? "turn failed";
        }
      },
    });

    const base = { sessionId, usage, argv, stderr: r.stderr, denials: [] as string[] };
    if (r.stopped === "pause") return { ...base, text: "", error: null, interrupted: true, cancelled: false };
    if (r.stopped === "cancel") return { ...base, text: "", error: "cancelled", interrupted: false, cancelled: true };
    let error: string | null = null;
    if (r.spawnError) error = `could not start ${this.bin}: ${r.spawnError}`;
    else if (r.timedOut) error = "agent timed out";
    else if (failure) error = `agent reported an error: ${failure}`;
    else if (!completed) error = `agent exited (code ${r.code}) without completing a turn: ${r.stderr.trim().slice(0, 500) || "no output"}`;
    return { ...base, text, error, interrupted: false, cancelled: false };
  }
}
