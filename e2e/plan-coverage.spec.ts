import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, ROOT_DIR, test } from "./helpers";

/** The development standard (agents.md): every case in the test plan has exactly one test, and vice versa. */
test("the e2e test plan and the test suite list the same cases", () => {
  const plan = [...readFileSync(join(ROOT_DIR, "docs/e2e-test-plan.md"), "utf8").matchAll(/^\| (E[0-9.a-z]+-\d+) \|/gm)].map((m) => m[1]);
  const titles: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (name === ".tmp") continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".spec.ts")) for (const m of readFileSync(p, "utf8").matchAll(/\btest\("(E[0-9.a-z]+-\d+) /g)) titles.push(m[1]);
    }
  };
  walk(join(ROOT_DIR, "e2e"));
  expect(new Set(plan).size, "duplicate case ids in the plan").toBe(plan.length);
  expect(new Set(titles).size, "duplicate case ids in the tests").toBe(titles.length);
  expect(plan.filter((id) => !titles.includes(id)), "cases in the plan without a test").toEqual([]);
  expect(titles.filter((id) => !plan.includes(id)), "tests that are not in the plan").toEqual([]);
});

test("every task in the dev plan has at least one case in the test plan", () => {
  // A task that was dropped from scope needs no case.
  const tasks = [...readFileSync(join(ROOT_DIR, "docs/dev-plan.md"), "utf8").matchAll(/^\| (\d+\.\d+a?) \| .* \| ([a-z ]+) \| [^|]*\|$/gm)].filter((m) => m[2] !== "dropped").map((m) => m[1]);
  const covered = new Set([...readFileSync(join(ROOT_DIR, "docs/e2e-test-plan.md"), "utf8").matchAll(/^\| E[0-9.a-z]+-\d+ \| (\d+\.\d+a?) \|/gm)].map((m) => m[1]));
  expect(tasks.length).toBeGreaterThan(40);
  expect(tasks.filter((t) => !covered.has(t))).toEqual([]);
});
