import { useEffect, useRef, useState } from "react";
import { api, get } from "../api";
import { AsyncButton, ErrorBox, Field, Help, readDraft, removeDraft, writeDraft } from "../ui";
import { applyAppearance, appearanceNow, followSystem, isTextScale, isTheme, resolvedTheme, TEXT_SCALES, type TextScale, type Theme } from "../theme";
import { SHOW_BUDGETS } from "../features";

/** One agent CLI as Settings shows it (the shape of `/api/doctor`'s `providers`; the web app may not import the engine). */
interface ProviderState { name: string; enabled: boolean; chosen: boolean; found: boolean; path: string | null; version: string | null; ok: boolean; note?: string }
const AGENT_LABEL: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor", antigravity: "Antigravity", opencode: "OpenCode", hermes: "Hermes" };
const ADAPTERS = ["claude-code", "codex", "cursor", "antigravity", "opencode", "hermes"];

export function Settings() {
  const [f, setF] = useState<Record<string, any> | null>(null);
  const [doctor, setDoctor] = useState<any | null>(null);
  /** The workspace that applies when the setting is empty, from the server (it depends on where chief runs from). */
  const [defaultWorkspace, setDefaultWorkspace] = useState("");
  useEffect(() => { get("/api/meta").then((m) => setDefaultWorkspace(m?.default_workspace_dir ?? "")).catch(() => {}); }, []);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  /** There is no Save button: a change is saved a moment after it is made. `invalid` keeps what was typed on screen. */
  const [state, setState] = useState<"saved" | "saving" | "invalid">("saved");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** The form to write next, if a save is already on its way (see `save`). */
  const latest = useRef<Record<string, any> | null>(null);
  const saving = useRef(false);
  /** Counts every change the person makes, so a save can tell whether what it carries is still the newest. */
  const typed = useRef(0);
  const load = () => get("/api/settings").then((s) => {
    // What was typed but could not be saved yet (an invalid value, or a refresh in mid-typing) comes back.
    const draft = readDraft<Record<string, any>>("settings");
    const form = {
      adapter: s["default-adapter"] ?? "claude-code",
      warn: s["default-budget"]?.["warn-usd"] ?? "", max: s["default-budget"]?.["max-usd"] ?? "",
      limit: s["output-size-limit"] ?? 20000, notify: s.notify !== false, workspace: s["workspace-dir"] ?? "",
      ...(draft ?? {}),
    };
    setF(form);
    if (draft) void save(form);
  }).catch((e) => setError(e.message));
  /** Save the whole form. A value that is not valid is not saved; it stays on screen with the reason. */
  const save = async (form: Record<string, any>) => {
    // One save at a time, and always the newest form: the person types faster than a request takes, so
    // a second change arriving mid-flight is queued rather than sent in parallel, where the slower one
    // (an older form) could land last and put a field back.
    latest.current = form;
    if (saving.current) return;
    saving.current = true;
    try {
      while (latest.current) {
        const next = latest.current;
        latest.current = null;
        // What was typed when this save began. Typing that happens while it is in flight is newer than
        // what this request carries, and its draft must survive it (E6.6-2: the workspace directory was
        // typed, a save of another field finished, the draft was deleted with it, `load()` filled the
        // field from the server and the next save wrote the empty value back).
        const edits = typed.current;
        const budget: Record<string, number> = {};
        for (const [key, v] of [["warn-usd", next.warn], ["max-usd", next.max]] as const) {
          if (v === "" || v == null) continue;
          const n = Number(v);
          if (!Number.isFinite(n) || n <= 0) { setState("invalid"); setError(`${key} must be a positive number. Nothing is saved until this is corrected.`); return; }
          budget[key] = n;
        }
        const limit = Number(next.limit);
        if (!Number.isInteger(limit) || limit < 100) { setState("invalid"); setError("The output size limit must be a whole number of at least 100 characters. Nothing is saved until this is corrected."); return; }
        setState("saving");
        try {
          await api("PUT", "/api/settings", {
            "default-adapter": next.adapter,
            "default-budget": budget, "output-size-limit": limit, notify: !!next.notify, "workspace-dir": String(next.workspace).trim() || null,
          });
        } catch (e: any) { setState("invalid"); setError(e.message); return; }
        // Tell the rest of the app that the settings moved: the chief bot panel follows the default agent
        // CLI (its own prompt is built on the server from this setting), so an open panel would otherwise
        // keep asking the CLI it was opened with until the page was reloaded.
        window.dispatchEvent(new CustomEvent("chief:settings", { detail: { "default-adapter": next.adapter } }));
        // The draft goes only when nothing was typed since this request left: what is on screen now is
        // what the server has. Otherwise the next turn of the loop saves that too.
        if (typed.current === edits && !latest.current) removeDraft("settings");
        setError(null);
        setState("saved");
        setSavedAt(new Date());
      }
      loadDoctor();
    } finally { saving.current = false; }
  };
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const loadDoctor = () => get("/api/doctor").then(setDoctor).catch(() => {});
  useEffect(() => { load(); loadDoctor(); }, []);

  if (!f) return <div className="p-6"><ErrorBox error={error} />Loading…</div>;
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const next = { ...f, [k]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value };
    setF(next);
    writeDraft("settings", next);
    typed.current += 1;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(next), 400);
  };

  const discover = async () => {
    setError(null); setNote("Asking the agent CLIs for their MCP servers…");
    try {
      const r = (await api("POST", "/api/mcp/refresh")).result;
      setNote(Object.entries(r).map(([a, v]: any) => `${a}: ${v.error ? `skipped (${v.error})` : `${v.count} servers`}`).join(" · "));
      loadDoctor();
    } catch (e: any) { setNote(null); setError(e.message); }
  };

  return (
    <div className="page-width py-6" data-testid="page-column">
    <div>
      <h1 className="mb-4 text-xl font-semibold">Settings</h1>
      <ErrorBox error={error} />
      <div data-testid="settings-status" data-state={state} className={`mb-3 text-xs ${state === "invalid" ? "text-amber-800" : "text-slate-500"}`}>
        {state === "saving" && "Saving…"}
        {state === "saved" && (savedAt ? `✓ Saved automatically · ${savedAt.toLocaleTimeString([], { hour12: false })}` : "Changes are saved automatically.")}
        {state === "invalid" && "● Not saved yet: see the message above."}
      </div>
      {note && <div data-testid="settings-note" className="mb-3 rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-900">{note}</div>}
      <Appearance />
      <Providers providers={(doctor?.providers ?? null) as ProviderState[] | null} loading={!doctor}
        defaultAdapter={String(f.adapter ?? "")} onChange={() => { loadDoctor(); load(); }} />
      <div className="grid items-start gap-5 xl:grid-cols-3">
      <div className="card min-w-0 xl:col-span-2" data-testid="settings-card">
          <Field label="Default agent CLI" hint="What a workflow or a step uses when it does not choose one. Only the CLIs switched on above are offered.">
          <select data-testid="setting-default-adapter" className="input" value={f.adapter} onChange={set("adapter")}>
            {/* Only the CLIs that are switched on: the others are not offered to a step either. */}
            {((doctor?.providers ?? []) as ProviderState[]).filter((p) => p.enabled || p.name === f.adapter).map((p) => <option key={p.name} value={p.name}>{AGENT_LABEL[p.name] ?? p.name}</option>)}
            {!doctor && ADAPTERS.map((a) => <option key={a} value={a}>{AGENT_LABEL[a] ?? a}</option>)}
          </select>
        </Field>
        <div className="grid gap-x-3 sm:grid-cols-2 lg:grid-cols-3">
          {/* The budget fields are hidden while budgets are (features.ts, task 15.24). What is stored is
              still sent back by `save`, so hiding the fields does not clear them. */}
          {SHOW_BUDGETS && (
            <>
              <Field label="Default budget: warn (USD)" help="setting-warn-usd"><input data-testid="setting-warn-usd" className="input" value={f.warn} onChange={set("warn")} /></Field>
              <Field label="Default budget: max (USD)" help="setting-max-usd" hint="Used when a workflow sets none"><input data-testid="setting-max-usd" className="input" value={f.max} onChange={set("max")} /></Field>
            </>
          )}
          {/* The hint says what the tooltip used to: the `?` was a second copy of the same sentence on a
              field that already explains itself (reported 2026-11-21: "this tool tip is not necessary"). */}
          <Field label="Output size limit (chars)" hint="Larger outputs are truncated in prompts"><input data-testid="setting-output-size-limit" className="input" value={f.limit} onChange={set("limit")} /></Field>
        </div>
        <Field label="Workspace directory" help="setting-workspace-dir" hint={`Base directory for workflows created in the designer. Empty: ${defaultWorkspace || "the default"}`}><input data-testid="setting-workspace-dir" className="input mono" placeholder={defaultWorkspace} value={f.workspace} onChange={set("workspace")} /></Field>
        <label className="mb-4 flex items-center gap-2 text-sm"><input type="checkbox" data-testid="setting-notify" checked={!!f.notify} onChange={set("notify")} /> Notify me when a gate is waiting</label>
      </div>

      <div className="card min-w-0" data-testid="doctor-summary">
        <div className="mb-2 flex items-center gap-3">
          <span className="text-sm font-semibold">Environment</span>
          <AsyncButton data-testid="btn-discover" className="btn" onClick={discover}>Refresh MCP servers</AsyncButton>
        </div>
        {!doctor ? "Checking…" : (
          <div className="text-sm">
            <div data-testid="doctor-ok" className={doctor.ok ? "text-green-800" : "text-red-800"}>{doctor.ok ? "All good." : `Problems: ${doctor.problems.join("; ")}`}</div>
            <div className="mono mt-2 text-xs text-slate-700 [overflow-wrap:anywhere]">
              <div>home {doctor.home}</div>
              <div>database ok · {doctor.db.migrations} migration(s)</div>
              <div data-testid="doctor-sandbox">sandbox {doctor.sandbox.available ? `ok (${doctor.sandbox.backend})` : `unavailable: ${doctor.sandbox.reason}`} → script nodes {doctor.sandbox.script_nodes}</div>
              <div data-testid="doctor-mcp">{doctor.mcp_servers} MCP servers known</div>
              {doctor.adapters.map((a: any) => <div key={a.name} data-testid={`doctor-adapter-${a.name}`}>{a.name}: {a.found ? `${a.version ?? "?"} ${a.ok ? "ok" : a.note ?? ""}` : a.note ?? "not found"}</div>)}
            </div>
          </div>
        )}
      </div>
      </div>
    </div>
    </div>
  );
}

