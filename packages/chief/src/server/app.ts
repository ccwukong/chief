import { Hono } from "hono";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { ADAPTER_NAMES, availableAdapters } from "../adapters/index.ts";
import { enabledProviders, providerChosenOff, providerLocated } from "../providers.ts";
import { askAboutRun, askAdapter, askConversation, assistantAnswer, assistantConversation } from "../ask.ts";
import { answerGate, driveRun, EngineError, requestCancel, requestPause, rerunRun, resumeRun, startRun } from "../engine/engine.ts";
import { revertRun } from "../engine/saga.ts";
import { addSchedule, approveWorkflow, cloneWorkflow, ConflictError, deleteRuns, doctor, ensureMcp, knownFolders, listModels, refreshMcp, pendingApprovals, refinePrompt, runDetail, changeStep, setStepModel, saveDefinition, validateFull } from "../ops.ts";
import { log, logDebug, logging } from "../log.ts";
import { defaultWorkspace } from "../paths.ts";
import { sandboxStatus } from "../sandbox/sandbox.ts";
import type { Store } from "../store/store.ts";
import { TERMINAL_RUN } from "../store/types.ts";
import { parseText, toYaml, validateWorkflow } from "../workflow/load.ts";
import { describeInputs } from "../workflow/inputs.ts";
import { describeCron, minuteKey, nextRun } from "../util/cron.ts";

/** See /api/meta. Keep in step with REQUIRED_API in packages/web/src/app.tsx. */
export const API_LEVEL = 14;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon", ".map": "application/json", ".woff2": "font/woff2",
};

export interface WebAssets { get(path: string): { body: Uint8Array | string; type: string } | null }

/** Built web UI from disk (development). The compiled binary embeds it instead. */
export function diskAssets(dir: string): WebAssets {
  return {
    get(path) {
      const file = normalize(join(dir, path));
      if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) return null;
      return { body: readFileSync(file), type: MIME[extname(file)] ?? "application/octet-stream" };
    },
  };
}

const expandHome = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : resolve(p));

/**
 * REST + SSE API. Local only: there is no auth, so requests must come from this machine's
 * browser to this exact origin (guards against DNS rebinding and cross-site requests).
 */
