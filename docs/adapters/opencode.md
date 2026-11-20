# OpenCode adapter: run-mode contract

**Status: checked against a real CLI**: `opencode` 1.18.31 on macOS (2026-11-19), with the free
model `opencode/big-pickle`. The adapter is `packages/chief/src/adapters/opencode.ts`. Select it
with `agent: opencode`. Set `opencode.path` if the binary is not on PATH.

## Invocation

```sh
[OPENCODE_CONFIG_CONTENT='{"mcp":{…}}'] opencode run --format json \
  [-m <provider/model>] [-s <session-id>] (--agent plan | --auto)
```

- **The prompt goes on stdin**: `opencode run` reads the message from stdin when none is given on
  the command line. Checked.
- `-m` takes `provider/model`, as `opencode models` lists them.
- **Built-in tools.** `tools: none` and `tools: read-only` run OpenCode's `plan` agent, which cannot
  edit files. `tools: default` or a tool list runs the default (build) agent with `--auto`, which
  approves every permission the config does not deny. Like agy, `none` is not stricter than
  `read-only`.

## Output stream (observed)

Every line has `type`, `timestamp`, `sessionID` and a `part`.

| `type` | Used for |
|---|---|
| `step_start` | Starts a step; the reply text is collected per step |
| `text` (`part.text`) | Reply text |
| `tool_use` (`part.tool`, `part.state.{status,input,output}`) | Tool call and its result (one event once it has finished) |
| `step_finish` (`part.reason`, `part.tokens`, `part.cost`) | Usage per step. `reason: "tool-calls"` means another step follows; any other reason (`stop`) ends the turn |
| `error` (`error.name`, `error.data.message`) | Failure |

`tokens` has `input`, `output`, `reasoning` and `cache.{read,write}`. chief adds them up over the
steps and counts reasoning as output. **`cost` is in USD** (0 for free models), so budgets do
limit OpenCode nodes. The result is the text of the last step that wrote any.

A bad model gives an `error` event (`UnknownError`, "Unexpected server error…") and no
`step_finish`. chief fails the node with the message.

## Resume

`-s <sessionID>` with the follow-up prompt on stdin. Checked: the resumed turn answered from the
first turn's context.

## MCP servers

- **Discovery:** `opencode debug config` prints the resolved configuration for the folder (global
  `~/.config/opencode/opencode.json[c]` merged with the project's `opencode.json`), and its `mcp`
  map gives the servers. `opencode mcp list` connects to each server and prints its status
  (`connected`, `failed` with the error on the next line, `disabled`), which chief keeps with the
  server.
- **Per-run scoping:** OpenCode merges the JSON in `OPENCODE_CONFIG_CONTENT` over its own
  configuration, deep-merging each server's entry (checked with `opencode debug config`). For a
  node restricted with `mcp:`, chief sets `{"mcp":{"<other>":{"enabled":false}}}` for every server
  the node did not choose, for that process only. An `OPENCODE_CONFIG_CONTENT` that is already set
  is kept and merged. A node that is not restricted gets no override. The run record shows the
  override in front of the command line.

## Models

`opencode models` prints one `provider/model` per line (over 100 with the default providers).

## Not verified

- Whether the `plan` agent may call MCP tools that write (OpenCode's default permission for MCP
  tools is to allow).
- The behaviour on SIGINT (pause). The fake CLI covers chief's side.
- The exact wording of the "needs authentication" status in `opencode mcp list`. chief matches any
  status that starts with "needs".
