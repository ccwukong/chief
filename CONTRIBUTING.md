# Contributing to chief

Thanks for looking. chief is open source under the **Apache License 2.0** (see [LICENSE](LICENSE)),
and contributions are welcome on those terms.

## Before you open a pull request

- Read [AGENTS.md](AGENTS.md): it is the development standard, and it applies to people as much as to
  coding agents. Two rules matter most: work is tracked in [docs/dev-plan.md](docs/dev-plan.md) by task
  ID, and every task needs at least one case in [docs/e2e-test-plan.md](docs/e2e-test-plan.md) before it
  is implemented.
- Run what the change touches, not the whole suite:

  ```sh
  npm run typecheck
  npm run lint
  npx playwright test -g "E1.6-1"     # the cases the change affects
  ```

- Keep the product rules: no Save buttons, nothing typed in the web UI is lost on a refresh, every list
  is paginated, buttons that wait on the server show a spinner, and script steps always run sandboxed.
  AGENTS.md lists them all.

## How your pull request lands

`main` takes **squash and merge only**, and requires a **linear history**. In practice:

- **Bring your branch up to date by rebasing**, not by merging: `git fetch origin && git rebase origin/main`.
  The "Update branch" button rebases for the same reason. A merge commit from `main` into your branch is
  refused, and `main` itself can never contain one.
- **Your pull request becomes one commit**, using the pull request title. Write the title as the commit
  message you want on `main`: a short imperative subject (`Add a fit control to the run diagram`), not
  "Fixes" or "WIP". The body is not used as the message.
- **Squash your own noise** if you like — one commit per review round is a courtesy, not a rule.
- Nothing merges without the checks green, one approving review, code-owner approval, and every
  conversation resolved; `main` also requires branches to be up to date first.

These are GitHub settings on the repository, not a convention in this file: there is no merge button to
press by accident, and a merge commit pushed to `main` is rejected.

## Licensing of contributions (please read)

By submitting a pull request, patch, or any other change to this repository, you agree that:

1. **You have the right to submit it.** It is your own work, or you have permission from whoever owns it,
   and it does not knowingly infringe anyone's rights.
2. **It is licensed to the project under Apache-2.0**, the same terms as the project itself
   (inbound = outbound). You keep your copyright; you are not assigning it.
3. **You grant the maintainer a separate, additional license** for the same contribution: a perpetual,
   worldwide, non-exclusive, royalty-free, irrevocable copyright license, with the right to sublicense and
   **to license the contribution under other terms**, including a different open source license or a
   commercial license.

Point 3 is the "short CLA". It costs you nothing — you can keep using your own contribution anywhere — and
it is what keeps one option open for the project.

**Why it is there.** chief may one day offer a hosted service. If it does, the maintainer may need to
relicense a future version (for example to AGPL-3.0, or under a commercial license alongside the open
source one). That is only possible while every contribution can be relicensed. Without a grant like
point 3, a single outside pull request would make it impossible, permanently.

Contributions under this arrangement already exist in the history as first-party work, so nothing is
retroactive for you.

If you cannot agree to point 3 — for example because your employer owns the work — please open an issue
first instead of a pull request, and we will work something out.

## What a good change looks like

- One task ID, one change. Update the task's `Status` in the dev plan in the same commit, and never leave
  a task `in progress` when you stop.
- Record honestly: if a case could not be run, mark it `not run` with the reason. Never mark it passed.
- Tests never touch the real `.chief/`, never spend real tokens (the agent CLIs are faked by default),
  and never post to a real service.
- Match the code conventions: lower-case kebab-case file names, snake_case for SQL and the agent JSON
  contract, `<schema>__<table>` table names, numbered migrations that are never edited once applied.

## Reporting a problem

Open an issue with what you did, what happened, and what you expected. If a run failed, the most useful
thing you can attach is the run's own record: `chief runs replay <id>` (it contains prompts and results,
so remove anything private first). Do not paste API keys or tokens; chief never needs them, because the
agent CLIs keep their own credentials outside this repository.
