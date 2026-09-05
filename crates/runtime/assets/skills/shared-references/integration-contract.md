# Integration Contract

When one ARIS skill delegates work to another (or to persistent project
state), the coupling must be **engineered**, not assumed. This document
formalizes what every cross-skill integration inside ARIS must provide.

Rule of thumb: **SKILL.md prose can *describe* an integration; it cannot
*guarantee* one.** Any integration whose silent failure would damage the
research result needs the components below. Prose-only "MUST invoke X"
has repeatedly failed in practice — the executor skips under context
pressure and the caller has no way to detect it.

## Known failure mode (why this contract exists)

Two bugs in the same week, same pathology:

1. **Assurance gate bypass (2026-04-21).** `/paper-writing` ran at
   `— effort: beast` silently skipped `/proof-checker`,
   `/paper-claim-audit`, and `/citation-audit` because each phase's
   content detector could return negative and the outer prose said
   "audit is optional."
2. **Research wiki ingest no-op (2026-04-21).** `/research-wiki init`
   created `research-wiki/papers/` but no paper ever landed there:
   `/arxiv`, `/openalex`, `/literature-search`,
   raw `Read`/`WebFetch` — none carried a wiki-ingest hook, and the two
   that did (`/research-lit`, `/idea-creator`) only had soft prose
   ("optional and automatic").

Both bugs ship through the same gap: **one skill "called" another via
prose without a canonical helper, a concrete artifact, or a verifier**.

## Required components

Every integration between two ARIS skills (or between a skill and a
persistent project artifact) must provide all six:

### 1. Activation predicate — single, explicit, observable

A one-line test that says "does this integration fire in this context?"
Must be observable from outside the LLM (a file exists, an argument is
set, an environment variable is present). Not a vibe, not "probably
relevant."

- ✅ `if [ -d research-wiki/ ]`
- ✅ `if assurance == "submission"`
- ❌ "if the user seems to want this"

### 2. Canonical helper — one implementation, not copy-pasted

The business logic lives in **exactly one place** — a script under
`tools/` (canonical name, no path prefix), or a single subcommand of
an existing helper. Every caller invokes the same entrypoint, but
every caller must also resolve **where** that entrypoint lives.

SomniQ bundles these helpers into the binary and extracts them to a
versioned cache at startup. The runtime prepends a **"Helper resolution"**
preamble to every skill prompt that names the chain *and* the concrete
absolute path of each helper bundled for that skill — read it first; it is
authoritative for the current process. The chain is:

1. `<skill-dir>/tools/<helper>` — filesystem skills only, where the SKILL.md lives
2. `~/.config/SomniQ/tools/<helper>` — user override, wins over the bundle
3. `$ARIS_CACHE_DIR/tools/<helper>` — the bundled copy for this binary
4. `<project>/tools/<helper>` — legacy compat with main-branch layouts

`$ARIS_CACHE_DIR` is exported by the app at startup, so bash subprocesses
inherit it. Layer 3 is the one that is always present in a normal install;
the others exist so a user can shadow a helper without rebuilding.

#### Resolver block (lookup only — failure policy is separate)

```bash
# Canonical strict-safe variant: works whether or not the caller has
# `set -e` / `set -u` enabled. `[ -f ]` means no chmod +x is required.
HELPER=""
for candidate in "$HOME/.config/SomniQ/tools/<helper>" "${ARIS_CACHE_DIR:-.}/tools/<helper>" "tools/<helper>"; do
  [ -f "$candidate" ] && { HELPER="$candidate"; break; }
done
```

After the resolver runs, `$HELPER` is either a resolved path or the empty
string. Use a semantic variable name in real callers (`AUDIT_VERIFIER`,
`TRACE_HELPER`, `WIKI_SCRIPT`, …) so a single SKILL that resolves multiple
helpers does not clobber one with another.

**Do not `cd` to the git root first.** Earlier revisions of this block
opened with `cd "$(git rev-parse --show-toplevel)"`, which silently moved
the working directory for everything the skill ran afterwards. Layer 3 is
absolute, so the resolver does not need a particular cwd.

#### Failure policy (chosen per integration)

The resolver does **not** decide what happens when the helper is
missing. Each calling SKILL must pick exactly one policy below based
on how the helper contributes to the research outcome:

**A. Load-bearing gate — unresolved helper must block.** Use for
verifiers whose exit code gates submission readiness (e.g.
`verify_paper_audits.sh` under `assurance: submission`).

```bash
[ -n "$AUDIT_VERIFIER" ] || {
  echo "ERROR: verify_paper_audits.sh not resolved. Checked ~/.config/SomniQ/tools/, \$ARIS_CACHE_DIR/tools/, and ./tools/." >&2
  echo "       assurance=submission requires the verifier; aborting Final Report." >&2
  exit 1
}
```

**B. Optional side-effect — unresolved helper warns and skips.** Use
when the SKILL's primary output is still delivered without the
helper (e.g. `research_wiki.py ingest_paper` — idea ranking still
gets produced, only the wiki side-effect is missed).

```bash
[ -n "$WIKI_SCRIPT" ] || {
  echo "WARN: research_wiki.py not resolved; primary output unaffected, wiki side-effect skipped." >&2
  echo "      Fix: reinstall SomniQ so the bundled helpers extract, or drop a copy at ~/.config/SomniQ/tools/." >&2
}
[ -n "$WIKI_SCRIPT" ] && python3 "$WIKI_SCRIPT" ingest_paper research-wiki/ --arxiv-id "$id"
```

**C. Forensic helper — unresolved means write artifacts directly.**
Use when the helper produces a record the SKILL is contractually
required to leave behind (e.g. `save_trace.sh`). The fallback is
**not** "skip"; it is "write the schema artifacts inline."

```bash
[ -n "$TRACE_HELPER" ] || {
  echo "WARN: save_trace.sh not resolved; writing trace files directly per review-tracing.md schema." >&2
}
if [ -n "$TRACE_HELPER" ]; then
  bash "$TRACE_HELPER" --skill "$SKILL" --purpose "$PURPOSE" --model "$MODEL" \
 --prompt "$PROMPT" --response "$RESPONSE"
else
  # Required fallback: write run.meta.json, request.json, response.md, meta.json
  # directly per review-tracing.md schema. Do NOT silently skip unless
  # `--- trace: off` was explicitly requested.
...
fi
```

**D1. Primary helper with first-success cascade — try N sources in
priority order, accept first success.** Use when the SKILL needs
one paper-discovery source and falls back across alternatives.

The example below is POSIX-sh safe (`${VAR:-}` defaults plus
explicit `source_used=""` init) so the same snippet works under
`#!/bin/sh`, `#!/bin/bash`, `set -e`, and `set -u`.

```bash
source_used=""
if [ -n "${S2_FETCHER:-}" ]; then
  if python3 "$S2_FETCHER" --query "$Q" > results.jsonl; then
    source_used="semantic_scholar"
  else
    echo "WARN: semantic_scholar_fetch.py invocation failed; trying arxiv." >&2
    S2_FETCHER=""  # force cascade
  fi
fi
if [ -z "$source_used" ] && [ -n "${ARXIV_FETCHER:-}" ]; then
  echo "WARN: semantic_scholar_fetch.py not resolved or failed; falling back to arxiv_fetch.py." >&2
  if python3 "$ARXIV_FETCHER" --query "$Q" > results.jsonl; then
    source_used="arxiv_fallback"
  fi
fi
if [ -z "$source_used" ]; then
  echo "ERROR: no fetcher resolved or succeeded; cannot retrieve papers." >&2
  exit 1
fi
```

The `if helper-invocation; then ... else ...` wrapper consumes the
helper's exit code so the cascade fires even under `set -e`.

**D2. Multi-source aggregate — invoke every resolved source,
aggregate results.** Use when the SKILL ranks or dedupes across all
available sources (e.g. `/research-lit` querying S2 + arxiv +
OpenAlex + Exa). Each source's success/failure is recorded; the
SKILL proceeds with a (possibly partial) aggregate if at least one
source contributed.

The example below is POSIX-sh safe (delimited-string accumulator
instead of bash arrays, so the snippet works under `dash`,
macOS bash 3.2, etc.):

