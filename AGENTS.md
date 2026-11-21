# chief — development standard

Rules for anyone (human or coding agent) working in this repository. The product plan is in
[docs/dev-plan.md](docs/dev-plan.md); the test plan is in [docs/e2e-test-plan.md](docs/e2e-test-plan.md).

## Development workflow

Work proceeds phase by phase, in the order of `docs/dev-plan.md` §7.

0. **How a pull request lands.** `main` takes **squash and merge only**: merge commits and rebase
   merging are switched off in the repository's settings, and `main` requires a **linear history**, so
   a pull request branch is brought up to date by **rebasing on `main`**, never by merging it in
   ("Update branch" rebases; `git rebase origin/main` by hand does the same). The result is one commit
   per pull request and a `main` with no merge commits at any point. The squash commit takes the pull
   request's title, so the title is the commit message: write it as one, in the imperative. The rule is
   enforced by GitHub, not by asking nicely — a merge commit cannot be pushed and the two other merge
   buttons do not exist. The maintainer's own work reaches `main` the same way, as a single amended
   commit force-pushed (allowed deliberately: `allow_force_pushes` is on for that one branch).

1. **Pick up tasks from the dev plan.** Every piece of work maps to a task ID there (`1.3`, `6.5`, …).
   If the work is not in the plan, add it to the plan first (or to §12 "Project backlog" if it is not scheduled).
2. **Always update the task status in the dev plan.** The `Status` column of `docs/dev-plan.md` must
   reflect reality at all times, and it is the agent's job to keep it so, without being asked:
   - `todo` → `in progress` at the moment you start working on a task, before writing code.
   - `in progress` → `done` only when the task's e2e test cases pass — or, under step 4's opt-in rule,
     when the cases are written and the "Phase results" table records, with the reason, that they were
     not run. A case that was never written is not done; a case that was written and not run is, and the
     plan says so.
   - → `blocked` as soon as something outside the repo stops the task (a CLI that is not installed,
     a decision that is needed, a person who must be present). Put the reason in the `Notes` column.
   - → back to `todo` if work on a task is abandoned or reverted.
   - `dropped` when a task is removed from scope, with the reason in `Notes`.

   Update the status in the same change as the work itself, one task at a time. Never batch status
   updates to the end of a phase and never leave a task `in progress` when you stop working on it.
3. **Every task has e2e test cases.** `docs/e2e-test-plan.md` lists test cases per task ID. A task without
   at least one test case in that plan is not ready to be implemented: add the cases first. When a task's
   scope changes, update its cases in the same change.
4. **Do not run the e2e suite by default. Run it when the user asks.** A change is not followed by a
   Playwright run unless the user asks for one ("run the e2e cases for this", "run full e2e test"). Say
   what you *would* run and why, and let them decide — including for a wide change (the engine, the
   store, a migration, an adapter), where the useful sentence is "this touches the engine, so
   `E…` and the store cases are worth a run" rather than a run you started yourself.

   ```sh
   npx playwright test -g "E9.22-1|E9.21-1"       # chosen cases, by case ID — when asked
   npx playwright test e2e/phase-6/ui.spec.ts     # one file — when asked
   npm run e2e                                    # the full suite — only when asked
   ```

   When you are asked, run what was asked for and no more: the cases of the task (and
   `e2e/plan-coverage.spec.ts`, which is cheap and is the one case that guards the plan files) unless
   the request names something wider. Record every run in the "Phase results" table of
   `docs/e2e-test-plan.md` (date, what was run, pass/fail counts), and say in the report which cases
   were run and that the rest were not. CI is where the suite runs on its own: on a pull request, and
   by hand (15.52).
5. **Do not move on with a red case.** Fix the failure, or mark the affected task
   `blocked` in the dev plan with the reason, before moving on.
6. **Report honestly.** If a test case could not be run (for example it needs a CLI that is not
   installed, or a person to answer a gate), mark it `not run` with the reason. Never mark it passed.

