# Memory Refactor Plan

Grounded in a review of [TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)
(v2.0.1), whose L0–L3 layering our R0–R3 names were taken from.

## What the reference design actually does

An earlier reading of `desktop/src-tauri/src/tencentdb_memory.rs` (212 lines) concluded
that the reference design writes memory without an LLM. That was wrong: that file is
only the optional cloud vector projection for one layer. In the real project,
`POST /v3/conversation/add` writes L0 and then **asynchronously triggers the L1
extraction pipeline**, and MemoryCore requires LLM credentials for "memory extraction
and aggregation". Its write path is an async LLM pipeline, the same shape as ours.

The differences that matter are elsewhere.

### 1. Only small, stable layers are injected

| Layer | Reference design | SomniQ today |
|---|---|---|
| L0 conversation | written back each turn, **not injected** | injected as excerpts (remaining budget, up to ~4.5k chars) **and** already reachable via the `session_search` tool |
| L1 atoms | **read-only tools**, model queries on demand | injected, 700-char quota |
| L2 scenario | injected | injected, 500-char quota |
| L3 persona | injected | injected, 300-char quota |

Their stated reason for toolizing L0/L1 is "avoiding upstream KV-cache invalidation".

`memory.rs:37` caps our injection at `RESEARCH_RECALL_TOTAL_CHARS = 6_000`, recomputed
per query, appended as the last system section (`engine.rs:7807`). Placing it last
preserves the cache for the *instructions above it* — but the entire message history
sits after that varying block, so the cache breaks for the largest part of the prompt
on every turn. This is the dominant, recurring token cost, larger than extraction.

### 2. L2/L3 are documents, not rows

- **L2 is a navigable file tree**: `/v3/scenario/ls` (path prefix, directories end in
  `/`), `read` (by path, traversal-checked, versioned), `write`, `rm`. Each entry is
  `{path, summary, version}`.
- **L3 is a single `persona.md`**, and writes "strip the Scene Navigation section" —
  meaning the persona document carries an index into the L2 tree.

So the injected payload is a small profile plus a map; the agent then *navigates* to
the one scenario file it needs. Progressive disclosure. Skills work the same way:
`/v3/skill/listing` injects an `<available_skills>` summary, full text is fetched by
name on demand.

Ours are SQLite rows squeezed into a character quota — truncation is the only lever.

### 3. Layers are derived from each other

L1 is extracted from L0; L2 and L3 are *aggregated* from accumulated L1. Ours assigns a
layer per candidate directly from one turn, which is why R2/R3 stay near-empty and
carry no more meaning than R1. Note that SomniQ v1 already had this cascade —
`research_memory.rs` still contains `episode_worthy_atom_ids`, `refresh_episode_card`,
`promotable_atom_ids`, `refresh_profile` — and v2 dropped it.

### 4. Extraction prompts are data

`/v3/memory-prompt/*` (7 endpoints) makes the L1/L2/L3 prompts creatable, versioned,
applied per team/agent, with a built-in fallback and an operations log.
`V2_EXTRACTION_SYSTEM` is a hardcoded Rust constant; every behaviour change is a
recompile.

### 5. BM25 is the default; embeddings are optional

MemoryCore "disables remote embeddings by default and uses BM25 retrieval". A missing
embedding provider is therefore **not** a blocker for good retrieval.

Ours is weaker than BM25: `recall_local` loads the 100 most recent rows and scores them
by counting how many query terms appear as substrings, sorted by raw count — no IDF, no
length normalisation. A term present in 90 atoms outranks nothing.

### 6. Smaller things worth copying

- L1 has a **type**: `episodic` / `persona` / `instruction`. Ours takes any snake_case
  `kind`, which produced one-off kinds like `completion_state_tex_pdf`.
- `/v3/memory-generation-log/*` lists generation runs by layer and status, and reverse-
  looks-up which run produced a given memory.
- `/v3/chat-memory/clear` clears content but keeps the asset (ownership, bindings, ACL).

---

## Plan

Ordered by leverage per unit of work. Each phase is independently shippable and leaves
the system working.

### Phase 1 — Retrieval that deserves to be trusted

