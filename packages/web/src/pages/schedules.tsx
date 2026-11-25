import { useCallback, useEffect, useRef, useState } from "react";
import { api, get, getPage } from "../api";
import { AsyncButton, ErrorBox, Field, Help, Modal, Pager, readDraft, TrashButton, useDraft, writeDraft } from "../ui";
import { InputFormWithJson, missingRequired, parseInputs, templateText, type InputField } from "../run-inputs";
import { usePolling } from "../polling";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { Card } from "../components/ui/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../components/ui/table";

/**
 * Schedules: a workflow started by a cron expression, by the scheduler inside `chief serve`. This page
 * is the whole of it without a terminal (task 15.1); `chief schedule` stays for scripts.
 *
 * The expression in words and the next firing come from the server (`GET /api/schedules`), so the
 * engine keeps the only cron parser and the page cannot disagree with it about an expression.
 */
export function Schedules() {
  const [workflows, setWorkflows] = useState<any[]>([]);
  const [rows, setRows] = useState<any[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  // The page size is a choice about the page itself, so it is kept like the other ones.
  const [perPage, setPerPage] = useDraft("schedules:per-page", 25);
  const [workflow, setWorkflow] = useDraft("schedule:new:workflow", "");
  const [cron, setCron] = useDraft("schedule:new:cron", "");
  /** The inputs typed for each workflow, so choosing another and coming back keeps each one's (15.121). */
  const [typed, setTyped] = useState<Record<string, string>>({});
  /** The fields the chosen workflow asks for. Without them an input is asked for by its path. */
  const [fields, setFields] = useState<InputField[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<any | null>(null);

  useEffect(() => {
    get("/api/workflows").then((w) => {
      setWorkflows(w);
      setWorkflow((cur) => (cur && w.some((x: any) => x.name === cur) ? cur : w[0]?.name || ""));
    }).catch(() => {});
  }, []);

  // The fields the chosen workflow asks for: the same list the run card builds its form from.
  useEffect(() => {
    if (!workflow) return setFields([]);
    let live = true;
    get(`/api/workflows/${encodeURIComponent(workflow)}`).then((w) => live && setFields(w.input_refs ?? [])).catch(() => live && setFields([]));
    return () => { live = false; };
  }, [workflow]);

  // Last and next firing change while the page is open, as runs start, so the list keeps asking.
  const load = useCallback(() => getPage("/api/schedules", page, perPage).then(({ items, total }) => {
    // A page that emptied (a schedule removed) moves back to the last page that has one.
    const last = Math.max(1, Math.ceil(total / perPage));
    if (page > last) return setPage(last);
    setRows(items); setTotal(total);
  }).catch((e) => setError(e.message)), [page, perPage]);
  usePolling(load, 5000, [load]);

  // The inputs of the schedule about to be added: one text per workflow, seeded from the workflow's shape.
  const draftKey = (name: string) => `schedule:new:inputs:${name}`;
  const inputsText = typed[workflow] ?? readDraft<string>(draftKey(workflow)) ?? templateText(fields);
  const setInputsText = (t: string) => { writeDraft(draftKey(workflow), t); setTyped((m) => ({ ...m, [workflow]: t })); };

  const add = async () => {
    setFormError(null);
    const parsed = parseInputs(inputsText) ?? {};
    if (inputsText.trim() && !parseInputs(inputsText)) return setFormError("The inputs are not valid JSON. Fix them in the JSON view.");
    const missing = missingRequired(fields, parsed);
    // Same rule as a run: a required field with no value would be refused at every tick, so it is refused now.
    if (missing.length) return setFormError(`Still needed: ${missing.map((f) => `${f.label} (inputs.${f.path})`).join(", ")}`);
    try {
      await api("POST", "/api/schedules", { workflow, cron, inputs: parsed });
      setCron("");
      // What was typed is cleared, so the next schedule of this workflow starts from its shape again.
      writeDraft(draftKey(workflow), "");
      setTyped((m) => { const next = { ...m }; delete next[workflow]; return next; });
      setPage(1);
      void load();
    } catch (e: any) {
      // The reason belongs beside the field that caused it: an invalid expression is the common one.
      setFormError(e.message);
    }
  };

  const toggle = async (row: any) => {
    setError(null);
    try {
      const next = await api("PATCH", `/api/schedules/${row.id}`, { enabled: !row.enabled });
      setRows((cur) => cur?.map((r) => (r.id === row.id ? next : r)) ?? cur);
    } catch (e: any) { setError(e.message); }
  };

  const remove = async () => {
    const row = removing!;
    await api("DELETE", `/api/schedules/${row.id}`);
    setRemoving(null);
    setRows((cur) => cur?.filter((r) => r.id !== row.id) ?? cur);
    setTotal((t) => Math.max(0, t - 1));
    void load();
  };

  return (
    <div className="page-width py-6" data-testid="page-column">
      <h1 className="mb-1 text-xl font-semibold">Schedules</h1>
      <p className="mb-2 text-sm text-slate-600">
        A schedule starts a workflow at the times a cron expression names. Schedules fire while chief is running: the
        desktop app keeps running after you close its window, until you quit it.
      </p>
      {/*
        * Said here, where a person is looking at the form they are about to fill in: chief bot can do all of it in a
        * sentence, and a new person would otherwise never guess that. "Add, change, pause, remove" is the whole set, and
        * "#3" is named because each row shows that number — a schedule can be quoted instead of described.
        */}
      <div data-testid="schedules-bot-hint" className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
        <span>You can also just ask:</span>
        <span className="italic">{"“run em-daily-operation every weekday at 10:00”"}</span>
        <span>— chief bot adds, changes, pauses and removes schedules, and each row's number ({<span className="mono">#3</span>}) is how you name the one you mean.</span>
        <Button variant="link" size="sm" className="h-auto px-0" data-testid="schedules-ask-bot" type="button"
          onClick={() => window.dispatchEvent(new CustomEvent("chief:open-assistant"))}>Ask chief bot</Button>
      </div>

      <Card className="mb-4">
        <h2 className="mb-3 text-sm font-semibold text-slate-700">Add a schedule</h2>
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-[12rem] flex-1">
            <Field label="Workflow">
              <Select data-testid="schedule-workflow"  value={workflow} onChange={(e) => setWorkflow(e.target.value)}>
                {workflows.length === 0 && <option value="">No workflows yet</option>}
                {workflows.map((w) => <option key={w.name} value={w.name}>{w.name}</option>)}
              </Select>
            </Field>
          </div>
          <div className="min-w-[14rem] flex-1">
            <Field label="When" help="schedule-cron" hint="Five fields: minute hour day month weekday, local time.">
              <Input className="mono" data-testid="schedule-cron"  placeholder="0 9 * * 1-5" value={cron}
                onChange={(e) => { setCron(e.target.value); setFormError(null); }} />
            </Field>
          </div>
          <AsyncButton data-testid="schedule-add" variant="default" className="mt-6" disabled={!workflow || !cron.trim()} onClick={add}>Add schedule</AsyncButton>
        </div>
        {/* The inputs are fields, not a JSON box (15.121), and the JSON stays one disclosure away: the same
            form the run card asks with, so a schedule and a run of the same workflow cannot ask differently. */}
        {(fields.length > 0 || inputsText.trim() !== "") && (
          <div className="mt-2 min-w-0 md:max-w-3xl" data-testid="schedule-inputs-block">
            <div className="mb-1 flex flex-wrap items-baseline gap-2">
              <span className="label mb-0">Inputs<Help id="new-run-inputs" /></span>
              <Button variant="link" size="sm" className="h-auto px-0 text-2xs" type="button" data-testid="schedule-inputs-shape"
                title="Put the values back to the workflow's own defaults" onClick={() => setInputsText(templateText(fields))}>Reset to the defaults</Button>
            </div>
            <InputFormWithJson fields={fields} text={inputsText} setText={setInputsText} stem="schedule-inputs" />
          </div>
        )}
        <ErrorBox error={formError} testid="schedule-error" />
      </Card>

      <ErrorBox error={error} />
      <div className="overflow-x-auto rounded border border-slate-200 bg-surface">
        <Table className="w-full min-w-[720px] border-collapse text-sm" data-testid="schedules-table">
          <TableHeader className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <TableRow>
              <TableHead className="px-3 py-2">Workflow</TableHead><TableHead className="px-3 py-2">When</TableHead><TableHead className="px-3 py-2">Status</TableHead>
              <TableHead className="px-3 py-2">Last run</TableHead><TableHead className="px-3 py-2">Next run</TableHead><TableHead className="px-3 py-2">Inputs</TableHead><TableHead className="px-3 py-2" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows === null && <TableRow><TableCell colSpan={7} className="px-3 py-6 text-center text-slate-500">Loading…</TableCell></TableRow>}
            {rows?.length === 0 && (
              <TableRow><TableCell colSpan={7} className="px-3 py-6 text-center text-slate-500" data-testid="schedules-empty">
                No schedules yet. Add one above: a workflow and when it should run.
              </TableCell></TableRow>
            )}
            {rows?.map((r) => (
              <ScheduleRow key={r.id} r={r} onSaved={(next) => setRows((cur) => cur?.map((x) => (x.id === next.id ? next : x)) ?? cur)}
                onToggle={() => void toggle(r)} onRemove={() => setRemoving(r)} />
            ))}
          </TableBody>
        </Table>
      </div>
      <Pager testid="schedule-pager" page={page} perPage={perPage} total={total}
        onPage={setPage} onPerPage={(n) => { setPerPage(n); setPage(1); }} />

      {removing && (
        <Modal title={`Remove the schedule for “${removing.workflow_name}”?`} onClose={() => setRemoving(null)} testid="confirm-schedule-remove">
          <p className="mb-2 text-sm">It will stop firing at <code className="mono">{removing.cron}</code> ({removing.description}). Runs it already started are kept, and removing it cannot be undone.</p>
          <p className="mb-3 text-sm text-slate-600">To bring it back, add a schedule with the same expression, or ask chief bot to: “schedule {removing.workflow_name} at {removing.cron}”.</p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" data-testid="confirm-schedule-remove-keep"  onClick={() => setRemoving(null)}>Keep</Button>
            <AsyncButton data-testid="confirm-schedule-remove-yes" variant="destructive" onClick={remove}>Remove schedule</AsyncButton>
          </div>
        </Modal>
      )}
    </div>
  );
}

/**
 * One schedule, with its `when` and its `inputs` editable in place (asked 2026-11-22: *"it doesn't have any edit
 * feature for me to edit the schedule's WHEN and INPUT"*). There is no Save button, as everywhere in chief: the value is
 * written when the field is left, and Enter does the same; Escape puts back what the server has. A field the server
 * refuses stays as it was typed, with the reason under it — an invalid expression is the common one, and throwing the
 * typing away would make the person write it again.
 *
 * The row also shows the schedule's **id** (`#3`). That is what the person quotes back to chief bot — "move #3 to 18:00"
 * — and it was in the bot's own prompt long before it was on the page.
 */
function ScheduleRow({ r, onSaved, onToggle, onRemove }: {
  r: any; onSaved: (next: any) => void; onToggle: () => void; onRemove: () => void;
}) {
  const [cron, setCron] = useState(String(r.cron));
  const [problem, setProblem] = useState<{ field: "cron" | "inputs"; message: string } | null>(null);
  const [saving, setSaving] = useState<"cron" | "inputs" | null>(null);
  /**
   * Set by Escape before the field is blurred, so the blur that follows does not save what Escape just abandoned. A ref,
   * because the blur fires before React can re-render with the state reset (found by E15.105-1: Escape saved the value it
   * was meant to throw away).
   */
  const abandoning = useRef(false);

  // ── the inputs, edited as the same form the run card uses (15.121) ─────────
  // The cell is a table cell, so the form opens **in the row** on request rather than sitting there for
  // every schedule on the page. Its fields save themselves as they change, like every other field in
  // chief: there is no Save button, only a way back to the summary.
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState<InputField[]>([]);
  const [text, setText] = useState(() => JSON.stringify(r.inputs ?? {}, null, 2));
  /** Set once the person has touched this row's inputs: a poll must not rewrite them under the caret. */
  const dirty = useRef(false);
  useEffect(() => { setCron(String(r.cron)); }, [r.cron]);
  useEffect(() => { if (!dirty.current) setText(JSON.stringify(r.inputs ?? {}, null, 2)); }, [r.inputs]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    get(`/api/workflows/${encodeURIComponent(r.workflow_name)}`).then((w) => live && setFields(w.input_refs ?? [])).catch(() => live && setFields([]));
    return () => { live = false; };
  }, [open, r.workflow_name]);

  const save = async (field: "cron" | "inputs", value: unknown) => {
    setSaving(field);
    setProblem(null);
    try {
      const next = await api("PATCH", `/api/schedules/${r.id}`, { [field]: value });
      onSaved(next);
    } catch (e: any) {
      // What is typed stays; the reason goes under the field it belongs to.
      setProblem({ field, message: e.message });
      setCron(String(r.cron));
      setText(JSON.stringify(r.inputs ?? {}, null, 2));
      dirty.current = false;
    } finally {
      setSaving(null);
    }
  };

  const commitCron = () => {
    if (abandoning.current) { abandoning.current = false; setCron(String(r.cron)); return; }
    const value = cron.trim().split(/\s+/).join(" ");
    if (value === r.cron || !value) { setCron(String(r.cron)); return; }
    // Written with the same check a new schedule gets: the server refuses an expression that cannot work, and says why.
    if (!/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(value)) { setProblem({ field: "cron", message: "A cron expression has five fields: minute hour day month weekday." }); setCron(String(r.cron)); return; }
    void save("cron", value);
  };

  /** An edit to a field: the text follows it, and the schedule is written a moment later (a positive-delay debounce). */
  const editInputs = (next: string) => {
    dirty.current = true;
    setText(next);
    setProblem(null);
  };
  useEffect(() => {
    if (!dirty.current) return;
    const t = setTimeout(() => {
      const parsed = parseInputs(text);
      if (!parsed) return;   // the JSON view says why; nothing is written that the server cannot read
      if (JSON.stringify(parsed) === JSON.stringify(r.inputs ?? {})) { dirty.current = false; return; }
      void save("inputs", parsed).then(() => { dirty.current = false; });
    }, 500);
    return () => clearTimeout(t);
  }, [text]);

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
    if (e.key === "Escape") { abandoning.current = true; setProblem(null); setCron(String(r.cron)); setText(JSON.stringify(r.inputs ?? {}, null, 2)); dirty.current = false; e.currentTarget.blur(); }
  };

  const summary = Object.keys(r.inputs ?? {}).length
    ? Object.entries(r.inputs ?? {}).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join(" · ")
    : "no inputs";

  return (
    <TableRow data-testid={`schedule-row-${r.id}`} data-enabled={r.enabled} data-schedule-id={r.id} className="border-t border-slate-100 align-top">
      <TableCell className="px-3 py-2">
        <div className="font-medium">{r.workflow_name}</div>
        {/* The id, so a schedule can be named to chief bot instead of described: "pause #3". */}
        <div className="mono text-2xs text-slate-400" data-testid={`schedule-id-${r.id}`}
          title={'This schedule\'s number: quote it to chief bot ("move #3 to 18:00") and it knows which one you mean.'}>#{r.id}</div>
      </TableCell>
      <TableCell className="px-3 py-2">
        {/* Editable in place: the expression is the one thing about a schedule that is genuinely typed, and it was the one
            thing that could only be changed by removing the schedule and adding it again. */}
        <Input className="mono h-8 w-40 px-2 text-xs" data-testid={`schedule-cron-${r.id}`} value={cron} disabled={saving === "cron"}
          aria-label={`When, for the schedule of ${r.workflow_name}`} aria-invalid={problem?.field === "cron" ? true : undefined}
          title="Editable: it saves when you leave the field. Enter saves, Escape puts back what is stored."
          onChange={(e) => { setCron(e.target.value); setProblem(null); }} onBlur={commitCron} onKeyDown={onKey} />
        <div className="mt-1 text-xs text-slate-500" data-testid={`schedule-description-${r.id}`}>{saving === "cron" ? "Saving…" : r.description}</div>
        {problem?.field === "cron" && <div className="mt-1 text-xs text-destructive" data-testid={`schedule-cron-error-${r.id}`}>{problem.message}</div>}
        {/* A schedule whose workflow has been archived keeps its own on/off, and stops firing. Saying so here is
            the difference between "quiet because I turned it off" and "quiet because someone archived it" (task 15.2). */}
        {!!r.workflow_archived && (
          <div data-testid={`schedule-archived-${r.id}`} className="mt-1 inline-block rounded bg-slate-200 px-2 py-0.5 text-xs text-slate-700" title="Its workflow is archived, so it cannot fire. Unarchive the workflow in the designer to let it fire again.">
            workflow archived · not firing
          </div>
        )}
      </TableCell>
      <TableCell className="px-3 py-2">
        <span data-testid={`schedule-state-${r.id}`} data-status={r.enabled ? "enabled" : "disabled"}
          className={`inline-block rounded px-2 py-0.5 text-xs font-semibold ${r.enabled ? "bg-green-100 text-green-800" : "bg-slate-200 text-slate-600"}`}>
          {r.enabled ? "enabled" : "disabled"}
        </span>
      </TableCell>
      <TableCell className="mono px-3 py-2 text-xs text-slate-600" data-testid={`schedule-last-${r.id}`}>{r.last_run_at ?? "never"}</TableCell>
      {/* A dash, not "never": an archived workflow's schedule is enabled and has a cron that would fire — it is the
            workflow that is out of service, and the badge in the previous cell says so (task 15.2). */}
      <TableCell className="mono px-3 py-2 text-xs text-slate-600" data-testid={`schedule-next-${r.id}`}>{r.next_run_at ?? (r.enabled && !r.workflow_archived ? "never" : "—")}</TableCell>
      <TableCell className="px-3 py-2 text-xs">
        {/* The fields, opened in the row rather than a JSON box in the cell (15.121). The summary is what the
            row is for — reading — and the form is one click from it, saving each field as it changes. */}
        {open ? (
          <div className="min-w-[15rem] max-w-[22rem]" data-testid={`schedule-inputs-editor-${r.id}`}>
            <InputFormWithJson fields={fields} text={text} setText={editInputs} stem={`schedule-inputs-${r.id}`} />
            <div className="mt-1 flex items-center gap-2">
              <Button variant="link" size="sm" className="h-auto px-0 text-2xs" type="button" data-testid={`schedule-inputs-done-${r.id}`} onClick={() => setOpen(false)}>Done</Button>
              <span className="text-2xs text-slate-500" data-testid={`schedule-inputs-state-${r.id}`}>{saving === "inputs" ? "Saving…" : problem?.field === "inputs" ? "Not saved" : "Saved"}</span>
            </div>
          </div>
        ) : (
          <Button variant="link" type="button" data-testid={`schedule-inputs-summary-${r.id}`} title="Edit the inputs this schedule hands to its runs"
            className="block h-auto w-full max-w-[22rem] justify-start truncate px-0 py-0 text-left font-normal text-slate-700 hover:no-underline"
            onClick={() => setOpen(true)}>{summary}</Button>
        )}
        {problem?.field === "inputs" && <div className="mt-1 text-2xs text-destructive" data-testid={`schedule-inputs-error-${r.id}`}>{problem.message}</div>}
      </TableCell>
      <TableCell className="whitespace-nowrap px-3 py-2">
        {/* Glyphs, not two filled buttons at the end of every row (asked 2026-11-22: *"can we have icon buttons instead?"*).
            A table is for reading, and the solid red **Remove** was the loudest thing in it on every row — the same
            complaint as the run list's bin (15.94–15.96), answered the same way: a drawn glyph in a 28 px ghost
            button, slate at rest, `--destructive` on hover for the removal, and the weight in the confirmation,
            which already says what goes and that it cannot be undone. Pause and play rather than a power symbol:
            the question a row answers is "is it firing", and the two states are opposites, not on and off.

            A glyph has no text, so the whole meaning is in `aria-label` and `title` — and the toggle's changes with
            the state, because "Disable" on a disabled schedule is worse than no label at all. */}
        <div className="flex items-center justify-end gap-1">
          <AsyncButton data-testid={`schedule-toggle-${r.id}`} variant="ghost" size="icon-sm"
            className="text-slate-600" onClick={onToggle}
            aria-label={r.enabled ? `Disable the schedule for ${r.workflow_name}` : `Enable the schedule for ${r.workflow_name}`}
            title={r.enabled ? "Disable: stop it firing. The schedule and its settings stay" : "Enable: let it fire again"}>
            {r.enabled
              ? <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M6 3.5v9M10 3.5v9" /></svg>
              : <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4" fill="currentColor" stroke="none"><path d="M4.5 3.2a.6.6 0 0 1 .92-.5l7.1 4.3a.6.6 0 0 1 0 1l-7.1 4.3a.6.6 0 0 1-.92-.5z" /></svg>}
          </AsyncButton>
          <TrashButton testid={`schedule-remove-${r.id}`} size="sm" label={`Remove the schedule for ${r.workflow_name}`}
            title="Remove: it stops firing for good. Runs it already started are kept" onClick={onRemove} />
        </div>
      </TableCell>
    </TableRow>
  );
}
