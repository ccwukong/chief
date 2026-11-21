-- chief bot's own compaction, so a long conversation does not depend on the CLI's memory (task 15.98).
--
-- The bot does not keep an agent running: each question spawns the CLI once, and a follow-up is a new process with
-- `--resume <session>` — the CLI's stored session is the context, so chief cannot see into it or trim it. While that works
-- there is nothing to do (Claude Code compacts its own session); but `cursor-agent` has no compaction and refuses outright
-- once its context is full, and a session can outgrow what the CLI keeps.
--
-- So a conversation gets a **memory** of its own: a short, dated summary that chief writes by asking the CLI for one when
-- the session grows past a budget, and then feeds into the next fresh session. It sits on the thread, because it is a
-- property of the conversation rather than of one message.
--
-- `compacted_through` is the id of the last message that went into the memory. It is how the stored `session_id` stops
-- being reused: a session whose messages are all at or before that id is retired, and the next question starts from the
-- memory instead. A session begun *after* a compaction resumes normally, which is why this is an id and not a flag.
ALTER TABLE assistant__threads ADD COLUMN memory TEXT;
ALTER TABLE assistant__threads ADD COLUMN compacted_through INTEGER;
ALTER TABLE assistant__threads ADD COLUMN compacted_at TEXT;
