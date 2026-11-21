/**
 * What the fake agent CLIs need from the runtime, on Node.
 *
 * `process.exit()` does not wait for a pipe's pending writes, so a fake that prints its stream-json
 * lines and exits at once loses some of them (`claude` writes to a pipe that chief reads line by
 * line). `exitAfterFlush` waits for stdout and stderr to drain first.
 */
import { writeSync } from "node:fs";

export const exitAfterFlush = async (code = 0): Promise<never> => {
  await new Promise<void>((r) => process.stdout.write("", () => r()));
  await new Promise<void>((r) => process.stderr.write("", () => r()));
  process.exit(code);
};

/** stdin as text: the prompt an agent CLI writes to the child. */
export const readStdin = async () => {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

/** Wait, without keeping the process alive. */
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Exit at once from a synchronous place, writing a message straight to stderr first. */
export const die = (code: number, message?: string): never => {
  if (message) { try { writeSync(2, message.endsWith("\n") ? message : message + "\n"); } catch { /* stderr closed */ } }
  process.exit(code);
};
