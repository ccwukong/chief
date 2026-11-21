-- chief bot's conversations become several, so a person can go back to what they were talking about (asked
-- 2026-11-22: "the chief bot should allow user to view historical chats too, because the user may wanna continue the
-- previous conversation").
--
-- A thread is a row of its own with a title, so the list reads as a list of conversations rather than a wall of
-- messages. The messages are untouched apart from the column that says which thread they belong to: everything that
-- existed before this migration belongs to one thread, which is found (or made) and given the id 1. Nothing is
-- deleted, so an upgrade keeps the conversation a person already had.
CREATE TABLE assistant__threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- The thread a new question continues unless it has moved on (a page change, a new run event): the panel reopens
  -- this one on load, which is the "created automatically" half of the decision.
  current INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE assistant__messages ADD COLUMN thread_id INTEGER REFERENCES assistant__threads(id);

-- One thread for what is already there, and the messages of that conversation filed under it. Written as SQL rather
-- than in code so an installed chief upgrades itself, with no state left to a migration script that might not run.
INSERT INTO assistant__threads (title, created_at, updated_at, current)
  SELECT '', COALESCE(MIN(ts), datetime('now')), COALESCE(MAX(ts), datetime('now')), 1 FROM assistant__messages;
UPDATE assistant__messages SET thread_id = (SELECT id FROM assistant__threads ORDER BY id LIMIT 1) WHERE thread_id IS NULL;

CREATE INDEX assistant__messages_thread ON assistant__messages(thread_id, id);
