# Builtin research memory

## v2 cutover (2026-09-04)

The v1 projection described below is now a **legacy archive**. It is retained
for inspection and export, but it is not a source for prompt assembly and it is
not rebuilt, replayed, edited, or deleted by the active desktop controls. The
authoritative source remains the local Session JSONL. A separate v2 SQLite
store starts empty at `memory/builtin/research-memory-v2.sqlite3`.

The old v1 outbox is frozen with that archive; it is not silently copied into
v2 and it is not treated as proof that a v2 review occurred. If historical raw
captures are ever reconsidered, the operation must be an explicit, auditable
rescreen that copies only source text plus provenance into the v2 outbox. It
must never copy v1 atoms, cards, or profiles, and each copied capture still
passes pre-screening, LLM extraction, and independent promotion from scratch.

### Runtime contract

1. **Capture** — a completed normal chat turn is written to the v2 outbox with
   its project, Session, event IDs, final message index, and exact user/assistant
   text. The write is idempotent by `(project, session, final message index)`.
2. **Pre-screen** — a local conservative filter rejects editorial/process text
   (such as “保留图注”“下一段”) before any model or network call. A rejection
   is audited as `prefilter_rejected` and is never injected.
3. **LLM extraction** — the configured independent Reviewer must return strict
   JSON. Every candidate must name `user` or `assistant`, an exact source quote,
   a statement grounded in that quote, a bounded scope, and a layer. Invalid
   JSON, invented summaries, invalid kinds, and missing R1 TTLs fail closed.
4. **Independent promotion** — a second Reviewer decision is persisted before
   an atom can be active. R1 is temporary task state; R2 is a durable research
   fact; R3 is restricted to a user-authored `user_preference` or `constraint`.
5. **Visibility gate** — R3 remains `pending_user_confirmation` until the user
   confirms it in Settings. If TencentDB is configured, R2 remains
   `remote_pending` until its semantic projection succeeds. Model, database,
   and embedding failures defer the outbox item with backoff; they do not inject
   a partial result.

### Four-layer recall

- **R0** is the bounded, authoritative Session search window and is always the
  safe fallback.
- **R1** is recalled only for the current Session and only while its finite TTL
  is valid.
- **R2** is on-demand. With TencentDB it uses vector + PostgreSQL lexical
  fusion (weighted score re-ranking); without TencentDB it uses the local v2
  lexical fallback. Remote results are IDs only and are resolved back through
  local provenance before rendering.
- **R3** is standing context only after explicit user confirmation and only for
  preferences or hard constraints. No v1 profile can enter this path.

The rollout setting is `legacy_r0_only` (safe default), `observe`, `canary`, or
`active`. `legacy_r0_only` prevents new writes and exposes R0 only, so rollback
is a configuration change rather than a data migration. Settings labels and
the v1 metadata/`research_memory_legacy_marks` table make the cutover explicit
without rewriting the original v1 semantic status or Session files.

### Optional TencentDB PostgreSQL backend

The adapter is opt-in through `SOMNIQ_TENCENTDB_MEMORY_URL` (tenant and
embedding model are separate environment values). It stores only screened R2
atoms, never R0 transcripts or R3 rules. The schema uses `vector(1024)`, HNSW
and GIN indexes, and tenant/project Row Level Security with `FORCE ROW LEVEL
SECURITY`. A cloud error leaves the local atom `remote_pending`; prompt
assembly keeps R0/R1 and omits R2 until acknowledgement. Local SQLite audit
records remain the audit authority, so the cloud is replaceable and optional.

### Operational acceptance checks

- `cargo test -p runtime research_memory --lib` keeps the v1 regression suite
  green; `research_memory_v2` tests cover editorial rejection, exact grounding,
  R1 session isolation, R3 confirmation, and remote-ack gating.
- `cargo check --manifest-path desktop/src-tauri/Cargo.toml` verifies the
  desktop/runtime integration; `npm run build` verifies the Settings controls.
