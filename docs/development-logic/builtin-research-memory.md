# Builtin research memory

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
  negative results, environment facts, methodological lessons, and artifact
  pointers. Each row stores Session/event provenance, artifact paths,
  confidence, validity, status, and an optional superseded atom.
- **R2 — research episodes.** Active, non-conflicting R1 atoms from the same
  Session are consolidated into one episode card. Cards never invent facts and
  list the exact R1 IDs from which they were derived.
- **R3 — project research constitution.** A bounded projection of stable
  preferences, decisions, constraints, and lessons. It excludes live goals,
  workflow state, evidence claims, and Reviewer-private memory.

## Capture and recall

Capture runs only after the independent review/revision loop has produced the
final assistant response and the authoritative Session save succeeds.
Ephemeral chats, Reviewer turns, and autonomous Workflow controller turns are
already excluded at that call site. The write path inserts an idempotent outbox
row and returns; a background worker performs deterministic local extraction,
deduplication, update/conflict handling, and R2/R3 refresh.
The worker drains every currently due row rather than stopping after a fixed
number of batches. Failed rows persist `next_attempt_at` with exponential
backoff, resume automatically on application startup, and move to dead-letter
after ten attempts. Settings exposes those dead-letter errors and live
migration progress.
R2 maintenance is incremental: only episode cards for Sessions touched by a new,
superseded, edited, or deleted atom are rebuilt. Existing cards for unrelated
Sessions are not scanned or replaced.

For builtin mode, each ordinary Executor turn retrieves:

- up to five relevant R1 atoms;
- up to two relevant R2 episode cards;
- the bounded R3 project constitution;
- up to two R0 Session hits with their existing ±5 windows.

R1/R2 recall is lexically gated. Query terms are reduced to content words, and
a candidate must share at least two of them (one for a very short query) with
its own text. There is no list fallback on the recall path: a query with no
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

Workflow-owned `wf-*` Sessions are filtered from automatic R0 injection. They
remain authoritative and inspectable through their Workflow/Session surfaces,
but cannot become general Executor memory.

The Settings migration action can explicitly backfill ordinary historical
Sessions into R1–R3. The ledger keys each source by path, content hash, and
`builtin-research:<project-id>` scope, so repeated runs are idempotent and
appended turns can be imported later. Workflow Sessions are excluded from both
the preview and the backfill.

The result is the last dynamic system section and is explicitly marked as
untrusted history. The combined section is capped at 6,000 characters. Manual
hot memory remains in the stable system prompt and has higher priority.
Successful TencentDB mode continues to use the external layered recall;
startup, timeout, or partial failure falls back to this builtin path.

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

## Knowledge updates and governance

Atoms with a recognized subject key can supersede an older active atom when
the new statement is an explicit update or a stable decision/preference. A
same-subject result without a safe update signal is marked as a conflict
instead of silently overwriting either source. Exact statements merge source
lineage rather than creating duplicates.

The Intelligent Memory page is available in builtin mode and displays all four
layers, labelled R0-R3 in builtin mode and L0-L3 when the TencentDB sidecar
owns recall.

The page also carries a recall preview. `memory_recall_preview` assembles the
section for a typed question without sending a turn and returns the same
`RecallReport` the production renderer fills in: the per-layer quota and spend,
every admitted entry, and every dropped candidate with its reason
(`duplicate`, `budget`, or `not_standing`). Because a layer's cost is now the
thing that decides whether it earns its place, the budget split is shown as a
stacked meter rather than described in prose. The preview always renders the
builtin R0-R3 path, which is what the model receives in builtin mode; in
TencentDB mode it shows the fallback assembly and says so. R1 entries expose status, confidence, source Session/event IDs,
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

The first extractor is deterministic (`builtin_rules_v1`). This keeps memory
local, auditable, and available with no model configuration. Its precision is
the weakest part of the pipeline: it classifies on keyword presence, so a
sentence containing "must" becomes a constraint and one containing "result"
becomes an experiment result. Measured source precision is 29.0% for R1 and
26.8% for R2. The recall gate limits the damage at injection time rather than
fixing extraction. Optional LLM candidate extraction can be added behind the
existing memory-model setting, but must write through the same
typed/provenance validation path and must never become a chat dependency.

R3 injection is standing-rules-only. `refresh_profile` still projects
decisions and lessons into the stored constitution for inspection, but only
`user_preference` and `constraint` lines earn an unconditional prompt slot;
the rest reach the prompt through R1 when the query calls for them. Promoting
R3 into the stable system prefix, where it would not compete with evidence for
the recall budget, is the next structural improvement and is not done here. Existing optional Session embeddings and hybrid RRF
also remain opt-in; the keyword path is the default.

R2 currently uses Session-bounded research episodes rather than attempting to
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
