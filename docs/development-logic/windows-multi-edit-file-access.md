# Windows multi_edit access failures

`multi_edit` validates every ordered replacement in memory and publishes one
atomic file replacement. A readable Windows handle may allow source reads but
deny `FILE_SHARE_DELETE`, preventing the rename used to publish that replacement.
The previous retry window was 315 ms. A handle held for 600 ms reproduced the
reported `Access denied (os error 5)` on Windows.

The shared atomic writer now waits at most 2.065 seconds across replacement
retries. It continues to use a sibling temporary file, sync, and atomic rename;
it does not fall back to truncating the live source or removing read-only
attributes. Failed writes remove their temporary file through `NamedTempFile`.

Filesystem errors report `atomic_write_failed`, the target path, original OS
error code, and the failing stage: `create_parent`, `create_temporary`,
`write_temporary`, `sync_temporary`, or `replace_destination`. The wrapped
`io::Error` preserves its kind and source. Its own `raw_os_error()` is not the
underlying OS code; consumers should use the diagnostic or error source.

`multi_edit` checks the revision of the source it read before every replacement
attempt, including retries. A change while waiting for an external handle
rejects the stale batch. This narrows the race with external writers; the
process-local lock and read-before-rename check are not a cross-process
compare-and-swap guarantee.

Audit recording occurs after source publication and outside the source lock.
Ledger and blob paths use the same striped lock pool, so holding the source lock
across audit could deadlock. Audit failure reports `multi_edit_audit_failed`,
`published: true`, `auditState: unconfirmed`, the observed source state, and its
current revision. It does not silently imply that the source remained unchanged.
Automatic source rollback is unsafe here: audit append may have partly or fully
written before returning an error, and an external editor may write while a
rollback waits to rename. Recovery requires inspecting the source and ledger,
repairing storage, and rebuilding any edit against a fresh source read.

The broader file-tool regression suite also reproduced a `write_files`
self-deadlock: publication held source stripes while audit attempted to acquire
one of those same stripes. In the captured workspace `new.txt` and
`.somniq/changes/local/ledger.jsonl` both hashed to stripe 74. Both target files
had been published; the first audit blob existed and ledger append could never
obtain its lock. Multi-file publication and its recovery journal now complete
under source locks, then audit runs after those locks are released. Audit errors
must distinguish published files from confirmed audit records. The collision
probe and captured stalled-test output are saved alongside the other evidence.

Multi-file publication and failure rollback also recheck the relevant source
revision before each replacement attempt. If a later save prevents safe
rollback, its content is preserved and the recovery journal remains for
inspection. Recovery rejects a journal whose target no longer matches either
recorded revision. This protects later saves in the tested waiting interval;
it shares the read-before-rename cross-process limitation described above.

## Reported case

The pasted request was valid, and its expected SHA256 still matched the actual
`Defense/main.tex` during read-only diagnosis. The old frame remained and the
requested replacement was absent, so that particular failure did not publish
the source edit. The source had no read-only attribute and resided on exFAT.
The historical bare error cannot identify the handle owner or filesystem stage;
the reproduced Windows handle conflict is a supported cause, not proof of the
original cause. All mutation tests use disposable workspaces; the user's source
document is not modified by this repair.

Test results and before/after logs are kept in
`output/multi-edit-access-fix-20261031/`.
