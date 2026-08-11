# TencentDB Agent Memory integration

## Authority boundary

SomniQ Session event JSONL remains the complete, replayable source of truth. TencentDB Memory Core is a derived Executor-memory projection only. Project Goal, Intent, workflow ledgers, Reviewer memory, evidence, Reviewer turns, autonomous workflow turns, and ephemeral turns never enter the general memory scope.

The supported modes are:

- `builtin`: no sidecar; existing hot-memory and Session index behavior.
- `tencentdb`: TencentDB recall is injected only when every requested layer succeeds; any startup, timeout, partial layer failure, empty failed recall, or pipeline failure discards the partial external result and falls back to builtin memory for the whole turn.

The default mode is global, but each project may explicitly inherit it or override it with `builtin` or `tencentdb`. All command/tool routing must resolve the active project's effective mode; never treat the default as the selected project's mode.

Isolation is fixed to `team_id=somniq-local`, a stable local user UUID, and `agent_id=project:<project-id>:executor`. Global confirmed profile memory uses `agent_id=somniq:global-profile`. Never loosen these fields or reuse the Executor agent for Reviewer/workflow traffic.

## Pinned resource build

`desktop/scripts/build-tencentdb-memory-resource.cjs` downloads the official `v2.0.0` archive at commit `0aff21a2d9f2b8a0354aaa80a2e586aab4054562`, verifies the SHA-256 in `desktop/resources/tencentdb-memory/source.lock.json`, installs the tracked production lockfile with pinned Node `22.20.0`, and emits licenses, third-party notices, hashes, and a CycloneDX SBOM. It precompiles the official entrypoint and JavaScript dependencies into `dist/server.js`; runtime uses the audited `src/` tree only as source material, not through `tsx` on the normal path.

The standalone SQLite build omits upstream optional service backends and Opik. It also replaces TCVDB sparse-BM25, ClickHouse reporting, and Context Offload tokenization with explicit build-time shims that throw if those excluded features are invoked. SQLite keyword recall still uses FTS5 BM25 ranking plus the pinned Windows x64 Jieba binding. Do not remove a package or add a shim without rerunning the real L0/L1/L2/L3 E2E.

The generated `desktop/src-tauri/resources/memory/tencentdb/` tree is ignored by git. `npm run build:resources` regenerates it before a Tauri release build; installed clients never clone, install, or download runtime code. Release verification commands are:

- `npm run verify:tencentdb-memory-resource`: pin, hash, Node, notices, and SBOM integrity.
- `npm run benchmark:tencentdb-memory-startup`: five fresh-process starts; p95 must be at most 5 seconds.
- `npm run test:tencentdb-memory-e2e`: fake OpenAI-compatible model, five turns, L1/L2/L3, cross-project isolation, and restart persistence.
- `npm run test:tencentdb-memory-live`: an optional manual acceptance flow against a real OpenAI-compatible model. It requires `SOMNIQ_MEMORY_LIVE_BASE_URL`, `SOMNIQ_MEMORY_LIVE_API_KEY`, and `SOMNIQ_MEMORY_LIVE_MODEL`; these are not required by the desktop app or release CI.
- `npm run test:tencentdb-memory-nsis -- <installer>`: silent install, installed-resource start, uninstall, and user-data retention. Set `SOMNIQ_REQUIRE_AUTHENTICODE=1` in release CI.

Use `npm run clean:tencentdb-memory-resource` before ordinary Rust development to avoid making Tauri scan the generated `node_modules` tree.

## Runtime and failure behavior

The sidecar is loopback-only, Bearer-protected, strict-isolation enabled, and CORS disabled. Its random Gateway key is stored in the OS credential vault. The model key exists only in the child environment and must never be included in logs or exported status.

SomniQ writes a managed gateway config that disables the TCVDB sparse-vector BM25 encoder in SQLite mode. SQLite FTS5 remains the keyword/BM25 implementation. This avoids two redundant Jieba dictionary initializations and is part of the cold-start invariant.

Recall has a 1.5 second hard timeout. Memory capture happens only after Reviewer finalization and durable Session persistence, through the idempotent `memory-bridge.sqlite3` outbox. A retry first queries L0 by session, timestamp, and content to resolve timeout-unknown delivery. Ten failed attempts move an item to dead-letter.

Layer calls are still collected independently so diagnostics name the degraded
source (`l1`, `l2`, `l3`, or manual memory). That partial result is never sent
to the model: one degraded source makes the prompt path fall back to the
complete builtin R0-R3 assembly.

