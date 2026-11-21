#!/usr/bin/env node
// First, before anything imports the store: Node 22 warns about `node:sqlite` when it is loaded, and the
// warning describes a choice this project made on purpose (see the module).
import "./node-warnings.ts";
import { writeFileSync } from "node:fs";
import { answerGate, driveRun, EngineError, recover, requestCancel, requestPause, rerunRun, resumeRun, startRun } from "./engine/engine.ts";
import { revertRun } from "./engine/saga.ts";
import { defaultWorkspace, expandDir } from "./paths.ts";
import { addSchedule, approveWorkflow, changeStep, cloneWorkflow, deleteRuns, setStepModel, doctor, ensureMcp, importFile, listModels, refreshMcp, runDetail, validateFull } from "./ops.ts";
import { askAboutRun } from "./ask.ts";
import { Store } from "./store/store.ts";
import { TERMINAL_RUN, type RunRow, type Usage } from "./store/types.ts";
import { parseText, toYaml, validateWorkflow } from "./workflow/load.ts";
import { setInputPath } from "./workflow/inputs.ts";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const HELP = `chief — local workflow orchestrator for agent CLIs

Usage: chief <command> [options]        (add --json to any command for machine-readable output)

  doctor                                  check CLIs, database and sandbox
  mcp list [--workflow <name>] [--cached]  the MCP servers your agent CLI has right now, in this folder or the workflow's (chief configures none)
  workflow import <file> [--approve-sandbox] | export <name> [--format yaml|json] [-o file]
           validate <file|name> | list | approve <name> | rm <name>
           clone <name> [<new-name>]      copy a workflow (not its runs, schedules or approvals)
  run <workflow> [--input k=v | --input a.b=v]... [--inputs-json <json>] [--warn-usd n] [--max-usd n]
  runs list [--workflow <name>] [--limit n] [--offset n] | show <id> | tail <id> [--follow]
  runs rerun <id>                         run a run again: a new run of its workflow with the inputs it ran with
  runs rm <id...>                         delete finished runs and everything recorded for them
  runs set-model <run> <step> <model|default>  change a step's model for this run while it is stopped, then resume
  runs set-prompt <run> <step> <text|file>     change a step's prompt for this run while it is stopped, then resume
  runs replay <id> [--node <id>] [--full]  play back everything recorded for a run (prompts, replies, tool calls, errors)
  runs ask <id> "<question>" [--model m]  ask an agent about a run: what went wrong, a summary, what to do next (from the run's record)
  models [--adapter a]                    the models the agent CLI offers
  pause <id> | resume <id> | cancel <id>
  gate list [--all] | show <id> | answer <id> <json> | approve <id> [--value <json>] [--text t] | reject <id> [--text t]
  revert <run> [--to <node>]
  schedule add <workflow> "<cron>" [--inputs-json <json>] | list | rm <id> | enable <id> | disable <id>
  settings get [key] | set <key> <json-value>
  serve [--port n] [--no-open]            start the HTTP server, web UI and scheduler (default port 8080) and open the web UI in your browser
`;

// ── argument parsing ──────────────────────────────────────────────────────

interface Args { _: string[]; flags: Record<string, string | boolean>; multi: Record<string, string[]> }
const BOOLEAN_FLAGS = new Set(["json", "follow", "all", "approve-sandbox", "help", "no-open", "cached", "full"]);

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {}, multi: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o") { out.flags.out = argv[++i]; continue; }
    if (a === "-h") { out.flags.help = true; continue; }
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const eq = a.indexOf("=");
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    let val: string | boolean;
    if (eq > 0) val = a.slice(eq + 1);
    else if (BOOLEAN_FLAGS.has(key)) val = true;
    else { val = argv[++i]; if (val === undefined) throw new EngineError(`option --${key} needs a value`); }
    out.flags[key] = val;
    if (typeof val === "string") (out.multi[key] ??= []).push(val);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const asJson = !!args.flags.json;
const out = (text: string) => process.stdout.write(text + "\n");
const emit = (data: unknown, text: () => string) => out(asJson ? JSON.stringify(data, null, 2) : text());

