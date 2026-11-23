# Memory L0 / L1: raw-session search and pitfall lessons

Status: implemented on `exp/memory-design` (2026-11-22). Evidence and the full
experiment tree: `experiments/memory/report/index.html`.

## Why

Offline replay on local history (426 sessions, 1,560 user turns) with two
probe sets:

| Task | Current production | Best tested | Store that wins |
|---|---|---|---|
| Cross-session recall (132 probes) | 49% (per-turn block, generous) | 70% bigram BM25 on raw messages | raw sessions; extracted v2 atoms 2-3% |
| Re-learning a fixed pitfall (104 events) | 4% | 69% lesson notes + failure trigger | short lessons; raw history 21% |

So the two jobs want opposite stores: facts and decisions stay in the raw
sessions (no extraction), and only "failure -> fix" lessons are extracted.

## L0: session search (no model calls)

- `messages_bigram_fts` is a contentless FTS5 table (`contentless_delete=1`)
  keyed by `messages.rowid`. Its text is a projection: every CJK run becomes
  overlapping two-character tokens, other alphanumeric runs one lowercase word.
  Two-character Chinese words therefore get real BM25 weight; the trigram
  tokenizer cannot match them, and the old LIKE path had no IDF.
- CJK queries rank by `-bm25 x (0.5 + 0.5 x 0.5^(age / 30 days))` over at least
  80 candidates, then keep one hit per session as before. Pure-English queries
  keep the existing `messages_fts` AND/OR path.
- Migration: an index written by an older build gets the table empty and the
  `bigram_ready` flag off. `sync_sessions_dir` (the background repair thread)
  backfills it from the `messages` rows without re-reading Session files;
  `session_index_reindex_state` reports pending until then. Until the flag is
  on, and for queries no bigram can carry (a single CJK character), CJK queries
  use the old LIKE path, so nothing regresses mid-migration.
- Invariant: every write to `messages` writes or deletes the matching
  `messages_bigram_fts` row in the same transaction (`replace_index_row`,
  `delete_fts_rows`, `prune_missing_sessions`).

## L1: lessons (`crates/runtime/src/lesson_memory.rs`)

Write path, at most one cheap model call per few qualifying turns:

1. At turn end the desktop engine calls `MemoryState::enqueue_lesson_turn`.
   `lesson_turn_from_messages` keeps the turn only if a tool failed and a later
   call of the same tool with a different input succeeded (23% of turns).
2. The job is queued in `<config>/memory/builtin/lessons.sqlite3`. A background
   writer sends a session's batch once 3 turns wait or the oldest waited 15
   minutes (about one call per 13 turns), through `run_memory_oneshot` (the
   `memory_v2_model` / reviewer route).
3. `parse_lesson_reply` accepts only `[lesson]` lines that cite a turn of the
   batch and a failed call of it that was really recovered, was not a flake
   (identical retry) and was not a fetch tool's network failure.
4. `insert_lessons` merges a lesson whose cause key (tool + decisive error line
   with paths and numbers normalised) is already stored for the project: the
   count goes up instead of adding a near-duplicate.

Read path, zero model calls: when a tool fails (`finish_tool_execution_output`),
`recall_for_failure` searches lessons from every project with the tool, input
digest and decisive error lines (bigram + trigram FTS, RRF). It returns at most
3 lessons that share at least 2 distinctive words (in at most 20% of lessons)
with the error, and nothing for a bare exit code or a fetch tool's network
failure. The block is appended to the failed tool result (`pastLessons`), never
to the system prompt, so the cached prefix is untouched. Each delivery is logged
as a `lesson_recall` session event.

Switch: `memory_lessons_enabled` in config (default on) gates writing and
recall. A lesson store that does not exist yet is never created by recall or by
the startup writer.

## Replay of the implementation on real data

`crates/runtime/examples/memory_replay.rs`, inputs from
`experiments/memory/scripts/prep_replay.py` (copies of the local session
directories with their existing, pre-upgrade indexes; release build):

| | Before | After |
|---|---|---|
| L0, top 2 sessions as injected, all history: dev / test | 34% / 31% | 45% / 46% |
| L0, same, only history before the question: dev / test | 49% / 36% | 51% / 42% |
| L0 mean query time | ~440 ms | 39-81 ms |
| L0 backfill of 17 old indexes | - | 8.2 s total |
| L1 right lesson recalled (v7 notes as the store): dev / test | - | 67% / 65% |
| L1 negatives that got a lesson attached | - | 23% (8/35) |

The time-locked L0 gain is smaller than the offline harness predicted: the
product's time filter keys on message timestamps (falling back to the Session
file's mtime), so older sessions continued later drop out of both runs.

Tests: `cargo test --workspace` 1,699 passed; desktop `tool_output` (24) and
`memory` (16) passed with `ARIS_CONFIG_ROOT` pointed at a scratch directory.

## In-app check (2026-11-22, debug build, isolated config, fresh account)

Three turns that each hit a planted trap (GBK CSV, `python src/x.py` import
error, trailing comma in JSON), then a new session that hit the GBK trap with a
different file.

- All three turns qualified and were queued. The first writer run failed every
  job with "reviewer is disabled": the account had no Reviewer configured, and
  the writer only used the Reviewer route. Fixed: `run_lesson_oneshot` uses the
  Reviewer route when one is configured, else the executor's connection at the
  cheap tier the compaction summarizer would pick
  (`literature::run_background_oneshot`, which leaves the global interrupt flag
  alone).
- After the fix one call (MiniMax-M3.1-Flash) wrote 3 lessons, 0 rejected. The
  import lesson was precise; the GBK and JSON ones were wordier than ideal (the
  GBK one copied the byte-inspection detour instead of saying "read it as GBK";
  the JSON one did not name the trailing comma).
- Recall: the new session's first failure carried the GBK lesson first in
  `pastLessons`; the model's next thought cited it and read the file as GBK on
  the next call (the original turn needed three extra calls). A second,
  unrelated lesson was attached too: with 3 lessons the 20% document-frequency
  rule admits any word found in one lesson, so the floor is weak on tiny stores.
- `lesson_recall` rows were erased by the checkpoint compaction of the event
  log. Fixed: the kind is durable (`DURABLE_EVENT_KINDS` in `session.rs`).
  `memory_recall` rows are still erased, so per-turn recall cannot be counted
  from session logs yet.
- Also fixed: editing a file and rerunning the identical command now counts as
  a recovery (it was treated as a flake), and every turn end wakes the writer so
  a batch that became due by waiting is not stranded until a restart.

## Not in this change

- The per-turn system-prompt recall block still exists (it now ranks with the
  bigram path). Removing it should be an A/B switch measured on answer quality
  and cached tokens first.
- L2/L3 promotion (project card, user rules) is designed but untested.
- Lessons have no UI yet.
