import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { availableAdapters, getAdapter } from "./adapters/index.ts";
import { detectProviders } from "./providers.ts";
import { describeWidening, EngineError, preflight } from "./engine/engine.ts";
import { widenedScripts } from "./engine/runners.ts";
import { effectiveBudget } from "./engine/context.ts";
import { log } from "./log.ts";
import { agentFolder, chiefHome, dbPath, defaultWorkspace } from "./paths.ts";
import { sandboxStatus } from "./sandbox/sandbox.ts";
import type { ModelChoice } from "./adapters/types.ts";
import type { Store } from "./store/store.ts";
import { TERMINAL_RUN, type WorkflowRow } from "./store/types.ts";
import { executableNodes, parseText, validateWorkflow } from "./workflow/load.ts";
import type { Workflow } from "./workflow/schema.ts";
import { estimateTokens } from "./workflow/template.ts";
import { mergeInputs, missingInputs, missingInputsMessage } from "./workflow/inputs.ts";
import { parseCron } from "./util/cron.ts";

/** Operations shared by the CLI and the HTTP server. */

export interface PendingApproval { key: string; node_id: string; script: string; widening: string; approved: boolean; missing: boolean }

export function pendingApprovals(store: Store, wf: WorkflowRow): PendingApproval[] {
  return widenedScripts(wf.definition, wf.base_dir ?? process.cwd()).map((w) => ({
    key: w.key, node_id: w.nodeId, script: w.path, widening: describeWidening(w.sandbox),
    approved: !!w.hash && store.getApproval(wf.id, w.key) === w.hash, missing: !w.hash,
  }));
}

/** Approve the current scripts of every node that widens the sandbox. Approval is tied to the script's hash. */
export function approveWorkflow(store: Store, name: string): PendingApproval[] {
  const wf = store.getWorkflow(name);
  if (!wf) throw new EngineError(`workflow "${name}" not found`);
  for (const w of widenedScripts(wf.definition, wf.base_dir ?? process.cwd())) {
    if (!w.hash) throw new EngineError(`node "${w.nodeId}": script not found: ${w.path}`);
    store.setApproval(wf.id, w.key, w.hash);
  }
  return pendingApprovals(store, wf);
}

export interface SaveResult { workflow: WorkflowRow; warnings: string[]; approvals: PendingApproval[] }

/** Validate and store a definition. Throws an EngineError listing every problem when it is invalid. */
export function saveDefinition(store: Store, raw: unknown, baseDir: string | null, opts: { approve?: boolean; autosave?: boolean; renameFrom?: string } = {}): SaveResult {
  const v = validateWorkflow(raw);
  if (!v.ok) throw new EngineError(`invalid workflow:\n- ${v.errors.join("\n- ")}`);
  const name = v.workflow!.name;
  // The designer renames by typing: the workflow keeps its identity (runs, schedules, approvals).
  if (opts.renameFrom && opts.renameFrom !== name) {
    const from = store.getWorkflow(opts.renameFrom);
    if (from) {
      if (store.getWorkflow(name)) throw new EngineError(`a workflow named "${name}" already exists; choose another name`);
      store.renameWorkflow(from.id, name);
    }
  }
  const existing = store.getWorkflow(name);
  const workflow = store.saveWorkflow(name, v.workflow, baseDir ?? existing?.base_dir ?? null, opts.autosave ? "autosave" : "version");
  if (opts.approve) approveWorkflow(store, workflow.name);
  return { workflow, warnings: v.warnings, approvals: pendingApprovals(store, workflow) };
}

/**
 * Copy a workflow under a new name, as a workflow of its own at version 1: the same steps, layout,
 * arrows, inputs, budget and agent. Nothing that belongs to the original's history comes along:
 * not its runs, not its schedules, and not its script approvals (a script that widens the sandbox
 * is approved again for the copy).
 *
 * The folder: a workflow in its default folder (`<workspace>/<name>`) gives the copy its own
 * default folder; a workflow with a folder the author chose keeps that folder, where its scripts
 * and its folder-local MCP servers are.
 */