- Search for `builtin_research_recall_prompt`: its production renderer accepts
  only v2 atoms plus R0 Session hits, and no production call invokes the v1
  `ResearchMemoryStore::recall` path.

## Legacy v1 reference (read-only)

The sections below document the former v1 schema and extraction behavior for
audit and export only. They are not an implementation contract after the
2026-09-04 cutover: v1 R1/R2/R3 rows are marked `legacy`, are not rebuilt or
edited by the active controls, and can never enter prompt assembly. New work
must follow the v2 contract above.

## Purpose and authority

SomniQ's builtin memory is a derived continuity layer for research work. It is
not a second source of truth. Complete Session event JSONL, Project Goal,
Workflow Ledger, Reviewer state, literature evidence, and experiment artifacts
remain authoritative and independently recoverable.

The derived store lives at
`<SomniQ config>/memory/builtin/research-memory.sqlite3`. It uses SQLite WAL,
FTS5, project-scoped keys, an idempotent outbox, and soft deletion for derived
atoms. It does not require Node, a sidecar, an embedding model, or network
access.

## Layers

- **R0 — authoritative Session projection.** Existing incremental Session
  SQLite/FTS rows and the bounded ±5 source window. The governance UI cannot
  delete R0; users edit or delete the authoritative chat through the Session
  surface.
- **R1 — research atoms.** Reviewed final turns produce typed candidates for
  researcher preferences, decisions, constraints, experiment results,
  negative results, environment facts, methodological lessons, explicit
  research findings, and artifact pointers. Each row stores Session/event provenance, artifact paths,
  confidence, validity, status, and an optional superseded atom.
- **R2 — research episodes.** Active, non-conflicting R1 atoms from the same
  Session are consolidated into one episode card. Cards never invent facts and
  list the exact R1 IDs from which they were derived.
- **R3 — project research constitution.** A bounded projection of stable
  preferences, decisions, constraints, and lessons. It excludes live goals,
  workflow state, evidence claims, and Reviewer-private memory.

## Capture and recall

Capture runs only after the independent review/revision loop has produced the
final assistant response and the authoritative Session save succeeds. It cites
the exact zero-based persisted assistant-message index and extracts only that
message; tool-loop drafts and earlier model iterations remain visible in the
Session but never enter the capture payload.
Ephemeral chats, Reviewer turns, autonomous Workflow controller turns, and
headless diagnostic/benchmark runs are excluded at that call site. The write path inserts an idempotent outbox
row and returns; a background worker performs deterministic local extraction,
deduplication, update/conflict handling, and R2/R3 refresh.
The worker drains every currently due row rather than stopping after a fixed
number of batches. Failed rows persist `next_attempt_at` with exponential
backoff, resume automatically on application startup, and move to dead-letter
after ten attempts. Settings exposes those dead-letter errors and live
migration progress.

On startup, and whenever the Intelligent Memory page asks for status, the app
reconciles every registered project's authoritative Session files against the
outbox. A capture obligation is the stable tuple
`(project_id, session_id, final_assistant_message_index)`, not a generated
capture ID. Missing final replies are enqueued and drained idempotently; an old
manual-backfill row with the same persisted user/final text is bound to that
tuple instead of copied. The status bar reports expected, covered, and missing
final replies plus the latest captured Session. Pending and dead-letter rows
count as covered delivery state while remaining visibly actionable; only an
absent outbox row is a capture gap.
R2 maintenance is incremental: only episode cards for Sessions touched by a new,
superseded, edited, or deleted atom are rebuilt. Existing cards for unrelated
Sessions are not scanned or replaced.

For builtin mode, each ordinary Executor turn retrieves:

- up to five relevant R1 atoms;
- up to two relevant R2 episode cards;
- the bounded R3 project constitution;
- up to two R0 Session hits with their existing ±5 windows.

