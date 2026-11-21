/**
 * How to add an MCP server to each agent CLI, as text for the person to run.
 *
 * chief reads the servers from the CLIs and never writes them: it holds no MCP configuration of its own
 * (AGENTS.md), so the CLI's own file stays the single source of truth. This is the part that was missing —
 * the Settings page could list the servers and refresh them, but said nothing about where a new one comes
 * from, so a person was left to find each CLI's syntax themselves.
 *
 * Every command here was read from the CLI's own `--help` on 2026-11-21, not from memory. Where a CLI has
 * no command for adding a server, the entry says so and shows the config it reads instead; the difference
 * matters, because a form in chief that appears to add a server and cannot is worse than a snippet.
 */
export interface McpGuide {
  /** Where the servers live, in the words of the thing that owns them. */
  where: string;
  /** Commands to add one, in order; `snippet` is used instead when the CLI has no command. */
  add: string[];
  /** A config block to paste, for the CLI that only reads a file. */
  snippet?: string;
  /** How to remove one, when the CLI has a command for it. */
  remove?: string;
  /** One thing that trips people up about this CLI. */
  note?: string;
}

export const MCP_GUIDE: Record<string, McpGuide> = {
  "claude-code": {
    where: "Claude Code's own configuration, written by `claude mcp`: local scope applies to this folder, user scope to every folder.",
    add: [
      "claude mcp add --transport stdio <name> -- npx -y <package>",
      'claude mcp add --transport http <name> https://example.com/mcp --header "Authorization: Bearer …"',
    ],
    remove: "claude mcp remove <name>",
    note: "Add --scope user to reach every folder, or leave it out to keep the server to the folder you are in. A claude.ai connector is not one of these: it is a connection your account provides, authenticated per connector at claude.ai/customize/connectors.",
  },
  antigravity: {
    where: "Antigravity's own configuration (`agy mcp`), one list for every folder.",
    add: ["agy mcp add <name> npx -y @modelcontextprotocol/server-filesystem /work"],
    remove: "agy mcp remove <name>",
    note: "Flags go before the name: a flag after it is rejected.",
  },
  cursor: {
    where: "~/.cursor/mcp.json for every folder, or .cursor/mcp.json inside one.",
    add: [],
    snippet: '{\n  "mcpServers": {\n    "files": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/work"]\n    }\n  }\n}',
    note: "`cursor-agent` can enable, disable or sign in to a server it already knows, but it cannot add one: it reads mcp.json.",
  },
  opencode: {
    where: "OpenCode's own configuration; `opencode debug config` prints what it is using.",
    add: [
      "opencode mcp add --url https://example.com/mcp --header \"Authorization=Bearer …\" <name>",
      "opencode mcp add   # a local server: an interactive prompt, so run it in a terminal",
    ],
    note: "A remote server can be added with flags; a local one needs the prompt, which chief cannot answer for you.",
  },
  codex: {
    where: "~/.codex/config.toml, under [mcp_servers.<name>].",
    add: [],
    snippet: '[mcp_servers.files]\ncommand = "npx"\nargs = ["-y", "@modelcontextprotocol/server-filesystem", "/work"]',
    note: "Codex has no command for this: the config file is the only way in.",
  },
  hermes: {
    where: "Hermes's config.yaml, under mcp_servers.",
    add: [],
    snippet: "mcp_servers:\n  files:\n    command: npx\n    args: [\"-y\", \"@modelcontextprotocol/server-filesystem\", \"/work\"]",
    note: "Read from the published CLI reference; the file is the only way in.",
  },
};
