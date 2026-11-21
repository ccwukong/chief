import { useEffect, useState } from "react";
import { api, get, usd } from "../api";
import { SHOW_COST } from "../features";
import { AsyncButton, Field, Help, JsonField, useDraft } from "../ui";
import type { NodeDef } from "./model";

/**
 * Where each agent CLI adds its MCP servers. A step with no servers gets the line for *its own* CLI:
 * the general text used to name Claude Code's `claude mcp` for every CLI (task 15.12).
 */
const ADD_SERVERS: Record<string, string> = {
  "claude-code": "claude mcp",
  codex: "the [mcp_servers.*] tables in ~/.codex/config.toml",
  cursor: "~/.cursor/mcp.json",
  antigravity: "~/.gemini/config/mcp_config.json",
  opencode: "its own configuration (opencode debug config shows what it resolved)",
  hermes: "the mcp_servers: key in ~/.hermes/config.yaml (hermes mcp)",
};
export const addServersHint = (adapter: string) => ADD_SERVERS[adapter] ?? "the CLI's own configuration";

type Change = (patch: Record<string, any>) => void;

/** What "Refine" needs to know about a prompt field: what the text is for, which agent CLI rewrites it, and a key for keeping the author's own text. */
interface RefineSpec { kind: "agent" | "gate" | "compensate"; adapter: string; model?: string; id: string }

function Txt({ label, value, onChange, testid, area, hint, placeholder, help, refine }: { label: string; value: any; onChange: (v: string) => void; testid: string; area?: number; hint?: string; placeholder?: string; help?: string; refine?: RefineSpec }) {
  return (
    <>
      <Field label={label} hint={refine ? undefined : hint} help={help}>
        {area
          ? <textarea data-testid={testid} rows={area} className="input mono text-xs" placeholder={placeholder} value={value ?? ""} onChange={(e) => onChange(e.target.value)} />
          : <input data-testid={testid} className="input" placeholder={placeholder} value={value ?? ""} onChange={(e) => onChange(e.target.value)} />}
      </Field>
      {refine && <Refine key={refine.id} spec={refine} testid={testid} value={value ?? ""} onChange={onChange} hint={hint} />}
    </>
  );
}

/**
 * "Refine": the node's agent CLI rewrites what was typed so that it is clear and complete. The
 * rewritten text replaces the prompt at once; the author's own text is kept (as a draft, so a
 * refresh does not lose it) until they go back to it or keep the new one.
 */
function Refine({ spec, testid, value, onChange, hint }: { spec: RefineSpec; testid: string; value: string; onChange: (v: string) => void; hint?: string }) {
  const [mine, setMine, clearMine] = useDraft<{ text: string; refined: string; cost: number } | null>(`refine:${spec.id}:${testid}`, null);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setError(null);
    try {
      const r = await api("POST", "/api/prompts/refine", { text: value, kind: spec.kind, adapter: spec.adapter, model: spec.model });
      // Refined twice in a row: "my text" stays what the author typed, not the first rewrite.
      setMine({ text: mine && mine.refined === value ? mine.text : value, refined: r.text, cost: r.cost_usd });
      onChange(r.text);
    } catch (e: any) { setError(e.message); }
  };
  return (
    <div className="-mt-2 mb-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <AsyncButton data-testid={`${testid}-refine`} className="btn px-2 py-1 text-xs" disabled={!value.trim()} onClick={run}
          title={value.trim() ? `Ask ${spec.adapter} to rewrite this text so that it is clear and complete. You can go back to your own text.` : "Type what the step should do first"}>
          {/* The sparkle says "an agent writes this", which the words alone do not: it is the shape people
              know from every other AI feature, and it distinguishes this from the buttons that only save or
              send (asked for 2026-11-21). Decorative, so it is hidden from a screen reader. */}
          <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5 shrink-0">
            <path d="M8 1.5l1.4 3.9 3.9 1.4-3.9 1.4L8 12.1 6.6 8.2 2.7 6.8l3.9-1.4z" fill="currentColor" />
            <path d="M12.6 10.4l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z" fill="currentColor" />
          </svg>
          Refine with {spec.adapter}
        </AsyncButton>
        {mine && (
          <span data-testid={`${testid}-refined`} className="flex flex-wrap items-center gap-2 text-slate-600">
            <span>Rewritten by {spec.adapter}{SHOW_COST ? ` (${usd(mine.cost)})` : ""}.</span>
            <button type="button" data-testid={`${testid}-refine-undo`} className="btn px-2 py-1 text-xs" onClick={() => { onChange(mine.text); clearMine(); }}>Back to my text</button>
            <button type="button" data-testid={`${testid}-refine-keep`} className="text-blue-700 underline" onClick={clearMine}>Keep it</button>
          </span>
        )}
      </div>
      {error && <div data-testid={`${testid}-refine-error`} className="mt-1 text-red-700">{error}</div>}
      {hint && <div className="mt-1 text-slate-500">{hint}</div>}
    </div>
  );
}