```bash
sources_used=""
sources_count=0
append_source() {
  sources_used="${sources_used:+$sources_used,}$1"
  sources_count=$((sources_count + 1))
}

if [ -n "${S2_FETCHER:-}" ]; then
  if python3 "$S2_FETCHER" --query "$Q" >> results.jsonl 2>>fetch.log; then
    append_source "semantic_scholar"
  else
    echo "WARN: semantic_scholar_fetch.py failed; see fetch.log" >&2
  fi
fi
if [ -n "${ARXIV_FETCHER:-}" ]; then
  if python3 "$ARXIV_FETCHER" --query "$Q" >> results.jsonl 2>>fetch.log; then
    append_source "arxiv"
  else
    echo "WARN: arxiv_fetch.py failed; see fetch.log" >&2
  fi
fi
# ... repeat for openalex, exa, deepxiv ...
if [ "$sources_count" -eq 0 ]; then
  echo "ERROR: no fetcher resolved or succeeded; aggregate empty." >&2
  exit 1
fi
echo "Aggregated from: $sources_used" >&2
```

Record `sources_used` (or equivalent) in the SKILL's output manifest
so downstream consumers know which sources contributed.

**E. Diagnostic / report helper — non-zero exit is captured, not propagated.**
Use when the helper's role is to surface drift to humans rather than
gate workflow correctness (e.g. `verify_wiki_coverage.sh` exits 1
when wiki coverage has gaps, but coverage is not load-bearing on any
research outcome). The SKILL records the diagnostic outcome to a
report file but does not propagate the exit code as a workflow gate.

```bash
if [ -n "$WIKI_COVERAGE_DIAG" ]; then
  # Wrap the helper call in if/then/else so `set -e` does not exit
  # the SKILL when the helper exits non-zero to report gaps.
  if bash "$WIKI_COVERAGE_DIAG" research-wiki/ > coverage_report.txt; then
    diag_exit=0
  else
    diag_exit=$?
  fi
  echo "Coverage diagnostic written to coverage_report.txt (exit=$diag_exit)" >&2
  # Do NOT propagate $diag_exit; this is a report, not a gate.
else
  echo "WARN: verify_wiki_coverage.sh not resolved; coverage diagnostic skipped (non-load-bearing)." >&2
fi
```

`wiki-helper-resolution.md` is the research-wiki-specific instance
of this generic resolver, and is the precedent for everything in §2.

#### Skill-local helpers

Some helpers belong to exactly one SKILL and live in that skill's own
`scripts/` subdirectory rather than in `tools/` — `figure-spec` and
`render-html` are the two current cases. They bundle under the
`skills/<name>/<rel>` key instead of `tools/<helper>`, so their resolver
uses the same three layers with a different suffix:

```bash
HELPER=""
for candidate in \
  "$HOME/.config/SomniQ/skills/<name>/scripts/<helper>" \
  "${ARIS_CACHE_DIR:-.}/skills/<name>/scripts/<helper>" \
  "skills/<name>/scripts/<helper>"; do
  [ -f "$candidate" ] && { HELPER="$candidate"; break; }
done
```

Cross-skill helpers (`research_wiki.py`, `save_trace.sh`) stay under
`tools/` — there is no single owning skill to anchor them to.

#### Per-helper policy assignments

Every helper invoked from any SKILL.md (single-skill or shared
across skills) is classified below so that downstream SKILLs do not
have to guess. Pure developer utilities that are never invoked from a
SKILL.md — manual setup (`overleaf_setup.sh`) and `watchdog.py` — are
out of scope.
If a future helper does not fit any policy, extend the taxonomy
here first.

