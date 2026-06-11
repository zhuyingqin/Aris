---
name: openalex-search
description: Build reproducible OpenAlex works search strategies and export complete result metadata. Use when Codex needs to design, compare, refine, or run OpenAlex literature search queries; download all works matched by every search expression; save titles, abstracts, DOIs, authors, venues, years, citation counts, OpenAlex IDs, topics, and raw JSONL/CSV outputs for reviews, novelty checks, related work, or paper metadata collection.
---

# OpenAlex Search

## Workflow

1. Translate the user's research topic into several explicit OpenAlex works queries.
2. Prefer transparent query groups: core terms, method terms, application terms, exclusions, and year/type/language filters.
3. Create a query-plan JSON file with one named query per search expression.
4. Run `scripts/openalex_works_export.py` for a dry run first when the query breadth is uncertain.
5. Run the full export so every query expression is paged completely with cursor pagination.
6. Inspect `query_counts.csv`, per-query CSV/JSONL files, and `all_results_deduped.csv` before summarizing coverage or deciding the final search formula.

## Query Plan

Use JSON so the exact search strategy is reproducible:

```json
{
  "project": "ntn-congestion-control",
  "description": "OpenAlex search strategy for NTN congestion control papers",
  "shared": {
    "filter": "from_publication_date:2020-01-01,to_publication_date:2026-04-26,type:article",
    "sort": "relevance_score:desc"
  },
  "queries": [
    {
      "name": "ntn_congestion_control",
      "search": "\"non-terrestrial network\" \"congestion control\""
    },
    {
      "name": "satellite_tcp",
      "search": "satellite network TCP congestion control"
    }
  ]
}
```

Rules:

- Put common date/type/language constraints in `shared.filter`.
- Put query-specific constraints in each query's `filter`; the script joins shared and query filters with a comma.
- Use `search` for broad relevance search across works.
- Use raw OpenAlex filter syntax when precision matters, for example `title_and_abstract.search:semantic communication`.
- Give every query a stable lowercase `name`; it becomes the output filename and the query label in CSV rows.

## Export Script

Run from any working directory:

```bash
OPENALEX_EXPORT=""
if [ -n "${CLAUDE_SKILL_DIR:-}" ] && [ -f "$CLAUDE_SKILL_DIR/scripts/openalex_works_export.py" ]; then
  OPENALEX_EXPORT="$CLAUDE_SKILL_DIR/scripts/openalex_works_export.py"
fi
if [ -z "$OPENALEX_EXPORT" ] && [ -n "${ARIS_CACHE_DIR:-}" ] && [ -f "$ARIS_CACHE_DIR/skills/openalex-search/scripts/openalex_works_export.py" ]; then
  OPENALEX_EXPORT="$ARIS_CACHE_DIR/skills/openalex-search/scripts/openalex_works_export.py"
fi
if [ -z "$OPENALEX_EXPORT" ]; then
  cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" || exit 1
  if [ -z "${ARIS_REPO:-}" ] && [ -f .aris/installed-skills.txt ]; then
    ARIS_REPO=$(awk -F'\t' '$1=="repo_root"{print $2; exit}' .aris/installed-skills.txt 2>/dev/null) || true
  fi
  OPENALEX_EXPORT=".aris/skills/openalex-search/scripts/openalex_works_export.py"
  [ -f "$OPENALEX_EXPORT" ] || OPENALEX_EXPORT="skills/openalex-search/scripts/openalex_works_export.py"
  [ -f "$OPENALEX_EXPORT" ] || { [ -n "${ARIS_REPO:-}" ] && OPENALEX_EXPORT="$ARIS_REPO/skills/openalex-search/scripts/openalex_works_export.py"; }
  [ -f "$OPENALEX_EXPORT" ] || OPENALEX_EXPORT=""
fi
[ -z "$OPENALEX_EXPORT" ] && { echo "ERROR: openalex_works_export.py not resolved (tried CLAUDE_SKILL_DIR, ARIS_CACHE_DIR, .aris/skills, skills/, and ARIS_REPO)." >&2; exit 1; }

python "$OPENALEX_EXPORT" \
  --queries openalex_queries.json \
  --out data/openalex/ntn-congestion-control \
  --dry-run
```

Then run the complete export:

```bash
python "$OPENALEX_EXPORT" \
  --queries openalex_queries.json \
  --out data/openalex/ntn-congestion-control
```

The script writes:

- `manifest.json`: run metadata, exact query parameters, timestamps, and counts.
- `query_counts.csv`: one row per query expression.
- `queries/<name>.csv`: flattened metadata for each query.
- `queries/<name>_title_abstract.csv`: compact per-query title/abstract table.
- `queries/<name>.jsonl`: raw OpenAlex work records with query labels.
- `all_results_deduped.csv`: deduplicated works across all queries.
- `all_title_abstract_deduped.csv`: compact deduplicated title/abstract table.
- `all_results_deduped.jsonl`: deduplicated raw records with `matched_queries`.

Use `OPENALEX_API_KEY` or `--api-key` when available. Use `OPENALEX_MAILTO` or `--mailto` for contact metadata. For very broad queries, keep the dry-run counts in the final summary before running the full export.

## Review And Refinement

After export:

1. Check `query_counts.csv` for overly broad or empty queries.
2. Sample titles/abstracts from the per-query CSV files.
3. Tighten noisy queries with title/abstract filters, type filters, date ranges, or exclusions.
4. Re-run the full export after every material query change so downloaded metadata always matches the current search strategy.

## References

Read `references/openalex-api.md` when changing API parameters, adding filters, or diagnosing OpenAlex pagination/authentication errors.
