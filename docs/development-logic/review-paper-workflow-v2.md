# Review Paper Workflow v2

## Purpose

`review-paper-from-topic` turns a broad topic into an auditable review-paper
knowledge base. It does not treat prompts as progress. A stage advances only
after its required records, coverage state, deterministic checks, and
independent Reviewer gate are complete.

## Current release boundary

The current desktop release implements the workflow through Stage 12 (paper-to-
section mapping). Zotero tag, collection, and external-library restructuring is
not part of this workflow version. Stages 13–16 (evidence synthesis,
manuscript, independent review, and submission package) remain explicit
read-only planning stages until their Executor/Reviewer/revision loops are
implemented.

The durable controller may still describe those stages so that the project
template remains forward-compatible; reaching one of them stops with an
explicit user-facing “not implemented” state rather than reporting success.

## Workflow

The Desktop presents stages 1–5 as one user-facing step, **Review
reconnaissance and direction discovery**. The five internal stages remain
durable checkpoints so retrieval, review, revision, and evidence provenance
stay auditable.

1. **Scope and review-landscape plan**
   - Generate source-specific `broader`, `base`, and `stricter` queries.
   - Add phrase, synonym, spelling, and language variants when useful.
   - Require independent review and explicit user approval before networking.
   - That one approval authorizes the bounded recent-review reconnaissance
     loop; the user is not asked to confirm the same external retrieval again.
2. **Recent-review retrieval**
   - Retrieve the current calendar year plus the previous four years by
     default.
   - Persist `totalHits`, `fetched`, `unique`, `exhausted`, `nextCursor`,
     `truncatedReason`, failures, and source attempts.
   - Continue valid cursors automatically. Source, authentication, or
     infrastructure failures pause the loop instead of retrying forever.
   - Before eligibility screening, an independent Reviewer inspects a bounded
     title/abstract sample, source coverage, and retrieval counts. Rejection
     feeds issues back into the Executor's next query revision.
3. **True-review eligibility**
   - Batch title/abstract metadata through the independent Reviewer.
   - A raw search result never counts as a review until eligibility is
     complete.
4. **Coverage and count branch**
   - `< 10`: invalidate retrieval-dependent outputs and return to query
     planning with a recorded revision reason; regenerate, review, and rerun
     automatically up to the persisted revision limit (four by default).
   - `10–49`: analyze reviews directly.
   - `>= 50`: cluster the review landscape before gap analysis.
5. **Landscape and direction selection**
   - Produce development status, problems, temporal trends, topic evolution,
     gaps, and three to five feasible candidate directions.
   - The user explicitly selects the direction that changes downstream scope.
   - Automation stops here and waits for the user's direction choice.
6. **Matrix Scopus strategy**
   - Decompose the direction into A (context), B (subject), and C (concrete
     process).
   - Generate complete A+B+C, B+A, B+C, and A+C queries.
   - Validate parentheses, Boolean operators, `TITLE-ABS-KEY`, and placeholder
     absence before independent review.
7. **Query-quality feedback loop**
   - The protocol requests Scopus `sort=-coverDate` for the 100-record pilot.
   - Batch-classify relevance, explain false-positive causes, and recommend
     concept, proximity, or `NOT TITLE` adjustments.
   - Roughly 50% title/abstract relevance is the minimum continuation signal.
8. **Primary-study library**
   - Version `maxResults` in the previewed protocol.
   - The user-entered `maxResults` is a hard external-retrieval budget. The
     Executor allocates it across the four matrix paths, and those allocations
     must sum exactly to the approved total; the workflow must not multiply the
     requested count to create a hidden oversampling plan.
   - Every record keeps its path attribution in the search run (`variantRanks`),
     so a quota cannot be silently diluted by reciprocal-rank fusion: a record
     belongs to each path that returned it, and the responsible stream controls
     whether it is admitted.
   - On continuation, a path that has spent its allocation is **retired** in
     the kernel: it contributes no further provider request while other paths
     continue their cursors.
   - Stage 8 performs only binary relevance screening: retain every record with
     any plausible core, indirect, contextual, methodological, or baseline
     value, and exclude only records that are completely unrelated. It does not
     assign A/B/C/D grades or extract writing evidence.
   - The corpus (`primaryRecordIds`) is written only after this screening, not
     by the raw result slice.
