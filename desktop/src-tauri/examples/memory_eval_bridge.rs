//! `cargo run --example memory_eval_bridge --features memory-eval`
//!
//! Reads one JSON request per stdin line and writes one JSON reply per stdout
//! line (see `aris_desktop_lib::memory_eval_bridge`). `--describe` prints the
//! configured model and provider and exits.

use std::io::{self, BufRead, Write};

fn main() {
    if std::env::args().any(|arg| arg == "--describe") {
        println!("{}", aris_desktop_lib::memory_eval_bridge::describe());
        return;
    }
    let args: Vec<String> = std::env::args().collect();
    if let Some(index) = args.iter().position(|arg| arg == "--product-prompt") {
        let workspace = args.get(index + 1).map(String::as_str).unwrap_or(".");
        let strip = args.iter().any(|arg| arg == "--strip-continuity");
        println!("{}", aris_desktop_lib::memory_eval_bridge::product_prompt_sections(workspace, strip));
        return;
    }
    if std::env::args().any(|arg| arg == "--tool-specs") {
        println!("{}", aris_desktop_lib::memory_eval_bridge::tool_specs_json());
        return;
    }
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<serde_json::Value>(&line) {
            Ok(request) => aris_desktop_lib::memory_eval_bridge::complete(&request),
            Err(error) => serde_json::json!({"error": format!("bad request: {error}")}),
        };
        let _ = writeln!(stdout, "{reply}");
        let _ = stdout.flush();
    }
}