/**
 * Appearance: the theme and the text size (task 15.8). Both save the moment they are chosen — there is
 * no Save button — and both apply to the whole page at once, so what you pick is what you see. The
 * choice is chief's own setting, not this browser's, so the desktop window and the browser agree.
 */
function Appearance() {
  const [theme, setTheme] = useState<Theme>(() => appearanceNow().theme);
  const [scale, setScale] = useState<TextScale>(() => appearanceNow().scale);
  const [error, setError] = useState<string | null>(null);
  // The page is already painted in these (main.tsx applied them before the first render).
  useEffect(() => {
    get("/api/settings").then((s) => {
      setTheme(isTheme(s.theme) ? s.theme : "system");
      setScale(isTextScale(s["font-size"]) ? s["font-size"] : "default");
    }).catch((e) => setError(e.message));
    followSystem();
  }, []);

  const choose = async (next: { theme?: Theme; scale?: TextScale }) => {
    const t = next.theme ?? theme, s = next.scale ?? scale;
    setTheme(t); setScale(s);
    applyAppearance(t, s);
    try {
      // Nothing waits for the save: the choice is already on screen.
      await api("PUT", "/api/settings", { theme: t, "font-size": s });
      setError(null);
    } catch (e: any) { setError(e.message); }
  };

  const themes: [Theme, string, string][] = [["light", "Light", "A light background with dark text"], ["dark", "Dark", "A dark background with light text"], ["system", "System", "Follow System Settings → Appearance"]];
  return (
    <div className="card mb-5" data-testid="appearance">
      <h2 className="mb-3 text-sm font-semibold">Appearance</h2>
      <ErrorBox error={error} testid="appearance-error" />
      <div className="flex flex-wrap items-start gap-6">
        <div className="min-w-0">
          <span className="label">Theme</span>
          <div className="flex rounded border border-slate-300 p-0.5" role="group" aria-label="Theme">
            {themes.map(([value, label, title]) => (
              <button key={value} type="button" data-testid={`theme-${value}`} aria-pressed={theme === value} title={title}
                className={`rounded px-3 py-1 text-sm ${theme === value ? "bg-accent text-white" : "text-slate-700 hover:bg-slate-100"}`}
                onClick={() => void choose({ theme: value })}>{label}</button>
            ))}
          </div>
          <p className="mt-1 text-2xs text-slate-500" data-testid="theme-now">
            {theme === "system" ? `Following the system, which is ${resolvedTheme("system")} right now.` : `Always ${theme}.`}
          </p>
        </div>
        <div className="min-w-0">
          <Field label="Text size" hint="Applies to the whole app: prose, tables and code alike.">
            <select data-testid="setting-font-size" className="input" value={scale} onChange={(e) => void choose({ scale: e.target.value as TextScale })}>
              {(Object.keys(TEXT_SCALES) as TextScale[]).map((k) => <option key={k} value={k}>{SCALE_NAMES[k]}</option>)}
            </select>
          </Field>
          {/* The three sizes in the app, at this scale, so a size is chosen by sight and not by name. */}
          <div className="rounded border border-slate-200 p-2" data-testid="font-preview">
            <div className="text-sm">Body text · the prompt you write and the results you read</div>
            <div className="text-xs text-slate-600">Code and hints · a JSON result or a path</div>
            <div className="text-2xs uppercase tracking-wide text-slate-500">Labels · field names and badges</div>
          </div>
        </div>
      </div>
    </div>
  );
}

