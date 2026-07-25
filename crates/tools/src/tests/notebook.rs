use serde_json::json;
use std::sync::{Mutex, OnceLock};

const MINIMAL_IPYNB: &str = r#"{"cells":[{"cell_type":"code","id":"c1","metadata":{},"source":"x = 41","outputs":[],"execution_count":null}],"metadata":{},"nbformat":4,"nbformat_minor":5}"#;
const PARAM_IPYNB: &str = r#"{"cells":[{"cell_type":"code","id":"params","metadata":{"tags":["parameters"]},"source":"seed = 0","outputs":[],"execution_count":null},{"cell_type":"code","id":"body","metadata":{},"source":"print(seed)","outputs":[],"execution_count":null}],"metadata":{},"nbformat":4,"nbformat_minor":5}"#;

fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[test]
fn notebook_execute_tool_runs_persists_and_writes_back() {
    let nb = std::env::temp_dir().join(format!("somniq-tools-{}.ipynb", std::process::id()));
    std::fs::write(&nb, MINIMAL_IPYNB).unwrap();
    let path = nb.to_string_lossy().to_string();

    // Run cell 0 (`x = 41`) and write outputs back. Skip if no kernel installed.
    let r0 = crate::execute_tool(
        "NotebookExecute",
        &json!({ "notebook_path": path, "cell_index": 0 }),
    );
    let r0 = match r0 {
        Ok(out) => out,
        Err(e) if e.contains("no Jupyter kernelspec installed") => {
            eprintln!("SKIP notebook tool test (no kernel): {e}");
            let _ = std::fs::remove_file(&nb);
            return;
        }
        Err(e) => panic!("NotebookExecute failed: {e}"),
    };
    assert!(
        r0.contains("\"status\": \"ok\""),
        "cell 0 should run ok: {r0}"
    );
    assert!(
        r0.contains("\"wroteBack\": true"),
        "cell 0 outputs should persist: {r0}"
    );

    // A second execute sees state from the first -> shared, long-lived kernel.
    let r1 = crate::execute_tool(
        "NotebookExecute",
        &json!({ "notebook_path": path, "code": "print(x + 1)" }),
    )
    .unwrap();
    assert!(
        r1.contains("42"),
        "expected persisted state to yield 42: {r1}"
    );

    // Errors surface as status=error, not a tool failure.
    let r2 = crate::execute_tool(
        "NotebookExecute",
        &json!({ "notebook_path": path, "code": "raise ValueError('boom')" }),
    )
    .unwrap();
    assert!(r2.contains("\"status\": \"error\""), "error path: {r2}");

    // Kernel management round-trips.
    let status = crate::execute_tool(
        "NotebookKernel",
        &json!({ "action": "status", "notebook_path": path }),
    )
    .unwrap();
    assert!(
        status.contains("\"running\": true"),
        "kernel should be running: {status}"
    );
    crate::execute_tool(
        "NotebookKernel",
        &json!({ "action": "shutdown", "notebook_path": path }),
    )
    .unwrap();

    let _ = std::fs::remove_file(&nb);
}

#[test]
fn notebook_run_with_parameters_writes_executed_copy_not_source() {
    let _guard = env_lock();
    let previous_root = std::env::var_os("ARIS_WORKSPACE_ROOT");
    let base = std::env::temp_dir().join(format!("somniq-notebook-run-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    std::env::set_var("ARIS_WORKSPACE_ROOT", &base);
    let nb = base.join("train.ipynb");
    std::fs::write(&nb, PARAM_IPYNB).unwrap();

    let result = crate::execute_tool(
        "NotebookRun",
        &json!({ "notebook_path": "train.ipynb", "parameters": { "seed": 7 } }),
    );
    let result = match result {
        Ok(out) => out,
        Err(e) if e.contains("no Jupyter kernelspec installed") => {
            eprintln!("SKIP notebook run test (no kernel): {e}");
            restore_root(previous_root);
            let _ = std::fs::remove_dir_all(&base);
            return;
        }
        Err(e) => panic!("NotebookRun failed: {e}"),
    };
    let output: serde_json::Value = serde_json::from_str(&result).unwrap();
    assert_eq!(output["status"], "ok", "run should succeed: {result}");
    let executed = output["executedPath"].as_str().expect("executedPath");
    assert_ne!(executed.replace('\\', "/"), "train.ipynb");

    let source = std::fs::read_to_string(&nb).unwrap();
    assert!(
        !source.contains("injected-parameters"),
        "source notebook must not be polluted: {source}"
    );
    let executed_path = base.join(executed);
    let executed_text = std::fs::read_to_string(&executed_path).unwrap();
    assert!(executed_text.contains("injected-parameters"));
    assert!(executed_text.contains("seed = 7"));

    let runs = std::fs::read_to_string(base.join(".somniq/experiments/runs.json")).unwrap();
    assert!(runs.contains("\"status\": \"ok\""), "runs ledger: {runs}");
    crate::execute_tool(
        "NotebookKernel",
        &json!({ "action": "shutdown", "notebook_path": "train.ipynb" }),
    )
    .unwrap();

    restore_root(previous_root);
    let _ = std::fs::remove_dir_all(&base);
}

fn restore_root(previous: Option<std::ffi::OsString>) {
    match previous {
        Some(value) => std::env::set_var("ARIS_WORKSPACE_ROOT", value),
        None => std::env::remove_var("ARIS_WORKSPACE_ROOT"),
    }
}
