import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import type { Store } from "./store/store.ts";
import type { GateRow } from "./store/types.ts";

/**
 * Tell the user a gate is waiting. macOS notification by default.
 * `CHIEF_NOTIFY_LOG=<file>` appends the message to a file instead (used by tests),
 * and the `notify` setting (default true) turns it off.
 */
export function notifyGate(store: Store, gate: GateRow, workflowName: string) {
  if (store.getSetting<boolean>("notify", true) === false) return;
  const what = gate.reason === "budget" ? "budget reached" : gate.reason === "needs_input" ? "agent needs input" : gate.reason === "irreversible" ? "confirm irreversible step" : `${gate.kind} gate`;
  const message = `${workflowName} run ${gate.run_id}: ${what}${gate.node_id ? ` (${gate.node_id})` : ""}`;
  const log = process.env.CHIEF_NOTIFY_LOG;
  if (log) { appendFileSync(log, JSON.stringify({ gate: gate.id, run: gate.run_id, message }) + "\n"); return; }
  if (process.platform !== "darwin" || process.env.CHIEF_NO_NOTIFY) return;
  try {
    const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const child = spawn("/usr/bin/osascript", ["-e", `display notification "${esc(message)}" with title "chief" subtitle "Waiting for you"`], { stdio: "ignore", detached: true });
    child.on("error", () => { /* best effort */ });
    child.unref();
  } catch { /* notifications are best effort */ }
}