const lines = (s: string) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);

function Irreversible({ node, change, p }: { node: any; change: Change; p: string }) {
  return (
    <div className="mb-3 text-sm">
      <label className="flex items-center gap-2"><input type="checkbox" data-testid={`${p}irreversible`} checked={!!node.irreversible} onChange={(e) => change({ irreversible: e.target.checked || undefined, confirm: undefined })} /> Performs something that cannot be undone<Help id="irreversible" /></label>
      {node.irreversible && <label className="ml-6 mt-1 flex items-center gap-2"><input type="checkbox" data-testid={`${p}confirm`} checked={node.confirm !== false} onChange={(e) => change({ confirm: e.target.checked ? undefined : false })} /> Ask me before it runs</label>}
    </div>
  );
}

interface ModelChoice { value: string; label: string; description?: string }
const modelCache = new Map<string, Promise<{ models: ModelChoice[]; note?: string }>>();

/**
 * The model of an agent node: a dropdown with the models the node's agent CLI offers
 * (asked from the CLI through /api/models), not free text.
 */
export function ModelSelect({ adapter, value, onChange, testid }: { adapter: string; value: string | undefined; onChange: (v: string) => void; testid: string }) {
  const [list, setList] = useState<{ models: ModelChoice[]; note?: string; signIn?: boolean; failed?: boolean } | null>(null);
  // A counter, so pressing Refresh asks again: the server caches a good list for ten minutes, and a
  // failure is deliberately not cached — signing a CLI in has to show up on the next look.
  const [tries, setTries] = useState(0);
  useEffect(() => {
    let live = true;
    setList(null);
    const url = `/api/models?adapter=${encodeURIComponent(adapter)}${tries ? "&refresh=1" : ""}`;
    if (tries) modelCache.set(adapter, get(url));
    else if (!modelCache.has(adapter)) modelCache.set(adapter, get(url));
    modelCache.get(adapter)!.then((r) => live && setList(r)).catch((e) => {
      modelCache.delete(adapter);
      if (live) setList({ models: [], failed: true, note: `The model list could not be read from the chief server (${e?.message ?? "no answer"}). If the server was started before this page was built, restart chief serve.` });
    });
    return () => { live = false; };
  }, [adapter, tries]);
  // The CLI's own "default" entry means "do not pass a model"; it labels the empty choice.
  const cliDefault = list?.models.find((m) => m.value === "default");
  const choices = (list?.models ?? []).filter((m) => m.value !== "default");
  const unknown = !!value && list !== null && !choices.some((m) => m.value === value);
  const refresh = () => { modelCache.delete(adapter); setTries((t) => t + 1); };
  return (
    // Short label, one line, so this field lines up with the three beside it; which CLI the list came from
    // is the "?" and the hint below, not a paragraph in the label (reported 2026-11-21).
    <Field label="Model" help="model" hint={list?.failed || list?.signIn ? undefined : (list?.note ?? (list && list.models.length ? `from ${adapter}` : undefined))}>
      {list?.failed && <span data-testid={`${testid}-error`} className="mb-1 block text-xs text-red-700">{list.note}</span>}
      {list?.signIn && (
        // Not a red error and not a wall of flags: the CLI is fine, it just needs a one-time sign-in, and
        // this line says which command to run and lets the person try again without reloading the page.
        <span data-testid={`${testid}-signin`} className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-amber-800">
          <span>{list.note}</span>
          <button type="button" data-testid={`${testid}-refresh`} className="rounded border border-amber-300 bg-surface px-1.5 py-0.5 font-medium text-amber-900 hover:bg-amber-50" onClick={refresh}>Check again</button>
        </span>
      )}
      <select data-testid={testid} data-adapter={adapter} data-loaded={list !== null} data-count={choices.length} className="input" value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
        <option value="">{cliDefault ? cliDefault.label : "CLI default"}</option>
        {choices.map((m) => <option key={m.value} value={m.value} title={m.description}>{m.label}</option>)}
        {unknown && <option value={value}>{value} (not offered by {adapter})</option>}
        {value && list === null && <option value={value}>{value}</option>}
      </select>
    </Field>
  );
}