## Testing conventions

- **Runner:** Playwright Test for all e2e cases, including CLI and API cases that need no browser.
  Browser cases (Phase 6) run against the real server and the built web UI.
- **Headed by default.** Browser cases open a visible Chromium window so the run can be watched.
  Set `CHIEF_E2E_HEADLESS=1` only where there is no display (CI).
- **Layout:** `e2e/phase-<n>/*.spec.ts`. Test titles start with the case ID from the test plan,
  e.g. `E1.6-1 select gate pauses the run`.
- **Isolation:** every test gets its own `CHIEF_HOME` under `e2e/.tmp/`, so tests never touch the real `~/.chief/`.
- **Agent CLIs are faked by default.** `e2e/fixtures/fake-claude.ts` reproduces Claude Code's
  `stream-json` output so tests are deterministic and free. Cases that call the real CLI are tagged
  `@real`, are opt-in (`CHIEF_E2E_REAL=1`), and must use the cheapest model.
- **No real writes.** Tests must never post messages, comments or tickets to real services.
- **Unit tests** (`node --test`, `npm test`) are welcome for pure logic (templates, schema, cron) but do not replace
  the e2e cases.

## Code conventions

- **Stack:** TypeScript on Node, Hono on `@hono/node-server`, `node:sqlite`, `zod`, React + Vite + React Flow for the web UI. Node 22.18 or newer, run with no build step: TypeScript is erased by Node's type stripping, so only erasable syntax (no parameter properties, enums or namespaces).
- **File and directory names:** lower-case kebab-case (`dev-plan.md`, `claude-code.ts`, `daily-slack.yaml`).
- **Workflow YAML keys and enum values:** kebab-case (`output-schema`, `max-parallel`).
- **SQL names and the agent JSON contract fields:** snake_case (`node_runs`, `side_effects`, `needs_input`).
- **One process, one SQLite instance.** `chief.db` in chief's home is the only place the project
  persists anything. The home is `~/.chief/state`, with the workflow folders next to it in
  `~/.chief/workspace`, or `CHIEF_HOME` when that is set (`packages/chief/src/paths.ts`). It is
  deliberately outside any checkout, like `~/.claude` and `~/.codex`: cloning, moving or deleting the
  source tree never touches the workflows, nothing a run writes can land inside the repository, and
  the desktop app reads the same folder as the CLI. chief writes nothing else outside the home, except what
  the desktop app adds beside it under `~/.chief`: the server's log (`logs/`) and Electron's own profile
  (`desktop/`). Nothing goes to `~/Library/Application Support`, and the app's window size is kept in the
  database like the web UI's other choices about itself. No
  second database file, no attached database, no browser storage, no side files for state. No queue,
  broker, ORM or extra service.
- **One schema per feature.** Every table and index is named `<schema>__<name>`, where the schema
  is the feature it belongs to (`workflow`, `run`, `agent`, `system`, `draft` today; see dev plan
  §4). A new feature joins an existing schema or adds a new one in a migration.
- **Raw SQL with numbered migrations** in `packages/chief/src/store/migrations/`; never edit a
  migration that has been applied.
- **`node:sqlite` is imported only by the store** (`packages/chief/src/store/`).
- **Runtime-specific APIs** (`node:child_process`, `node:http` behind `@hono/node-server`) stay inside the adapters, the sandbox and the server.
- **The web UI talks to the engine over HTTP only.** `packages/web` may not import `packages/chief`
  (no store, no engine, no Node built-ins), and `packages/chief` may not import `packages/web`. ESLint
  enforces both directions (`eslint.config.js`); neither may import Electron, and `packages/desktop` (the
  macOS wrapper, `docs/desktop.md`) starts the server as a program and talks to it over HTTP, so it imports neither. This is the renderer/main boundary of the planned
  desktop app, and a lint rule holds it because a name in a directory cannot.