If L0 advances for ten turns or 30 minutes without L1 advancing, SomniQ restarts the sidecar once. A second stall disables TencentDB prompt injection for that app run while preserving L0 and Session data. Live logs rotate at 10 MB with five retained files.

Before a component-version change, the stopped data directory is copied to `memory/backups/`; only two backups are retained. If the upgraded process cannot start, SomniQ restores the just-created backup and quarantines the failed upgraded data.

## Desktop memory library

The Intelligent Memory settings page is also the supported Memory Core inspection surface; SomniQ does not embed the upstream Memory Panel. `memory_explorer_snapshot` loads the active project's latest L0 conversations, L1 atomic memories, L2 scenario index, and L3 core profile concurrently. A failure in one layer is reported as a partial error and must not hide healthy layers. The UI shows up to 50 recent L0/L1 entries, opens L2 files through the gateway, and displays L3 as read-only derived content.

L1 entries can be corrected or deleted and L0 entries can be deleted from this surface. L2/L3 remain read-only; confirmed manual memory still uses SomniQ's approval workflow. Switching projects clears the explorer state before querying the new project scope. TencentDB v2 does not expose complete L2/L3-to-L1/L0 lineage in these responses, so the UI must label missing provenance rather than invent it.

## Migration and rollout

Migration reads SomniQ sources and writes only through V3 APIs. It includes expired manual entries for audit but filters them from recall. The ledger key is `(source_path, target_scope)`, so reruns are idempotent and one project's migration never suppresses another's. Source hot-memory files, knowledge notes, Session JSON, and `session-index.sqlite3` are not deleted.

Roll out in this order: builtin default, selected-project TencentDB, TencentDB default for new projects after benchmark gates, then stop legacy projection writes only after two stable releases. Session event JSONL remains permanent.

## LongMemEval comparison gate

The reproducible benchmark entrypoint is `npm run benchmark:longmemeval`. It downloads and validates the official LongMemEval cleaned-S dataset, creates deterministic stratified selections, uses a separate Memory Core data directory, and never writes benchmark conversations into normal SomniQ projects. Live layered runs require `--allow-layered-cost`; retrieval-only runs do not call the configured LLM. `crates/runtime/examples/longmemeval_builtin_retrieval.rs` invokes the real `runtime::search_sessions` implementation and exports its Top-5 hits for paired comparison. `npm run analyze:longmemeval-paired -- <report.json>` emits the raw CSV, paired statistics, confidence intervals, and per-type report.

### Complete 500-question run

The benchmark runner supports both a no-token retrieval gate and the full answer/judge protocol:

```powershell
# Validate the full cleaned-S dataset and write the deterministic 500-question selection.
node scripts/benchmark-longmemeval-memory.cjs --full --selection-out .benchmark-results/longmemeval/full-selection.json

# Full L0 retrieval + answer generation + optional oracle/judge.
node scripts/benchmark-longmemeval-memory.cjs --full --live --profile l0 --output-dir .benchmark-results/longmemeval/full-l0

# Retrieval-only live run; no answer/judge model or API key is required.
node scripts/benchmark-longmemeval-memory.cjs --full --live --profile l0 --retrieval-only --output-dir .benchmark-results/longmemeval/full-l0-retrieval

# Layered Memory Core run; extraction uses the configured memory model and requires explicit cost acknowledgement.
node scripts/benchmark-longmemeval-memory.cjs --full --live --profile layered --allow-layered-cost --output-dir .benchmark-results/longmemeval/full-layered

# Resume an interrupted run after verifying the same dataset, profile, and evaluation switches.
node scripts/benchmark-longmemeval-memory.cjs --full --live --profile l0 --resume --output-dir .benchmark-results/longmemeval/full-l0
```

Each live run writes `report.json`, `report.md`, `selection.json`, `hypotheses.jsonl`, Memory Core stdout/stderr logs, and an isolated `memory-data/` directory. The report records the dataset SHA-256, Memory Core version/commit, model host/name (never the API key), retrieval metrics, answer metrics, benchmark answer/Judge request-token totals, per-question outcomes, and whether the run completed or degraded. Memory Core's own extraction requests are not exposed by the gateway usage payload and remain auditable in the sidecar logs. `--full` selects all 500 cleaned-S records; without it, the default deterministic smoke sample is six questions.

`--resume` only reuses a question when its isolated L0 count exactly matches the expected flattened message count. If the process stopped during ingestion and the count is partial, the runner fails closed instead of calling the gateway delete endpoint (which can use a different isolation key); start that run again with a new `--output-dir`.