export function cloneWorkflow(store: Store, source: string, opts: { name?: string; workspace: string }): SaveResult & { from: string } {
  const src = store.getWorkflow(source);
  if (!src) throw new EngineError(`workflow "${source}" not found`);
  let name = (opts.name ?? "").trim();
  if (name) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new EngineError(`"${name}" is not a valid workflow name: use lower-case letters, digits and dashes`);
    if (store.getWorkflow(name)) throw new ConflictError(`a workflow named "${name}" already exists; choose another name`);
  } else {
    name = `${src.name}-copy`;
    for (let i = 2; store.getWorkflow(name); i++) name = `${src.name}-copy-${i}`;
  }
  const workspace = resolve(opts.workspace);
  const ownFolder = !!src.base_dir && resolve(src.base_dir) !== join(workspace, src.name);
  const baseDir = ownFolder ? src.base_dir! : join(workspace, name);
  const r = saveDefinition(store, { ...src.definition, name }, baseDir);
  return { ...r, from: src.name };
}

export function importFile(store: Store, file: string, opts: { approve?: boolean } = {}): SaveResult {
  const path = resolve(file);
  if (!existsSync(path)) throw new EngineError(`file not found: ${path}`);
  let raw: unknown;
  try { raw = parseText(readFileSync(path, "utf8")); } catch (e: any) { throw new EngineError(`cannot parse ${file}: ${e.message}`); }
  return saveDefinition(store, raw, dirname(path), opts);
}

/** Static prompt-size estimate per agent node (templates unexpanded), shown before a run. */
export function promptEstimates(wf: Workflow): { node_id: string; chars: number; est_tokens: number }[] {
  return executableNodes(wf).filter((x) => x.node.type === "agent").map(({ top, node }) => ({ node_id: top.id, chars: node.prompt.length, est_tokens: estimateTokens(node.prompt) }));
}

export function validateFull(store: Store, raw: unknown, baseDir: string, workflowId: number | null) {
  const v = validateWorkflow(raw);
  if (!v.ok) return { ok: false, errors: v.errors, warnings: v.warnings, environment: [] as string[], estimates: [] as ReturnType<typeof promptEstimates> };
  const pre = preflight(store, v.workflow!, baseDir, workflowId);
  return { ok: true, errors: [] as string[], warnings: v.warnings, environment: pre.errors, estimates: promptEstimates(v.workflow!), workflow: v.workflow };
}

/** The folder to start an agent CLI in to ask about a folder: that folder, or the nearest one above it that exists (nothing is created). */
function existingDir(dir: string): string {
  let d = resolve(dir);
  while (!existsSync(d) && dirname(d) !== d) d = dirname(d);
  return d;
}

/**
 * Ask the agent CLIs for their MCP servers in each folder and remember the answers per folder.
 * A CLI's servers depend on the folder it runs in (Claude Code's local scope and `.mcp.json`).
 * chief has no MCP configuration of its own; this is a cache of what the CLIs report.
 */
export async function refreshMcp(store: Store, adapters: string[] = availableAdapters(), folders: string[] = [process.cwd()]) {
  const result: Record<string, { count: number; error?: string; folders: Record<string, number> }> = {};
  const where = [...new Set(folders.map((f) => resolve(f)))];
  for (const name of adapters) {
    const r: { count: number; error?: string; folders: Record<string, number> } = (result[name] = { count: 0, folders: {} });
    try {
      const adapter = getAdapter(store, name);
      const info = await adapter.info();
      if (!info.found) { for (const f of where) store.replaceMcpServers(name, f, []); r.error = "CLI not installed"; continue; }
      const names = new Set<string>();
      for (const f of where) {
        const t0 = Date.now();
        const servers = await adapter.discoverMcp(existingDir(f));
        store.replaceMcpServers(name, f, servers);
        r.folders[f] = servers.length;
        for (const s of servers) names.add(s.name);
        const off = servers.filter((s) => s.config?.status && s.config.status !== "connected").length;
        log(`MCP servers of ${name} in ${f}: ${servers.length}${off ? ` (${off} not connected)` : ""} (${Date.now() - t0} ms)`);
      }
      r.count = names.size;
    } catch (e: any) {
      r.error = e.message;
      log(`could not read the MCP servers of ${name}: ${e.message}`);
    }
  }
  return result;
}

/**
 * For each adapter a workflow's agent steps (and its ask gates) use, the folders they run in.
 * Those are the folders whose MCP servers matter for the workflow.
 */
