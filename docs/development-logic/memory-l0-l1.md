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

## Step 1: measuring real use (2026-11-23)

What changed:

- `memory_recall` rows (one per turn) are durable like `lesson_recall`, and
  name what reached the prompt instead of only sizes: `delivered` lists each R0
  line's `session_id` + `message_index`, `query_digest` is the first 16 hex
  digits of SHA-256 over the trimmed question. No recalled text is logged.
  `lesson_recall` rows add `lessonIds`.
- `chat_delete` removes the Session's rows from the search index at once
  (`forget_indexed_session`). Before, a deleted chat stayed searchable, and
  could be injected into later turns, until the next project activation ran the
  background repair.
- Message times: a compaction or rewind re-appends the Session behind a
  `session_reset`, which re-stamped every surviving message with the rewrite
  time; rows without a time fell back to the Session file's mtime at query
  time. Now the k-th row with a given text keeps the earliest time the index
  gave it, and rows without a time inherit the previous live message's time or
  the Session start encoded in its id (`chat-<13-digit ms>-…`).

How to read it: `experiments/memory/scripts/usage_report.py` (aggregates only,
read-only). "Used" = the answer contains an 8-character fragment found in the
delivered history but not in the question or earlier in the session; it is a
floor (paraphrase is missed). Lesson adoption = the next call of the same tool
in the turn succeeds, with vs without lessons attached.

Baseline from history before this change (`--all-sessions`, 995 sessions):
433 older `memory_recall` rows survived compaction; a block was sent on 98.6%
of those turns, 5,347 characters on average; recall latency p50 414 ms, p95
4.1 s (the old LIKE path). After a failed tool call, the next call of the same
tool succeeded 65.7% of the time (n = 1,211).

## Step 2: stop the expensive part, compare placements (2026-11-23)

- v2 background screening is **off by default**
  (`memory_v2_background_screening`). Captures are still queued for a manual
  build and existing atoms stay readable. Reason: on local history the atoms
  answered 2-3% of both probe sets, at ~3,300 Reviewer input tokens per
  surviving atom.
- `memory_recall_placement` decides where the per-turn recall block goes:
  `system` (the old placement, last system section), `user` (appended to this
  turn's user message in the request only, via
  `ConversationRuntime::set_turn_context`; never persisted), `off`, or
  `alternate` (default while measuring: each Session gets `system` or `user`
  by an FNV-1a hash of its id). Each `memory_recall` row records its
  `placement`; `usage_report.py` reports, per arm, the "used" rate and the
  executor's cache-read share from `run-state/usage-log.jsonl`.
- Why `user` should cache better: a block that changes every turn at the end of
  the system prompt invalidates the cached prefix for the whole history on
  every turn; on the user side only the last turn's message changes.
- Decision rule after 1-2 weeks: if fewer than 5% of delivered blocks are used,
  deliver only above a reranker threshold; if `user` is not worse on use and
  better on cache, make it the default.

## Step 3: lesson quality and lifecycle (2026-11-23)

- The fix of a failure is now the identical rerun after any successful step
  (edit, install...), else the same-tool success whose input is closest to the
  failed one -- no longer the first different call, which in-app was a byte
  dump. The writer sees the steps between failure and fix ("then ..."), edit
  contents included (`new_string`/`content` in the input digest), and is told
  to name the concrete cause and change rather than the diagnosis.
- `ungrounded` rejection: a lesson must share a word with the error and one
  with the fixing call or a step before it.
- Small stores (< 20 active lessons) need one more shared word.
- Lifecycle (schema v2, migrated in place): each delivery counts (`recalled`);
  at turn end a delivered lesson whose failure was fixed resets its unhelpful
  streak, otherwise the streak grows, and two in a row make it `stale` (not
  recalled). `lesson_sources` records every chat that taught a lesson; deleting
  a chat deletes lessons no other chat taught, and its queued turns. Hourly
  cleanup: finished jobs after 7 days, dropped jobs after 30, stale lessons 90
  days after going stale; active lessons unused for 180 days, and any beyond
  2,000, are archived.
- Settings > Memory > "踩坑教训": the switch, every lesson with its counts and
  status, turn off / restore, two-step delete.

Replay on real data after the change: right lesson 67.3% dev / 65.4% test,
unchanged; unrelated failures with a lesson attached 22.9%, unchanged. A floor
of 3 shared words left the 8 wrong attachments in place and cost a dev hit;
the shared-word counts of right and wrong attachments overlap (wrong: 2-8,
mostly 6), so word overlap cannot reach the 15% target. Next lever: whether the
lesson's tool matches the failing tool, which the v7 replay notes cannot test
(they carry no tool); real lessons do.

L0 replay with the step-1 time fixes, indexes rebuilt from scratch, top 2
sessions, only history before the question: 50.7% dev / 45.8% test (36-37%
test before L0). Top 3 sessions would give 54.8% / 50.8%, but this replay does
not model the 6,000-character budget, so that is left for production data.

## Step 4: always-on memory (2026-11-23)

- MEMORY.md / USER.md limits are UTF-8 bytes and are now labelled so. Counting
  characters would triple the per-turn token cost of Chinese memory; bytes give
  English and Chinese about the same token budget.
- L3 promotion, offline (`experiments/memory/scripts/eval_promotion.py`): over
  ~21 weeks of local history (3,396 user sentences) only 19 carried a
  persistence marker ("以后/一律/不要再/记住/always/never..."), none was said
  again in another session 2+ days later (the designed gate never fired), and
  4 of the 19 were real lasting rules (21% precision; the bar was 80%). All 4
  were writing preferences and half said "记住" explicitly. Decision: no
  automatic L3 proposals; explicit "remember this" stays with the memory tool
  and its confirmation. L2 project cards were not built for the same reason:
  project facts are already found in the raw sessions.