9. **A/B/C/D grading**
   - Grade the screened primary library for the first time as A/B/C/D and
     extract one to two key findings per record for downstream writing.
   - A/B grades feed evidence clustering and section mapping; C/D remain in the
     audit trail. This stage must not repeat Stage 8's admission decision.
   - Preserve original order.
   - Save one to two sentences of useful information for every record.
10. **Outline and section mapping**
    - Build the outline from batch-level evidence digests.
    - Review every A/B-grade paper for a direct and optional indirect `x.x` section.
    - Retain only records assigned at least one section in the mapping artifact.
    - Keep C/D grades in the audit trail, but do not send them to section mapping.
The evidence-synthesis, manuscript, independent-review, and submission-package
stages are the downstream publication pipeline and are currently read-only.

## Review-writing requirements and outline policy

The workflow does not treat a fixed chapter count as a reporting standard. The
normal recommendation is a compact **6–8 top-level chapter** outline, with **7
chapters as the default**; this is not a validation limit. The canonical
arrangement is:

1. Introduction
2. Review methodology
3. Taxonomy and the main body of methods
4. Benchmarks, datasets, and metrics
5. Cross-study comparison, disagreements, and synthesis
6. Challenges and future directions
7. Conclusion

The last two pairs are deliberately mergeable: splitting “challenges” from
“future directions”, or splitting “taxonomy” from the method body, only to reach
an arbitrary count makes the review harder to read. An additional body chapter
is allowed only when the evidence digests justify it.

The non-negotiable constraint is **coverage**, not chapter arithmetic. The
methodology chapter must make the search reproducible: complete search strings,
every database/source, search and publication date range, inclusion and
exclusion criteria, screening flow, and real final counts. The outline generator
receives those counts from the ledger and is forbidden to invent them. The
comparison chapter must synthesize common dimensions and disagreements rather
than list papers one by one. The benchmark chapter must report benchmarks,
datasets, and metrics, including an explicit statement when no common benchmark
exists. Every future direction must be paired with a documented challenge,
evidence gap, or testable research question.

This is aligned with reporting guidance rather than a fabricated table-of-
contents rule: PRISMA 2020 requires transparent eligibility criteria,
information sources and search dates, and full search strategies; PRISMA-ScR
applies the same transparency to scoping reviews; SANRA assesses narrative
reviews on rationale/aims, literature-search description, referencing,
scientific reasoning, and relevant endpoint data. None of these guidelines
requires eight, nine, ten, or eleven top-level chapters.

References: [PRISMA 2020 checklist](https://www.prisma-statement.org/prisma-2020-checklist),
[PRISMA-ScR](https://www.prisma-statement.org/scoping), and
[SANRA](https://link.springer.com/article/10.1186/s41073-019-0064-8).

## Context policy

The workflow stores record IDs and compact structured decisions, not a full
copy of every abstract or PDF:

- 20 abstracts per model batch
- at most 2,400 characters per abstract
- at most 60,000 characters of batch digests in a synthesis request
- full text retrieved by relevant section on demand

The limits are persisted per run so they can later become model-aware without
changing the evidence contract.

## Invariants

- Incomplete coverage cannot be reported as complete.
- Review-count branching uses eligible recent reviews, never raw unique hits.
- A required stage cannot pass before its independent Reviewer approves it.
- Executor query generation and retrieval-quality review remain separate model
  roles; automation never collapses the independent-review loop.
- Every internal reconnaissance checkpoint is persisted before the controller
  advances, so app restart resumes from durable state instead of replaying
  completed model work.
- Pilot date ordering is part of the versioned protocol and provider request.
- Re-running an upstream stage invalidates all dependent stages and outputs.
- Paper grades must be one-to-one with the current primary library; mapping
  entries must uniquely reference A/B grades and assign at least one section.
- Workflow updates use optimistic revisions and atomic project-local writes.
