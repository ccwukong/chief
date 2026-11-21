/**
 * Node 22 prints an ExperimentalWarning the first time `node:sqlite` is loaded, on every command that
 * opens the database — which is nearly all of them. chief uses `node:sqlite` on purpose (dev plan §4: one
 * SQLite file, no native addon), so the warning tells the person nothing they can act on and makes every
 * `chief` command's stderr start with two lines of noise.
 *
 * So exactly that warning is dropped. Every other warning Node raises is printed as usual: this silences
 * a fact the project already knows, not warnings in general.
 *
 * It must be the first import of an entry point: the warning is emitted while `node:sqlite` is being
 * loaded, so the filter has to be in place before anything imports the store.
 */
process.removeAllListeners("warning");
process.on("warning", (warning: Error & { name: string }) => {
  if (warning.name === "ExperimentalWarning" && /SQLite is an experimental feature/.test(warning.message)) return;
  process.stderr.write(`${warning.name}: ${warning.message}\n`);
});