export function createApp(store: Store, opts: { port: () => number; assets: WebAssets | null }) {
  const app = new Hono();
  const active = new Map<number, Promise<unknown>>();

  /** Drive a run in the background of this server process. */
  const launch = (runId: number, o: { retryFailed?: boolean } = {}) => {
    const p = driveRun(store, runId, o)
      .catch((e) => store.addEvent(runId, "engine_error", { error: e?.message ?? String(e) }))
      .finally(() => { if (active.get(runId) === p) active.delete(runId); });
    active.set(runId, p);
  };

  // The terminal log (only `chief serve` turns it on): every change made through the API and every
  // failed request. What the web UI asks all the time (polling, drafts, the event stream) only with
  // CHIEF_LOG=debug, so that the log shows what happened rather than the page refreshing itself.
  const errors = new WeakMap<object, string>();
  app.use("*", async (c, next) => {
    const t0 = performance.now();
    await next();
    if (!logging()) return;
    const path = new URL(c.req.url).pathname;
    if (!path.startsWith("/api/")) return logDebug(`${c.req.method} ${path} ${c.res.status}`);
    const ms = Math.round(performance.now() - t0);
    const failed = c.res.status >= 400;
    const chatter = c.req.method === "GET" || path.startsWith("/api/drafts") || (c.req.method === "POST" && path === "/api/workflows/validate");
    const line = `${c.req.method} ${path}${c.req.url.includes("?") ? "?" + new URL(c.req.url).searchParams : ""} ${c.res.status} ${ms}ms${failed && errors.has(c.req.raw) ? `: ${errors.get(c.req.raw)}` : ""}`;
    if (failed || !chatter) log(line); else logDebug(line);
  });

  app.use("*", async (c, next) => {
    const allowed = new Set([`127.0.0.1:${opts.port()}`, `localhost:${opts.port()}`]);
    const host = c.req.header("host") ?? "";
    if (!allowed.has(host)) return c.json({ error: "forbidden host" }, 403);
    const origin = c.req.header("origin");
    if (origin && !allowed.has(origin.replace(/^https?:\/\//, ""))) return c.json({ error: "forbidden origin" }, 403);
    await next();
  });

  // The API is never cached. Without this a browser may reuse a GET response heuristically — a reload
  // after a setting changed could show the value from before it (found with the theme, task 15.8).
  app.use("/api/*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });

  app.onError((e, c) => {
    errors.set(c.req.raw, e instanceof SyntaxError ? "request body is not valid JSON" : e.message);
    if (e instanceof EngineError) return c.json({ error: e.message }, e instanceof ConflictError ? 409 : /not found/.test(e.message) ? 404 : 400);
    if (e instanceof SyntaxError) return c.json({ error: "request body is not valid JSON" }, 400);
    console.error(e);
    return c.json({ error: e.message }, 500);
  });

  const id = (v: string, what: string) => {
    const n = Number(v);
    if (!Number.isInteger(n)) throw new EngineError(`${what} must be a number`);
    return n;
  };
  const body = async (c: any) => {
    const b = await c.req.json();
    if (!b || typeof b !== "object") throw new EngineError("request body must be a JSON object");
    return b;
  };

  // ── environment ─────────────────────────────────────────────────────────
  app.get("/api/doctor", async (c) => c.json(await doctor(store)));
  app.get("/api/meta", (c) => c.json({
    // Raised whenever the web UI starts to rely on something new in this API. The page compares it
    // with the level it was built for and tells the user to restart an older server.
    api: API_LEVEL,
    // The agent CLIs a person can pick: one turned off in Settings (Providers) is not offered here,
    // so no picker can hand a step a CLI the person has said not to use (task 15.14).
    adapters: enabledProviders(store),
    /** Which CLIs could run a step now: not switched off, and the program is on this machine. Empty means
     *  chief cannot start a run, which is what the warning bar and the bell report (task 15.15). */
    usable_adapters: ADAPTER_NAMES.filter((n) => !providerChosenOff(store, n) && providerLocated(store, n)),
    /** Every agent CLI chief knows, with its two independent facts: the person's switch, and whether the
     *  program is there. The designer lists them all as a status list; the pickers use `adapters`. */
    providers: ADAPTER_NAMES.map((name) => ({ name, enabled: !providerChosenOff(store, name), found: providerLocated(store, name) })),
    /** The CLIs detection found at the last check, switched on or not. */
    found_providers: store.getSetting<string[]>("providers.found", []),
    default_adapter: (() => { const d = store.getSetting("default-adapter", "claude-code"); return enabledProviders(store).includes(d) ? d : (enabledProviders(store)[0] ?? d); })(),
    sandbox: sandboxStatus(), workspace_dir: (store.getSetting<string | null>("workspace-dir", null) || defaultWorkspace()), default_workspace_dir: defaultWorkspace(),
  }));

  // The agent CLIs' own servers. Read-only: chief does not configure MCP servers.
  // Per folder: an agent CLI has different servers in different folders. `workflow` asks for a
  // workflow's folder, `base_dir` for a folder being typed in the designer (nothing is created);
  // without either, the default workspace. The folder is in the X-Mcp-Folder header.
  const workspace = () => expandHome(store.getSetting<string | null>("workspace-dir", null) || defaultWorkspace());
  app.get("/api/mcp", async (c) => {
    const wf = c.req.query("workflow") ? store.getWorkflow(c.req.query("workflow")!) : null;
    const typed = c.req.query("base_dir");
    const name = c.req.query("name");
    const folder = resolve(typed ? expandHome(typed) : wf?.base_dir ?? (name ? join(workspace(), name) : workspace()));
    const stale = availableAdapters().filter((a) => c.req.query("refresh") || Date.now() - store.mcpReadAt(a, folder) > 5 * 60_000);
    if (stale.length) await refreshMcp(store, stale, [folder]);
    c.header("X-Mcp-Folder", folder);
    return c.json(store.mcpServers(undefined, folder));
  });
  /** Read every adapter's servers again, in the default workspace and in every workflow's folders. */
  app.post("/api/mcp/refresh", async (c) => {
    const folders = knownFolders(store, workspace());
    return c.json({ result: await refreshMcp(store, availableAdapters(), folders), folders, servers: store.mcpServers(undefined, resolve(workspace())) });
  });

  /** The models the adapter's CLI offers (for the model dropdown). */
  /** Rewrite a prompt typed in the designer. Returns the text; nothing is stored. */
  app.post("/api/prompts/refine", async (c) => {
    const b = await body(c);
    const str = (x: unknown) => (typeof x === "string" && x ? x : undefined);
    return c.json(await refinePrompt(store, { text: b.text, kind: str(b.kind), adapter: str(b.adapter), model: str(b.model) }));
  });
  app.get("/api/models", async (c) => c.json(await listModels(store, c.req.query("adapter") || store.getSetting("default-adapter", "claude-code"), !!c.req.query("refresh"))));

  app.get("/api/settings", (c) => c.json(store.allSettings()));
  app.put("/api/settings", async (c) => {
    for (const [k, v] of Object.entries(await body(c))) store.setSetting(k, v);
    return c.json(store.allSettings());
  });

  // ── workflows ───────────────────────────────────────────────────────────
  const wfOr404 = (name: string) => {
    const wf = store.getWorkflow(name);
    if (!wf) throw new EngineError(`workflow "${name}" not found`);
    return wf;
  };
  const save = (raw: unknown, b: any) => {
    const name = (raw as any)?.name;
    const existing = typeof name === "string" ? store.getWorkflow(name) ?? (typeof b.rename_from === "string" ? store.getWorkflow(b.rename_from) : null) : null;
    let baseDir: string | null = typeof b.base_dir === "string" && b.base_dir ? expandHome(b.base_dir) : existing?.base_dir ?? null;
    if (!baseDir && typeof name === "string") baseDir = join(expandHome((store.getSetting<string | null>("workspace-dir", null) || defaultWorkspace())), name);
    const r = saveDefinition(store, raw, baseDir, { approve: !!b.approve, autosave: !!b.autosave, renameFrom: typeof b.rename_from === "string" ? b.rename_from : undefined });
    // The working directory is created when a run needs it, not here: with autosave this is
    // called while a path or a name is still being typed.
    if (!b.autosave && r.workflow.base_dir) mkdirSync(r.workflow.base_dir, { recursive: true });
    return { name: r.workflow.name, version: r.workflow.version, base_dir: r.workflow.base_dir, warnings: r.warnings, approvals: r.approvals };
  };

  app.get("/api/workflows", (c) => c.json(store.listWorkflows().map((w) => ({ name: w.name, version: w.version, description: w.definition.description ?? null, nodes: w.definition.nodes.length, updated_at: w.updated_at }))));
  app.post("/api/workflows/validate", async (c) => {
    const b = await body(c);
    let raw: unknown;
    try { raw = typeof b.yaml === "string" ? parseText(b.yaml) : b.definition; } catch (e: any) { return c.json({ ok: false, errors: [`cannot parse: ${e.message}`], warnings: [], environment: [], estimates: [] }); }
    const name = (raw as any)?.name;
    const existing = typeof name === "string" ? store.getWorkflow(name) : null;
    const baseDir = typeof b.base_dir === "string" && b.base_dir ? expandHome(b.base_dir) : existing?.base_dir ?? join(expandHome((store.getSetting<string | null>("workspace-dir", null) || defaultWorkspace())), String(name ?? "unnamed"));
    const parsed = validateWorkflow(raw);
    if (parsed.ok) await ensureMcp(store, parsed.workflow!, baseDir, 30_000);
    const { workflow, ...v } = validateFull(store, raw, baseDir, existing?.id ?? null) as any;
    return c.json({ ...v, definition: workflow ?? null });
  });
  app.post("/api/workflows/import", async (c) => {
    const b = await body(c);
    if (typeof b.yaml !== "string") throw new EngineError("`yaml` is required");
    let raw: unknown;
    try { raw = parseText(b.yaml); } catch (e: any) { throw new EngineError(`cannot parse: ${e.message}`); }
    return c.json(save(raw, b), 201);
  });
  app.get("/api/workflows/:name", (c) => {
    const wf = wfOr404(c.req.param("name"));
    // `input_refs`: the inputs the workflow uses (`{{inputs.…}}`), with their defaults, for the forms that start a run.
    return c.json({ name: wf.name, version: wf.version, base_dir: wf.base_dir, definition: wf.definition, input_refs: describeInputs(wf.definition), approvals: pendingApprovals(store, wf), updated_at: wf.updated_at });
  });
  app.put("/api/workflows/:name", async (c) => {
    const b = await body(c);
    if (b.definition?.name !== c.req.param("name")) throw new EngineError("the definition's name must match the URL");
    return c.json(save(b.definition, b));
  });
  app.get("/api/workflows/:name/export", (c) => {
    const wf = wfOr404(c.req.param("name"));
    return c.req.query("format") === "json" ? c.json(wf.definition) : c.text(toYaml(wf.definition), 200, { "Content-Type": "text/yaml; charset=utf-8" });
  });
  /** Copy a workflow under a new name (`name`, or `<name>-copy`). See cloneWorkflow for what is copied. */
  app.post("/api/workflows/:name/clone", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const r = cloneWorkflow(store, c.req.param("name"), { name: typeof b?.name === "string" ? b.name : undefined, workspace: workspace() });
    return c.json({ name: r.workflow.name, version: r.workflow.version, base_dir: r.workflow.base_dir, from: r.from, warnings: r.warnings, approvals: r.approvals }, 201);
  });
  app.post("/api/workflows/:name/approve", (c) => c.json(approveWorkflow(store, c.req.param("name"))));
  app.delete("/api/workflows/:name", (c) => {
    const wf = wfOr404(c.req.param("name"));
    if (store.workflowHasRuns(wf.id)) return c.json({ error: `workflow "${wf.name}" has runs and cannot be removed` }, 409);
    store.deleteWorkflow(wf.id);
    return c.json({ ok: true });
  });

  // ── runs ────────────────────────────────────────────────────────────────
  app.get("/api/runs", (c) => {
    const name = c.req.query("workflow");
    const wf = name ? wfOr404(name) : null;
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100) || 100, 1), 500);
    const offset = Math.max(Number(c.req.query("offset") ?? 0) || 0, 0);
    // The list stays an array; the number of matching runs, for paging, is in a header.
    c.header("X-Total-Count", String(store.countRuns(wf?.id)));
    return c.json(store.listRuns(limit, wf?.id, offset).map(({ definition: _d, ...r }) => r));
  });
  /** Delete finished runs with their whole record. All or nothing: an active run stops the batch. */
  app.post("/api/runs/delete", async (c) => {
    const b = await body(c);
    if (!Array.isArray(b.ids) || !b.ids.every((x: unknown) => Number.isInteger(x) && (x as number) > 0)) throw new EngineError("`ids` must be a list of run ids");
    return c.json(deleteRuns(store, b.ids));
  });
  app.delete("/api/runs/:id", (c) => c.json(deleteRuns(store, [id(c.req.param("id"), "run id")])));
  /** The full record of a run, in order: every message in and out, answers, status changes, errors. */
  app.get("/api/runs/:id/transcript", (c) => {
    const runId = id(c.req.param("id"), "run id");
    if (!store.getRun(runId)) throw new EngineError(`run ${runId} not found`);
    return c.json(store.messages(runId, { afterId: Number(c.req.query("after") ?? 0) || 0, nodeId: c.req.query("node") || undefined }));
  });
  app.post("/api/runs", async (c) => {
    const b = await body(c);
    if (typeof b.workflow !== "string") throw new EngineError("`workflow` is required");
    const target = store.getWorkflow(b.workflow);
    // The folder first: its MCP servers are read from inside it.
    if (target?.base_dir) { try { mkdirSync(target.base_dir, { recursive: true }); } catch { /* reported by the run if it matters */ } }
    if (target) await ensureMcp(store, target.definition, target.base_dir ?? process.cwd());
    const run = startRun(store, b.workflow, b.inputs ?? {}, b.budget ?? null);
    launch(run.id);
    return c.json(runDetail(store, run.id), 201);
  });
  /** Run a run again: a new run of the same workflow, as it is now, with the inputs that run ran with. */
  app.post("/api/runs/:id/rerun", async (c) => {
    const old = store.getRun(id(c.req.param("id"), "run id"));
    if (!old) throw new EngineError(`run ${c.req.param("id")} not found`);
    const target = store.getWorkflow(old.workflow_id);
    if (target?.base_dir) { try { mkdirSync(target.base_dir, { recursive: true }); } catch { /* reported by the run if it matters */ } }
    if (target) await ensureMcp(store, target.definition, target.base_dir ?? process.cwd());
    const run = rerunRun(store, old.id);
    launch(run.id);
    return c.json(runDetail(store, run.id), 201);
  });
  app.get("/api/runs/:id", (c) => c.json(runDetail(store, id(c.req.param("id"), "run id"))));
  app.post("/api/runs/:id/pause", (c) => c.json({ run: requestPause(store, id(c.req.param("id"), "run id")) }));
  app.post("/api/runs/:id/cancel", (c) => c.json({ run: requestCancel(store, id(c.req.param("id"), "run id")) }));
  app.post("/api/runs/:id/resume", async (c) => {
    const runId = id(c.req.param("id"), "run id");
    // Read the servers again: a resume often follows a fixed connection.
    const before = store.getRun(runId);
    if (before) await ensureMcp(store, before.definition, before.base_dir ?? process.cwd());
    const { run, retryFailed } = resumeRun(store, runId);
    launch(runId, { retryFailed });
    return c.json({ run });
  });
  /** Change the model of a step that has not completed, while the run is stopped. Body: { model } (null or "" for the CLI's default). */
  app.post("/api/runs/:id/steps/:node/model", async (c) => {
    const b = await body(c);
    const runId = id(c.req.param("id"), "run id");
    const r = setStepModel(store, runId, c.req.param("node"), b.model == null ? null : String(b.model));
    return c.json({ from: r.from, to: r.to, changed: r.changed, ...runDetail(store, runId) });
  });
  /** Change a step of a stopped run that has not completed: { model?, prompt? }. For this run only. */
  app.post("/api/runs/:id/steps/:node", async (c) => {
    const b = await body(c);
    const runId = id(c.req.param("id"), "run id");
    const patch: { model?: string | null; prompt?: string } = {};
    if ("model" in b) patch.model = b.model == null ? null : String(b.model);
    if ("prompt" in b) patch.prompt = String(b.prompt ?? "");
    if (!("model" in patch) && !("prompt" in patch)) throw new EngineError("give the step's new `model` or `prompt`");
    const r = changeStep(store, runId, c.req.param("node"), patch);
    return c.json({ changes: r.changes, restarted: r.restarted, changed: r.changed, ...runDetail(store, runId) });
  });
  /** The conversation about a run: questions asked and the agent's answers, oldest first (task 9.62). */
  app.get("/api/runs/:id/ask", (c) => {
    const runId = id(c.req.param("id"), "run id");
    const run = store.getRun(runId);
    if (!run) throw new EngineError(`run ${runId} not found`);
    return c.json({ adapter: askAdapter(store, run), conversation: askConversation(store, runId) });
  });
  /** Ask about a run: { question, model? }. The agent answers from the run's record; it has no tools and changes nothing. */
  app.post("/api/runs/:id/ask", async (c) => {
    const b = await body(c);
    return c.json(await askAboutRun(store, id(c.req.param("id"), "run id"), { question: String(b.question ?? ""), model: typeof b.model === "string" && b.model ? b.model : undefined }));
  });
  app.post("/api/runs/:id/revert", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    return c.json(await revertRun(store, id(c.req.param("id"), "run id"), { to: typeof b?.to === "string" && b.to ? b.to : undefined }));
  });

  /** Live event stream. Polls the database, so runs driven by another chief process show up too. */
  app.get("/api/runs/:id/events", (c) => {
    const runId = id(c.req.param("id"), "run id");
    if (!store.getRun(runId)) throw new EngineError(`run ${runId} not found`);
    let after = Number(c.req.query("after") ?? c.req.header("last-event-id") ?? 0) || 0;
    if (c.req.query("format") === "json") return c.json(store.events(runId, after));
    const enc = new TextEncoder();
    let timer: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let lastBeat = Date.now();
        const send = (s: string) => { try { controller.enqueue(enc.encode(s)); } catch { clearInterval(timer); } };
        const tick = () => {
          const rows = store.events(runId, after);
          for (const e of rows) { after = e.id; send(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`); }
          if (rows.length) lastBeat = Date.now();
          else if (Date.now() - lastBeat > 10_000) { lastBeat = Date.now(); send(": keep-alive\n\n"); }
          const run = store.getRun(runId);
          if (!rows.length && run && TERMINAL_RUN.includes(run.status) && !active.has(runId)) {
            send(`event: end\ndata: ${JSON.stringify({ status: run.status })}\n\n`);
            clearInterval(timer);
            try { controller.close(); } catch { /* already closed */ }
          }
        };
        tick();
        timer = setInterval(tick, 250);
      },
      cancel() { clearInterval(timer); },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
  });

  // ── the assistant (task 9.64): the chat panel's one conversation ──────────
  app.get("/api/assistant", (c) => c.json({ adapter: store.getSetting<string>("default-adapter", "claude-code"), conversation: assistantConversation(store) }));
  /**
   * Ask the assistant: { question, model?, run_id?, workflow? } where run_id is the run the page shows, if any,
   * and workflow ({ definition, base_dir? }) is the designer's canvas when it is asked there (task 9.65).
   */
  app.post("/api/assistant", async (c) => {
    const b = await body(c);
    const runId = b.run_id == null || b.run_id === "" ? null : Number(b.run_id);
    if (runId !== null && !Number.isInteger(runId)) throw new EngineError("run_id must be a number");
    return c.json(await assistantAnswer(store, { question: String(b.question ?? ""), model: typeof b.model === "string" && b.model ? b.model : undefined, runId, workflow: b.workflow && typeof b.workflow === "object" ? { definition: b.workflow.definition, base_dir: typeof b.workflow.base_dir === "string" && b.workflow.base_dir ? expandHome(b.workflow.base_dir) : null } : null }));
  });
  /** New chat: the conversation is cleared (the rows are deleted; the agent CLI's own session is left alone). */
  app.delete("/api/assistant", (c) => c.json({ cleared: store.clearAssistant() }));

  // ── gates ───────────────────────────────────────────────────────────────
  app.get("/api/gates", (c) => c.json(store.gates(c.req.query("status") === "all" ? {} : { status: "waiting" })));
  app.get("/api/gates/:id", (c) => {
    const g = store.getGate(id(c.req.param("id"), "gate id"));
    if (!g) throw new EngineError(`gate ${c.req.param("id")} not found`);
    return c.json(g);
  });
  app.post("/api/gates/:id/answer", async (c) => {
    const b = await body(c);
    const { gate, drive } = answerGate(store, id(c.req.param("id"), "gate id"), b.answer ?? b);
    if (drive) launch(gate.run_id);
    return c.json({ gate });
  });

  // ── drafts: text typed in the web UI, kept in the database until it is saved or sent ──
  const seqOf = (c: any, b?: any) => {
    const n = Number(b?.seq ?? c.req.query("seq"));
    return Number.isFinite(n) && n > 0 ? n : Date.now() * 1000;
  };
  app.get("/api/drafts", (c) => c.json(store.drafts()));
  app.put("/api/drafts/:key", async (c) => {
    const b = await body(c);
    if (!("value" in b)) throw new EngineError("`value` is required");
    return c.json({ stored: store.putDraft(c.req.param("key"), b.value, seqOf(c, b)) });
  });
  app.delete("/api/drafts/:key", (c) => c.json({ stored: store.putDraft(c.req.param("key"), undefined, seqOf(c)) }));
  app.delete("/api/drafts", (c) => {
    const prefix = c.req.query("prefix");
    if (!prefix) throw new EngineError("`prefix` is required");
    store.removeDraftsWithPrefix(prefix, seqOf(c));
    return c.json({ ok: true });
  });

  // ── schedules ───────────────────────────────────────────────────────────
  // The row carries its cron in words and when it fires next, so the page needs no cron parser of its
  // own (the engine has the only one) and the two can never disagree about an expression.
  const scheduleView = (s: any) => ({
    ...s,
    enabled: !!s.enabled,
    description: describeCron(s.cron),
    next_run_at: s.enabled ? (() => { const n = nextRun(s.cron); return n ? minuteKey(n) : null; })() : null,
  });
  app.get("/api/schedules", (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100) || 100, 1), 500);
    const offset = Math.max(Number(c.req.query("offset") ?? 0) || 0, 0);
    c.header("X-Total-Count", String(store.countSchedules()));
    return c.json(store.listSchedules(limit, offset).map(scheduleView));
  });
  app.post("/api/schedules", async (c) => {
    const b = await body(c);
    const created = addSchedule(store, String(b.workflow ?? ""), String(b.cron ?? ""), b.inputs ?? {});
    // Read it back joined with the workflow's name, so the page can show the row it just made.
    return c.json(scheduleView(store.schedules().find((s) => s.id === created.id)), 201);
  });
  app.patch("/api/schedules/:id", async (c) => {
    const b = await body(c);
    const sid = id(c.req.param("id"), "schedule id");
    store.setScheduleEnabled(sid, !!b.enabled);
    const row = store.schedules().find((s) => s.id === sid);
    return c.json(row ? scheduleView(row) : null);
  });
  app.delete("/api/schedules/:id", (c) => {
    if (!store.removeSchedule(id(c.req.param("id"), "schedule id"))) throw new EngineError(`schedule ${c.req.param("id")} not found`);
    return c.json({ ok: true });
  });

  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  // ── web UI ──────────────────────────────────────────────────────────────
  app.get("*", (c) => {
    if (!opts.assets) return c.text("The web UI is not built. Run `npm run build:web`, then restart `chief serve`.", 503);
    const path = new URL(c.req.url).pathname;
    const hit = opts.assets.get(path === "/" ? "/index.html" : path) ?? opts.assets.get("/index.html");
    if (!hit) return c.text("not found", 404);
    return new Response(hit.body as any, { headers: { "Content-Type": hit.type, "Cache-Control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache" } });
  });

  return { app, launch, active };
}
