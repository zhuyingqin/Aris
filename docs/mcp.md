# MCP in ARIS

ARIS CLI and Desktop Chat load Claude Code-compatible MCP configuration from:

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

## Codex and Claude Code

Create `<project>/.mcp.json`:

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
