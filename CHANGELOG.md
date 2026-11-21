# Changelog

Every version that ships, newest first, with what changed for the person using chief. Internal work (a
refactor, a test) is listed only when it changes what the app does or what a run records.

The version is in `packages/desktop/package.json`; the app's About panel reads it from there, and the
landing page and the release notes take it from the same place. `Unreleased` collects what is on `main`
and not yet in a version.

## [Unreleased]

### Fixed

- **The Refine button's icon sits beside its label.** `AsyncButton` hides its contents while it spins by
  wrapping them in a span; that span was not a flex container, so the sparkle stacked above the text and
  the button was 42 px tall for one short line. The wrapper now passes the button's layout through, which
  fixes every async button with an icon.
- **chief bot's tooltip is a tooltip.** It opened three sections — a paragraph over a thousand characters,
  a use case and an example — taller than half the window. It is two sentences and the examples now.
- **A labelled way back to the workflow on the canvas.** Pan the canvas far away and it was an empty grid
  with nothing to say the workflow was still there — the fit control existed, as a pair of unlabelled
  brackets. It is chief's own **Fit the whole workflow in the canvas** button now, and the library's
  duplicate is switched off.
- **Thin scrollbars.** They were the platform's ~15 px ones, which took a sixth of the designer's block
  column. Every scrolling box in the app — the block column, the run record, JSON, the assistant — now gets
  a thin, translucent, rounded bar with a transparent track. Whether it appears only while you scroll is
  your macOS setting, not something the app chooses.
- **The Refine button looks like what it does.** It carries a sparkle, the shape every other AI feature
  uses, so it reads as "an agent writes this" rather than as another save-or-send button.
- **The step's Id explains itself under the field, and its hint obeys its own rule.** It said "lower-case
  kebab-case" and nothing else; it now says the rule and how other steps read the result, with the field's
  own id in the example. Its `?` is gone, like the workflow name's.
- **The collapsed panel is a tab, not a sliver.** It was a bare `«`, then a pale labelled button; at 26 px
  wide it still looked like the window's edge. It is now a bordered handle on a tinted strip, with a drawn
  chevron and its label, that fills with blue on hover.
- **Five things the designer did without saying so.** Each group of MCP servers now has a caret that turns
  as it folds — and stays folded: with `open` as a fixed prop, a group you closed was reopened by the next
  refresh. The four building blocks share **one** tooltip on the column's heading instead of four `?` in a
  224 px column. The workflow's name drops its `?` — the example is in the box and the rule is under it.
  **New workflow** sits beside the workflow picker with a plus, not fourth in a row of five. And the step's
  four fields are one word each (Context, Agent CLI, Model, Tools), so they line up instead of wrapping.
- **Two "?" removed from Settings that only repeated the line under the field.** The default agent CLI and
  the output size limit already explain themselves in their own hint; the tooltip was the same sentence a
  second time. The fields that need more than a line keep theirs.
- **The designer says what it has before you find it by accident.** With the side panel folded, the only
  trace of it was a bare `«` — it read as decoration, and you could not tell a panel existed until you
  dropped a block and it opened by itself. The strip is a labelled **Panel** button now. And each agent
  CLI's MCP server group folds, so one CLI reporting ten (or thirty) servers no longer pushes the others
  out of reach; the closed header still shows the name and the count.
- **chief bot answers the question you asked.** In the designer it used to decline anything that was not
  about the workflow on the canvas — a general question, some research, an explanation — because its
  instructions said that was its job. Ask it a question and it answers; ask it to change the workflow and
  it does that. It is also given chief's recent runs and waiting gates while you design, so "which runs
  failed?" works from there too.
- **The model list says how to sign a CLI in, and recovers when you do.** A Cursor CLI that is installed
  but not signed in printed its own flags in the chat box, and the failure was cached for ten minutes. It
  now says *"Cursor is installed but not signed in — `cursor-agent login`"* with a **Check again** button,
  and a failure is never cached.
- **chief bot follows the default agent CLI.** Change it in Settings and the open panel switches to it and
  lists that CLI's models; a model chosen for the previous CLI is dropped rather than sent to the new one.
- **It is called chief bot in the UI**, not "Assistant".

### Added

- **`chief` is a command you can install.** `npm run build && npm run install:cli` writes
  `~/.local/bin/chief`, which runs the bundle from anywhere — `chief runs list`, `chief serve`, and so
  on. Before this there was no such command: `npm install` put nothing on the `PATH`, and the README
  used `chief` while parenthesising that you could write a wrapper yourself. From a checkout without it,
  `npm run chief <command>` still works.

### Changed

