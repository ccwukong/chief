# chief — instructions for Claude Code

The development standard is **[AGENTS.md](AGENTS.md)**, and the rules this repository enforces are in
**[docs/guardrails.md](docs/guardrails.md)**. Read both before changing code.

They are not suggestions an agent has to remember:

```sh
npm run check     # typecheck + lint + guardrails; the same thing CI runs
```

- `docs/dev-plan.md` is the specification and the task list; work is tracked there by task id.
- `docs/e2e-test-plan.md` lists the cases; every task needs at least one, and the plan-coverage case
  fails if that is not true.
- State lives in `~/.chief`, never in this checkout.