export function agentFolders(store: Store, wf: Workflow, baseDir: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (adapter: string, folder: string) => { if (availableAdapters().includes(adapter)) (out.get(adapter) ?? out.set(adapter, new Set()).get(adapter)!).add(folder); };
  const fallback = wf.agent ?? store.getSetting<string>("default-adapter", "claude-code");
  for (const { node } of executableNodes(wf)) {
    if (node.type === "agent" || node.compensate?.prompt) add(node.agent ?? fallback, agentFolder(node, baseDir));
  }
  for (const n of wf.nodes) if (n.type === "gate" && n.kind === "ask") add(n.agent ?? fallback, resolve(baseDir));
  return out;
}

/**
 * Bring the remembered server lists up to date before a workflow is checked, run or resumed, so
 * that "which servers exist and are connected" always comes from the agent CLI's current state in
 * the folders the steps run in. `maxAgeMs` lets interactive checks reuse a list read a moment ago.
 */
export async function ensureMcp(store: Store, wf: Workflow, baseDir: string, maxAgeMs = 0): Promise<void> {
  for (const [adapter, folders] of agentFolders(store, wf, baseDir)) {
    const stale = [...folders].filter((f) => !maxAgeMs || Date.now() - store.mcpReadAt(adapter, f) >= maxAgeMs);
    if (!stale.length) continue;
    const r = (await refreshMcp(store, [adapter], stale))[adapter];
    if (r.error && r.error !== "CLI not installed") throw new EngineError(`could not read the MCP servers of ${adapter}: ${r.error}`);
  }
}

/** The folders whose servers are worth showing: the default workspace and every workflow's agent folders. */
export function knownFolders(store: Store, defaultFolder: string): string[] {
  const out = new Set<string>([resolve(defaultFolder)]);
  for (const w of store.listWorkflows()) for (const fs of agentFolders(store, w.definition, w.base_dir ?? defaultFolder).values()) for (const f of fs) out.add(f);
  return [...out];
}

export async function doctor(store: Store) {
  // Detection happens here, and it is what fills the paths in Settings (task 15.14): the page asks
  // `doctor`, so a CLI installed after the last check is found without anyone typing anything.
  const providers = await detectProviders(store);
  const adapters = providers.map((p) => ({ name: p.name, found: p.found, path: p.path, version: p.version, ok: p.ok, note: p.note, enabled: p.enabled }));
  const sandbox = sandboxStatus();
  const migrations = store.appliedMigrations();
  const defaultAdapter = store.getSetting<string>("default-adapter", "claude-code");
  const problems: string[] = [];
  const def = adapters.find((a) => a.name === defaultAdapter);
  // A provider that was turned off on purpose is not a problem; one that is on but unusable is.
  if (def?.enabled && !def.ok) problems.push(`default adapter ${defaultAdapter}: ${def.note ?? "not usable"}`);
  if (def && !def.enabled) problems.push(`default adapter ${defaultAdapter} is turned off in Settings (Providers)`);
  if (!sandbox.available) problems.push(`script nodes disabled: ${sandbox.reason}`);
  return {
    ok: problems.length === 0, problems,
    home: chiefHome(), db: { path: dbPath(), ok: true, migrations: migrations.length, latest: migrations.at(-1)?.name ?? null, schemas: store.schemas() },
    adapters, providers, default_adapter: defaultAdapter,
    sandbox: { ...sandbox, script_nodes: sandbox.available ? "enabled" : "disabled" },
    mcp_servers: new Set(store.mcpServers().map((s) => `${s.adapter}/${s.name}`)).size, platform: process.platform, node: process.version,
  };
}

/**
 * The models an adapter's CLI offers, for the model dropdown. Asked from the CLI and remembered
 * for ten minutes; `refresh` asks again now.
 */
export async function listModels(store: Store, adapter: string, refresh = false): Promise<{ adapter: string; models: ModelChoice[]; note?: string }> {
  if (!availableAdapters().includes(adapter)) throw new EngineError(`unknown agent adapter "${adapter}" (available: ${availableAdapters().join(", ")})`);
  const cached = store.getSetting<any>(`models.${adapter}`, null);
  if (!refresh && cached && Date.now() - cached.at < 10 * 60_000) return { adapter, models: cached.models, note: cached.note };
  const impl = getAdapter(store, adapter);
  const info = await impl.info();
  if (!info.found) return { adapter, models: [], note: "CLI not installed" };
  const r = await impl.listModels();
  store.setSetting(`models.${adapter}`, { at: Date.now(), models: r.models, note: r.note });
  return { adapter, ...r };
}