- **Timers are a design decision, not a patch.** `setInterval`, zero-delay `setTimeout` and
  `requestAnimationFrame` are refused in `packages/web/src` outside `packages/web/src/polling.ts`
  (which exports `usePolling` and `useReveal`). A positive-delay `setTimeout` for debouncing is fine.
  If you reach for a timer to "wait for the DOM" or "let it settle", fix the missing signal instead.
- **A `TODO`/`FIXME`/`HACK` comment must name the task that owns it** (`// TODO(14.1): …`). A comment
  cannot be enforced; a lint rule can. Prefer adding the rule to writing the comment.
- **`npm run lint` runs with `--max-warnings 0`** and CI (`.github/workflows/ci.yml`) runs typecheck and
  lint on every push and pull request, and the e2e suite on a pull request or by hand (a merge onto
  `main` need not re-run what the pull request already proved). A warning is a failure.
- **The rules above are enforced, not requested.** [docs/guardrails.md](docs/guardrails.md) lists every
  rule with its reason and its fix. `npm run check` runs typecheck, ESLint and
  `scripts/guardrails.mjs`; CI runs the same three on every push and pull request. Nothing in the
  enforcement depends on an editor or an agent tool: `scripts/guardrails.mjs` needs only Node, and
  `CLAUDE.md` points here for Claude Code. If a correction has to be remembered, it is not yet a rule:
  add it to one of the two checkers, with a case that proves it fires (the pattern is E14.1-1).

## Product rules that must not regress

- **A run belongs to the server, not to the page.** Runs are driven by the `chief serve` process and
 recorded in SQLite; a browser tab or an app window is a viewer over HTTP/SSE. Closing the tab, the
 window or the whole browser never pauses, cancels or loses a run, and no feature may depend on a page
 staying open to make progress. Anything a person must know after they close it comes from the server
 (a gate notification today; run finished and failed in 15.7).
- **Closing the desktop window does not quit chief.** The app stays in the Dock with its server and its
 scheduler running, and only Quit stops it (15.3).
- **A capability is finished when it works without a terminal.** Every capability has an HTTP endpoint
 and a place in the web UI; the CLI is a scripting surface and a recovery path, not a parallel product
 to keep at parity. Work on the web and desktop experience comes first (dev plan decision 15, Phase 15),
 and a new command that is not deliberately terminal-only arrives with its screen. E15.5-1 keeps the
 audit.
- **Every run is recorded in full.** Whatever goes to a worker (agent CLI or script) and whatever
  comes back is written to `run_messages` as it happens: the command line, the prompt exactly as
  sent, replies, tool calls with input and result, stdin, stdout, stderr, exit code, gate questions
  and answers, status changes and errors. New node types, adapters and code paths must record too.
  Replay reads that record; it never executes anything.
- **There are no Save buttons.** Every change in the web UI saves itself: designer changes
  (canvas, panel, model, name, budget, inputs) are stored at once as the working copy and become
  the workflow as soon as they form a valid one; settings save per field. Do not add a Save,
  Apply or Validate button. Buttons are for actions (Run, Start run, answering a gate, Import,
  Revert) and for the one security confirmation (approving wider sandbox permissions).
- **Autosave must not multiply things.** A new workflow version starts only once the current one
  has been run, never for a move or a rename; typing a name renames; nothing is created on disk
  while a path is being typed.
- **Nothing typed in the web UI may be lost on a refresh.** Any new text field keeps a draft
  (`useDraft` and friends in `packages/web/src/ui.tsx`) until it is saved or sent. Drafts are
  stored in the database (`draft` schema) through `/api/drafts`, never in browser storage.
- **Connections in the designer are always drawn as arrows.**
- **Removing something is a bin, never a red bar.** A run, a schedule, a step, a connection, a
  workflow, a conversation: `TrashButton` from `packages/web/src/ui.tsx` — a drawn glyph, slate at
  rest and `--destructive` on hover, `aria-label` and `title` carrying the name because a glyph has
  none. A `variant="destructive"` button is for **confirming** one of those in a dialog, or for an
  action with a consequence that is not a deletion (Cancel a run, Revert a run, Reject a gate) — never
  as the trigger that removes a thing. A page is for reading; the removal control must not be the
  loudest thing on it (asked 2026-11-22, three times from three pages).
