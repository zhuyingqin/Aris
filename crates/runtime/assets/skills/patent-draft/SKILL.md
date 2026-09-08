---
name: patent-draft
description: "Draft a patent application stage by stage: invention disclosure, claims, figures, embodiments, specification, examiner review, and jurisdiction formatting. Use when user says \"撰写权利要求\", \"draft claims\", \"写权利要求书\", \"构建发明\", \"撰写说明书\", \"write specification\", \"撰写实施例\", \"附图说明\", \"专利审查\", \"格式转换\", or wants any part of a patent application written."
argument-hint: "[input-path] [— stage: structure|claims|figures|embodiments|spec|review|format]"
allowed-tools: read_file, write_file, edit_file, glob_search, grep_search, bash, WebSearch, WebFetch, LlmReview, Agent
---

# Patent Draft: Stage-by-Stage Application Writing

Write the requested part of a patent application: **$ARGUMENTS**

Each stage reads the previous stage's artifact and writes its own. `/patent-pipeline`
drives all seven in order with checkpoints; invoke this skill directly to run or
redo a single stage.

## Stages

| `— stage:` | Does | Reads | Writes |
|---|---|---|---|
| `structure` | Decompose the invention (Problem-Solution-Advantage, core/supporting/optional features, claim plan) | `INVENTION_BRIEF.md`, `PRIOR_ART_REPORT.md`, `NOVELTY_ASSESSMENT.md` | `patent/INVENTION_DISCLOSURE.md` |
| `claims` | Draft the claims hierarchy — the legal scope | `INVENTION_DISCLOSURE.md`, `PRIOR_ART_REPORT.md` | `patent/CLAIMS.md` |
| `figures` | Assign reference numerals, write 附图说明 | user figures, `CLAIMS.md` | `patent/figures/figure_descriptions.md`, `numeral_index.md` |
| `embodiments` | Write the detailed description (how to make and use) | `CLAIMS.md`, `numeral_index.md` | `patent/specification/detailed_description.md` |
| `spec` | Write the remaining specification sections and verify claim support | `CLAIMS.md`, `INVENTION_DISCLOSURE.md` | `patent/specification/*.md` |
| `review` | Examiner-style review, 2 rounds | `patent/` | `patent/PATENT_REVIEW.md` |
| `format` | Compile into CN / US / EP filing format | `patent/` | `patent/output/<JURISDICTION>/` |

**Stage detection.** If `— stage:` is absent, infer from `$ARGUMENTS` and from
which artifacts already exist: no `INVENTION_DISCLOSURE.md` → `structure`;
disclosure but no `CLAIMS.md` → `claims`; and so on down the table. State which
stage you inferred before starting.

## Reading a stage

Each stage's full procedure lives in its own file, so only the stage actually
being run enters context. Resolve and read it first:

```bash
STAGE_DOC=""
for candidate in \
  "$HOME/.config/SomniQ/skills/patent-draft/stages/<stage>.md" \
  "${ARIS_CACHE_DIR:-.}/skills/patent-draft/stages/<stage>.md" \
  "skills/patent-draft/stages/<stage>.md"; do
  [ -f "$candidate" ] && { STAGE_DOC="$candidate"; break; }
done
[ -n "$STAGE_DOC" ] || {
  echo "ERROR: patent-draft stage doc not resolved. Checked ~/.config/SomniQ/, \$ARIS_CACHE_DIR/, and ./skills/." >&2
  echo "       Fix: reinstall SomniQ so the bundled assets extract." >&2
  exit 1
}
```

Then `read_file "$STAGE_DOC"` and follow it. The bundled paths are:

- `${ARIS_CACHE_DIR:-.}/skills/patent-draft/stages/structure.md`
- `${ARIS_CACHE_DIR:-.}/skills/patent-draft/stages/claims.md`
- `${ARIS_CACHE_DIR:-.}/skills/patent-draft/stages/figures.md`
- `${ARIS_CACHE_DIR:-.}/skills/patent-draft/stages/embodiments.md`
- `${ARIS_CACHE_DIR:-.}/skills/patent-draft/stages/spec.md`
- `${ARIS_CACHE_DIR:-.}/skills/patent-draft/stages/review.md`
- `${ARIS_CACHE_DIR:-.}/skills/patent-draft/stages/format.md`

## Constants

- `JURISDICTION = "auto"` — Inherit from `/patent-pipeline` or detect from args: `CN`, `US`, `EP`, `ALL`
- `PATENT_TYPE = "invention"` — `invention` (发明专利) or `utility_model` (实用新型, CN only, apparatus claims only)
- `LANGUAGE = "auto"` — Auto from jurisdiction: CN→Chinese, US/EP→English
- `OUTPUT_DIR = "patent/"` — Base output directory
- `OUTPUT_FORMAT = "markdown"` — `markdown` for review, `docx` for filing
- `REVIEWER_MODEL = configured reviewer` — Used via `LlmReview` for cross-model examiner review
- `MAX_REVISION_ROUNDS = 3` — Maximum revision iterations within a stage
- `REFERENCE_NUMERAL_PREFIX = 100` — First figure's components start at 100; FIG. 2 uses 200-series, etc.

## Shared References

Load `../shared-references/patent-writing-principles.md` for drafting principles, antecedent-basis rules, and common pitfalls.
Load the jurisdiction format file the stage needs: `../shared-references/patent-format-cn.md`, `patent-format-us.md`, or `patent-format-ep.md`.

## Key Rules (apply to every stage)

These are the rules that hold across the whole application. Stage files add
their own on top.

- **Claims are the point.** Everything else — specification, figures, abstract —
  exists to support and enable the claims. The specification supports the claims,
  never the other way around.
- **No empirical content anywhere in the application.** No experimental results,
  accuracy percentages, detection rates, precision values, response times, or
  comparative performance data. Those belong in papers. A patent teaches HOW to
  make and use, not HOW WELL it performs.
  - WRONG: "传感器对直径超过150μm的金属颗粒实现了100%的检测精度"
  - RIGHT: "当不锈钢颗粒通过间隙传感区域时，谐振频率下降。颗粒直径越大，频率偏移幅度越大。"
- **Consistent terminology is mandatory.** Same word for the same concept
  throughout. Same component, same reference numeral, everywhere.
- **Never fabricate.** No invented prior art references, patent numbers,
  citations, or embodiments that do not correspond to the actual invention or
  user-provided materials.
- **No subjective language.** Never "excellent", "surprising", "superior",
  "improved", "novel".
- **Utility model (实用新型)** applies ONLY to CN and ONLY to apparatus/device
  claims. No method claims, no product-by-process.
- **Never mix jurisdiction formats** — e.g. no "其特征在于" in US claims.
- **Drafts, not filings.** Output is for attorney review, not direct filing.
- **Large file handling**: if a `write_file` call fails on size, retry via
  `bash` with a `cat <<'EOF'` heredoc.
- If `LlmReview` is unavailable, skip the cross-model review step in that stage
  and say so in the output — never substitute your own judgement silently.
