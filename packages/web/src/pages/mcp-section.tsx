/**
 * Settings › MCP servers: what each agent CLI is connected to, how it is authenticated, and the CLI's own command
 * for adding or removing a server — editable, with its output shown as it arrives.
 *
 * chief holds no MCP configuration of its own (AGENTS.md). Where a CLI has a command, the card puts **that command**
 * in a box with the values to fill in, runs it when asked, and prints what it says: no second form that rebuilds
 * something the person can already read. Where a CLI has no command, the card shows the syntax to paste instead —
 * a form that appears to work and cannot is worse than a snippet.
 */
import { useEffect, useMemo, useState } from "react";
import { api, get } from "../api";
import { usePolling } from "../polling";
import { AsyncButton, ErrorBox } from "../ui";
import { MCP_GUIDE } from "../mcp-guide";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Card } from "../components/ui/card";

interface Row { name: string; adapter: string; folder: string; source: string; config: any }
interface Provider { name: string; enabled: boolean; found: boolean }
const LABEL: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor", antigravity: "Antigravity", opencode: "OpenCode", hermes: "Hermes" };

/** Connected or configured is usable; anything else is listed and greyed, with the CLI's own word for it. */
const usable = (status: unknown) => status === "connected" || status === "configured";
/**
 * The CLI's own status word, said so a person can act on it. `needs-auth` is about **this connection's**
 * authentication with the service it belongs to — not about signing in to an account, which is what "sign in"
 * would suggest (corrected 2026-11-21).
 */
const statusText = (s: string) => s === "needs-auth" ? "needs authentication" : s === "failed" ? "could not connect" : s;

function Snippet({ text, testid, onUse, useLabel = "Use this" }: { text: string; testid: string; onUse?: () => void; useLabel?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative mt-1">
      <pre className="mono overflow-x-auto rounded border border-slate-200 bg-slate-50 px-2 py-1.5 pr-2 text-sm leading-relaxed text-slate-800" data-testid={testid}>{text}</pre>
      <div className="mt-1 flex gap-1.5">
        {onUse && <Button variant="outline" className="px-1.5 py-0.5 text-sm" type="button" data-testid={`${testid}-use`}  onClick={onUse}>{useLabel}</Button>}
        <Button variant="outline" className="border border-slate-300" type="button" data-testid={`${testid}-copy`} title="Copy this line, then run it in a terminal" onClick={() => { navigator.clipboard?.writeText(text).then(() => { setCopied(true); }, () => {}); }}>{copied ? "Copied" : "Copy"}</Button>
      </div>
    </div>
  );
}

/** The output of a command that is running or has finished, printed as it arrives. */
function Output({ run }: { run: { status: string; lines: string[]; exitCode: number | null } | null }) {
  if (!run) return null;
  const last = run.lines[run.lines.length - 1] ?? "";
  return (
    <div className="mt-1.5" data-testid="mcp-output" data-status={run.status}>
      <pre className="mono max-h-56 overflow-auto rounded border border-slate-300 bg-slate-900 px-2 py-1.5 text-sm leading-relaxed text-slate-100">
        {run.lines.length ? run.lines.join("\n") : run.status === "running" ? "running…" : "(it printed nothing)"}
      </pre>
      <div className="mt-1 flex items-center gap-2 text-sm">
        {run.status === "running" && <span className="text-slate-500">running…</span>}
        {run.status === "done" && <span className="text-green-800" data-testid="mcp-output-ok">finished, exit {run.exitCode}</span>}
        {run.status === "failed" && <span className="text-red-800" data-testid="mcp-output-failed">failed{run.exitCode != null ? `, exit ${run.exitCode}` : ""} — the last line says why</span>}
        {run.status === "cancelled" && <span className="text-slate-500">cancelled</span>}
        {last && run.status === "failed" && <span className="truncate text-slate-500">{last}</span>}
      </div>
    </div>
  );
}

/**
 * The CLI's own command, in a box you can edit, with its output underneath.
 *
 * This replaced a form with Action / Transport / Command / Arguments / Environment / Headers fields. The form
 * rebuilt the exact command the guide below it already printed, which was more to fill in than to type, and it could
 * not show what the CLI said back (reported 2026-11-21: *"the form is so ugly, can you just allow me to run the
 * `claude mcp add …` commands directly … and see the stdio print messages inline?"*).
 */