- **Choices that come from an agent CLI are dropdowns filled from that CLI** (models, MCP
  servers), never free text and never a list hard-coded in chief.
- **Steps share stored results, not a conversation.** Every agent call is its own session. A step
  is given the results of the steps before it (free-form JSON, no fixed schema) unless it opts out.
- **Nothing a step produces may be lost between steps.** The result is the agent's final JSON
  block and the appended instructions say so; text written outside it is kept (`reply`) and
  passed on when it is substantial. Never drop either silently.
- **Human gates have no use-case logic.** A gate either renders a form an agent worked out from
  the author's plain-language instruction (`kind: ask`) or one of the fixed generic forms. Do not
  add gate kinds or UI for a specific use case.
- **There is no backlog.** It was removed on request; do not reintroduce it.
- **Every list page is paginated.** The server pages the list (`limit`, `offset`, the total in
  `X-Total-Count`) and the page uses `Pager` from `packages/web/src/ui.tsx`. No list page loads
  everything at once.
- **A button whose action waits on the server shows a spinner.** Use `AsyncButton` from
  `packages/web/src/ui.tsx`: the label is replaced by a spinner until the action is done and the
  button cannot be clicked twice.
- **The layout is responsive.** The app shell is a sidebar that becomes a menu below 768 px, and it
  is **collapsed to icons by default**: the working area gets the room, and a person who expands it
  keeps it expanded. No page may scroll sideways at 375 px wide; wide tables scroll inside their own box.
- **chief bot is a place in the shell, not an overlay.** It is a rail item beside the destinations
  that opens a **panel of its own column** next to the page (full width below 768 px), with the page
  keeping its layout beside it. Do not put it back in a floating bubble: the bubble covered page
  controls and read as an ad-hoc helper rather than as part of chief (asked 2026-11-22).

## Safety rules that must not regress

- **Script nodes always run sandboxed.** There is no off switch. On platforms without a sandbox
  backend (Windows, Linux today) the script node type is disabled; scripts never run unsandboxed.
- **Protected paths are never writable** and cannot be granted through `write:`.
- **Node data reaches scripts through stdin only**, never through the command line.
- **Environment variables are allowlisted**, not inherited.
- **A node that reported side effects is never retried automatically.**
- **chief never speaks MCP itself and holds no MCP configuration of its own.** The servers are
  whatever the agent CLI is connected to, read from the CLI before each run. By default an agent node
  may use all of them and the agent decides; a node can be restricted to some or to none. MCP servers
  are shown as a status list, not as building blocks. **chief may add or remove a server only by
  running that CLI's own command** (`claude mcp add`, `agy mcp add`, …), never by writing or editing
  the CLI's configuration file — the CLI stays the owner of its config, and a CLI that has no such
  command gets the snippet to paste instead of a button. A command that changes a CLI's tools is
  **shown before it runs** (a dry run builds the same argv the button executes), its argv is passed to
  `spawn` without a shell, the server name is validated so it cannot be read as a flag, and env/header
  values are masked in what the page shows and never stored. **Sign-in works the same way**: chief runs
  the CLI's own login command, shows the authorization URL it prints, and writes the pasted redirect to
  the waiting child's stdin. chief never receives a token itself — the CLI exchanges and keeps it — so a
  redirect is never written to the database, the run record or the log, and only flows the CLI offers a
  headless flag for (`--no-browser`) can be completed in chief's window. Do not add an editor for these
  files: `~/.claude.json` alone is 66 keys of application state rewritten on every launch.
- **A server the CLI cannot reach is an error to report**, not something to retry or work around:
  the run stops, or the node fails, with the CLI's or the agent's error message.
