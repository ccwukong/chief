# Writing workflows

A workflow is a YAML (or JSON) file with a name, a list of nodes and the edges between them.
Import it with `chief workflow import <file>`, check it with `chief workflow validate <file>`, run
it with `chief run <name>`. The web designer (`chief serve`) edits the same format.

All keys are kebab-case. Node ids and workflow names are lower-case kebab-case.

## A first workflow

```yaml
name: hello-review
inputs: { repo: my-org/my-repo }
nodes:
  - id: find
    type: agent
    mcp: [github]
    prompt: |
      Read only. List the open pull requests in {{inputs.repo}} that request my review.
    output-schema: { prs: [{ title: string, url: string }] }

  - id: pick
    type: gate
    kind: select
    from: "{{nodes.find.output.prs}}"

  - id: review
    type: map
    over: "{{nodes.pick.output.selected}}"
    node:
      type: agent
      mcp: [github]
      prompt: |
        Review this pull request: {{item}}
        Do not post the review. Ask me first, with the full review text as the proposal.

edges: [find -> pick, pick -> review]
```

## Starting from an existing workflow

To make a variation of a workflow, clone it instead of building it again: **Clone** in the
designer, or `chief workflow clone <name> [<new-name>]`. The copy is a workflow of its own, at
version 1, with the same steps, layout, arrows, inputs, budget and agent. Rename it by typing a
name in the Workflow section of the designer's side panel, then change what differs.

- Not copied: the original's runs, schedules and script approvals. A script that widens the sandbox
  must be approved again for the copy.
- The working directory: a workflow in its default folder gives the copy its own default folder
  (`.chief/workspace/<new-name>`). A workflow whose folder you chose keeps that folder, because its
  scripts and any MCP servers set up for that folder are there. Change it in the designer if the
  copy should work elsewhere.
- MCP servers set up in Claude Code for the original's folder only are not available in a new
  folder; see "MCP servers" in the README.

## Workflow fields

| Field | Meaning |
|---|---|
| `name` | Required. Unique name of the workflow |
| `description` | Free text |
| `agent` | Default adapter for agent nodes: `claude-code` (default), `codex`, `cursor`, `antigravity`, `opencode` |
| `budget` | `{ warn-usd, max-usd }`. At `max-usd` the run stops and asks whether to continue |
| `inputs` | Default values for the run inputs (see below). A run gives its own with `chief run <name> --input key=value` (`a.b=value` for a nested one), `--inputs-json`, or the form that starts it |
| `nodes` | The nodes, see below |
| `edges` | `a -> b` means b runs after a completed. The graph must not contain a cycle |

A node runs when all nodes it depends on have completed. Nodes without edges between them have no
defined order.

## Run inputs

A workflow is reused for different cases by reading what differs from its inputs. The inputs are
one JSON object for the whole workflow, with one section per block, named by the block's id. A
block's prompt reads its values as `{{inputs.<block id>.<name>}}`:

```yaml
name: review
inputs:
  planner: { prlink: "" }
  runner: { mode: dry }
nodes:
  - id: planner
    type: agent
    prompt: Plan the review of pull request {{inputs.planner.prlink}}.
  - id: runner
    type: agent
    prompt: Carry out the plan in {{inputs.runner.mode}} mode.
edges: [planner -> runner]
```

The designer's Workflow tab holds this JSON: change the values there, then press **Run**, which
starts at once with them. From the Runs page or the command line a run can also give its own
values, `{"planner": {"prlink": "https://github.com/my-org/app/pull/42"}}`, which are laid over the
workflow's level by level, so `runner.mode` keeps `dry` here.
The inputs belong to the run, not to one block: any block may read any section. Sections per
block are a convention, not a rule; `{{inputs.name}}` at the top level works too. An input a
prompt uses that has no value at all is refused before anything starts. From the command line:
`chief run review --input planner.prlink=https://…`.

A block's output is defined the same optional way, per block: its **Output schema** says which
fields its result has, and later blocks read them as `{{nodes.<block id>.output.<name>}}`.

## Templates

`{{…}}` inserts a value. It is a lookup only: there are no expressions.

| Reference | Value |
|---|---|
| `{{inputs.name}}`, `{{inputs.params.prlink}}` | A run input, at any depth |
| `{{nodes.<id>.output.<path>}}` | Output of an earlier node. Paths may go through objects and list indexes (`items.0.title`) |
| `{{item}}`, `{{item.<path>}}` | The current element inside a `map` node |
| `{{output.<path>}}`, `{{side_effects}}` | Inside `compensate` only: the node's own output and its recorded side effects |