function CommandBox({ agent, onDone }: { agent: string; onDone: () => Promise<void> | void }) {
  const [text, setText] = useState("");
  const [run, setRun] = useState<{ id: string; status: string; lines: string[]; exitCode: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    get(`/api/mcp/command/template?adapter=${encodeURIComponent(agent)}`).then((r) => setText((cur) => cur || String(r.template))).catch(() => {});
  }, [agent]);
  // Poll only while it runs; a finished command stops asking by itself and the list is read again.
  usePolling(() => {
    if (!run || run.status !== "running") return;
    get(`/api/mcp/command/${run.id}`).then(async (r) => {
      setRun(r);
      if (r.status !== "running" && r.status === "done") await onDone();
    }).catch((e) => setError(e.message));
  }, run?.status === "running" ? 700 : null, [run?.id, run?.status]);

  const start = async () => {
    setError(null);
    try { setRun(await api("POST", "/api/mcp/command", { adapter: agent, command: text })); }
    catch (e: any) { setError(e.message); }
  };
  const stop = async () => { if (run) { try { setRun(await api("DELETE", `/api/mcp/command/${run.id}`)); } catch (e: any) { setError(e.message); } } };
  const running = run?.status === "running";

  return (
    <div className="mt-2 rounded border border-border bg-accent/40 px-2.5 py-2" data-testid={`settings-mcp-command-${agent}`}>
      <div className="mb-1 text-sm">
        <span className="font-semibold text-slate-800">Run a command</span>
        <span className="text-slate-500"> — this CLI's own <code className="mono">mcp</code> command, in the folder it belongs to</span>
      </div>
      <Textarea data-testid={`mcp-command-line-${agent}`} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} rows={2}
        aria-label={`The ${LABEL[agent] ?? agent} command to run`}
        className="mono input h-auto w-full resize-y py-1.5 text-sm" />
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        <AsyncButton data-testid={`mcp-command-run-${agent}`} variant="default" className="text-sm" busy={false} disabled={!text.trim() || running} onClick={start}>
          {running ? "Running…" : "Run"}
        </AsyncButton>
        {running && <Button variant="outline" className="text-sm" type="button" data-testid={`mcp-command-cancel-${agent}`}  onClick={stop}>Cancel</Button>}
        <span className="text-sm text-slate-500">Quotes group a value; nothing else is interpreted — no shell, no variables, no pipes.</span>
      </div>
      <ErrorBox error={error} testid={`mcp-command-error-${agent}`} />
      <Output run={run} />
    </div>
  );
}

/**
 * Authenticate one MCP connection, through the CLI's own login command.
 *
 * An OAuth consent takes as long as the person takes, so this is not one request: chief starts the CLI, the CLI
 * prints an authorization URL, the page shows it, and the URL the browser lands on is posted back. Credentials are
 * the CLI's — the redirect goes through this page to the waiting CLI and is not stored.
 */
