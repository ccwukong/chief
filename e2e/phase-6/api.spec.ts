import { request } from "node:http";
import { networkInterfaces } from "node:os";
import { expect, fake, test, type Server } from "../helpers";

const until = async <T>(fn: () => Promise<T | false | null | undefined>, ms = 15_000): Promise<T> => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
};
const runStatus = (s: Server, id: number, status: string) => until(async () => { const d = (await s.api("GET", `/api/runs/${id}`)).body; return d.run?.status === status ? d : null; });

const def = (name: string, nodes: object[], edges: string[] = []) => ({ name, nodes, edges });
const agent = (id: string, prompt: string, extra: object = {}) => ({ id, type: "agent", prompt, ...extra });

test("E6.1-1 the server answers on 127.0.0.1 only", async ({ chief }) => {
  const s = await chief.serve();
  try {
    const doc = await s.api("GET", "/api/doctor");
    expect(doc.status).toBe(200);
    expect(doc.body).toMatchObject({ ok: true, sandbox: { available: true } });
    expect((await s.api("GET", "/api/workflows")).body).toEqual([]);
    expect((await s.api("GET", "/api/runs")).body).toEqual([]);
    expect((await s.api("GET", "/api/meta")).body).toMatchObject({ adapters: expect.arrayContaining(["claude-code"]), default_adapter: "claude-code" });
    expect((await s.api("GET", "/api/nope")).status).toBe(404);

    const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address;
    if (lan) await expect(fetch(`http://${lan}:${s.port}/api/doctor`, { signal: AbortSignal.timeout(3000) })).rejects.toThrow();
  } finally { await s.stop(); }
});

test("E6.1-2 workflows over REST: save, validate, export, delete", async ({ chief }) => {
  const s = await chief.serve();
  try {
    const good = def("rest", [agent("a", "hello"), agent("b", "after {{nodes.a.output.ok}}")], ["a -> b"]);
    const saved = await s.api("PUT", "/api/workflows/rest", { definition: good, base_dir: chief.dir });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ name: "rest", version: 1, base_dir: chief.dir, approvals: [] });
    expect((await s.api("PUT", "/api/workflows/rest", { definition: good, base_dir: chief.dir })).body.version).toBe(1);

    const bad = def("rest", [agent("a", "see {{nodes.zzz.output}}")], ["a -> a"]);
    const rejected = await s.api("PUT", "/api/workflows/rest", { definition: bad });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toContain("invalid workflow");
    expect(rejected.body.error).toContain("a node cannot depend on itself");
    expect((await s.api("PUT", "/api/workflows/other", { definition: good })).status).toBe(400);

    const v = await s.api("POST", "/api/workflows/validate", { definition: bad });
    expect(v.status).toBe(200);
    expect(v.body.ok).toBe(false);
    const ok = await s.api("POST", "/api/workflows/validate", { yaml: "name: y\nnodes:\n  - { id: a, type: agent, prompt: hi, mcp: [ghost] }\n" });
    expect(ok.body).toMatchObject({ ok: true, errors: [] });
    expect(ok.body.environment.join("\n")).toContain('claude-code has no MCP server named "ghost"');
    expect(ok.body.estimates).toEqual([{ node_id: "a", chars: 2, est_tokens: 1 }]);

    const got = await s.api("GET", "/api/workflows/rest");
    expect(got.body.definition.edges).toEqual([{ from: "a", to: "b" }]);
    const yaml = (await s.api("GET", "/api/workflows/rest/export")).body as string;
    expect(yaml).toBe(chief.run(["workflow", "export", "rest"]).stdout);
    expect((await s.api("GET", "/api/workflows/rest/export?format=json")).body.name).toBe("rest");

    const imported = await s.api("POST", "/api/workflows/import", { yaml: yaml.replace("name: rest", "name: copy"), base_dir: chief.dir });
    expect(imported.status).toBe(201);
    expect((await s.api("GET", "/api/workflows")).body.map((w: any) => w.name)).toEqual(["copy", "rest"]);
    expect((await s.api("DELETE", "/api/workflows/copy")).status).toBe(200);
    expect((await s.api("GET", "/api/workflows/copy")).status).toBe(404);

    // A workflow that has runs cannot be deleted; sandbox rules are the same as in the CLI.
    await s.api("POST", "/api/runs", { workflow: "rest" });
    expect((await s.api("DELETE", "/api/workflows/rest")).status).toBe(409);
    const off = await s.api("PUT", "/api/workflows/off", { definition: def("off", [{ id: "s", type: "script", run: "x.sh", sandbox: "off" }]) });
    expect(off.status).toBe(400);
    expect(off.body.error).toContain("the script sandbox cannot be disabled");
  } finally { await s.stop(); }
});

