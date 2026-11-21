/**
 * What the app shows for now, in one place (task 15.24).
 *
 * A dollar figure is only useful to someone who knows what it means, and "cost" is not a decision anyone
 * makes in chief today: the run already ran. So the cost figures and the per-workflow budget are **hidden**
 * from the interface while that is decided. Hidden is not removed: the engine still records what each step
 * used, `run.runs` still has `cost_usd`, and `/api/runs/:id` still returns it, so the numbers are there for
 * the CLI and for turning these screens back on. Flipping one of these to `true` restores its screens with
 * no other change.
 */
export const SHOW_COST = false;
export const SHOW_BUDGETS = false;
