//! Did the work a tool did actually succeed?
//!
//! Execution tools do not fail the *call* when the *work* fails. A non-zero
//! exit, a raised cell, a timed-out kernel are all successful invocations that
//! return a payload describing a failure, so `Result::Ok` from a tool says
//! nothing about whether anything worked. Every consumer that reasons about
//! failure — [`crate::focus_trace`]'s repeat counter, the dead ends
//! [`crate::compact`] pins through a compaction, the desktop's error badge —
//! reads one flag, and this is where that flag is decided.
//!
//! It deliberately lives below the surfaces rather than in one of them: the
//! same shell command run from desktop Chat, from a sub-agent, or from any
//! shell added later has to be judged identically, and a tool whose failures
//! are not recognized here is invisible to all of them at once.
//!
//! Classification reads the payload and never rewrites it. Turning the failure
//! into an error *message* instead would drop stdout, which is frequently where
//! the diagnostic actually is, and would bypass the large-output persistence and
//! tool-specific compaction that run on the success path.

/// Whether a tool that returned `Ok` reported failed work in its payload.
///
/// An allow-list rather than a heuristic over arbitrary text: "error" appearing
/// somewhere in a successful build log is not a failure, and guessing produces
/// exactly the false alarms that teach a model to ignore the signal.
///
/// **Adding a tool that executes anything — code, a command, a compile, a job
/// submission, a provider search — means adding it here.** Nothing else derives
/// this.
#[must_use]
pub fn tool_output_reports_failure(tool_name: &str, output: &str) -> bool {
    classifier(tool_name).is_some_and(|judge| judge(output))
}

/// Whether this module claims to be able to judge a tool's payload at all.
///
/// Exposed so the tool inventory can assert, in a test, that every tool has
/// been through this decision — the allow-list is a hand-kept registry, and a
/// registry nobody is forced to update is one a new tool silently falls out of.
#[must_use]
pub fn classifies_failures(tool_name: &str) -> bool {
    classifier(tool_name).is_some()
}

fn classifier(tool_name: &str) -> Option<fn(&str) -> bool> {
    Some(match tool_name {
        "bash" | "PowerShell" | "LaTeXCompile" => shell_output_reports_failure,
        "REPL" => repl_output_reports_failure,
        "NotebookExecute" | "NotebookRun" | "NotebookSweep" => notebook_output_reports_failure,
        "LiteratureSearch" | "LiteratureSearchExecute" | "LiteratureCitations" => {
            literature_search_output_reports_failure
        }
        "WebSearch" => web_search_output_reports_failure,
        _ => return None,
    })
}

/// A web search whose every provider refused still returns a well-formed
/// payload, exactly like a literature search does.
///
/// The top-level `status` cannot carry this: it only reports whether the
/// providers were exhausted (`completed`/`partial`), so a run where all of them
/// errored still reads `partial`. The verdict lives per source, and only a run
/// where every attempt failed counts — one rate-limited provider out of five is
/// the coverage gap the payload already reports.
fn web_search_output_reports_failure(output: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(output) else {
        return false;
    };
    let Some(attempts) = value
        .get("sourceAttempts")
        .and_then(serde_json::Value::as_array)
    else {
        return false;
    };
    !attempts.is_empty()
        && attempts.iter().all(|attempt| {
            attempt
                .get("status")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|status| status.trim().eq_ignore_ascii_case("failed"))
        })
}

/// A literature search whose every source failed still returns a well-formed
/// `SearchRun`, so the call succeeds while the retrieval did not. Without this
/// the repeat counter cannot see a model re-running the same dead search, and
/// the desktop shows a clean result for a run that found nothing because every
/// provider refused it.
///
/// Only a wholly failed run counts. `partial` is the ordinary outcome of a
/// bounded page — one rate-limited source out of five is a coverage gap the
/// payload already reports, not a failed tool call.
fn literature_search_output_reports_failure(output: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(output) else {
        return false;
    };
    value
        .get("searchRun")
        .and_then(|run| run.get("status"))
        .and_then(serde_json::Value::as_str)
        .is_some_and(|status| status.trim().eq_ignore_ascii_case("failed"))
}

/// `returnCodeInterpretation` carries more than an exit code — `timeout`,
/// `interrupted`, `missing_output`, `inputs_changed` — and is absent on success,
/// so its mere presence is the signal.
#[must_use]
pub fn shell_output_reports_failure(output: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(output) else {
        return false;
    };
    value
        .get("interrupted")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
        || value
            .get("returnCodeInterpretation")
            .is_some_and(json_value_is_present)
}

fn repl_output_reports_failure(output: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(output) else {
        return false;
    };
    value
        .get("exitCode")
        .and_then(serde_json::Value::as_i64)
        .is_some_and(|code| code != 0)
}

/// A notebook reports failure three ways: a terminal `status` other than `ok`
/// (`NotebookExecute` / `NotebookRun`), a per-run status inside a sweep, or an
/// `error` output block on a cell that ran with `stop_on_error` disabled — that
/// last one leaves the run's own status `ok` while cells raised.
fn notebook_output_reports_failure(output: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(output) else {
        return false;
    };
    if notebook_status_is_failure(value.get("status")) {
        return true;
    }
    if let Some(runs) = value.get("runs").and_then(serde_json::Value::as_array) {
        if runs
            .iter()
            .any(|run| notebook_status_is_failure(run.get("status")))
        {
            return true;
        }
    }
    value
        .get("outputs")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|outputs| {
            outputs.iter().any(|output| {
                output.get("type").and_then(serde_json::Value::as_str) == Some("error")
            })
        })
}

fn notebook_status_is_failure(status: Option<&serde_json::Value>) -> bool {
    status
        .and_then(serde_json::Value::as_str)
        .is_some_and(|status| !matches!(status.trim(), "ok" | "" | "running"))
}

fn json_value_is_present(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null => false,
        serde_json::Value::String(text) => !text.trim().is_empty(),
        _ => true,
    }
}

#[cfg(test)]
#[path = "tests/tool_outcome.rs"]
mod tests;