function need(value: string | undefined, what: string): string {
  if (!value) throw new EngineError(`missing ${what}\n\n${HELP}`);
  return value;
}
const num = (value: string | undefined, what: string) => {
  const n = Number(need(value, what));
  if (!Number.isFinite(n)) throw new EngineError(`${what} must be a number`);
  return n;
};
function json(value: string | boolean | undefined, what: string): any {
  if (typeof value !== "string") throw new EngineError(`${what} must be JSON`);
  try { return JSON.parse(value); } catch { throw new EngineError(`${what} is not valid JSON: ${value}`); }
}

function table(rows: (string | number | null | undefined)[][]): string {
  const widths: number[] = [];
  for (const r of rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, String(c ?? "").length)));
  return rows.map((r) => r.map((c, i) => String(c ?? "").padEnd(widths[i])).join("  ").trimEnd()).join("\n");
}

const usd = (n: number) => `$${n.toFixed(4)}`;

// ── printing ──────────────────────────────────────────────────────────────

function printRun(store: Store, runId: number) {
  const d = runDetail(store, runId);
  emit(d, () => {
    const { run } = d;
    const lines = [
      `run ${run.id}  ${run.workflow_name} v${run.workflow_version}  ${run.status}${run.error ? `  (${run.error})` : ""}`,
      `tokens in ${run.tokens_in}  out ${run.tokens_out}  cost ${usd(run.cost_usd)}${d.budget["max-usd"] ? `  budget ${usd(d.budget["max-usd"])}` : ""}`,
      `${d.messages} messages recorded  (chief runs replay ${run.id})`,
      "",
      table([
        ["NODE", "TYPE", "STATUS", "TRY", "TOKENS IN", "OUT", "COST", "PROMPT~TOK"],
        ...d.node_runs.map((n) => {
          const u = n.usage as Usage | null;
          return [
            `${n.parent_node_run_id && n.phase === "forward" ? "  " : ""}${n.node_id}${n.item_index != null ? `[${n.item_index}]` : ""}${n.phase === "compensate" ? " (compensate)" : ""}`,
            n.node_type, n.status, n.attempt,
            u ? u.input_tokens + u.cache_read_tokens + u.cache_write_tokens : "", u ? u.output_tokens : "", u ? usd(u.cost_usd) : "", n.input?.est_tokens ?? "",
          ];
        }),
      ]),
    ];
    const failed = d.node_runs.filter((n) => n.status === "failed");
    for (const f of failed) lines.push("", `error in ${f.node_id}: ${f.error}`);
    if (failed.length) lines.push(`  ask about it: chief runs ask ${run.id} "what went wrong?"`);
    const waiting = d.gates.filter((g) => g.status === "waiting");
    if (waiting.length) {
      lines.push("", "Waiting gates:");
      for (const g of waiting) lines.push(`  gate ${g.id}  ${g.kind}${g.reason !== "node" ? ` (${g.reason})` : ""}  ${g.node_id ?? ""}  — ${g.payload?.message ?? ""}`, `    answer with: chief gate answer ${g.id} '<json>'   (chief gate show ${g.id} for details)`);
    }
    if (d.side_effects.length) {
      lines.push("", "Side effects:");
      for (const e of d.side_effects) lines.push(`  ${e.kind}  ${e.ref ?? ""}  ${e.url ?? ""}${e.irreversible ? "  [irreversible]" : ""}${e.reverted_at ? "  [reverted]" : ""}`);
    }
    return lines.join("\n");
  });
}

function exitCodeFor(run: RunRow): number {
  return run.status === "failed" ? 1 : run.status === "cancelled" ? 2 : 0;
}

async function waitWhile(store: Store, runId: number, cond: (r: RunRow) => boolean, timeoutMs = 60_000) {
  const t0 = Date.now();
  while (cond(store.getRun(runId)!) && Date.now() - t0 < timeoutMs) await sleep(200);
}

