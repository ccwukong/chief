# Claude Code adapter — headless contract

Result of spike 0.1, run on 2026-11-10 against Claude Code **2.1.311** on macOS, driven through
`node:child_process`. Everything below was observed, except where marked *not verified*.
The adapter is `packages/chief/src/adapters/claude-code.ts`; minimum supported version is 2.1.300.

## Invocation

```sh
claude -p --output-format stream-json --verbose \
  --disable-slash-commands --permission-prompts none \
  [--model <alias|id>] [--resume <session-id>] [--permission-mode <mode>] \
  [--allowedTools <…>] [--disallowedTools <…>] \
  [--strict-mcp-config --mcp-config '<json>']
```

- **Prompt goes on stdin.** With no stdin, the CLI waits 3 s and warns, so chief always pipes the prompt.
- `--verbose` is required for `stream-json` in print mode.
- `--permission-prompts none`: anything that would prompt is denied automatically. Denied calls are
  listed in the result's `permission_denials`.
- `--disable-slash-commands` keeps skills out of the session.
- Sessions are stored per working directory, so a resume must use the same `cwd` as the first call.
  chief stores the node's `cwd` on the node run.

## Output stream

One JSON object per line. The ones chief reads:

| `type` / `subtype` | Used for |
|---|---|
| `system` / `init` | `session_id`, `model`, tool list |
| `assistant` | `message.content[]` blocks: `text`, `tool_use` (`name`, `input`) |
| `user` | `tool_result` blocks (`is_error`) |
| `result` | Final line: `subtype`, `is_error`, `result` (final text), `session_id`, `total_cost_usd`, `usage`, `modelUsage`, `permission_denials`, `num_turns` |

Other lines (`system/hook_started`, `hook_response`, `rate_limit_event`) are ignored.

