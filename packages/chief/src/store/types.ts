export type RunStatus =
  | "pending" | "running" | "waiting_gate" | "paused" | "interrupted"
  | "completed" | "failed" | "reverting" | "reverted" | "cancelled";

export type NodeRunStatus =
  | "pending" | "running" | "waiting_gate" | "interrupted"
  | "completed" | "failed" | "cancelled";

export const TERMINAL_RUN: RunStatus[] = ["completed", "failed", "reverted", "cancelled"];
export const TERMINAL_NODE: NodeRunStatus[] = ["completed", "failed", "cancelled"];

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  model?: string;
  invocations: number;
}

export interface WorkflowRow {
  id: number; name: string; version: number; definition: any; base_dir: string | null;
  created_at: string; updated_at: string;
}

export interface RunRow {
  id: number; workflow_id: number; workflow_version: number; definition: any; base_dir: string | null;
  status: RunStatus; inputs: any; budget: { "warn-usd"?: number; "max-usd"?: number } | null;
  requested_action: "pause" | "cancel" | null; owner_pid: number | null; parent_run_id: number | null;
  tokens_in: number; tokens_out: number; cost_usd: number; error: string | null;
  created_at: string; started_at: string | null; finished_at: string | null;
}

export interface NodeRunRow {
  id: number; run_id: number; node_id: string; node_type: string; phase: "forward" | "compensate";
  attempt: number; parent_node_run_id: number | null; item_index: number | null;
  status: NodeRunStatus; input: any; output: any; session_id: string | null; usage: Usage | null;
  state: any; error: string | null; compensated_at: string | null;
  created_at: string; started_at: string | null; finished_at: string | null;
}

export interface GateRow {
  id: number; run_id: number; node_run_id: number | null; node_id: string | null;
  kind: "ask" | "select" | "approve" | "input"; reason: "node" | "needs_input" | "irreversible" | "budget";
  payload: any; answer: any; status: "waiting" | "answered" | "consumed" | "cancelled";
  created_at: string; answered_at: string | null;
}

export interface SideEffectRow {
  id: number; run_id: number; node_run_id: number; kind: string; ref: string | null; url: string | null;
  how_to_undo: string | null; irreversible: number; reverted_at: string | null; created_at: string;
}

export interface EventRow { id: number; run_id: number; node_run_id: number | null; ts: string; type: string; payload: any }

export type MessageDirection = "in" | "out" | "user" | "system";

/** One entry of a run's full record. `in` goes to the worker (agent CLI or script), `out` comes from it. */
export interface MessageRow {
  id: number; run_id: number; workflow_id: number; node_run_id: number | null; node_id: string | null;
  ts: string; direction: MessageDirection; kind: string; content: string; meta: any;
}

export interface McpServerRow { name: string; adapter: string; folder: string; source: "discovered" | "manual"; config: any; updated_at: string }

export interface ScheduleRow {
  id: number; workflow_id: number; cron: string; enabled: number; inputs: any; last_run_at: string | null; created_at: string;
}

/** One row of the assistant's conversation (task 9.64): a question, the exact prompt sent, or an answer. */
export interface AssistantRow { id: number; ts: string; role: "user" | "prompt" | "assistant"; content: string; meta: any }
