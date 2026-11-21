import { existsSync } from "node:fs";
import { runProcess, which } from "../util/proc.ts";
import { emptyUsage, slugServer, type AdapterInfo, type AgentAdapter, type AgentRequest, type AgentResult, type ModelChoice } from "./types.ts";

const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * OpenCode CLI in non-interactive mode (`opencode run --format json`, prompt on stdin).
 * Checked against opencode 1.18.31 (see docs/adapters/opencode.md).
 */
export class OpenCodeAdapter implements AgentAdapter {
  readonly name = "opencode";
  private bin: string;
  constructor(bin: string = "opencode") { this.bin = bin; }

  private env(extra: Record<string, string> = {}) { return { ...(process.env as Record<string, string>), ...extra }; }

  async info(): Promise<AdapterInfo> {
    const path = existsSync(this.bin) ? this.bin : which(this.bin);
    if (!path) return { name: this.name, found: false, path: null, version: null, ok: false, note: "not installed" };
    const r = await runProcess({ argv: [path, "--version"], timeoutMs: 20_000 });
    const version = r.stdout.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
    return { name: this.name, found: true, path, version, ok: !!version, note: version ? undefined : "could not read the version" };
  }

  /**
   * The servers come from OpenCode's resolved configuration for the folder (`opencode debug config`,
   * which merges the global and the project config), and their connection status from
   * `opencode mcp list`.
   */
  async discoverMcp(cwd: string = process.cwd()) {
    const r = await runProcess({ argv: [this.bin, "debug", "config"], cwd, timeoutMs: 30_000, env: this.env() });
    if (r.spawnError) throw new Error(`could not start ${this.bin}: ${r.spawnError}`);
    if (r.code !== 0) throw new Error(`\`${this.bin} debug config\` failed: ${r.stderr.trim().slice(0, 300) || `exit code ${r.code}`}`);
    let cfg: any;
    try { cfg = JSON.parse(r.stdout.slice(r.stdout.indexOf("{"))); } catch { throw new Error(`\`${this.bin} debug config\` did not print JSON`); }
    const defs: Record<string, any> = cfg?.mcp ?? {};
    if (!Object.keys(defs).length) return [];
    const status = await this.mcpStatus(cwd);
    return Object.entries(defs).map(([cliName, def]: [string, any]) => {
      const s = status.get(cliName);
      return {
        name: slugServer(cliName),
        config: {
          cli_name: cliName,
          target: def.url ?? (Array.isArray(def.command) ? def.command.join(" ") : def.command ?? ""),
          status: def.enabled === false ? "disabled" : s?.status ?? "configured",
          detail: s?.detail,
          scope: "config",
        },
      };
    });
  }

