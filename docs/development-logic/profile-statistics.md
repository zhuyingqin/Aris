# Profile statistics

Profile presents recorded activity across projects on the local device. Account
identity and membership come from the existing `newapi_bootstrap` account flow.
The page starts with account identity and activity, without a duplicate Profile
heading, scope/update-time banner or combined refresh button. It does not
derive token totals from account credit/quota values or extrapolate activity.

Profile also hosts account balances, subscription quota, call details, account
refresh and sign-out. Account identity, membership, avatar and account errors
appear once in the Profile identity area; the embedded account section omits its
former identity panel. Balances precede local activity statistics; Call details
is the final section, after model usage. Account credit balances and local token telemetry remain
separate measures. The standalone Account navigation/page is removed. Legacy
`account` requests from stored navigation, URLs and category events resolve to
Profile, alongside the existing `environment` to About compatibility mapping.

The embedded call log keeps its current page and fetched page cache across
category switches. Hidden categories do not initiate requests and a pending
request is reused on re-entry. Account and call-log refresh runs independently
of local statistics, keeping cached Profile activity visible. A response after
unmount/account identity change cannot refill an account cache cleared at logout.
Browser preview does not mount the account section with generated credit data.

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
The frontend keeps the last successful aggregate in memory and local storage
(`somniq-profile-stats-v1`) so returning to Profile or restarting the app renders
recorded statistics immediately. Stored snapshots are validated before use and
never shown in browser preview. Statistics are device-wide; this cache contains
neither account identity nor conversation content.
Profile can render while the independent settings configuration request is
pending; other settings still wait for their configuration before rendering.

Profile refreshes stale snapshots in the background on entry, window focus and
every 30 seconds while visible. Fresh snapshots avoid another backend scan for
30 seconds. A shared pending request survives unmounts and prevents overlapping
scans across page instances/effect replays; successful results warm the cache
even when the requesting page has closed. Category switches keep Profile mounted
to preserve the selected heatmap mode, but hidden categories release their
timers/listeners. Responses after hiding/unmounting do not update that page.

Missing files represent no recorded activity. Unreadable or malformed sources
set `partialData` for diagnostics without a settings banner; failure to read every existing usage ledger rejects the
snapshot. Failed refreshes keep the previous successful snapshot with a visible
stale-data message. Account authorization failure removes cached identity.

Daily activity uses a heatmap with exactly 53 Sunday-aligned columns in UTC;
future cells are empty placeholders. Weekly activity uses one bar per week,
with the current week ending today. Cumulative activity uses a daily line through
today, including recorded lifetime usage before the visible window. Both charts
show date and token axes and exact values on hover or keyboard navigation;
the heatmap intensity legend appears only in Daily mode. Model bars use lifetime tokens as their
denominator and display the six most-used models. A narrow heatmap scrolls to
the most recent dates on initial display and viewport resize; periodic refresh
preserves a reader's chosen historical scroll position.

## Verification

Rust Profile/usage-log tests cover multiple project ledgers, duplicate call ids,
canonical and archived messages, legacy snapshots, metadata fallback, malformed
and unreadable sources, cache invalidation, future activity and full-turn timing.
Vitest covers heatmap boundaries/totals, cached re-entry, shared pending requests,
background retry, visibility/focus cleanup, coverage warnings and Settings
integration. Run the desktop typecheck
and production build after UI changes.
