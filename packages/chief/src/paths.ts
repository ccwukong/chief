import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Root of chief's local state: `~/.chief/state`, or `CHIEF_HOME` when that is set (the e2e suite gives
 * every case its own). Outside any checkout, for the reasons in dev plan §3 and decision 14.
 */
export function chiefHome(): string {
  const dir = resolve(process.env.CHIEF_HOME || join(homedir(), ".chief", "state"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Where workflows without a working directory of their own get one: a `workspace` folder beside the
 * home, so `~/.chief/workspace`, unless the `workspace-dir` setting names another. Kept apart from the
 * home because scripts may never read or write the home.
 */
export function defaultWorkspace(): string {
  const home = chiefHome();
  // A home that is itself called "workspace" gets "workspace-workspace", so that the two never overlap.
  return join(dirname(home), basename(home) === "workspace" ? "workspace-workspace" : "workspace");
}

export const dbPath = () => join(chiefHome(), "chief.db");

/** A folder as written in a workflow (`~/x`, absolute, or relative to the workflow's folder), made absolute. */
export const expandDir = (p: string, base: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : isAbsolute(p) ? p : resolve(base, p));

/** The folder an agent step runs in: its own `cwd`, or the workflow's folder. Its MCP servers are that folder's. */
export const agentFolder = (node: { cwd?: string } | null | undefined, baseDir: string) => resolve(node?.cwd ? expandDir(node.cwd, baseDir) : baseDir);

/** Per-node-run scratch directory, the only place a sandboxed script may always write. */
export function scratchDir(runId: number, nodeRunId: number): string {
  const dir = join(chiefHome(), "runs", String(runId), String(nodeRunId));
  mkdirSync(dir, { recursive: true });
  return dir;
}
