# Cursor adapter — print-mode contract

**Status: not verified against a real CLI.** The Cursor CLI is not installed on the machine where
chief was built (2026-11-10), so this adapter was written from Cursor's published documentation and
is tested only against a fake CLI (`e2e/fixtures/fake-cursor.ts`) that reproduces the documented
events. Spike 0.3 stays blocked until the CLI is installed; the first step then is to run the
`@real` case E7.2-3 and correct this page.

The adapter is `packages/chief/src/adapters/cursor.ts`. Select it with `agent: cursor`.

**Binary name:** older releases install `cursor-agent`, which is chief's default; the current
documentation calls the binary `agent`. If yours is `agent`, run
`chief settings set cursor.path "$(which agent)"`.

## Invocation

```sh
cursor-agent -p --output-format stream-json --trust --workspace <cwd> \
  [--model <model>] [--resume <chat-id>] [--approve-mcps] [--force] "<prompt>"
```

- **The prompt is an argument.** The documentation describes no stdin form. chief passes it as one
  argv entry without a shell, so nothing in it is interpreted, but very large prompts are bounded by
  the operating system's argument limit (about 1 MB on macOS).
- `--trust` skips the workspace trust prompt in headless mode.
- `--approve-mcps` is added only when the node uses MCP servers.
- `--force` (auto-approve commands) is added only for nodes with `tools: default` or a tool list.

## Output stream (from the documentation)

| Event | Used for |
|---|---|
| `{"type":"system","subtype":"init","session_id":…,"model":…}` | Session id, model |
| `{"type":"assistant","message":{"content":[{"type":"text",…}]}}` | Reply text |
| `{"type":"tool_call","subtype":"started",…}` | Logged as a tool call |
| `{"type":"result","subtype":"success","is_error":false,"result":"…","session_id":…}` | Final answer |

On failure the CLI exits non-zero, writes to stderr, and may end without a `result` event; chief
treats that as an infrastructure failure.

**No token or cost fields are documented**, so Cursor nodes add nothing to a run's usage and
budgets do not limit them.

## Resume

`--resume <chat-id>` with the follow-up prompt, using the `session_id` of the first call.

## MCP scoping — weaker than the other adapters

Cursor reads servers from `~/.cursor/mcp.json` and `<workspace>/.cursor/mcp.json`; chief reads the
same files for discovery.

The CLI has no per-invocation switch to hide a configured server (`agent mcp enable|disable`
change global state, which chief does not touch). So for Cursor, chief can only **tell** the node
which servers it may use, in a note appended to the prompt. A node can technically call any server
that is approved in Cursor. Use Claude Code or Codex for nodes where hard scoping matters.

## Not verified

Everything on this page, and in particular:

- whether the session started by `-p` can be resumed with `--resume` in print mode;
- the behaviour on SIGINT;
- whether `--approve-mcps` is needed for servers already approved interactively;
- the version string format (`chief doctor` shows whatever `--version` prints).