function AgentFields({ node, change, servers: byAgent, p, adapter, adapters }: { node: any; change: Change; servers: Record<string, string[]>; p: string; adapter: string; adapters: string[] }) {
  // The servers on offer are those of the agent CLI that runs this node.
  const servers = byAgent[node.agent ?? adapter] ?? [];
  // No list at all: the node may use every server the agent CLI is connected to, and the agent decides.
  const unrestricted = !Array.isArray(node.mcp);
  const mcp: string[] = node.mcp ?? [];
  const all = [...new Set([...servers, ...mcp])];
  return (
    <>
      <Txt label="Prompt" help="prompt" testid={`${p}prompt`} area={7} value={node.prompt} onChange={(v) => change({ prompt: v })} hint="Placeholders use two braces: {{inputs.x}}, {{nodes.id.output.path}}, {{item}}"
        refine={{ kind: "agent", adapter: node.agent ?? adapter, model: node.model, id: node.id }} />
      <Field label={`MCP servers this node may use (from ${node.agent ?? adapter})`} help="mcp">
        <label className="mb-1 flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" data-testid={`${p}mcp-all`} checked={unrestricted} onChange={(e) => change({ mcp: e.target.checked ? undefined : [] })} />
          All connected servers (the agent decides which to use)
        </label>
        {!unrestricted && (
          <div data-testid={`${p}mcp`} className="max-h-36 overflow-auto rounded border border-slate-200 bg-surface p-2 text-sm">
            <div className="mb-1 text-xs text-slate-500">{mcp.length ? "Only the ticked servers:" : "No server ticked: this node uses no MCP server. Tick the ones it may use:"}</div>
            {all.length === 0 && <span className="text-slate-500" data-testid={`${p}mcp-none`}>This step's agent CLI ({node.agent ?? adapter}) reports no MCP servers. Add them where that CLI keeps them: {addServersHint(node.agent ?? adapter)}.</span>}
            {all.map((s) => (
              <label key={s} className="flex items-center gap-2"><input type="checkbox" data-testid={`${p}mcp-${s}`} checked={mcp.includes(s)} onChange={(e) => change({ mcp: e.target.checked ? [...mcp, s] : mcp.filter((x) => x !== s) })} /> {s}</label>
            ))}
          </div>
        )}
      </Field>
      {/* Four short fields in two rows. The labels are one word each on purpose: "Knows about earlier steps"
          wrapped to two lines and pushed its select out of line with the row beside it, which is what made
          the block look clunky (reported 2026-11-21). What the long label said is in the "?" — and in the
          options, which spell the choice out. */}
      <div className="grid grid-cols-2 gap-x-2 gap-y-2">
        <Field label="Context" help="context">
          <select data-testid={`${p}context`} className="input" value={node.context ?? "previous"} onChange={(e) => change({ context: e.target.value === "previous" ? undefined : e.target.value })}>
            <option value="previous">the step before</option>
            <option value="all">every earlier step</option>
            <option value="none">nothing, just the prompt</option>
          </select>
        </Field>
        <Field label="Agent CLI" help="agent" hint={node.agent && !adapters.includes(node.agent) ? `${node.agent} is not installed, or is switched off in Settings, so a run that uses this step cannot start. Choose another CLI, or set it up.` : undefined}>
          <select data-testid={`${p}agent`} className="input" value={node.agent ?? ""} onChange={(e) => change({ agent: e.target.value || undefined, model: undefined })}>
            <option value="">workflow’s ({adapter})</option>
            {/* The step's own choice is shown even when it is not on offer (task 15.14): the picker only
                lists the CLIs switched on, and a stored value that vanished from it would read as
                "the workflow's" — silently changing which CLI the step runs on. */}
            {node.agent && !adapters.includes(node.agent) && <option value={node.agent}>{node.agent} (not available)</option>}
            {adapters.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </Field>
        <ModelSelect testid={`${p}model`} adapter={node.agent ?? adapter} value={node.model} onChange={(v) => change({ model: v || undefined })} />
        <Field label="Tools" help="tools">
          <select data-testid={`${p}tools`} className="input" value={Array.isArray(node.tools) ? "none" : node.tools ?? "none"} onChange={(e) => change({ tools: e.target.value === "none" ? undefined : e.target.value })}>
            <option value="none">none</option><option value="read-only">read-only</option><option value="default">default</option>
          </select>
        </Field>
      </div>
      <Field label="Output schema (JSON shorthand)" help="output-schema" hint='e.g. {"summary": "string", "items": [{"title": "string"}]}'>
        <JsonField testid={`${p}output-schema`} value={node["output-schema"]} onChange={(v) => change({ "output-schema": v })} />
      </Field>
      <Txt label="Compensation prompt (how to undo this node)" help="compensate-prompt" testid={`${p}compensate-prompt`} area={3} value={node.compensate?.prompt} onChange={(v) => change({ compensate: v.trim() ? { ...(node.compensate ?? {}), prompt: v, run: undefined } : undefined })} hint="May use {{output.side_effects}}" />
      <Irreversible node={node} change={change} p={p} />
    </>
  );
}

function ScriptFields({ node, change, p }: { node: any; change: Change; p: string }) {
  const sb = node.sandbox ?? {};
  const setSb = (patch: Record<string, any>) => change({ sandbox: { network: !!sb.network, write: sb.write ?? [], env: sb.env ?? [], ...patch } });
  return (
    <>
      <Txt label="Script path" help="run" testid={`${p}run`} value={node.run} onChange={(v) => change({ run: v })} placeholder="scripts/dedupe.py" hint="Relative to the workflow's base directory. JSON in on stdin, JSON out on stdout." />
      <div className="grid grid-cols-2 gap-2">
        <Txt label="Interpreter" help="interpreter" testid={`${p}interpreter`} value={node.interpreter} onChange={(v) => change({ interpreter: v })} placeholder="by extension" />
        <Txt label="Timeout" help="timeout" testid={`${p}timeout`} value={node.timeout} onChange={(v) => change({ timeout: v })} placeholder="5m" />
      </div>
      <Field label="Input (JSON, templates allowed in strings)" help="input"><JsonField testid={`${p}input`} value={node.input} onChange={(v) => change({ input: v })} /></Field>
      <div data-testid={`${p}sandbox`} className="mb-3 rounded border border-slate-300 bg-slate-50 p-3">
        <div className="mb-1 text-sm font-semibold">Sandbox</div>
        <p className="mb-2 text-xs text-slate-600">Scripts always run sandboxed: no network, files writable only in the working directory and a scratch directory, secrets unreadable. You can widen it below; widening needs your approval when you save.</p>
        <label className="mb-2 flex items-center gap-2 text-sm"><input type="checkbox" data-testid={`${p}sandbox-network`} checked={!!sb.network} onChange={(e) => setSb({ network: e.target.checked })} /> Allow network access<Help id="sandbox-network" /></label>
        <Txt label="Extra writable paths (one per line)" help="sandbox-write" testid={`${p}sandbox-write`} area={2} value={(sb.write ?? []).join("\n")} onChange={(v) => setSb({ write: lines(v) })} hint="Protected paths can never be granted." />
        <Txt label="Environment variables to pass through" help="sandbox-env" testid={`${p}sandbox-env`} value={(sb.env ?? []).join(", ")} onChange={(v) => setSb({ env: lines(v) })} placeholder="GITHUB_TOKEN" />
      </div>
      <Txt label="Compensation script (how to undo this node)" help="compensate-run" testid={`${p}compensate-run`} value={node.compensate?.run} onChange={(v) => change({ compensate: v.trim() ? { run: v } : undefined })} />
      <Irreversible node={node} change={change} p={p} />
    </>
  );
}

/** What each kind of gate gives the steps after it: your answer, in a shape fixed by the kind. */
const GATE_OUTPUT: Record<string, { shape: string; fields: [string, string][]; note?: string }> = {
  input: { shape: '{ "text": "…", "option": "…" }', fields: [["option", "the option you picked (one of the Options below; empty when there are none)"], ["text", "what you typed"]] },
  approve: { shape: '{ "approved": true, "value": …, "text": "…" }', fields: [["value", "the value shown, as you left it (edited or not)"], ["text", "your note"], ["approved", "always true: a rejection cancels the run"]] },
  select: { shape: '{ "selected": […], "unselected": […], "mode": "…" }', fields: [["selected", "the items you ticked"], ["unselected", "the items you left out"], ["mode", "how you asked for them to be handled"]] },
  ask: { shape: '{ "selected": […], "unselected": […], "summary": "…", … }', fields: [["selected", "what you picked, when the form has a list to pick from"], ["unselected", "what you left out"], ["summary", "a one-line summary of your answers"]], note: "The form is worked out when the run gets here, so other questions add fields of their own. When a later step needs an exact field name, use one of the fixed forms." },
};

/** Shown under a gate's Kind: the output of that kind, and how a later step's prompt reads it. A gate has no output schema to define. */
function GateOutput({ node }: { node: any }) {
  const out = GATE_OUTPUT[node.kind];
  if (!out) return null;
  const id = node.id || "<gate id>";
  return (
    <div data-testid="gate-output" data-kind={node.kind} className="mb-3 rounded border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700">
      <div className="mb-1 font-semibold uppercase tracking-wide text-slate-500">Output of this gate<Help id="gate-output" /></div>
      <code className="mono mb-1 block whitespace-pre-wrap rounded bg-surface p-1.5 text-slate-800" data-testid="gate-output-shape">{out.shape}</code>
      <ul className="space-y-0.5">
        {out.fields.map(([f, what]) => <li key={f}><code className="mono text-sky-800" data-testid={`gate-output-ref-${f}`}>{`{{nodes.${id}.output.${f}}}`}</code> <span className="text-slate-600">{what}</span></li>)}
      </ul>
      {out.note && <p className="mt-1 text-slate-600">{out.note}</p>}
    </div>
  );
}

function GateFields({ node, change, adapter }: { node: any; change: Change; adapter: string }) {
  const modes: string[] = node.modes ?? ["all", "by-priority", "one-by-one"];
  return (
    <>
      <Field label="Kind" help="kind">
        <select data-testid="node-kind" className="input" value={node.kind} onChange={(e) => change({ kind: e.target.value })}>
          <option value="ask">ask: describe what to ask, in plain words</option>
          <option value="select">select: pick from a list (fixed form)</option>
          <option value="approve">approve: yes / no / edit (fixed form)</option>
          <option value="input">input: free text (fixed form)</option>
        </select>
      </Field>
      <GateOutput node={node} />
      {node.kind === "ask" ? (
        <>
          <Txt label="What should you be asked?" help="gate-prompt" testid="node-gate-prompt" area={6} value={node.prompt} onChange={(v) => change({ prompt: v })} refine={{ kind: "gate", adapter: node.agent ?? adapter, id: node.id }}
            placeholder="Show me the list from the previous step and let me pick which ones to handle. Also ask for an optional note."
            hint="An instruction, in plain words. When the run gets here, an agent turns it and the previous step's result into a form for you." />
          <ModelSelect testid="node-gate-model" adapter={node.agent ?? adapter} value={node.model} onChange={(v) => change({ model: v || undefined })} />
        </>
      ) : (
        <Txt label="Text shown to you (not an instruction)" help="message" testid="node-message" value={node.message} onChange={(v) => change({ message: v })}
          hint="This is only displayed above the form. To describe what should be asked, choose the kind “ask”." />
      )}
      {node.kind === "select" && (
        <>
          <Txt label="Items to choose from" help="from" testid="node-from" value={typeof node.from === "string" ? node.from : JSON.stringify(node.from ?? "")} onChange={(v) => change({ from: v })} placeholder="{{nodes.plan.output.items}}" />
          <Field label="Modes offered" help="modes">
            <div className="flex gap-3 text-sm">{["all", "by-priority", "one-by-one"].map((m) => (
              <label key={m} className="flex items-center gap-1"><input type="checkbox" data-testid={`node-mode-${m}`} checked={modes.includes(m)} onChange={(e) => change({ modes: e.target.checked ? [...modes, m] : modes.filter((x) => x !== m) })} /> {m}</label>
            ))}</div>
          </Field>
        </>
      )}
      {node.kind === "approve" && <Txt label="Value to approve" help="value" testid="node-value" area={3} value={typeof node.value === "string" ? node.value : node.value == null ? "" : JSON.stringify(node.value)} onChange={(v) => change({ value: v })} placeholder="{{nodes.draft.output.text}}" />}
      {node.kind === "input" && (
        <>
          <Txt label="Summary shown above the text box" help="summary" testid="node-summary" value={typeof node.summary === "string" ? node.summary : node.summary == null ? "" : JSON.stringify(node.summary)} onChange={(v) => change({ summary: v })} placeholder="{{nodes.act.output}}" />
          <Txt label="Options (comma separated)" help="options" testid="node-options" value={(node.options ?? []).join(", ")} onChange={(v) => change({ options: lines(v) })} placeholder="done, restart" />
        </>
      )}
    </>
  );
}

export function NodePanel({ node, change, onDelete, servers, scriptsEnabled, adapter, adapters }: { node: NodeDef; change: Change; onDelete: () => void; servers: Record<string, string[]>; scriptsEnabled: boolean; adapter: string; adapters: string[] }) {
  const inner = node.node ?? {};
  const changeInner: Change = (patch) => change({ node: { ...inner, ...patch } });
  return (
    <div data-testid="node-panel" data-node-type={node.type}>
      <div className="mb-3 flex items-center justify-between">
        <span className="rounded bg-slate-200 px-2 py-0.5 text-xs font-semibold uppercase text-slate-800">{node.type}</span>
        <button data-testid="node-delete" className="btn btn-danger" onClick={onDelete}>Delete node</button>
      </div>
      <Txt label="Id (lower-case kebab-case)" testid="node-id" value={node.id} onChange={(v) => change({ id: v })}
        hint={`Lower-case letters, digits and dashes. Other steps read its result as {{nodes.${node.id || "<id>"}.output}}, or one field as {{nodes.${node.id || "<id>"}.output.<field>}}.`} />
      {node.type === "agent" && <AgentFields node={node} change={change} servers={servers} p="node-" adapter={adapter} adapters={adapters} />}
      {node.type === "script" && <ScriptFields node={node} change={change} p="node-" />}
      {node.type === "gate" && <GateFields node={node} change={change} adapter={adapter} />}
      {node.type === "map" && (
        <>
          <Txt label="Over (the list to fan out on)" help="over" testid="node-over" value={typeof node.over === "string" ? node.over : JSON.stringify(node.over ?? "")} onChange={(v) => change({ over: v })} placeholder="{{nodes.choose.output.selected}}" />
          <div className="grid grid-cols-3 gap-2">
            <Txt label="Mode" help="mode" testid="node-mode" value={node.mode} onChange={(v) => change({ mode: v })} placeholder="sequential" hint="sequential, parallel or a template" />
            <Field label="Max parallel" help="max-parallel"><input type="number" min={1} data-testid="node-max-parallel" className="input" value={node["max-parallel"] ?? 3} onChange={(e) => change({ "max-parallel": Number(e.target.value) || 1 })} /></Field>
            <Field label="On error" help="on-error">
              <select data-testid="node-on-error" className="input" value={node["on-error"] ?? "fail"} onChange={(e) => change({ "on-error": e.target.value })}><option value="fail">fail</option><option value="continue">continue</option></select>
            </Field>
          </div>
          <div className="mb-2 mt-2 border-t border-slate-200 pt-3 text-sm font-semibold">Inner node (runs once per item; use {"{{item}}"})</div>
          <Field label="Inner node type" help="inner-type">
            <select data-testid="inner-type" className="input" value={inner.type ?? "agent"}
              onChange={(e) => change({ node: e.target.value === "script" ? { type: "script", run: "" } : { type: "agent", prompt: "", mcp: [] } })}>
              <option value="agent">agent</option>
              <option value="script" disabled={!scriptsEnabled}>script{scriptsEnabled ? "" : " (disabled: no sandbox)"}</option>
            </select>
          </Field>
          {inner.type === "script" ? <ScriptFields node={inner} change={changeInner} p="inner-" /> : <AgentFields node={inner} change={changeInner} servers={servers} p="inner-" adapter={adapter} adapters={adapters} />}
        </>
      )}
    </div>
  );
}