| Helper (canonical name) | Policy | Rationale |
|---|---|---|
| `verify_paper_audits.sh` | A (gate) | Exit code is the source of truth for submission readiness |
| `save_trace.sh` | C (forensic) | Trace artifacts are load-bearing for audit traceability and reviewer-independence audit |
| `research_wiki.py ingest_paper` (caller skills) | B (side-effect) | Primary output (idea ranking, paper summary) is delivered without wiki ingestion |
| `research_wiki.py` (in `/research-wiki` itself) | A (gate) | The SKILL is the wiki tool; missing helper means no functionality (Variant A in `wiki-helper-resolution.md`) |
| `verify_wiki_coverage.sh` | E (diagnostic) | Reports coverage gaps; not load-bearing on any research outcome |
| `verify_papers.py` | D1 (primary + fallback cascade) | Filters candidate papers via arXiv/CrossRef/S2 cross-checks; when unresolved **or** invocation fails, callers emit a degraded `verified_papers.json` tagging every candidate `status=unverified, method=none` with explicit WARN |
| `arxiv_fetch.py`, `semantic_scholar_fetch.py`, `deepxiv_fetch.py`, `exa_search.py`, `openalex_fetch.py` | D2 (multi-source aggregate) when SKILL queries multiple sources (e.g. `/research-lit`); D1 (cascade) when a single source suffices | Each fetcher is one paper-discovery source; SKILLs aggregate or cascade across resolved sources and record which contributed |
| `extract_paper_style.py` | A when activation predicate `literal "— style-ref:" or equivalent in $ARGUMENTS` is true; not invoked otherwise | If the user asked for style transfer and the helper is unresolved, the SKILL cannot satisfy the request |
| `paper_illustration_image2.py` (`preflight`, `finalize`, `verify`) | A (skill-local gate) | Image2 finalization cannot complete without these checks; verify exits 1 on missing artifacts and that is a skill-local gate (the parent paper-writing workflow may still continue with the alternate illustration path). **Phase 3.2 move**: canonical location is `skills/paper-illustration-image2/scripts/paper_illustration_image2.py`; `tools/paper_illustration_image2.py` retained as `os.execv` shim for legacy resolver layers. |
| `figure_renderer.py` | A (skill-local gate, single-skill) | `figure-spec` cannot produce vector SVG output without the renderer. **Phase 3.1 move**: canonical location is `skills/figure-spec/scripts/figure_renderer.py`; `tools/figure_renderer.py` retained as `os.execv` shim for legacy resolver layers. |
| `overleaf_audit.sh` | E (diagnostic) | Reports overleaf sync drift; surfaces gaps but does not gate the parent workflow |

When a SKILL invokes a helper not listed above, add the row here as
part of the same commit and link the chosen policy. Inconsistency in
this table is the cheapest place to catch policy drift.

#### Examples

- ✅ Resolved-via-chain invocation: `python3 "$WIKI_SCRIPT" ingest_paper <root> --arxiv-id <id>` (where `$WIKI_SCRIPT` was set by the chain above with `<helper>=research_wiki.py`)
- ✅ Resolver block + policy A above for `verify_paper_audits.sh` (submission-gate verifier)
- ❌ Hard-coded `python3 tools/research_wiki.py …` from a downstream skill that may run in a project without `tools/` on disk — it silently exits 2 and the caller proceeds with no side effect, which is exactly the failure mode that left a real user's `research-wiki/` empty for a week.
- ❌ N skills each paraphrasing the same 10-line bash snippet. When one drifts, they all drift.

If the same 3+ lines of prose appear in more than two SKILL.md files,
factor them into a helper.

### 3. Concrete artifact or log entry

Successful execution must leave an observable side effect: a file, a
JSON record, a log line. The artifact is the receipt — something a
third party (verifier, code reviewer, human auditor) can inspect to
answer "did this integration run?"

- ✅ `paper/PROOF_AUDIT.json` with the 6-state verdict schema
- ✅ `research-wiki/papers/<slug>.md` + `research-wiki/log.md` append
- ❌ "the model said it ran"

### 4. Visible checklist — for long workflows

If the integration fires inside a multi-step workflow (paper-writing
Phase 6, idea-discovery Phase 7, etc.), render a **visible checkbox
block** at the start of the phase so the executor has to confront each
row before claiming done. Prose-only "MUST" inside a long SKILL.md is
the first thing to get skipped.

```
📋 Submission audits required before Final Report:
   [ ] 1. /proof-checker   → paper/PROOF_AUDIT.json
   [ ] 2. /paper-claim-audit → paper/PAPER_CLAIM_AUDIT.json
   [ ] 3. /citation-audit  → paper/CITATION_AUDIT.json
   [ ] 4. Resolve $AUDIT_VERIFIER via §2 (canonical name verify_paper_audits.sh)
          then: bash "$AUDIT_VERIFIER" paper/ --assurance submission
   [ ] 5. Block Final Report iff verifier exit code != 0
```

Cheap, and empirically resists lazy skipping. Skip only for single-step
invocations (one-off skills like `/arxiv 2501.12345`).

