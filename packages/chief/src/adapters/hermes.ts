import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { runProcess, which } from "../util/proc.ts";
import { emptyUsage, slugServer, type AdapterInfo, type AgentAdapter, type AgentRequest, type AgentResult, type ModelChoice } from "./types.ts";

export const hermesHome = () => process.env.HERMES_HOME || join(homedir(), ".hermes");
export const hermesConfigPath = () => join(hermesHome(), "config.yaml");

/**
 * NousResearch Hermes Agent (`hermes`) in one-shot machine mode
 * (`hermes chat -q "<prompt>" --format stream-json`).
 * Written from the published CLI reference; NOT verified against a real CLI (see docs/adapters/hermes.md).
 */
export class HermesAdapter implements AgentAdapter {
  readonly name = "hermes";
  private bin: string;
  constructor(bin: string = "hermes") { this.bin = bin; }

  async info(): Promise<AdapterInfo> {
    const path = existsSync(this.bin) ? this.bin : which(this.bin);
    if (!path) return { name: this.name, found: false, path: null, version: null, ok: false, note: "not installed" };
    const r = await runProcess({ argv: [path, "--version"], timeoutMs: 20_000 });
    const version = r.stdout.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
    return { name: this.name, found: true, path, version, ok: !!version, note: version ? "adapter not verified against a real Hermes CLI" : "could not read the version" };
  }

  /**
   * Hermes keeps its servers under `mcp_servers:` in `~/.hermes/config.yaml` (`$HERMES_HOME` when set)
   * and manages them with `hermes mcp`. chief reads the file, never runs the CLI for the list.
   */
  async discoverMcp() {
    const file = hermesConfigPath();
    if (!existsSync(file)) return [];
    const cfg = YAML.parse(readFileSync(file, "utf8")) as any;
    return Object.entries(cfg?.mcp_servers ?? {}).map(([cliName, def]: [string, any]) => ({
      name: slugServer(cliName),
      config: {
        cli_name: cliName,
        target: def?.url ?? [def?.command, ...(def?.args ?? [])].filter(Boolean).join(" "),
        status: def?.enabled === false || def?.disabled === true ? "disabled" : "configured",
        scope: "config",
        def,
      },
    }));
  }

  /**
   * There is no documented model list: `hermes model` is an interactive provider/model wizard, and
   * `hermes chat` takes a free `-m`. Return nothing with the reason rather than a list chief invented.
   */
  async listModels(): Promise<{ models: ModelChoice[]; note?: string }> {
    return { models: [], note: "Hermes has no model-list command (`hermes model` is interactive), so this step uses the CLI's own default model; leave the model empty or name one Hermes accepts" };
  }

  /** `--format stream-json` requires `-q` and implies quiet; `--resume` continues the exact session. */
  private flags(req: AgentRequest): string[] {
    const args = ["--format", "stream-json"];
    if (req.resumeSessionId) args.push("--resume", req.resumeSessionId);
    if (req.model) args.push("-m", req.model);
    return args;
  }

  buildArgs(req: AgentRequest, prompt: string = req.prompt): string[] {
    return ["chat", "-q", prompt, ...this.flags(req)];
  }

  /**
   * Hermes has no per-invocation switch to hide a configured server, and no documented flag that names
   * the servers one run may use (`-t` enables toolsets, not servers). Scoping is by instruction, as for
   * Cursor and Antigravity.
   */
  scopeNote(req: AgentRequest): string {
    if (req.resumeSessionId || req.unrestricted) return "";
    const names = req.servers.map((s) => s.config?.cli_name ?? s.name);
    return names.length
      ? `\n\nYou may use only these MCP servers: ${names.join(", ")}. Do not call tools of any other MCP server.`
      : "\n\nDo not call any MCP server tools in this task.";
  }

