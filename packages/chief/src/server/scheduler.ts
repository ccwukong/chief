import { startRun } from "../engine/engine.ts";
import { ensureMcp } from "../ops.ts";
import type { Store } from "../store/store.ts";
import { cronMatches, minuteKey } from "../util/cron.ts";

/**
 * In-process scheduler. Runs only while `chief serve` runs. Each schedule fires at most once per
 * matching minute; the minute is recorded before the run starts, so a restart cannot fire it twice.
 */
export function startScheduler(store: Store, launch: (runId: number) => void, now: () => Date = () => new Date()) {
  const tick = () => {
    const d = now();
    const key = minuteKey(d);
    for (const s of store.schedules()) {
      if (!s.enabled || s.last_run_at === key) continue;
      let due = false;
      try { due = cronMatches(s.cron, d); } catch { continue; }
      if (!due) continue;
      store.touchSchedule(s.id, key);
      void (async () => {
        try {
          const wf = store.getWorkflow(s.workflow_name);
          if (wf) await ensureMcp(store, wf.definition, wf.base_dir ?? process.cwd());
          const run = startRun(store, s.workflow_name, s.inputs ?? {});
          store.addEvent(run.id, "scheduled", { schedule_id: s.id, cron: s.cron });
          launch(run.id);
        } catch (e: any) {
          console.error(`schedule ${s.id} (${s.workflow_name}) could not start: ${e.message}`);
        }
      })();
    }
  };
  tick();
  const timer = setInterval(tick, Number(process.env.CHIEF_SCHEDULER_TICK_MS) || 20_000);
  return () => clearInterval(timer);
}
