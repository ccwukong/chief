-- An agent CLI's MCP servers depend on the folder it runs in (Claude Code's local scope and
-- .mcp.json), so they are remembered per folder. The list is only a cache of what the CLI reported:
-- it is read again before every run, so it starts empty here.
DROP TABLE IF EXISTS agent__mcp_servers;
CREATE TABLE agent__mcp_servers (
  adapter TEXT NOT NULL,
  folder TEXT NOT NULL,
  name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'discovered',
  config_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (adapter, folder, name)
);
-- When an adapter's servers were last read for a folder (0: the CLI reported none, ask again soon).
CREATE TABLE agent__mcp_reads (
  adapter TEXT NOT NULL,
  folder TEXT NOT NULL,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (adapter, folder)
);
DELETE FROM system__settings WHERE key LIKE 'mcp-refreshed-at.%';
