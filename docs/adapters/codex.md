# Codex adapter — non-interactive contract

**Status: not verified against a real CLI.** The Codex CLI is not installed on the machine where
chief was built (2026-11-10), so this adapter was written from OpenAI's published documentation and
is tested only against a fake CLI (`e2e/fixtures/fake-codex.ts`) that reproduces the documented
events. Spike 0.2 stays blocked until Codex is installed; the first step then is to run the `@real`
case E7.1-3 and correct this page.

The adapter is `packages/chief/src/adapters/codex.ts`. Select it per workflow or node with
`agent: codex`, and set its path with `chief settings set codex.path <path>` if it is not on `PATH`.

## Invocation

```sh
codex exec [resume <thread-id>] --json --skip-git-repo-check \
  [-m <model>] [--sandbox workspace-write] \
  [-c mcp_servers.<name>.enabled=<true|false>]... -
```

- The prompt is sent on stdin (`-`).
- `--json` makes stdout a JSON Lines stream.
- `--skip-git-repo-check` because chief's working directories are not always git repositories.

## Output stream (from the documentation)

| Event | Used for |
|---|---|
| `{"type":"thread.started","thread_id":"…"}` | Session id (used for resume) |
| `{"type":"turn.started"}` | ignored |
| `{"type":"item.started","item":{"type":"command_execution" \| "mcp_tool_call" \| …}}` | Logged as a tool call |
| `{"type":"item.completed","item":{"type":"agent_message","text":"…"}}` | The reply text; the last one is the final answer |
| `{"type":"turn.completed","usage":{…}}` | Success, token usage |
| `{"type":"turn.failed",…}`, `{"type":"error",…}` | Infrastructure failure |

`usage` has `input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`.
**There is no cost field**, so Codex nodes add tokens but $0 to a run. Budgets in USD therefore do
not limit Codex nodes.

## Resume

`codex exec resume <thread-id>` with the follow-up prompt on stdin. Used for `needs_input` answers,
the JSON repair turn, and resume after pause.

## MCP scoping

Codex keeps servers in `[mcp_servers.<name>]` tables of `~/.codex/config.toml` (or `$CODEX_HOME`).
chief reads that file for discovery; it does not run `codex mcp list`.

For each run, chief passes `-c mcp_servers.<name>.enabled=true|false` for every known server, so
only the node's servers are enabled.

## Built-in tools

Codex has its own sandbox, read-only by default. A node with `tools: default` or an explicit tool
list gets `--sandbox workspace-write`; otherwise the default is kept. chief's `allowed-tools`,
`disallowed-tools` and `permission-mode` fields are Claude Code concepts and are ignored here.

## Not verified

Everything on this page, and in particular:

- that `-c mcp_servers.<name>.enabled=false` is honoured per invocation (the MCP documentation
  describes the `enabled` key but not the `-c` override for it);
- the `-m` flag and the exact shape of `turn.failed` / `error` events (not shown on the
  non-interactive documentation page);
- the behaviour on SIGINT, and whether an interrupted thread can be resumed;
- that `resume` accepts `--json` and a prompt on stdin in the same way as a first call.
