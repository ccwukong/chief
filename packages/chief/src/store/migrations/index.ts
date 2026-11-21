import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The migration files are read from disk: Node has no import attribute that loads a `.sql` file as
 * text, so the SQL is read at startup. It is the same numbered files, unchanged once applied.
 *
 * Two places are tried because the module moves: beside this file when chief runs from source
 * (`src/store/migrations/`), and in `migrations/` beside the bundle when it runs from `dist/`
 * (scripts/build.ts copies them there).
 */
const here = import.meta.dirname;
const sql = (file: string) => {
  for (const dir of [here, join(here, "migrations")]) {
    try { return readFileSync(join(dir, file), "utf8"); } catch { /* try the next place */ }
  }
  throw new Error(`migration ${file} is missing next to ${here}`);
};

/** Numbered migrations, applied in order. Add new files here; never edit an applied one. */
export const migrations: { id: number; name: string; sql: string }[] = [
  { id: 1, name: "001-init", sql: sql("001-init.sql") },
  { id: 2, name: "002-run-messages-no-backlog", sql: sql("002-run-messages-no-backlog.sql") },
  { id: 3, name: "003-schemas-and-drafts", sql: sql("003-schemas-and-drafts.sql") },
  { id: 4, name: "004-mcp-per-folder", sql: sql("004-mcp-per-folder.sql") },
  { id: 5, name: "005-assistant", sql: sql("005-assistant.sql") },
  { id: 6, name: "006-assistant-threads", sql: sql("006-assistant-threads.sql") },
  { id: 7, name: "007-text-size-default", sql: sql("007-text-size-default.sql") },
  { id: 8, name: "008-workflow-archive", sql: sql("008-workflow-archive.sql") },
  { id: 9, name: "009-assistant-memory", sql: sql("009-assistant-memory.sql") },
];
