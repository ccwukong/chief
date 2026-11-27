import { Hono } from "hono";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { ADAPTER_NAMES, availableAdapters, getAdapter } from "../adapters/index.ts";
import type { McpWriteRequest } from "../adapters/types.ts";
import { enabledProviders, providerChosenOff, providerLocated } from "../providers.ts";
import { askAboutRun, askAdapter, askConversation, assistantAdapterFor, assistantAnswer, assistantActions, assistantConversation, assistantTooling, cancelAssistantAnswer } from "../ask.ts";
import { answerGate, driveRun, EngineError, requestCancel, requestPause, rerunRun, resumeRun, startRun } from "../engine/engine.ts";
import { addInputSet, addSchedule, approveWorkflow, cloneWorkflow, ConflictError, deleteRuns, doctor, ensureMcp, inputSetValues, knownFolders, listModels, refreshMcp, pendingApprovals, refinePrompt, runDetail, changeStep, setModelForSteps, setInputSet, readiness, setStepModel, saveDefinition, setSchedule, validateFull } from "../ops.ts";
import { log, logDebug, logging } from "../log.ts";
import { defaultWorkspace } from "../paths.ts";
import { runProcess } from "../util/proc.ts";
import { answerMcpAuth, beginMcpAuth, cancelMcpAuth, mcpAuthState, planMcpAuth } from "../mcp-auth.ts";
import { cancelMcpCommand, commandTemplate, mcpCommandState, runMcpCommand } from "../mcp-run.ts";
import { sandboxStatus } from "../sandbox/sandbox.ts";
import type { Store } from "../store/store.ts";
import { TERMINAL_RUN } from "../store/types.ts";
import { parseText, toYaml, validateWorkflow } from "../workflow/load.ts";
import { describeInputs, mergeInputs, unansweredInputs, unansweredInputsMessage } from "../workflow/inputs.ts";
import { describeCron, minuteKey, nextRun } from "../util/cron.ts";