export function addSchedule(store: Store, workflowName: string, cron: string, inputs: Record<string, unknown> = {}) {
  const wf = store.getWorkflow(workflowName);
  if (!wf) throw new EngineError(`workflow "${workflowName}" not found`);
  try { parseCron(cron); } catch (e: any) { throw new EngineError(`invalid cron expression: ${e.message}`); }
  // A schedule whose runs would be refused for a missing input is refused now, while someone is there to read it.
  const missing = missingInputs(wf.definition, mergeInputs(wf.definition.inputs, inputs));
  if (missing.length) throw new EngineError(missingInputsMessage(`schedule "${wf.name}"`, missing, mergeInputs(wf.definition.inputs, inputs)));
  return store.addSchedule(wf.id, cron.trim().split(/\s+/).join(" "), inputs);
}

/** Run detail as shown by `chief runs show` and the web UI. */
const REFINE: Record<string, string> = {
  agent: "The text is the prompt of one step of an automated workflow. An agent carries it out unattended: it cannot ask the author anything while it works, and it is given the results of earlier steps automatically.",
  gate: "The text is an instruction for a checkpoint of an automated workflow. It describes, in plain words, what the person running the workflow should be asked at that point; another agent turns it into a form.",
  compensate: "The text is the prompt that undoes what one step of an automated workflow did. An agent carries it out unattended when the run is reverted.",
};

/**
 * Ask an agent CLI to rewrite a prompt the author typed, so that it is clear and complete. Nothing
 * is stored: the caller shows the result and the author keeps it or goes back. Not part of any run.
 */
export async function refinePrompt(store: Store, v: { text: string; kind?: string; adapter?: string; model?: string }): Promise<{ text: string; adapter: string; cost_usd: number }> {
  const text = String(v.text ?? "").trim();
  if (!text) throw new EngineError("there is no prompt to refine yet: type what the step should do first");
  const adapterName = v.adapter || store.getSetting<string>("default-adapter", "claude-code");
  const adapter = getAdapter(store, adapterName);
  const prompt = [
    "Rewrite the text between the <prompt> tags so that it is clear, specific and well organised.",
    REFINE[v.kind ?? "agent"] ?? REFINE.agent,
    "Rules:",
    "- Keep the author's intent and every requirement, name, example and URL. Do not add requirements, steps or tools the author did not ask for, and do not carry the task out.",
    "- Keep every template placeholder exactly as written, for example {{inputs.x}}, {{nodes.id.output.path}} and {{item}}.",
    "- Fix grammar and spelling, remove repetition, put the goal first, and use short paragraphs or a list where that helps.",
    "- Do not add instructions about the format of the reply (a JSON block, side effects): the orchestrator appends those itself.",
    "- Write in the language of the original.",
    "Reply with the rewritten text only: no introduction, no explanation, no code fence.",
    "",
    `<prompt>\n${text}\n</prompt>`,
  ].join("\n");
  const cwd = defaultWorkspace();
  mkdirSync(cwd, { recursive: true });
  const res = await adapter.run({ prompt, model: v.model || undefined, servers: [], allServers: [], builtinTools: "none", cwd, timeoutMs: 3 * 60_000 });
  if (res.error || res.interrupted || res.cancelled) throw new EngineError(`${adapterName} could not refine the prompt: ${res.error ?? "it was stopped"}`);
  let out = res.text.trim();
  const fenced = out.match(/^```[a-z]*\n([\s\S]*?)\n```$/);
  if (fenced) out = fenced[1].trim();
  out = out.replace(/^<prompt>\s*/, "").replace(/\s*<\/prompt>$/, "");
  if (!out) throw new EngineError(`${adapterName} returned nothing for the prompt`);
  log(`prompt refined by ${adapterName}: ${text.length} → ${out.length} characters, $${(res.usage?.cost_usd ?? 0).toFixed(4)}`);
  return { text: out, adapter: adapterName, cost_usd: res.usage?.cost_usd ?? 0 };
}

/** Run statuses in which nothing is executing, so a step that has not completed may be changed before the run is resumed. */
export const STOPPED_RUN = ["failed", "paused", "interrupted", "waiting_gate"];

