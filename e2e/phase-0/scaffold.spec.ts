import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, ROOT_DIR as ROOT, test } from "../helpers";

test("E0.1-1 Claude Code adapter notes cover the headless contract", () => {
  const doc = readFileSync(join(ROOT, "docs/adapters/claude-code.md"), "utf8");
  for (const topic of ["stream-json", "--resume", "SIGINT", "--allowedTools", "--strict-mcp-config", "total_cost_usd", "permission_denials"]) expect(doc).toContain(topic);
});

test("E0.1-2 @real one agent node runs through the real Claude Code CLI", async ({ chief }) => {
  test.setTimeout(180_000);
  const env = { CHIEF_CLAUDE_BIN: "claude" };
  expect(chief.importWorkflow(`
name: real-smoke
nodes:
  - id: hello
    type: agent
    model: haiku
    prompt: 'Reply with the JSON object {"greeting": "hello"} as instructed below. Do not use any tools.'
    output-schema: { greeting: string }
`).code).toBe(0);
  const r = chief.run(["run", "real-smoke", "--json"], { env });
  expect(r.code, r.stdout + r.stderr).toBe(0);
  const d = r.json();
  expect(d.run.status).toBe("completed");
  expect(d.node_runs[0].output.greeting).toBe("hello");
  expect(d.node_runs[0].session_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(d.run.cost_usd).toBeGreaterThan(0);
});

test("E0.2-1 Codex adapter notes exist", () => {
  test.skip(!existsSync(join(ROOT, "docs/adapters/codex.md")), "task 0.2 is blocked: Codex CLI is not installed");
  expect(readFileSync(join(ROOT, "docs/adapters/codex.md"), "utf8")).toMatch(/not verified/i);
});

test("E0.3-1 Cursor adapter notes exist", () => {
  test.skip(!existsSync(join(ROOT, "docs/adapters/cursor.md")), "task 0.3 is blocked: cursor-agent is not installed");
  expect(readFileSync(join(ROOT, "docs/adapters/cursor.md"), "utf8")).toMatch(/not verified/i);
});

test("E0.4-1 --help lists the commands", ({ chief }) => {
  const r = chief.run(["--help"]);
  expect(r.code).toBe(0);
  for (const c of ["doctor", "mcp", "models", "workflow", "run", "runs", "gate", "revert", "settings"]) expect(r.stdout).toContain(c);
});

test("E0.4-2 unknown command fails with usage", ({ chief }) => {
  const r = chief.run(["frobnicate"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("unknown command: frobnicate");
  expect(r.stderr).toContain("Usage: chief");
});

test("E0.4-3 workspace layout and kebab-case file names", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  expect(pkg.workspaces).toEqual(["packages/*"]);
  expect(existsSync(join(ROOT, "packages/chief/package.json"))).toBe(true);
  expect(existsSync(join(ROOT, "packages/web/package.json"))).toBe(true);
  const bad: string[] = [];
  const allowed = new Set(["README.md", "LICENSE", "Dockerfile"]);
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (["node_modules", "dist", ".tmp", ".git", "test-results", "playwright-report"].includes(name) || name.startsWith(".")) continue;
      const p = join(dir, name);
      if (!allowed.has(name) && !/^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+)*$/.test(name)) bad.push(p.slice(ROOT.length + 1));
      if (statSync(p).isDirectory()) walk(p);
    }
  };
  for (const d of ["docs", "packages", "e2e", "examples"]) if (existsSync(join(ROOT, d))) walk(join(ROOT, d));
  expect(bad).toEqual([]);
});

test("E0.5-1 the database is created and migrated on first use", ({ chief }) => {
  expect(existsSync(join(chief.home, "chief.db"))).toBe(false);
  const d = chief.run(["doctor", "--json"]).json();
  expect(existsSync(join(chief.home, "chief.db"))).toBe(true);
  expect(d.db.ok).toBe(true);
  expect(d.db.migrations).toBeGreaterThanOrEqual(1);
  expect(d.db.latest).toMatch(/^\d{3}-/);
});

