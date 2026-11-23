# Terms

**Last updated: 2026-11-21.**

chief is free, open-source software. There is no account, no company behind it, no hosted service and
nothing to buy. These terms say, in plain words, what you are responsible for when you run it, and what
happens if it goes wrong.

## 1. The software is Apache-2.0, and these terms do not change that

chief is licensed under the [Apache License, Version 2.0](LICENSE). That licence is what grants you the
right to use, copy, change and redistribute chief — including commercially — and **nothing on this page
takes any of it away.** Where these terms and the licence differ about the software, the licence wins.

These terms also cover the project's website, and restate the licence's warranty and liability sections
so that nobody has to read legal drafting to know where they stand.

## 2. What you are responsible for

chief runs agent CLIs on your machine, with the permissions you give them, and it runs scripts in a
sandbox. You choose what a workflow does, what each step is allowed to reach, and which agent CLI and
MCP servers it uses. So you are responsible for:

- the workflows you write or ask chief bot to write, and the prompts in them;
- the actions an agent takes with the access it has — sending a message, opening a pull request,
  changing a file;
- keeping your own backups. chief's state is a SQLite database and a folder of workflows under
  `~/.chief`. If that folder is lost, damaged or deleted, the workflows and run history in it are gone;
- the accounts, API keys, agent subscriptions and MCP servers you connect, and the terms of those
  services. They are not ours, and we cannot answer for them;
- making sure what you do with it is lawful where you are.

## 3. No warranty

chief is provided **"as is", without warranty of any kind**, express or implied, including the
warranties of merchantability, fitness for a particular purpose and non-infringement. Nobody promises it
will work, be free of defects, or suit what you want it for. This is the same disclaimer as section 7 of
the Apache-2.0 licence.

## 4. Limitation of liability

To the maximum extent permitted by law, the author and contributors are **not liable for any loss or
damage** arising from chief or from using it: lost or corrupted data, lost work, lost time, lost profits
or revenue, or any indirect, incidental, special or consequential damages, however caused and whether or
not anyone was told the loss was possible. This is the same limitation as section 8 of the Apache-2.0
licence.

Nothing here limits a right the law gives you and does not let you waive — for example, mandatory
consumer protection where you live.

## 5. The name and the logo

The Apache-2.0 licence gives you no right to use the name **chief** or its logo for your own version.
You may say, truthfully, that your work is based on chief or uses chief. You may not present a modified
build as chief itself.

## 6. Changes

These terms may be updated as the project changes; the date at the top is when that last happened. The
version that applies to you is the one in the repository at the time you use it. The licence cannot be
retroactively restricted: a version already released under Apache-2.0 stays under Apache-2.0.

## 7. What chief sends, and what it does not

chief has no analytics, no crash reporting and no account. It makes one request of its own: on launch it
asks GitHub whether a newer release exists (turn that off with `CHIEF_NO_UPDATE_CHECK=1`). Everything
else that leaves your machine is what your agent CLI or an MCP server sends, to services you are already
signed in to. More in [README.md](README.md#the-desktop-app-macos).

That is about the app. **This website is separate from it**: it counts visits with **Cloudflare Web
Analytics**, which sets no cookie, stores nothing in your browser and builds no profile of you, so there is
no consent banner to dismiss. It tells the maintainer how many people read the page and roughly where they
came from. Nothing you do inside chief reaches it.

## 8. Contributions

Contributions are welcome under the same licence and the contributor grant described in
[CONTRIBUTING.md](CONTRIBUTING.md).

---

*These terms are written to be read, and are not legal advice. If you need certainty for a commercial
deployment, have a lawyer look at them.*
