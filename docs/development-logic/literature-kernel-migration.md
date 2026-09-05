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
  complete per-source query variants, the versioned per-source result bound,
  eligibility criteria and known papers.
- `SearchRun` records a concrete execution, its source attempts, request shape,
  statuses, quotas, coverage state, artifacts, provider ranks and fused
  canonical record order.
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
coverage note. Coverage explicitly records `totalHits`, `fetched`, `unique`,
`exhausted`, `nextCursor`, and `truncatedReason`; an HTTP-successful first page
is not equivalent to complete retrieval. Credentials, cookies and authorization
headers are excluded.

The store checkpoints a run both before and after every source attempt. An
interrupted run can only resume its original protocol revision; completed
sources are skipped and interrupted ones are marked and retried. Final status
uses each source's latest attempt, not an obsolete failure from before resume.
A terminal partial run is continued as a new bounded run. The new run carries
the prior canonical record set, original provider ranks, and cumulative
coverage forward while requesting only unfinished query streams; exhausted
streams make no second request.

Adapters paginate within provider-specific bounds: Scopus, OpenAlex and
Crossref use cursors; Semantic Scholar uses bounded offsets; arXiv uses
`start`/`max_results` with provider-friendly pacing. Transient transport,
rate-limit, and 5xx failures receive bounded exponential backoff. Scopus
begins with `view=COMPLETE`. A `401` or `403` response is retained as
an artifact, then triggers exactly one `view=STANDARD` retry. This downgrade
is explicit partial coverage. The protocol's `maxResults` is a unique-record
retention bound, not a claim that the provider result set was exhausted. That
bound is distributed across the source's query variants, so one bounded page
does not fetch several full variant-sized result sets and then silently discard
the fused overflow.
Validated protocol time windows are translated to each provider's native date
filter. Query planning emits high-recall terms, precision supplements,
terminology/spelling aliases, and available language aliases. Scopus precision
queries join content terms explicitly and never force the whole research
question into one quoted phrase.

## M5 Desktop contract

The Literature page is the main confirmation surface. It creates a
`SearchProtocol`, displays each source query plus coverage/quota caveats and
the per-source cap, and keeps execution disabled until the user explicitly
checks confirmation. It receives live source progress events, renders each
attempt's coverage and failure/truncation state, and exposes continuation only
when a source is retryable or has a resumable cursor. It also shows a bounded
metadata-only record sample.
That sample is explicitly not a screening decision or evidence card. Desktop
invokes the shared tools/runtime path with the active project root; it does not
implement providers itself.

Local literature search executes indexed exact/AND, OR, and typo-tolerant FTS
strategies. Typo expansion is bounded by the FTS vocabulary instead of scanning
every stored document. Desktop requests one page at a time and exposes the
loaded/total count plus an explicit load-more action.

## Redundancy disposition

The prior source-specific bridge flag and the independent Desktop provider path
are removed: legacy `LiteratureSearch` and the Desktop mail path now reuse the
same adapter functions as `literature-search`. The legacy JSON library remains
as the Desktop projection while search results are linked back to their
`SearchRun` ids. Screening uses stable 40-paper chunks, durable run/chunk
checkpoints, missing-index detection, and explicit heuristic fallback; evidence
remains a separate canonical hand-off. The JSON projection may be removed only
after all Desktop consumers read the canonical kernel directly.

## M6 Zotero-style Library relationships

The Library relationship model is now normalized inside the same project-local
SQLite database. `canonical_records` owns bibliographic identity; the following
tables own Library relationships:

- `library_collections` and `library_collection_items` for the collection tree
  and item membership.
- `library_tags` and `library_item_tags` for reusable, case-insensitive tags.
- `library_attachments` for PDFs, supplements, web snapshots, and external
  links.
- `library_annotations` and `library_notes` for PDF anchors and researcher
  notes, with nullable links back to attachments, annotations, and evidence.

Schema version 4 performs an idempotent backfill from the old
`legacyLibrary` payload and projection metadata. The normalized rows are the
write-side source of truth. `papers/library.json` and the `legacyLibrary`
fields retained in canonical payloads are rebuildable compatibility caches.

New Desktop callers can use:

- `literature_library_relations` to read the normalized graph.
- `literature_update_collections` to replace the collection tree.
- `literature_update_relations` to update one item's relationships.

Each write is an IMMEDIATE SQLite transaction, records an audit event, refreshes
the compatibility cache/FTS row, and returns a regenerated projection. Duplicate
record merges remap collection links, tags, attachments, annotations, and notes
before removing the duplicate row. The current UI keeps the existing
`LiteratureLibrary` read shape for compatibility, while collection, tag,
attachment, annotation, and note actions now use the fine-grained relationship
commands. Workflow decisions, evidence, search runs, and Typeset artifacts
remain outside this relationship boundary.

## M7 Local Zotero-style item data plane (cloud sync deferred)

The next migration step makes the normalized Library graph the local source of
truth for item identity, hierarchy, metadata, and recoverable deletion. Schema
version 5 adds:

- library_items for stable item keys, item types, parent/child hierarchy,
  versioning, deletion, and Trash state.
- library_item_data, library_creators, library_item_creators, and
  library_item_relations for Zotero-style fields, creators, and generic item
  relations.
- library_saved_searches and library_saved_search_conditions for durable
  saved searches rather than UI-only filters.
- library_fulltext_items and library_attachment_full_text for local
  attachment/full-text indexing.

Attachments, notes, and annotations retain their original source payload while
participating in the normalized item tree. Notes and annotations may be
children of attachments. Moving an item to Trash is recoverable and cascades
through its child tree; restoring the parent restores the child subtree.
Collection trees reject self-references and cycles, while the Zotero JSON
export walks the complete visible descendant tree so attachment notes and
annotations round-trip with their normalized parent keys. The compatibility
projection also retains generic item relations and exposes an Unfiled view in
Desktop.
papers/library.json remains a rebuildable compatibility projection for
existing Desktop consumers.

The runtime exposes model reads, optimistic item updates with expectedVersion,
Trash/restore, saved-search updates, and Zotero JSON import/export. The Desktop
Library surface now exposes a local Trash view and restore actions. These
operations remain project-local and transactional, so Workflow, Evidence, and
Typeset boundaries are unchanged.

Cloud synchronization is intentionally deferred. This milestone does not add
remote library identifiers, credentials, upload/download queues, conflict
reconciliation, or remote permissions. Local keys, versions, audit events, and
source payloads are retained so a future sync adapter can be added without
changing the local Library model or the downstream research workflow.