### 5. Backfill / repair command — explicit manual fallback

An escape hatch for when the integration didn't fire. Users must be
able to run a command that **declares** the missed inputs and ingests
them retroactively. Prefer explicit arguments over trace-scanning — the
helper should not have to guess what to backfill.

- ✅ `/research-wiki sync --arxiv-ids 2501.12345,1706.03762`
- ✅ `/research-wiki sync --from-file ids.txt`
- ⚠️ `/research-wiki sync` that scans `.aris/traces/` for arxiv IDs —
     only as a best-effort secondary mode, not the primary UX, and
     clearly labeled as heuristic.

### 6. Verifier or diagnostic (only when load-bearing)

If silent failure of this integration would damage the research result
(wrong numbers shipped to a conference, claims unsupported by
evidence, citations in wrong context), a verifier script must exist
whose exit code is the source of truth for downstream gates.

- ✅ `verify_paper_audits.sh` — exit 1 blocks Final Report (resolved per §2)
- ✅ `verify_wiki_coverage.sh` — diagnostic only, reports gaps but
     does not block (coverage is not load-bearing on any research
     outcome; resolved per §2)

Verifiers must be **external processes** (not LLM self-report), must
validate **concrete artifacts** (§3) against a schema, and must emit a
structured report callers can parse.

A diagnostic-only verifier (no exit-1 blocking) is still valuable — it
surfaces drift to humans. But do not market a diagnostic as a gate.

## Anti-patterns to refuse in review

When reviewing a new integration proposal, reject any of:

- **"Optional and automatic"** — contradicts itself; if it's automatic,
  it's not optional. Pick one and mean it.
- **"The skill will intelligently decide"** — indecision surface, not
  a predicate (§1).
- **"Copy the following 10 lines into each caller"** — missing helper
  (§2); will drift within a month.
- **"The reviewer can see from the logs that..."** — if the evidence is
  unstructured logs, write a schema and make it an artifact (§3).
- **"Users should remember to..."** — missing backfill (§5); humans
  don't reliably remember.
- **"Trust the LLM to self-report completion"** — missing verifier (§6)
  when the failure is load-bearing.

## Known ARIS integrations under this contract

Helper names in the table below are **canonical names**; callers
resolve actual paths via §2.

| Integration | Predicate | Helper | Artifact | Checklist | Backfill | Verifier |
|---|---|---|---|---|---|---|
| Submission audits (`max`/`beast`) | `paper/.aris/assurance.txt = submission` | `verify_paper_audits.sh` + 3 audit skills emit JSON | `paper/PROOF_AUDIT.json`, `PAPER_CLAIM_AUDIT.json`, `CITATION_AUDIT.json` + `paper/.aris/audit-verifier-report.json` | Phase 6.0 pre-flight checklist | Rerun the failed audit | `verify_paper_audits.sh` (exit 1 blocks) |
| Research wiki ingest | `research-wiki/` exists | `research_wiki.py ingest_paper` | `research-wiki/papers/<slug>.md` + `log.md` entry | Step in each paper-reading skill | `research_wiki.py sync --arxiv-ids …` | `verify_wiki_coverage.sh` (diagnostic) |
| paper-illustration-image2 finalization | `paper_illustration_image2.py preflight --workspace <cwd>` returns `ok=true` | `paper_illustration_image2.py` (`preflight`, `finalize`, `verify`) | `figures/ai_generated/figure_final.png`, `latex_include.tex`, `review_log.json` | Step 0 checklist in `paper-illustration-image2` | `paper_illustration_image2.py finalize --workspace <cwd> --best-image <png>` | `paper_illustration_image2.py verify` (skill-local gate; exit 1 on missing artifacts blocks finalize claim, parent workflow may continue with the alternate illustration path) |

When adding a new cross-skill integration, add a row to the table above
and confirm all six columns are populated.

## See Also

- `shared-references/assurance-contract.md` — implementation of the
  paper-writing submission gate under this contract
- `shared-references/reviewer-independence.md` — the adjacent contract
  for cross-model review (executor never filters reviewer inputs)
- `tools/verify_paper_audits.sh`, `tools/research_wiki.py ingest_paper`,
  `tools/verify_wiki_coverage.sh` — current canonical helpers
