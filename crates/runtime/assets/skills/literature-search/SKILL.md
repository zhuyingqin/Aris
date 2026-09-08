---
name: literature-search
description: Design a reproducible literature protocol, preview its source coverage, and run a confirmed project-local SearchRun. Use for structured scholarly retrieval, systematic search planning, or when traceable query/source history is required.
argument-hint: [research-question]
allowed-tools: read_file, LiteratureSearchProtocolCreate, LiteratureSearchPreview, LiteratureSearchExecute, LiteraturePdfDownload
---

# Literature Search

Build a reproducible local search record for: **$ARGUMENTS**.

This is the canonical retrieval workflow. It stores `SearchProtocol`,
`SearchRun`, normalized records, failures, and artifacts under the active
project's `.somniq/literature/` directory. Do not substitute ad-hoc web search
results for a SearchRun when the user requests a traceable literature search.

## Required sequence

1. Design a `SearchProtocol` before searching. Include:
   - the question, scope and time window;
   - requested databases;
   - complete query per database in `queries`;
   - explicit inclusion/exclusion criteria; and
   - known key papers supplied by the user.
2. Call `LiteratureSearchProtocolCreate` with that protocol.
3. Call `LiteratureSearchPreview` with the returned `protocolId`.
4. Present the preview to the user: exact queries, available/unavailable
   adapters, requested result cap, coverage gaps and any Scopus permission or
   quota caveats.
5. Only after the user explicitly confirms the displayed scope, call
   `LiteratureSearchExecute` with `confirmation: "execute"`.
6. Report the resulting `SearchRun` status and its per-source attempts. State
   failures, partial coverage and unavailable adapters plainly.

Never run `LiteratureSearchExecute` in the same turn as protocol design unless
the user has already explicitly confirmed that exact protocol and result scope.
Never treat a login wall, unavailable adapter, or a partial run as complete
coverage.

## Source support and auditability

The unified adapters support `scopus`, `openalex`, `semantic-scholar`,
`crossref`, and `arxiv`. Each successful attempt records the sanitised exact
request, immutable provider response artifact(s), normalized results, provider
hit count, and rate-limit headers when exposed. Never place keys, cookies, or
authorization values in a protocol, query, or explanation.

Scopus starts with `COMPLETE`; only a `401`/`403` entitlement response can
trigger one `STANDARD` retry, and the downgraded coverage remains visible in
the `SearchRun`. The default is bounded retrieval, not implicit full export.
If an interrupted run is returned or surfaced by Desktop, resume only with its
same `runId` and original protocol revision.

## Profiles

- `--profile default`: canonical replacement for `research-lit`. Complete the
  traceable retrieval first, then hand the stored SearchRun to
  `literature-screen` and `literature-evidence`; do not mix untracked web
  candidates into the canonical library.
- `--profile communications`: favor query variants for IEEE/ACM venue terms,
  communications, networking, wireless, satellite, and transport terminology.
  It is a query strategy, not a parallel workflow.
- `--profile arxiv`: constrain the protocol to the `arxiv` source and record
  its query explicitly. PDF download remains a separate, explicit action and
  must use `LiteraturePdfDownload`; never overwrite an existing file.
- `--profile scopus`: use Scopus syntax in the Scopus query. Preview the scope
  before running; COMPLETE-to-STANDARD downgrade and coverage gaps must be
  reported by the Scopus adapter.

## Output discipline

After a successful run, cite records by their canonical identifiers and direct
downstream screening to the stored run. Do not create screening decisions,
evidence cards, novelty claims, or full-text downloads during this workflow
unless the user separately asks for them.
