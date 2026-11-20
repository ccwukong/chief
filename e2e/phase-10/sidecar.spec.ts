import { expect, fake, test } from "../helpers";
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/**
 * What the desktop app relies on from the server it starts (dev plan §7, task 10.2): `chief serve`
 * ends its agent CLIs when it is stopped, and ends itself when the program that started it is gone.
 */
test("E10.2-5 chief serve ends its agent CLIs on SIGTERM, and exits when its parent's pipe closes", async ({ chief }) => {
  chief.importWorkflow(`name: slow\nnodes:\n  - { id: a, type: agent, prompt: 'A ${fake({ sleep_ms: 60000, output: { x: 1 } })}' }\n`);
  // SIGTERM: the run's agent CLI does not outlive the server.
  const s1 = await chief.serve();
  await s1.api("POST", "/api/runs", { workflow: "slow" });
  await expect.poll(() => chief.calls().length, { timeout: 15_000 }).toBe(1);
  const agent = chief.calls()[0].pid;
  expect(alive(agent)).toBe(true);
  await s1.stop();
  await expect.poll(() => alive(agent), { timeout: 10_000 }).toBe(false);
  // Closing the stdin pipe, as happens when the desktop app is killed: the server follows.
  const { proc } = chief.start(["serve", "--port", "0", "--no-open"], { env: { CHIEF_EXIT_WITH_PARENT: "1" } });
  let out = "";
  proc.stdout!.on("data", (d) => (out += d));
  await chief.until(() => /127\.0\.0\.1:\d+/.test(out));
  const exited = new Promise<number | null>((res) => proc.once("exit", res));
  proc.stdin!.end();
  expect(await exited).toBe(0);
  // Without the variable, a closed stdin changes nothing (a `chief serve` in a terminal or under a supervisor).
  const plain = chief.start(["serve", "--port", "0", "--no-open"]);
  let out2 = "";
  plain.proc.stdout!.on("data", (d) => (out2 += d));
  await chief.until(() => /127\.0\.0\.1:\d+/.test(out2));
  plain.proc.stdin!.end();
  await new Promise((r) => setTimeout(r, 1500));
  expect(plain.proc.exitCode).toBeNull();
  plain.proc.kill("SIGTERM");
  await plain.done;
});
