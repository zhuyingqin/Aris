---
name: literature-evidence
description: Turn human-confirmed literature screening results into page-grounded briefs, evidence notes, and answer chains in the SomniQ Literature workspace.
argument-hint: [evidence-question]
allowed-tools: read_file
---

# Literature Evidence

Build evidence for: **$ARGUMENTS**.

This is the canonical evidence workflow exposed by the Desktop Literature
reader. It starts from human-confirmed screening decisions, not raw search
results or unreviewed metadata samples.

## Required sequence

1. Select papers accepted by a completed or explicitly partial `ScreenRun`.
2. Acquire the PDF through the opt-in Literature download/import surface.
3. Extract or visually read the relevant pages. Every factual brief section
   must retain a valid page number and a verbatim supporting quote.
4. Save evidence notes and question-to-answer chains without deleting their
   source annotations.
5. Human-review the final answer chain before it supports writing or claims.

## Integrity rules

- Search metadata is not evidence.
- Abstract evidence must stay labelled as abstract-only.
- A page quote must occur on the cited page; otherwise reject the generated
  section instead of fabricating an anchor.
- Keep source paper id, PDF path/version, page and annotation linkage visible.
- Never promote an unconfirmed screening suggestion into final evidence.

## Profiles

- `--profile review`: paper-by-paper grounded reading.
- `--profile domain-map`: aggregate only human-confirmed evidence cards.
- `--profile wiki`: publish confirmed summaries without severing provenance.

