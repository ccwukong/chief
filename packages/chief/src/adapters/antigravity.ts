import { existsSync } from "node:fs";
import { runProcess, which } from "../util/proc.ts";
import { emptyUsage, redact, slugServer, type AdapterInfo, type AgentAdapter, type AgentRequest, type AgentResult, type McpWritePlan, type McpWriteRequest, type ModelChoice } from "./types.ts";

/**
 * Google Antigravity CLI (`agy`) in print mode with stream-json in and out.
 * Checked against agy 1.5.11 (see docs/adapters/antigravity.md).
 */
export class AntigravityAdapter implements AgentAdapter {
  readonly name = "antigravity";
  private bin: string;
  constructor(bin: string = "agy") { this.bin = bin; }

  /**
   * `agy mcp add` / `remove`, its own command for its own `~/.gemini/config/mcp_config.json`.
   * One list for every folder, so there is no scope to pass. Flags must come before the name —
   * the CLI rejects one placed after it — which is why the name is pushed last.
   */
  mcpWrite(req: McpWriteRequest): McpWritePlan {
    if (req.action === "remove") {
      const argv = [this.bin, "mcp", "remove", req.name];
      return { argv, command: argv.join(" ") };
    }
    const argv = [this.bin, "mcp", "add"];
    for (const e of req.env ?? []) argv.push("--env", e);
    for (const h of req.header ?? []) argv.push("--header", h);
    const url = req.url?.trim();
    if (url) argv.push("--type", "http", req.name, url);
    else argv.push("--type", "stdio", req.name, req.command ?? "", ...(req.args ?? []));
    return { argv, command: redact(argv).join(" ") };
  }

  async info(): Promise<AdapterInfo> {
    const path = existsSync(this.bin) ? this.bin : which(this.bin);
    if (!path) return { name: this.name, found: false, path: null, version: null, ok: false, note: "not installed" };
    const r = await runProcess({ argv: [path, "--version"], timeoutMs: 20_000 });
    const version = r.stdout.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
    return { name: this.name, found: true, path, version, ok: !!version, note: version ? undefined : "could not read the version" };
  }

  /**
   * `agy mcp list` prints a table (NAME TYPE STATUS COMMAND/URL) of the servers in its
   * `~/.gemini/config/mcp_config.json`. agy has no per-folder servers.
   */
  async discoverMcp(cwd: string = process.cwd()) {
    const r = await runProcess({ argv: [this.bin, "mcp", "list"], cwd, timeoutMs: 30_000, env: process.env as Record<string, string> });
    if (r.spawnError) throw new Error(`could not start ${this.bin}: ${r.spawnError}`);
    if (r.code !== 0) throw new Error(`\`${this.bin} mcp list\` failed: ${r.stderr.trim().slice(0, 300) || `exit code ${r.code}`}`);
    const out: { name: string; config: any }[] = [];
    for (const line of r.stdout.split("\n")) {
      const cols = line.trim().split(/\s{2,}/);
      if (cols.length < 3 || cols[0] === "NAME") continue;
      const [cliName, type, status, target] = cols;
      out.push({ name: slugServer(cliName), config: { cli_name: cliName, type, target: target ?? "", status: status === "disabled" ? "disabled" : "configured", scope: "config" } });
    }
    return out;
  }

  /** `agy models` prints one model per line: the id, a tab, the display name. */
  async listModels(): Promise<{ models: ModelChoice[]; note?: string }> {
    const r = await runProcess({ argv: [this.bin, "models"], timeoutMs: 60_000, env: process.env as Record<string, string> });
    if (r.spawnError || r.code !== 0) return { models: [], note: `\`${this.bin} models\` failed: ${r.spawnError ?? (r.stderr.trim().slice(0, 200) || `exit code ${r.code}`)}` };
    const models: ModelChoice[] = [];
    for (const line of r.stdout.split("\n")) {
      const [id, label] = line.split("\t");
      if (id?.trim() && label?.trim()) models.push({ value: id.trim(), label: label.trim() });
    }
    return { models };
  }

