/**
 * Lines for the terminal `chief serve` runs in: what the server is doing, as it happens. Off for
 * every other command, whose output is its result (and may be JSON). `CHIEF_LOG=debug` adds the
 * requests the web UI makes all the time (polling, drafts) and the agents' own messages.
 */
let on = false;
let debug = false;

export function enableLog() {
  on = true;
  debug = process.env.CHIEF_LOG === "debug";
}
export const logging = () => on;
export const debugLogging = () => on && debug;

const time = () => new Date().toLocaleTimeString([], { hour12: false });
const one = (s: unknown, max = 300) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
};

export function log(message: string) {
  if (on) console.log(`${time()} ${message}`);
}
export function logDebug(message: string) {
  if (on && debug) console.log(`${time()} ${message}`);
}

/** One line for a run event (see `run__events`), or null for events not worth a line. */
export function describeEvent(e: { runId: number; type: string; payload: any; workflow?: string | null }): { text: string; debug?: boolean } | null {
  const p = e.payload ?? {};
  const run = `run #${e.runId}${e.workflow ? ` (${e.workflow})` : ""}`;
  const step = p.node_id
    ? `step ${p.node_id}${p.item_index != null ? `[${p.item_index}]` : ""}${p.attempt > 1 ? ` (try ${p.attempt})` : ""}${p.phase === "compensate" ? " (undo)" : ""}`
    : "a step";
  switch (e.type) {
    case "run_created": return null;
    case "run_started": return { text: `${run} started` };
    case "run_completed": return { text: `${run} completed` };
    case "run_failed": return { text: `${run} failed${p.error ? `: ${one(p.error)}` : ""}` };
    case "run_cancelled": return { text: `${run} cancelled` };
    case "run_paused": return { text: `${run} paused` };
    case "run_interrupted": return { text: `${run} interrupted` };
    case "run_waiting": return { text: `${run} is waiting for an answer` };
    case "run_step_changed": return { text: p.field === "prompt"
      ? `${run}: ${step} has a new prompt (${String(p.to ?? "").length} characters)${p.restarted ? ", and starts again" : ""}`
      : `${run}: ${step} now uses ${p.to ?? "the CLI's default model"} (was ${p.from ?? "the CLI's default"})` };
    case "run_resumed": return { text: `${run} resumed${p.from ? ` (it was ${p.from})` : ""}` };
    case "gate_opened": return { text: `${run}: ${step} is waiting for your answer${p.kind ? ` (${p.kind} gate)` : ""}` };
    case "node_running": return { text: `${run}: ${step} started` };
    case "node_completed": return { text: `${run}: ${step} completed` };
    case "node_failed": return { text: `${run}: ${step} failed${p.error ? `: ${one(p.error)}` : ""}` };
    case "node_cancelled": return { text: `${run}: ${step} cancelled` };
    case "node_interrupted": return { text: `${run}: ${step} interrupted` };
    case "node_waiting_gate": return null; // gate_opened says it, with the gate's kind
    case "node_retry": return { text: `${run}: ${step} is tried again${p.reason ? `: ${one(p.reason)}` : ""}` };
    case "node_repair": return { text: `${run}: ${step} gave an invalid result and is asked to fix it${p.problem ? `: ${one(p.problem)}` : ""}` };
    case "side_effect": return { text: `${run}: ${step} reported a write: ${one([p.kind, p.ref, p.url].filter(Boolean).join(" "))}` };
    case "budget_warning": return { text: `${run} passed its budget warning` };
    case "budget_stop": return { text: `${run} reached its budget and waits for a decision` };
    case "budget_raised": return { text: `${run}: budget raised` };
    case "revert_started": return { text: `${run}: revert started` };
    case "revert_report": return { text: `${run}: revert finished` };
    case "scheduled": return { text: `${run} started by schedule ${p.schedule_id ?? ""} (${p.cron ?? ""})` };
    case "restarted": return { text: `${run} was started again from a gate's answer` };
    case "engine_error": return { text: `${run}: engine error: ${one(p.error)}` };
    case "output_truncated": return { text: `${run}: ${step}: a value was cut to the output size limit (${p.ref ?? ""}, ${p.chars ?? "?"} chars)` };
    default: return { text: `${run}: ${e.type.replace(/_/g, " ")}${p.node_id ? ` (${step})` : ""}`, debug: true };
  }
}