A value that is exactly one reference keeps its type, so `over: "{{nodes.plan.output.items}}"`
passes the list itself. Inside longer text, objects and lists are inserted as JSON. A node can only
refer to nodes that run before it. Very large values are cut off in prompts (setting
`output-size-limit`, 20000 characters by default).

## How steps share what they found

Every agent step runs as its own session. Steps do not share a conversation or a memory. What
they share is the **result** of each step, which chief stores in its database as JSON, in whatever
shape the step returned. You do not define a schema for it (an `output-schema` is optional and
only there when you want to insist on a shape).

By default a step is given the results of the steps directly before it, so nothing needs wiring:

```yaml
name: context-example
nodes:
  - id: find
    type: agent
    prompt: Find my action items from the last day. Return them as a list, with whatever details are useful.
  - id: act
    type: agent
    prompt: Do the most urgent one and report what you did.   # is given the result of "find"
edges: [find -> act]
```

- The result is the JSON block an agent finishes with. Agents are told to put everything in it,
  in full. If a step nevertheless writes real content outside that block, that text is kept too,
  handed to the next step alongside the result, shown on the run page, and available as
  `{{nodes.<id>.reply}}`.
- You do not need to tell a step to store its findings somewhere: its result is saved for you.
- A result your prompt already inserts with `{{nodes.<id>.output…}}` is not added a second time.
- Inside a `map`, the inner step is given its item, not the whole list.
- A gate's answer is a result like any other, so the step after a gate sees what you chose.
- A gate that only carries your decision or a comment (an `input` gate, or an `approve` gate
  without a `value`) does not hide what it was about: the step after it is also given the result
  of the step before the gate. A gate that passes data on itself (`select`, `ask`, `approve` with
  a `value`) stands for it, so the next step works on what you picked or edited.
- A step cannot ask you anything while it works, and it has no database to read or write. If you
  want to choose between options, put an `ask` gate after the step that produces them.
- `context: all` gives a step the results of every earlier step; `context: none` gives it nothing
  beyond its prompt.
- Very large results are cut off in the prompt (setting `output-size-limit`); the stored result
  stays complete, and `chief runs replay` shows exactly what each step was given.

## Agent nodes

Run the agent CLI with a prompt.

| Field | Meaning |
|---|---|
| `prompt` | Required. What the agent should do |
| `mcp` | Optional restriction on the MCP servers this node may use. **Left out, the node may use every server your agent CLI is connected to, and the agent decides which ones the task needs.** A list restricts it to those servers: use the names shown by `chief mcp list`, a unique prefix (`github` for `github-custom`), or the CLI's name (`claude.ai Slack`); if the CLI is not connected to a listed one, the run stops with that error. An empty list (`mcp: []`) means none. Restrict a node when it must not be able to touch certain services, or to keep its cost down |
| `model` | Model for this node (for example `haiku` for cheap steps). `chief models` lists what the agent CLI offers; the designer shows the same list as a dropdown |
| `agent` | Adapter for this node, overriding the workflow default |
| `context` | What the step is told about earlier steps without your prompt asking for it: `previous` (default: the results of the steps directly before it), `all` (every earlier step), `none`. See "How steps share what they found" |
| `output-schema` | Shape the result must have, see below |
| `tools` | Built-in tools of the CLI: `none` (default), `read-only`, `default`, or a list such as `[Bash, Read]`. How each CLI applies this is in "Agent CLIs" below |
| `allowed-tools`, `disallowed-tools` | Extra tool rules passed to Claude Code, for example `disallowed-tools: [mcp__claude_ai_Slack__slack_send_message]` |
| `permission-mode` | Claude Code permission mode |
| `cwd` | Working directory (default: the directory of the workflow file) |
| `timeout` | For example `10m`. Default 30 minutes |
| `irreversible` | `true` if the node does something that cannot be undone. chief asks before running it; `confirm: false` skips that question |
| `compensate` | How to undo this node, see "Undoing a run" |

chief appends a short contract to every prompt. The agent must finish with a JSON block, list the
writes it performed in `side_effects`, and return a question instead of writing when the prompt
tells it to ask first. You do not need to repeat any of that in your prompt.

### Agent CLIs

`agent:` on the workflow or on a node picks the CLI; the `default-adapter` setting applies
otherwise. They behave the same towards chief (sessions, gates, pause and resume, revert) and differ
in what the CLI itself allows:

| `agent` | CLI | `mcp:` restriction | `tools: none` / `read-only` | `tools: default` or a list | Cost reported |
|---|---|---|---|---|---|
| `claude-code` | `claude` | Other servers hidden | No built-in tools / read tools only | All tools | Yes |
| `codex` | `codex` | Other servers switched off for the run | Read-only sandbox | `--sandbox workspace-write` | Tokens only |
| `cursor` | `cursor-agent` | Told in the prompt only | No auto-approval | `--force` | No |
| `antigravity` | `agy` | Told in the prompt only | `--mode plan` | `--mode auto` | Tokens only |
| `opencode` | `opencode` | Other servers switched off for the run | `plan` agent | `--auto` | Yes |

`allowed-tools`, `disallowed-tools` and `permission-mode` apply to Claude Code only. Where the
restriction is only told in the prompt, an agent could still call another server it is connected
to; use one of the other CLIs for steps where that matters. Budgets limit only the CLIs that report
cost. Details per CLI are in [docs/adapters/](adapters/).

### One workflow, several agent CLIs

`default-adapter` in Settings is only the last of three answers to "which CLI runs this step". The
order is: the node's `agent:`, then the workflow's `agent:`, then the setting. So a single workflow can
use your personal subscription for one step and your work subscription for the next — which is the
usual reason to mix them.

Say your personal Antigravity (`agy`) is signed in to your personal Google Calendar through an MCP
server, and your work account is Claude Code. A workflow that finds a free slot personally and then
starts the work with the work account:

```yaml
name: find-slot-and-start
agent: claude-code          # every step that does not say otherwise

nodes:
  - id: slots
    type: agent
    agent: antigravity      # this step only: the personal subscription
    mcp: [google-calendar]  # and only that server, not every server agy is connected to
    model: gemini-2.5-pro
    prompt: >-
      Find a free 30-minute slot tomorrow between 09:00 and 12:00 in my calendar.
      Return {"start": "ISO time", "end": "ISO time"}.
    output-schema: { start: string, end: string }

  - id: pick
    type: gate
    kind: input
    agent: antigravity      # the gate's question is written by the same account that read the calendar
    prompt: Which slot should I start with?

  - id: start
    type: agent
    agent: claude-code      # the work account does the work, and nothing personal
    mcp: []                 # no MCP server at all: it only needs the slot
    prompt: >-
      Start work on the task for {{nodes.pick.output.option}}, beginning at
      {{nodes.slots.output.start}}. Report what you changed.

edges:
  - { from: slots, to: pick }
  - { from: pick, to: start }
```

In the designer, the same thing is the **Agent CLI for this node** dropdown in the step's panel; a step
that chose its own CLI shows it on the canvas, so a mixed workflow can be read at a glance.

Four things worth knowing before you rely on it:

- **MCP servers belong to the CLI *and* the folder.** Each step's server list is read from its own CLI
  in its own working directory. `google-calendar` must be connected in `agy` for the folder the
  workflow runs in (see `chief mcp list --workflow find-slot-and-start`). If a step names a server its
  CLI is not connected to, the run stops with that error rather than running without it.
- **A restriction is a promise only where the CLI can enforce it.** Claude Code, Codex and OpenCode
  hide or switch off the other servers; Cursor and Antigravity can only be *told* which to use (the
  table above). For a boundary you actually trust, write `mcp: []` on the step that must not reach
  anything, and put the personal step on a CLI that hides the rest.
- **They share the workflow's folder.** Steps of different CLIs start in the same working directory, so
  a file one writes is there for the other. If personal and work must not share a folder, give the
  workflow its own `base-dir` and keep the split to the accounts, or use two workflows.
- **Cost is only tracked for CLIs that report it** (Claude Code and OpenCode). A budget does not limit
  a step on Cursor or Antigravity.

### Output schema

A compact description of the JSON you expect:

```yaml
name: schema-example
nodes:
  - id: plan
    type: agent
    prompt: Summarise my day.
    output-schema:
      summary: string                 # string, number, boolean, object, array, or any
      count: number
      items: [{ title: string, url }] # a list of objects; a key without a type accepts anything
```

If the reply does not match, the agent gets one chance to correct it; after that the node fails.

### Asking before writing

Tell the agent in the prompt to ask first. It then returns its question and proposal, the run
waits, and you answer:

```sh
chief gate show 3                       # the question and the proposal
chief gate approve 3                    # go ahead as proposed
chief gate approve 3 --value "edited text" --text "shorter please"
chief gate reject 3 --text "not now"    # the agent is told not to do it
```

The answer goes to the same agent session, so it keeps its context.

## Script nodes

Run a local script. The node's input arrives as JSON on stdin; the script prints JSON on stdout.

```yaml
name: script-example
inputs: { items: [3, 1, 2] }
nodes:
  - id: sort
    type: script
    run: scripts/sort.py            # relative to the workflow file
    input: { values: "{{inputs.items}}" }
    timeout: 30s
```