/**
 * Change an agent step of a run, for this run only, while the run is stopped: its model, its prompt,
 * or both. The step must not have completed (completed steps keep their results); a step that has
 * not started yet can be changed too. The workflow itself is not changed. Each change is written to
 * the run's record (`run_step_changed`, with the old and the new value).
 *
 * On resume a failed step gets a new attempt with what was changed. An interrupted step continues
 * its session with a new model, but a new prompt starts it again: its interrupted attempt is closed
 * as cancelled and a new attempt is opened. A step waiting for the answer to its own question is
 * treated the same way when its prompt changes: the question is withdrawn and the step starts again,
 * and the run is then paused so that Resume runs it (a new model alone is used when it continues
 * after the answer). For a map, the change applies to its inner step: its completed items stay, the
 * others use the new version. `model` null or "" means the CLI's default.
 */
export function changeStep(store: Store, runId: number, nodeId: string, patch: { model?: string | null; prompt?: string }) {
  const run = store.getRun(runId);
  if (!run) throw new EngineError(`run ${runId} not found`);
  if (!STOPPED_RUN.includes(run.status)) throw new ConflictError(`run ${runId} is ${run.status}: a step can be changed only while the run is stopped (failed, paused, interrupted or waiting at a gate)`);
  const def: any = structuredClone(run.definition);
  const node = (def.nodes ?? []).find((n: any) => n.id === nodeId);
  if (!node) throw new EngineError(`step "${nodeId}" not found in run ${runId}`);
  const target = node.type === "agent" ? node : node.type === "map" && node.node?.type === "agent" ? node.node : null;
  if (!target) throw new EngineError(`step "${nodeId}" is a ${node.type} step${node.type === "map" ? " whose inner step is not an agent" : ""}: only agent steps can be changed in a run`);
  const last = store.latestNodeRun(runId, nodeId);
  if (last?.status === "completed") throw new ConflictError(`step "${nodeId}" of run ${runId} has already completed and its result is kept: only steps that have not completed can be changed`);

  const changes: { field: "model" | "prompt"; from: string | null; to: string | null }[] = [];
  if (patch.model !== undefined) {
    const to = (patch.model ?? "").trim() || null;
    if (to && !/^[A-Za-z0-9._:\/\[\]-]{1,100}$/.test(to)) throw new EngineError(`"${to}" is not a model name`);
    const from = target.model ?? null;
    if (from !== to) { if (to) target.model = to; else delete target.model; changes.push({ field: "model", from, to }); }
  }
  let restart = false;
  if (patch.prompt !== undefined) {
    const to = String(patch.prompt);
    if (!to.trim()) throw new EngineError("the prompt cannot be empty");
    const from = target.prompt ?? "";
    if (from !== to) { target.prompt = to; changes.push({ field: "prompt", from, to }); restart = true; }
  }
  if (!changes.length) return { run, node_id: nodeId, changes, restarted: 0, changed: false };
  const v = validateWorkflow(def);
  if (!v.ok) throw new EngineError(`the step would not be valid:\n- ${v.errors.join("\n- ")}`);
  const missing = missingInputs(def, mergeInputs(def.inputs, run.inputs));
  if (missing.length) throw new EngineError(`the step refers to ${missing.length === 1 ? "an input this run does not have" : "inputs this run does not have"}: ${missing.map((m) => `inputs.${m}`).join(", ")}`);

  // A new prompt cannot continue a session that was started with the old one: start those again.
  let restarted = 0;
  if (restart) {
    const interrupted = node.type === "map"
      ? (last ? latestChildren(store, runId, last.id).filter((c) => c.status === "interrupted" || c.status === "waiting_gate") : [])
      : last && (last.status === "interrupted" || last.status === "waiting_gate") ? [last] : [];
    for (const nr of interrupted) {
      // Its own question is withdrawn: the step is not asking it any more.
      if (nr.status === "waiting_gate") { const g = store.latestGateFor(nr.id); if (g?.status === "waiting") store.cancelGate(g.id); }
      store.updateNodeRun(nr.id, { status: "cancelled", error: "the prompt was changed while the run was stopped; the step starts again with the new prompt", finished_at: new Date().toISOString() });
      store.createNodeRun({ run_id: runId, node_id: nr.node_id, node_type: nr.node_type, attempt: nr.attempt + 1, parent_node_run_id: nr.parent_node_run_id, item_index: nr.item_index, input: nr.input?.item !== undefined ? { item: nr.input.item } : undefined });
      restarted++;
    }
  }
  store.updateRunDefinition(runId, def);
  for (const c of changes) store.addEvent(runId, "run_step_changed", { node_id: nodeId, ...c, ...(c.field === "prompt" ? { restarted } : {}) });
  // A run that was only waiting for that question now waits for Resume.
  if (restarted && run.status === "waiting_gate" && !store.gates({ runId }).some((g) => g.status === "waiting")) {
    store.updateRun(runId, { status: "paused", requested_action: null });
    store.addEvent(runId, "run_paused", { reason: `step ${nodeId} was changed instead of answering its question` });
  }
  return { run: store.getRun(runId)!, node_id: nodeId, changes, restarted, changed: true };
}

