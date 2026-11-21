/**
 * Help shown by the "?" next to a setting: what it is for, and an example.
 * Keep the text plain and short; add an entry here for any new setting that is not self-explanatory.
 */
export const HELP: Record<string, { text: string; use?: string; example?: string }> = {
  // ── designer header ──────────────────────────────────────────────────────
  "wf-name": { text: "The workflow's name. You use it to run the workflow from the command line and to find its runs. Lower-case letters, digits and dashes. Changing it renames the workflow.", example: "daily-slack" },
  "wf-warn": { text: "A soft budget for one run, in US dollars. When a run has spent this much, a warning is logged and the run carries on. Leave empty for no warning.", example: "2" },
  "wf-max": { text: "A hard budget for one run, in US dollars. When a run has spent this much it stops before the next step and asks you whether to continue. Leave empty for no limit.", example: "4" },
  "wf-base-dir": {
    text: [
      "Optional. The folder this workflow works in. Empty gives it its own folder.",
      "Set it to work inside a specific folder, such as a repository: script paths are relative to it and agents start in it.",
      "It is the only project folder a sandboxed script may write to.",
    ].join("\n"),
    example: "~/code/my-service",
  },
  "wf-inputs": { text: "The workflow's inputs: one JSON object for the whole workflow, with one section per block, named by the block's id. A block's prompt reads its own values as {{inputs.<block id>.<name>}} (any block may read any section). Run shows this JSON so the values can be changed for that run; what is set here is the default.", example: '{\n  "planner": { "prlink": "https://github.com/my-org/app/pull/42" },\n  "runner": { "dry-run": true }\n}\n\nIn planner\'s prompt: "review {{inputs.planner.prlink}}"' },

    // No `use` block: a tooltip with text, a use case and an example is three sections to open one "?",
  // and this one was reported as "way too much, no one would read this" (2026-11-21). The examples are
  // what a person copies; the prose says the rest.
  assistant: { text: "Ask in plain words. It answers from what chief has recorded — your workflows, recent runs, waiting gates, and the run you are looking at — and says what went wrong and what to do next. In the designer it builds the workflow on the canvas, and each change can be undone. It has no tools, runs nothing, and never picks a model or grants a script permissions.", example: "What went wrong, and what should I do next?\nWhich runs failed today?\nIn the designer: add a step that collects each person's metrics, then one that writes the review from them." },
  "gate-output": { text: [
      "A gate's output is your answer, and its shape is fixed by the gate's kind.",
      "The next step is given it automatically.",
      "input: { text, option }",
      "approve: { approved, value, text }",
      "select: { selected, unselected, mode }",
      "ask: one field per question",
    ].join("\n"), example: 'An input gate "gate" with the options approve, comment:\n\nIf {{nodes.gate.output.option}} is "approve", approve the pull request. Otherwise post the comments.' },

  // ── any node ─────────────────────────────────────────────────────────────

  // ── agent node ───────────────────────────────────────────────────────────
  prompt: {
    text: [
      "What the agent should do, in plain language.",
      "Insert values with {{…}}: run inputs, earlier results, or {{item}} in a map.",
      "JSON and the list of changes are added for you — no need to ask.",
    ].join("\n"),
    example: "Summarise my Slack for the last {{inputs.lookback-hours}} hours.\nList action items with a title and a priority.\nRead only. Do not post anything.",
  },
  context: { text: [
      "Steps share results, not a conversation: each agent call is its own session.",
      "A step is given what the steps before it returned, as free-form JSON — it can be any JSON, no schema needed.",
      "Tick only the steps whose results this one actually needs.",
    ].join("\n"), example: "Step 1: \"Find my action items in Slack.\"\nStep 2: \"Do the first one.\"  (it is given step 1's result automatically)" },
  mcp: { text: [
      "Which servers this step may use, from the CLI that runs it.",
      "Default: every server that CLI is connected to, and the agent decides.",
      "Tick some to restrict it. Tick none to give it no servers.",
      "chief never adds or signs in to a server — the CLI does.",
    ].join("\n"), example: "Leave it on \"all\" for a general assistant step.\nRestrict a \"summarise Slack\" step to slack so that it cannot post to GitHub or Jira." },
  agent: { text: [
      "Use a different agent CLI for this step: another account, or a cheaper model for simple work.",
      "It overrides the workflow's choice. The model list and the MCP servers follow the CLI, because they belong to it.",
    ].join("\n"), example: "cursor" },
  model: { text: "The model this step runs on. The list comes from the agent CLI itself. The first entry lets the CLI use its own default. A cheaper model is a good choice for simple steps.", example: "haiku for a quick summary,\nopus for a careful code review" },
  tools: { text: "Which of the agent's built-in tools (not MCP) this step may use. \"none\": only the MCP servers ticked above. \"read-only\": may also read files in the working directory. \"default\": everything the CLI offers, including running commands and editing files.", example: "none for a Slack summary;\nread-only to let it read a repository" },
  "output-schema": { text: [
      "Optional. The fields later steps may rely on, as JSON shorthand.",
      "The agent is told the shape and the result is checked against it. A mismatch is sent back for a correction.",
      "Read the whole result with {{nodes.<id>.output}}. Without a schema, reading one field can fail.",
    ].join("\n"), example: '{"summary": "string",\n "items": [{"title": "string", "priority": "string"}]}\n\nLater: {{nodes.plan.output.items}}' },
  "compensate-prompt": { text: "How to undo what this step did. Used only when you revert a run. {{output.side_effects}} is the list of changes the step reported. Leave empty for steps that only read.", example: "Delete these documents: {{output.side_effects}}" },
  irreversible: { text: "Tick this when the step does something that cannot be taken back, such as sending a message. The run then stops and asks you before running the step." },

  // ── script node ──────────────────────────────────────────────────────────
  run: { text: "The script file to run, relative to the working directory. Python (.py), shell (.sh) and TypeScript or JavaScript (.ts, .js) are recognised. The script reads its input as JSON from standard input and must print JSON.", example: "scripts/summarise.py" },
  interpreter: { text: "The program that runs the script, when the file extension is not enough to tell.", example: "python3.12" },
  timeout: { text: "How long the step may take before it is stopped and marked failed. A number followed by s, m or h.", example: "90s" },
  input: { text: "What the script receives on standard input, as JSON. Text values may use {{…}}. Leave empty to send the run inputs (and the current item inside a map).", example: '{"items": "{{nodes.plan.output.items}}"}' },
  "sandbox-network": { text: "Scripts run in a sandbox with no network access. Tick this only for a script that must call a service. You will be asked to approve it before the workflow can run." },
  "sandbox-write": { text: "A sandboxed script may change files only in the working directory and in a temporary folder. List further folders it may write to, one per line. Needs your approval. Credentials, start-up files and anything outside your home folder can never be listed.", example: "~/reports" },
  "sandbox-env": { text: "Scripts do not see your environment variables. List the names of the ones this script needs, separated by commas. Needs your approval.", example: "GITHUB_TOKEN" },
  "compensate-run": { text: "A script that undoes what this step did. Used only when you revert a run. It receives the step's result and reported changes as JSON on standard input.", example: "scripts/delete-report.py" },

  // ── gate node ────────────────────────────────────────────────────────────
  kind: { text: [
      "How the run asks you when it stops here.",
      "ask: you describe what to ask, and a model builds the form from it and the previous result.",
      "The rest are fixed forms with no model call: select, approve, input.",
    ].join("\n"), example: "ask, when you would otherwise have to explain the form;\napprove before something is sent" },
  "gate-prompt": { text: [
      "Write what you want to be asked, as you would tell a colleague.",
      "At the gate an agent reads it with the previous step's result and builds the form.",
      "Answers reach the next step: what you tick as …selected, the rest as …unselected.",
    ].join("\n"), example: "Show me the action items and let me cherry-pick which ones to add to the database for the executor. Ask for an optional note too." },
  from: { text: "The list you choose from, usually the result of an earlier step.", example: "{{nodes.plan.output.items}}" },
  modes: { text: "The ways of choosing that are offered. one-by-one: tick items; they run one after another. by-priority: everything up to a priority, most urgent first. all: everything, in parallel." },
  message: { text: "Text displayed above the form when the run stops here. It is shown as it is; it is not an instruction and nothing acts on it. To describe what should be asked, choose the kind \"ask\" instead.", example: "Which of these do you want to handle now?" },
  value: { text: "What you are asked to approve. You can edit it before approving; the edited version is what the next step receives.", example: "{{nodes.draft.output.text}}" },
  summary: { text: "Context shown above the text box, usually the result of the step before.", example: "{{nodes.act.output}}" },
  options: { text: "Buttons offered with the text box, separated by commas. An option named restart finishes the run and starts a new one that carries your feedback over.", example: "done, restart" },

  // ── map node ─────────────────────────────────────────────────────────────
  over: { text: "The list to go through. The inner step runs once for each element and refers to it as {{item}}.", example: "{{nodes.choose.output.selected}}" },
  mode: { text: "Run the elements one after another (sequential) or several at once (parallel). It can also be taken from a select gate's answer.", example: "{{nodes.choose.output.mode}}" },
  "max-parallel": { text: "In parallel mode, how many elements run at the same time. A low number keeps cost and rate limits under control.", example: "3" },
  "on-error": { text: "What happens when one element fails. fail: stop and fail the run. continue: finish the others and record the failure in the result." },
  "inner-type": { text: "What runs for each element: an agent with a prompt, or a script." },

  // ── new run ──────────────────────────────────────────────────────────────
  "new-run-inputs": { text: "The inputs for this run: one JSON object in the same shape as the workflow's own inputs, with one section per block, named by the block's id. A prompt reads a value as {{inputs.<block id>.<name>}}. While the box is empty it shows, in grey, the shape the workflow's prompts expect. An input you leave out takes the value stored in the workflow, if it has one.", example: '{\n  "planner": { "prlink": "https://github.com/my-org/app/pull/42" },\n  "runner": {}\n}' },

  // ── schedules ────────────────────────────────────────────────────────────
  "schedule-cron": { text: "When the workflow runs, as a five-field cron expression: minute, hour, day of the month, month, day of the week. Times are local. A star means every value, a range is written 1-5, a list 1,3,5, and a step *\/15. Day of the week counts Sunday as 0 or 7. The row shows what the expression means and when it next fires, so you can check it at a glance.", use: "Every weekday at half past eight, so the review is ready when you sit down: 30 8 * * 1-5.", example: "0 9 * * *      every day at 09:00\n*\/15 * * * *    every 15 minutes\n0 18 * * 5    every Friday at 18:00" },

  // ── settings ─────────────────────────────────────────────────────────────
  // One entry per agent CLI, so each "?" names its own program and its own usual place, instead of
  // repeating the first CLI's program in all of them (task 15.12).
  "setting-path-claude-code": { text: "Where the Claude Code program is installed. Leave it empty when `claude` can be started by name from a terminal.", example: "/opt/homebrew/bin/claude" },
  "setting-path-codex": { text: "Where the Codex program is installed. Leave it empty when `codex` can be started by name from a terminal.", example: "/opt/homebrew/bin/codex" },
  "setting-path-cursor": { text: "Where the Cursor agent program is installed: its command is `cursor-agent`, not `cursor`. Leave it empty when `cursor-agent` can be started by name from a terminal.", example: "~/.local/bin/cursor-agent" },
  "setting-path-antigravity": { text: "Where the Antigravity program is installed: its command is `agy`. Leave it empty when `agy` can be started by name from a terminal.", example: "/opt/homebrew/bin/agy" },
  "setting-path-opencode": { text: "Where the OpenCode program is installed. Leave it empty when `opencode` can be started by name from a terminal.", example: "/opt/homebrew/bin/opencode" },
  "setting-path-hermes": { text: "Where the Hermes Agent program is installed. Leave it empty when `hermes` can be started by name from a terminal.", example: "/opt/homebrew/bin/hermes" },
  "setting-path-pin": { text: "A path left empty is looked up on PATH every time a step runs, so you never have to fill these in: an upgrade that moves the program keeps working. This switch writes the path that was found into the fields, for a machine where chief is started with a PATH that does not have the CLIs (a launch item, another user's terminal). Turning it off clears the paths it filled and leaves a path you typed yourself alone.", use: "You start chief from the login item, and doctor says every CLI is missing although they are installed: pin the paths once and they are found from then on.", example: "/opt/homebrew/bin/codex" },
  "setting-warn-usd": { text: "The warning level, in US dollars per run, for workflows that set no budget of their own. Leave empty for none.", example: "2" },
  "setting-max-usd": { text: "The spending limit, in US dollars per run, for workflows that set no budget of their own. At the limit a run stops and asks you. Leave empty for none.", example: "5" },
  "setting-workspace-dir": { text: "Where workflows that have no working directory of their own get their folder: one subfolder per workflow, created the first time it runs. Leave it empty for the default, .chief/workspace in chief's source folder.", example: "~/code/flows  →  ~/code/flows/daily-slack" },
};
