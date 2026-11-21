import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
/**
 * Where the desktop app keeps what it writes. Everything is under chief's own folder, `~/.chief`
 * (dev plan §3 "Where chief keeps things"): the database and the workflow folders belong to the
 * server and are chosen by its own `paths.ts`; the wrapper adds the server's log and Electron's own
 * profile (cache, cookies) beside them, so one folder holds all of it and none of it lands in
 * `~/Library/Application Support` or in the checkout. A `CHIEF_HOME` in the environment (a test, or a
 * deliberately separate install) moves all three together, the same way the server derives its
 * workspace.
 */
export function chiefRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = resolve(env.CHIEF_HOME || join(homedir(), ".chief", "state"));
  return dirname(home);
}
export const logDir = (root: string) => join(root, "logs");
export const logFile = (root: string) => join(logDir(root), "chief.log");
export const profileDir = (root: string) => join(root, "desktop");