**Why first:** Phase 2 hands retrieval to the model. If a `memory_search` call returns
what `recall_local` returns today, the model will learn to ignore it and memory becomes
dead weight. Retrieval quality is a prerequisite, not a follow-up.

- Add an FTS5 table over `memory_v2_atoms` (`statement`, `kind`, `source_quote`),
  maintained by the same transactions that write atoms.
- Rank with SQLite's built-in `bm25()`. Keep the existing term-overlap path as the CJK
  fallback — the bundled FTS5 tokenizer does not segment CJK reliably, a constraint
  `session_index.rs` already documents and works around.
- Fuse the two rankings with RRF rather than picking one, so a CJK query and an ASCII
  query use the same code path.
- Leave a seam for vectors (score fusion, not a second retriever) but do not build it:
  the configured gateway currently exposes no embedding model.

**Verify:** replay real queries against the live atom set, compare top-5 against the
current scorer, and assert that a term appearing in most atoms no longer dominates.

### Phase 2 — Stop injecting the volatile layers

**The token win.** After Phase 1 this is mostly deletion.

- Add a `memory_search` tool (mirroring the existing `session_search` spec) that queries
  R1 and R2 with the Phase 1 retriever and returns bounded, labelled results.
- Remove R1 and R0 from the injected block. R0 is already reachable through
  `session_search`; injecting excerpts as well pays for it twice.
- Keep R3 injected — it is small, stable, user-confirmed, and standing rules must apply
  without the model having to ask for them.
- Keep the untrusted-data framing on tool results, exactly as the injected block has it.

**Expected effect:** the per-turn injected block drops from up to 6,000 chars to a few
hundred, and stops varying with the query — which is what actually restores the cache
for the message history.

**Risk:** a model that never calls the tool silently loses access to R1/R2. Mitigate by
logging tool-call rates per turn for a week before removing the injection path, and keep
the injection behind a config flag so it can be restored without a release.

### Phase 3 — L2/L3 become documents

The structural change, and the reason the reference design can afford to inject L2/L3
at all: it injects an index, not content.

- R2 becomes a per-project file tree under the project's memory directory, with
  `ls` / `read` / `write` / `rm` semantics, per-file `summary` and version. Expose
  `read` as a tool; expose `ls` output (paths + summaries only) in the injected block.
- R3 becomes a single `persona.md` per project, carrying a generated navigation index
  into the R2 tree. This is the injected payload.
- Restore the L1 → L2 → L3 cascade: R2 files are aggregated from accumulated R1 atoms,
  R3 from stable patterns across R2. v1's `refresh_episode_card` / `refresh_profile` are
  the prior art to port, not to reinvent.

**Sequencing note:** this changes what the Settings library browses. The three layer
cards stay, but R2/R3 drill-down becomes a document view. Do this only after Phase 2 has
proven the tool path works.

### Phase 4 — Operability

- Move `V2_EXTRACTION_SYSTEM` / `V2_PROMOTION_SYSTEM` into stored, versioned prompts
  with a built-in fallback and a Settings editor, so tuning extraction is not a
  recompile.
- Surface the existing `memory_v2_audit` rows as a generation log in Settings: filter by
  layer and outcome, and reverse-look-up which run produced a given atom.
- Constrain L1 `kind` to a small typed set (`episodic` / `persona` / `instruction`, or a
  research-domain equivalent) instead of free-form snake_case.

---

## Deliberately not in scope

- **Team / ACL / multi-agent asset model.** The reference design is a team memory hub;
  SomniQ is single-user local-first. Ownership, visibility and agent loadout solve a
  problem we do not have.
- **A separate memory service and proxy.** Their process split exists to serve many
  agent frameworks over HTTP. We have one app and a shared runtime crate.
- **Embeddings.** Not blocked on design — blocked on a provider. Revisit when the
  gateway exposes an embedding model; Phase 1 leaves the fusion seam for it.

## Measurement

The claim being tested is "memory costs too many tokens". Before Phase 2, record per
turn: injected block size, whether it changed from the previous turn, and cached vs.
uncached input tokens. Without that baseline, Phase 2's benefit is an assertion.
