---
name: literature-screen
description: Screen a saved SomniQ literature SearchRun in durable 40-paper Reviewer batches with explicit scope, checkpoints, coverage, and human confirmation.
argument-hint: [review-question]
allowed-tools: read_file
---

# Literature Screen

Screen the active project's canonical literature library for: **$ARGUMENTS**.

This is the canonical screening workflow exposed by the Desktop Literature
surface. It consumes papers linked to a saved SearchRun and persists a
`ScreenRun` manifest in the compatibility library while canonical screening
objects continue their kernel migration. Never edit `papers/library.json`
directly and never describe heuristic fallback as Reviewer coverage.

## Required sequence

1. Open the active project's Literature page and choose **New review task**.
2. Enter the review question and explicitly choose either one saved SearchRun
   or the whole project library. Do not infer scope from matching query text.
3. Review the inclusion/exclusion criteria before starting screening.
4. Run title/abstract screening. The Desktop splits candidates into stable
   chunks of at most 40 papers and checkpoints before and after every chunk.
5. Inspect the persisted `ScreenRun`: every chunk must report its paper ids,
   expected count, Reviewer count, heuristic fallback count, missing indices,
   status, and any error.
6. Human-confirm or revise boundary decisions before using them downstream.

## Integrity rules

- Preserve paper ids and chunk order; never renumber between retries.
- A chunk is complete only when every expected index has one usable decision.
- Partial model output is `partial`, not complete. Missing rows may use the
  explicit heuristic fallback, but the fallback count must remain visible.
- Reviewer quotes must be verified against the supplied abstract; otherwise
  use a deterministic abstract excerpt and mark the decision truthfully.
- Criteria changes create a new screening run; old decisions are historical
  evidence and must not be silently rewritten.

## Profiles

- `--profile title-abstract`: default bounded screening from canonical metadata.
- `--profile full-text`: only after PDFs are present and page-level evidence is
  available; never treat abstract-only judgments as full-text screening.