test("E0.5-2 data persists and migrations are not re-applied", ({ chief }) => {
  const before = chief.run(["doctor", "--json"]).json().db.migrations;
  expect(chief.run(["settings", "set", "default-budget", '{"max-usd": 5}']).code).toBe(0);
  expect(chief.run(["settings", "get", "default-budget", "--json"]).json()).toEqual({ "max-usd": 5 });
  expect(chief.run(["doctor", "--json"]).json().db.migrations).toBe(before);
});

test("E0.5-3 doctor reports the CLI, the database and the sandbox", ({ chief }) => {
  const r = chief.run(["doctor"]);
  expect(r.code, r.stdout + r.stderr).toBe(0);
  expect(r.stdout).toMatch(/claude-code \*\s+yes\s+2\.1\.311/);
  expect(r.stdout).toContain("database");
  expect(r.stdout).toMatch(/sandbox\s+ok \(sandbox-exec\)\s+→ script nodes enabled/);
  expect(r.stdout).toContain("All good.");
});

test("E0.5-4 doctor fails when the agent CLI is missing", ({ chief }) => {
  const r = chief.run(["doctor", "--json"], { env: { CHIEF_CLAUDE_BIN: "/nonexistent/claude" } });
  expect(r.code).toBe(1);
  const d = r.json();
  expect(d.ok).toBe(false);
  expect(d.adapters.find((a: any) => a.name === "claude-code").found).toBe(false);
});

test("E0.5-5 doctor fails when the agent CLI is too old", ({ chief }) => {
  const r = chief.run(["doctor"], { env: { FAKE_CLAUDE_VERSION: "2.0.14" } });
  expect(r.code).toBe(1);
  expect(r.stdout).toMatch(/needs 2\.1\.300 or newer/);
});

test("E0.6-1 mcp list shows the servers the agent CLI has right now", ({ chief }) => {
  const list = chief.run(["mcp", "list", "--json"]).json();
  expect(list.map((s: any) => s.name)).toEqual(["atlassian", "github-custom", "google-drive", "notion", "slack"]);
  const slack = list.find((s: any) => s.name === "slack");
  expect(slack).toMatchObject({ adapter: "claude-code", config: { cli_name: "claude.ai Slack", status: "connected", tool_prefix: "mcp__claude_ai_Slack", scope: "connector" } });
  expect(list.find((s: any) => s.name === "notion").config.status).toBe("needs-auth");
  // Read over the CLI's control interface, not from the slow `claude mcp list` health check.
  expect(chief.mcpReads()).toEqual({ control: 1, probes: 0, lists: 0 });
  const text = chief.run(["mcp", "list"]).stdout;
  expect(text).toMatch(/slack\s+claude-code\s+connected\s+claude\.ai Slack/);
  expect(text).toContain("chief does not configure MCP servers");
});

test("E0.6-2 chief has no commands to add, remove or discover MCP servers", ({ chief }) => {
  for (const sub of ["add", "rm", "discover"]) {
    const r = chief.run(["mcp", sub, "local-files", "--config", "{}"]);
    expect(r.code, sub).toBe(1);
    expect(r.stderr, sub).toContain("unknown command: mcp " + sub);
  }
  const help = chief.run(["--help"]).stdout;
  expect(help).toContain("mcp list");
  expect(help).not.toMatch(/mcp (add|discover)/);
});

test("E0.6-3 a change in the agent CLI's servers shows up on the next read, with nothing stale", ({ chief }) => {
  expect(chief.run(["mcp", "list", "--json"]).json()).toHaveLength(5);
  const changed = chief.file("mcp-list.txt", "claude.ai Slack: https://mcp.slack.com/mcp - ✘ Failed to connect\nclaude.ai Linear: https://mcp.linear.app/mcp - ✔ Connected\n");
  const env = { FAKE_CLAUDE_MCP_LIST: changed };
  const now = chief.run(["mcp", "list", "--json"], { env }).json();
  expect(now.map((s: any) => [s.name, s.config.status])).toEqual([["linear", "connected"], ["slack", "failed"]]);
  // --cached shows the last answer without asking again.
  const before = chief.mcpReads().control;
  expect(chief.run(["mcp", "list", "--cached", "--json"]).json()).toHaveLength(2);
  expect(chief.mcpReads().control).toBe(before);
});