// ── commands ──────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const [cmd, sub, ...rest] = args._;
  if (!cmd || args.flags.help || cmd === "help") { out(HELP); return 0; }
  const store = new Store();
  recover(store);

  switch (cmd) {
    case "doctor": {
      const d = await doctor(store);
      emit(d, () => [
        `chief home   ${d.home}`,
        `database     ${d.db.path}  (ok, ${d.db.migrations} migration${d.db.migrations === 1 ? "" : "s"}, latest ${d.db.latest})`,
        `schemas      ${Object.entries(d.db.schemas).map(([s, t]) => `${s} (${(t as any[]).length})`).join(", ")}  — one SQLite file, one schema per feature`,
        `sandbox      ${d.sandbox.available ? `ok (${d.sandbox.backend})` : `unavailable: ${d.sandbox.reason}`}  → script nodes ${d.sandbox.script_nodes}`,
        `mcp servers  ${d.mcp_servers} reported by the agent CLIs when last asked (chief mcp list asks again)`,
        "",
        table([["ADAPTER", "FOUND", "VERSION", "MIN", "STATUS"], ...d.adapters.map((a: any) => [a.name + (a.name === d.default_adapter ? " *" : ""), a.found ? "yes" : "no", a.version ?? "-", a.minVersion ?? "-", a.ok ? "ok" : a.note ?? "not ok"])]),
        "",
        d.ok ? "All good." : "Problems:\n" + d.problems.map((p) => `- ${p}`).join("\n"),
      ].join("\n"));
      return d.ok ? 0 : 1;
    }

    case "mcp": {
      if (sub === "list" || !sub) {
        // Always the agent CLIs' current state; `--cached` shows what was read last time. The servers
        // depend on the folder: this one, or the folder of the workflow given with --workflow.
        const wf = typeof args.flags.workflow === "string" ? store.getWorkflow(args.flags.workflow) : null;
        if (typeof args.flags.workflow === "string" && !wf) throw new EngineError(`workflow "${args.flags.workflow}" not found`);
        const folder = resolve(wf?.base_dir ?? process.cwd());
        const refreshed = args.flags.cached ? null : await refreshMcp(store, undefined, [folder]);
        const rows = store.mcpServers(undefined, folder);
        emit(rows, () => {
          const lines = [`MCP servers for ${folder}${wf ? ` (the folder of workflow ${wf.name})` : ""}:`, ""];
          lines.push(rows.length
            ? table([["NAME", "ADAPTER", "STATUS", "NAME IN THE CLI"], ...rows.map((s) => [s.name, s.adapter, s.config?.status ?? "", s.config?.cli_name ?? ""])])
            : "The agent CLIs report no MCP servers here.");
          for (const [a, r] of Object.entries(refreshed ?? {})) if (r.error && r.error !== "CLI not installed") lines.push(`${a}: ${r.error}`);
          lines.push("", "These are the servers your agent CLI has. chief does not configure MCP servers: add, remove or sign in to them in the CLI (for Claude Code: `claude mcp` or the claude.ai connector settings).");
          return lines.join("\n");
        });
        return 0;
      }
      break;
    }

    case "workflow": {
      if (sub === "import") {
        const r = importFile(store, need(rest[0], "file"), { approve: !!args.flags["approve-sandbox"] });
        emit({ name: r.workflow.name, version: r.workflow.version, warnings: r.warnings, approvals: r.approvals }, () => {
          const lines = [`imported ${r.workflow.name} (version ${r.workflow.version})`, ...r.warnings.map((w) => `warning: ${w}`)];
          const pending = r.approvals.filter((a) => !a.approved);
          if (pending.length) {
            lines.push("", "These script nodes widen the sandbox and need your approval before the workflow can run:");
            for (const a of pending) lines.push(`  ${a.node_id}: ${a.script}  → ${a.widening}`);
            lines.push(`Review the scripts, then run: chief workflow approve ${r.workflow.name}`);
          }
          return lines.join("\n");
        });
        return 0;
      }
      if (sub === "approve") {
        const r = approveWorkflow(store, need(rest[0], "workflow name"));
        emit(r, () => r.length ? r.map((a) => `approved ${a.node_id}: ${a.script}  → ${a.widening}`).join("\n") : "nothing to approve");
        return 0;
      }
      if (sub === "list") {
        const rows = store.listWorkflows();
        emit(rows.map((w) => ({ name: w.name, version: w.version, nodes: w.definition.nodes.length, updated_at: w.updated_at })), () =>
          rows.length ? table([["NAME", "VERSION", "NODES", "UPDATED"], ...rows.map((w) => [w.name, w.version, w.definition.nodes.length, w.updated_at])]) : "No workflows. Import one: chief workflow import <file>");
        return 0;
      }
      if (sub === "export") {
        const wf = store.getWorkflow(need(rest[0], "workflow name"));
        if (!wf) throw new EngineError(`workflow "${rest[0]}" not found`);
        const text = args.flags.format === "json" ? JSON.stringify(wf.definition, null, 2) + "\n" : toYaml(wf.definition);
        if (typeof args.flags.out === "string") { writeFileSync(args.flags.out, text); out(`wrote ${args.flags.out}`); } else process.stdout.write(text);
        return 0;
      }
      if (sub === "validate") {
        const target = need(rest[0], "file or workflow name");
        const stored = existsSync(target) ? null : store.getWorkflow(target);
        if (!existsSync(target) && !stored) throw new EngineError(`no file or workflow named "${target}"`);
        let raw: unknown;
        try { raw = stored ? stored.definition : parseText(readFileSync(target, "utf8")); } catch (e: any) { throw new EngineError(`cannot parse ${target}: ${e.message}`); }
        const baseDir = stored ? stored.base_dir ?? process.cwd() : dirname(resolve(target));
        const name = (raw as any)?.name;
        const parsed = validateWorkflow(raw);
        if (parsed.ok) await ensureMcp(store, parsed.workflow!, baseDir, 30_000);
        const v = validateFull(store, raw, baseDir, stored?.id ?? (typeof name === "string" ? store.getWorkflow(name)?.id ?? null : null));
        emit({ ok: v.ok, errors: v.errors, warnings: v.warnings, environment: v.environment, estimates: v.estimates }, () => [
          v.ok ? "valid" : "invalid",
          ...v.errors.map((e) => `error: ${e}`), ...v.warnings.map((w) => `warning: ${w}`),
          ...v.environment.map((e) => `environment: ${e}`),
          ...(v.estimates.length ? ["", "Prompt size estimates (before template expansion):", table([["NODE", "CHARS", "~TOKENS"], ...v.estimates.map((e) => [e.node_id, e.chars, e.est_tokens])])] : []),
        ].join("\n"));
        return v.ok ? 0 : 1;
      }
      if (sub === "clone") {
        const ws = expandDir(store.getSetting<string | null>("workspace-dir", null) || defaultWorkspace(), process.cwd());
        const r = cloneWorkflow(store, need(rest[0], "workflow name"), { name: rest[1], workspace: ws });
        emit({ name: r.workflow.name, version: r.workflow.version, base_dir: r.workflow.base_dir, from: r.from, approvals: r.approvals }, () => [
          `cloned ${r.from} as ${r.workflow.name} (v${r.workflow.version}), working directory ${r.workflow.base_dir}`,
          ...(r.approvals.some((a) => !a.approved) ? [`scripts that widen the sandbox need approving again: chief workflow approve ${r.workflow.name}`] : []),
        ].join("\n"));
        return 0;
      }
      if (sub === "rm") {
        const wf = store.getWorkflow(need(rest[0], "workflow name"));
        if (!wf) throw new EngineError(`workflow "${rest[0]}" not found`);
        if (store.workflowHasRuns(wf.id)) throw new EngineError(`workflow "${wf.name}" has runs and cannot be removed`);
        store.deleteWorkflow(wf.id);
        emit({ ok: true }, () => `removed ${wf.name}`);
        return 0;
      }
      break;
    }

    case "run": {
      const inputs: Record<string, unknown> = args.flags["inputs-json"] ? json(args.flags["inputs-json"], "--inputs-json") : {};
      for (const kv of args.multi.input ?? []) {
        const i = kv.indexOf("=");
        if (i < 1) throw new EngineError(`--input expects key=value, got "${kv}"`);
        const raw = kv.slice(i + 1);
        let value: unknown;
        try { value = JSON.parse(raw); } catch { value = raw; }
        // A dotted name sets a nested value: --input params.prlink=https://…
        setInputPath(inputs, kv.slice(0, i), value);
      }
      const budget: any = {};
      if (args.flags["warn-usd"]) budget["warn-usd"] = num(String(args.flags["warn-usd"]), "--warn-usd");
      if (args.flags["max-usd"]) budget["max-usd"] = num(String(args.flags["max-usd"]), "--max-usd");
      const target = store.getWorkflow(need(sub, "workflow name"));
      if (target?.base_dir) { try { mkdirSync(target.base_dir, { recursive: true }); } catch { /* reported by the run if it matters */ } }
      if (target) await ensureMcp(store, target.definition, target.base_dir ?? process.cwd());
      const run = startRun(store, need(sub, "workflow name"), inputs, budget);
      if (!asJson) out(`started run ${run.id}`);
      const done = await driveRun(store, run.id);
      printRun(store, run.id);
      return exitCodeFor(done);
    }

    case "runs": {
      if (sub === "list" || !sub) {
        const only = typeof args.flags.workflow === "string" ? store.getWorkflow(args.flags.workflow) : null;
        if (typeof args.flags.workflow === "string" && !only) throw new EngineError(`workflow "${args.flags.workflow}" not found`);
        const limit = typeof args.flags.limit === "string" ? num(args.flags.limit, "--limit") : 50;
        const offset = typeof args.flags.offset === "string" ? num(args.flags.offset, "--offset") : 0;
        const rows = store.listRuns(limit, only?.id, offset);
        const total = store.countRuns(only?.id);
        const range = rows.length ? `Runs ${offset + 1}–${offset + rows.length} of ${total}.` : `No runs here: there are ${total} in all.`;
        emit(rows.map(({ definition: _d, ...r }) => r), () => !total ? "No runs yet." : rows.length
          ? `${table([["ID", "WORKFLOW", "STATUS", "COST", "CREATED"], ...rows.map((r) => [r.id, r.workflow_name, r.status, usd(r.cost_usd), r.created_at])])}\n\n${range}${offset + rows.length < total ? ` Next: --offset ${offset + rows.length}` : ""}`
          : range);
        return 0;
      }
      if (sub === "set-model") {
        const runId = num(rest[0], "run id");
        const model = need(rest[2], "model (or default)");
        const r = setStepModel(store, runId, need(rest[1], "step id"), model === "default" ? null : model);
        emit({ node_id: r.node_id, from: r.from, to: r.to, changed: r.changed }, () => r.changed
          ? `run ${runId}: step ${r.node_id} now uses ${r.to ?? "the CLI's default model"} (was ${r.from ?? "the CLI's default"}). Continue with: chief resume ${runId}`
          : `run ${runId}: step ${r.node_id} already uses ${r.to ?? "the CLI's default model"}`);
        return 0;
      }
      if (sub === "ask") {
        const runId = num(rest[0], "run id");
        const question = need(rest.slice(1).join(" ").trim(), 'question: chief runs ask <id> "what went wrong?"');
        const r = await askAboutRun(store, runId, { question, model: typeof args.flags.model === "string" ? args.flags.model : undefined });
        emit(r, () => `${r.answer}\n\n(${r.adapter}${r.model ? ` · ${r.model}` : ""} · ${usd(r.cost_usd)}${r.resumed ? " · the conversation continued" : ""})`);
        return 0;
      }
      if (sub === "rerun") {
        const old = store.getRun(num(rest[0], "run id"));
        if (!old) throw new EngineError(`run ${rest[0]} not found`);
        const target = store.getWorkflow(old.workflow_id);
        if (target?.base_dir) { try { mkdirSync(target.base_dir, { recursive: true }); } catch { /* reported by the run if it matters */ } }
        if (target) await ensureMcp(store, target.definition, target.base_dir ?? process.cwd());
        const run = rerunRun(store, old.id);
        if (!asJson) out(`started run ${run.id} (run ${old.id} again)`);
        const done = await driveRun(store, run.id);
        printRun(store, run.id);
        return exitCodeFor(done);
      }
      if (sub === "set-prompt") {
        const runId = num(rest[0], "run id");
        const given = need(rest[2], "prompt (text, or a file holding it)");
        const text = existsSync(given) ? readFileSync(given, "utf8") : given;
        const r = changeStep(store, runId, need(rest[1], "step id"), { prompt: text });
        emit({ node_id: r.node_id, changed: r.changed, restarted: r.restarted }, () => r.changed
          ? `run ${runId}: step ${r.node_id} has a new prompt (${text.length} characters)${r.restarted ? "; it starts again from the beginning" : ""}. Continue with: chief resume ${runId}`
          : `run ${runId}: step ${r.node_id} already has this prompt`);
        return 0;
      }
      if (sub === "rm") {
        if (!rest.length) throw new EngineError("give the ids of the runs to delete: chief runs rm <id...>");
        const r = deleteRuns(store, rest.map((x) => num(x, "run id")));
        emit(r, () => `deleted run${r.deleted.length === 1 ? "" : "s"} ${r.deleted.join(", ")} and everything recorded for ${r.deleted.length === 1 ? "it" : "them"}`);
        return 0;
      }
      if (sub === "show") { printRun(store, num(rest[0], "run id")); return 0; }
      if (sub === "replay") {
        // Plays back the stored record of a run. Nothing is executed again.
        const id = num(rest[0], "run id");
        const run = store.getRun(id);
        if (!run) throw new EngineError(`run ${id} not found`);
        const msgs = store.messages(id, { nodeId: typeof args.flags.node === "string" ? args.flags.node : undefined });
        const limit = args.flags.full ? Infinity : 4000;
        const who: Record<string, string> = { in: "→ to worker", out: "← from worker", user: "● you", system: "· chief" };
        emit(msgs, () => {
          const wf = store.getWorkflow(run.workflow_id);
          const lines = [`Replay of run ${id} (${wf?.name ?? "?"} v${run.workflow_version}, ${run.status}): ${msgs.length} recorded messages${args.flags.node ? ` for node ${args.flags.node}` : ""}`];
          for (const m of msgs) {
            const head = `#${m.id}  ${m.ts.slice(11, 19)}  ${who[m.direction] ?? m.direction}  ${m.kind}${m.node_id ? `  [${m.node_id}${m.node_run_id ? ` #${m.node_run_id}` : ""}]` : ""}${m.meta?.name ? `  ${m.meta.name}` : ""}${m.meta?.is_error ? "  (error)" : ""}`;
            lines.push("", `── ${head} ${"─".repeat(Math.max(3, 96 - head.length))}`);
            if (m.content) lines.push(m.content.length > limit ? `${m.content.slice(0, limit)}\n… [${m.content.length - limit} more characters; add --full]` : m.content);
          }
          return lines.join("\n");
        });
        return 0;
      }
      if (sub === "tail") {
        const id = num(rest[0], "run id");
        if (!store.getRun(id)) throw new EngineError(`run ${id} not found`);
        let after = 0;
        for (;;) {
          const evs = store.events(id, after);
          for (const e of evs) { after = e.id; out(asJson ? JSON.stringify(e) : `${e.ts}  ${e.type}  ${JSON.stringify(e.payload)}`); }
          if (!args.flags.follow) break;
          const run = store.getRun(id)!;
          if (!evs.length && (TERMINAL_RUN.includes(run.status) || ["waiting_gate", "paused", "interrupted"].includes(run.status))) break;
          await sleep(300);
        }
        return 0;
      }
      break;
    }

    case "pause": {
      const id = num(sub, "run id");
      requestPause(store, id);
      await waitWhile(store, id, (r) => r.status === "running");
      const run = store.getRun(id)!;
      emit({ id, status: run.status }, () => `run ${id} is ${run.status}`);
      return 0;
    }

    case "resume": {
      const id = num(sub, "run id");
      // Read the servers again: a resume often follows a fixed connection.
      const before = store.getRun(id);
      if (before) await ensureMcp(store, before.definition, before.base_dir ?? process.cwd());
      const { retryFailed } = resumeRun(store, id);
      const done = await driveRun(store, id, { retryFailed });
      printRun(store, id);
      return exitCodeFor(done);
    }

    case "cancel": {
      const id = num(sub, "run id");
      requestCancel(store, id);
      await waitWhile(store, id, (r) => r.status === "running");
      const run = store.getRun(id)!;
      emit({ id, status: run.status }, () => `run ${id} is ${run.status}`);
      return 0;
    }

    case "gate": {
      if (sub === "list" || !sub) {
        const rows = store.gates(args.flags.all ? {} : { status: "waiting" });
        emit(rows, () => rows.length ? table([["ID", "RUN", "NODE", "KIND", "REASON", "STATUS", "MESSAGE"], ...rows.map((g) => [g.id, g.run_id, g.node_id, g.kind, g.reason, g.status, String(g.payload?.message ?? "").slice(0, 70)])]) : "No gates waiting.");
        return 0;
      }
      const id = num(rest[0], "gate id");
      if (sub === "show") {
        const g = store.getGate(id);
        if (!g) throw new EngineError(`gate ${id} not found`);
        emit(g, () => {
          const lines = [`gate ${g.id}  run ${g.run_id}  ${g.kind} (${g.reason})  ${g.status}`, g.payload?.message ?? ""];
          if (g.kind === "ask") {
            if (g.payload.description) lines.push(g.payload.description);
            const example: Record<string, unknown> = {};
            for (const f of g.payload.fields) {
              lines.push("", `${f.id}${f.required ? " (required)" : ""}: ${f.label}  [${f.type}]`);
              (f.options ?? []).forEach((o: any, i: number) => lines.push(`  [${i}] ${o.label}${o.detail ? `  — ${o.detail}` : ""}`));
              example[f.id] = f.type === "choose-many" ? [0] : f.type === "choose-one" ? 0 : f.type === "yes-no" ? true : "...";
            }
            lines.push("", `answer: chief gate answer ${g.id} '${JSON.stringify({ values: example })}'   (options are given by their number)`);
          } else if (g.kind === "select") {
            lines.push("", ...g.payload.items.map((it: any, i: number) => `  [${i}] ${it?.priority ? it.priority + " " : ""}${it?.title ?? JSON.stringify(it)}${it?.kind ? `  (${it.kind})` : ""}`), "",
              `modes: ${g.payload.modes.join(", ")}`,
              `answer: chief gate answer ${g.id} '{"mode":"one-by-one","selected":[0]}'   or '{"mode":"all"}'   or '{"mode":"by-priority","priority":"P1"}'`);
          } else if (g.kind === "approve") {
            lines.push("", typeof g.payload.value === "string" ? g.payload.value : JSON.stringify(g.payload.value, null, 2), "", `answer: chief gate approve ${g.id} [--value '<edited json>'] [--text "..."]   or   chief gate reject ${g.id}`);
          } else {
            lines.push("", typeof g.payload.summary === "string" ? g.payload.summary : JSON.stringify(g.payload.summary, null, 2), "",
              `answer: chief gate answer ${g.id} '{"text":"...",${g.payload.options?.length ? `"option":"${g.payload.options[0]}"` : ""}}'${g.payload.options?.length ? `   options: ${g.payload.options.join(", ")}` : ""}`);
          }
          return lines.join("\n");
        });
        return 0;
      }
      let answer: any;
      if (sub === "answer") answer = json(rest[1], "answer");
      else if (sub === "approve" || sub === "reject") {
        answer = { decision: sub };
        if (args.flags.value !== undefined) { try { answer.value = JSON.parse(String(args.flags.value)); } catch { answer.value = String(args.flags.value); } }
        if (typeof args.flags.text === "string") answer.text = args.flags.text;
      } else break;
      const { gate, drive } = answerGate(store, id, answer);
      if (!asJson) out(`gate ${id} answered`);
      if (drive) await driveRun(store, gate.run_id);
      else await sleep(100);
      printRun(store, gate.run_id);
      return exitCodeFor(store.getRun(gate.run_id)!);
    }

    case "revert": {
      const id = num(sub, "run id");
      const report = await revertRun(store, id, { to: typeof args.flags.to === "string" ? args.flags.to : undefined });
      emit(report, () => {
        const lines = [`run ${id} reverted`, `compensated: ${report.compensated.length ? report.compensated.join(", ") : "none"}`, `side effects reverted: ${report.reverted_effects}`];
        if (report.manual.length) {
          lines.push("", "Manual follow-up needed:");
          for (const m of report.manual) lines.push(`  ${m.node_id}${m.item_index != null ? `[${m.item_index}]` : ""}: ${m.kind} ${m.ref ?? ""} ${m.url ?? ""} — ${m.reason}${m.how_to_undo ? ` (how to undo: ${m.how_to_undo})` : ""}`);
        } else lines.push("nothing left to undo by hand");
        return lines.join("\n");
      });
      return 0;
    }

    case "models": {
      const adapter = typeof args.flags.adapter === "string" ? args.flags.adapter : store.getSetting<string>("default-adapter", "claude-code");
      const r = await listModels(store, adapter, true);
      emit(r, () => [
        r.models.length ? table([["MODEL", "NAME", "DESCRIPTION"], ...r.models.map((m) => [m.value, m.label, m.description ?? ""])]) : `${adapter} offers no models to choose from.`,
        ...(r.note ? ["", r.note] : []),
      ].join("\n"));
      return 0;
    }

    case "schedule": {
      if (sub === "list" || !sub) {
        const rows = store.schedules();
        emit(rows, () => rows.length ? table([["ID", "WORKFLOW", "CRON", "ENABLED", "LAST RUN"], ...rows.map((s) => [s.id, s.workflow_name, s.cron, s.enabled ? "yes" : "no", s.last_run_at ?? "never"])]) + "\n\nSchedules fire only while `chief serve` is running." : "No schedules.");
        return 0;
      }
      if (sub === "add") {
        const row = addSchedule(store, need(rest[0], "workflow name"), need(rest[1], "cron expression"), args.flags["inputs-json"] ? json(args.flags["inputs-json"], "--inputs-json") : {});
        emit(row, () => `schedule ${row.id} added: ${rest[0]} at "${row.cron}" (fires while \`chief serve\` is running)`);
        return 0;
      }
      if (sub === "rm") {
        const sid = num(rest[0], "schedule id");
        if (!store.removeSchedule(sid)) throw new EngineError(`schedule ${sid} not found`);
        emit({ ok: true }, () => `schedule ${sid} removed`);
        return 0;
      }
      if (sub === "enable" || sub === "disable") {
        const sid = num(rest[0], "schedule id");
        store.setScheduleEnabled(sid, sub === "enable");
        emit({ ok: true }, () => `schedule ${sid} ${sub}d`);
        return 0;
      }
      break;
    }

    case "settings": {
      if (sub === "get" || !sub) {
        const data = rest[0] ? store.getSetting(rest[0], null) : store.allSettings();
        emit(data, () => JSON.stringify(data, null, 2));
        return 0;
      }
      if (sub === "set") {
        const key = need(rest[0], "key");
        let value: unknown = need(rest[1], "value");
        try { value = JSON.parse(String(value)); } catch { /* keep as string */ }
        store.setSetting(key, value);
        emit({ [key]: value }, () => `${key} = ${JSON.stringify(value)}`);
        return 0;
      }
      break;
    }
  }
  if (cmd === "serve") {
    const { serve } = await import("./server/serve.ts");
    await serve(store, args.flags.port !== undefined ? num(String(args.flags.port), "--port") : 8080, { open: !args.flags["no-open"] });
    await new Promise(() => {}); // until interrupted
  }
  throw new EngineError(`unknown command: ${args._.join(" ")}\n\n${HELP}`);
}

main().then(
  (code) => process.exit(code),
  (e) => {
    const message = e instanceof EngineError ? e.message : e?.stack ?? String(e);
    if (asJson) process.stdout.write(JSON.stringify({ error: e?.message ?? String(e) }) + "\n");
    else process.stderr.write(`chief: ${message}\n`);
    process.exit(e instanceof EngineError ? 1 : 70);
  },
);
