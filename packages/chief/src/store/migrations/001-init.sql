CREATE TABLE workflows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1,
  definition_json TEXT NOT NULL,
  base_dir TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id INTEGER NOT NULL REFERENCES workflows(id),
  workflow_version INTEGER NOT NULL,
  definition_json TEXT NOT NULL,
  base_dir TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  inputs_json TEXT NOT NULL DEFAULT '{}',
  budget_json TEXT,
  requested_action TEXT,
  owner_pid INTEGER,
  parent_run_id INTEGER,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE node_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  node_id TEXT NOT NULL,
  node_type TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'forward',
  attempt INTEGER NOT NULL DEFAULT 1,
  parent_node_run_id INTEGER,
  item_index INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  input_json TEXT,
  output_json TEXT,
  session_id TEXT,
  usage_json TEXT,
  state_json TEXT,
  error TEXT,
  compensated_at TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX node_runs_run ON node_runs(run_id);

CREATE TABLE gates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  node_run_id INTEGER,
  node_id TEXT,
  kind TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'node',
  payload_json TEXT NOT NULL DEFAULT '{}',
  answer_json TEXT,
  status TEXT NOT NULL DEFAULT 'waiting',
  created_at TEXT NOT NULL,
  answered_at TEXT
);
CREATE INDEX gates_run ON gates(run_id);

CREATE TABLE side_effects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  node_run_id INTEGER NOT NULL REFERENCES node_runs(id),
  kind TEXT NOT NULL,
  ref TEXT,
  url TEXT,
  how_to_undo TEXT,
  irreversible INTEGER NOT NULL DEFAULT 0,
  reverted_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  node_run_id INTEGER,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX run_events_run ON run_events(run_id, id);

CREATE TABLE backlog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  kind TEXT,
  priority TEXT,
  url TEXT,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  origin_run_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE mcp_servers (
  name TEXT NOT NULL,
  adapter TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'discovered',
  config_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (adapter, name)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

CREATE TABLE schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id INTEGER NOT NULL REFERENCES workflows(id),
  cron TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  inputs_json TEXT NOT NULL DEFAULT '{}',
  last_run_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE script_approvals (
  workflow_id INTEGER NOT NULL REFERENCES workflows(id),
  node_id TEXT NOT NULL,
  script_hash TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  PRIMARY KEY (workflow_id, node_id)
);
