# LaTeX compilation time budget

LaTeX builds use a 600,000 ms (10 minute) default, shared by Desktop and the
`LaTeXCompile` tool. The former default inherited the generic 120,000 ms shell
timeout, so a large first build could be stopped during normal multi-pass TeX or
bibliography processing. Generic shell timeouts remain independent.

The tool's explicit positive `timeoutMs` takes precedence over the positive
`SOMNIQ_LATEX_COMPILE_TIMEOUT_MS` environment override, then the default applies.
Desktop uses this same resolver. The compile options menu beside **Recompile**
includes **Maximum compile time (minutes)**. Apply a positive whole number to
override the budget for subsequent builds, or choose **Use app default** to
return to the environment/default resolver. The preference is stored locally
per project and restored on restart and project changes. Invalid or unapplied
input does not change it. The page converts minutes to milliseconds and passes
`timeoutMs` through the native command to the shared compiler for manual,
save-triggered and cache-clearing builds. An active build keeps its original
budget. There is no separate two-minute hard cap.

All engine passes, engine fallback, and stale-cache retries consume a single
elapsed-time budget. A timeout or cancellation cannot trigger a cache retry.
Managed execution still terminates the compiler process tree and preserves its
captured log. Process shutdown and log draining can add a small amount of time
after the budget expires.

When no concrete source error was reported, diagnostics distinguish timeout,
cancellation, and other unlocated failure. Generated-file notices for `.toc`,
`.lof`, `.lot`, or `.bbl` do not identify a source error. The log UI and agent
recovery inspect the process/log before suggesting source edits, including for
older persisted `compile_failed` results. A concrete TeX error retains its
location and minimal-edit guidance even if the process later times out.

A managed timeout also sets `interrupted`; Desktop treats `timedOut` as a failed
build so the diagnostic log opens instead of hiding it as a user cancellation.
These process failures do not count as source-repair attempts.
