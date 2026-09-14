# Working context projection and large tool-output artifacts

The model-visible transcript is a bounded working projection. It is not the sole copy of tool evidence.

## Large-output path

Completed textual tool output is handled in this order:

1. Classify the tool outcome and let retrieval/post-tool guards inspect the complete result.
2. Feed the pristine result to the Evidence Ledger.
3. If the result exceeds its context-relative threshold, persist the complete UTF-8 text under `.somniq/tmp/tool-output` using a content hash in the file name.
4. Put only a bounded head/tail preview, absolute local path, byte/character counts, SHA-256, and selective-read guidance into the transcript.

The default artifact threshold is capped at 32,000 characters. Smaller configured context budgets lower it to approximately 5% of the budget, with an 8,000-character floor. Artifact-backed previews are capped at the smaller of 12,000 characters and the active artifact threshold.

Existing Desktop-specific Shell, LaTeX, literature, and Playwright compactors remain useful because they preserve domain-specific diagnostics. When those compactors already produced a `persistedOutputPath`, the shared runtime reuses that artifact rather than writing a second copy.

Artifact persistence is best effort. A filesystem failure falls back to the existing 64,000-character safety bound rather than failing the user's tool call.

## Working context projection

The authoritative pinned projection carries the bounded state needed to continue work:

- current and carried user requests;
- active focus and latest assistant decision;
- todo state and unresolved errors;
- dead ends and main-line focus signals;
- Evidence Ledger aggregates;
- recent materialized files;
- up to eight recent large-output artifact references.

Fallback summaries also render artifact references in a dedicated `Artifact References` section. This keeps the address of complete evidence available after compaction without reinserting the evidence body into every model request.

## Invariants

- Raw artifact contents are project-local and are not added to prompts automatically.
- A reference never bypasses normal file-read permissions.
- Evidence novelty is computed from pristine output when a wrapper supplies it, not from the shortened preview.
- Image media remains on the existing media path and is not duplicated as a text artifact.
- Debug export discovers `persistedOutputPath`/`rawOutputPath` and includes the referenced files in `tool-output/`.
