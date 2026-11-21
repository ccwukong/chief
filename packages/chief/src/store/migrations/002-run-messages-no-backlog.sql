-- The backlog was removed from the product.
DROP TABLE IF EXISTS backlog;

-- The complete, ordered record of every run: everything sent to a worker (agent CLI or script),
-- everything it sent back, what the user answered, and what chief decided. Used for replay.
CREATE TABLE run_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  workflow_id INTEGER NOT NULL REFERENCES workflows(id),
  node_run_id INTEGER,
  node_id TEXT,
  ts TEXT NOT NULL,
  direction TEXT NOT NULL,        -- in (to the worker) | out (from the worker) | user | system
  kind TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  meta_json TEXT
);
CREATE INDEX run_messages_run ON run_messages(run_id, id);
CREATE INDEX run_messages_workflow ON run_messages(workflow_id, id);
