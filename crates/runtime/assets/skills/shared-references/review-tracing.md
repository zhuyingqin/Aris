# Review Tracing Protocol

## Purpose

Save full prompt/response pairs for every cross-model reviewer call, enabling:
- **Reviewer-independence audit**: verify the executor only passed file paths, not summaries
- **Reproducibility**: the saved prompt is the only way to replay a review, since `LlmReview` keeps no history of its own
- **Harness analysis**: richer data for improving prompts and workflows

## When to Trace

After **every** `LlmReview` call that serves a reviewer/critique function. This includes review scoring, experiment auditing, claim verification, idea critique, and patch gating.

Do NOT trace: purely informational LLM calls (e.g., generation calls that are not reviews).

## Trace Directory

```
.aris/traces/<skill-name>/<YYYY-MM-DD>_run<NN>/
  ├── run.meta.json                      # Run-level metadata
  ├── 001-<purpose>.request.json         # Request snapshot
  ├── 001-<purpose>.response.md          # Full response text
  ├── 001-<purpose>.meta.json            # Response metadata
  ├── 002-<purpose>.request.json         # Second call (e.g., reply)
  └── ...
```

- `<skill-name>`: the ARIS skill that triggered this call (e.g., `auto-review-loop`)
- `<YYYY-MM-DD>_run<NN>`: date + sequential run number (start from `01`)
- `<purpose>`: short kebab-case label (e.g., `round-1-review`, `critique`, `ideation`, `audit`, `patch-gate`)

## How to Trace

After each reviewer call, save the trace using `save_trace.sh`,
resolved through the canonical helper chain (see
`integration-contract.md` §2 — failure policy C, "forensic helper").
The full invocation:

```bash
# Resolve $TRACE_HELPER (canonical strict-safe chain; see integration-contract.md §2).
TRACE_HELPER=""
for candidate in "$HOME/.config/SomniQ/tools/save_trace.sh" "${ARIS_CACHE_DIR:-.}/tools/save_trace.sh" "tools/save_trace.sh"; do
  [ -f "$candidate" ] && { TRACE_HELPER="$candidate"; break; }
done

if [ -n "$TRACE_HELPER" ]; then
  bash "$TRACE_HELPER" \
    --skill "<skill-name>" \
    --purpose "<purpose>" \
    --model "<model>" \
    --prompt "<full prompt as sent>" \
    --response "<full response content>"
else
  # Required fallback: the resolver exhausted all three layers and
  # save_trace.sh is unreachable, but trace artifacts are still
  # required (unless `--- trace: off` was explicitly set on this
  # SKILL invocation). Write the four files below directly per the
  # schemas in "File Schemas", into:
  #.aris/traces/<skill-name>/<YYYY-MM-DD>_run<NN>/
  #     run.meta.json
  #     <NNN>-<purpose>.request.json
  #     <NNN>-<purpose>.response.md
  #     <NNN>-<purpose>.meta.json
  # Do NOT silently skip — trace_path is load-bearing for any
  # mandatory audit emitting `trace_path` in its artifact (see
  # assurance-contract.md §"Required Audit Artifact Schema").
  echo "WARN: save_trace.sh not resolved; writing trace files directly per review-tracing.md schema." >&2
fi
```

The helper, when present, handles directory creation, run numbering,
and file writing. The fallback branch above documents what to do
when the helper is unreachable — the trace is forensic evidence, so
"helper missing" never means "skip the trace."

## File Schemas

### `run.meta.json`
```json
{
  "skill": "auto-review-loop",
  "run_id": "2026-04-15_run01",
  "started_at": "2026-04-15T14:30:00+08:00",
  "executor": "claude-code",
  "project_dir": "/path/to/project"
}
```

### `NNN-<purpose>.request.json`
```json
{
  "call_number": 1,
  "purpose": "round-1-review",
  "timestamp": "2026-04-15T14:31:00+08:00",
  "tool": "LlmReview",
  "model": "<reviewer model actually used>",
  "files_referenced": ["paper/sections/3_method.tex", "results/table1.csv"],
  "prompt": "<full prompt text>"
}
```

### `NNN-<purpose>.response.md`
The reviewer's full response, verbatim. No truncation, no summarization.

### `NNN-<purpose>.meta.json`
```json
{
  "call_number": 1,
  "purpose": "round-1-review",
  "timestamp": "2026-04-15T14:33:00+08:00",
  "model": "<reviewer model actually used>",
  "duration_ms": 142000,
  "status": "ok"
}
```

## Configuration

Tracing respects three modes, set via inline parameter `--- trace: off | meta | full`:
- **`full`** (default): save full prompt + full response
- **`meta`**: save metadata only (no prompt/response text), useful for sensitive projects
- **`off`**: disable tracing entirely

## Integration with events.jsonl

After writing a trace, append a compact summary event to `.aris/meta/events.jsonl`:

```json
{"event":"review_trace","skill":"auto-review-loop","purpose":"round-1-review","trace_path":".aris/traces/auto-review-loop/2026-04-15_run01/","status":"ok"}
```

This lets tooling discover traces without reading the full trace files.

## Privacy

- `.aris/traces/` should be in `.gitignore` — traces are project-local, never committed
- Traces may contain sensitive research content; treat them as confidential
- Use `--- trace: off` for projects with strict confidentiality requirements
