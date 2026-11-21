import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, fake, test, type Chief, type Server } from "../helpers";

const until = async <T>(fn: () => Promise<T | false | null | undefined>, ms = 20_000): Promise<T> => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
};
const status = (s: Server, id: number, want: string) => until(async () => { const d = (await s.api("GET", `/api/runs/${id}`)).body; return d.run?.status === want ? d : null; });
/** Give the fake Claude Code servers that exist only in one folder (like local scope or .mcp.json). */
const folderServers = (dir: string, lines: string[]) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "fake-mcp-list.txt"), lines.join("\n")); };
/** Import a workflow whose folder is `dir` (an imported workflow's folder is the folder of its file). */
const importIn = (chief: Chief, dir: string, yaml: string) => {
  const name = yaml.match(/^name:\s*(\S+)/m)![1];
  mkdirSync(dir, { recursive: true });
  const r = chief.run(["workflow", "import", join(dir, `${name}.yaml`), "--json"], {});
  return r;
};
const writeAndImport = (chief: Chief, dir: string, yaml: string) => {
  const name = yaml.match(/^name:\s*(\S+)/m)![1];
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.yaml`), yaml);
  const r = importIn(chief, dir, yaml);
  expect(r.code, r.stdout + r.stderr).toBe(0);
};
const names = (rows: any[]) => rows.map((r) => r.name).sort();
/** The values given to a flag such as --allowedTools (they run until the next flag). */
const flagValues = (argv: string[], flag: string) => {
  const i = argv.indexOf(flag);
  if (i < 0) return [];
  const out: string[] = [];
  for (let k = i + 1; k < argv.length && !argv[k].startsWith("--"); k++) out.push(argv[k]);
  return out;
};

test("E9.34-1 servers are read for the folder a step runs in, and a folder-only server is blocked unless ticked", async ({ chief }) => {
  const a = join(chief.dir, "flows", "a"), b = join(chief.dir, "flows", "b"), c = join(chief.dir, "flows", "c");
  folderServers(a, ["localgit: https://example.test/mcp (HTTP) - ✔ Connected"]);
  folderServers(c, ["othergit: https://example.test/other (HTTP) - ✔ Connected"]);
  mkdirSync(b, { recursive: true });
  writeAndImport(chief, a, [
    "name: wa", "nodes:",
    `  - { id: none, type: agent, mcp: [], prompt: 'None ${fake({ output: { n: 1 } })}' }`,
    `  - { id: conn, type: agent, mcp: [github-custom], prompt: 'Conn ${fake({ output: { n: 5 } })}' }`,
    `  - { id: uses, type: agent, mcp: [localgit], prompt: 'Uses ${fake({ output: { n: 2 } })}' }`,
    `  - { id: away, type: agent, cwd: ../c, mcp: [othergit], prompt: 'Away ${fake({ output: { n: 3 } })}' }`,
    "edges: [none -> conn, conn -> uses, uses -> away]", "",
  ].join("\n"));
  writeAndImport(chief, b, `name: wb\nnodes:\n  - { id: x, type: agent, mcp: [], prompt: 'X ${fake({ output: { n: 4 } })}' }\n`);

  const s = await chief.serve();
  try {
    // Each folder's own list.
    const inA = await s.api("GET", "/api/mcp?workflow=wa"), inB = await s.api("GET", "/api/mcp?workflow=wb");
    expect(names(inA.body)).toContain("localgit");
    expect(names(inB.body)).not.toContain("localgit");
    expect(names(inB.body)).toContain("github-custom");
    expect(inA.body.every((r: any) => r.folder === a)).toBe(true);

    // A node may tick the folder-only server in A's folder, not in B's.
    const okA = (await s.api("POST", "/api/workflows/validate", { yaml: `name: wa2\nnodes:\n  - { id: u, type: agent, mcp: [localgit], prompt: hi }\n`, base_dir: a })).body;
    expect(okA.errors).toEqual([]);
    expect(okA.environment).toEqual([]);
    const inBad = (await s.api("POST", "/api/workflows/validate", { yaml: `name: wb2\nnodes:\n  - { id: u, type: agent, mcp: [localgit], prompt: hi }\n`, base_dir: b })).body;
    expect(inBad.environment.join(" ")).toMatch(/has no MCP server named "localgit"/);

    // Running A: the step with no servers has the folder-only one blocked; the step that ticked it may use it;
    // the step with its own cwd gets that folder's servers.
    const run = (await s.api("POST", "/api/runs", { workflow: "wa" })).body.run.id;
    await status(s, run, "completed");
    const call = (word: string) => chief.calls().find((x) => x.prompt.startsWith(word))!;
    const none = call("None"), conn = call("Conn"), uses = call("Uses"), away = call("Away");
    // No servers: strict mode with an empty server list, so not even the folder's own server is there.
    expect(none.cwd).toBe(a);
    expect(none.argv).toContain("--strict-mcp-config");
    expect(JSON.parse(none.argv[none.argv.indexOf("--mcp-config") + 1])).toEqual({ mcpServers: {} });
    // A claude.ai connector ticked: every other server of the folder is blocked by name, the folder-only one included.
    expect(flagValues(conn.argv, "--allowedTools")).toContain("mcp__claude_ai_GitHub_Custom");
    expect(flagValues(conn.argv, "--disallowedTools")).toContain("mcp__localgit");
    expect(flagValues(uses.argv, "--allowedTools")).toContain("mcp__localgit");
    expect(flagValues(uses.argv, "--disallowedTools")).not.toContain("mcp__localgit");
    expect(away.cwd).toBe(c);
    expect(flagValues(away.argv, "--allowedTools")).toContain("mcp__othergit");
    expect(flagValues(away.argv, "--disallowedTools")).not.toContain("mcp__localgit");
  } finally { await s.stop(); }
});

test("E9.34-3 a resume reads the servers again, so a fixed connection is seen", async ({ chief }) => {
  const a = join(chief.dir, "flows", "r");
  folderServers(a, ["authgit: https://example.test/mcp (HTTP) - ✔ Connected"]);
  writeAndImport(chief, a, [
    "name: wr", "nodes:",
    "  - { id: ok, type: gate, kind: approve, value: go }",
    `  - { id: pr, type: agent, mcp: [authgit], prompt: 'Read the PR ${fake({ by_start: [{ output: { status: "mcp_unavailable", server: "authgit", error: "404 Not Found" } }, { output: { title: "the PR" } }] })}' }`,
    "edges: [ok -> pr]", "",
  ].join("\n"));
  const s = await chief.serve();
  try {
    const run = (await s.api("POST", "/api/runs", { workflow: "wr" })).body.run.id;
    const waiting = await status(s, run, "waiting_gate");
    // The connection breaks while the run waits; the agent reports it and the step fails with its error.
    folderServers(a, ["authgit: https://example.test/mcp (HTTP) - ! Needs authentication"]);
    await s.api("POST", `/api/gates/${waiting.gates[0].id}/answer`, { answer: { decision: "approve" } });
    let d = await status(s, run, "failed");
    expect(d.node_runs.find((n: any) => n.node_id === "pr").error).toContain("404 Not Found");
    const callsBefore = chief.calls().length;

    // Resumed while it still needs authentication: the servers are read again and the step fails at once, without calling the CLI.
    const reads0 = chief.mcpReads().control;
    await s.api("POST", `/api/runs/${run}/resume`);
    d = await status(s, run, "failed");
    expect(chief.mcpReads().control).toBeGreaterThan(reads0);
    expect(d.node_runs.filter((n: any) => n.node_id === "pr").at(-1).error).toMatch(/not connected to MCP server "authgit"/);
    expect(chief.calls().length).toBe(callsBefore);

    // Fixed, then resumed: the step runs again and the run completes.
    folderServers(a, ["authgit: https://example.test/mcp (HTTP) - ✔ Connected"]);
    await s.api("POST", `/api/runs/${run}/resume`);
    d = await status(s, run, "completed");
    expect(d.node_runs.filter((n: any) => n.node_id === "pr").at(-1).output).toMatchObject({ title: "the PR" });
  } finally { await s.stop(); }
});

test("E9.34-4 chief mcp list shows the servers of a folder", async ({ chief }) => {
  const a = join(chief.dir, "flows", "l"), other = join(chief.dir, "elsewhere");
  folderServers(a, ["localgit: https://example.test/mcp (HTTP) - ✔ Connected"]);
  mkdirSync(other, { recursive: true });
  writeAndImport(chief, a, `name: wl\nnodes:\n  - { id: x, type: agent, mcp: [], prompt: 'X ${fake({ output: { n: 1 } })}' }\n`);

  const here = chief.run(["mcp", "list"], { cwd: a });
  expect(here.stdout).toContain(`MCP servers for ${a}:`);
  expect(here.stdout).toMatch(/^localgit\s/m);
  const there = chief.run(["mcp", "list"], { cwd: other });
  expect(there.stdout).toContain(`MCP servers for ${other}:`);
  expect(there.stdout).not.toMatch(/^localgit\s/m);
  expect(there.stdout).toMatch(/^github-custom\s/m);
  const byName = chief.run(["mcp", "list", "--workflow", "wl"], { cwd: other });
  expect(byName.stdout).toContain(`MCP servers for ${a} (the folder of workflow wl):`);
  expect(byName.stdout).toMatch(/^localgit\s/m);
  expect(chief.run(["mcp", "list", "--workflow", "wl", "--json"], { cwd: other }).json().map((r: any) => r.name)).toContain("localgit");
});

test("E9.35-1 chief serve prints a log of what it does", async ({ chief }) => {
  chief.importWorkflow(`name: logged\nnodes:\n  - { id: work, type: agent, mcp: [], prompt: 'Work ${fake({ output: { ok: 1 } })}' }\n  - { id: check, type: gate, kind: approve, value: go }\nedges: [work -> check]\n`);
  const s = await chief.serve();
  try {
    const run = (await s.api("POST", "/api/runs", { workflow: "logged" })).body.run.id;
    const waiting = await status(s, run, "waiting_gate");
    for (let i = 0; i < 3; i++) await s.api("GET", "/api/runs");
    await s.api("PUT", "/api/drafts/some-field", { value: "typing", seq: 1 });
    await s.api("POST", `/api/gates/${waiting.gates[0].id}/answer`, { answer: { decision: "approve" } });
    await status(s, run, "completed");
    await s.api("DELETE", "/api/runs/999");
    await until(async () => s.output().includes("DELETE /api/runs/999"));
    const out = s.output();
    const line = (re: RegExp) => expect(out, String(re)).toMatch(new RegExp(`^\\d\\d:\\d\\d:\\d\\d ${re.source}`, "m"));
    line(/database .*chief\.db/);
    line(/workflow folders in .*workspace/);
    line(/POST \/api\/runs 201 \d+ms/);
    line(new RegExp(`run #${run} \\(logged\\) started`));
    line(new RegExp(`run #${run} \\(logged\\): step work started`));
    line(new RegExp(`run #${run} \\(logged\\): step work completed`));
    line(new RegExp(`run #${run} \\(logged\\): step check is waiting for your answer \\(approve gate\\)`));
    line(new RegExp(`POST /api/gates/\\d+/answer 200`));
    line(new RegExp(`run #${run} \\(logged\\) completed`));
    line(/MCP servers of claude-code in \/.+: 5 \(1 not connected\) \(\d+ ms\)/);
    line(/DELETE \/api\/runs\/999 404 \d+ms: run 999 not found/);
    // What the page asks all the time is not in it.
    expect(out).not.toMatch(/GET \/api\/runs /);
    expect(out).not.toMatch(/\/api\/drafts/);
  } finally { await s.stop(); }

  // CHIEF_LOG=debug: every request too.
  const d = await chief.serve({ env: { CHIEF_LOG: "debug" } });
  try {
    await d.api("GET", "/api/runs");
    await until(async () => /GET \/api\/runs 200/.test(d.output()));
    expect(d.output()).toContain("every request (CHIEF_LOG=debug)");
  } finally { await d.stop(); }

  // Other commands print no log lines: their output is their result.
  const listed = chief.run(["runs", "list", "--json"]);
  expect(() => JSON.parse(listed.stdout)).not.toThrow();
  expect(chief.run(["mcp", "list", "--json"]).stdout.trim().startsWith("[")).toBe(true);
});
