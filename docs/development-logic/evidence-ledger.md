# Evidence Ledger and no-new-evidence loop guard

The Evidence Ledger measures whether completed tool calls add a distinct observation. It does not decide whether evidence is true, relevant, or sufficient; those judgments remain with the Executor and the independent Reviewer.

## Runtime behavior

- The ledger is scoped to one user turn and reconstructed from stored tool-use/tool-result pairs when compaction needs durable working state.
- Each result receives a deterministic fingerprint. JSON object keys are canonicalized, and volatile timing, request, trace, and heartbeat fields are excluded so an unchanged status does not appear novel merely because time passed.
- Empty results and previously seen fingerprints extend the no-new-evidence streak. A distinct fingerprint resets it.
- After 4 consecutive calls without new evidence, the runtime adds an internal strategy-change note to the tool result.
- In the default `block` mode, a call is rejected before execution after 6 consecutive calls without new evidence, but only if the exact tool/input pair and its outcome have each repeated at least 3 times. Polling/status tools use a doubled hard threshold.
- A different source, target, query, or mechanism remains available, even while the streak is active.

The synthetic rejection has reason `no_new_evidence_loop`. It does not itself count as new evidence or extend the ledger.

## Rollout and diagnostics

Set `ARIS_EVIDENCE_LOOP_GUARD` to:

- `block` (default): emit observations and nudges, and reject proven repeat loops.
- `nudge`: emit observations and nudges without blocking execution.
- `off`: disable observation, nudging, and blocking.

Desktop wire traces contain a turn-level `tool.evidence_guard` configuration event and metadata-only `tool.evidence` events. The latter include novelty, a short fingerprint, streak length, unique count, and total observation count; raw tool output is not duplicated into the event.

Fallback compaction summaries and pinned working context carry aggregate ledger facts so a restored session does not lose the fact that recent work was repeating rather than progressing.

## Safety boundaries

- Permission checks and the existing Executor/Reviewer separation are unchanged.
- A new result always clears the no-new-evidence streak.
- Parallel calls are judged from completed results; calls already dispatched in the same group are not retroactively cancelled.
- Long-running tool timeout policy is separate from evidence-loop detection. A slow call is not treated as a repeated result until it completes.
