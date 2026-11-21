import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
const MAX_BYTES = 5 * 1024 * 1024;
/** The server's output and the wrapper's own decisions, in one file the menu can reveal. */
export class Log {
  readonly file: string;
  constructor(file: string) {
    this.file = file;
    try {
      mkdirSync(dirname(file), { recursive: true });
      // One generation of history is enough: a log of a local app that is opened every day.
      if (statSync(file).size > MAX_BYTES) renameSync(file, file + ".1");
    } catch { /* no log yet */ }
  }
  /** One line written by the wrapper. */
  note(text: string) {
    this.raw(`${new Date().toISOString()} [desktop] ${text}\n`);
  }
  /** Text from the server, kept as it came. */
  raw(text: string) {
    try { appendFileSync(this.file, text); } catch { /* a log that cannot be written must not stop the app */ }
  }
}