test("E6.1-3 runs over REST: start, gate, pause, resume, cancel, revert", async ({ chief }) => {
  const s = await chief.serve();
  try {
    await s.api("PUT", "/api/workflows/flow", { base_dir: chief.dir, definition: def("flow", [
      agent("write", `W ${fake({ output: { side_effects: [{ kind: "doc", ref: "d1" }] } })}`, { compensate: { prompt: `UNDO ${fake({ output: { reverted: ["d1"], failed: [] } })}` } }),
      { id: "ok", type: "gate", kind: "approve", value: "{{inputs.msg}}" },
      agent("slow", `S {{nodes.ok.output.value}} ${fake({ sleep_ms: 60000 }, { output: { done: true } })}`),
    ], ["write -> ok", "ok -> slow"]) });

    const started = await s.api("POST", "/api/runs", { workflow: "flow", inputs: { msg: "ship it" } });
    expect(started.status).toBe(201);
    const id = started.body.run.id;
    let d = await runStatus(s, id, "waiting_gate");
    const gate = d.gates[0];
    expect(gate).toMatchObject({ kind: "approve", payload: { value: "ship it" } });
    expect((await s.api("GET", "/api/gates")).body.map((g: any) => g.id)).toEqual([gate.id]);

    expect((await s.api("POST", `/api/gates/${gate.id}/answer`, { answer: { decision: "maybe" } })).status).toBe(400);
    expect((await s.api("POST", `/api/gates/${gate.id}/answer`, { answer: { decision: "approve", value: "ship it now" } })).status).toBe(200);
    await until(async () => chief.calls().length === 2);
    expect(chief.calls()[1].prompt).toContain("S ship it now");

    expect((await s.api("POST", `/api/runs/${id}/pause`)).status).toBe(200);
    d = await runStatus(s, id, "paused");
    expect(d.node_runs.find((n: any) => n.node_id === "slow").status).toBe("interrupted");
    expect((await s.api("POST", `/api/runs/${id}/pause`)).status).toBe(400);

    expect((await s.api("POST", `/api/runs/${id}/resume`)).status).toBe(200);
    d = await runStatus(s, id, "completed");
    expect(chief.calls()[2].resume).toBe(chief.calls()[1].session);

    const report = await s.api("POST", `/api/runs/${id}/revert`, {});
    expect(report.status).toBe(200);
    expect(report.body).toMatchObject({ compensated: ["write"], reverted_effects: 1, manual: [] });
    expect((await s.api("GET", `/api/runs/${id}`)).body.run.status).toBe("reverted");

    // Cancel a second run while its agent is working.
    const second = (await s.api("POST", "/api/runs", { workflow: "flow", inputs: { msg: "x" } })).body.run.id;
    d = await runStatus(s, second, "waiting_gate");
    await s.api("POST", `/api/gates/${d.gates[0].id}/answer`, { answer: { decision: "approve" } });
    await until(async () => (await s.api("GET", `/api/runs/${second}`)).body.node_runs.some((n: any) => n.node_id === "slow" && n.status === "running"));
    expect((await s.api("POST", `/api/runs/${second}/cancel`)).status).toBe(200);
    await runStatus(s, second, "cancelled");
    expect((await s.api("POST", `/api/runs/${second}/resume`)).status).toBe(400);
    expect((await s.api("GET", "/api/runs/999")).status).toBe(404);
    expect((await s.api("POST", "/api/runs", { workflow: "ghost" })).status).toBe(404);
  } finally { await s.stop(); }
});

/** Read an SSE response into a growing list of events. */
function sse(url: string) {
  const events: { event: string; data: any; id?: string }[] = [];
  const ctrl = new AbortController();
  let closed = false;
  const done = (async () => {
    const res = await fetch(url, { signal: ctrl.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev: any = { event: "message" };
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) ev.event = line.slice(7);
          else if (line.startsWith("data: ")) ev.data = JSON.parse(line.slice(6));
          else if (line.startsWith("id: ")) ev.id = line.slice(4);
        }
        if (ev.data !== undefined) events.push(ev);
      }
    }
    closed = true;
  })().catch((e) => { if (e.name !== "AbortError") throw e; });
  return { events, close: () => ctrl.abort(), done, isClosed: () => closed };
}

