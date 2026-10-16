---
name: literature-search
description: Design a reproducible literature search strategy, preview its compiled per-source queries, and run it as a project-local SearchProtocol and SearchRun with a known-paper recall check. Use for structured scholarly retrieval, systematic search planning, or when traceable query/source history is required.
argument-hint: [research-question]
allowed-tools: read_file, LiteratureSearchPreview, LiteratureSearch, LiteratureCitations, LiteraturePdfDownload
---

# Literature Search

Build a reproducible local search record for: **$ARGUMENTS**.

This is the canonical retrieval workflow. Every `LiteratureSearch` call saves a
`SearchProtocol` (the strategy) and a `SearchRun` (its execution: requests,
normalized records, failures, artifacts) under the active project's
`.somniq/literature/` directory. Do not substitute ad-hoc web search results
for a SearchRun when the user requests a traceable literature search.

## Required sequence

1. Design the strategy before searching:
   - the question (English academic terms), scope and time window;
   - concept blocks written once as `booleanQuery` — synonyms joined by `OR`
     inside a block, blocks joined by `AND`, exclusions as `AND NOT`, e.g.
     `([continual learning] OR [lifelong learning]) AND ([time series] OR [time-series]) AND [anomaly detection]`;
   - a `queries` entry only for a source that needs exact provider syntax
     (it overrides `booleanQuery` for that source and is sent verbatim);
   - explicit `inclusionCriteria` / `exclusionCriteria`;
   - `knownKeyPapers` (DOI, arXiv id or exact title) — ask the user for two
     to five papers they already know belong in the result.
2. Call `LiteratureSearchPreview` with `search` set to exactly those
   arguments. It opens no connection and saves nothing.
3. Present the preview to the user: each source's compiled query streams,
   available/unavailable adapters, the per-source cap, any saturation or
   snowball bounds, coverage gaps, and Scopus permission or quota caveats.
4. Only after the user explicitly confirms that scope, call `LiteratureSearch`
   with the same arguments.
5. Report the `SearchRun` status and per-source attempts, and the
   `knownPaperRecall` block. State failures, partial coverage and unavailable
   adapters plainly.
6. If a known key paper was missed, revise the strategy (compare the missed
   paper's wording with the query terms; `inLibrary` means the paper is
   reachable and only the query missed it), preview again, and rerun. Record
   any miss you decide to accept, with the reason.

Never run a systematic search in the same turn as its design unless the user
has already explicitly confirmed that exact strategy and scope. Never treat a
login wall, unavailable adapter, or a partial run as complete coverage.

## Coverage

- A single page (`coverage` omitted) is a bounded sample: each source returns
  at most `maxResults` records. A result with `continuation.continueRunId`
  has more; repeat the same `query` with that `continueRunId` to fetch the
  next page.
- `coverage: "saturate"` pages every unexhausted source until a page adds
  under 10% new records (at most 5 pages). Report its `stopReason`:
  `low_yield` is saturation of new material, not an exhausted index.
- `snowball` follows citations one hop from explicit seeds, the known key
  papers, and the best-ranked results. Its records are mostly off-topic and
  must be screened; report them separately from the keyword results.
- Saturation and snowball can fetch several hundred records. Preview and get
  explicit confirmation of that scope first.

## Source support and auditability

The unified adapters support `scopus`, `openalex`, `semantic-scholar`,
`crossref`, and `arxiv`. `booleanQuery` is compiled into each source's own
syntax; Crossref and Semantic Scholar parse no boolean syntax and receive a
few keyword streams that rotate through each concept's synonyms, with any
`NOT` clause named as unsent. Each successful attempt records the sanitised
exact request, immutable provider response artifact(s), normalized results,
provider hit count, and rate-limit headers when exposed. Never place keys,
cookies, or authorization values in a strategy, query, or explanation.

Scopus starts with `COMPLETE`; only a `401`/`403` entitlement response can
trigger one `STANDARD` retry, and the downgraded coverage remains visible in
the `SearchRun`. The default is bounded retrieval, not implicit full export.

## Profiles

- `--profile default`: canonical replacement for `research-lit`. Complete the
  traceable retrieval first, then hand the stored SearchRun to
  `literature-screen` and `literature-evidence`; do not mix untracked web
  candidates into the canonical library.
- `--profile communications`: favor concept-block synonyms for IEEE/ACM venue
  terms, communications, networking, wireless, satellite, and transport
  terminology. It is a query strategy, not a parallel workflow.
- `--profile arxiv`: restrict `sources` to `arxiv`. PDF download remains a
  separate, explicit action and must use `LiteraturePdfDownload`; never
  overwrite an existing file.
- `--profile scopus`: restrict `sources` to `scopus`, or give a `queries.scopus`
  string in Scopus syntax. Preview the scope before running; COMPLETE-to-
  STANDARD downgrade and coverage gaps must be reported.

## Output discipline

After a successful run, cite records by their canonical identifiers and direct
downstream screening to the stored run. Do not create screening decisions,
evidence cards, novelty claims, or full-text downloads during this workflow
unless the user separately asks for them.
