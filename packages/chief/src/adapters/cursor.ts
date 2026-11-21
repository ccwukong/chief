import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runProcess, which } from "../util/proc.ts";
import { type AdapterInfo, type AgentAdapter, type AgentRequest, type AgentResult, type McpAuthPlan, type ModelChoice, emptyUsage, slugServer } from "./types.ts";

function readJson(path: string): any {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

/**
 * Cursor CLI in print mode (`cursor-agent -p --output-format stream-json`; newer releases name
 * the binary `agent`, set the `cursor.path` setting for that).
 * Written from the published documentation; NOT verified against a real CLI (see docs/adapters/cursor.md).
 */
export class CursorAdapter implements AgentAdapter {
  readonly name = "cursor";
  private bin: string;
  constructor(bin: string = "cursor-agent") { this.bin = bin; }

  /**
   * `cursor-agent mcp login <name>`: it has no headless flag, so the CLI opens the browser itself and
   * chief can only start it and wait. If it ever prints a URL, the server picks that up from the output.
   */
  mcpAuth(req: { action: "login" | "logout"; name: string }): McpAuthPlan | null {
    // Cursor has no logout. `mcp disable` exists but it is not the same act — the server stops being
    // loaded and has to be re-enabled — so the page offers no Log out for it rather than one that
    // quietly does something else.
    if (req.action === "logout") return null;
    const argv = [this.bin, "mcp", "login", req.name];
    return { argv, mode: "browser", command: argv.join(" "), note: "Cursor opens the browser itself; finish there and this closes by itself." };
  }

  async info(): Promise<AdapterInfo> {
    const path = existsSync(this.bin) ? this.bin : which(this.bin);
    if (!path) return { name: this.name, found: false, path: null, version: null, ok: false, note: "not installed" };
    const r = await runProcess({ argv: [path, "--version"], timeoutMs: 20_000 });
    const version = r.stdout.trim().split(/\s+/).find((w) => /\d/.test(w)) ?? null;
    return { name: this.name, found: true, path, version, ok: !!version, note: version ? "adapter not verified against a real Cursor CLI" : "could not read the version" };
  }

  /** Cursor reads MCP servers from `~/.cursor/mcp.json` and the workspace's `.cursor/mcp.json`. */
  async discoverMcp(cwd: string = process.cwd()) {
    const home = process.env.CURSOR_CONFIG_HOME || join(homedir(), ".cursor");
    const defs: Record<string, any> = { ...(readJson(join(home, "mcp.json"))?.mcpServers ?? {}), ...(readJson(join(cwd, ".cursor", "mcp.json"))?.mcpServers ?? {}) };
    return Object.entries(defs).map(([cliName, def]: [string, any]) => ({
      name: slugServer(cliName),
      config: { cli_name: cliName, target: def.url ?? [def.command, ...(def.args ?? [])].join(" "), status: "configured", scope: "config", def },
    }));
  }

  /** The Cursor CLI lists the account's models with its `models` command, one per line. */
  async listModels(): Promise<{ models: ModelChoice[]; note?: string }> {
    const r = await runProcess({ argv: [this.bin, "models"], timeoutMs: 30_000, env: process.env as Record<string, string> });
    if (r.spawnError || r.code !== 0) return { models: [], note: `\`${this.bin} models\` failed: ${r.spawnError ?? (r.stderr.trim().slice(0, 200) || `exit code ${r.code}`)}` };
    const models: ModelChoice[] = [];
    for (const line of r.stdout.split("\n")) {
      // A model id, optionally after a bullet, optionally followed by a description.
      const m = line.match(/^\s*(?:[-*•]\s*)?([A-Za-z0-9][A-Za-z0-9._\/-]*)(?:\s+[-–—]?\s*(.*))?$/);
      if (!m || /^(available|models?|tip|usage)$/i.test(m[1])) continue;
      models.push({ value: m[1], label: m[1], description: m[2]?.trim() || undefined });
    }
    return { models };
  }

  buildArgs(req: AgentRequest): string[] {
    const args = ["-p", "--output-format", "stream-json", "--trust", "--workspace", req.cwd];
    if (req.model) args.push("--model", req.model);
    if (req.resumeSessionId) args.push("--resume", req.resumeSessionId);
    if (req.servers.length) args.push("--approve-mcps");
    // Without --force, shell commands and writes are not auto-approved in print mode.
    if (req.builtinTools === "default" || Array.isArray(req.builtinTools)) args.push("--force");
    return args;
  }

  /**
   * Cursor has no per-invocation switch to hide a configured server, so scoping is by instruction:
   * the node is told which servers it may use. This is weaker than the other adapters.
   */
  scopeNote(req: AgentRequest): string {
    if (req.resumeSessionId || req.unrestricted) return "";
    const names = req.servers.map((s) => s.config?.cli_name ?? s.name);
    return names.length
      ? `\n\nYou may use only these MCP servers: ${names.join(", ")}. Do not call tools of any other MCP server.`
      : "\n\nDo not call any MCP server tools in this task.";
  }

  async run(req: AgentRequest): Promise<AgentResult> {
    // The documented way to pass a prompt is as an argument. It is passed as one argv entry, never through a shell.
    const prompt = req.prompt + this.scopeNote(req);
    const argv = [this.bin, ...this.buildArgs(req), prompt.startsWith("-") ? " " + prompt : prompt];
    req.onEvent?.({ type: "sent", argv: argv.slice(0, -1), prompt });
    let sessionId: string | null = req.resumeSessionId ?? null;
    let result: any = null;
    let lastText = "";
    const usage = emptyUsage();
    usage.invocations = 1;

    const r = await runProcess({
      argv, cwd: req.cwd, env: process.env as Record<string, string>, timeoutMs: req.timeoutMs,
      shouldStop: req.shouldStop, onSpawn: req.onSpawn,
      onStdoutLine: (line) => {
        let d: any;
        try { d = JSON.parse(line); } catch { return; }
        if (d.session_id) sessionId = d.session_id;
        if (d.type === "system" && d.subtype === "init") {
          usage.model = d.model;
          req.onEvent?.({ type: "init", session_id: d.session_id, model: d.model });
        } else if (d.type === "assistant") {
          for (const c of d.message?.content ?? []) if (c.type === "text") { lastText = c.text; req.onEvent?.({ type: "text", text: c.text }); }
        } else if (d.type === "tool_call" && d.subtype === "started") {
          req.onEvent?.({ type: "tool_use", name: Object.keys(d.tool_call ?? {})[0] ?? "tool" });
        } else if (d.type === "result") {
          result = d;
          req.onEvent?.({ type: "result", is_error: !!d.is_error, cost_usd: 0 });
        }
      },
    });

    // The log keeps the flags but not the prompt.
    const base = { sessionId, usage, argv: argv.slice(0, -1), stderr: r.stderr, denials: [] as string[] };
    if (r.stopped === "pause") return { ...base, text: "", error: null, interrupted: true, cancelled: false };
    if (r.stopped === "cancel") return { ...base, text: "", error: "cancelled", interrupted: false, cancelled: true };
    let error: string | null = null;
    if (r.spawnError) error = `could not start ${this.bin}: ${r.spawnError}`;
    else if (r.timedOut) error = "agent timed out";
    else if (!result) error = `agent exited (code ${r.code}) without a result: ${r.stderr.trim().slice(0, 500) || "no output"}`;
    else if (result.is_error) error = `agent reported an error: ${String(result.result ?? "").slice(0, 500)}`;
    return { ...base, text: result?.result ?? lastText, error, interrupted: false, cancelled: false };
  }
}