test("E6.1-4 run events stream live over SSE and survive a long idle period", async ({ chief }) => {
  test.setTimeout(60_000);
  const s = await chief.serve();
  try {
    await s.api("PUT", "/api/workflows/live", { base_dir: chief.dir, definition: def("live", [
      agent("a", `A ${fake({ sleep_ms: 600 })}`),
      { id: "g", type: "gate", kind: "approve", value: "go" },
      agent("b", "B"),
    ], ["a -> g", "g -> b"]) });
    const id = (await s.api("POST", "/api/runs", { workflow: "live" })).body.run.id;
    const stream = sse(`${s.url}/api/runs/${id}/events`);

    // Events arrive while the agent is still working, not only at the end.
    await until(async () => stream.events.some((e) => e.event === "node_running"));
    expect(stream.events.some((e) => e.event === "node_completed")).toBe(false);
    await until(async () => stream.events.some((e) => e.event === "gate_opened"));
    const gateId = stream.events.find((e) => e.event === "gate_opened")!.data.payload.gate_id;

    // Nothing happens for longer than 10 s; the stream must stay open.
    const before = stream.events.length;
    await new Promise((r) => setTimeout(r, 12_500));
    expect(stream.isClosed()).toBe(false);
    expect(stream.events.length).toBe(before);

    await s.api("POST", `/api/gates/${gateId}/answer`, { answer: { decision: "approve" } });
    await until(async () => stream.events.some((e) => e.event === "end"));
    await stream.done;
    const types = stream.events.map((e) => e.event);
    expect(types.filter((t) => /^(run_|gate_|end)/.test(t))).toEqual(["run_created", "run_started", "gate_opened", "run_waiting", "gate_answered", "run_completed", "end"]);
    const ids = stream.events.filter((e) => e.id).map((e) => Number(e.id));
    expect(ids).toEqual([...ids].sort((x, y) => x - y));
    expect(stream.events.at(-1)!.data).toEqual({ status: "completed" });

    // Reconnecting with ?after= replays only what is newer; the JSON form returns the same rows.
    const all = (await s.api("GET", `/api/runs/${id}/events?format=json`)).body;
    expect(all.map((e: any) => e.id)).toEqual(ids);
    const tail = (await s.api("GET", `/api/runs/${id}/events?format=json&after=${ids[ids.length - 2]}`)).body;
    expect(tail).toHaveLength(1);
  } finally { await s.stop(); }
});

test("E6.1-5 settings over REST persist across a restart; MCP servers are read-only; there is no backlog", async ({ chief }) => {
  let s = await chief.serve();
  try {
    // The backlog was removed from the product.
    expect((await s.api("GET", "/api/backlog")).status).toBe(404);
    expect((await s.api("POST", "/api/backlog", { title: "x" })).status).toBe(404);

    // MCP servers are read-only here: the list is whatever the agent CLI reports.
    expect((await s.api("GET", "/api/mcp")).body.map((m: any) => m.name)).toEqual(["atlassian", "github-custom", "google-drive", "notion", "slack"]);
    const refreshed = await s.api("POST", "/api/mcp/refresh");
    expect(refreshed.body.result["claude-code"]).toMatchObject({ count: 5 });
    expect(refreshed.body.servers).toHaveLength(5);
    expect((await s.api("POST", "/api/mcp", { name: "local-files", config: {} })).status).toBe(404);
    expect((await s.api("DELETE", "/api/mcp/claude-code/notion")).status).toBe(404);
    expect((await s.api("POST", "/api/mcp/discover")).status).toBe(404);

    const settings = await s.api("PUT", "/api/settings", { "default-budget": { "max-usd": 3 }, notify: false, "claude-code.path": chief.env.CHIEF_CLAUDE_BIN });
    expect(settings.body).toMatchObject({ "default-budget": { "max-usd": 3 }, notify: false });

    const sched = await s.api("POST", "/api/schedules", { workflow: "nope", cron: "* * * * *" });
    expect(sched.status).toBe(404);
  } finally { await s.stop(); }

  s = await chief.serve();
  try {
    expect((await s.api("GET", "/api/settings")).body).toMatchObject({ "default-budget": { "max-usd": 3 }, notify: false });
    expect(chief.run(["settings", "get", "notify", "--json"]).json()).toBe(false);
  } finally { await s.stop(); }
});

test("E6.1-6 requests with a foreign Host or Origin are rejected", async ({ chief }) => {
  const s = await chief.serve();
  try {
    const raw = (headers: Record<string, string>, method = "GET", path = "/api/workflows") => new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: s.port, path, method, headers }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on("error", reject);
      req.end();
    });
    expect(await raw({ Host: `127.0.0.1:${s.port}` })).toBe(200);
    expect(await raw({ Host: `localhost:${s.port}` })).toBe(200);
    expect(await raw({ Host: "evil.example" })).toBe(403);
    expect(await raw({ Host: `evil.example:${s.port}` })).toBe(403);
    expect(await raw({ Host: `127.0.0.1:${s.port}`, Origin: "https://evil.example" })).toBe(403);
    expect(await raw({ Host: `127.0.0.1:${s.port}`, Origin: `http://127.0.0.1:${s.port}` })).toBe(200);
    expect(await raw({ Host: `127.0.0.1:${s.port}`, Origin: "https://evil.example" }, "POST", "/api/runs")).toBe(403);
    expect(await raw({ Host: "evil.example" }, "GET", "/")).toBe(403);
  } finally { await s.stop(); }
});

test("E9.24-1 chief serve listens on port 8080 by default", async ({ chief }) => {
  expect(chief.run(["help"]).stdout).toMatch(/serve \[--port n\].*default port 8080/);
  const { proc, done } = chief.start(["serve"]);
  let out = "";
  proc.stdout!.on("data", (d) => (out += d));
  proc.stderr!.on("data", (d) => (out += d));
  try {
    await until(async () => out.includes("http://127.0.0.1:8080") || (proc.exitCode !== null && Promise.reject(new Error("chief serve exited (is port 8080 in use?):\n" + out))));
    const res = await fetch("http://127.0.0.1:8080/api/meta");
    expect(res.status).toBe(200);
  } finally { proc.kill("SIGTERM"); await done; }
});
