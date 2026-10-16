# Profile statistics

Profile presents recorded activity across projects on the local device. Account
identity and membership come from the existing `newapi_bootstrap` account flow;
the refresh action reloads both the account and local statistics. It does not
derive token totals from account credit/quota values or extrapolate activity.

## Sources and coverage

- Tokens, model usage, turn counts, UTC daily activity, streaks and reasoning
  effort come from each project's `run-state/usage-log.jsonl`. Default, registered
  project and explicitly configured active runtime paths are included. Canonical
  paths prevent the active project's ledger being read twice.
- Tool and Skill calls come from durable `session_message` tool-use blocks and
  `session_compaction` archived messages, plus in-flight `tool_call` events.
  Counts deduplicate `(sessionId, toolUseId)` across these sources. A canonical
  reset replaces previous history. Legacy session JSON is used only when no
  corresponding canonical event log exists.
- Optional runtime metadata uses `JsonlEventSink::default_path()`, matching its
  writer even with `ARIS_CONFIG_ROOT`. Sessions already covered by desktop
  events are excluded from that fallback. Failed CLI tool calls count as calls.
- Historical skills/tools are limited to retained records. Missing telemetry is
  not reconstructed from prompt text. `metaLoggingEnabled` is retained on the
  wire for compatibility and now means historical activity coverage is available.

## Duration and refresh

`durationMs` continues to mean request latency. The separate `turnDurationMs`
field stores complete turn wall time once, on the final billable row, including
tools and approval waits. Profile uses a turn's recorded wall time where present,
with summed request latency as the fallback for identified turns. Old rows
without `turnId` repeated whole-turn duration on each request; their timestamp
groups take the maximum duration instead of multiplying it. Retained user-message/done
event pairs can contribute measured duration for older sessions. New duration
records survive normal event-log compaction.

Statistics scan on Tauri's blocking pool. Per-file summaries retain only usage
rows, tool identities/skill names and duration, not conversation content. File
length and modification time invalidate the cache. Removed sources are pruned.
Profile refreshes on demand, on window focus and every 30 seconds while visible;
unmounting releases the timer/listeners. Requests do not overlap within a mounted
refresh generation and responses after unmount are ignored.

Missing files represent no recorded activity. Unreadable or malformed sources
set `partialData`; failure to read every existing usage ledger rejects the
snapshot. Failed refreshes keep the previous successful snapshot with a visible
stale-data message. Account authorization failure removes cached identity.

The heatmap has exactly 53 Sunday-aligned columns in UTC. Future cells are empty
placeholders. Weekly tooltips show the week range and total. Cumulative values
include recorded lifetime usage before the visible window, and their tooltip
uses the same value as their intensity. Model bars use lifetime tokens as their
denominator and display the six most-used models. A narrow heatmap scrolls to
the most recent dates on initial display and viewport resize; periodic refresh
preserves a reader's chosen historical scroll position.

## Verification

Rust Profile/usage-log tests cover multiple project ledgers, duplicate call ids,
canonical and archived messages, legacy snapshots, metadata fallback, malformed
and unreadable sources, cache invalidation, future activity and full-turn timing.
Vitest covers heatmap boundaries/totals and Profile refresh, retry, focus cleanup,
coverage warnings and existing Settings integration. Run the desktop typecheck
and production build after UI changes.
