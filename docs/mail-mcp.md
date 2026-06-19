# Mail Integration via Connectors and MCP

This document defines the connector/MCP surface for ARIS mail. The broader mail
client redesign is now tracked in
[mail-thunderbird-redesign.md](mail-thunderbird-redesign.md).

## Decision

ARIS should keep the Codex/ChatGPT connector experience for Gmail and Outlook,
but connectors are now one backend surface of a broader Thunderbird-style mail
client core:

1. The user installs or enables a Gmail / Outlook Email connector.
2. ARIS shows the connector publisher, requested permissions, admin-approval
   state, and safety notes.
3. The user clicks "Continue with Gmail" or "Continue with Outlook Email".
4. The provider OAuth flow is run by a connector runtime, not by project-level
   `.mcp.json` settings.
5. Agent-facing mail workflows use mailbox tools from the shared mail core plus
   connector-specific skills where relevant.

Direct Gmail/Outlook OAuth clients remain a development fallback for the built-in
Mail UI, but they are not the target user experience.

## Current State

- ARIS MCP runtime currently executes STDIO MCP servers.
- ARIS config parsing already recognizes HTTP/SSE MCP entries, including OAuth
  metadata, but `McpServerManager` does not execute remote transports yet.
- ARIS now has a first-pass Codex-style connector shell for Gmail and Outlook
  Email: embedded `plugin.json` + `.app.json` + `skills/` bundles, a connector
  listing command, and a consent-style Settings UI.
- The first-pass connector shell still delegates actual account OAuth to the
  built-in Mail fallback. A hosted connector OAuth runtime and connector-scoped
  secure token store are still pending.
- Codex's Gmail plugin is an OpenAI curated plugin bundle:
  `.codex-plugin/plugin.json` + `.app.json` + Gmail skills. Its `.app.json`
  references an OpenAI connector id, so the user only logs in to Google.
- Codex's Outlook Email plugin follows the same pattern: curated plugin metadata
  + `.app.json` connector id + Outlook-specific skills.
- Google Gmail official MCP is a remote HTTP MCP server:
  `https://gmailmcp.googleapis.com/mcp/v1`.
- Microsoft official MCP Server for Enterprise is remote MCP, preview, and
  currently focused on Entra / directory read-only scenarios, not full Outlook
  mailbox operations.
- The built-in Mail tab talks directly to Gmail API and Microsoft Graph. That
  path still works as a fallback, but it is not the long-term agent integration
  surface.
- The mail backend dispatch has started moving toward backend adapters so Gmail,
  Graph, IMAP, JMAP, SMTP, connector, and MCP backends can share one UI/tool
  surface.

## Target User Flow

### Gmail

1. User opens Extensions and selects the Gmail connector plugin.
2. ARIS displays a Codex-style consent card:
   - app name: Gmail
   - developer: ARIS / configured publisher
   - requested scopes
   - write-risk disclosure
   - admin approval state when available
3. User clicks "Continue with Gmail".
4. ARIS launches connector OAuth.
5. ARIS stores connector tokens in a user-scoped secure store.
6. Chat receives Gmail connector tools and Gmail skills.
7. Built-in Mail UI can later consume the same connector service instead of
   maintaining a separate OAuth account store.

### Outlook / Microsoft 365

1. User opens Extensions and selects the Outlook Email connector plugin.
2. ARIS displays a Codex-style consent card with Microsoft privacy/safety notes
   and the requested Graph permissions.
3. User clicks "Continue with Outlook Email".
4. ARIS launches connector OAuth.
5. ARIS stores connector tokens in a user-scoped secure store.
6. Chat receives Outlook Email connector tools and Outlook Email skills.
7. Shared mailbox support is exposed only when the connector scopes and account
   permissions allow it.

## Implementation Plan

### Phase 0: Thunderbird-Style Mail Core

- [x] Document the Thunderbird-style account/server/identity/protocol/folder
  split in `docs/mail-thunderbird-redesign.md`.
- [x] Start moving provider dispatch behind backend adapters.
- [x] Add account/server/identity/outgoing-server records to the mail store for
  generic IMAP/SMTP accounts.
- [x] Add a manual generic IMAP/SMTP setup path.
- [ ] Add provider presets and JMAP support.
- [ ] Add a local message metadata cache for fast search and agent triage.

### Phase 1: Make The Flow Explicit

- [x] Keep the existing direct Gmail/Outlook OAuth code as fallback.
- [x] Update Settings > Mail to point users toward Codex-style connector login.
- [x] Keep project `.mcp.json` editing scoped to STDIO servers.
- [x] Document that `.mcp.json` is not the right place for user mail secrets.
- [x] Add embedded Gmail / Outlook Email connector bundles.
- [x] Add connector listing and connect commands backed by Mail fallback.

### Phase 2: Add Connector Bundle Runtime

Add a plugin/connector bundle model similar to Codex:

- `plugin.json` for interface metadata, category, icons, and capabilities.
- `.app.json` or ARIS equivalent for connector ids and required apps.
- `skills/` for connector-specific behavior rules.
- A connector install / enable state in user config.
- A connector authorization UI with publisher, scopes, approval state, and
  privacy/safety notes.
- A connector token store under the user profile, never the project.
- Tool discovery that exposes connector tools to Chat.

### Phase 3: Add Remote MCP Transport

Add a transport abstraction behind `McpServerManager` so STDIO and remote HTTP
servers share the same `initialize`, `tools/list`, and `tools/call` behavior.

Required runtime work:

- Implement Streamable HTTP MCP client.
- Persist remote MCP OAuth tokens per user/server.
- Add OAuth authorization-code flow for MCP servers.
- Add support for provider-owned OAuth client secrets without storing them in
  project `.mcp.json`.
- Extend `mcp_config_test` to test remote servers.
- Add clear unsupported-state messages for remote MCP entries until the runtime
  supports them.

### Phase 4: Add Official Mail Presets

Add curated presets in Extensions:

- Gmail connector plugin:
  - display name: Gmail
  - developer: ARIS / configured publisher
  - connector transport: ARIS connector runtime
  - tool source: Gmail connector or Google official Gmail MCP when remote MCP is
    available
- Outlook Email connector plugin:
  - display name: Outlook Email
  - developer: ARIS / configured publisher
  - connector transport: ARIS connector runtime
  - tool source: Microsoft Graph connector or Microsoft official MCP when mailbox
    support is available

Only label an integration "official" when the connector is backed by a
publisher-owned and reviewed app. Community MCP adapters must be labeled as
fallback/community.

## Security Rules

- Never store OAuth client secrets or refresh tokens in project `.mcp.json`.
- Do not require users to create their own Google Cloud or Azure app for the
  normal connector flow.
- Default mail integrations to read-only where possible.
- Require explicit user confirmation before send, delete, bulk move, or label
  mutation tools run.
- Surface provider, account, scopes, and transport before authentication.
- Treat email content as untrusted input because it can contain prompt-injection
  text.