/** The latest attempt of each item of a map's node run. */
function latestChildren(store: Store, runId: number, parentId: number) {
  const latest = new Map<number, ReturnType<Store["nodeRuns"]>[number]>();
  for (const n of store.nodeRuns(runId)) if (n.parent_node_run_id === parentId) latest.set(n.item_index ?? -1, n);
  return [...latest.values()];
}

/** Change only a step's model (see changeStep). */
export function setStepModel(store: Store, runId: number, nodeId: string, model: string | null) {
  const r = changeStep(store, runId, nodeId, { model });
  const c = r.changes.find((x) => x.field === "model");
  const target: any = (() => { const n: any = (r.run.definition as any).nodes.find((x: any) => x.id === nodeId); return n?.type === "map" ? n.node : n; })();
  return { run: r.run, node_id: nodeId, from: c ? c.from : target?.model ?? null, to: c ? c.to : target?.model ?? null, changed: r.changed };
}

/** A request that is valid but cannot be done in the current state (HTTP 409). */
export class ConflictError extends EngineError {}

/**
 * Delete finished runs with their whole record. Nothing is deleted when one of them is unknown or
 * still active: an active run has to be cancelled first, so that no process is still writing to it.
 */
export function deleteRuns(store: Store, ids: number[]): { deleted: number[] } {
  const unique = [...new Set(ids)];
  if (!unique.length) throw new EngineError("no runs given");
  for (const id of unique) {
    const run = store.getRun(id);
    if (!run) throw new EngineError(`run ${id} not found`);
    if (!TERMINAL_RUN.includes(run.status)) throw new ConflictError(`run ${id} is ${run.status}: cancel it before deleting it`);
  }
  store.deleteRuns(unique);
  return { deleted: unique };
}

export function runDetail(store: Store, runId: number) {
  const run = store.getRun(runId);
  if (!run) throw new EngineError(`run ${runId} not found`);
  const wf = store.getWorkflow(run.workflow_id);
  // What each node received and, for a gate, what was answered: taken from the run's record. Only those
  // kinds are read — the transcript itself is megabytes and is not what this page needs (task 15.23).
  const sent = new Map<number, { kind: string; text: string }>();
  const answers = new Map<number, string>();
  for (const m of store.runInputs(runId)) {
    if (m.node_run_id == null) continue;
    if (["prompt", "stdin", "gate_question"].includes(m.kind) && (!sent.has(m.node_run_id) || m.kind === "gate_question")) sent.set(m.node_run_id, { kind: m.kind, text: m.content });
    if (m.kind === "gate_answer") answers.set(m.node_run_id, m.content);
  }
  return {
    run: { ...run, workflow_name: wf?.name ?? null },
    node_runs: store.nodeRuns(runId).map((n) => ({
      ...n,
      io: { input_kind: sent.get(n.id)?.kind ?? null, input: sent.get(n.id)?.text ?? null, answer: answers.get(n.id) ?? null, reply: typeof n.state?.reply === "string" && n.state.reply ? n.state.reply : null },
    })),
    gates: store.gates({ runId }),
    // The workflow as it is now, when it has changed since the run started: the run page offers its
    // steps' prompts and models to an unfinished step of the run.
    current: wf && wf.version !== run.workflow_version ? { version: wf.version, nodes: wf.definition.nodes } : null,
    side_effects: store.sideEffects({ runId }),
    messages: store.messageCount(runId),
    budget: effectiveBudget(store, run),
  };
}
