import { useEffect, useRef, useState } from "react";
import { api, get } from "../api";
import { AsyncButton, ErrorBox, Field, Help, readDraft, removeDraft, writeDraft } from "../ui";
import { applyAppearance, appearanceNow, BASE_COLORS, followSystem, isBaseColor, isTextScale, isTheme, resolvedTheme, TEXT_SCALES, type BaseColor, type TextScale, type Theme } from "../theme";
import { SHOW_BUDGETS } from "../features";
import { McpServers } from "./mcp-section";
import { ModelSelect } from "../designer/panel";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Checkbox } from "../components/ui/checkbox";

/** One agent CLI as Settings shows it (the shape of `/api/doctor`'s `providers`; the web app may not import the engine). */
interface ProviderState { name: string; enabled: boolean; chosen: boolean; found: boolean; path: string | null; version: string | null; ok: boolean; note?: string }
const AGENT_LABEL: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor", antigravity: "Antigravity", opencode: "OpenCode", hermes: "Hermes" };
const ADAPTERS = ["claude-code", "codex", "cursor", "antigravity", "opencode", "hermes"];

export function Settings() {
  const [f, setF] = useState<Record<string, any> | null>(null);
  const [doctor, setDoctor] = useState<any | null>(null);
  /** The workspace that applies when the setting is empty, from the server (it depends on where chief runs from). */
  const [defaultWorkspace, setDefaultWorkspace] = useState("");
  /** Which CLIs chief can add an MCP server for, by running that CLI's own command (task 15.56). */
  const [mcpWritable, setMcpWritable] = useState<string[]>([]);
  /** Which CLIs can sign in to a server through their own login command (task 15.57). */
  const [mcpAuthable, setMcpAuthable] = useState<string[]>([]);
  /** Which CLIs can sign out. Cursor cannot (its `disable` is a different act), so it shows none. */
  const [mcpLogoutable, setMcpLogoutable] = useState<string[]>([]);
  useEffect(() => { get("/api/meta").then((m) => { setDefaultWorkspace(m?.default_workspace_dir ?? ""); setMcpWritable(Array.isArray(m?.mcp_writable) ? m.mcp_writable : []); setMcpAuthable(Array.isArray(m?.mcp_auth) ? m.mcp_auth : []); setMcpLogoutable(Array.isArray(m?.mcp_logout) ? m.mcp_logout : []); }).catch(() => {}); }, []);
  const [error, setError] = useState<string | null>(null);

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
  /** Set one setting from a control's value (a text field or a checkbox), then save it a moment later. */
  const setValue = (k: string, value: unknown) => {
    const next = { ...f, [k]: value };
    setF(next);
    writeDraft("settings", next);
    typed.current += 1;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(next), 400);
  };
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const next = { ...f, [k]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value };
    setF(next);
    writeDraft("settings", next);
    typed.current += 1;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(next), 400);
  };

  return (
    <div className="page-width py-6" data-testid="page-column">
    <div>
      <h1 className="mb-4 text-xl font-semibold">Settings</h1>
      <ErrorBox error={error} />
      <div data-testid="settings-status" data-state={state} className={`mb-3 text-sm ${state === "invalid" ? "text-amber-800" : "text-slate-500"}`}>
        {state === "saving" && "Saving…"}
        {state === "saved" && (savedAt ? `✓ Saved automatically · ${savedAt.toLocaleTimeString([], { hour12: false })}` : "Changes are saved automatically.")}
        {state === "invalid" && "● Not saved yet: see the message above."}
      </div>
      <Appearance />
      <BotSettings providers={(doctor?.providers ?? null) as ProviderState[] | null} />
      <Providers providers={(doctor?.providers ?? null) as ProviderState[] | null} loading={!doctor}
        defaultAdapter={String(f.adapter ?? "")} onChange={() => { loadDoctor(); load(); }} />
      <div className="grid items-start gap-5 xl:grid-cols-3">
      <Card className="min-w-0 xl:col-span-2" data-testid="settings-card">
          <Field label="Default agent CLI" hint="What a workflow or a step uses when it does not choose one. Only the CLIs switched on above are offered.">
          <Select data-testid="setting-default-adapter"  value={f.adapter} onChange={set("adapter")}>
            {/* Only the CLIs that are switched on: the others are not offered to a step either. */}
            {((doctor?.providers ?? []) as ProviderState[]).filter((p) => p.enabled || p.name === f.adapter).map((p) => <option key={p.name} value={p.name}>{AGENT_LABEL[p.name] ?? p.name}</option>)}
            {!doctor && ADAPTERS.map((a) => <option key={a} value={a}>{AGENT_LABEL[a] ?? a}</option>)}
          </Select>
        </Field>
        <div className="grid gap-x-3 sm:grid-cols-2 lg:grid-cols-3">
          {/* The budget fields are hidden while budgets are (features.ts, task 15.24). What is stored is
              still sent back by `save`, so hiding the fields does not clear them. */}
          {SHOW_BUDGETS && (
            <>
              <Field label="Default budget: warn (USD)" help="setting-warn-usd"><Input data-testid="setting-warn-usd"  value={f.warn} onChange={set("warn")} /></Field>
              <Field label="Default budget: max (USD)" help="setting-max-usd" hint="Used when a workflow sets none"><Input data-testid="setting-max-usd"  value={f.max} onChange={set("max")} /></Field>
            </>
          )}
          {/* The hint says what the tooltip used to: the `?` was a second copy of the same sentence on a
              field that already explains itself (reported 2026-11-21: "this tool tip is not necessary"). */}
          <Field label="Output size limit (chars)" hint="Larger outputs are truncated in prompts"><Input data-testid="setting-output-size-limit"  value={f.limit} onChange={set("limit")} /></Field>
        </div>
        <Field label="Workspace directory" help="setting-workspace-dir" hint={`Base directory for workflows created in the designer. Empty: ${defaultWorkspace || "the default"}`}><Input className="mono" data-testid="setting-workspace-dir"  placeholder={defaultWorkspace} value={f.workspace} onChange={set("workspace")} /></Field>
        <label className="mb-4 flex items-center gap-2 text-sm"><Checkbox data-testid="setting-notify" checked={!!f.notify} onCheckedChange={(v) => setValue("notify", !!v)} /> Notify me when a gate is waiting</label>
      </Card>

      <Card className="min-w-0" data-testid="doctor-summary">
        <div className="mb-2 flex items-center gap-3">
          <span className="text-sm font-semibold">Environment</span>
        </div>
        {!doctor ? "Checking…" : (
          <div className="text-sm">
            <div data-testid="doctor-ok" className={doctor.ok ? "text-green-800" : "text-red-800"}>{doctor.ok ? "All good." : `Problems: ${doctor.problems.join("; ")}`}</div>
            <div className="mono mt-2 text-sm text-slate-700 [overflow-wrap:anywhere]">
              <div>home {doctor.home}</div>
              <div>database ok · {doctor.db.migrations} migration(s)</div>
              <div data-testid="doctor-sandbox">sandbox {doctor.sandbox.available ? `ok (${doctor.sandbox.backend})` : `unavailable: ${doctor.sandbox.reason}`} → script nodes {doctor.sandbox.script_nodes}</div>
              <div data-testid="doctor-mcp">{doctor.mcp_servers} MCP servers known</div>
              {doctor.adapters.map((a: any) => <div key={a.name} data-testid={`doctor-adapter-${a.name}`}>{a.name}: {a.found ? `${a.version ?? "?"} ${a.ok ? "ok" : a.note ?? ""}` : a.note ?? "not found"}</div>)}
            </div>
          </div>
        )}
      </Card>
      </div>
      {/* Read-only, and outside the two-column grid: it is a reference list, not a setting that is typed. */}
      {doctor && <McpServers writable={mcpWritable} authable={mcpAuthable} logoutable={mcpLogoutable} providers={((doctor.providers ?? []) as ProviderState[]).map((p) => ({ name: p.name, enabled: p.enabled, found: p.found }))} />}
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
  /** The neutral ramp: shadcn's five base colours, `neutral` by default. */
  const [base, setBase] = useState<BaseColor>(() => appearanceNow().base);
  const [error, setError] = useState<string | null>(null);
  // The page is already painted in these (main.tsx applied them before the first render).
  useEffect(() => {
    get("/api/settings").then((s) => {
      setTheme(isTheme(s.theme) ? s.theme : "system");
      setScale(isTextScale(s["font-size"]) ? s["font-size"] : "default");
      setBase(isBaseColor(s["base-color"]) ? s["base-color"] : "neutral");
    }).catch((e) => setError(e.message));
    followSystem();
  }, []);

  const choose = async (next: { theme?: Theme; scale?: TextScale; base?: BaseColor }) => {
    const t = next.theme ?? theme, s = next.scale ?? scale, b = next.base ?? base;
    setTheme(t); setScale(s); setBase(b);
    applyAppearance(t, s, b);
    try {
      // Nothing waits for the save: the choice is already on screen.
      await api("PUT", "/api/settings", { theme: t, "font-size": s, "base-color": b });
      setError(null);
    } catch (e: any) { setError(e.message); }
  };

  const themes: [Theme, string, string][] = [["light", "Light", "A light background with dark text"], ["dark", "Dark", "A dark background with light text"], ["system", "System", "Follow System Settings → Appearance"]];
  return (
    <Card className="mb-5" data-testid="appearance">
      <h2 className="mb-3 text-sm font-semibold">Appearance</h2>
      <ErrorBox error={error} testid="appearance-error" />
      <div className="flex flex-wrap items-start gap-6">
        <div className="min-w-0">
          <span className="label">Theme</span>
          <div className="flex rounded border border-slate-300 p-0.5" role="group" aria-label="Theme">
            {themes.map(([value, label, title]) => (
              <Button variant="ghost" key={value} type="button" data-testid={`theme-${value}`} aria-pressed={theme === value} title={title} className={`rounded px-3 py-1 text-sm ${theme === value ? "bg-primary text-primary-foreground" : "text-slate-700 hover:bg-slate-100"}`} onClick={() => void choose({ theme: value })}>{label}</Button>
            ))}
          </div>
          <p className="mt-1 text-sm text-slate-500" data-testid="theme-now">
            {theme === "system" ? `Following the system, which is ${resolvedTheme("system")} right now.` : `Always ${theme}.`}
          </p>
        </div>
        <div className="min-w-0">
          <Field label="Colour scheme" hint="The greys behind everything. Neutral is pure grey; Slate, the old default, had a blue cast.">
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Colour scheme">
              {(Object.keys(BASE_COLORS) as BaseColor[]).map((value) => (
                <Button variant="outline" key={value} type="button" data-testid={`base-${value}`} aria-pressed={base === value}
                  title={`${BASE_COLORS[value]} greys`} onClick={() => void choose({ base: value })}
                  className={`h-auto flex-col gap-1 px-2 py-1.5 ${base === value ? "ring-2 ring-ring" : ""}`}>
                  {/* The swatch is the ramp itself, not a colour name. */}
                  <span aria-hidden="true" className="flex overflow-hidden rounded-sm border border-slate-300" data-base-swatch={value}>
                    {BASE_SWATCH[value].map((colour) => <span key={colour} className="block h-3 w-3" style={{ background: colour }} />)}
                  </span>
                  <span className="text-xs">{BASE_COLORS[value]}</span>
                </Button>
              ))}
            </div>
          </Field>
        </div>
        <div className="min-w-0">
          <Field label="Text size" hint="Applies to the whole app: prose, tables and code alike. Default is the size chief ships with.">
            <Select data-testid="setting-font-size"  value={scale} onChange={(e) => void choose({ scale: e.target.value as TextScale })}>
              {(Object.keys(TEXT_SCALES) as TextScale[]).map((k) => <option key={k} value={k}>{SCALE_NAMES[k]}</option>)}
            </Select>
          </Field>
          {/* The three sizes in the app, at this scale, so a size is chosen by sight and not by name. The rows keep their
              own sizes — this is the one place where small text is the *subject*, not a caption — which is why the
              settings-wide step up left them alone. */}
          <div className="rounded border border-slate-200 p-2" data-testid="font-preview">
            <div className="text-sm" data-size="body">Body text · the prompt you write and the results you read</div>
            <div className="text-xs text-slate-600" data-size="code">Code and hints · a JSON result or a path</div>
            <div className="text-2xs uppercase tracking-wide text-slate-500" data-size="label">Labels · field names and badges</div>
          </div>
        </div>
      </div>
    </Card>
  );
}

