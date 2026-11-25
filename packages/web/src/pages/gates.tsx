import { useState } from "react";
import { api, pretty } from "../api";
import { AsyncButton, ErrorBox, removeDrafts, useDraft } from "../ui";
import { JsonCode } from "../json-editor";
import { Input } from "../components/ui/input";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { Checkbox } from "../components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "../components/ui/radio-group";

const REASON: Record<string, string> = { needs_input: "The agent needs your input", irreversible: "Confirm an action that cannot be undone", budget: "Budget reached", node: "" };

/** One waiting gate, answered in place. */
export function GateCard({ gate, onAnswered, onChangeStep }: { gate: any; onAnswered: () => void; onChangeStep?: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const answer = async (a: unknown) => {
    setBusy(true); setError(null);
    try { await api("POST", `/api/gates/${gate.id}/answer`, { answer: a }); removeDrafts(`gate:${gate.id}:`); onAnswered(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };
  return (
    <div data-testid={`gate-${gate.id}`} data-kind={gate.kind} data-reason={gate.reason} className="mb-4 rounded border-2 border-amber-300 bg-amber-50 p-4 last:mb-0">
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-800">
        {gate.kind} gate{gate.node_id ? ` · ${gate.node_id}` : ""}{REASON[gate.reason] ? ` · ${REASON[gate.reason]}` : ""}
      </div>
      <div data-testid="gate-message" className="mb-3 whitespace-pre-wrap text-sm font-medium">{gate.payload?.message}</div>
      <ErrorBox error={error} testid="gate-error" />
      {gate.kind === "ask" && <AskGate gate={gate} busy={busy} answer={answer} />}
      {gate.kind === "select" && <SelectGate gate={gate} busy={busy} answer={answer} />}
      {gate.kind === "approve" && <ApproveGate gate={gate} busy={busy} answer={answer} />}
      {gate.kind === "input" && <InputGate gate={gate} busy={busy} answer={answer} />}
      {onChangeStep && (
        <p data-testid="gate-change-step" className="mt-3 text-xs text-slate-600">
          Not a question you can answer? An answer goes into the step's current session, with its current prompt.{" "}
          <Button variant="link" className="h-auto px-0 underline" type="button" onClick={onChangeStep}>Change this step instead</Button>: a new prompt withdraws the question and starts the step again.
        </p>
      )}
    </div>
  );
}

type Props = { gate: any; busy: boolean; answer: (a: unknown) => Promise<void> };

/**
 * A form that was worked out by an agent from the gate's instruction. Nothing here knows what
 * the questions are about: it renders whatever fields came back and returns the answers.
 */
function AskGate({ gate, busy, answer }: Props) {
  const fields: any[] = gate.payload.fields ?? [];
  const initial: Record<string, any> = {};
  for (const f of fields) initial[f.id] = f.default ?? (f.type === "choose-many" ? [] : f.type === "choose-one" ? null : f.type === "yes-no" ? false : "");
  const [values, setValues] = useDraft<Record<string, any>>(`gate:${gate.id}:values`, initial);
  const set = (id: string, v: any) => setValues((cur) => ({ ...cur, [id]: v }));
  const missing = fields.filter((f) => f.required && (values[f.id] == null || values[f.id] === "" || (Array.isArray(values[f.id]) && !values[f.id].length)));
  return (
    <>
      {gate.payload.description && <p data-testid="gate-description" className="mb-3 whitespace-pre-wrap text-sm text-slate-700">{gate.payload.description}</p>}
      {fields.map((f) => (
        <div key={f.id} data-testid={`gate-field-${f.id}`} data-type={f.type} className="mb-3">
          <div className="mb-1 text-sm font-semibold">{f.label}{f.required && <span className="ml-1 text-red-700" title="needs an answer">*</span>}</div>
          {f.type === "choose-many" && (
            <ul className="space-y-1">
              {f.options.map((o: any, i: number) => (
                <li key={i}>
                  <label className="flex items-start gap-2 rounded bg-surface px-2 py-1.5 text-sm">
                    <Checkbox className="mt-0.5" data-testid={`gate-field-${f.id}-${i}`} checked={(values[f.id] ?? []).includes(i)}
                      onCheckedChange={(v) => set(f.id, v ? [...(values[f.id] ?? []), i].sort((a: number, b: number) => a - b) : (values[f.id] ?? []).filter((x: number) => x !== i))} />
                    <span><span className="font-medium">{o.label}</span>{o.detail && <span className="block text-xs text-slate-500">{o.detail}</span>}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {f.type === "choose-one" && (
            <RadioGroup value={values[f.id] == null ? undefined : String(values[f.id])} onValueChange={(v) => set(f.id, Number(v))} aria-label={f.label}>
              {f.options.map((o: any, i: number) => (
                <label key={i} className="flex items-start gap-2 rounded bg-surface px-2 py-1.5 text-sm">
                  <RadioGroupItem value={String(i)} className="mt-0.5" data-testid={`gate-field-${f.id}-${i}`} />
                  <span><span className="font-medium">{o.label}</span>{o.detail && <span className="block text-xs text-slate-500">{o.detail}</span>}</span>
                </label>
              ))}
            </RadioGroup>
          )}
          {f.type === "text" && <Input data-testid={`gate-field-${f.id}-input`}  value={values[f.id] ?? ""} onChange={(e) => set(f.id, e.target.value)} />}
          {f.type === "long-text" && <Textarea data-testid={`gate-field-${f.id}-input`}  rows={4} value={values[f.id] ?? ""} onChange={(e) => set(f.id, e.target.value)} />}
          {f.type === "yes-no" && (
            <label className="flex items-center gap-2 text-sm"><Checkbox data-testid={`gate-field-${f.id}-input`} checked={!!values[f.id]} onCheckedChange={(v) => set(f.id, !!v)} /> Yes</label>
          )}
        </div>
      ))}
      <AsyncButton data-testid="gate-ask-submit" variant="default" disabled={busy || missing.length > 0} title={missing.length ? `Still needed: ${missing.map((f) => f.label).join(", ")}` : undefined}
        onClick={() => answer({ values })}>{gate.payload.submit_label ?? "Submit"}</AsyncButton>
    </>
  );
}

function SelectGate({ gate, busy, answer }: Props) {
  const items: any[] = gate.payload.items ?? [];
  const modes: string[] = gate.payload.modes ?? [];
  const [picked, setPicked] = useDraft<number[]>(`gate:${gate.id}:picked`, []);
  const [cutoff, setCutoff] = useDraft(`gate:${gate.id}:cutoff`, "");
  const toggle = (i: number) => setPicked((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i]));
  return (
    <>
      <ul className="mb-3 space-y-1">
        {items.map((it, i) => (
          <li key={i}>
            <label className="flex items-start gap-2 rounded bg-surface px-2 py-1.5 text-sm">
              <Checkbox data-testid={`gate-item-${i}`} checked={picked.includes(i)} onCheckedChange={() => toggle(i)} className="mt-0.5" />
              <span>
                {it?.priority && <span className="mr-2 rounded bg-slate-200 px-1.5 text-xs font-semibold text-slate-800">{it.priority}</span>}
                <span className="font-medium">{it?.title ?? pretty(it)}</span>
                {it?.kind && <span className="ml-2 text-xs text-slate-500">{it.kind}</span>}
                {it?.url && <a className="ml-2 text-xs text-primary underline" href={it.url} target="_blank" rel="noreferrer">link</a>}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        {modes.includes("one-by-one") && (
          <AsyncButton data-testid="gate-select-submit" variant="default" disabled={busy} onClick={() => answer({ mode: "one-by-one", selected: picked })}>
            Run selected ({picked.length}), one by one
          </AsyncButton>
        )}
        {modes.includes("all") && <AsyncButton data-testid="gate-mode-all" variant="outline" disabled={busy} onClick={() => answer({ mode: "all" })}>Run all in parallel</AsyncButton>}
        {modes.includes("by-priority") && (
          <span className="flex items-center gap-1">
            <Input className="w-24" data-testid="gate-priority-cutoff"  placeholder="up to P1" value={cutoff} onChange={(e) => setCutoff(e.target.value)} />
            <AsyncButton data-testid="gate-mode-by-priority" variant="outline" disabled={busy} onClick={() => answer({ mode: "by-priority", ...(cutoff.trim() ? { priority: cutoff.trim() } : {}) })}>Run by priority</AsyncButton>
          </span>
        )}
      </div>
    </>
  );
}

function ApproveGate({ gate, busy, answer }: Props) {
  const original = gate.payload?.value;
  const hasValue = original !== undefined && original !== null;
  const originalText = hasValue ? pretty(original) : "";
  const [value, setValue] = useDraft(`gate:${gate.id}:value`, originalText);
  const [text, setText] = useDraft(`gate:${gate.id}:text`, "");
  const approve = () => {
    const a: any = { decision: "approve" };
    if (hasValue && value !== originalText) {
      // Keep the type of the original: an edited object is sent as an object when it still parses.
      if (typeof original === "string") a.value = value;
      else { try { a.value = JSON.parse(value); } catch { a.value = value; } }
    }
    if (text.trim()) a.text = text.trim();
    return answer(a);
  };
  return (
    <>
      {hasValue && (
        <label className="mb-2 block">
          <span className="label">{gate.reason === "irreversible" ? "What will run" : "Proposed (edit before approving if needed)"}</span>
          <Textarea data-testid="gate-value" className="mono text-xs" rows={Math.min(14, Math.max(3, originalText.split("\n").length + 1))} value={value}
            readOnly={gate.reason === "irreversible"} onChange={(e) => setValue(e.target.value)} />
        </label>
      )}
      {gate.reason !== "budget" && (
        <Input className="mb-3" data-testid="gate-text"  placeholder="Optional note to go with your answer" value={text} onChange={(e) => setText(e.target.value)} />
      )}
      <div className="flex gap-2">
        <AsyncButton data-testid="gate-approve" variant="default" disabled={busy} onClick={approve}>{gate.reason === "budget" ? "Continue (raise the limit)" : "Approve"}</AsyncButton>
        <AsyncButton data-testid="gate-reject" variant="destructive" disabled={busy} onClick={() => answer({ decision: "reject", ...(text.trim() ? { text: text.trim() } : {}) })}>{gate.reason === "budget" ? "Stop the run" : "Reject"}</AsyncButton>
      </div>
    </>
  );
}

function InputGate({ gate, busy, answer }: Props) {
  const options: string[] = gate.payload.options ?? [];
  const [text, setText] = useDraft(`gate:${gate.id}:text`, "");
  return (
    <>
      {gate.payload.summary != null && (typeof gate.payload.summary === "string"
        ? <pre data-testid="gate-summary" className="mono mb-3 max-h-64 overflow-auto rounded bg-surface p-2 text-xs">{pretty(gate.payload.summary)}</pre>
        : <div className="mb-3"><JsonCode testid="gate-summary" maxRows={16} value={pretty(gate.payload.summary)} /></div>)}
      <Textarea data-testid="gate-text" className="mb-3" rows={3} placeholder="Your feedback" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="flex flex-wrap gap-2">
        {options.map((o) => <AsyncButton key={o} data-testid={`gate-option-${o}`} variant="default" disabled={busy} onClick={() => answer({ text, option: o })}>{o}</AsyncButton>)}
        {options.length === 0 && <AsyncButton data-testid="gate-submit" variant="default" disabled={busy} onClick={() => answer({ text })}>Submit</AsyncButton>}
      </div>
    </>
  );
}
