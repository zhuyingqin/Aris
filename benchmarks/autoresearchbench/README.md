# SomniQ × AutoResearchBench

This isolated harness evaluates SomniQ's real Agent runtime on
[AutoResearchBench](https://github.com/CherYou/AutoResearchBench) without
changing Desktop/Tauri product code. It reuses `aris-chat` for the model/tool
loop and `tools` for `LiteratureSearch`, `WebSearch`, and `WebFetch`.

No GPU is required when the Executor and optional Reviewer use hosted APIs.

## What is measured

- `deep`: locate one target paper from multi-hop clues.
- `wide`: collect all papers satisfying an open-ended set of conditions.
- `executor`: one SomniQ Executor under a bounded retrieval budget.
- `executor + reviewer`: the same budget plus one independent validity review
  and, only when rejected, one Executor revision. Report this configuration
  separately from the single-Executor baseline.

The runner never places `answer` or `arxiv_id` from the input record in the
model prompt. Those fields remain only in `input_data` so the official evaluator
can score the generated candidates.

## Folder layout

```text
autoresearchbench/
├── src/                 Rust Agent runner and output adapter
├── scripts/             Upstream setup, run, and evaluation helpers
├── fixtures/            Synthetic schema-only smoke inputs
├── .cache/              Official repo, dataset, Python venv (ignored)
└── runs/                Isolated sessions, traces, and outputs (ignored)
```

## 1. Verify locally without API calls

From this directory:

```powershell
cargo test
./scripts/run.ps1 -InputFile ./fixtures/deep_sample.jsonl -DryRun
./scripts/run.ps1 -InputFile ./fixtures/wide_sample.jsonl -DryRun
```

Dry-run validates JSONL, task-type inference, slicing, and configuration. The
synthetic fixtures are not meaningful accuracy tests.

## 2. Fetch the official benchmark

```powershell
./scripts/bootstrap.ps1
```

This clones the official Apache-2.0 repository into `.cache/`, creates a local
Python virtual environment, downloads the released obfuscated bundle, and uses
the upstream decryptor. The script prints the exact upstream commit used.

## 3. Configure SomniQ

The runner first reads `.env`, then falls back to the active Executor in
`~/.config/SomniQ/config.json`. Copy `.env.example` only when explicit overrides
are needed:

```powershell
Copy-Item .env.example .env
```

Never commit `.env`. Search keys are optional: OpenAlex, Crossref, and arXiv can
run without them. Scopus, Semantic Scholar, Brave, and Exa improve coverage when
configured.

For a custom OpenAI-compatible gateway, `SOMNIQ_BENCH_TRANSPORT` can force
`chat` or `responses` when automatic model detection does not match the gateway.
`SOMNIQ_BENCH_NON_STREAM=1` enables the non-streaming compatibility path for
gateways that omit required reasoning fields in streamed tool responses.
`SOMNIQ_BENCH_MESSAGE_IDS=1` adds top-level IDs for strict gateways that require
them on assistant/tool messages.

## 4. Run a bounded sample

```powershell
$Dataset = ".cache/AutoResearchBench/input_data/AutoResearchBench.jsonl"

# Compatibility-oriented single Executor runs
./scripts/run.ps1 -InputFile $Dataset -Task deep -Limit 10 `
  -ToolProfile literature -OutputFile ./runs/deep.jsonl
./scripts/run.ps1 -InputFile $Dataset -Task wide -Limit 10 `
  -ToolProfile literature -OutputFile ./runs/wide.jsonl

# Full SomniQ run; Reviewer must use a different provider/model identity
./scripts/run.ps1 -InputFile $Dataset -Task deep -Limit 10 `
  -ToolProfile hybrid -Reviewer -OutputFile ./runs/deep-reviewed.jsonl
```

The runner is sequential by design because SomniQ's workspace binding is a
process-level environment boundary. Each question/pass gets a separate folder
under `runs/.../workspaces/<question-hash>/pass-N/`, including a durable
`session.json`. The official-compatible JSONL also embeds bounded tool traces,
model identity, usage, and Reviewer metadata under `somniq`.

Interrupted runs are resumable: pass the same `--output` path and completed
questions are skipped.

For direct options:

```powershell
cargo run --release -- --help
```

## 5. Evaluate with the official scripts

Split Deep and Wide records into separate runs with `--only-task-type` when producing
leaderboard-style reports, then run:

```powershell
./scripts/evaluate.ps1 -Task deep -InputFile ./runs/<run>/deep.jsonl
./scripts/evaluate.ps1 -Task wide -InputFile ./runs/<run>/wide.jsonl `
  -GroundTruthFile ./.cache/AutoResearchBench/input_data/AutoResearchBench.jsonl
```

Deep evaluation uses an LLM title judge and therefore needs the official
repository's evaluation model variables. Wide evaluation scores predicted
arXiv IDs with IoU, recall, and precision.

## Fair-comparison rules

1. Record the Executor model, tool profile, passes, and retrieval-call budget.
2. Do not mix Deep and Wide task-type overrides in one reported score.
3. Keep the same retrieval budget when comparing Executor-only and Reviewer
   variants; the revision shares the Executor's remaining budget.
4. Report Reviewer-enabled results as a SomniQ system result, not as the
   official single-agent baseline.
5. Preserve output JSONL and per-item session folders for auditability.