/**
 * Three steps of each base colour, for the swatch.
 *
 * Literal values, not `var(--color-slate-*)`: that token is the *chosen* ramp, so five swatches reading it would all look
 * like the one selected — a picker whose options are identical. These are Tailwind's own values for each family.
 */
const BASE_SWATCH: Record<BaseColor, string[]> = {
  neutral: ["oklch(87% 0 none)", "oklch(55.6% 0 none)", "oklch(37.1% 0 none)"],
  gray: ["oklch(87.2% 0.01 258.338)", "oklch(55.1% 0.027 264.364)", "oklch(37.3% 0.034 259.733)"],
  slate: ["oklch(86.9% 0.022 252.894)", "oklch(55.4% 0.046 257.417)", "oklch(37.2% 0.044 257.287)"],
  stone: ["oklch(86.9% 0.005 56.366)", "oklch(55.3% 0.013 58.071)", "oklch(37.4% 0.01 67.558)"],
  zinc: ["oklch(87.1% 0.006 286.286)", "oklch(55.2% 0.016 285.938)", "oklch(37% 0.013 285.805)"],
};

const SCALE_NAMES: Record<TextScale, string> = { default: "Default", large: "Large", larger: "Larger", largest: "Largest" };

/**
 * The agent CLIs, as cards (task 15.14). Each card is the CLI's name, whether chief found it, and the
 * switch that decides whether chief may use it. The paths are found — `doctor` writes what it detected
 * into the setting — so a card's path field is filled in already, and is only there to be corrected
 * when something was not found or was found in the wrong place.
 *
 * A card that is switched off disappears from every agent picker (the designer's step panel, the
 * workflow's setting, the default here): chief never offers a CLI the person has said not to use.
 */
