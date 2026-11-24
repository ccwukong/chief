# chief bot: how it is designed

chief bot is the assistant behind the sparkle in the left rail. It answers questions about chief and about a
run, it builds and changes the workflow on the designer's canvas, and it adds, changes and removes schedules.
This document is the design: what it is made of, what it is given, what it may return, what is recorded, and
what it deliberately does not have.

The one sentence that explains most of the design: **chief has no model of its own.** Every answer is one run
of an agent CLI the person already has installed, and chief decides what that CLI is told and what it is
allowed to do. That is why chief needs no key of its own, why the bot costs nothing beyond the CLI's own
plan, and why the prompt is the programme.

## The shape of it

```
  page (the panel)            server                        agent CLI                  model
  ─────────────────           ──────                        ─────────                  ─────
  question ──── HTTP ────▶    ask.ts: build the prompt  ──▶  one process per question ──▶ provider
                              check what comes back         its own session store
  answer   ◀─── HTTP ────     write it down
                                   │
                                   ▼
                             chief.db  (assistant__messages, assistant__threads)
```

Three parts, and the boundaries between them are the design:

| Part | What it owns | What it never does |
|---|---|---|
| `packages/web/src/assistant.tsx` | The panel: the question, the answer, the change it applied, Undo, the history dropdown | Talk to a CLI, or decide what the agent is told |
| `packages/chief/src/ask.ts` | Assembling the prompt, choosing the CLI, sessions, compaction, checking and writing what comes back | Call a model, hold an API key, or know what a workflow is *for* |
| the agent CLI | The model, its own authentication, the tool loop, and the session that is continued | Persist anything chief needs; chief keeps its own record |

`assistant-design.ts` holds the words — the system prompts and the blocks the agent may return — and the
checks on a proposed change. It is separate from `ask.ts` because two conversation modes share it: the
designer's canvas and the panel opened anywhere else.
## One question, one process

chief bot is **not a running agent**. There is no daemon, no open socket to a model, and nothing that happens
between questions. Each question is one spawn of the CLI (`adapter.run` in `packages/chief/src/ask.ts`),
with a five-minute ceiling, and the answer is that process's last text.

Continuity comes from the CLI's **session**, not from a process chief keeps alive: the CLI reports a
`session_id` with every answer, and a follow-up is a new process given `resumeSessionId`. So the process is
ad-hoc while the conversation is continuous — the CLI's own store is where the context lives. That has two
consequences that matter elsewhere in this document:

- chief cannot see into a resumed session or trim it, which is why compaction is chief's own mechanism
  (see [Sessions, memory and compaction](#sessions-memory-and-compaction)).
- A follow-up is only resumed when it is the same conversation, from the same page, against unchanged
  material. The check is a **fingerprint**, and it is deliberately strict:

| What the page is | What must be unchanged to continue the session |
|---|---|
| The designer | The canvas, compared canonically — layout and written-out defaults do not count as a change (`canonical()`) |
| A run's page | The run's record size, the last event id, and the number of runs |
| Anywhere else | The last event id and the number of runs |

A session is also not continued when the answer before it wrote a schedule (the new `#id` is something the
conversation has never seen, so the next prompt must list it) or when it has been retired by a compaction.
When any of that fails, the next question is a **fresh** session given the context again plus the last ten
exchanges.

The panel allows one question at a time — while an answer is in flight the box is locked and the button is
**Stop** — and Stop is a signal to the CLI's process group, the same way a paused run stops
(`cancelAssistantAnswer`). A stopped answer is not a failure: the panel says so, and nothing recorded is lost.

## What it is given

The panel is the context. The same code answers in three situations, and each one is handed different
material.

| Asked | It is given | Assembled by |
|---|---|---|
| In the designer | The workflow **on the canvas** exactly as it is now, valid or not: steps, prompts, schemas, edges, inputs, budget, the workflow's validity errors, the MCP servers the CLI reports for its folder, its schedules with their `#id`s, and the workflow names already taken | `describeCanvas()` |
| On a run's page | That run described in full: the steps as drawn, each attempt with its status, the prompt it was sent, its result, the text it wrote besides the result, tool calls, gate questions and answers, side effects, and the events of note | `describeRun()` |
| Anywhere else | chief as a whole: every workflow with its steps, every schedule with its `#id`, the newest 20 runs with status and error, and the gates waiting for the person | `describeOverview()` |

On a run's page and in the designer it is also given **chief as a whole** (`describeOverview`), so a question
asked while designing ("which runs failed?") is answered about this machine instead of refused. That was a
real report: the panel declined a question it could have answered, because it had the run's record and
nothing else.

Two smaller rules keep the prompt honest:

- **What is cut is labelled.** A long prompt, result or reply is clipped with a marker saying how much was
  left out (`…[cut: 1,204 more characters not shown]`), so the agent knows it is not seeing everything. The
  whole run description is capped as well.
- **The reach is described from the same source as the reach itself.** `reachInstructions()` and
  `assistantTooling()` are two readings of one setting, so the prompt cannot say "you have tools" while the
  CLI was given none. That mismatch was a real bug: the bot refused work it could do.

On a fresh session the conversation is also given its own past: the last ten exchanges, and — if it has been
compacted — the thread's memory, before those exchanges.

## What it can return

The agent's answer is text, and in that text it may put fenced blocks. Each block's *language tag* is its name,
and its body is one JSON object:

````text
```chief-workflow   the complete workflow
```chief-schedule   one schedule to create, change or delete
```chief-options    two to six choices to offer the person
````

The last block of each kind wins, and the blocks are removed from the prose the person reads. There are four
outcomes, and only three of them change anything.

| In the reply | Means | Checked by | Written by |
|---|---|---|---|
| prose | An answer, an explanation, a question back | — | nowhere |
| a `chief-workflow` block | The **complete** workflow | `checkProposal()` | the page, through the canvas, then the designer's autosave |
| a `chief-schedule` block | One schedule to create, change or delete | `checkScheduleReply()`, `checkSchedule()`, the cron parser | the server, immediately, through the same functions the Schedules page uses |
| a `chief-options` block | Two to six short choices to offer the person | `readReply()` (truncated to six) | the panel, as buttons |

**In the designer**, a workflow block is a change to the canvas. chief checks it, notes what differs
(`summarizeChange` → "Added: …", "Renamed to …"), and hands it to the page, which puts it on the canvas only
if the canvas has not been edited by hand in the meantime. The designer's own autosave then stores it, so
there is one way a workflow is written. Each change is listed under the answer with **Undo**.

**Outside the designer**, the same block is a **proposal**: a new workflow, checked against an empty
definition, offered in a card with the step count, and created with one click that opens it in the designer.
Nothing exists until the person presses that. This is the half that was missing until 2026-11-23, when
asking for a workflow from the run list got "chief hasn't given me a format for workflow changes in this
conversation" — true, and useless.

**A schedule is not a draft.** It is written by the server inside the same answer, with the workflow's own
inputs checked, so a schedule chief bot writes is exactly one added by hand — and one that would be refused
is refused with the reason, before anything is written. A `delete` carries only an `id`; a schedule is not
recoverable in place, so the answer records what went and what to write to bring it back.

**One correction, not a loop.** If a block is not acceptable, chief sends the reasons back to the same
session and asks for that block again — once. If the corrected block does not come, the reasons are still
kept and shown to the person (`change_error`, `proposal_error`, `schedule_error`), because "nothing was
changed" without a reason is a dead end.

### What a change may not touch

A person chooses three things in the designer from lists the agent CLI owns, and chief bot may not set them,
however it is asked. This is enforced in `checkProposal()`, not only asked for in the prompt:

- `model` — chosen from the CLI's own list;
- `agent` — the agent CLI that runs the step;
- `sandbox` — a script's network, write paths and environment, which the person grants and approves.

A workflow block that introduces any of them as a *new* value is refused with the step named. Writing them
back exactly as they were is allowed. The same rule applies to a proposed new workflow, which is why it can
never create a step with a model already set.

The format between steps is also the agent's job: a placeholder that reads a field its producer's
`output-schema` does not name is refused, so "design the data contract" cannot silently ship a broken
connection.

## What it may reach

chief bot is an **agent**, not a prompt form: it has the CLI's own tools and, optionally, its MCP servers.
What it gets is a setting, and the panel says which one is in force ("read-only tools, no MCP servers")
beside the folder it works in.

| Setting | Default | Meaning |
|---|---|---|
| `assistant-tools` | `read-only` | `none`; `read-only` (read and search); `default` (everything the CLI offers, including writing and a shell) |
| `assistant-mcp` | `none` | `none`, or `all` — every server the chosen CLI is connected to in that folder |

The defaults are conservative on purpose. The bot can rewrite the canvas, and a write-capable agent reading
an untrusted file is how a workflow gets rewritten by something it was asked to read. The folder is the
canvas's `base_dir`, else the run's, else chief's workspace.

Chief never speaks MCP itself and holds no MCP configuration: the server list is read from the CLI before a
run, and the CLI's own settings decide what it may call.

**Every tool call is recorded**, because a conversation with tools is a run and a run is recorded in full:
the tool's name and input, and its result (capped at 4,000 characters), as `tool` rows in the thread. The
panel shows them beside the answer (`assistantActions`), so the bot's actions are visible rather than implied.

## Sessions, memory and compaction

A long conversation must not end because a CLI's context filled up, and the fix cannot be left to the CLI:
Claude Code compacts its own session, `cursor-agent` has none and refuses outright once it is full. So chief
measures what it can see and takes over.

**What it measures.** Every answer reports the tokens the CLI read — `input_tokens`, plus the cache reads and
writes, which are input the session carried. The thread's most recent figure is the conversation's size as
the CLI experienced it — not a guess at a model's window, which chief does not know.

**The budget.** `assistant-context-budget`, 100,000 tokens by default (never below 10,000). It is a setting
because the right number depends on the CLI, and a person can move it without a release.

**What happens at the budget**, before the next answer:

1. A separate call, with **no tools and no session**, is given the last 40 exchanges (each clipped) and asked
   for notes to a successor: what the person is doing, what was decided, the facts and identifiers that
   matter, what is still open, what did not work. At most 700 words.
2. The notes are stored on the thread (`assistant__threads.memory`), with the id of the last message they
   cover (`compacted_through`) and when (`compacted_at`).
3. That id is what **retires the session**: a session whose newest message is at or before it is never
   resumed again. A session begun after a compaction resumes normally, which is why this is an id and not a
   flag.
4. The next answer comes from a **fresh** session seeded with the notes, and the panel says so: "Context
   compacted · started from notes (N tokens)". A reply that suddenly comes from a fresh session looks like it
   forgot things unless it says why.

Nothing is thrown away: the messages stay, the notes stay, and the compaction itself is recorded as a `tool`
row with `call: "compaction"` — it was a real invocation with a prompt of its own, and every invocation is
recorded — without being shown as a conversation turn.

**A failed compaction is not a failed answer.** If the notes cannot be written, the question still goes
through on the session it would have used: losing the conversation is worse than a large prompt.

## Threads and the record

The conversation lives in its own `assistant` schema, never in browser storage.

| Table | Holds |
|---|---|
| `assistant__messages` | Every row of every conversation: `user`, `prompt`, `assistant`, `tool` — the question, the exact prompt and command line, each tool call and result, and the answer with its adapter, model, session, usage, cost, whether it continued, the fingerprint, and what it changed |
| `assistant__threads` | One row per conversation: a title taken from its first question (set once, at most 120 characters), when it was created and last used, which one is current, and the memory and compaction columns above |

**History is a dropdown, not a second list in the panel.** The header's clock opens past conversations over
the thread: pick one to carry on where you left off, or use its bin to delete that conversation and
everything in it — which asks first, because it cannot be undone. **New** starts a fresh thread and keeps the
old one. The typed question is a draft, like every other text field: a reload does not lose it.

**Refine rewrites the question before it is sent.** The sparkle button in the composer sends the typed text
to `POST /api/prompts/refine` with the bot's own CLI and model, and puts the rewritten prompt in the box; the
original is kept behind "Back to my text", also as a draft, so a rewrite is never a loss. It is a separate
call from the answer, and the bot never sees the original unless the person sends it.

The panel reaches the rest of chief over HTTP only; it imports no engine code.

| Endpoint | Purpose |
|---|---|
| `GET /api/assistant?run_id=&workflow=` | The conversation, the CLI and model that will answer *this page*, what it may reach, the folder, and the actions taken |
| `POST /api/assistant` | Ask. `{ question, model?, run_id?, workflow? }` — `workflow` is the designer's canvas |
| `DELETE /api/assistant/pending` | Stop the answer in flight |
| `GET /api/assistant/threads` | Past conversations |
| `POST /api/assistant/threads` | Start a new one |
| `POST /api/assistant/threads/:id/use` | Continue that one |
| `DELETE /api/assistant/threads/:id` | Delete it and everything in it |

`DELETE /api/assistant` clears everything, and is what an older client's "clear" meant. The command line has
its own path for a run: `chief runs ask <id> "<question>"` (`POST /api/runs/:id/ask`) answers from the run's
record and writes the exchange into **the run's** record, not into a conversation — the same idea, filed
where a run's reader looks for it.

## Which CLI answers

One function answers that question everywhere (`assistantAdapterFor`), so the line in the panel cannot name
one CLI while another answers. In order:

1. `assistant-adapter`, when it names a CLI — a decision about the assistant itself wins everywhere;
2. else the run's agent CLI, on a run's page;
3. else the workflow's `agent`, on the canvas;
4. else chief's default CLI, but only if chief may use it — a default that names a CLI since switched off
   fails every question otherwise, so the first enabled CLI is the honest fallback.

The model is `assistant-model` (empty means the CLI's own default), and the list is always the CLI's. A step's
model is never reused for the bot.

## Failure, and what the person is told

Errors are the CLI's words plus chief's reading of them (`explainAgentError`), because "usage limit" and
"model not in your plan" need different actions:

| What happened | What the panel says |
|---|---|
| A plan or quota refused the request | That it is not something chief can retry; the CLI's own message names the limit, which model is excluded, or when it resets. Switch the model, or the CLI. |
| The model is not on this plan | That the model is not included, and to pick another or switch the CLI |
| The context is too long | To start a fresh chat: the old one stays in the history, and a fresh session gets the last few exchanges |
| The CLI's session no longer exists | Silent recovery: the question is re-asked in a fresh session with the whole context |
| The person pressed Stop | "stopped" — not an error, and the conversation stays |
| The agent returned nothing | "the agent returned nothing" |
| A schedule or workflow was refused | The reason, kept on the answer even when the correction never arrives |

## What it deliberately does not do

- **No model of its own, and no API key.** chief calls no model, which is also why Mastra was considered and
  rejected: it needs a model provider, and giving it one over a CLI would put a second tool loop on top of an
  invisible first one.
- **No background agent.** Nothing runs between questions; closing the panel, the page or the browser ends
  nothing that was running, because nothing was.
- **No autonomous change.** A workflow changes only through a block chief checked and the page applied, and
  a schedule only through a block chief checked. The bot cannot edit the database, the files or the CLI's
  configuration.
- **No MCP configuration.** The servers are the CLI's; chief reads them and holds none of its own.
- **No script files.** It can put a `script` step in a workflow, but it cannot create the file the step runs.
- **No use-case logic.** Nothing in `ask.ts` or `assistant-design.ts` knows what a workflow is for; the
  workflow language, the data contract and the schedule rules are the whole of its domain knowledge.
- **No secrets.** The CLI's authentication stays in the CLI; chief never sees or stores a token.

## Where the code is

| File | What it does |
|---|---|
| `packages/chief/src/ask.ts` | One answer end to end: context, prompt, CLI choice, session and resume, compaction, checking the reply, writing a schedule, the record |
| `packages/chief/src/assistant-design.ts` | The prompts and the three blocks; the canvas description; `checkProposal` and `summarizeChange` |
| `packages/chief/src/server/app.ts` | The `/api/assistant` endpoints, `/api/runs/:id/ask`, and the settings the panel reads |
| `packages/web/src/assistant.tsx` | The panel: turns, actions, changes with Undo, proposals, history, Stop, the Refine button |
| `packages/web/src/pages/settings.tsx` | Settings › chief bot: CLI, model, reach, MCP, compaction budget |
| `packages/chief/src/store/store.ts` | The `assistant` schema's reads and writes, including the thread memory and its token figure |
| `packages/chief/src/store/migrations/005-assistant.sql`, `006-assistant-threads.sql`, `009-assistant-memory.sql` | The tables, the threads, the compaction columns |

## Reading further

- [README › chief bot](../README.md#chief-bot) — what it is like to use, in a page.
- [docs/workflow-guide.md](workflow-guide.md) — the workflow language and the data contract it writes against.
- [AGENTS.md](../AGENTS.md) — the rules every part of chief keeps, including "every run is recorded in full".
- The development plan's reasoning, task by task: 9.62 (answer about a run), 9.64 (the panel), 9.65 (builds
  the canvas), 9.66 (the data contract), 15.32 and 15.106 (schedules), 15.69 (an agent, not a prompt form),
  15.87 (configured in Settings), 15.98 (compaction), 15.115 (a workflow from anywhere, and a thin request
  gets questions).
