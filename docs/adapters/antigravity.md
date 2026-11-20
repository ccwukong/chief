# Antigravity adapter: print-mode contract

**Status: checked against a real CLI**: `agy` 1.5.11 on macOS (2026-11-19), with the model
`gemini-3.8-flash-low`. The adapter is `packages/chief/src/adapters/antigravity.ts`. Select it with
`agent: antigravity`. The binary is `agy`; set `antigravity.path` if it is not on PATH.

## Invocation

```sh
agy --print= --input-format stream-json --output-format stream-json \
  [--model <model>] [--conversation <id>] --mode plan|auto
```

stdin carries one line: `{"event":"user","message":{"role":"user","content":"<prompt>"}}`.

- **The prompt goes on stdin, never on the command line.** `--print` always takes a value (given a
  separate word, it swallows the next flag, and agy exits 2 with a message), so chief passes it
  empty (`--print=`). With `--input-format stream-json`, agy reads the prompt from stdin, one turn
  per line, and exits when stdin closes. A line without `"event"` fails with
  `stream input message is missing the "event" field`.
- `--model` takes an id from `agy models`. An unknown model fails at once with exit 1 and an
  `ERROR` result that lists the available models.
- **Built-in tools → `--mode`.** `tools: none` and `tools: read-only` give `--mode plan` ("research and
  plan without making changes"). `tools: default` or a tool list gives `--mode auto`, which approves
  file edits and safe commands and still asks before irreversible actions. Headless runs without
  `--mode` use Auto where it is available, so chief always passes `--mode`. agy has no switch that
  turns off its read tools, so `none` is not stricter than `read-only`.

## Output stream (observed)

| Event | Used for |
|---|---|
| `{"event":"init","conversation_id":…,"init":{"model":…,"cwd":…,"tools":[…]}}` | Session id, model |
| `{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":…,"state":"ACTIVE"\|"DONE","usage":…}}` | Reply text, built up per `step_index` |
| `{"event":"step_update","step_update":{"step_type":"tool","state":"ACTIVE","tool_name":…,"tool_info":{"parameters":…}}}` | Tool call |
| `… "step_type":"tool","state":"DONE"\|"ERROR","tool_info":{"output":…\|"error":{"message":…}}` | Tool result |
| `{"event":"result","result":{"status":"SUCCESS"\|"ERROR","response":…,"error":…,"usage":…}}` | Final answer, totals |

`result.usage` has `input_tokens`, `output_tokens`, `thinking_tokens` and `cache_read_tokens`
(input does not include the cached part). chief counts thinking tokens as output. **No cost is
reported**, so USD budgets do not limit Antigravity nodes.

A failure ends with `"status":"ERROR"` and the reason in `result.error`, and agy exits 1.

## Resume

`--conversation <id>` with the `conversation_id` from the first call, and the follow-up prompt on
stdin. Checked: the resumed turn answered from the first turn's context.

## MCP servers

agy keeps its servers in `~/.gemini/config/mcp_config.json` (plus servers that plugins bring).
`agy mcp list` prints them as a table (`NAME TYPE STATUS COMMAND/URL`), and chief reads that table.
The status is `enabled` or `disabled`. agy reports no connection state outside a session, so an
enabled server is shown as `configured`. agy has no per-folder servers.

**Scoping is by instruction only**, as for Cursor. agy has no per-invocation switch to hide a
configured server: `--settings` takes `settings.json` keys, and none of them is documented for
this. `agy mcp enable|disable` changes global state, which chief never touches. So chief tells the
node in the prompt which servers it may use, or that it may use none.

## Models

`agy models` prints `id<TAB>display name` per line. These fill the model dropdown.

## Not verified

- **Whether `--mode plan` lets the agent call MCP tools.** If plan mode blocks MCP calls that
  write, a node with the default `tools: none` cannot post or write through MCP. Checking it needs
  a server in the real `~/.gemini/config/mcp_config.json`: agy's sign-in is tied to `HOME`, so a
  throw-away home cannot be used.
- The behaviour on SIGINT (pause). The fake CLI covers chief's side.
- Whether `agy mcp list` includes servers that come from plugins.
