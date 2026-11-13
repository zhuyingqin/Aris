//! Replay historical tool failures through the real tools (`execute_tool`).
//!
//! Usage: replay_tool_failures <plan.json> <before|after> <out.json>
//!
//! The plan (memory-l1-eval/tools/build_replay_plan.py) re-issues each failing
//! operation without its original side effects. `before` reproduces the old
//! environment: Python children forced to the console code page (what CPython
//! does with no UTF-8 variables), MSYS bash started with the bare Windows PATH
//! (`REPLAY_MSYS_BASH`), and read-only roots without the project's sub-agent
//! store. `after` uses the tools as they are now plus the roots the desktop now
//! builds.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{json, Value};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let plan: Vec<Value> =
        serde_json::from_str(&std::fs::read_to_string(&args[1]).expect("plan")).expect("json");
    let after = args[2] == "after";
    if !after {
        // An explicitly set value wins over apply_windows_utf8_env, so this
        // gives Python exactly its pre-fix behaviour on a GBK console.
        std::env::set_var("PYTHONUTF8", "0");
        std::env::set_var("PYTHONIOENCODING", "cp936");
    }
    let scratch = std::env::temp_dir().join("aris-replay-workspace");
    std::fs::create_dir_all(&scratch).expect("scratch workspace");
    let mut results = Vec::new();
    for item in &plan {
        let outcome = match item["kind"].as_str().unwrap_or_default() {
            "tool" => replay_tool(item, after, &scratch),
            "path_probe" => probe_program(item["program"].as_str().unwrap_or("ls"), after),
            _ => json!({"status": "not_replayed", "detail": item["skip_reason"]}),
        };
        eprintln!(
            "{} {} {} -> {}",
            item["n"], item["class"], item["tool"], outcome["status"]
        );
        results.push(
            json!({"n": item["n"], "class": item["class"], "tool": item["tool"],
                            "day": item["day"], "outcome": outcome}),
        );
    }
    std::fs::write(&args[3], serde_json::to_string_pretty(&results).unwrap()).expect("write out");
}

fn replay_tool(item: &Value, after: bool, scratch: &Path) -> Value {
    let name = item["tool_name"].as_str().unwrap_or_default();
    let input = &item["input"];
    let result = if item["class"] == "outside" {
        let workspace = item["workspace"]
            .as_str()
            .map(PathBuf::from)
            .filter(|path| path.exists())
            .unwrap_or_else(|| scratch.to_path_buf());
        let mut roots: Vec<PathBuf> = item["base_roots"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(PathBuf::from)
            .collect();
        if after {
            roots.push(PathBuf::from(
                item["agent_store"].as_str().unwrap_or_default(),
            ));
        }
        roots.retain(|root| root.exists());
        let mut context = runtime::ProjectExecutionContext::new(&workspace)
            .with_env("ARIS_WORKSPACE_ROOT", workspace.as_os_str());
        context = match std::env::join_paths(&roots) {
            Ok(joined) if !roots.is_empty() => context.with_env("ARIS_READONLY_ROOTS", joined),
            _ => context.without_env("ARIS_READONLY_ROOTS"),
        };
        runtime::with_project_execution_context(&context, || tools::execute_tool(name, input))
    } else {
        tools::execute_tool(name, input)
    };
    match result {
        Ok(text) => {
            if let Some(expected) = item["expect_stdout"].as_str() {
                let output: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
                let stdout = output["stdout"].as_str().unwrap_or_default();
                let stderr = output["stderr"].as_str().unwrap_or_default();
                let exit_ok = output["exitCode"].as_i64().map_or(true, |code| code == 0)
                    && output["returnCodeInterpretation"].is_null();
                let status = if stdout.contains(expected) && exit_ok {
                    "fixed"
                } else if stderr.contains("UnicodeEncodeError")
                    || stderr.contains("UnicodeDecodeError")
                {
                    "fails_same_way"
                } else {
                    "wrong_output"
                };
                json!({"status": status, "stdout": clip(stdout), "stderr": clip(stderr)})
            } else {
                // read_files succeeds as a call and reports each file's error inside.
                let output: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
                let errors: Vec<&str> = output["results"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|result| result["error"].as_str())
                    .collect();
                let status = if errors
                    .iter()
                    .any(|error| error.contains("outside the isolated workspace"))
                {
                    "denied"
                } else if errors.is_empty() {
                    "allowed"
                } else {
                    "allowed_other_error"
                };
                json!({"status": status, "detail": clip(&text)})
            }
        }
        Err(error)
            if error.contains("outside the isolated workspace")
                || error.contains("outside the current workspace") =>
        {
            json!({"status": "denied", "detail": clip(&error)})
        }
        Err(error) => json!({"status": "allowed_other_error", "detail": clip(&error)}),
    }
}

fn probe_program(program: &str, after: bool) -> Value {
    let script = format!("command -v {program}");
    if after {
        return match tools::execute_tool("bash", &json!({"command": script, "timeout": 20000})) {
            Ok(text) => {
                let output: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
                let found = output["returnCodeInterpretation"].is_null()
                    && !output["stdout"]
                        .as_str()
                        .unwrap_or_default()
                        .trim()
                        .is_empty();
                json!({"status": if found { "found" } else { "missing" },
                       "detail": clip(output["stdout"].as_str().unwrap_or_default())})
            }
            Err(error) => json!({"status": "missing", "detail": clip(&error)}),
        };
    }
    // Old launcher: MSYS bash started directly with the Windows PATH only.
    let bash = std::env::var("REPLAY_MSYS_BASH").expect("REPLAY_MSYS_BASH");
    match Command::new(bash).arg("-c").arg(&script).output() {
        Ok(output) if output.status.success() => json!({"status": "found",
            "detail": clip(&String::from_utf8_lossy(&output.stdout))}),
        Ok(output) => json!({"status": "missing",
            "detail": clip(&String::from_utf8_lossy(&output.stderr))}),
        Err(error) => json!({"status": "missing", "detail": error.to_string()}),
    }
}

fn clip(text: &str) -> String {
    text.chars().take(300).collect()
}