R1/R2 recall is lexically gated. Query terms are reduced to content words and
CJK bigrams, with a small set of explicit aliases for common research concepts
such as compilation failure, chapter-wise builds, and novelty. Each R1 row also
indexes its source user question as hidden recall context, while the displayed
statement stays clean. This lets an answer be found without forcing it to
repeat the question verbatim. There is no list fallback on the recall path: a query with no
anchor returns no atoms and no cards. The inspection UI keeps its always-show
listing, because an empty governance surface and an empty prompt section have
opposite costs.

Normal recall also enforces each atom's validity interval. Future and expired
rows stay auditable but do not enter the prompt. An explicit `YYYY-MM-DD`,
`YYYY/MM/DD`, or Chinese date in the question selects the version valid at the
end of that day using source occurrence time (`valid_from`), not database
maintenance time (`updated_at`). Superseded versions can therefore answer
historical questions, while unresolved conflicts remain governance-only. R2
is materialized from validity-checked R1 IDs so expired/conflicting text cannot
leak back through an older card.

Workflow-owned `wf-*` and diagnostic `somni-*` Sessions are filtered from automatic R0 injection. They
remain authoritative and inspectable through their Workflow/Session surfaces,
but cannot become general Executor memory.

R1 is frozen at extraction time, so an extractor change otherwise reaches only
new conversations. The Settings re-derive action replays every completed capture
through the current rules. It is store-wide rather than scoped to the active
project: a version bump invalidates every project at once, and a per-project
button leaves projects the user has not opened lately on the old rules, which is
how one store came to hold three rule generations at once and stopped having a
comparable `kind` across rows. User corrections, confirmations, and deletions
survive a replay; captures on excluded `wf-*`/`somni-*` Sessions are dropped
rather than replayed, so a first migration also removes them.

The Settings migration action can explicitly backfill ordinary historical
Sessions into R1–R3. The ledger keys each source by path, content hash, and
`builtin-research:<project-id>` scope, so repeated runs are idempotent and
appended turns can be imported later. Workflow Sessions are excluded from both
the preview and the backfill.

The result is the last dynamic system section and is explicitly marked as
untrusted history. The combined section is capped at 6,000 characters. Manual
hot memory remains in the stable system prompt and has higher priority.

Two rules govern how that budget is divided.

**The derived layers cannot borrow from R0.** R3, R1, and R2 each have a fixed
quota (300, 700, and 500 characters); whatever they do not spend is left to the
Session windows. R0 is always budget-bound — its unbudgeted windows average
about 48,000 characters — so any character a derived layer takes is evidence
removed from the prompt. Items are admitted whole: a row that does not fit is
skipped rather than cut mid-sentence.

**No layer may restate text already in the prompt.** R1 statements are verbatim
sentences lifted from R0 turns and R2 summaries are lists of R1 statements, so
without this rule the section pays repeatedly for one fact. Candidate lines are
compared against the already-committed text, R3 first, then R1, then R2. Because
R0 owns the remaining rather than a fixed budget, assembly iterates to a stable
admission set and only R0 messages that actually fit participate in derived-layer
deduplication. A card whose lines are all duplicates is dropped entirely rather
than rendered as a pointer to nothing.

Inside R0, messages are admitted anchor first, then whole turns, then truncated
ones, and only then in window order. Anchors keep 700 characters and neighbours
300. The matched turn is what the window exists to deliver, and a complete
short turn is worth more than a longer neighbour cut mid-sentence.

## Project subjects

Each atom carries a derived `subject_key`: the entity the project keeps
returning to that the atom is about. A term becomes a project subject once a
*second* Session mentions it; terms and their atoms live in
`research_memory_atom_terms`, and the key is a projection re-run whenever atoms
change, because the atom that first names a term cannot be keyed at write time —
the evidence for its own key does not exist yet.

Candidates are only concrete, stable objects: normalized file paths, LaTeX
`\ref`/`\label` keys, and explicit identifiers (including structured code spans
such as `eq:admissible-set` or `run_042`). Quoted natural language and free CJK
phrases do not become subjects. Three rejections were established by measuring
against a real 474-atom store rather than by inspection:

- **Free CJK n-grams are excluded.** At every threshold that covered a useful
  share of atoms, the top "subjects" were function words (`保留`, `必须`, `不能`)
  and fragments of the workspace path. Chinese-heavy projects therefore key at a
  lower rate — 40% on the thesis project against 78% on a mixed one — and a real
  CJK term extractor is the next lever.
- **Sentence-initial capitals are grammar, not naming.** Admitting them made
  `However`, `Initial`, `Introduction` and `August` a project's top subjects.
  A capital opening a sentence needs a second signal: an internal capital, a
  digit, or a separator.
- **Opaque tokens are excluded** — hashes, ids and timestamps read as
  identifiers but name nothing a later turn can refer back to.

This exists because the store previously had no identity coarser than a whole
sentence. Measured on that same store, `normalized_key` produced 474 distinct
keys for 474 atoms and matched `SUPERSEDABLE_SUBJECTS` zero times: every atom was
an island, so nothing could supersede, conflict with, or count as a repeat of
anything else. The current rules key 63% of atoms across 136 subjects.

`subject_key` participates in two conservative paths. A query naming a
registered file, LaTeX key, or identifier receives matching R1 atoms even when
their prose has little lexical overlap. An explicit later revision to a
decision, constraint, or preference may supersede the active atom with the same
stable subject and kind. This never applies to an unqualified Chinese phrase,
and a same-subject result without an explicit update remains a conflict rather
than being silently overwritten.

## Current facts

Some observations are scalar state rather than independent claims. The
extractor assigns them stable current identities:

- `current:artifact:<normalized-path>:page_count` for a materialized PDF's
  page count;
- `current:build:project:compile_status` for the project's latest compilation
  outcome.

A strictly newer observation with the same identity supersedes the old R1 atom,
sets its validity end, and retains its source and supersession relation for
audit. Thus `Final/main.pdf` at 153 pages replaces the prior 143-page fact in
normal recall, while an historical date query can still recover 143; a successful
compile similarly retires a resolved compiler failure. Schema upgrade applies
the same lifecycle to recognizable legacy rows and immediately reduces any old
duplicate current identity to one active observation.

## Knowledge updates and governance

Atoms with a recognized subject key can supersede an older active atom when
the new statement is an explicit update or a stable decision/preference. A
same-subject result without a safe update signal is marked as a conflict
instead of silently overwriting either source. Exact statements merge source
lineage rather than creating duplicates.

The Intelligent Memory page displays all four layers, R0-R3. R1 cards expose
current/history/conflict state, the stable subject key, and whether the atom is
eligible for standing R3 injection. R2 cards and every R3 line show their exact
R1 atom, source Session, and event IDs. R3 explicitly distinguishes stored
lines that are recalled on demand from standing lines actually injected into
every prompt.

The page also carries a recall preview. `memory_recall_preview` assembles the
section for a typed question without sending a turn and returns the same
`RecallReport` the production renderer fills in: the per-layer quota and spend,
every admitted entry, and every dropped candidate with its reason
(`duplicate`, `budget`, or `not_standing`). Because a layer's cost is now the
thing that decides whether it earns its place, the budget split is shown as a
stacked meter rather than described in prose. The preview renders exactly what the model
receives on a real turn. R1 entries expose status, confidence, source Session/event IDs,
artifact paths, and supersession. Editing an R1 atom marks it
`user_confirmed` with maximum confidence; deleting it soft-deletes only the
derived row and refreshes R2/R3. R2/R3 are read-only projections. Export emits
the complete derived snapshot and an authority notice.

## Layered recall gate

`npm run analyze:longmemeval-research-layers -- <dataset> <raw-results> <stem>`
scores the rendered prompt against LongMemEval cleaned-S, using the same 60
question IDs and selection as the paired comparison gate (56 retrieval questions, 4
abstentions excluded). `crates/runtime/examples/longmemeval_research_layers.rs`
produces the raw retrieval; the analyzer mirrors the production renderer and is
the decision metric, so the two must be changed together.

