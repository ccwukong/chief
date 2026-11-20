/**
 * Providers: the agent CLIs chief can use, detected once instead of typed in (task 15.14).
 *
 * A person using chief should never have to find a program's path. On every check chief asks each
 * CLI where it is (`--version`, which is also the version check), and:
 *
 *   - writes the path it found into `<adapter>.path`, so the Settings field is filled in rather than
 *     empty — but only when the field is empty or the stored path no longer exists, so a path that
 *     was chosen by hand is never overwritten;
 *   - turns a CLI it finds **on** (`<adapter>.enabled` absent means "on when found"), and leaves a CLI
 *     it cannot find **off**. That is the one default that cannot surprise anyone: chief never offers
 *     a program that is not there, and a provider that appears later is picked up on the next check.
 *
 * The switch is what a person turns *off*: a CLI that is installed but not wanted (a company account
 * on a personal machine) disappears from the agent pickers instead of being offered everywhere.
 */
import { existsSync } from "node:fs";
import { ADAPTER_NAMES, adapterBin, adapterFromEnv, getAdapterByBin } from "./adapters/index.ts";
import type { Store } from "./store/store.ts";
import { which } from "./util/proc.ts";

/** The CLIs detection found at the last check. */
const foundLast = (store: Store): string[] => store.getSetting<string[]>("providers.found", []);

/**
 * The program to look for when nothing else is pinned: the command a person would type. Detection asks
 * for this one, so a stored path that has gone (an upgrade moved the program) is found again on PATH.
 */
const BARE_BIN: Record<string, string> = { "claude-code": "claude", codex: "codex", cursor: "cursor-agent", antigravity: "agy", opencode: "opencode" };

export interface ProviderState {
  name: string;
  /** Whether chief may use it: the switch in Settings. Absent setting means "on when found". */
  enabled: boolean;
  /** Whether the switch was set by a person, so detection must not change it. */
  chosen: boolean;
  found: boolean;
  /** The path in use: what was detected, or what was typed. Null when nothing was found. */
  path: string | null;
  version: string | null;
  ok: boolean;
  note?: string;
}

/**
 * Three different questions, three different answers. Conflating them is what made a CLI that was merely
 * not installed read as "turned off in Settings", and a CLI found once read as found forever (task 15.19):
 *
 *   - `providerChosenOff` — a person moved the switch to off. A decision: the pickers leave the CLI out
 *     and a workflow that names it is refused with that reason.
 *   - `providerLocated` — the program is on this machine right now. A fact about the machine, checked with
 *     a path lookup (no process is spawned). It is what "can a step run" turns on.
 *   - `providerFound` — detection asked it for its version. That is the Settings card's `CLI detected`.
 */
export const providerChosenOff = (store: Store, name: string): boolean =>
  store.getSetting<boolean>(`${name}.chosen`, false) && !store.getSetting<boolean>(`${name}.enabled`, false);

/** Is the program there right now? A path check, the same one `which` makes; nothing is spawned. */
export function providerLocated(store: Store, name: string): boolean {
  const bin = adapterBin(store, name);
  return existsSync(bin) || !!which(bin);
}

/** What detection found at the last check — the list `/api/meta` reports as "found". */
export const providerFound = (store: Store, name: string): boolean => foundLast(store).includes(name);

/** The adapters a person may pick, in the fixed order: every one that is not switched off. */
export const enabledProviders = (store: Store): string[] => ADAPTER_NAMES.filter((n) => !providerChosenOff(store, n));

/**
 * Ask every CLI where it is and what version it has, and record what that means. `persist` writes
 * the findings as settings (the Settings page); a read-only caller passes false.
 */
export async function detectProviders(store: Store, persist = true): Promise<ProviderState[]> {
  const out: ProviderState[] = [];
  for (const name of ADAPTER_NAMES) {
    // `.chosen` is set only when a person moves the switch; until then detection decides.
    const chosen = store.getSetting<boolean>(`${name}.chosen`, false);
    const storedPath = store.getSetting<string | null>(`${name}.path`, null);
    // A stored path that no longer exists is re-detected on PATH: an upgrade that moves the program
    // must not leave chief pointing at nothing.
    const stale = !!storedPath && !existsSync(storedPath);
    let info: { found: boolean; path: string | null; version: string | null; ok: boolean; note?: string };
    try {
      info = await getAdapterByBin(name, stale ? BARE_BIN[name] : adapterBin(store, name)).info();
    } catch {
      info = { found: false, path: null, version: null, ok: false, note: "adapter not available" };
    }
    const detected = info.found ? info.path : null;
    // What a person typed is always shown, even when the program is not there: the field is how they fix
    // it. Detection replaces it only when it finds the program somewhere real (below).
    const path = detected ?? storedPath;
    // The switch: a person's choice wins; otherwise it is on as soon as the CLI is there.
    const enabled = chosen ? store.getSetting<boolean>(`${name}.enabled`, false) : info.found || providerLocated(store, name);
    if (persist && detected && detected !== storedPath && !adapterFromEnv(name)) {
      // A path that came from `CHIEF_<ADAPTER>_BIN` is not written into the settings: it belongs to the
      // process that set it, and storing it made the variable sticky for every later run.
      store.setSetting(`${name}.path`, detected);
    }
    out.push({
      name,
      enabled,
      chosen,
      // What the switch is judged on: a path that exists, whether detected or typed.
      found: info.found || (!!path && existsSync(path)),
      path: path ?? (info.found ? adapterBin(store, name) : null),
      version: info.version,
      ok: info.ok,
      note: info.note,
    });
  }
  // Which CLIs were found, recorded so `/api/meta` can tell "nothing installed" from "all switched
  // off" without running five programs on every page load (task 15.15).
  if (persist) store.setSetting("providers.found", out.filter((p) => p.found).map((p) => p.name));
  return out;
}
