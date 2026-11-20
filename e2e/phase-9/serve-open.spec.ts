import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../helpers";

/** Task 9.63: `chief serve` opens the web UI in the browser once it listens. */

test("E9.63-1 chief serve opens the web UI once it listens; --no-open and a missing opener do not stop it", async ({ chief }) => {
  const log = join(chief.dir, "opened.log");
  const opener = chief.file("opener.sh", `#!/bin/sh\necho "$@" >> "${log}"\n`, 0o755);
  const opened = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
  /** Start `chief serve` and return its URL and a reader of its terminal output. */
  const start = async (args: string[], env: Record<string, string>) => {
    const { proc } = chief.start(["serve", "--port", "0", ...args], { env });
    let out = "";
    proc.stdout!.on("data", (d) => (out += d));
    proc.stderr!.on("data", (d) => (out += d));
    const url = await chief.until(() => out.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] || (proc.exitCode !== null ? Promise.reject(new Error("chief serve exited:\n" + out)) : ""), 15_000);
    return { proc, url, out: () => out, stop: () => new Promise<void>((res) => { proc.once("close", () => res()); proc.kill("SIGTERM"); }) };
  };

  // The opener is called once, with the URL, and the terminal says so.
  const a = await start([], { CHIEF_BROWSER: opener });
  await chief.until(() => opened().length > 0, 5_000);
  expect(opened()).toEqual([a.url]);
  expect((await fetch(`${a.url}/api/meta`)).status).toBe(200);
  await chief.until(() => a.out().includes(`opened ${a.url} in your browser`), 5_000);
  await a.stop();

  // --no-open: not called, nothing said.
  const b = await start(["--no-open"], { CHIEF_BROWSER: opener });
  await new Promise((r) => setTimeout(r, 500));
  expect(opened()).toEqual([a.url]);
  expect(b.out()).not.toMatch(/browser/);
  await b.stop();

  // A command that does not exist: logged with the URL to open by hand; the server runs on.
  const c = await start([], { CHIEF_BROWSER: "/nonexistent/browser" });
  await chief.until(() => c.out().includes("could not open the browser"), 5_000);
  expect(c.out()).toContain(`open ${c.url} yourself`);
  expect((await fetch(`${c.url}/api/meta`)).status).toBe(200);
  await c.stop();
});
