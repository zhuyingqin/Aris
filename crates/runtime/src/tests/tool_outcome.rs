use super::*;
use serde_json::json;

fn payload(value: serde_json::Value) -> String {
    serde_json::to_string_pretty(&value).expect("json")
}

#[test]
fn a_nonzero_shell_exit_reports_failure() {
    assert!(tool_output_reports_failure(
        "bash",
        &payload(json!({
            "stdout": "",
            "stderr": "ModuleNotFoundError: No module named 'torch'",
            "interrupted": false,
            "returnCodeInterpretation": "exit_code:1"
        }))
    ));
    assert!(!tool_output_reports_failure(
        "bash",
        &payload(json!({
            "stdout": "ok",
            "stderr": "",
            "interrupted": false,
            "returnCodeInterpretation": null
        }))
    ));
}

/// `returnCodeInterpretation` carries more than exit codes, and a cancelled
/// command sets `interrupted` without one.
#[test]
fn timeouts_and_interrupts_report_failure_too() {
    for interpretation in ["timeout", "interrupted", "missing_output", "inputs_changed"] {
        assert!(
            tool_output_reports_failure(
                "PowerShell",
                &payload(json!({ "returnCodeInterpretation": interpretation }))
            ),
            "{interpretation}"
        );
    }
    assert!(tool_output_reports_failure(
        "bash",
        &payload(json!({ "interrupted": true }))
    ));
}

#[test]
fn a_raised_or_timed_out_notebook_cell_reports_failure() {
    assert!(tool_output_reports_failure(
        "NotebookExecute",
        &payload(json!({
            "status": "error",
            "cellIndex": 3,
            "outputs": [{ "type": "error", "ename": "RuntimeError", "evalue": "CUDA out of memory" }]
        }))
    ));
    assert!(tool_output_reports_failure(
        "NotebookExecute",
        &payload(json!({ "status": "timeout", "cellIndex": 3 }))
    ));
    assert!(!tool_output_reports_failure(
        "NotebookExecute",
        &payload(json!({
            "status": "ok",
            "cellIndex": 3,
            "outputs": [{ "type": "stream", "name": "stdout", "text": "loss 0.12" }]
        }))
    ));
}

/// `stop_on_error: false` leaves the run's terminal status `ok` while cells
/// raised, and a sweep reports per-run statuses rather than one.
#[test]
fn notebook_failures_are_seen_through_per_cell_and_per_run_statuses() {
    assert!(tool_output_reports_failure(
        "NotebookRun",
        &payload(json!({
            "status": "ok",
            "outputs": [{ "type": "error", "ename": "KeyError", "evalue": "label" }]
        }))
    ));
    assert!(tool_output_reports_failure(
        "NotebookSweep",
        &payload(json!({
            "sweepId": "sweep-1",
            "runs": [
                { "id": "a", "status": "ok" },
                { "id": "b", "status": "error" }
            ]
        }))
    ));
    assert!(!tool_output_reports_failure(
        "NotebookSweep",
        &payload(json!({ "sweepId": "sweep-2", "runs": [{ "id": "a", "status": "ok" }] }))
    ));
}

#[test]
fn a_nonzero_repl_exit_reports_failure() {
    assert!(tool_output_reports_failure(
        "REPL",
        &payload(json!({ "language": "python", "stderr": "AssertionError", "exitCode": 1 }))
    ));
    assert!(!tool_output_reports_failure(
        "REPL",
        &payload(json!({ "language": "python", "stdout": "4", "exitCode": 0 }))
    ));
}

/// Classification is an allow-list, not a scan for the word "error": a
/// successful build log mentioning errors it fixed is not a failed run, and
/// guessing produces the false alarms that teach a model to ignore the signal.
#[test]
fn non_execution_tools_and_unparseable_output_are_never_guessed_at() {
    assert!(!tool_output_reports_failure(
        "read_file",
        &payload(json!({ "content": "error: this is just file content" }))
    ));
    assert!(!tool_output_reports_failure(
        "WebSearch",
        &payload(json!({ "status": "error" }))
    ));
    assert!(!tool_output_reports_failure("bash", "not json at all"));
}
