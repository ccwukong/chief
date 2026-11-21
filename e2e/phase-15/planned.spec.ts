import { test } from "../helpers";

/**
 * Phase 15 — the web and desktop experience first (dev plan §7, decision 15) — is planned, not built.
 * The cases that ARE built live beside their feature: E15.1-1 in `ui.spec.ts`, E15.3-1 in
 * `e2e/desktop/desktop.spec.ts`, E15.8-1 and E15.8-2 in `appearance.spec.ts`.
 *
 * Each case below is skipped, never passed, until its task is implemented: AGENTS.md says a task is
 * done only when its cases pass, so replacing a skip with the real case is part of the task. The
 * declarations exist now so that the plan and the suite keep listing the same cases
 * (e2e/plan-coverage.spec.ts) and the specifications are not lost.
 */

test("E15.2-1 a workflow without runs is removed from the designer, and one with runs is refused", () => {
  test.skip(true, "Phase 15 is planned, not built (dev plan §7, task 15.2)");
});

test("E15.4-1 the README leads with the app and keeps the terminal for scripting and recovery", () => {
  test.skip(true, "Phase 15 is planned, not built (dev plan §7, task 15.4)");
});

test("E15.5-1 every CLI command has a screen or a reason to be terminal-only", () => {
  test.skip(true, "Phase 15 is planned, not built (dev plan §7, task 15.5)");
});

test("E15.6-1 Start at login follows the switch and survives a relaunch", () => {
  test.skip(true, "Phase 15 is planned, not built (dev plan §7, task 15.6)");
});

test("E15.6-2 the LaunchAgent recipe loads a server that outlives its shell", () => {
  test.skip(true, "Phase 15 is planned, not built (dev plan §7, task 15.6)");
});

test("E15.7-1 a failed or completed run notifies when nothing is watching, unless notify is off", () => {
  test.skip(true, "Phase 15 is planned, not built (dev plan §7, task 15.7)");
});