## Step 5: what a lesson must share with the failure (2026-11-24)

The 8 wrong attachments of step 3 were read one by one. None was about the
tool: all 35 negatives are bash/PowerShell failures, so "same tool" filters
nothing (and a check on the programs a command ran cost 3-6 hits for at most
one negative; dropped). Five matched on path pieces (the project root
`G:/2-博士期间资料/0- 毕业材料`, `E:\texlive\2025\bin\windows`), two of them
not even errors (`where` output, a diff); three matched on stock wording
("cannot access", "no such file or directory"). A held-out sample of 200 real
failures from chats the benchmark never used added two more causes: the
desktop's "Recovery hint: ..." line appended to every failed result (77 of
200), and English function words ("the", "not", "too many"), which pass the
20% document-frequency rule because most lessons are written in Chinese.

Recall now (`LessonGates`, all on in the product):

- `key_error_lines` drops the "Recovery hint:" line.
- Shared words are counted on the error without its paths, without stock
  error wording (whole words only, so `FileNotFoundError` keeps its `error`)
  and without English function words. When that leaves fewer than the floor,
  every remaining specific word must be shared: `rg: command not found`
  becomes `rg`, which the ripgrep lesson shares and the coreutils one does not.
  Nothing left means nothing is attached. Keeping the last two path components
  instead lifted the floor back up and lost 8 dev hits.
- A lesson about another known kind of failure is skipped (`error_class`: 13
  kinds such as command_missing, path_missing, encoding, edit_mismatch; unknown
  on either side passes). Schema v3 stores the kind; older lessons get it from
  the error line in their cause key.

Replay (`examples/memory_replay.rs l1` on `l1_enriched.json`, whose notes carry
their source call, read back by `experiments/memory/scripts/enrich_l1_notes.py`;
`sample_failures.py` adds the held-out split; `MEMORY_REPLAY_GATES` picks the
rules):

| | before | after |
|---|---|---|
| right lesson, dev | 34/52 (65.4%) | 36/52 (69.2%) |
| right lesson, test | 35/52 (67.3%) | 35/52 (67.3%) |
| benchmark negatives with a lesson | 8/35 (22.9%) | 2/35 (5.7%) |
| held-out failures with a lesson | 104/200 (52%) | 73/200 (36.5%) |

"before" already includes the tool name in the indexed text (the old replay
notes had none: 67.3/65.4% there) and the Recovery-hint filter. Each rule alone
helps (stock wording alone: 4/35, 43%); together is best. The held-out split
is unlabelled: of the 30 attachments the rules removed, about 28 read as wrong
(lost: `head: command not found`, a Playwright port refusal); of 25 sampled
that remain, about 13 are right or related. So wrong attachments on random
failures fall from roughly 31% to 18% while right ones are mostly kept. The 35
negatives were read while designing the rules, so 5.7% is optimistic; the
held-out numbers are the honest ones. Recall time about 30 ms per failure.

### Larger held-out set, judged blind (2026-11-24)

`sample_failures.py ... all` takes every failed call in local history (all
projects and the no-project chats) except the 142 the benchmark labelled, one
per tool + error opening: 894 failures. With the replay's JSON export
(`MEMORY_REPLAY_JSON`), every (failure, lesson) pair either rule set attaches
was stratified and a sample judged by 8 independent subagents, blind to the
stratum, as applies / related / unrelated (`judge_report.py`):

| stratum | pairs | judged | applies |
|---|---|---|---|
| benchmark right lessons (control) | 159 | 60 | 97% |
| benchmark negatives' attachments (control) | 24 | 24 | 4% |
| attached by old rules only | 673 | 300 | 5% (3-8%) |
| attached by new rules only | 161 | 161 | 14% (9-20%) |
| attached by both | 766 | 250 | 40% (35-47%) |

The judges agree with the benchmark labels (97% / 96%). Weighted by stratum
size, on the 894 failures:

| | failures with a lesson | lessons attached | apply | do not |
|---|---|---|---|---|
| old rules | 533 | 1,439 | ~343 (24%) | ~1,096 |
| new rules (floor 2) | 380 | 927 | ~331 (36%) | ~596 |
| new rules, floor 3 | 265 | 650 | ~298 (46%) | ~352 |
| new rules, floor 4 | 212 | 502 | ~246 (49%) | ~256 |

So the new rules remove ~46% of the lessons that do not apply for ~3% of those
that do. Rank does not separate them (38/33/36% apply at ranks 1/2/3); the
number of shared specific words does: pairs sharing exactly 2 apply 10% of the
time, 4 or more about 50%. A floor of 3 removes another ~244 non-applying
lessons for ~33 applying ones and costs 7 of 104 benchmark hits (dev 36->32,
test 35->32). Decision (2026-11-24): the floor is 3 -- a wrong lesson is worse
than none, and wrong attachments also blur the unhelpful-streak signal that
retires lessons (`LESSON_RECALL_MIN_SHARED`; replays can still set it with
`MEMORY_REPLAY_MIN_SHARED`). Product replay: right lesson 32/52 dev, 32/52
test; benchmark negatives 1/35; held-out failures with a lesson 265/894; about
46% of attached lessons apply. Stores under 20 active lessons still need one
word more.

## Not in this change

- The per-turn recall block is still in every turn; `memory_recall_placement`
  (step 2) compares system and user placement per session. Whether to drop it
  waits for that data (`usage_report.py`).
- Proactive delivery of earlier sessions (a relevance gate before the recall
  block, then an end-to-end comparison) and any reranker model.
- L2/L3 promotion: replayed offline in step 4 and not built.
