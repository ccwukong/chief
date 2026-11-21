import { useCallback, useEffect, useState } from "react";
import { api, get, getPage } from "../api";
import { AsyncButton, ErrorBox, Field, JsonField, Modal, Pager, useDraft } from "../ui";
import { usePolling } from "../polling";

/**
 * Schedules: a workflow started by a cron expression, by the scheduler inside `chief serve`. This page
 * is the whole of it without a terminal (task 15.1); `chief schedule` stays for scripts.
 *
 * The expression in words and the next firing come from the server (`GET /api/schedules`), so the
 * engine keeps the only cron parser and the page cannot disagree with it about an expression.
 */
export function Schedules() {
  const [rows, setRows] = useState<any[] | null>(null);
  const [total, setTotal] = useState(0);
  const [perPage, setPerPage] = useDraft("schedules:per-page", 25);
  const [page, setPage] = useState(1);
  const [workflows, setWorkflows] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Typed text is a draft: a refresh never loses it (AGENTS.md).
  const [workflow, setWorkflow] = useDraft("schedule:new:workflow", "");
  const [cron, setCron] = useDraft("schedule:new:cron", "");
  const [inputs, setInputs, clearInputs] = useDraft<unknown>("schedule:new:inputs", undefined);
  const [formError, setFormError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<any | null>(null);

  useEffect(() => {
    get("/api/workflows").then((w) => {
      setWorkflows(w);
      setWorkflow((cur) => (cur && w.some((x: any) => x.name === cur) ? cur : w[0]?.name || ""));
    }).catch(() => {});
  }, []);

  // Last and next firing change while the page is open, as runs start, so the list keeps asking.
  const load = useCallback(() => getPage("/api/schedules", page, perPage).then(({ items, total }) => {
    // A page that emptied (a schedule removed) moves back to the last page that has one.
    const last = Math.max(1, Math.ceil(total / perPage));
    if (page > last) return setPage(last);
    setRows(items); setTotal(total);
  }).catch((e) => setError(e.message)), [page, perPage]);
  usePolling(load, 5000, [load]);

  const add = async () => {
    setFormError(null);
    try {
      await api("POST", "/api/schedules", { workflow, cron, inputs: inputs ?? {} });
      setCron("");
      clearInputs();
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
    <div className="page-width p-4 md:p-6">
      <h1 className="mb-1 text-xl font-semibold">Schedules</h1>
      <p className="mb-4 text-sm text-slate-600">
        A schedule starts a workflow at the times a cron expression names. Schedules fire while chief is running: the
        desktop app keeps running after you close its window, until you quit it.
      </p>

      <div className="card mb-4">
        <h2 className="mb-3 text-sm font-semibold text-slate-700">Add a schedule</h2>
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-[12rem] flex-1">
            <Field label="Workflow">
              <select data-testid="schedule-workflow" className="input" value={workflow} onChange={(e) => setWorkflow(e.target.value)}>
                {workflows.length === 0 && <option value="">No workflows yet</option>}
                {workflows.map((w) => <option key={w.name} value={w.name}>{w.name}</option>)}
              </select>
            </Field>
          </div>
          <div className="min-w-[14rem] flex-1">
            <Field label="When" help="schedule-cron" hint="Five fields: minute hour day month weekday, local time.">
              <input data-testid="schedule-cron" className="input mono" placeholder="0 9 * * 1-5" value={cron}
                onChange={(e) => { setCron(e.target.value); setFormError(null); }} />
            </Field>
          </div>
          <div className="min-w-[14rem] flex-[2]">
            <Field label="Inputs" hint="Optional JSON, handed to the run as its inputs.">
              <JsonField testid="schedule-inputs" rows={2} value={inputs} onChange={setInputs} placeholder='{ "day": "today" }' />
            </Field>
          </div>
          <AsyncButton data-testid="schedule-add" className="btn btn-primary mt-6" disabled={!workflow || !cron.trim()} onClick={add}>Add schedule</AsyncButton>
        </div>
        <ErrorBox error={formError} testid="schedule-error" />
      </div>

      <ErrorBox error={error} />
      <div className="overflow-x-auto rounded border border-slate-200 bg-surface">
        <table className="w-full min-w-[720px] border-collapse text-sm" data-testid="schedules-table">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="px-3 py-2">Workflow</th><th className="px-3 py-2">When</th><th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Last run</th><th className="px-3 py-2">Next run</th><th className="px-3 py-2">Inputs</th><th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows === null && <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-500">Loading…</td></tr>}
            {rows?.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-500" data-testid="schedules-empty">
                No schedules yet. Add one above: a workflow and when it should run.
              </td></tr>
            )}
            {rows?.map((r) => (
              <tr key={r.id} data-testid={`schedule-row-${r.id}`} data-enabled={r.enabled} className="border-t border-slate-100 align-top">
                <td className="px-3 py-2 font-medium">{r.workflow_name}</td>
                <td className="px-3 py-2">
                  <div data-testid={`schedule-description-${r.id}`}>{r.description}</div>
                  <code className="mono text-xs text-slate-500" data-testid={`schedule-cron-${r.id}`}>{r.cron}</code>
                </td>
                <td className="px-3 py-2">
                  <span data-testid={`schedule-state-${r.id}`} data-status={r.enabled ? "enabled" : "disabled"}
                    className={`inline-block rounded px-2 py-0.5 text-xs font-semibold ${r.enabled ? "bg-green-100 text-green-800" : "bg-slate-200 text-slate-600"}`}>
                    {r.enabled ? "enabled" : "disabled"}
                  </span>
                </td>
                <td className="mono px-3 py-2 text-xs text-slate-600" data-testid={`schedule-last-${r.id}`}>{r.last_run_at ?? "never"}</td>
                <td className="mono px-3 py-2 text-xs text-slate-600" data-testid={`schedule-next-${r.id}`}>{r.next_run_at ?? (r.enabled ? "never" : "—")}</td>
                <td className="px-3 py-2 text-xs">
                  <code className="mono [overflow-wrap:anywhere]" data-testid={`schedule-inputs-${r.id}`}>{Object.keys(r.inputs ?? {}).length ? JSON.stringify(r.inputs) : "—"}</code>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  <AsyncButton data-testid={`schedule-toggle-${r.id}`} className="btn mr-2" onClick={() => toggle(r)}
                    title={r.enabled ? "Stop it firing. The schedule and its settings stay" : "Let it fire again"}>
                    {r.enabled ? "Disable" : "Enable"}
                  </AsyncButton>
                  <button data-testid={`schedule-remove-${r.id}`} className="btn btn-danger" onClick={() => setRemoving(r)}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager testid="schedule-pager" page={page} perPage={perPage} total={total}
        onPage={setPage} onPerPage={(n) => { setPerPage(n); setPage(1); }} />

      {removing && (
        <Modal title={`Remove the schedule for “${removing.workflow_name}”?`} onClose={() => setRemoving(null)} testid="confirm-schedule-remove">
          <p className="mb-2 text-sm">It will stop firing at <code className="mono">{removing.cron}</code> ({removing.description}). Runs it already started are kept, and removing it cannot be undone.</p>
          <div className="mt-4 flex justify-end gap-2">
            <button data-testid="confirm-schedule-remove-keep" className="btn" onClick={() => setRemoving(null)}>Keep</button>
            <AsyncButton data-testid="confirm-schedule-remove-yes" className="btn btn-danger" onClick={remove}>Remove schedule</AsyncButton>
          </div>
        </Modal>
      )}
    </div>
  );
}