- **The landing page has its own home: <https://runchief.dev>.** It moved out of this repository into
  [ccwukong/chief-site](https://github.com/ccwukong/chief-site), which builds it from this one — the
  version, the newest `.dmg`, the logos and the screenshots — and deploys it to Cloudflare Pages on
  every push there, once a day, and on demand. Nothing about the app changes; the README and the
  changelog now point at the new address, and the old `ccwukong.github.io/chief` URL is retired.

## [0.2.8] — 2026-11-21

### Fixed

- **A tooltip you can read.** The building blocks' one `?` said everything about all four kinds in a single
  1,249-character paragraph, and the step panel's `?` did the same for the context, the output schema, the
  gate and the MCP servers. Each is now a few short lines, one idea per line, with the example kept — and a
  tooltip can no longer grow back into prose.
- **The run's diagram is a canvas again.** It could not be moved or zoomed, so a workflow wider than the box
  was stuck at whatever scale fitted it and there was no way back after panning. It pans, zooms, has the same
  labelled **fit** control as the designer, and the view you choose is left alone when the run updates.
- **A run page can reach its workflow.** **Edit workflow** opens it in the designer — the run itself keeps
  the version it started with.
- **The Start run card is laid out as one thought.** A JSON box was its centrepiece even for a workflow that
  uses no inputs, with the button under a narrow select. It is now a heading, the workflow and its button on
  one line, and an inputs editor below — only when the workflow uses inputs.

## [0.2.7] — 2026-11-21

### Changed

- **GitHub is in the landing page's nav bar**, with the other links, instead of a button in the hero.
- **Every CLI now shows its vendor's mark**, Codex included: OpenAI publishes its kit from
  [openai.com/brand](https://openai.com/brand/) and its terms permit showing the mark where it relates to
  OpenAI's services, used exactly as provided — so the kit's own black and white files are shipped
  unmodified, one per theme.
- **The landing page no longer ends on a list of caveats.** Nothing was made untrue: the unsigned app is
  explained where macOS warns about it, and the unverified adapters are in the README's "Limits worth
  knowing".

## [0.2.6] — 2026-11-21

### Added

- **Antigravity's logo**, from [its press kit](https://antigravity.google/press/) — the assets published for
  exactly this, saying which products work with it. (Codex had no mark in this version; it has one from
  0.2.7.)

### Changed

- **GitHub is in the landing page's nav bar**, with the other links, instead of a button in the hero.

## [0.2.5] — 2026-11-21

### Added

- **Hermes Agent is the sixth agent CLI.** `agent: hermes` runs a step with
  `hermes chat -q "<prompt>" --format stream-json`; sessions are resumed with `--resume`, tokens are
  recorded, and exit 75 is reported as a provider rate-limit worth retrying. Its MCP servers come
  from `mcp_servers:` in `~/.hermes/config.yaml`. Written from the vendor's documentation and tested
  against a fake CLI only, so it is listed with Codex and Cursor as unverified; Hermes also cannot be
  told per run to use no built-in tools (its toolsets come from its own config), which the README
  says in "Limits worth knowing".
- **The CLI logos**, on the landing page and in the README: Claude Code, Cursor, OpenCode and Hermes with
  their vendors' own marks, and Codex and Antigravity named without one rather than given an invented logo.

### Changed

- **The landing page opens in the dark theme**, and its top-right button shows a sun while the page is dark
  and a moon while it is light — it says what pressing it gives you. Your choice is remembered.
- **The supported CLIs have a row of their own** under the hero, in a line, instead of wrapping inside the
  hero's text column.
- The page asks for its stylesheet with the version in the URL, so a new page never renders over a cached
  older one.

## [0.2.4] — 2026-11-21

### Changed

- **The About panel no longer shows a copyright line or a personal name.** The notice that has to travel
  with a copy of chief is in the app's own licence file (`Chief.app/Contents/Resources/server/LICENSE`),
  which is where the Apache licence asks for it; a menu repeating it added nothing.
- **There are terms, in plain words.** [docs/terms.md](docs/terms.md), and the same page on the site at
  <https://runchief.dev/terms>: chief comes as it is, with no warranty, and nobody is
  liable if using it loses you data, work or time. Nothing in them narrows what the Apache-2.0 licence
  grants you — a terms page cannot, and saying so is the point.

## [0.2.3] — 2026-11-21

### Added

- **chief tells you when there is a newer version.** On launch it asks GitHub for the newest release
  and, when yours is older, offers **Download and Open**: the installer lands in Downloads and opens, so
  updating is the same drag onto Applications as the first install. **Check for Updates…** in the chief
  menu asks again whenever you want, and `CHIEF_NO_UPDATE_CHECK=1` stops the launch check.

  It does not replace itself silently. macOS only lets an app update itself when it is signed with a
  Developer ID and notarized, and chief is neither — so it fetches the installer rather than pretending
  to have installed it. That is also why the landing page no longer says there are no update pings: it
  says what the one request is and how to switch it off.

### Fixed

- **The assistant's cards are readable in the dark theme.** Its answer puts a tinted panel under the
  workflow change (purple) and the schedule (teal), and in the dark theme the purple panel's text was
  near-black on a near-black card — 1.16:1, invisible — because the palette turned the tints dark at one
  end but never defined the `950` step the text used. The schedule card had no dark values at all. Both
  are themed now, and a case fails if any colour the app reaches for is missing from the dark ramp.
- **The landing page's download button is readable in the dark theme.** "Apple silicon · v0.2.2" was mint
  on a lightened mint, 1.1:1.
- **The landing page's nav is on one line.** The links, the Download pill and the theme button now share a
  vertical centre; the pill is taller than a line of text and the links used to sit on its top edge.
- **The quarantine step says what the warning is.** It names the dialog — *"chief" cannot be opened
  because the developer cannot be verified* — and the only button it offers, so someone who has just seen
  it knows which step in the list they are on.

## [0.2.2] — 2026-11-20

### Added

- **Ask chief bot for a schedule.** In the designer, "run this every weekday at 9am" adds one, "pause it"
  pauses the one you just made, and "make it 6pm instead" changes it — and it is listed on the Schedules
  page like any other. chief checks the expression and the workflow's inputs exactly as the form does, so
  a schedule it wrote behaves like one added by hand, and an expression it cannot accept is asked for again
  once and, if it is still wrong, not written at all.

### Fixed

- **The bot no longer loses its reason when a change is refused twice.** When it was asked to correct
  something and its second answer did not contain the correction, the panel said only that nothing had been
  sent; it now shows what was actually wrong with the first one.

## [0.2.1] — 2026-11-20

### Added

- **The `.dmg` installs the way an installer should.** It opens as a window named **chief — drag to
  Applications**, with **chief** on the left and an **Applications** shortcut on the right, and the
  sentence and an arrow drawn behind them at the window's own size. Drag chief onto the shortcut and it
  is installed. The window's name says it even on a machine where macOS cannot arrange the icons.

### Changed

- **The download page keeps up with a release by itself.** The landing page's button and its stated size
  come from the newest release, and the page is now published when the desktop build finishes rather than
  waiting for someone to run it or for the next day's schedule.

### Fixed

- **The `.dmg` build no longer fails on a busy image.** `hdiutil convert` could answer *Resource
  temporarily unavailable* right after the volume was detached, and only on a machine where Finder had
  written the window layout; a release built from such a machine failed with nothing to act on. The
  detach now waits until the image itself is released, not just its mount point, and that one transient
  answer is retried.

## [0.2.0] — 2026-11-20

### Added

- **A landing page**, published at <https://ccwukong.github.io/chief/>, with the screenshots, the
  features and a direct download of the app.
- **A public `.dmg`** on a release, so a download needs no GitHub account.
- **One release per version, named for it**, published automatically when the version in
  `packages/desktop/package.json` goes up: the file is `chief-<version>-apple-silicon.dmg` with its
  `.sha256` beside it, so a download says which version it is and which Mac it is for.
- **Schedules**: a page listing every cron schedule with its expression in words, when it last fired and
  when it fires next, a switch per schedule, and a paginated list.
- **Providers as cards** in Settings: every agent CLI chief can use, whether it was found, its version,
  its path filled in automatically, and a switch. A switched-off CLI is offered nowhere, and a workflow
  that still names one is refused before it starts.
- **One workflow, several agent CLIs**: a step can choose its own CLI, so a personal subscription and a
  work one can share a workflow. The step says so on the canvas.
- **Appearance**: Light, Dark or System, and one text scale for the whole app from Small to Extra large.
- **A warning when chief cannot run anything**: a bar and a notification when no agent CLI is installed,
  or every installed one is switched off, with the way to fix it.
- **chief bot**: say what a workflow should do and watch the steps, prompts and arrows appear on the
  canvas; or open a run that went wrong and ask what happened. It authors workflows before a run and
  reads a run's own record after one, with no tools of its own.
- **Two ways to run chief**, both on the landing page and in the README: the macOS app (a window that
  keeps running after you close it) and the web UI (`npm run chief serve`, then `127.0.0.1:8080`).
- **`npm run dev:desktop`**: the app with live reload — Vite with hot reload, the server under
  `node --watch`, and the app relaunched when the main process changes.
- Desktop app: **closing the window keeps it running**, so runs finish and schedules fire until you quit
  (⌘Q asks first if a run is in flight).
- Desktop app: the menu bar and the Dock say **chief** with chief's icon in a development run too, and the
  menu is a production one (About, Settings…, Services, the Hide items, Hide Others, Show All, Quit;
  File, Edit, View, Window, Help with Copy Diagnostics).

### Changed

- **The download count is now a ledger that cannot go down.** `downloads.json` in the repository records
  the highest number of downloads each version ever had, so the total on the landing page survives an old
  release being pruned — before, pruning an old release lowered the count it was read from. It is a file
  in git, not a database and not a service, and it is refreshed daily and when a release is published.
- **The version in `packages/desktop/package.json` decides when an app is built.** Every push to `main`
  compares it with the newest `v*` tag: higher, and the tag, the build and the release happen by
  themselves; not higher, and nothing is built and no macOS runner is spent. Raising the version is the
  approval, so the *Waiting for review* gate is gone — a change to the plans, the README or the landing
  page ships no new download either way.
- **The download is named in words**: `chief-<version>-apple-silicon.dmg`, never `arm64`, and never
  `-latest`. A versioned name means the landing page resolves the newest release's asset when it builds.
- **Cost and budget figures are hidden** in the app while their usefulness is decided: the run list's
  Cost column, a run's dollars, each step's cost, the assistant's per-answer cost and the budget fields in
  Settings and the designer. They are still recorded and still returned by the API.
- The product is described for **agent CLIs**, not only coding agents: a general assistant with a
  command-line interface can be an adapter.
- Third-party notices are **generated by the build** into `dist/` instead of being a tracked file, and
  they ship inside the app. `NOTICE` is gone: under Apache-2.0 it is optional, and the copyright line in
  `LICENSE` is the attribution that travels.
- Every CLI's own tooltip names **its own program**, instead of all five quoting Claude Code's path.
- The three commands in a run's record are the agent's own: the prompt is **not** put on the command line.

### Fixed

- A stored agent path is **re-detected when it stops existing**, so an upgrade that moves the program does
  not leave chief pointing at nothing.
- A CLI given by `CHIEF_<ADAPTER>_BIN` is no longer written into the settings, where it stayed after the
  variable was gone.
- A typed path is **saved as it is typed**, not only when the field loses focus.
- The designer's canvas no longer shows React Flow's attribution badge; the credit is in the generated
  notices.
- Node 22's `node:sqlite` experimental warning no longer lands on every command's stderr.
- The API answers `Cache-Control: no-store`, so a page cannot read a setting from before it changed.
- The macOS suite runs on macOS: the script sandbox has no Linux backend, so the Linux run reported 51
  unrelated failures.
- **Cancel no longer leaves its spinner spinning.** The button is released when the request is answered
  rather than when the run's whole record has been read again, it reads *Cancelling…* while the cancel is
  in flight, and a run that is still going is polled as well — so a cancelled run shows as cancelled
  without closing and reopening the panel. A page load no longer reads a run's entire transcript.

## [0.1.0] — 2026-11-20

The first public version: the desktop app, the web UI, and the CLI over one local server.

### Added

- **The designer**: drag Agent, Gate, Script and Map blocks onto a canvas, connect them with arrows,
  and write each step's prompt. Autosave — there is no Save button — and a new workflow version only
  once the current one has been run.
- **Runs**: the run list with status and cost, a run's steps over its own diagram, each step's prompt,
  result and cost on it, pause, resume, cancel and **Run again**.
- **Gates**: a run stops where you asked for a say. A gate built from a plain-language instruction (an
  agent writes the form from the earlier results), or a fixed one: pick several, pick one, approve, type.
- **Replay**: every prompt as sent, every reply, tool call and result, stdin, stdout, stderr, exit code,
  gate questions and answers, status changes and errors — recorded as the run happens and never
  re-executed.
- **The assistant**: asks and answers from the record — "what went wrong, and what should I do next?" on
  a run, "which runs failed?" elsewhere. In the designer it builds the workflow with you. It runs
  nothing.
- **Scripts** in Python, shell or Node, always in a macOS sandbox: no network, writes only where you
  grant them, an allowlist for environment variables, protected paths that can never be granted.
- **Saga / revert**: each step reports the side effects it caused, so a run can be undone in reverse
  order; what is irreversible is gated first and listed for you afterwards.
- **Budgets and cost**: a warning level and a hard limit per run, and what each step cost, as the agent
  CLI reports it.
- **Schedules**: cron entries that start a run while chief is running.
- **Five agent CLIs**: Claude Code, Codex, Cursor, Antigravity and OpenCode. MCP servers are whatever
  the CLI is connected to; chief configures none.
- **The desktop app** for macOS: the same server in an Electron window, with your login shell's
  environment so the agent CLIs are found when it is opened from the Finder.
- **The CLI** for scripting and recovery: every operation with `--json`, including `runs replay`,
  `runs ask` and `revert`.
- State in `~/.chief`: `state/chief.db`, `workspace/`, `logs/` and `desktop/` (Electron's profile).
  Nothing is written into the checkout, and no page requires a cloud account.

[Unreleased]: https://github.com/ccwukong/chief/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/ccwukong/chief/releases/tag/v0.2.0
[0.1.0]: https://github.com/ccwukong/chief/releases/tag/v0.1.0
