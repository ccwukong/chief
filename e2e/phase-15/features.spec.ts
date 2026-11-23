import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, ROOT_DIR, test } from "../helpers";

/**
 * Phase 15, task 15.24: the cost figures and the budgets are hidden while their usefulness is decided.
 *
 * A dollar amount is only useful to someone who knows what to do with it, and "cost" is not a decision in
 * chief today: the run has already run. Hidden, not removed — the engine still records usage and cost,
 * and these flags turn the screens back on without another change. This case reads the flags and the
 * places they gate, so a screen cannot be added back by accident with the figure half shown.
 */
const read = (p: string) => readFileSync(join(ROOT_DIR, p), "utf8");

test("E15.24-1 the cost figures and budgets are hidden behind two flags, and the data is still recorded", () => {
  const flags = read("packages/web/src/features.ts");
  expect(flags).toContain("export const SHOW_COST = false");
  expect(flags).toContain("export const SHOW_BUDGETS = false");

  // Every place the interface showed a dollar figure now asks the flag.
  const gated = {
    "packages/web/src/pages/runs.tsx": ["SHOW_COST"],
    "packages/web/src/pages/run-detail.tsx": ["SHOW_COST", "SHOW_BUDGETS"],
    "packages/web/src/pages/designer.tsx": ["SHOW_BUDGETS"],
    "packages/web/src/pages/settings.tsx": ["SHOW_BUDGETS"],
    "packages/web/src/designer/panel.tsx": ["SHOW_COST"],
    "packages/web/src/assistant.tsx": ["SHOW_COST"],
  };
  for (const [file, needed] of Object.entries(gated)) {
    const text = read(file);
    for (const flag of needed) expect(text, `${file} uses ${flag}`).toContain(flag);
  }

  // The run list no longer has a Cost column, the run page has no dollars in its totals, and Settings has
  // no budget fields — the three places that showed one before this task.
  expect(read("packages/web/src/pages/runs.tsx")).toMatch(/\{SHOW_COST && <TableHead[^>]*>Cost<\/TableHead>\}/);
  expect(read("packages/web/src/pages/run-detail.tsx")).toContain("{SHOW_COST ? ` · ${usd(run.cost_usd)}` : \"\"}");
  expect(read("packages/web/src/pages/settings.tsx")).toContain("{SHOW_BUDGETS && (");
  expect(read("packages/web/src/pages/designer.tsx")).toContain("{SHOW_BUDGETS && <>");

  // Hidden is not removed: the engine still writes what each step used, and the API still returns it, so
  // the numbers are there for the CLI and for turning these screens back on.
  expect(read("packages/chief/src/engine/context.ts")).toContain("cost_usd");
  expect(read("packages/chief/src/ops.ts")).toMatch(/budget:/);
  // And hiding a field did not start clearing what is stored: Settings still sends the budget back.
  expect(read("packages/web/src/pages/settings.tsx")).toContain('"default-budget": budget');
});