  buildArgs(req: AgentRequest): string[] {
    // `--print=` with an empty value: the prompt comes from stdin as a stream-json message.
    const args = ["--print=", "--input-format", "stream-json", "--output-format", "stream-json"];
    if (req.model) args.push("--model", req.model);
    if (req.resumeSessionId) args.push("--conversation", req.resumeSessionId);
    // `plan` researches without changing anything; `auto` approves edits and safe commands.
    args.push("--mode", req.builtinTools === "default" || Array.isArray(req.builtinTools) ? "auto" : "plan");
    return args;
  }

  /**
   * agy has no per-invocation switch to hide a configured server (`agy mcp disable` changes global
   * state, which chief does not touch), so scoping is by instruction, as for Cursor.
   */
  scopeNote(req: AgentRequest): string {
    if (req.resumeSessionId || req.unrestricted) return "";
    const names = req.servers.map((s) => s.config?.cli_name ?? s.name);
    return names.length
      ? `\n\nYou may use only these MCP servers: ${names.join(", ")}. Do not call tools of any other MCP server.`
      : "\n\nDo not call any MCP server tools in this task.";
  }

  async run(req: AgentRequest): Promise<AgentResult> {
    const prompt = req.prompt + this.scopeNote(req);
    const argv = [this.bin, ...this.buildArgs(req)];
    req.onEvent?.({ type: "sent", argv, prompt });
    let sessionId: string | null = req.resumeSessionId ?? null;
    let result: any = null;
    const steps = new Map<number, string>();
    let lastText = "";
    const usage = emptyUsage();
    usage.invocations = 1;
    usage.model = req.model;

    const r = await runProcess({
      argv, cwd: req.cwd, env: process.env as Record<string, string>, timeoutMs: req.timeoutMs,
      stdin: JSON.stringify({ event: "user", message: { role: "user", content: prompt } }) + "\n",
      shouldStop: req.shouldStop, onSpawn: req.onSpawn,
      onStdoutLine: (line) => {
        let d: any;
        try { d = JSON.parse(line); } catch { return; }
        if (d.event === "init") {
          sessionId = d.conversation_id || sessionId;
          usage.model = d.init?.model ?? usage.model;
          if (sessionId) req.onEvent?.({ type: "init", session_id: sessionId, model: usage.model, tools: d.init?.tools?.length });
        } else if (d.event === "step_update") {
          const s = d.step_update ?? {};
          if (s.step_type === "agent_response") {
            const text = (steps.get(s.step_index) ?? "") + (s.text_delta ?? "");
            steps.set(s.step_index, text);
            if (s.state === "DONE" && text.trim()) { lastText = text.trim(); req.onEvent?.({ type: "text", text: lastText }); }
          } else if (s.step_type === "tool") {
            const t = s.tool_info ?? {};
            if (s.state === "ACTIVE") req.onEvent?.({ type: "tool_use", name: s.tool_name ?? t.name ?? "tool", input: t.parameters });
            else if (s.state === "DONE" || s.state === "ERROR") req.onEvent?.({ type: "tool_result", is_error: s.state === "ERROR", content: t.error?.message ?? t.output });
          }
        } else if (d.event === "result") {
          result = d.result ?? {};
          if (result.conversation_id) sessionId = result.conversation_id;
          const u = result.usage ?? {};
          usage.input_tokens += u.input_tokens ?? 0;
          usage.output_tokens += (u.output_tokens ?? 0) + (u.thinking_tokens ?? 0);
          usage.cache_read_tokens += u.cache_read_tokens ?? 0;
          req.onEvent?.({ type: "result", is_error: result.status !== "SUCCESS", cost_usd: 0 });
        }
      },
    });

    const base = { sessionId, usage, argv, stderr: r.stderr, denials: [] as string[] };
    if (r.stopped === "pause") return { ...base, text: "", error: null, interrupted: true, cancelled: false };
    if (r.stopped === "cancel") return { ...base, text: "", error: "cancelled", interrupted: false, cancelled: true };
    let error: string | null = null;
    if (r.spawnError) error = `could not start ${this.bin}: ${r.spawnError}`;
    else if (r.timedOut) error = "agent timed out";
    else if (!result) error = `agent exited (code ${r.code}) without a result: ${r.stderr.trim().slice(0, 500) || "no output"}`;
    else if (result.status !== "SUCCESS") error = `agent reported an error: ${String(result.error || result.response || result.status).slice(0, 500)}`;
    return { ...base, text: String(result?.response ?? lastText).trim(), error, interrupted: false, cancelled: false };
  }
}
