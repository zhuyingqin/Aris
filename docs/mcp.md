# MCP in ARIS

SomniQ Desktop manages MCP configuration globally at:

- `~/.config/SomniQ/mcp.json` (or `<ARIS_CONFIG_ROOT>/mcp.json`)

The same configured MCP servers are therefore available in every Desktop
workspace. Desktop also reads user-level Claude-compatible MCP declarations
from `~/.claude.json` and `~/.claude/settings.json`, but project and local MCP
declarations are deliberately excluded from the Desktop tool collection.
Project files continue to provide non-MCP runtime settings such as permissions,
hooks, and sandbox policy.

When the global file does not exist yet, Desktop copies STDIO entries from the
active project's legacy `.mcp.json` into it once. The project file is retained
unchanged for recovery and interoperability; subsequent Desktop edits affect
only the global file. Non-STDIO project entries are not promoted globally.

The shared CLI configuration loader retains its normal Claude Code-compatible
discovery behavior:

- `~/.claude.json`
- `~/.claude/settings.json`
- `<project>/.claude.json`
- `<project>/.mcp.json`
- `<project>/.claude/settings.json`
- `<project>/.claude/settings.local.json`

ARIS currently executes STDIO MCP servers. The config parser recognizes remote
HTTP/SSE MCP entries, but `McpServerManager` does not execute those transports
yet. Discovered STDIO tools are exposed to the model as
`mcp__<server>__<tool>` and require the `dontAsk` / `danger-full-access`
permission mode.

For mail and workspace integrations, see [mail-mcp.md](mail-mcp.md). The target
direction is provider-owned MCP first, with direct provider APIs kept as
fallback paths while remote MCP OAuth support is implemented.

## Codex and Claude Code in Desktop

The Desktop MCP settings page writes the global SomniQ file. Its equivalent
shape is:

```json
{
  "mcpServers": {
    "codex": {
      "type": "stdio",
      "command": "codex",
      "args": ["mcp-server"],
      "requestTimeoutSecs": 300
    },
    "claude": {
      "type": "stdio",
      "command": "claude",
      "args": ["mcp", "serve"],
      "requestTimeoutSecs": 300
    }
  }
}
```

The corresponding executables must be installed, authenticated, and available
on `PATH`. A server that cannot start is reported as a warning and does not
disable other healthy MCP servers.

Use `--allowedTools mcp__codex__codex` to explicitly allow an MCP tool in CLI
sessions that use an allowlist.

## Managed Oracle MCP

Oracle Web appears in the Desktop MCP settings as a SomniQ-managed MCP service.
It is intentionally not written as a generic server entry and cannot be edited
as an arbitrary command. SomniQ starts an ephemeral account-scoped Oracle MCP
worker and exposes only `ChatGptWebConsult`, `ChatGptWebImage`, and the
independent Reviewer adapter. This preserves the account routing, attachment,
output-path, approval, and audit boundaries documented in
[`development-logic/oracle-web.md`](development-logic/oracle-web.md). The MCP
detail panel owns the complete Oracle surface: managed install/update,
detected browsers, persistent isolated browser users, sign-in launch, and per-account
capability routing. There is no second Oracle settings entry to drift out of
sync.

Curated Codex, Claude Code, and Playwright presets are resolved by the native
backend rather than guessed by the web UI. The backend persists concrete local
paths, refreshes known preset paths when an installation moves, and reports
availability separately from configuration and successful tool discovery.

## Persistence and validation

Desktop MCP saves use an atomic replace and a process-local configuration lock.
Malformed STDIO fields fail visibly instead of disappearing from the editor.
Names, request timeouts, environment keys, and process strings are validated,
and a STDIO save cannot overwrite a same-named HTTP/SSE/WS entry.
