/**
 * Collections: a named set of input values for one workflow, prepared over as many days as the data takes, and used
 * as the input of a run (dev plan 15.122, renamed and re-placed by 15.124–15.126).
 *
 * Called a "case" for an afternoon on 2026-11-24 and given a page of its own; both were wrong. It is **the input data
 * of a run**, so it lives in the Runs page beside the runs it starts, and the word is the one the person used.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, get, getPage } from "./api";
import { AsyncButton, ErrorBox, Help, PanelResizeHandle, readDraft, removeDraft, useRightPanelResize, writeDraft } from "./ui";
import { blankInputs, InputFormWithJson, missingRequired, parseInputs, type InputField } from "./run-inputs";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Select } from "./components/ui/select";

/** A collection as `GET /api/input-sets` returns it: its values, and how ready it is to start. */
export interface InputSet {
  id: number; workflow: string; name: string; values: Record<string, unknown>;
  ready: boolean; missingRequired: { path: string; label: string }[]; missing: string[];
  fields: number; filled: number;
  workflow_archived: boolean; created_at: string; updated_at: string;
}

/** What an input data set still needs, in the person's words. */
export const inputSetMissing = (c: InputSet) =>
  [...c.missingRequired.map((m) => m.label), ...c.missing.filter((p) => !c.missingRequired.some((m) => m.path === p))]
    .filter((v, i, all) => all.indexOf(v) === i);

/**
 * The collections, read after each change rather than polled: one changes only when someone changes it, and a poll
 * would fight what is being typed. `workflow` filters them to one workflow's.
 */