The 2026-08-10 rerun compares the layered prompt against an R0-only prompt of
the same budget, before and after the recall gate and the quota split:

| Metric | Before: R0-only | Before: layered | After: R0-only | After: layered |
|---|---:|---:|---:|---:|
| Any evidence provenance | 85.7% | 85.7% | 87.5% | 89.3% |
| All evidence provenance | 69.6% | 57.1% | 69.6% | 73.2% |
| Evidence-turn text available | 83.9% | 41.1% | 85.7% | 85.7% |
| Answer string available (n=42) | n/a | n/a | 45.2% | 45.2% |

Layer spend per prompt fell from R3=1782, R1=1071, R2=1368, R0=773 characters to
R3=195, R1=136, R2=186, R0=4269. Mean recalled rows fell from 5.0 atoms and 2.0
cards to 1.7 and 1.1, and R1-R3 query p95 fell from 50 ms to 29 ms. Paired
outcomes went from 24 evidence-turn regressions with 0 rescues (exact McNemar
p=0.0010 against R0-only) to **0 regressions on every metric**, with one
provenance rescue the Session index alone did not reach.

The layered prompt is therefore no longer harmful and is weakly additive on
provenance. It is not yet demonstrably additive on answer content: the derived
layers carried the answer string in 7.1% of questions and never as the only
source. LongMemEval contains no research work, so `builtin_rules_v1` classifies
ordinary chat sentences as constraints and experiment results; this gate proves
no-harm under a realistic budget, not benefit. Claiming benefit requires an
in-domain set built from real research Sessions.

## Deliberate limitations

The extractor remains deterministic (`builtin_rules_v5`, exported as
`RESEARCH_MEMORY_EXTRACTOR_VERSION` so no surface hardcodes a version that has
moved on). This keeps memory
local, auditable, and available with no model configuration. Version 5 rejects
headings, tables, raw JSON, user requests/questions, assistant process narration,
conditional proposals, bare result labels, and acknowledgement-only text. ASCII
classification uses token boundaries, artifact paths are parsed from Markdown,
code spans, and plain paths without accepting HTTP URLs, and one sentence owns
one primary kind. R2 accepts at most six eligible atoms, is capped at 1,200
characters, and does not promote assistant-authored plans or decisions.

A replay smoke test on a copy of the active real project database reduced 76
machine-derived atoms to 60, removed all seven exact duplicate-statement groups,
reduced the longest card from 4,223 to 706 characters, and reduced 13 suspicious
truncated/URL artifact paths to zero. It also recovered the exact Ch5 compilation
error and the chapter's regime-gating novelty statement for representative
queries. This is not a replacement for a labelled precision/recall benchmark;
the older 29.0% R1 and 26.8% R2 measurements describe `builtin_rules_v1` and
must not be presented as version-3 quality. Optional LLM candidate extraction
can still be added behind the existing memory-model setting, but must write
through the same typed/provenance validation path and must never become a chat
dependency.

R3 injection is standing-rules-only. `refresh_profile` still projects
decisions and lessons into the stored constitution for inspection, but only
`user_preference` and `constraint` lines earn an unconditional prompt slot;
the rest reach the prompt through R1 when the query calls for them. Promoting
R3 into the stable system prefix, where it would not compete with evidence for
the recall budget, is the next structural improvement and is not done here. Existing optional Session embeddings and hybrid RRF
also remain opt-in; the keyword path is the default.

R2 currently uses bounded, source-gated Session episodes rather than attempting to
infer an experiment run or paper identity without a structured event. A future
extractor may bind episodes to Workflow run IDs or experiment run IDs when
those IDs are present, without changing the authority model.

## Acceptance focus

- zero cross-project, Reviewer, Workflow-controller, or ephemeral leakage;
- 100% R1-to-Session/event lineage;
- no automatic overwrite of conflicting experiment results;
- recall remains local and bounded;
- capture does not add user-visible turn latency;
- Project Goal, evidence, and Workflow state are never mutated by memory.