`usage` fields: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`.
The model name is the key of `modelUsage`.

**Cost note:** a minimal call with no MCP servers still carries about 39k tokens of system prompt
(cache write on the first call, cache read afterwards). On the cheapest model that was about $0.008
for the first call and $0.001–0.002 for later ones.

## Exit codes and errors

| Situation | Exit code | `result` line |
|---|---|---|
| Success | 0 | `subtype: success`, `is_error: false` |
| Interrupted with SIGINT | 0 | `subtype: error_during_execution`, `is_error: true` |
| Crash / bad flags | non-zero | none |

chief therefore never relies on the exit code alone: no `result` line, or `is_error: true`, is an
infrastructure failure (retried once, and never if the node already reported side effects).

## Resume

`--resume <session_id>` continues the conversation and keeps the same `session_id`. Verified for:

- a normal follow-up turn (used for `needs_input` answers and the JSON repair turn);
- a session that was interrupted with SIGINT mid-reply (used for pause → resume). The resumed
  session knew what it had been asked.

## Pause

SIGINT to the process group. Observed: the CLI wrote the `result` line within about a second and
exited 0. chief escalates to SIGKILL after 5 s if the process is still alive.

## MCP scoping

chief never connects to MCP servers. It tells Claude Code which ones a node may use.

There are two kinds of server on this machine, and they need different handling:

| Kind | Example | How it is scoped |
|---|---|---|
| **Connector** (managed by the claude.ai account) | `claude.ai Slack` | Cannot be passed via `--mcp-config`. chief allows the node's servers with `--allowedTools mcp__<prefix>` and removes every other known server with `--disallowedTools mcp__<prefix>` |
| **File-configured** (`~/.claude.json`, `.mcp.json`) | a local stdio server | When a node uses only these, chief generates a per-run `--mcp-config` and adds `--strict-mcp-config`, so no other server is loaded at all |

- Tool names are `mcp__<prefix>__<tool>`, where the prefix is the server name with every character
  outside `[A-Za-z0-9_-]` replaced by `_` (`claude.ai Slack` → `mcp__claude_ai_Slack`).
- `--allowedTools mcp__claude_ai_Slack` allows every tool of that server.
- Verified against the real Slack connector: the allowed server's tool ran; a Datadog tool in the
  same session was denied and reported in `permission_denials`; servers named in
  `--disallowedTools` did not appear in the tool list.
- Connectors start as `pending` in headless mode and their tools are loaded on demand through the
  built-in `ToolSearch` tool, so chief always keeps `ToolSearch` available.
- Because of that, the model does not see a connector's tools up front and sometimes answered
  "no Slack tools are available" without trying. The adapter therefore appends a short note to the
  prompt naming the node's servers, their tool prefix and `ToolSearch`. With the note the real-CLI
  case E2.2-5 passes; without it, it failed twice.

### Where the server list comes from

chief has no MCP configuration. Before every run it asks Claude Code which servers it has and
whether each is connected. Three sources, in this order:

1. **The control protocol (`mcp_status`).** A session started with
   `claude -p --input-format stream-json --output-format stream-json --verbose` answers
   `control_request` lines on stdin without any prompt or model call. The request
   `{"subtype": "mcp_status"}` returns `mcpServers: [{ name, status, scope, config, tools… }]`.
   Servers connect in the background after the session starts, so the first answers can be empty
   or `pending`. chief repeats the request every 0.5 s until nothing is pending and the list has
   stopped changing (measured on 2026-11-10 with 51 connectors: settled after about 4 s as 9
   `connected`, 42 `needs-auth`; five runs in a row gave the same result). It gives up after 12 s.
   The same protocol's `initialize` request returns the account's model list (0.2 s).
2. **The `init` line of a throw-away session**, if the control request is not supported. It carries
   `mcp_servers: [{ name, status }]`, but it is a snapshot taken at start-up: in about one run out
   of three it listed **no servers at all**, because they had not loaded yet. chief first used
   this as its only source, which made the designer show an empty server list. An empty answer
   from this source is therefore never believed.
3. **`claude mcp list`**, last. It health-checks every server, so it is slow and variable: 15 s
   once, 12 min 51 s later the same day. chief allows it 20 minutes.

An answer with no servers is not remembered: it is asked again the next time.

A node's server names are resolved against that list. `needs-auth` and `failed` stop the run
before any agent call, with that reason. If a server fails later, the agent is instructed to
finish with `{"status": "mcp_unavailable", "server", "error"}` and chief fails the node with that
error; this only applies to the node's own servers.

## Built-in tools

**`--tools` must not be used.** It restricts the built-in set, but on 2.1.311 it also removes every
MCP server from the session (`mcp_servers: []` in the init line), so a node could never reach its
connectors. This was found by the real-CLI e2e case E2.2-5, not by the first spike.

chief hides built-in tools with `--disallowedTools` instead. The node's `tools` field maps to:

| `tools:` | Hidden | Allowed without prompting |
|---|---|---|
| `none` (default) | acting tools and read tools | none |
| `read-only` | acting tools | `Read`, `Grep`, `Glob` |
| `default` | nothing | nothing extra |
| a list | acting and read tools not in the list | the listed tools |

"Acting tools" is a fixed list in the adapter (`Bash`, `Edit`, `Write`, `NotebookEdit`, `WebFetch`,
`WebSearch`, `Task`, `Workflow`, …). Unknown names in the deny list are ignored by the CLI, and a
built-in tool the list misses still cannot act, because nothing can approve it under
`--permission-prompts none`.

**Do not hide every built-in tool.** When `ToolSearch` was the only built-in left, the init line
still listed it, but the model could not call it ("No such tool available: ToolSearch") and so
could not load any connector tool. Bisected on 2.1.311: hiding either half of the remaining tools
was fine, hiding all of them broke it. The adapter therefore leaves three inert tools visible
(`ListAgents`, `ReportFindings`, `TaskStop`).

Verified against the real CLI with the adapter's final deny list: `Bash` and `Read` were
unavailable to the model while the allowed Slack connector still worked.

## Not used, on purpose

- `--json-schema`: exists, but chief validates output itself so the same contract works for every adapter.
- `--max-budget-usd`: chief enforces budgets across nodes at the run level.
- `--bare`: would skip the keychain, which is where the login lives.

## Not verified

- Behaviour on Linux or Windows.
- The tool prefix for server names with unusual characters (parentheses, non-ASCII).
- Versions older than 2.1.311; the minimum of 2.1.300 is a conservative guess.