| Field | Meaning |
|---|---|
| `run` | Required. Path of the script. `.py` runs with python3, `.sh` with sh, `.ts`/`.js` with node (a `.ts` script is an ES module) |
| `interpreter` | Use another interpreter |
| `args` | Fixed extra arguments. Templates are not expanded here: node data reaches a script only through stdin |
| `input` | The JSON sent on stdin. Default: `{ inputs, item }` |
| `cwd`, `timeout` | Working directory (default: the workflow's directory), time limit (default 5 minutes) |
| `sandbox` | Widen the sandbox, see below |
| `irreversible`, `compensate` | As for agent nodes |

A script can report writes the same way agents do, by including a `side_effects` list in its
output.

### The sandbox

Every script runs sandboxed. By default it:

- has no network access;
- can create, change, move and delete files only in its working directory and in a scratch
  directory (`$TMPDIR`);
- can read most of the disk, but not credentials and secrets (`~/.ssh`, `~/.aws`, the agent CLIs'
  own folders such as `~/.claude`, `~/.gemini` and `~/.local/share/opencode`, keychains, …) or
  chief's own data;
- sees only `PATH`, `HOME`, `TMPDIR` and `LANG` from the environment.

A node can widen this:

```yaml
name: sandbox-example
nodes:
  - id: fetch
    type: script
    run: scripts/fetch.py
    sandbox:
      network: true                 # allow network access
      write: [~/reports]            # extra writable directories
      env: [REPORT_API_TOKEN]       # extra environment variables to pass through
    compensate: { run: scripts/remove-report.py }
```

- A workflow with a widened node must be approved before it runs: `chief workflow approve <name>`.
  The approval is tied to the script's content, so changing the script asks again.
- Some paths can never be granted: credentials, chief's data, shell start-up files,
  `~/Library/LaunchAgents`, `.git/hooks` and `.git/config`, and anything outside your home directory.
- `sandbox` accepts only those three keys. There is no way to turn the sandbox off.
- On Linux and Windows there is no sandbox backend yet, so script nodes are disabled there.

## Gate nodes

Stop and ask.

| `kind` | Asks for | Fields | Output |
|---|---|---|---|
| `ask` | Whatever you describe in plain words | `prompt` (the instruction), `model` | One entry per question; for a list to pick from: `selected`, `unselected`; plus `summary` |
| `select` | A choice from a list | `from` (the list), `modes`, `message` | `{ selected, unselected, mode }` |
| `approve` | Yes or no, optionally editing the value | `value`, `message` | `{ approved, value, text }`. A rejection cancels the run |
| `input` | Free text and optionally one of several options | `summary`, `options`, `message` | `{ text, option }` |

### Gates described in plain words (`ask`)

With `kind: ask` you write what you want to be asked, as an instruction. When the run reaches the
gate, an agent reads the instruction together with the results of the steps before it and prepares
a form: a list to tick, a single choice, a text box, a yes/no. Your answers are the gate's result.

```yaml
name: ask-example
nodes:
  - id: plan
    type: agent
    prompt: List the database changes that are waiting, each with a title and a risk level.
  - id: review
    type: gate
    kind: ask
    model: haiku
    prompt: Show me the list and let me cherry-pick which changes go to the database. Ask for an optional note for the executor.
  - id: execute
    type: map
    over: "{{nodes.review.output.selected}}"
    node:
      type: agent
      prompt: Apply this change.
edges: [plan -> review, review -> execute]
```

- What you tick from a list is in `selected` (the complete original items), the rest in
  `unselected`; every question is also available under its own name, and `summary` is a readable
  recap.
- It costs one small model call; a cheap `model` is enough.
- `message` on the other gate kinds is only text shown above the form. It is not an instruction.
- From the command line, `chief gate show <id>` lists the questions and options, and you answer
  with option numbers: `chief gate answer <id> '{"values":{"selected":[0,2],"note":"…"}}'`.

Select gates offer three ways to choose (`modes`, all three by default):

| Mode | Answer | Selects | `mode` in the output |
|---|---|---|---|
| `one-by-one` | `{"mode":"one-by-one","selected":[0,2]}` | The listed items | `sequential` |
| `by-priority` | `{"mode":"by-priority","priority":"P1"}` | Items with that priority or higher, most urgent first | `sequential` |
| `all` | `{"mode":"all"}` | Everything | `parallel` |

Add `"run-mode": "sequential"` or `"parallel"` to an answer to override the last column. The items
you did not pick are in the gate's output as `unselected`.

An `input` gate with an option named `restart` is special: answering with it finishes the run and
starts a new one, with the feedback text and the unfinished items in `{{inputs.carry-over}}`.

## Map nodes

Run one inner node for every element of a list.

| Field | Meaning |
|---|---|
| `over` | The list |
| `mode` | `sequential` (default) or `parallel`. May be a template, for example the `mode` of a select gate |
| `max-parallel` | How many run at once in parallel mode. Default 3 |
| `on-error` | `fail` (default): stop at the first failure. `continue`: finish the others and record the failure |
| `node` | The inner node, an `agent` or a `script`. It uses `{{item}}` |

The output is a list with one entry per element: `{ item, status, output }` (or `error`).

## When a step fails

A failed run can be resumed: completed steps keep their results, and only the failed step and the
steps after it run again. Before resuming you can change the **model** and the **prompt** of any
agent step that has not completed, including steps that have not started yet, for that run only:

- in the web UI, open the step on the run page (steps that have not started are listed under the
  others), pick another model or edit the prompt, then press **Resume**. Prompt edits save
  themselves a moment after you stop typing;
- from the command line, `chief runs set-model <run> <step> <model>` (`default` means the agent
  CLI's default) or `chief runs set-prompt <run> <step> <text or file>`, then `chief resume <run>`.

How a changed step continues:

- a failed step gets a new attempt with the new model and prompt;
- an interrupted step (paused mid-work) continues its session with a new model, but a new prompt
  starts it again from the beginning, because its session was started with the old prompt;
- a step waiting for the answer to its own question: an answer goes into its current session, with
  its current prompt. If the question shows the step cannot do its job as written, change its prompt
  instead of answering ("Change this step instead" in the question box): the question is withdrawn,
  the run is paused, and **Resume** starts the step again with the new prompt.

If you have already fixed the prompt in the designer, the step's editor on the run page offers it:
"Use version N's" copies that version's prompt and model into the run. Editing the workflow alone
does not change a run that has already started.

A new prompt is checked like an edit in the designer, templates included.

This is the way out of a context-window error ("prompt is too long", "maximum context length"):
pick a model with a larger context window instead of running the whole workflow again. The run's
record says what was changed, when, and the old and new values. The workflow itself is not changed;
change it in the designer if new runs should behave the same way.

Steps can be changed only while the run is stopped: failed, paused, interrupted, or waiting at a
gate.

## Undoing a run

`chief revert <run>` walks the completed nodes in reverse order and runs each node's `compensate`:

```yaml
name: compensate-example
nodes:
  - id: draft
    type: agent
    mcp: [google-drive]
    prompt: Create a Google Doc titled "ADR draft" with a one-paragraph outline.
    compensate:
      prompt: "Move these documents to the trash: {{output.side_effects}}"
  - id: announce
    type: agent
    mcp: [slack]
    irreversible: true              # asks you before it runs; cannot be undone afterwards
    prompt: Post "ADR draft is ready" in #architecture.
edges: [draft -> announce]
```

- A compensation is either an agent `prompt` (run in a fresh session) or a script (`run`), which
  receives `{ output, side_effects, item }` on stdin.
- Nodes that changed nothing are skipped.
- What cannot be undone automatically is listed as manual follow-up: effects marked irreversible,
  effects of nodes without a compensation, and compensations that failed.
- `chief revert <run> --to <node>` undoes only the nodes after that node.

## Budgets and cost

- `budget: { warn-usd: 2, max-usd: 4 }` on the workflow, or `--warn-usd` / `--max-usd` on
  `chief run`, or the `default-budget` setting for all workflows.
- At the warning level an event is logged. At the limit the run stops before the next node and
  opens a gate; approving raises the limit by one more step.
- `chief workflow validate` shows a size estimate for each prompt, and `chief runs show` shows the
  tokens and cost of each node.
- Use `model` on cheap nodes, and keep `max-parallel` low on maps over long lists.
- Only Claude Code and OpenCode report cost. Codex and Antigravity report tokens, Cursor nothing;
  `max-usd` does not stop steps run by those three.

## Scheduling

In the app, open **Schedules**: the same list with each expression in words, its next run, and
buttons to add, disable and remove one. Or from a terminal:

```sh
chief schedule add daily-slack "30 8 * * 1-5"    # weekdays at 08:30, local time
chief serve                                       # schedules fire while this runs
```

Schedules fire while chief runs. The desktop app keeps running after you close its window, until
you quit it, so a schedule on your laptop works with no window open; a `chief serve` started in a
terminal stops with that terminal.

A scheduled run stops at its first gate like any other; chief shows a macOS notification when a
gate is waiting (setting `notify`).
