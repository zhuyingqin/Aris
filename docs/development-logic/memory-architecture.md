# ARIS Memory Architecture

ARIS uses a local-first, layered memory model shared by the desktop app and CLI.
The design is inspired by Hermes Agent's compact always-on memory plus searchable
history, while preserving ARIS's existing multi-file reference notes.

## Memory classes

| Class | Purpose | Storage | Prompt behavior |
|---|---|---|---|
| User profile | Stable identity, preferences, and communication style | `~/.config/aris/hot-memory/USER.md` | Always injected, within a 1,375-character visible-scope budget |
| Stable facts | Durable environment and project facts | `~/.config/aris/hot-memory/MEMORY.md` | Always injected, within a 2,200-character visible-scope budget |
| Task history | Prior work, decisions, progress, and conversations | Per-project session JSON plus `session-index.sqlite3` | Retrieved on demand with `session_search` |
| Knowledge notes | Long-form reference material | `~/.config/aris/memories/*.md` | Catalog injected; files loaded on demand with `read_file` |
| Procedures | Repeatable workflows and instructions | Skills | Loaded or invoked on demand |

Do not store secrets, raw logs, temporary paths, short-lived task progress, or
reusable procedures in hot memory.

## Hot memory

`USER.md` and `MEMORY.md` are human-readable Markdown files. Each entry has a
metadata comment containing:

- `id`
- `source`
- `scope`
- `created_at`
- optional `expires_at`

Scopes are either `global` or `project:<id>`. Desktop projects use the desktop
project id. CLI projects use a stable hash of the canonical workspace path.
Only global entries and entries for the active project are injected. Expired
entries are retained on disk for auditability but are not injected or counted
against the visible-scope budget.

Writes are atomic and serialized with a local write lock. Add, replace, and
remove operations cannot modify entries from another project scope.

## Approval and provenance

Set `memory_write_approval` in `~/.config/aris/config.json`, toggle it in desktop
Settings, or use:

```text
/memory approval on
/memory approval off
```

When approval is enabled, agent-proposed writes are staged under
`~/.config/aris/hot-memory/pending/`. Review them with:

```text
/memory pending
/memory approve <id>
/memory reject <id>
```

Every committed entry records a short source label. The memory tool also rejects
common prompt-injection phrases before committing content.

## Session search

Each project keeps its own SQLite FTS5 index beside its persisted sessions:

```text
<sessions-dir>/session-index.sqlite3
```

Session saves update the index best-effort. Searches also synchronize existing
session JSON files, so older sessions become searchable without migration.
English-like text uses FTS5 ranking and snippets. CJK queries use a substring
fallback because the bundled FTS5 tokenizer does not provide reliable CJK word
segmentation.

The model can call `session_search`. Users can search from either shell:

```text
/session search <query>
```

## Shared integration

The desktop app and CLI both:

- inject the same hot-memory and knowledge-memory prompt blocks;
- expose the `memory` and `session_search` model tools;
- use the same memory approval configuration;
- report active hot-memory entries, pending writes, scope, and knowledge notes
  through `/memory`.

## External providers

`runtime::MemoryProvider` is the extension interface for an optional external
memory backend. Its lifecycle supports initialization, system-prompt additions,
prefetch, turn synchronization, session-end synchronization, memory-write
notifications, and shutdown.

`MemoryProviderManager` permits at most one external provider. Initialization
can fail explicitly; non-critical runtime callbacks are best effort. The
built-in local stores remain the default, and the interface does not require an
external service.
