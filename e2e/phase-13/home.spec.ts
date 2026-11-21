import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, fake, ROOT_DIR, test } from "../helpers";

/**
 * Task 13.1: everything chief generates lives in ~/.chief, never in the checkout. The state is
 * deliberately outside the repository, so a workflow's folder (and any .mcp.json a CLI puts in it)
 * cannot be committed by accident, and moving the checkout is not an event.
 */

/** Paths chief could have written in the checkout: everything except deps, git, build output and test scratch. */
const SKIP = new Set(["node_modules", ".git", "dist", "test-results", "playwright-report"]);
const tree = (dir: string, rel = ""): string[] => {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || rel === "" && (name === "test-results" || name === "playwright-report")) continue;
    const p = join(dir, name);
    out.push(p);
    // lstat: a broken symlink must not be followed out of the tree.
    if (lstatSync(p).isDirectory() && !(rel === "e2e" && name === ".tmp")) out.push(...tree(p, rel ? `${rel}/${name}` : name));
  }
  return out;
};

test("E13.1-1 chief writes its state to ~/.chief and nothing into the checkout", async ({ chief }) => {
  // A user home of its own, so "~/.chief" is a folder this case can inspect.
  const userHome = join(dirname(chief.home), "user-home");
  mkdirSync(userHome, { recursive: true });

  // The path rules: home and workspace under ~/.chief whatever the working directory.
  const paths = (cwd: string) => {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e",
      `const p = await import(${JSON.stringify(join(ROOT_DIR, "packages/chief/src/paths.ts"))}); console.log(JSON.stringify({ home: p.chiefHome(), db: p.dbPath(), workspace: p.defaultWorkspace() }))`],
      { cwd, env: { ...process.env, HOME: userHome, CHIEF_HOME: "" }, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout.trim());
  };
  for (const cwd of [ROOT_DIR, userHome, "/tmp"]) {
    const p = paths(cwd);
    expect(p.home, cwd).toBe(join(userHome, ".chief", "state"));
    expect(p.db, cwd).toBe(join(userHome, ".chief", "state", "chief.db"));
    expect(p.workspace, cwd).toBe(join(userHome, ".chief", "workspace"));
  }

  // A run of a real workflow whose folder is outside the repository, with an agent step and a script
  // step that writes into its working directory — the kind of file that used to land in the checkout.
  const flow = join(userHome, "flows", "outside");
  mkdirSync(flow, { recursive: true });
  writeFileSync(join(flow, "write.py"), "import json\nopen('written-by-step.txt','w').write('hi')\nprint(json.dumps({'ok': True}))\n");
  writeFileSync(join(flow, "outside.yaml"), `
name: outside
nodes:
  - { id: a, type: agent, mcp: [], prompt: 'A ${fake({ output: { n: 1 } })}' }
  - { id: s, type: script, run: write.py }
edges: [a -> s]
`);
  const wf = chief.run(["workflow", "import", join(flow, "outside.yaml"), "--json"]);
  expect(wf.code, wf.stdout + wf.stderr).toBe(0);

  const before = new Set(tree(ROOT_DIR));
  const ran = chief.run(["run", "outside", "--json"]);
  expect(ran.code, ran.stdout + ran.stderr).toBe(0);
  expect(JSON.parse(ran.stdout).run.status).toBe("completed");

  // The state is where ~/.chief says it is…
  const doc = chief.run(["doctor", "--json"]).json();
  expect(doc.home).toBe(chief.home); // the e2e harness points CHIEF_HOME at its own folder
  expect(doc.db.path).toBe(join(chief.home, "chief.db"));
  expect(existsSync(join(chief.home, "chief.db"))).toBe(true);
  // …the same-folder rule holds for the doctor's reported default workspace…
  const s = await chief.serve();
  try {
    const meta = (await s.api("GET", "/api/meta")).body;
    expect(meta.default_workspace_dir).toBe(join(dirname(chief.home), "workspace"));
  } finally { await s.stop(); }

  // …and the run wrote its file into the workflow's own folder, not into the checkout. An imported
  // workflow keeps the folder its file came from (ops.importFile), which here is outside the repo.
  const baseDir = chief.run(["runs", "show", "1", "--json"]).json().run.base_dir as string;
  expect(baseDir).toBe(flow);
  expect(existsSync(join(baseDir, "written-by-step.txt")), `the step wrote into ${baseDir}`).toBe(true);

  // The checkout gained nothing: no .chief, no stray files from the run.
  expect(existsSync(join(ROOT_DIR, ".chief"))).toBe(false);
  expect(tree(ROOT_DIR).filter((p) => !before.has(p))).toEqual([]);
});