function McpAuth({ agent, name, action, onDone }: { agent: string; name: string; action: "login" | "logout"; onDone: () => Promise<void> | void }) {
  const [flow, setFlow] = useState<{ id: string; status: string; url: string | null; mode: string; error: string | null; command?: string } | null>(null);
  const [redirect, setRedirect] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Poll only while a flow is unfinished: a finished sign-in stops asking by itself.
  usePolling(() => {
    if (!flow || flow.status === "done" || flow.status === "failed" || flow.status === "cancelled") return;
    get(`/api/mcp/auth/${flow.id}`).then((f) => { setFlow(f); if (f.status === "done") void onDone(); }).catch((e) => setError(e.message));
  }, flow && !["done", "failed", "cancelled"].includes(flow.status) ? 1200 : null, [flow?.id, flow?.status]);

  const start = async () => {
    setError(null); setBusy(true);
    try { setFlow(await api("POST", "/api/mcp/auth", { adapter: agent, action, name })); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };
  const answer = async () => {
    if (!flow) return;
    setBusy(true); setError(null);
    try { setFlow(await api("POST", `/api/mcp/auth/${flow.id}`, { redirect })); setRedirect(""); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };
  const stop = async () => {
    if (!flow) return;
    try { setFlow(await api("DELETE", `/api/mcp/auth/${flow.id}`)); } catch (e: any) { setError(e.message); }
  };

  const open = !!flow && !["done", "failed", "cancelled"].includes(flow.status);
  return (
    <span className="inline-flex flex-wrap items-baseline gap-1.5" data-testid={`mcp-auth-${agent}-${name}`}>
      {!flow && <Button variant="ghost" className="text-primary underline" type="button" disabled={busy} data-testid={`mcp-auth-start-${agent}-${name}`} onClick={start}>{action === "login" ? "Authenticate" : "Sign out"}</Button>}
      {open && <span className="text-sm text-slate-500" data-testid={`mcp-auth-waiting-${agent}-${name}`}>{flow!.mode === "url" ? "waiting for the browser" : "a browser window should have opened"}…</span>}
      {open && flow!.command && <code className="mono mt-0.5 block w-full break-all text-sm text-slate-500" data-testid={`mcp-auth-cmd-${agent}-${name}`}>{flow!.command}</code>}
      {open && <Button variant="ghost" className="underline" type="button" data-testid={`mcp-auth-cancel-${agent}-${name}`} onClick={stop}>Cancel</Button>}
      {flow && ["done", "failed", "cancelled"].includes(flow.status) && (
        <span data-testid={`mcp-auth-result-${agent}-${name}`} data-status={flow.status}
          className={`text-sm ${flow.status === "done" ? "text-green-800" : flow.status === "cancelled" ? "text-slate-500" : "text-red-800"}`}>
          {flow.status === "done" ? (action === "login" ? "authenticated" : "signed out") : flow.status === "cancelled" ? "cancelled" : `failed: ${flow.error ?? "the CLI gave no reason"}`}
        </span>
      )}
      {flow?.url && open && (
        <span className="mt-1 block w-full">
          <a href={flow.url} target="_blank" rel="noreferrer" data-testid={`mcp-auth-link-${agent}-${name}`} className="break-all text-sm text-primary underline">{flow.url}</a>
          <span className="mt-1 flex flex-wrap items-center gap-1.5">
            <Input className="mt-0 w-72 text-sm" data-testid={`mcp-auth-redirect-${agent}-${name}`}  value={redirect} placeholder="paste the URL the browser landed on" onChange={(e) => setRedirect(e.target.value)} />
            <Button variant="outline" className="text-sm" type="button" disabled={busy || !redirect.trim()} data-testid={`mcp-auth-answer-${agent}-${name}`}  onClick={answer}>Finish</Button>
          </span>
          <span className="mt-1 block text-sm text-slate-500">The code in that URL goes straight to {LABEL[agent] ?? agent}; chief does not keep it.</span>
        </span>
      )}
      <ErrorBox error={error} testid={`mcp-auth-error-${agent}-${name}`} />
    </span>
  );
}

export function McpServers({ providers, writable, authable, logoutable }: { providers: Provider[]; writable: string[]; authable: string[]; logoutable: string[] }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => get("/api/mcp").then((r) => { setRows(r); setError(null); }).catch((e) => setError(e.message));
  useEffect(() => { void load(); }, []);

  const refresh = async () => {
    setError(null); setNote("Asking the agent CLIs for their MCP servers…");
    try {
      const r = (await api("POST", "/api/mcp/refresh")).result;
      setNote(Object.entries(r).map(([a, v]: any) => `${a}: ${v.error ? `skipped (${v.error})` : `${v.count} servers`}`).join(" · "));
      await load();
    } catch (e: any) { setNote(null); setError(e.message); }
  };

  const byAgent = useMemo(() => {
    const out: Record<string, Row[]> = {};
    for (const r of rows ?? []) (out[r.adapter] ??= []).push(r);
    for (const list of Object.values(out)) list.sort((a, b) => Number(usable(b.config?.status)) - Number(usable(a.config?.status)) || a.name.localeCompare(b.name));
    return out;
  }, [rows]);
  const folder = rows?.find((r) => r.folder)?.folder ?? "";
  const found = useMemo(() => Object.fromEntries(providers.map((p) => [p.name, p])), [providers]);
  const order = ["claude-code", "codex", "cursor", "antigravity", "opencode", "hermes"];

  return (
    <Card asChild className="mt-5 mb-5"><section data-testid="settings-mcp">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">MCP servers</h2>
        {/* Says the one thing a person needs to know before looking for an Add button. */}
        <span className="text-sm text-slate-500">chief reads these; adding one runs the CLI's own command</span>
        <AsyncButton data-testid="btn-discover" variant="outline" className="ml-auto" onClick={refresh}>Refresh MCP servers</AsyncButton>
      </div>
      <ErrorBox error={error} testid="settings-mcp-error" />
      {note && <div data-testid="settings-note" className="mb-2 rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-900">{note}</div>}
      {rows !== null && (
        <p className="mb-2 text-sm text-slate-500">
          The servers depend on the folder the agent runs in, and these are the ones for
          {folder ? <> <span className="mono break-all" data-testid="settings-mcp-folder">{folder}</span></> : " this workspace"}.
          A workflow that runs elsewhere may see a different list.
        </p>
      )}

      {rows === null && <div className="text-sm text-slate-500">Reading the agent CLIs…</div>}
      {rows?.length === 0 && <div className="mb-2 text-sm text-slate-600" data-testid="settings-mcp-empty">No agent CLI reports an MCP server here yet. The command below adds one.</div>}

      <div className="space-y-3">
        {order.map((agent) => {
          const list = byAgent[agent] ?? [];
          const p = found[agent];
          const why = p && !p.found ? "not installed" : p && !p.enabled ? "switched off" : null;
          const guide = MCP_GUIDE[agent];
          const on = list.filter((r) => usable(r.config?.status)).length;
          // Connectors are the account's, not the CLI's: no command reaches them, so the card says once where they
          // are authenticated rather than repeating it on every row.
          const connectors = list.filter((r) => r.config?.scope === "connector").length;
          return (
            <div key={agent} data-testid={`settings-mcp-agent-${agent}`} data-count={list.length} data-why={why ?? undefined} data-connectors={connectors}
              className="rounded border border-slate-200 px-3 py-2">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-sm font-semibold text-slate-800" data-testid={`settings-mcp-name-${agent}`}>{LABEL[agent] ?? agent}</span>
                <span className="text-sm text-slate-500" data-testid={`settings-mcp-count-${agent}`}>
                  {why ?? (list.length ? `${on} of ${list.length} usable` : "no servers")}
                </span>
              </div>
              {connectors > 0 && (
                <p className="mt-1 text-sm text-slate-500" data-testid={`settings-mcp-connectors-${agent}`}>
                  {connectors === list.length ? "These" : `${connectors} of these`} are MCP connections your {LABEL[agent] ?? agent} account provides, not servers in the CLI's own configuration.
                  {" "}Each one is authenticated separately, with the service it belongs to — {LABEL[agent] ?? agent} cannot do that for one of them.{" "}
                  {agent === "claude-code" ? (
                    <a data-testid={`settings-mcp-connectors-link-${agent}`} href="https://claude.ai/customize/connectors" target="_blank" rel="noreferrer"
                      className="font-medium text-primary underline hover:no-underline"
                      title="Open the connector settings in a new tab: each connection is authenticated there">
                      Authenticate them at claude.ai
                    </a>
                  ) : (
                    <span>Authenticate them in {LABEL[agent] ?? agent} itself.</span>
                  )}
                </p>
              )}

              {list.length > 0 && (
                <ul className="mt-1.5 space-y-1">
                  {list.map((r) => {
                    const status = String(r.config?.status ?? "unknown");
                    const target = r.config?.target ? String(r.config.target) : "";
                    return (
                      <li key={r.name} data-testid={`settings-mcp-server-${agent}-${r.name}`} data-status={status} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                        <span aria-hidden="true" className={`inline-block h-2 w-2 shrink-0 rounded-full ${usable(status) ? "bg-green-600" : "bg-slate-400"}`} />
                        <span className="font-medium text-slate-800">{r.name}</span>
                        {/* The target is what the server runs or where it points. Never the headers or env values:
                            a token shown in a settings page is a token in a screenshot. */}
                        {target && <span className="mono truncate text-slate-500" title={target}>{target}</span>}
                        <span className="ml-auto shrink-0 text-slate-500">{statusText(status)}</span>
                        {r.config?.scope === "connector"
                          // Account-level: not in the CLI's list, so no command reaches it. The card says where to go.
                          ? null
                          : status === "connected"
                            ? (logoutable.includes(agent) ? <McpAuth agent={agent} name={r.name} action="logout" onDone={load} /> : null)
                            : status === "disabled"
                              ? null
                              : (authable.includes(agent) ? <McpAuth agent={agent} name={r.name} action="login" onDone={load} /> : null)}
                      </li>
                    );
                  })}
                </ul>
              )}

              {/* The command itself, editable and runnable — not a form that rebuilds it. */}
              {writable.includes(agent) && <CommandBox agent={agent} onDone={load} />}
              {guide && (
                <details data-testid={`settings-mcp-how-${agent}`} className="mt-2">
                  <summary className="cursor-pointer text-sm font-medium text-primary hover:underline" data-testid={`settings-mcp-how-summary-${agent}`}>
                    {guide.add.length ? `Other ways to add one to ${LABEL[agent] ?? agent}` : `Where ${LABEL[agent] ?? agent} reads its servers`}
                  </summary>
                  <div className="mt-1.5 space-y-1.5 text-sm text-slate-600">
                    <p data-testid={`settings-mcp-where-${agent}`}>{guide.where}</p>
                    {guide.add.map((line, i) => <Snippet key={i} text={line} testid={`settings-mcp-add-${agent}-${i}`} />)}
                    {guide.snippet && <Snippet text={guide.snippet} testid={`settings-mcp-add-${agent}-snippet`} />}
                    {guide.note && <p className="text-slate-500" data-testid={`settings-mcp-note-${agent}`}>{guide.note}</p>}
                    {guide.remove && <p className="text-slate-500">Remove one with <code className="mono rounded bg-slate-100 px-1 py-0.5">{guide.remove}</code>.</p>}
                    <p className="text-slate-500">Then press <b>Refresh</b> above, and the list here follows.</p>
                  </div>
                </details>
              )}
            </div>
          );
        })}
      </div>
    </section></Card>
  );
}