const SCALE_NAMES: Record<TextScale, string> = { small: "Small", default: "Default", large: "Large", "extra-large": "Extra large" };

/**
 * The agent CLIs, as cards (task 15.14). Each card is the CLI's name, whether chief found it, and the
 * switch that decides whether chief may use it. The paths are found — `doctor` writes what it detected
 * into the setting — so a card's path field is filled in already, and is only there to be corrected
 * when something was not found or was found in the wrong place.
 *
 * A card that is switched off disappears from every agent picker (the designer's step panel, the
 * workflow's setting, the default here): chief never offers a CLI the person has said not to use.
 */
function Providers({ providers, loading, defaultAdapter, onChange }: { providers: ProviderState[] | null; loading: boolean; defaultAdapter: string; onChange: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [paths, setPaths] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!providers) return;
    setOpen((cur) => cur ?? providers.find((p) => p.found)?.name ?? providers[0]?.name ?? null);
    // Seed a field once. Re-seeding on every refresh would overwrite what is being typed: a save calls
    // back into this component, and the refresh arrives before the next keystroke.
    setPaths((cur) => {
      const next = { ...cur };
      for (const p of providers) if (next[p.name] === undefined) next[p.name] = p.path ?? "";
      return next;
    });
  }, [providers]);

  const toggle = async (p: ProviderState, on: boolean) => {
    setError(null);
    try {
      if (!on && p.name === defaultAdapter) {
        // Turning off the CLI every new step uses would leave chief with no default: say so first.
        setError(`${AGENT_LABEL[p.name] ?? p.name} is the default agent CLI. Choose another default below before switching it off.`);
        return;
      }
      // `.chosen` is what makes this a person's decision, so detection stops overriding it.
      await api("PUT", "/api/settings", { [`${p.name}.enabled`]: on, [`${p.name}.chosen`]: true });
      onChange();
    } catch (e: any) { setError(e.message); }
  };

  /**
   * A path is saved as it is typed (after a pause), like every other field: there is no Save button, and
   * a refresh must not lose what was typed (AGENTS.md, "Nothing typed in the web UI may be lost").
   */
  const pathTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const typePath = (name: string, value: string) => {
    setPaths((cur) => ({ ...cur, [name]: value }));
    clearTimeout(pathTimers.current[name]);
    pathTimers.current[name] = setTimeout(() => void savePath(name, value), 400);
  };
  const savePath = async (name: string, typed = paths[name] ?? "") => {
    const value = typed.trim();
    setError(null);
    try {
      await api("PUT", "/api/settings", { [`${name}.path`]: value || null });
      onChange();
    } catch (e: any) { setError(e.message); }
  };

  const checkAgain = async () => {
    setChecking(true);
    setError(null);
    try { onChange(); } finally { setChecking(false); }
  };

  const chosen = providers?.find((p) => p.name === open) ?? null;
  return (
    <div className="card mb-5" data-testid="providers">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Agent CLIs</h2>
        <AsyncButton data-testid="providers-check" className="btn" busy={checking || loading} onClick={checkAgain}>Check again</AsyncButton>
      </div>
      <p className="mb-3 text-sm text-slate-600">chief looks for each of these on your machine and fills in its path. Switch on the ones you want to use; a switched-off CLI is not offered in the designer or as a default.</p>
      <ErrorBox error={error} testid="providers-error" />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="provider-cards">
        {(providers ?? []).map((p) => (
          <div key={p.name} data-testid={`provider-${p.name}`} data-found={p.found} data-enabled={p.enabled}
            className={`flex cursor-pointer items-center justify-between gap-3 rounded border px-3 py-2 ${open === p.name ? "border-accent ring-1 ring-accent" : "border-slate-200 hover:bg-slate-50"}`}
            onClick={() => setOpen(p.name)}>
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{AGENT_LABEL[p.name] ?? p.name}</div>
              <div data-testid={`provider-status-${p.name}`} className={`truncate text-xs ${p.found ? "text-green-800" : "text-red-700"}`}>
                {p.found ? `CLI detected${p.version ? ` · ${p.version}` : ""}` : "CLI not detected"}
              </div>
            </div>
            {/* A switch, not a checkbox: off means "chief may not use this CLI". */}
            <button type="button" role="switch" aria-checked={p.enabled} aria-label={`Use ${AGENT_LABEL[p.name] ?? p.name}`}
              data-testid={`provider-switch-${p.name}`} disabled={!p.found}
              title={p.found ? (p.enabled ? "Stop offering this CLI" : "Offer this CLI again") : "Not found: set its path below, or install it"}
              onClick={(e) => { e.stopPropagation(); void toggle(p, !p.enabled); }}
              className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${p.enabled ? "bg-accent" : "bg-slate-300"}`}>
              <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-surface shadow transition-all ${p.enabled ? "left-[1.375rem]" : "left-0.5"}`} />
            </button>
          </div>
        ))}
      </div>
      {loading && <p className="mt-3 text-xs text-slate-500">Looking for the CLIs…</p>}
      {chosen && (
        <div className="mt-4" data-testid="provider-settings">
          <h3 className="mb-2 text-sm font-semibold">{AGENT_LABEL[chosen.name] ?? chosen.name} settings</h3>
          <div className="rounded border border-slate-200 bg-slate-50 p-3">
            <label className="block min-w-0">
              <span className="label">{AGENT_LABEL[chosen.name] ?? chosen.name} path<Help id={`setting-path-${chosen.name}`} /></span>
              <input data-testid={`setting-${chosen.name}-path`} className="input mono" value={paths[chosen.name] ?? ""}
                placeholder={chosen.found ? undefined : "Not found — the path to the program, if you have it"}
                onChange={(e) => typePath(chosen.name, e.target.value)}
                onBlur={(e) => void savePath(chosen.name, e.target.value)} />
              <span className="mt-1 block text-xs text-slate-600" data-testid={`provider-path-hint-${chosen.name}`}>
                {chosen.found
                  ? "Found on your machine; chief uses this path. Change it only if it is the wrong program."
                  : "chief could not find this CLI. Install it (a one-time command in its own documentation), or paste the path to the program here."}
              </span>
            </label>
            {chosen.found && chosen.version && <p className="mt-2 text-xs text-slate-600">Version {chosen.version}{chosen.ok ? "" : ` · ${chosen.note ?? "needs a newer version"}`}</p>}
            {!chosen.found && <p className="mt-2 text-xs text-slate-600">Until it is found the switch stays off, so no step can ask for it.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