The full answer mode is not equivalent to the no-token retrieval gate: it calls the configured OpenAI-compatible model for answer generation and, unless `--no-judge` is supplied, for the official yes/no judge. `--no-oracle` removes the evidence-only answer ceiling. Layered runs additionally invoke Memory Core's extraction pipeline and are guarded by `--allow-layered-cost`.

The 2026-08-10 gate used 60 cleaned-S questions (10 per type), seed `somniq-longmemeval-v1`, dataset SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`, and a shared isolated database containing 30,034 messages:

| Metric | TencentDB L0 | Builtin `session_search` |
|---|---:|---:|
| Evidence-session Recall@5 | 88.3% | 90.0% |
| Evidence-session MRR@5 | 0.858 | 0.851 |
| Evidence-turn Recall@5 | 69.0% | 87.9% |
| Evidence-turn MRR@5 | 0.568 | 0.812 |
| Mean recall latency | 38.0 ms | 936.5 ms |
| p95 recall latency | 83.0 ms | 1,585.0 ms |

The gate is **failed** even though TencentDB is substantially faster: no Tencent-only turn hit was observed, while builtin alone recovered 11 labeled turns (exact paired McNemar p=0.0010). Expanding each Tencent hit with the same ±5-message window projects turn Recall@5 to 86.2%, showing that most of the gap is context materialization rather than session ranking. Preference recall remains a separate keyword-ranking weakness: TencentDB reached only 50% session and 30% turn Recall@5 on that category.

Do not stop the legacy Session index or make TencentDB the default while this gate is failed. The current TencentDB `session_search` adapter reattaches locators and message windows through the builtin index; that compatibility bridge is not an independent replacement. Before rerunning the gate, Memory Core/SomniQ must provide a source-session locator that does not depend on `session-index.sqlite3`, fetch a bounded neighboring-message window, and evaluate L1/persona or verified hybrid retrieval for preference questions. Full 60-question layered extraction is deferred: this sample contains about 3,029 ten-message L1 batches before L2/L3 calls.

## Builtin-next index and retrieval

`runtime::search_sessions` is projection-only on the hot path. `Session::save_to_path` compares the desired message projection with existing SQLite rows and inserts, changes, or removes only affected L0/FTS rows. It must never scan the Session directory before a normal query. Project activation starts `sync_sessions_dir` on a background repair thread; schema upgrades may also perform one guarded bootstrap repair before the new index is used.

The keyword path preserves the proven session-level ordering and bounded `±5` neighbor window. Preference-bearing user/profile messages are indexed separately; a preference query may add at most one exact profile message to an already selected Session, but it cannot replace the lexical anchor or remove its original window. Imported `date=YYYY/MM/DD` markers and native Session event timestamps are stored as Unix milliseconds. `session_search` accepts inclusive `time_start`/`time_end` dates and a bounded `prefer_recent` tie-break for updated facts.

Embedding remains optional. Runtime exposes pending-message batches, transactional vector upsert with automatic invalidation when source content changes, and an explicit hybrid search entrypoint using weighted RRF. The default keyword path never calls a model or network service and does not require vectors.

The final 2026-08-10 rerun used the exact same 60 question IDs and baseline output:

| Metric | Builtin-next | Previous builtin | TencentDB L0 |
|---|---:|---:|---:|
| Evidence-session Recall@5 | 90.0% | 90.0% | 88.3% |
| Evidence-session MRR@5 | 0.851 | 0.851 | 0.858 |
| Evidence-turn Recall@5 | 87.9% | 87.9% | 69.0% |
| Evidence-turn MRR@5 | 0.812 | 0.812 | 0.568 |
| Mean recall latency | 26.0 ms | 936.5 ms | 38.0 ms |
| p95 recall latency | 42.0 ms | 1,585.0 ms | 83.0 ms |

Paired against the previous builtin, both session and labeled-turn outcomes were identical (`next-only=0`, `baseline-only=0`, exact McNemar `p=1.0`). Mean latency fell 97.2% and p95 fell 97.4%. On this fixed L0 retrieval gate, builtin-next therefore retains the stronger context recall while also beating TencentDB's measured mean and p95 latency. TencentDB remains experimental; this result does not claim superiority over an untested full layered TencentDB run.

SomniQ's builtin provider now also has a research-specific derived hierarchy.
Its authority, R0/R1/R2/R3 semantics, capture rules, conflict handling, and UI
governance are specified in `builtin-research-memory.md`. Do not treat its R1
atoms as literature evidence or its R3 constitution as live Workflow state.
