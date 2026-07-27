# Literature Kernel Migration

## Decision

SomniQ treats literature retrieval, screening, evidence and downstream citation
grounding as one project-local, versioned capability. The runtime owns the data
contract and persistence. Tools own source adapters and canonicalisation. Chat,
Desktop and CLI invoke the same tools rather than keeping separate workflows.

The initial schema is stored at `.somniq/literature/literature.sqlite3`; raw
provider responses and normalized compatibility artifacts live beneath
`.somniq/literature/artifacts/`. All request metadata is sanitized: API keys,
cookies and authorization headers are never persisted.

## Contract

- `SearchProtocol` records the question, scope, time window, selected sources,
  complete per-source queries, eligibility criteria and known papers.
- `SearchRun` records a concrete execution, its source attempts, request shape,
  statuses, quotas, artifacts and resulting canonical record identifiers.
- `CanonicalRecord` preserves DOI, arXiv ID, Scopus ID, source identifiers,
  per-source field observations, detected conflicts, and provenance. A later
  adapter must not overwrite a user-resolved record.
- `ScreenDecision` and `EvidenceCard` are append-only evidence objects. Legacy
  UI state is never promoted to either object without an explicit review.

## Compatibility and rollback

`papers/library.json` remains a compatibility projection during migration, not
an independent database. On first access, a one-time importer snapshots the
old file as an artifact and carries its paper metadata into CanonicalRecords
without inventing historical protocol/review provenance. Thereafter,
`library_load` projects canonical records and SearchRuns back to JSON; every
legacy UI save first synchronizes into canonical metadata, then rewrites the
projection. A damaged projection is regenerated from SQLite.

The retired Desktop instant-search store path no longer calls
`literature_search → literature_library_upsert`; it directs users to the
protocol/preview/confirmed-execution surface so no visible UI search can omit
a `SearchRun` or its artifacts.

Canonical identity resolves DOI, arXiv ID, Scopus ID, and normalized title
through an alias table before a record is written. A title-only match is a
fallback, not a peer of a strong identifier: records with the same normalized
title but conflicting DOI, arXiv ID, or Scopus ID remain separate unless they
also share an exact strong identifier. Ambiguous title aliases are removed
rather than being claimed by the last writer.
Conflicting source fields, including strong identifiers when a separate shared
identifier establishes equivalence, are retained as append-only conflict
objects. SearchRun and CanonicalRecord writes use SQLite IMMEDIATE transactions
plus revisions, so an independent process receives a retryable conflict instead
of overwriting a newer payload.

## Skill registration

`runtime::skill_registry` owns the canonical workflow map. The
`research-lit`, `arxiv`, `scopus-search`, and `comm-lit-review` entry points
now resolve to the active `literature-search` compatibility profile. The
canonical `literature-screen` and `literature-evidence` workflows are active
for Desktop screening and evidence hand-off. Broader legacy workflows such as
`paper-batch-grading` remain independent instead of being silently narrowed to
the Desktop screening contract.

## Execution policy

The deliberate protocol workflow is split into protocol/preview and confirmed
execution. An explicit casual Chat `LiteratureSearch` is the bounded-search
exception: it automatically creates an ad-hoc `SearchProtocol` (using the
user's request as its question and the actual selected source queries) and
executes one `SearchRun`. It is therefore a workspace-write tool, not a
read-only metadata shortcut. Its output is already canonical and projected;
`LiteratureLibraryUpsert` may only refresh that projection for known canonical
ids and rejects raw/untracked papers.

Full export, Scopus view downgrade, rate-limit failures, unavailable sources
and coverage gaps become explicit `SourceAttempt` data. Full text acquisition
is a separate opt-in operation whose default collision policy is never
overwrite.

## M3 adapter contract

The tools crate owns one adapter boundary for `scopus`, `openalex`,
`semantic-scholar`, `crossref`, and `arxiv`. Every successful source attempt
persists a sanitized exact request, immutable provider response artifact(s),
normalized results, provider hit count, exposed rate-limit headers, and a
coverage note. Credentials, cookies and authorization headers are excluded.

The store checkpoints a run both before and after every source attempt. An
interrupted run can only resume its original protocol revision; completed
sources are skipped and interrupted ones are marked and retried. Final status
uses each source's latest attempt, not an obsolete failure from before resume.

Scopus begins with `view=COMPLETE`. A `401` or `403` response is retained as
an artifact, then triggers exactly one `view=STANDARD` retry. This downgrade
is explicit partial coverage. Result limits are bounded per source (currently
100); no full export happens implicitly.

## M5 Desktop contract

The Literature page is the main confirmation surface. It creates a
`SearchProtocol`, displays each source query plus coverage/quota caveats and
the per-source cap, and keeps execution disabled until the user explicitly
checks confirmation. It receives advisory source progress events and renders
the resulting `SearchRun` attempts plus a bounded metadata-only record sample.
That sample is explicitly not a screening decision or evidence card. Desktop
invokes the shared tools/runtime path with the active project root; it does not
implement providers itself.

## Redundancy disposition

The prior source-specific bridge flag and the independent Desktop provider path
are removed: legacy `LiteratureSearch` and the Desktop mail path now reuse the
same adapter functions as `literature-search`. The legacy JSON library remains
as the Desktop projection while search results are linked back to their
`SearchRun` ids. Screening uses stable 40-paper chunks, durable run/chunk
checkpoints, missing-index detection, and explicit heuristic fallback; evidence
remains a separate canonical hand-off. The JSON projection may be removed only
after all Desktop consumers read the canonical kernel directly.
