# Hermes adapter: one-shot stream-json contract

**Status: not verified against a real CLI.** Hermes Agent (`NousResearch/hermes-agent`) is not
installed on the machine where chief was built (2026-11-21), so this adapter was written from the
vendor's published CLI reference (`website/docs/reference/cli-commands.md` and
`hermes_cli/stream_json.py`) and is tested only against a fake CLI (`e2e/fixtures/fake-hermes.ts`)
that reproduces the documented events. The first step with a real `hermes` is to run the adapter's
cases with `CHIEF_E2E_REAL=1` and correct this page.

The adapter is `packages/chief/src/adapters/hermes.ts`. Select it with `agent: hermes`; the binary is
`hermes`. Set `hermes.path` if it is not on `PATH`.

## Invocation

```sh
hermes chat -q "<prompt>" --format stream-json \
  [--resume <session-id>] [-m <model>]
```

- **The prompt is an argument**, as the CLI documents for `-q`. chief passes it as one argv entry
  without a shell, so nothing in it is interpreted. The run record keeps the flags and records the
  prompt in its own row, exactly as the Cursor adapter does; it is not duplicated in the command line.
- `--format stream-json` requires `-q`, implies `--quiet`, and rejects `--tui`. chief passes it on
  every call, including a resumed one.
- `-m/--model` is passed only when the step names a model.
- `--resume <id>` (not `--continue`) is used for a `needs_input` answer, the JSON repair turn, and
  resume after a pause, so the exact session chief started is the one continued.
- `--oneshot`/`-Q` are not passed: non-TTY stdio already makes `-q` answer and exit, and `--format
  stream-json` implies the quiet mode.

## Output stream (from the documentation)

Every stdout line is one JSON object; diagnostics and the `session_id:` line stay on **stderr**,
which chief records and never parses. Every event carries `timestamp` (epoch ms).

| Event | Fields chief uses |
|---|---|
| `system`, `subtype: "init"` | `session_id`, `model` — the session id used for resume |
| `text` | `text` — a streamed assistant **delta**; accumulated for the record, never treated as the whole reply |
| `tool_use` | `name`, `input` — recorded as a tool call |
| `tool_result` | `name`, `output` (capped at 5000 characters by Hermes), `duration_ms`, `is_error` — recorded as the result |
| `result` | The terminal record: `session_id`, `exit_code`, `text` (the **whole** reply), `tokens`, `duration_ms`, `error` when the turn failed; `replay_gap: true` is possible and harmless because `text` is still whole |

`result.text` is the reply chief parses for the step's JSON block. The `text` deltas are recorded but
not concatenated into the answer, so nothing is counted twice.

`tokens` has `input`, `output`, `total`, `cache_read`, `cache_write`; chief maps the four parts to
its usage record and ignores `total` (the sum it already has). **No cost is reported**, so USD
budgets do not limit Hermes steps.

## Exit codes

The process exit code mirrors the terminal `result`'s `exit_code`:

| Code | Meaning | chief |
|---|---|---|
| `0` | The turn completed | Success; `result.text` is the reply |
| `1` | Failed, stopped partway, hit the iteration budget, or never ran (credentials/init) | An infrastructure failure with the `result.error` text (or stderr when it is missing) |
| `130` | Interrupted | `interrupted`; the session is kept and chief continues it with `--resume` (a run paused or cancelled by a person stays interrupted, and `chief resume` continues it later) |
| `75` | `EX_TEMPFAIL`: the provider was rate-limited, overloaded, returning 5xx, timing out, or out of quota | A failure whose message **names the provider rate-limit and its exit code 75**, so a person knows to retry; it is not worded as a fault in the step |

A crash or a timeout is reported the way the other adapters report it (`could not start …`,
`agent timed out`). chief's own pause/cancel still wins over the exit code, because it arrives as
`shouldStop`.

## Models

There is **no documented model-list command**: `hermes model` is an interactive provider/model
wizard, and `hermes chat` takes a free `-m`. `listModels` therefore returns an empty list with that
note rather than a list chief invented. Leave the model empty to use Hermes's configured default, or
name a model Hermes accepts.

## MCP servers

Hermes keeps its servers under `mcp_servers:` in `~/.hermes/config.yaml` (`$HERMES_HOME` when set)
and manages them with `hermes mcp`. chief parses that file with the `yaml` package — it never runs
the CLI for the list and never writes to it. `url` is shown as the target for a remote server;
`command` plus `args` for a stdio one. `enabled: false` (or `disabled: true`) is shown as disabled.

**Scoping is by instruction only**, as for Cursor and Antigravity. The CLI documents no flag that
names the servers one run may use (`-t/--toolsets` enables toolsets, not servers, and `--safe-mode`
disables *all* customizations including MCP servers and requires an explicit model). So chief tells
the node in the prompt which servers it may use, or that it may use none. A Hermes step could still
call any server that CLI is connected to.

## Built-in tools: a documented limitation

chief's default for an agent step is `tools: none`. **Hermes cannot be told that per run.** The
documented `-t/--toolsets` only *enables* a comma-separated set; which toolsets exist is a property
of the installation's `~/.hermes/config.yaml` (`hermes tools`), and there is no documented way to
enable none and no read-only mode (the nearest is `--safe-mode`, which also drops the user's config,
its MCP servers and its rule files, and requires `--model`).

So the adapter passes **no `-t` at all**, and `tools: none`, `read-only`, `default` and a tool list
all behave the same: **a Hermes step runs with whatever toolsets that installation has enabled**,
including shell access if Hermes has it. Passing `-t` with the names chief uses for Claude Code
would be a lie. This is a documented limitation rather than a silent grant: it is in
[README "Limits worth knowing"](../../README.md#limits-worth-knowing) and in the workflow guide's
adapter table. Use Claude Code, Codex or OpenCode for steps where the absence of built-in tools is a
security requirement.

## Not verified

Everything on this page, and in particular:

- the exact `hermes --version` format (chief reads the first `x.y.z`);
- that `--resume` accepts a `-q` prompt and `--format stream-json` in the same call;
- that a prompt beginning with `-` is still taken as the value of `-q`;
- the behaviour on SIGINT, and whether every interrupted run ends with an `exit_code: 130` result;
- that `mcp_servers:` entries use `command`/`args`/`url` as chief reads them (the published CLI
  reference links to an MCP config page that was not available when this adapter was written).
