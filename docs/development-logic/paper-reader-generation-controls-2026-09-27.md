# Paper guide generation controls

The reading panel exposes regeneration even when the guide is complete. Regeneration prepares a fresh run ID with the selected Chat model, rereads the whole PDF and generates a new guide. Previous runs and original evidence remain stored. The prepare request defaults to cache reuse for existing callers; explicit regeneration bypasses that cache. Continuing a saved run supplies its ID so a regenerated version resumes itself rather than falling back to the original cached version. The backend checks the requested paper, PDF hash/path, model, executor configuration and language before resuming that ID.

The panel has a Close guide action. PDF toolbar's Paper guide toggle reopens it. Hiding keeps the component and task subscription mounted, preserves reading state and does not cancel generation. The hidden panel relinquishes the web-reading layout so the PDF returns to view. Cancel remains a separate task action. Regeneration is disabled while a task is active.

Tests cover fresh generation from a completed guide, continuation by saved run ID, and hiding/reopening without cancellation or refetch. Existing PDF reader tests cover surrounding reader behavior. No release build or EXE packaging was requested.