export function useInputSets(workflow: string) {
  const [rows, setRows] = useState<InputSet[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback((page = 1, perPage = 25) => {
    const q = workflow ? `?workflow=${encodeURIComponent(workflow)}&` : "?";
    getPage(`/api/input-sets${q}`.replace(/&&/, "&"), page, perPage)
      .then(({ items, total }) => { setRows(items as InputSet[]); setTotal(total); setError(null); setLoading(false); })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, [workflow]);
  useEffect(() => { setLoading(true); load(); }, [load]);
  return { rows, total, loading, error, reload: load };
}

/**
 * The workflow column: see, choose, manage and create workflows without leaving the page (15.125). It copies the
 * designer's *Building blocks* panel — the pattern this app already taught its people — including the things that
 * panel does and a bare list does not:
 *
 * - a **header that lines up with the page's own title** (the same 24 px top padding, not jammed against the app bar);
 * - a **surface of its own** (`bg-slate-50` against the page's white) and a border, so it reads as a column and not as
 *   an accidental strip of text;
 * - a **section label** over the list, rows that highlight on hover, the current one marked with a filled card and a
 *   left accent rather than a font weight alone;
 * - full height with its own scroll, so a long list scrolls in the column and never pushes the page;
 * - a footer for the actions, at the foot where a panel's actions belong.
 *
 * Below 768 px it is always the collapsed strip, and that is CSS rather than a measured width: a layout that waits for
 * a `resize` event to stop overflowing overflows for a frame (found by E15.33-2 on 2026-11-24).
 */
export function WorkflowPanel({ workflows, selected, onSelect, open, setOpen }: {
  workflows: any[]; selected: string; onSelect: (name: string) => void; open: boolean; setOpen: (v: boolean) => void;
}) {
  const strip = (
    <div data-testid="workflows-panel-collapsed" className={`${open ? "flex lg:hidden" : "flex"} min-h-0 w-9 shrink-0 flex-col items-center border-r border-slate-200 bg-surface pt-7`}>
      <Button variant="ghost" size="sm" className="h-7 w-7 px-0 text-slate-500 hover:text-slate-800" type="button" data-testid="workflows-panel-open"
        aria-label="Show the workflows" title="Show the workflows" onClick={() => setOpen(true)}>
        <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 3l5 5-5 5" /></svg>
      </Button>
      <span className="mt-4 select-none text-2xs font-semibold uppercase tracking-wide text-slate-400" style={{ writingMode: "vertical-rl" }}>Workflows</span>
    </div>
  );
  if (!open) return strip;
  /**
   * One workflow: its name, and what is in it. **One line, one control height** — two lines made it taller than the
   * 40 px every other button obeys (E15.72-1 caught it), and a column of cards taller than a row of text is a column
   * that pushes the list it filters off the page.
   */
  const card = (name: string, label: string, detail: string, testid: string, isOn: boolean) => (
    <Button variant="ghost" type="button" data-testid={testid} data-selected={isOn} aria-current={isOn ? "true" : undefined}
      onClick={() => onSelect(name)} title={`${label}${detail ? ` · ${detail}` : ""}`}
      className={`h-auto w-full justify-start gap-2 rounded-md border px-2 py-1.5 text-left font-normal ${isOn
        ? "border-slate-800 bg-slate-50 text-slate-900 shadow-xs ring-1 ring-slate-800"
        : "border-slate-200 bg-surface text-slate-700 hover:border-slate-300 hover:bg-slate-50"}`}>
      <span className={`min-w-0 flex-1 truncate text-sm ${isOn ? "font-semibold" : ""}`}>{label}</span>
      {detail && <span className="shrink-0 text-2xs text-slate-500">{detail}</span>}
    </Button>
  );
  const count = (n: number) => `${n} ${n === 1 ? "input data set" : "input data sets"}`;
  return (
    <>
      {strip}
      <aside data-testid="workflows-panel" aria-label="Workflows"
        className="hidden h-full w-56 shrink-0 flex-col border-r border-slate-200 bg-surface lg:flex">
        <div className="flex h-7 shrink-0 items-center gap-1 px-3 pt-6">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Workflows</span>
          <Button variant="ghost" className="ml-auto h-7 w-7 px-0 text-slate-500 hover:text-slate-800" type="button" data-testid="workflows-panel-close"
            aria-label="Hide the workflows" title="Hide the workflows" onClick={() => setOpen(false)}>
            <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M10 3L5 8l5 5" /></svg>
          </Button>
        </div>
        <div className="mt-5 min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {/* shadcn's Button, like every other control here: a hand-written one is what E15.76-1 catches. */}
          {card("", "All workflows", "", "workflow-panel-all", !selected)}
          <div className="mb-1.5 mt-4 px-1 text-2xs font-semibold uppercase tracking-wide text-slate-400">Choose one</div>
          <div className="space-y-1.5">
            {workflows.map((w) => card(w.name, w.name, count(w.input_sets ?? 0), `workflow-panel-${w.name}`, selected === w.name))}
            {workflows.length === 0 && <p className="px-1 py-2 text-xs text-slate-500">No workflows yet. Make one with the button below.</p>}
          </div>
        </div>
        <div className="shrink-0 space-y-1 border-t border-slate-200 p-2">
          {selected && (
            <Button asChild variant="ghost" size="sm" className="h-auto w-full justify-start rounded-md px-2 py-1.5 text-xs font-normal text-slate-600 hover:bg-surface">
              <a data-testid="workflow-panel-manage" href={`#/designer/${encodeURIComponent(selected)}`} title={`Open “${selected}” in the designer`}>
                <span className="truncate">Open in the designer</span>
              </a>
            </Button>
          )}
          <Button asChild variant="outline" size="sm" className="w-full justify-start rounded-md px-2 text-xs">
            <a data-testid="workflow-panel-new" href="#/designer">+ New workflow</a>
          </Button>
        </div>
      </aside>
    </>
  );
}

/**
 * One input data set, in a **right side panel**: the design standard for adding something to a listing, and the shape
 * the designer already uses for a new workflow (15.125).
 *
 * There is **no Save button**, because every change saves itself. It is debounced a moment so a name being typed is one
 * write and not nine, and the state line says which of the three it is: saved, saving, or what is still needed. That is
 * the rule this repository already had (*"There are no Save buttons"*, AGENTS.md), and a card with a Create button had
 * quietly broken it.
 *
 * **Two panels, one component.** A panel opened by **New input data set** is a form that is not a set yet: its fields are
 * empty, nothing is written while it is typed, and its one action is **Save data set**. A panel opened by **clicking a row**
 * is that set: every value is written as it is typed (that is the "no Save buttons" rule), and its one action is
 * **Start run** (asked 2026-11-25: *"disable the auto create data set feature when the new data set button is clicked, add
 * the explict Save data set button in the panel if it's a new form, otherwise it should be `Start run` if it opened by
 * clicking the item on the data set listing"* — which reverses the create-on-open of an hour earlier).
 *
 * **No placeholder carries a value.** An empty box is empty: putting a previous set's data, or the workflow's, in the grey
 * text reads as a filled form and told a person their own data was there (2026-11-25: *"DO NOT use my previous data set
 * values as the placeholder's content for the form"*). An empty field still leaves the workflow's own default in place
 * when the run starts, which is what that default is for, but the panel says so in words, not by showing a value.
 */
export function InputSetPanel({ id, existing, workflows, defaultWorkflow, blocked, onClose, onSaved, onStarted }: {
  /** `null` creates; a number edits that set. */
  id: number | null;
  existing: InputSet | null;
  workflows: any[];
  defaultWorkflow: string;
  /** Why a run cannot start at all (no agent CLI): the button says it before the press, not after. */
  blocked?: { why: string };
  onClose: () => void;
  onSaved: (c: InputSet) => void;
  onStarted: (runId: number) => void;
}) {
  /** The set this panel is now about: the one given, or the one the first change created. */
  const [saved, setSaved] = useState<InputSet | null>(existing);
  const creating = saved === null;
  const resize = useRightPanelResize({ draftKey: "ui:input-set-panel-width", defaultWidth: 448, minWidth: 360 });
  /**
   * A draft per set (or per "new"): nothing typed in chief is lost on a refresh (AGENTS.md's draft rule). Removed once
   * what is stored matches what is on screen.
   */
  // `||`, not `??`: the page's focus is the empty string when no workflow is chosen, and `"" ?? next` keeps "".
  const initialWorkflow = existing?.workflow || defaultWorkflow || workflows[0]?.name || "";
  const [workflow, setWorkflow] = useState(initialWorkflow);
  /**
   * The draft is per set, and a **new** one is per workflow: a draft left behind for one workflow must never fill a
   * panel opened for another, which is what "i still see the previous data already filled the form" was (2026-11-25).
   */
  const draftBase = `input-set:${id ?? `new:${initialWorkflow}`}`;
  const [name, setName] = useState(() => readDraft<string>(`${draftBase}:name`) ?? existing?.name ?? "");
  /** The values as text: one value, two views, exactly as a run's inputs are (15.120). */
  /** The values, empty to begin with: a new set holds `{}` and the fields show nothing. */
  const [text, setText] = useState<string>(() => readDraft<string>(`${draftBase}:values`) ?? (existing ? JSON.stringify(existing.values, null, 2) : "{}"));
  const [fields, setFields] = useState<InputField[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  /** What was last stored, so "has anything changed?" is a comparison rather than a flag kept in step by hand. */
  const stored = useRef({ name: existing?.name ?? "", values: existing ? JSON.stringify(existing.values) : "{}" });
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  /**
   * Close: **a pending change is written before the panel goes**, rather than dropped with the debounce. Typing a name
   * and closing within the half-second used to save nothing and leave the draft behind, so the next new panel opened
   * pre-filled with it (reported 2026-11-25: *"why when i create a new data set, i still see the previous data already
   * filled the form"*). Now the write happens first, which also clears the draft — nothing typed is lost, and nothing
   * stale is inherited.
   */
  const began = useRef(false);
  const close = async () => {
    if (saved && !began.current && changed && parsed) {
      began.current = true;
      try {
        const out = await write(parsed);
        onSaved(out);
      } catch { /* the error is on screen if it can be; the panel still closes */ }
    }
    // A closed panel has nothing left to restore — and a draft left behind is what filled the next new panel.
    removeDraft(`${draftBase}:name`); removeDraft(`${draftBase}:values`);
    onClose();
  };
  /**
   * The same flush when the panel goes **without** being closed — navigating to another page. A draft is there to
   * survive a **refresh** (a refresh runs no cleanup, so it still does), not to be inherited by the next new panel, and
   * an abandoned panel that has content is a set, so it is written rather than left in a draft.
   */
  const flush = useRef<() => void>(() => {});
  flush.current = () => {
    if (!saved || began.current || !changed || !parsed) return;
    began.current = true;
    void write(parsed).then(() => { removeDraft(`${draftBase}:name`); removeDraft(`${draftBase}:values`); }).catch(() => { /* a draft is better than nothing */ });
  };
  useEffect(() => () => flush.current(), []);

  // Escape closes it, as the designer's panel does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); void close(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // The fields of the chosen workflow. A new set also starts from the workflow's own values — the only thing left to do
  // is the part this one differs in.
  useEffect(() => {
    if (!workflow) return setFields([]);
    let live = true;
    get(`/api/workflows/${encodeURIComponent(workflow)}`)
      .then((w: any) => live && setFields(w.input_refs ?? []))
      .catch(() => live && setFields([]));
    return () => { live = false; };
  }, [workflow]);
  // The workflow list can arrive after the panel opens, so a new set with none takes the first one then.
  useEffect(() => { if (!saved && !workflow && workflows.length) setWorkflow(workflows[0].name); }, [saved, workflow, workflows]);
  useEffect(() => { if (name) writeDraft(`${draftBase}:name`, name); else removeDraft(`${draftBase}:name`); }, [draftBase, name]);
  useEffect(() => { writeDraft(`${draftBase}:values`, text); }, [draftBase, text]);

  const parsed = parseInputs(text);
  const missing = missingRequired(fields, parsed ?? {});
  // A blank the prompts read is refused by the engine, so it disables Start too, or the panel offers a refused run.
  const blank = blankInputs(fields, parsed ?? {});
  const cannotStart = missing.length > 0 || blank.length > 0;
  /**
   * The name to store: what is in the field, or empty — the **server** names a nameless set after the workflow and the
   * day, uniquely, because only it can see what is taken.
   */
  const finalName = () => name.trim();
  const changed = parsed !== null && (name.trim() !== stored.current.name || JSON.stringify(parsed) !== stored.current.values);

  // ── a value typed into an existing set is written; a new one is not, until it is saved ────
  const write = useCallback(async (values: Record<string, unknown>): Promise<InputSet> => {
    const body = { name: finalName(), values };
    const out = saved
      ? await api("PATCH", `/api/input-sets/${saved.id}`, body)
      : await api("POST", "/api/input-sets", { workflow, ...body });
    return out as InputSet;
  }, [saved, workflow, name]);

  useEffect(() => {
    // A **new** set is not stored while it is typed: it becomes one when its Save is pressed. An existing set is the
    // "no Save buttons" rule — every value is written as it is made.
    if (!saved) return;
    if (!parsed) return;              // the JSON view says why; nothing is written that the server cannot read
    if (!changed) return;             // nothing new to write
    setState("saving");
    // A moment, so a name being typed is one write and not nine. A positive delay for a debounce is the one timer the UI
    // rules allow (AGENTS.md).
    const t = setTimeout(() => {
      void write(parsed).then((out) => {
        if (!alive.current) return;
        stored.current = { name: out.name, values: JSON.stringify(out.values) };
        setSaved(out);
        removeDraft(`${draftBase}:name`); removeDraft(`${draftBase}:values`);
        setState("saved");
        setError(null);
        onSaved(out);
      }).catch((e) => { if (!alive.current) return; setState("error"); setError(e.message); });
    }, 500);
    return () => clearTimeout(t);
  }, [text, name, workflow, changed, parsed, write, draftBase, onSaved]);

  /** **Save data set**: the one action of a panel that is not a set yet. */
  const create = async () => {
    setError(null);
    if (!parsed) return setError("The values are not a JSON object. Fix them in the JSON view.");
    setState("saving");
    try {
      const out = await api("POST", "/api/input-sets", { workflow, name: finalName(), values: parsed }) as InputSet;
      stored.current = { name: out.name, values: JSON.stringify(out.values) };
      removeDraft(`${draftBase}:name`); removeDraft(`${draftBase}:values`);
      setSaved(out);
      // The name it was given is shown, so the field is never empty over a set that has one.
      if (!name.trim()) setName(out.name);
      setState("saved");
      onSaved(out);
    } catch (e: any) { setState("error"); setError(e.message); }
  };

  const start = async () => {
    setError(null);
    if (!parsed) return setError("The values are not a JSON object. Fix them in the JSON view.");
    setState("saving");
    try {
      // Written first, so what runs is what this set now says — then started from it, which copies the values.
      const out = await write(parsed);
      const run = await api("POST", "/api/runs", { workflow, input_set: out.id });
      onStarted(run.run.id);
    } catch (e: any) { setState("error"); setError(e.message); }
  };

  return (
    <>
      <div data-testid="input-set-backdrop" className="fixed inset-0 z-40 bg-black/20" onClick={() => void close()} />
      <aside data-testid="input-set-panel" role="dialog" aria-modal="true" aria-label={creating ? "New input data set" : "Input data set"}
        className="slide-in-right fixed inset-y-0 right-0 z-50 flex flex-col border-l border-slate-200 bg-surface shadow-2xl" style={{ width: resize.width }}>
        <PanelResizeHandle testid="input-set-panel-resize" label="Resize the input data set panel" resize={resize} />
        <div className="flex shrink-0 items-center gap-2 border-b border-slate-200 px-4 py-2.5">
          <h2 className="text-base font-semibold">{creating ? "New input data set" : "Input data set"}</h2>
          {saved && <span className="mono text-2xs text-slate-400" data-testid="input-set-id">#{saved.id}</span>}
          <span className="ml-auto text-xs" data-testid="input-set-state" data-state={state} title={blocked?.why}>
            {state === "error" ? "Not saved"
              : creating ? "Not saved yet"
              : state === "saving" ? "Saving…"
              : missing.length ? `Saved · still needed: ${missing.map((f) => f.label).join(", ")}`
              : blank.length ? `Saved · still empty: ${blank.join(", ")}`
              : "Saved"}
          </span>
          <Button variant="ghost" className="h-7 w-7 px-0 text-slate-500" type="button" data-testid="input-set-close" aria-label="Close" title="Close (Escape)" onClick={onClose}>
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <ErrorBox error={error} testid="input-set-error" />
          <label className="mb-3 block min-w-0">
            <span className="label">Name</span>
            <Input data-testid="input-set-name" autoFocus placeholder="Ana · 2026 review" value={name} onChange={(e) => { setName(e.target.value); }} />
            <span className="mt-1 block text-xs text-slate-500">What this set is for. Left empty, it is named after the workflow and today.</span>
          </label>
          <label className="mb-3 block min-w-0">
            <span className="label">Workflow</span>
            <Select className="w-full" data-testid="input-set-workflow" value={workflow} disabled={!creating}
              onChange={(e) => { setWorkflow(e.target.value); }}>
              {workflows.map((w) => <option key={w.name} value={w.name}>{w.name}</option>)}
            </Select>
            {!creating && <span className="mt-1 block text-xs text-slate-500">It belongs to the workflow it was prepared for.</span>}
          </label>
          {saved?.workflow_archived && (
            <p className="mb-2 text-xs text-amber-800" data-testid="input-set-archived">Its workflow is archived, so this set cannot run. Unarchive the workflow in the designer.</p>
          )}
          <div className="mb-1 flex flex-wrap items-baseline gap-2">
            <span className="label mb-0">Inputs<Help id="new-run-inputs" /></span>
            {fields.length > 0 && (
              <span className="text-xs text-slate-500" data-testid="input-set-inputs-count">
                {fields.length} {fields.length === 1 ? "field" : "fields"}, empty until you fill them in
              </span>
            )}
            <Button variant="link" size="sm" className="h-auto px-0 text-2xs" type="button" data-testid="input-set-inputs-shape"
              title="Empty every value: a field left empty keeps the workflow's own value when the run starts" onClick={() => setText("{}")}>Clear the values</Button>
          </div>
          <InputFormWithJson fields={fields} text={text} setText={setText} stem="new-run-inputs" />
        </div>
        {/*
          * **One action, and which one depends on what this panel is.** A new set is a form that has not been stored, so its
          * action is Save; an existing set is already a row, so its action is Start run and its edits save themselves.
          * Asked 2026-11-25: *"add the explict Save data set button in the panel if it's a new form, otherwise it should be
          * `Start run` if it opened by clicking the item on the data set listing"*.
          */}
        <div className="flex shrink-0 items-center gap-2 border-t border-slate-200 px-4 py-2.5">
          {creating ? (
            <AsyncButton data-testid="input-set-save" variant="default" busy={state === "saving"} disabled={!parsed}
              title={parsed ? undefined : "The values are not a JSON object; fix them in the JSON view"}
              onClick={create}>Save data set</AsyncButton>
          ) : (
            <AsyncButton data-testid="input-set-start" variant="default" busy={state === "saving"} disabled={!parsed || cannotStart || !!blocked}
              title={blocked?.why ?? (missing.length ? `Still needed: ${missing.map((f) => f.label).join(", ")}` : blank.length ? `Still empty: ${blank.join(", ")}` : undefined)}
              onClick={start}>Start run</AsyncButton>
          )}
          <span className="text-xs text-slate-500" data-testid="input-set-hint">
            {creating ? "Not saved yet — nothing is stored until you save it" : blocked ? blocked.why : "Every change is saved as you make it"}
          </span>
        </div>
      </aside>
    </>
  );
}
