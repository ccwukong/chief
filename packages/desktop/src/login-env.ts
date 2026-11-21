import { spawn } from "node:child_process";
const START = "__CHIEF_ENV_START__";
/** Parse `env -0` output (NUL-separated KEY=VALUE) that follows the marker line. */
export function parseEnv(output: string): Record<string, string> {
  const at = output.lastIndexOf(START);
  const body = at < 0 ? "" : output.slice(at + START.length).replace(/^\r?\n/, "");
  const env: Record<string, string> = {};
  for (const entry of body.split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.slice(0, eq))) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}
/**
 * The environment a person has in a terminal. An app opened from Finder gets `/usr/bin:/bin:/usr/sbin:/sbin`,
 * where no agent CLI is, so chief would report every adapter as not installed. The login shell is
 * asked once (it reads the person's own `.zprofile` / `.zshrc`), with a timeout; when it cannot
 * answer, the environment the app was given is used as it is. Variables the shell exports (an
 * `ANTHROPIC_API_KEY`) come along.
 */
export async function loginEnvironment(base: NodeJS.ProcessEnv, timeoutMs = 8000): Promise<{ env: NodeJS.ProcessEnv; from: string }> {
  const shell = base.SHELL || "/bin/zsh";
  return new Promise((resolve) => {
    const fallback = (why: string) => resolve({ env: base, from: `the app's own environment (${why})` });
    let out = "";
    let done = false;
    const child = spawn(shell, ["-ilc", `echo ${START}; env -0`], { env: base, stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => { if (!done) { done = true; child.kill("SIGKILL"); fallback(`${shell} did not answer in ${timeoutMs / 1000} s`); } }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.on("error", (e) => { if (!done) { done = true; clearTimeout(timer); fallback(e.message); } });
    child.on("close", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const login = parseEnv(out);
      if (!login.PATH) return fallback(`${shell} printed no PATH`);
      resolve({ env: { ...base, ...login }, from: `${shell} -ilc` });
    });
  });
}