  /**
   * chief's default is `tools: none`, but Hermes has no documented per-run way to switch its toolsets
   * off: `-t/--toolsets` only *enables* a comma-separated set, and which toolsets exist is a property
   * of `~/.hermes/config.yaml` (`hermes tools`). There is no "enable none" and no read-only mode.
   * Passing `-t` with the names chief uses for Claude Code would be a lie, so nothing is passed: a
   * Hermes step runs with whatever toolsets that installation has enabled. This is a documented
   * limitation (docs/adapters/hermes.md, README "Limits worth knowing"), not a silent grant by chief.
   */
  async run(req: AgentRequest): Promise<AgentResult> {
    const prompt = req.prompt + this.scopeNote(req);
    const argv = [this.bin, ...this.buildArgs(req, prompt)];
    // The prompt is an argv entry (`-q <prompt>`) and is recorded in its own row, so the command line
    // keeps the flags and not a second copy of it (the Cursor adapter does the same).
    const logged = [this.bin, "chat", ...this.flags(req)];
    req.onEvent?.({ type: "sent", argv: logged, prompt });

    let sessionId: string | null = req.resumeSessionId ?? null;
    let result: any = null;
    let streamed = "";
    const usage = emptyUsage();
    usage.invocations = 1;
    usage.model = req.model;

    const r = await runProcess({
      argv, cwd: req.cwd, env: process.env as Record<string, string>, timeoutMs: req.timeoutMs,
      shouldStop: req.shouldStop, onSpawn: req.onSpawn,
      onStdoutLine: (line) => {
        let d: any;
        try { d = JSON.parse(line); } catch { return; }
        if (d.session_id) sessionId = String(d.session_id);
        if (d.type === "system" && d.subtype === "init") {
          usage.model = d.model ?? usage.model;
          req.onEvent?.({ type: "init", session_id: String(d.session_id ?? sessionId ?? ""), model: d.model });
        } else if (d.type === "text") {
          if (typeof d.text === "string" && d.text) {
            // A delta, not the reply: accumulated here and in the record, never counted twice.
            streamed += d.text;
            req.onEvent?.({ type: "text", text: d.text });
          }
        } else if (d.type === "tool_use") {
          req.onEvent?.({ type: "tool_use", name: String(d.name ?? "tool"), input: d.input });
        } else if (d.type === "tool_result") {
          req.onEvent?.({
            type: "tool_result",
            is_error: !!d.is_error,
            content: typeof d.output === "string" ? d.output : d.output === undefined ? undefined : JSON.stringify(d.output, null, 2),
          });
        } else if (d.type === "result") {
          result = d;
          if (d.session_id) sessionId = String(d.session_id);
          const t = d.tokens ?? {};
          usage.input_tokens = t.input ?? 0;
          usage.output_tokens = t.output ?? 0;
          usage.cache_read_tokens = t.cache_read ?? 0;
          usage.cache_write_tokens = t.cache_write ?? 0;
          req.onEvent?.({ type: "result", is_error: !!d.error || Number(d.exit_code ?? 0) !== 0, cost_usd: 0 });
        }
      },
    });

    const base = { sessionId, usage, argv: logged, stderr: r.stderr, denials: [] as string[] };
    if (r.stopped === "pause") return { ...base, text: "", error: null, interrupted: true, cancelled: false };
    if (r.stopped === "cancel") return { ...base, text: "", error: "cancelled", interrupted: false, cancelled: true };

    // The documented contract: the terminal `result` record says the outcome and the process exit code
    // matches its `exit_code`. The fallback covers a CLI that died before printing it.
    const code = result ? Number(result.exit_code ?? r.code ?? -1) : (r.code ?? -1);
    const failure = String(result?.error ?? "").trim();

    // 130 interrupted: the session is kept and chief can resume it.
    if (code === 130) return { ...base, text: "", error: null, interrupted: true, cancelled: false };

    let error: string | null = null;
    if (r.spawnError) error = `could not start ${this.bin}: ${r.spawnError}`;
    else if (r.timedOut) error = "agent timed out";
    // 75 (EX_TEMPFAIL): a provider that was rate-limited, overloaded or out of quota. Said plainly, so
    // a person knows it is worth retrying rather than a fault in the step.
    else if (code === 75) error = "Hermes could not complete the turn: the model provider was rate-limited, overloaded or out of quota (Hermes exit code 75). This is not the step's fault — retry this run.";
    else if (!result) error = `agent exited (code ${code}) without a result: ${r.stderr.trim().slice(0, 500) || "no output"}`;
    else if (code !== 0 || failure) error = `agent reported an error${code !== 0 ? ` (exit code ${code})` : ""}: ${(failure || r.stderr.trim() || "no error message given").slice(0, 500)}`;

    // `result.text` is the whole reply; the deltas are the only fallback when it is absent.
    return { ...base, text: String(result?.text || streamed), error, interrupted: false, cancelled: false };
  }
}