/**
 * § chief bot's own configuration (task 15.87).
 *
 * The bot was configured from inside its panel: a model picker and two dropdowns for what it may reach, parked in the
 * strip above the composer on every reply. Those are settings, not conversation controls — a person chooses once and
 * then talks — so they live here with the rest of chief's settings, and the panel keeps a line saying what is in force.
 * Every field saves as it changes; there is no Save button.
 *
 * **Only installed, switched-on CLIs are offered.** A choice that cannot answer is worse than no choice, and the switch
 * above already says which CLIs chief may use.
 *
 * `Auto` is the default and is not a CLI: it keeps the bot following the page, which is what makes a question asked on a
 * run's page answer with that run's CLI, and one asked on the canvas answer with the workflow's own.
 */
function BotSettings({ providers }: { providers: ProviderState[] | null }) {
  const [adapter, setAdapter] = useState("auto");
  const [model, setModel] = useState("");
  const [tools, setTools] = useState("read-only");
  const [mcp, setMcp] = useState("none");
  const [defaultAdapter, setDefaultAdapter] = useState("claude-code");
  /** Mirrors `DEFAULT_CONTEXT_BUDGET` in `ask.ts`: the two must agree, and a case (E15.98-1) checks the default. */
  const CONTEXT_BUDGET_DEFAULT = 100_000;
  const [budget, setBudget] = useState(String(CONTEXT_BUDGET_DEFAULT));
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    get("/api/settings").then((s: any) => {
      setAdapter(typeof s["assistant-adapter"] === "string" && s["assistant-adapter"] ? s["assistant-adapter"] : "auto");
      setModel(typeof s["assistant-model"] === "string" ? s["assistant-model"] : "");
      setTools(typeof s["assistant-tools"] === "string" ? s["assistant-tools"] : "read-only");
      setMcp(typeof s["assistant-mcp"] === "string" ? s["assistant-mcp"] : "none");
      setDefaultAdapter(typeof s["default-adapter"] === "string" ? s["default-adapter"] : "claude-code");
      setBudget(String(Number(s["assistant-context-budget"]) || CONTEXT_BUDGET_DEFAULT));
      setLoaded(true);
    }).catch((e: any) => setError(e.message));
  }, []);

  const save = async (patch: Record<string, unknown>) => {
    try { await api("PUT", "/api/settings", patch); setError(null); }
    catch (e: any) { setError(e.message); }
  };

  // A model belongs to the CLI that offered it: Claude's id sent to Cursor is rejected by the CLI with a message about
  // models rather than about the real problem. So changing the CLI clears the model, the rule the panel used.
  const chooseAdapter = (next: string) => {
    setAdapter(next);
    if (next !== adapter) { setModel(""); void save({ "assistant-adapter": next, "assistant-model": "" }); }
  };

  // The CLI whose models are offered. `auto` has no list of its own — the page decides — so it shows chief's default
  // CLI's, which is what a run with no opinion of its own would use.
  const listAdapter = adapter === "auto" ? defaultAdapter : adapter;
  // Only switched-on CLIs, plus the stored choice itself when its CLI has since been switched off: an option list that
  // silently dropped it would leave the field reading `Auto` while chief answered with something else.
  const offered = providers ?? [];
  const enabled = offered.filter((p) => p.enabled);
  const shown = adapter === "auto" || offered.some((p) => p.name === adapter);
  const options = enabled.length ? enabled : offered;
  const modelHint = adapter === "auto"
    ? `Following the page. Its models come from ${AGENT_LABEL[listAdapter] ?? listAdapter}, chief's default CLI.`
    : `from ${AGENT_LABEL[adapter] ?? adapter}`;

  return (
    <Card className="mb-5" data-testid="bot-settings">
      <h2 className="mb-1 text-sm font-semibold">chief bot</h2>
      <p className="mb-3 text-sm text-slate-500">The assistant in the panel beside every page. It answers with an agent CLI, never with an API key of its own.</p>
      {error && <p data-testid="bot-settings-error" className="mb-2 text-sm text-red-700">{error}</p>}
      <div className="grid gap-x-3 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Agent CLI" hint="Auto follows the page: a run's CLI on its run, the workflow's on the canvas.">
          <Select data-testid="setting-bot-adapter" value={adapter} disabled={!loaded} onChange={(e) => chooseAdapter(e.target.value)}>
            <option value="auto">Auto — follow the page</option>
            {!shown && <option value={adapter}>{AGENT_LABEL[adapter] ?? adapter}</option>}
            {options.map((p) => <option key={p.name} value={p.name}>{AGENT_LABEL[p.name] ?? p.name}</option>)}
          </Select>
        </Field>
        <div className="sm:col-span-2 lg:col-span-1" data-testid="setting-bot-model-field">
          {/* The list is the CLI's, as every model choice in chief is — never one hard-coded here. */}
          {/* `saySource={false}`: the line under it is the hint, and it is the one that can also say what "Auto" means
              (which CLI the page will be on). Two of them said the same thing twice, in two names. */}
          <ModelSelect adapter={listAdapter} value={model || undefined} testid="setting-bot-model" saySource={false}
            onChange={(v) => { setModel(v); void save({ "assistant-model": v }); }} />
          <p className="mt-1 text-sm text-slate-500" data-testid="bot-model-hint">{modelHint}</p>
        </div>
        <Field label="What it may reach" hint="Read-only can look; it cannot write, edit or run a shell.">
          <Select data-testid="setting-bot-tools" value={tools} disabled={!loaded}
            onChange={(e) => { setTools(e.target.value); void save({ "assistant-tools": e.target.value }); }}>
            <option value="none">No tools</option>
            <option value="read-only">Read-only — read and search</option>
            <option value="default">All of the CLI's own</option>
          </Select>
        </Field>
        <Field label="MCP servers" hint="Whatever the chosen CLI is already connected to, read from that CLI.">
          <Select data-testid="setting-bot-mcp" value={mcp} disabled={!loaded}
            onChange={(e) => { setMcp(e.target.value); void save({ "assistant-mcp": e.target.value }); }}>
            <option value="none">None</option>
            <option value="all">Every connected server</option>
          </Select>
        </Field>
        <Field label="Compact a conversation after" hint="Tokens the CLI reports reading for the session. Past this, chief has the conversation summarised and continues from the notes.">
          <Input data-testid="setting-bot-context-budget" inputMode="numeric" value={budget} disabled={!loaded}
            onChange={(e) => setBudget(e.target.value)}
            onBlur={(e) => {
              // Written on blur rather than per keystroke: half a number is not a setting, and "1" would compact at once.
              const n = Number(e.target.value);
              if (!Number.isFinite(n) || n < 10_000) { setBudget(String(CONTEXT_BUDGET_DEFAULT)); void save({ "assistant-context-budget": CONTEXT_BUDGET_DEFAULT }); }
              else void save({ "assistant-context-budget": Math.round(n) });
            }} />
        </Field>
      </div>
      {/* The safety model, said once where the controls are, rather than in a tooltip nobody opens. */}
      <p className="mt-2 text-xs text-slate-500">chief never writes MCP configuration itself: the servers are the CLI's, and its own settings decide which of them the bot may call.</p>
    </Card>
  );
}

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
    <Card className="mb-5" data-testid="providers">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Agent CLIs</h2>
        <AsyncButton data-testid="providers-check" variant="outline" busy={checking || loading} onClick={checkAgain}>Check again</AsyncButton>
      </div>
      <p className="mb-3 text-sm text-slate-600">chief looks for each of these on your machine and fills in its path. Switch on the ones you want to use; a switched-off CLI is not offered in the designer or as a default.</p>
      <ErrorBox error={error} testid="providers-error" />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="provider-cards">
        {(providers ?? []).map((p) => (
          <div key={p.name} data-testid={`provider-${p.name}`} data-found={p.found} data-enabled={p.enabled}
            className={`flex cursor-pointer items-center justify-between gap-3 rounded border px-3 py-2 ${open === p.name ? "border-primary ring-1 ring-ring" : "border-slate-200 hover:bg-slate-50"}`}
            onClick={() => setOpen(p.name)}>
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{AGENT_LABEL[p.name] ?? p.name}</div>
              <div data-testid={`provider-status-${p.name}`} className={`truncate text-sm ${p.found ? "text-green-800" : "text-red-700"}`}>
                {p.found ? `CLI detected${p.version ? ` · ${p.version}` : ""}` : "CLI not detected"}
              </div>
            </div>
            {/* A switch, not a checkbox: off means "chief may not use this CLI". */}
            <Button variant="ghost" type="button" role="switch" aria-checked={p.enabled} aria-label={`Use ${AGENT_LABEL[p.name] ?? p.name}`} data-testid={`provider-switch-${p.name}`} disabled={!p.found} title={p.found ? (p.enabled ? "Stop offering this CLI" : "Offer this CLI again") : "Not found: set its path below, or install it"} onClick={(e) => { e.stopPropagation(); void toggle(p, !p.enabled); }}
              className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${p.enabled ? "bg-primary" : "bg-slate-300"}`}>
              <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-surface shadow transition-all ${p.enabled ? "left-[1.375rem]" : "left-0.5"}`} />
            </Button>
          </div>
        ))}
      </div>
      {loading && <p className="mt-3 text-sm text-slate-500">Looking for the CLIs…</p>}
      {chosen && (
        <div className="mt-4" data-testid="provider-settings">
          <h3 className="mb-2 text-sm font-semibold">{AGENT_LABEL[chosen.name] ?? chosen.name} settings</h3>
          <div className="rounded border border-slate-200 bg-slate-50 p-3">
            <label className="block min-w-0">
              <span className="label">{AGENT_LABEL[chosen.name] ?? chosen.name} path<Help id={`setting-path-${chosen.name}`} /></span>
              <Input className="mono" data-testid={`setting-${chosen.name}-path`}  value={paths[chosen.name] ?? ""}
                placeholder={chosen.found ? undefined : "Not found — the path to the program, if you have it"}
                onChange={(e) => typePath(chosen.name, e.target.value)}
                onBlur={(e) => void savePath(chosen.name, e.target.value)} />
              <span className="mt-1 block text-sm text-slate-600" data-testid={`provider-path-hint-${chosen.name}`}>
                {chosen.found
                  ? "Found on your machine; chief uses this path. Change it only if it is the wrong program."
                  : "chief could not find this CLI. Install it (a one-time command in its own documentation), or paste the path to the program here."}
              </span>
            </label>
            {chosen.found && chosen.version && <p className="mt-2 text-sm text-slate-600">Version {chosen.version}{chosen.ok ? "" : ` · ${chosen.note ?? "needs a newer version"}`}</p>}
            {!chosen.found && <p className="mt-2 text-sm text-slate-600">Until it is found the switch stays off, so no step can ask for it.</p>}
          </div>
        </div>
      )}
    </Card>
  );
}
