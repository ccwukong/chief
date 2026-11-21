import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, fake, ROOT_DIR, test } from "../helpers";

/** The build output of task 11.5: a bundle run by Node, with the SQL migrations beside it. */
const BIN = join(ROOT_DIR, "e2e/.tmp/_bin/chief.mjs");

// One build for the three cases.
test.describe.configure({ mode: "serial" });

test("E8.4-1 the build produces one chief bundle that runs on Node", () => {
  test.setTimeout(300_000);
  mkdirSync(join(ROOT_DIR, "e2e/.tmp/_bin"), { recursive: true });
  // The web UI is already built by e2e/global-setup.ts. It is not rebuilt here: that would empty
  // packages/web/dist while the browser cases in other workers are loading it.
  const r = spawnSync(process.execPath, ["packages/chief/scripts/build.ts", BIN], { cwd: ROOT_DIR, encoding: "utf8" });
  expect(r.status, r.stdout + r.stderr).toBe(0);
  // The line a release build prints: one bundle, the embedded UI, the migrations, and the notices it
  // generated beside it (task 15.18).
  expect(r.stdout).toMatch(/built .*chief\.mjs \(\d+\.\d MB, \d+ web files embedded, \d+ migrations beside it, \d+ third-party notices; state in .*\.chief\)/);
  for (const beside of ["LICENSE", "THIRD-PARTY-NOTICES.md"]) expect(existsSync(join(ROOT_DIR, "e2e/.tmp/_bin", beside)), beside).toBe(true);
  const st = statSync(BIN);
  expect(st.isFile()).toBe(true);
  // It is run as `node chief.mjs`, and also carries a shebang so it can be started on its own.
  expect(st.mode & 0o111).not.toBe(0);
  expect(st.size).toBeGreaterThan(1 * 1024 * 1024);
  expect(readFileSync(BIN, "utf8").startsWith("#!/usr/bin/env node"), "the bundle starts with a node shebang");
  // The SQL migrations are read at startup and are copied beside the bundle.
  for (const m of ["001-init", "005-assistant"]) expect(existsSync(join(ROOT_DIR, "e2e/.tmp/_bin/migrations", `${m}.sql`)), m).toBe(true);
  // The generated asset module must not be left behind (the dev server would serve stale files).
  expect(existsSync(join(ROOT_DIR, "packages/chief/src/server/web-assets.generated.ts"))).toBe(false);
});

test("E8.4-2 the executable works on its own: doctor, import, run", ({ chief }) => {
  test.skip(!existsSync(BIN), "the build case did not produce a binary");
  const run = (args: string[]) => spawnSync(process.execPath, [BIN, ...args], { cwd: chief.dir, env: chief.env, encoding: "utf8" });
  const doc = run(["doctor", "--json"]);
  expect(doc.status, doc.stdout + doc.stderr).toBe(0);
  expect(JSON.parse(doc.stdout)).toMatchObject({ ok: true, db: { ok: true, latest: "005-assistant" }, sandbox: { available: true } });

  chief.file("double.py", "import json,sys\nprint(json.dumps({'n': json.load(sys.stdin)['n'] * 2}))\n");
  const wf = chief.file("standalone.yaml", `
name: standalone
nodes:
  - { id: a, type: agent, prompt: 'A ${fake({ output: { n: 21 } })}' }
  - { id: s, type: script, run: double.py, input: { n: "{{nodes.a.output.n}}" } }
  - { id: g, type: gate, kind: approve, value: "{{nodes.s.output.n}}" }
edges: [a -> s, s -> g]
`);
  expect(run(["workflow", "import", wf]).status).toBe(0);
  const started = run(["run", "standalone", "--json"]);
  expect(started.status, started.stdout + started.stderr).toBe(0);
  expect(JSON.parse(started.stdout).gates[0].payload.value).toBe(42);
  const done = run(["gate", "approve", "1", "--json"]);
  expect(JSON.parse(done.stdout).run.status).toBe("completed");
  expect(run(["--help"]).stdout).toContain("Usage: chief");
});

test("E8.4-3 the executable serves the embedded web UI", async ({ chief, page }) => {
  test.skip(!existsSync(BIN), "the build case did not produce a binary");
  const proc = startBinary(BIN, ["serve", "--port", "0"], chief);
  try {
    const url = await proc.url;
    const html = await (await fetch(url + "/")).text();
    expect(html).toContain('<div id="root">');
    const asset = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
    expect(asset, html).toBeTruthy();
    const js = await fetch(url + asset!);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
    expect((await fetch(url + "/api/doctor")).status).toBe(200);
    // Client-side routes fall back to the app.
    expect(await (await fetch(url + "/some/deep/link")).text()).toContain('<div id="root">');

    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(url + "/");
    await expect(page.locator("#root")).not.toBeEmpty();
    await expect(page.getByRole("link", { name: /runs/i }).first()).toBeVisible();
    expect(errors).toEqual([]);
  } finally { proc.stop(); }
});

/** Start the compiled binary's server and resolve its URL from its output. */
function startBinary(bin: string, args: string[], chief: { env: Record<string, string>; dir: string }) {
  const p = spawn(process.execPath, [bin, ...args], { env: chief.env, cwd: chief.dir });
  let out = "";
  const url = new Promise<string>((resolve, reject) => {
    const onData = (d: Buffer) => { out += d; const m = out.match(/http:\/\/127\.0\.0\.1:\d+/); if (m) resolve(m[0]); };
    p.stdout.on("data", onData);
    p.stderr.on("data", onData);
    p.on("close", () => reject(new Error("server exited:\n" + out)));
    setTimeout(() => reject(new Error("server did not start:\n" + out)), 15_000);
  });
  return { url, stop: () => p.kill("SIGTERM") };
}