/** See /api/meta. Keep in step with REQUIRED_API in packages/web/src/app.tsx. */
export const API_LEVEL = 18;

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
    /** The CLIs whose own command can add or remove an MCP server. The rest keep it in a config file that
     *  chief does not write, so Settings shows their syntax instead of a button (task 15.56). */
    mcp_writable: ADAPTER_NAMES.filter((n) => typeof getAdapter(store, n).mcpWrite === "function"),
    /** The CLIs whose own command can sign in to a server. The rest get a sentence saying where to do it. */
    mcp_auth: ADAPTER_NAMES.filter((n) => typeof getAdapter(store, n).mcpAuth === "function"),
    /** The CLIs that can actually sign out. Cursor cannot — its `disable` is a different act — so it is
     *  absent here and the page shows no Log out beside its servers. */
    mcp_logout: ADAPTER_NAMES.filter((n) => { const a = getAdapter(store, n); return typeof a.mcpAuth === "function" && !!a.mcpAuth({ action: "logout", name: "probe", cwd: "/" }); }),
  }));

  // The agent CLIs' own servers. Read-only: chief does not configure MCP servers.
  // Per folder: an agent CLI has different servers in different folders. `workflow` asks for a
  // workflow's folder, `base_dir` for a folder being typed in the designer (nothing is created);
  // without either, the default workspace. The folder is in the X-Mcp-Folder header.
  const workspace = () => expandHome(store.getSetting<string | null>("workspace-dir", null) || defaultWorkspace());
  /**
   * A directory to run a CLI command in. The workspace is chief's own folder, so it is created if it is not
   * there yet — `spawn` fails with ENOENT on a cwd that does not exist, which is what a fresh install looks
   * like and what made the first version of the MCP sign-in fail before it started. If it cannot be created
   * (a read-only parent), the nearest existing ancestor is used rather than failing the command.
   */
  const existingDir = (dir: string) => { let d = resolve(dir); while (!existsSync(d) && dirname(d) !== d) d = dirname(d); return d; };
  /**
   * The name the CLI knows a server by.
   *
   * chief's own names are slugs (`google-docs`) so they can appear in `mcp:` lists and template paths, but
   * the CLI's command needs the CLI's own spelling (`claude.ai Google Docs`). The slug is what the page has;
   * this is the translation, read from the stored row. Without it, `claude mcp login google-docs` failed with
   * "No MCP server named google-docs" — a real report (2026-11-21).
   */
  const cliName = (adapter: string, slug: string): string => {
    const row = store.mcpServers(adapter).find((r) => r.name === slug);
    const own = row?.config?.cli_name;
    // A stored name that begins a flag would be dangerous as an argv element; the slug is used then.
    return typeof own === "string" && own.trim() && !own.trim().startsWith("-") ? own.trim() : slug;
  };
  /**
   * The folder a server belongs to. These CLIs keep servers **per folder** (a local-scope server applies to
   * one directory), so a command run anywhere else cannot see the server — which is why a sign-in reported
   * "No MCP server named …" from a workspace that had none (found 2026-11-21). The stored row knows.
   */
  const serverFolder = (adapter: string, slug: string): string | null => {
    const row = store.mcpServers(adapter).find((r) => r.name === slug);
    return row?.folder && existsSync(row.folder) ? row.folder : null;
  };
  /**
   * The settings list, which is what a person sees. Errors are not failures here: a CLI that cannot be read
   * answers with nothing, and a missing answer is not evidence that nothing changed.
   */
  const readServers = async (adapter: string, folder: string) => {
    try { return await getAdapter(store, adapter).discoverMcp(folder); } catch { return null; }
  };
  const unitDir = () => {
    const want = resolve(workspace());
    try { mkdirSync(want, { recursive: true }); return want; } catch { return existingDir(want); }
  };
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

  /**
   * Add or remove one server **by running the CLI's own command** — never by writing its config file.
   *
   * `dryRun` returns the exact argv without running anything, and the page shows it before the person
   * presses the button: a command that changes your tools should be readable first. A CLI with no such
   * command has no `mcpWrite`, and gets a 409 with what to do instead rather than a button that fails.
   * argv is passed to `spawn` directly (no shell), and env/header values are redacted from the reply.
   */
  app.post("/api/mcp/apply", async (c) => {
    const b = await body(c);
    const adapter = getAdapter(store, String(b?.adapter ?? ""));
    if (!adapter) throw new EngineError(`unknown agent CLI "${b?.adapter}"`);
    const action = b?.action === "remove" ? "remove" : b?.action === "add" ? "add" : null;
    if (!action) throw new EngineError('action must be "add" or "remove"');
    const name = String(b?.name ?? "").trim();
    if (!name) throw new EngineError("a server name is needed");
    // A name reaches an argv, so it is checked rather than trusted: no spaces, no leading dash, no shell
    // metacharacters. Every CLI accepts this shape, and it cannot be read as a flag.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new EngineError("a server name may use letters, digits, dots, dashes and underscores, and must not start with a dash");
    if (!adapter.mcpWrite) {
      return c.json({ error: `${adapter.name} has no command for this: its MCP configuration is a file, and chief does not write it` }, 409);
    }
    const req: McpWriteRequest = {
      action, name,
      transport: b?.transport === "http" || b?.transport === "sse" || b?.transport === "stdio" ? b.transport : undefined,
      command: typeof b?.command === "string" ? b.command : undefined,
      args: Array.isArray(b?.args) ? b.args.map(String) : undefined,
      url: typeof b?.url === "string" ? b.url : undefined,
      env: Array.isArray(b?.env) ? b.env.map(String) : undefined,
      header: Array.isArray(b?.header) ? b.header.map(String) : undefined,
      scope: typeof b?.scope === "string" ? b.scope : undefined,
      cwd: unitDir(),
    };
    if (action === "add") {
      if (req.transport === "stdio" || (!req.transport && !req.url)) {
        if (!req.command?.trim()) throw new EngineError("a stdio server needs a command to run, like npx");
      } else if (!req.url?.trim()) throw new EngineError("an http server needs a URL");
    }
    // Removing an existing server needs the CLI's own name, exactly as signing in to it does.
    if (action === "remove") req.name = cliName(adapter.name, req.name);
    const plan = adapter.mcpWrite(req);
    if (b?.dryRun) return c.json({ command: plan.command, note: plan.note ?? null, ran: false });
    const r = await runProcess({ argv: plan.argv, cwd: req.cwd, timeoutMs: 120_000, env: process.env as Record<string, string> });
    const out = { code: r.code, stdout: r.stdout.trim(), stderr: r.stderr.trim(), spawnError: r.spawnError ?? null, timedOut: r.timedOut };
    const ok = r.code === 0 && !r.spawnError;
    // Verify by reading back rather than by trusting the exit code: the CLI is the authority on its own list.
    const after = ok ? await refreshMcp(store, [adapter.name], [req.cwd]) : null;
    return c.json({ command: plan.command, ok, ran: true, ...out, after: after?.[adapter.name] ?? null }, ok ? 200 : 400);
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

  /**
   * The workflow list. Live ones by default; `?archived=1` is the archived ones, which is where an archive can be undone
   * from. Every row says which it is, and how many runs it has, so a page can offer Delete only where it would work.
   */
  app.get("/api/workflows", (c) => {
    const only = c.req.query("archived");
    const rows = only === "1" ? store.archivedWorkflows() : only === "all" ? store.listWorkflows() : store.liveWorkflows();
    return c.json(rows.map((w) => ({
      name: w.name, version: w.version, description: w.definition.description ?? null, nodes: w.definition.nodes.length,
      updated_at: w.updated_at, archived: w.archived_at != null, archived_at: w.archived_at, runs: store.countWorkflowRuns(w.id),
      // How many collections it has: the workflow column shows it, so choosing a workflow is a decision with a fact
      // in it rather than a list of names (15.125). A handful of workflows, so one count each is the honest way.
      input_sets: store.countInputSets(w.id),
    })));
  });
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
    // `archived` and `runs` travel with it, so the designer can show whether this one is in service and offer Delete only
    // where it would work, without asking a second endpoint (task 15.2).
    return c.json({ name: wf.name, version: wf.version, base_dir: wf.base_dir, definition: wf.definition, input_refs: describeInputs(wf.definition), approvals: pendingApprovals(store, wf), updated_at: wf.updated_at, archived: wf.archived_at != null, archived_at: wf.archived_at, runs: store.countWorkflowRuns(wf.id) });
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
  /**
   * Take a workflow out of service, or put it back.
   *
   * This is the answer for a workflow that has runs: deleting is refused once there are runs, because each run is the
   * record of what happened and `run__runs` points at this row. Archiving hides it from every list and stops its
   * schedules firing, and deletes nothing, so replay, the runs and the schedules all still resolve (task 15.2).
   */
  app.post("/api/workflows/:name/archive", (c) => {
    const wf = wfOr404(c.req.param("name"));
    if (wf.archived_at) return c.json({ error: `workflow "${wf.name}" is already archived` }, 409);
    store.setWorkflowArchived(wf.id, true);
    return c.json({ name: wf.name, archived: true, runs: store.countWorkflowRuns(wf.id) });
  });
  app.post("/api/workflows/:name/unarchive", (c) => {
    const wf = wfOr404(c.req.param("name"));
    if (!wf.archived_at) return c.json({ error: `workflow "${wf.name}" is not archived` }, 409);
    store.setWorkflowArchived(wf.id, false);
    return c.json({ name: wf.name, archived: false });
  });
  /**
   * Remove a workflow outright. Only one with no runs may go: its runs are the record, and they reference this row.
   * The message names the way forward rather than only refusing, because a person reading it wants to know what to do.
   */
  app.delete("/api/workflows/:name", (c) => {
    const wf = wfOr404(c.req.param("name"));
    const runs = store.countWorkflowRuns(wf.id);
    if (runs) return c.json({ error: `workflow "${wf.name}" has ${runs} run${runs === 1 ? "" : "s"}, and a run is kept in full. Archive it instead: that hides it from every list and stops its schedules, and keeps the runs.` }, 409);
    store.deleteWorkflow(wf.id);
    return c.json({ ok: true });
  });

  /**
   * Sign in to (or out of) one MCP server, through the CLI's own login command.
   *
   * The reply is a flow id, not a result: an OAuth consent cannot be waited on inside a request. The page
   * polls `GET /api/mcp/auth/:id`, shows the authorization URL when the CLI prints one, and posts the
   * redirect back to the same id. Credentials never pass through chief — the CLI exchanges and keeps the
   * token; the redirect is written to the waiting child's stdin and never stored or logged.
   */
  app.post("/api/mcp/auth", async (c) => {
    const b = await body(c);
    const adapter = getAdapter(store, String(b?.adapter ?? ""));
    if (!adapter) throw new EngineError(`unknown agent CLI "${b?.adapter}"`);
    if (!adapter.mcpAuth) return c.json({ error: `${adapter.name} has no command for signing in` }, 409);
    const action = b?.action === "logout" ? "logout" : "login";
    const name = String(b?.name ?? "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new EngineError("a server name may use letters, digits, dots, dashes and underscores, and must not start with a dash");
    // A connector (`claude.ai …`) is account-level: it is not in the CLI's own list, so its login command
    // refuses it — "No MCP server named …", with exit code 0. Saying so is better than a button that cannot work.
    const row = store.mcpServers(adapter.name).find((r) => r.name === name);
    if (row?.config?.scope === "connector") {
      return c.json({ error: `${row.config?.cli_name ?? name} is a connector of your Claude account, not one of ${adapter.name}'s own servers: sign in to it from Claude itself` }, 409);
    }
    const folder = serverFolder(adapter.name, name) ?? unitDir();
    // The page has the slug; the CLI's command needs the CLI's own name (see `cliName`).
    const opts: { action: "login" | "logout"; name: string; cwd: string; verify?: () => Promise<boolean> } = { action, name: cliName(adapter.name, name), cwd: folder };
    if (!b?.dryRun) {
      // Look at the CLI's list before and after: a status that did not move is not a success, whatever the
      // command's exit code said. This is what makes "signed in" mean it, not merely "the CLI exited".
      const before = await readServers(adapter.name, folder);
      const statusOf = (list: { name: string; config: any }[] | null) => list?.find((s) => s.name === name)?.config?.status ?? null;
      const was = statusOf(before);
      opts.verify = async () => {
        const now = statusOf(await readServers(adapter.name, folder));
        // A list that could not be read is not evidence of failure: only a status that is known and unmoved is.
        if (now === null) return true;
        return action === "login" ? now === "connected" : now !== "connected" || was === null;
      };
    }
    if (b?.dryRun) return c.json({ ...planMcpAuth(adapter, opts), ran: false });
    return c.json(beginMcpAuth(adapter, opts), 202);
  });
  app.get("/api/mcp/auth/:id", (c) => {
    const f = mcpAuthState(c.req.param("id"));
    if (!f) return c.json({ error: "no such sign-in" }, 404);
    // Once it has ended, the cached server list is stale: read it again so the page's next poll is right.
    if (f.finishedAt && f.action === "login" && f.status === "done") void refreshMcp(store, [f.adapter], [unitDir()]);
    return c.json(f);
  });
  app.post("/api/mcp/auth/:id", async (c) => {
    const b = await body(c);
    return c.json(answerMcpAuth(c.req.param("id"), String(b?.redirect ?? "")));
  });
  app.delete("/api/mcp/auth/:id", (c) => c.json(cancelMcpAuth(c.req.param("id"))));

  /**
   * Run one of the CLI's own `mcp` commands, typed in a box, and stream what it prints.
   *
   * The reply is an id; the page polls it for the lines as they arrive, because a stdio server prints while the CLI
   * starts it and waiting for the exit would hide all of it. The argv is tokenised without a shell and checked to
   * begin with this CLI's own program and `mcp` — see `mcp-run.ts` for why that check is the whole safety story.
   */
  app.get("/api/mcp/command/template", (c) => {
    const adapter = String(c.req.query("adapter") ?? "");
    if (!ADAPTER_NAMES.includes(adapter as (typeof ADAPTER_NAMES)[number])) throw new EngineError(`unknown agent CLI "${adapter}"`);
    return c.json({ template: commandTemplate(store, adapter) });
  });
  app.post("/api/mcp/command", async (c) => {
    const b = await body(c);
    const adapter = String(b?.adapter ?? "");
    if (!ADAPTER_NAMES.includes(adapter as (typeof ADAPTER_NAMES)[number])) throw new EngineError(`unknown agent CLI "${adapter}"`);
    return c.json(runMcpCommand(store, adapter, String(b?.command ?? ""), unitDir()), 202);
  });
  app.get("/api/mcp/command/:id", (c) => {
    const r = mcpCommandState(c.req.param("id"));
    if (!r) return c.json({ error: "no such command" }, 404);
    // A command that changed the CLI's list makes the cached list stale: read it again once it has finished.
    if (r.finishedAt && r.status === "done") void refreshMcp(store, [r.adapter], [unitDir()]);
    return c.json(r);
  });
  app.delete("/api/mcp/command/:id", (c) => c.json(cancelMcpCommand(c.req.param("id"))));

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
    // An archived workflow is out of service: it is not offered anywhere, and a request that names it anyway is told why
    // rather than started (task 15.2).
    if (target?.archived_at) throw new EngineError(`workflow "${target.name}" is archived. Unarchive it to run it.`);
    // The folder first: its MCP servers are read from inside it.
    if (target?.base_dir) { try { mkdirSync(target.base_dir, { recursive: true }); } catch { /* reported by the run if it matters */ } }
    if (target) await ensureMcp(store, target.definition, target.base_dir ?? process.cwd());
    // A run can be started from an input data set (15.122): its stored values are the run's, copied in as a snapshot,
    // so editing it afterwards never rewrites a run that already happened. `inputs` given beside it still win, which is
    // what "start this one with a value changed" needs.
    let fromInputSet: { id: number; name: string } | null = null;
    let inputs: Record<string, unknown> = b.inputs ?? {};
    if (b.input_set !== undefined && b.input_set !== null) {
      const got = inputSetValues(store, Number(b.input_set), b.workflow);
      fromInputSet = { id: got.set.id, name: got.set.name };
      inputs = mergeInputs(got.values, inputs);
      // The set's own values, plus anything this request lays over them — not the workflow's defaults. Those
      // defaults are what a run without a set uses. Counting them here is how an empty set was started with
      // someone else's text (reported 2026-11-27).
      if (target) {
        const pending = unansweredInputs(target.definition, inputs);
        if (pending.length) throw new EngineError(unansweredInputsMessage(`run "${target.name}"`, pending));
      }
    }
    const run = startRun(store, b.workflow, inputs, b.budget ?? null, null, null, fromInputSet);
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
    // `from`: start at that step, keeping the earlier run's results for the steps before it (the body is optional, so a
    // rerun with no body is a full rerun as before).
    const b = await c.req.json().catch(() => ({}));
    const run = rerunRun(store, old.id, b?.from == null || b.from === "" ? null : String(b.from));
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
  /**
   * The same model for several steps at once: { model, nodes: [...] }. One call, so it cannot leave some steps
   * changed and others not (the "every step failed on the CLI's default model" case, run #51).
   */
  app.post("/api/runs/:id/steps/model", async (c) => {
    const b = await body(c);
    const runId = id(c.req.param("id"), "run id");
    if (!Array.isArray(b.nodes) || !b.nodes.length) throw new EngineError("give `nodes`: the steps to change");
    if (!("model" in b)) throw new EngineError("give the `model` to use (null for the CLI's own default)");
    const r = setModelForSteps(store, runId, b.model == null || b.model === "" ? null : String(b.model), b.nodes.map(String));
    return c.json({ ...r, ...runDetail(store, runId) });
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
  app.get("/api/assistant", (c) => {
    // `workflow` and `run_id` are the same context a question is asked with, so the picker names the CLI that will
    // actually answer — it used to report the setting while the answer used the canvas (reported 2026-11-22).
    const name = String(c.req.query("workflow") ?? "");
    const runId = Number(c.req.query("run_id"));
    const run = Number.isInteger(runId) && runId > 0 ? store.getRun(runId) : null;
    const wf = name ? store.getWorkflow(name) : null;
    const canvas = wf ? { definition: wf.definition } : null;
    // What the bot may reach, so the panel shows the choice instead of hiding it (task 15.69).
    const folder = wf?.base_dir ?? run?.base_dir ?? workspace();
    const t = assistantTooling(store, folder);
    return c.json({
      adapter: assistantAdapterFor(store, { run, canvas }),
      // The model Settings holds, so the panel's line names what will answer instead of guessing (task 15.87).
      model: store.getSetting<string>("assistant-model", ""),
      conversation: assistantConversation(store),
      tools: store.getSetting<string>("assistant-tools", "read-only"),
      mcp: store.getSetting<string>("assistant-mcp", "none"),
      reach: t.label,
      folder,
      // What the agent did in this conversation, for the panel to show beside the answer.
      actions: assistantActions(store),
    });
  });
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
  /**
   * Past conversations, newest first. Asked 2026-11-22: "the chief bot should allow user to view historical chats too,
   * because the user may wanna continue the previous conversation" — so a conversation is kept, not cleared.
   */
  app.get("/api/assistant/threads", (c) => c.json(store.assistantThreads()));
  /** Stop the answer being written. The CLI is signalled; nothing already recorded is removed. */
  app.delete("/api/assistant/pending", (c) => c.json({ cancelled: cancelAssistantAnswer() }));
  /** Continue an old conversation: it becomes the current one, and its messages come back. */
  app.post("/api/assistant/threads/:id/use", (c) => {
    const thread = id(c.req.param("id"), "conversation id");
    if (!store.useAssistantThread(thread)) return c.json({ error: "no such conversation" }, 404);
    return c.json({ thread, conversation: assistantConversation(store, thread) });
  });
  app.delete("/api/assistant/threads/:id", (c) => {
    return c.json({ deleted: store.deleteAssistantThread(id(c.req.param("id"), "conversation id")), threads: store.assistantThreads() });
  });
  /**
   * New chat: a **new thread**, not a deletion. The old conversation stays in the history where it can be picked up
   * again; only `DELETE /api/assistant/threads/:id` throws one away, and only when asked.
   */
  app.post("/api/assistant/threads", (c) => c.json({ thread: store.createAssistantThread(), threads: store.assistantThreads() }));
  /** Everything at once, for a client that would rather not ask twice (kept for older pages). */
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
    // No next firing when the schedule is off **or** its workflow is archived: the second is the case a page cannot infer,
    // and a time that will never come is worse than a dash beside the reason (task 15.2).
    next_run_at: s.enabled && !s.workflow_archived ? (() => { const n = nextRun(s.cron); return n ? minuteKey(n) : null; })() : null,
    workflow_archived: !!s.workflow_archived,
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
    // Any of the three, and only the ones given: the switch sends `enabled`, the assistant may send a new
    // expression or new inputs as well. All of it goes through the same check a new schedule gets.
    const patch: { cron?: string; inputs?: Record<string, unknown>; enabled?: boolean } = {};
    if (b.cron !== undefined) patch.cron = String(b.cron);
    if (b.inputs !== undefined) patch.inputs = b.inputs ?? {};
    if (b.enabled !== undefined) patch.enabled = !!b.enabled;
    setSchedule(store, sid, patch);
    const row = store.schedules().find((s) => s.id === sid);
    return c.json(row ? scheduleView(row) : null);
  });
  app.delete("/api/schedules/:id", (c) => {
    if (!store.removeSchedule(id(c.req.param("id"), "schedule id"))) throw new EngineError(`schedule ${c.req.param("id")} not found`);
    return c.json({ ok: true });
  });

  // ── input data sets: input values prepared over days, used when a run is started (15.122) ────
  /**
   * One as the page reads it: its values, its workflow's name, and how ready it is. Readiness is computed by
   * `readiness`, the same function the start uses, so one shown as ready cannot be refused on the click.
   */
  const inputSetView = (s: any) => {
    const wf = store.getWorkflow(s.workflow_name);
    const r = wf ? readiness(wf, s.values ?? {}) : { ready: false, missingRequired: [], missing: [], fields: 0, filled: 0 };
    return {
      id: s.id, workflow: s.workflow_name, name: s.name, values: s.values ?? {},
      created_at: s.created_at, updated_at: s.updated_at,
      workflow_archived: !!s.workflow_archived,
      ...r,
    };
  };
  app.get("/api/input-sets", (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 25) || 25, 1), 200);
    const offset = Math.max(Number(c.req.query("offset") ?? 0) || 0, 0);
    const name = c.req.query("workflow");
    const wf = name ? store.getWorkflow(name) : null;
    if (name && !wf) throw new EngineError(`workflow "${name}" not found`);
    c.header("X-Total-Count", String(store.countInputSets(wf?.id)));
    return c.json(store.listInputSets(limit, offset, wf?.id).map(inputSetView));
  });
  app.post("/api/input-sets", async (c) => {
    const b = await body(c);
    const created = addInputSet(store, String(b.workflow ?? ""), b.name, b.values ?? {});
    return c.json(inputSetView(store.inputSetWithWorkflow(created.id)), 201);
  });
  app.get("/api/input-sets/:id", (c) => {
    const s = store.inputSetWithWorkflow(id(c.req.param("id"), "input data set id"));
    if (!s) throw new EngineError(`input data set ${c.req.param("id")} not found`);
    return c.json(inputSetView(s));
  });
  app.patch("/api/input-sets/:id", async (c) => {
    const b = await body(c);
    const patch: { name?: unknown; values?: unknown } = {};
    if (b.name !== undefined) patch.name = b.name;
    if (b.values !== undefined) patch.values = b.values;
    setInputSet(store, id(c.req.param("id"), "input data set id"), patch);
    return c.json(inputSetView(store.inputSetWithWorkflow(id(c.req.param("id"), "input data set id"))));
  });
  app.delete("/api/input-sets/:id", (c) => {
    // The runs started from it keep their own copy of the values and its name: deleting one loses nothing a run is
    // made of, which is why no confirmation is needed beyond the bin's own.
    if (!store.removeInputSet(id(c.req.param("id"), "input data set id"))) throw new EngineError(`input data set ${c.req.param("id")} not found`);
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
