# Thunderbird-Style Mail Redesign

This document resets the ARIS mail direction around a Thunderbird-style mail
client core plus ARIS connector/agent surfaces.

## Source References

- `thunderbird/thunderbird-website` is a website build repository for
  thunderbird.net and start.thunderbird.net. Use it for product onboarding,
  copy, visual hierarchy, and download/start-page inspiration only.
- Thunderbird's mail architecture references should come from Thunderbird Source
  Docs, especially:
  - Accounts, Servers and Identities:
    `https://source-docs.thunderbird.net/en/latest/backend/accounts.html`
  - Email Protocols:
    `https://source-docs.thunderbird.net/en/latest/backend/email_protocols.html`
  - Folders:
    `https://source-docs.thunderbird.net/en/latest/backend/folders.html`
  - Message Database:
    `https://source-docs.thunderbird.net/en/latest/backend/message_database.html`

## Decision

ARIS mail should become a provider-neutral local mail client core. Gmail API and
Microsoft Graph remain backend adapters, not the product architecture. The
normal account model is:

1. Account: user-visible mailbox profile.
2. Incoming server: IMAP, JMAP, Gmail API, Graph, Exchange, or connector service.
3. Identity: sender name, email address, signature, and outgoing server.
4. Outgoing server: SMTP or provider send API.
5. Folder: provider-neutral tree node with stable role mapping.
6. Message database: local metadata cache for list/search/agent context.
7. Message store: optional local body/attachment cache with explicit retention.
8. Connector tools: safe agent-facing operations over the same core.

## What Changes

The current ARIS implementation is API-first:

- Gmail account implies Gmail OAuth, Gmail API, and Gmail send.
- Outlook account implies Graph OAuth, Graph folders, and Graph send.
- Tokens and account config live in `~/.aris/mail/accounts.json`.
- Chat Agent cannot directly use mail tools yet.

The redesigned model is client-core-first:

- Account setup creates account + incoming server + identity + outgoing server.
- Backends implement a shared message service interface.
- Protocol details are hidden behind backend adapters.
- The Mail UI and Agent tools call the same mailbox service.
- Local cache becomes the source for fast list/search/triage, with provider sync
  preserving server truth.
- Write operations are permissioned separately from read operations.

## Backend Adapter Registry

The first code-level migration is the backend registry in
`desktop/src-tauri/src/mail/provider.rs`.

Current adapters:

- `GmailBackend`: Gmail API for identity, folders, list, read, modify, send.
- `GraphBackend`: Microsoft Graph for identity, folders, list, read, modify,
  send.
- `ImapBackend`: generic IMAP read/list/mark/move plus SMTP send through a
  Python stdlib helper. This is a dependency-light first pass so users can test
  real mailboxes before the native backend is finalized.

Next adapters:

- `SmtpBackend`: generic send through an identity's outgoing server.
- `JmapBackend`: Fastmail/Stalwart-style modern mail API.
- `ConnectorBackend`: hosted Gmail/Outlook connector runtime.
- `McpBackend`: STDIO or remote MCP-backed mailbox tools when appropriate.

## Account Setup Roadmap

### Phase 1: Stabilize The Core

- Keep existing Gmail/Graph behavior working.
- [x] Route all provider calls through backend adapters.
- [x] Add account/server/identity/outgoing-server records to the store schema
  for generic IMAP/SMTP accounts.
- Add safe migration from the current `accounts[]` store format.
- Keep direct OAuth fields as development fallback only.

### Phase 2: Generic Providers

- Add account setup presets:
  - Fastmail JMAP or IMAP/SMTP.
  - iCloud IMAP/SMTP app password.
  - Yahoo IMAP/SMTP app password.
  - Zoho IMAP/SMTP app password.
  - Proton Mail Bridge local IMAP/SMTP.
  - Custom IMAP/SMTP.
- Default to read-only IMAP until SMTP is explicitly enabled.
- Keep all secrets user-scoped and outside project `.mcp.json`.
- [x] Add a manual generic IMAP/SMTP setup form under Settings > Mail.
- [x] Add IMAP/SMTP test and connect commands.

### Phase 3: Local Cache

- Add a local message metadata database.
- Cache folder/message headers first; bodies and attachments remain opt-in.
- Normalize flags: unread, starred/flagged, archived, trash, labels/categories.
- Track provider UIDs/change tokens so sync is incremental.

### Phase 4: Agent Tools

Expose mailbox tools to Chat through the same permission policy as other ARIS
tools:

- [x] `mail_accounts`
- [x] `mail_folders`
- [x] `mail_search`
- [x] `mail_read`
- [ ] `mail_draft_reply`
- [x] `mail_send`
- [x] `mail_mark`
- [x] `mail_move`
- [ ] `mail_triage`

Read/search tools can run in read-only mode. Send, delete, bulk move, and label
mutation require explicit confirmation.

Current security note: generic IMAP/SMTP passwords are stored in the user-scoped
`~/.aris/mail/accounts.json` file in the same first-pass style as existing OAuth
tokens. This is acceptable only for local testing; production should move these
secrets to the OS credential store or an encrypted ARIS vault.

### Phase 5: Connector Runtime

For Gmail and Outlook, the long-term consumer experience is still a
Codex/ChatGPT-style connector:

- User clicks Continue with Gmail/Outlook.
- ARIS or a hosted connector runtime owns the OAuth app.
- Tokens are stored in a user-level secure store.
- Connector tools are discovered by Chat and reused by the Mail UI.

## UI Direction

Use Thunderbird's product experience as the shape, adapted for ARIS:

- Left rail: unified accounts and folders.
- Center list: compact message rows optimized for triage.
- Right pane: reading/compose surface.
- Setup flow: provider presets first, advanced manual settings second.
- Security copy: show provider, transport, account, read/write scope, and local
  cache policy before authentication.

Do not copy Thunderbird website code into ARIS. The useful part is the product
framing and mature mail-client separation, not the static-site build system.