  /** `opencode mcp list` lines look like `●  ✓ name connected`, then the error (if any) and the target. */
  private async mcpStatus(cwd: string): Promise<Map<string, { status: string; detail?: string }>> {
    const out = new Map<string, { status: string; detail?: string }>();
    const r = await runProcess({ argv: [this.bin, "mcp", "list"], cwd, timeoutMs: 60_000, env: this.env() });
    if (r.spawnError || r.code !== 0) return out;
    const lines = r.stdout.replace(ANSI, "").split("\n").map((l) => l.replace(/^[\s│┌└●○◇◆▲]+/u, "").trim());
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\S\s+(\S+)\s+(connected|failed|disabled|needs[ _-]?auth\w*|pending)\b/i);
      if (!m) continue;
      const word = m[2].toLowerCase();
      const status = word.startsWith("needs") ? "needs-auth" : word;
      out.set(m[1], { status, detail: status === "failed" || status === "needs-auth" ? lines[i + 1] || undefined : undefined });
    }
    return out;
  }

  /** `opencode models` prints one `provider/model` per line. */
  async listModels(): Promise<{ models: ModelChoice[]; note?: string }> {
    const r = await runProcess({ argv: [this.bin, "models"], timeoutMs: 60_000, env: this.env() });
    if (r.spawnError || r.code !== 0) return { models: [], note: `\`${this.bin} models\` failed: ${r.spawnError ?? (r.stderr.trim().slice(0, 200) || `exit code ${r.code}`)}` };
    const models = r.stdout.replace(ANSI, "").split("\n").map((l) => l.trim()).filter((l) => /^[\w.-]+\/\S+$/.test(l)).map((value) => ({ value, label: value }));
    return { models };
  }

  buildArgs(req: AgentRequest): string[] {
    const args = ["run", "--format", "json"];
    if (req.model) args.push("-m", req.model);
    if (req.resumeSessionId) args.push("-s", req.resumeSessionId);
    // OpenCode's `plan` agent cannot edit files; `--auto` approves what the config does not deny.
    if (req.builtinTools === "default" || Array.isArray(req.builtinTools)) args.push("--auto");
    else args.push("--agent", "plan");
    return args;
  }

  /**
   * Per-run scoping: every configured server the node did not ask for is switched off with an
   * inline config override, which OpenCode merges over its own configuration for this run only.
   */
  configOverride(req: AgentRequest): string | null {
    if (req.unrestricted) return null;
    const chosen = new Set(req.servers.map((s) => s.name));
    const off = req.allServers.filter((s) => !chosen.has(s.name));
    if (!off.length) return null;
    let base: any = {};
    try { base = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}"); } catch { /* not JSON: replaced */ }
    const mcp = { ...(base.mcp ?? {}) };
    for (const s of off) { const k = s.config?.cli_name ?? s.name; mcp[k] = { ...(mcp[k] ?? {}), enabled: false }; }
    return JSON.stringify({ ...base, mcp });
  }

  async run(req: AgentRequest): Promise<AgentResult> {
    const argv = [this.bin, ...this.buildArgs(req)];
    const override = this.configOverride(req);
    req.onEvent?.({ type: "sent", argv: override ? [`OPENCODE_CONFIG_CONTENT=${override}`, ...argv] : argv, prompt: req.prompt });
    let sessionId: string | null = req.resumeSessionId ?? null;
    let announced = false;
    let stepText = "";
    let text = "";
    let failure: string | null = null;
    let completed = false;
    const usage = emptyUsage();
    usage.invocations = 1;
    usage.model = req.model;

    const r = await runProcess({
      argv, cwd: req.cwd, env: this.env(override ? { OPENCODE_CONFIG_CONTENT: override } : {}), stdin: req.prompt, timeoutMs: req.timeoutMs,
      shouldStop: req.shouldStop, onSpawn: req.onSpawn,
      onStdoutLine: (line) => {
        let d: any;
        try { d = JSON.parse(line); } catch { return; }
        if (d.sessionID) {
          sessionId = d.sessionID;
          if (!announced) { announced = true; req.onEvent?.({ type: "init", session_id: d.sessionID, model: req.model }); }
        }
        const p = d.part ?? {};
        if (d.type === "step_start") stepText = "";
        else if (d.type === "text" && p.text) { stepText += p.text; req.onEvent?.({ type: "text", text: p.text }); }
        else if (d.type === "tool_use") {
          const st = p.state ?? {};
          req.onEvent?.({ type: "tool_use", name: p.tool ?? "tool", input: st.input });
          if (st.status === "completed" || st.status === "error") req.onEvent?.({ type: "tool_result", is_error: st.status === "error", content: typeof st.output === "string" ? st.output : st.error });
        } else if (d.type === "step_finish") {
          const t = p.tokens ?? {};
          usage.input_tokens += t.input ?? 0;
          usage.output_tokens += (t.output ?? 0) + (t.reasoning ?? 0);
          usage.cache_read_tokens += t.cache?.read ?? 0;
          usage.cache_write_tokens += t.cache?.write ?? 0;
          usage.cost_usd += Number(p.cost) || 0;
          if (stepText.trim()) text = stepText.trim();
          if (p.reason !== "tool-calls") { completed = true; req.onEvent?.({ type: "result", is_error: false, cost_usd: usage.cost_usd }); }
        } else if (d.type === "error") {
          failure = d.error?.data?.message ?? d.error?.message ?? d.error?.name ?? "error";
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
    else if (!completed) error = `agent exited (code ${r.code}) without finishing: ${r.stderr.trim().slice(0, 500) || "no output"}`;
    return { ...base, text, error, interrupted: false, cancelled: false };
  }
}
