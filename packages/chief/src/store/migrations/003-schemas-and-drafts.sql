-- One SQLite instance, one schema per feature. A SQLite file has no named schemas, so the schema
-- is the first part of every table name: <schema>__<table>.
--   workflow  definitions, schedules, script approvals
--   run       runs, node runs, gates, side effects, events, the full message record
--   agent     what the agent CLIs report (MCP servers)
--   system    settings, applied migrations
--   draft     text typed in the web UI that is not saved or sent yet
ALTER TABLE workflows RENAME TO workflow__definitions;
ALTER TABLE schedules RENAME TO workflow__schedules;
ALTER TABLE script_approvals RENAME TO workflow__script_approvals;
ALTER TABLE runs RENAME TO run__runs;
ALTER TABLE node_runs RENAME TO run__node_runs;
ALTER TABLE gates RENAME TO run__gates;
ALTER TABLE side_effects RENAME TO run__side_effects;
ALTER TABLE run_events RENAME TO run__events;
ALTER TABLE run_messages RENAME TO run__messages;
ALTER TABLE mcp_servers RENAME TO agent__mcp_servers;
ALTER TABLE settings RENAME TO system__settings;

DROP INDEX IF EXISTS node_runs_run;
DROP INDEX IF EXISTS gates_run;
DROP INDEX IF EXISTS run_events_run;
DROP INDEX IF EXISTS run_messages_run;
DROP INDEX IF EXISTS run_messages_workflow;
CREATE INDEX run__node_runs_by_run ON run__node_runs(run_id);
CREATE INDEX run__gates_by_run ON run__gates(run_id);
CREATE INDEX run__events_by_run ON run__events(run_id, id);
CREATE INDEX run__messages_by_run ON run__messages(run_id, id);
CREATE INDEX run__messages_by_workflow ON run__messages(workflow_id, id);

-- Drafts were kept in browser storage; they belong in the one database.
-- `seq` orders writes of one key: a write that arrives late never replaces a newer one.
-- A NULL value marks a removed draft, so a late write cannot bring it back.
CREATE TABLE draft__entries (
  key TEXT PRIMARY KEY,
  value_json TEXT,
  seq INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
