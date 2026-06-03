//! `flow` — headless CLI for the P0 flow runtime.
//!
//! Subcommands:
//!   run <topic...>              run the idea-pilot flow on MiniMax
//!   resume <run_id>             resume a run (completed steps replay from cache)
//!   fork <run_id> --from <step> re-run from a step on a new run (upstream reused)
//!   inspect <run_id> [--at N]   reconstruct + print run state at event N (rewind)

#![allow(clippy::doc_markdown)]

use std::process::ExitCode;

use flow::event::read_entries;
use flow::store::{run_dir, StepStore};
use flow::{fold, idea_pilot, FlowError, FlowRunner};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("flow: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run(args: &[String]) -> flow::Result<()> {
    let Some((cmd, rest)) = args.split_first() else {
        print_usage();
        return Ok(());
    };
    match cmd.as_str() {
        "run" => cmd_run(rest),
        "resume" => cmd_resume(rest),
        "fork" => cmd_fork(rest),
        "inspect" => cmd_inspect(rest),
        "help" | "-h" | "--help" => {
            print_usage();
            Ok(())
        }
        other => Err(FlowError::InvalidGraph(format!(
            "unknown subcommand: {other}"
        ))),
    }
}

fn cmd_run(rest: &[String]) -> flow::Result<()> {
    let topic = rest.join(" ");
    if topic.trim().is_empty() {
        return Err(FlowError::InvalidGraph(
            "usage: flow run <topic...>".to_string(),
        ));
    }
    let flow = idea_pilot();
    let args = serde_json::json!({ "topic": topic });
    let mut runner = FlowRunner::fresh(flow, args)?;
    println!("▶ run {}  (topic: {topic})", runner.run_id());
    let outcome = runner.run()?;
    print_outcome(&outcome.run_id, outcome.result.as_deref());
    Ok(())
}

fn cmd_resume(rest: &[String]) -> flow::Result<()> {
    let run_id = first(rest, "usage: flow resume <run_id>")?;
    let mut runner = FlowRunner::resume(run_id)?;
    println!("▶ resume {}", runner.run_id());
    let outcome = runner.run()?;
    print_outcome(&outcome.run_id, outcome.result.as_deref());
    Ok(())
}

fn cmd_fork(rest: &[String]) -> flow::Result<()> {
    let run_id = first(rest, "usage: flow fork <run_id> --from <step>")?;
    let from = flag(rest, "--from")
        .ok_or_else(|| FlowError::InvalidGraph("fork requires --from <step>".to_string()))?;
    let mut runner = FlowRunner::fork(run_id, &from)?;
    println!(
        "▶ fork {} from step '{from}'  (new run {})",
        run_id,
        runner.run_id()
    );
    let outcome = runner.run()?;
    print_outcome(&outcome.run_id, outcome.result.as_deref());
    Ok(())
}

fn cmd_inspect(rest: &[String]) -> flow::Result<()> {
    let run_id = first(rest, "usage: flow inspect <run_id> [--at N]")?;
    let at = flag(rest, "--at").and_then(|v| v.parse::<usize>().ok());

    let dir = run_dir(run_id);
    let entries = read_entries(&dir.join("events.jsonl"))?;
    if entries.is_empty() {
        return Err(FlowError::RunNotFound(run_id.to_string()));
    }
    let state = fold(&entries, at);

    println!("run      : {}", state.run_id.as_deref().unwrap_or(run_id));
    println!("flow     : {}", state.flow_name.as_deref().unwrap_or("?"));
    if let Some(parent) = &state.parent {
        println!("parent   : {parent}  (forked)");
    }
    println!("args     : {}", state.args);
    println!(
        "folded   : {} / {} events{}",
        state.events_folded,
        entries.len(),
        at.map(|n| format!("  (--at {n})")).unwrap_or_default()
    );
    println!(
        "status   : {}",
        if state.finished {
            "finished"
        } else if state.failed.is_some() {
            "failed"
        } else {
            "in-progress"
        }
    );
    if let Some((step, error)) = &state.failed {
        println!("failed   : {step}: {error}");
    }

    let store = StepStore::open(&dir)?;
    println!("steps    :");
    for (step, key) in &state.completed {
        let tag = if state.cached.contains(step) {
            "cached"
        } else {
            "fresh "
        };
        let preview_text = store
            .get(key)?
            .map_or_else(|| "<no stored output>".to_string(), |r| preview(&r.output));
        println!("  [{tag}] {step:<12} {}  {preview_text}", key.short());
    }
    if let Some(result_step) = &state.result_step {
        println!("result   : step '{result_step}'");
    }
    Ok(())
}

fn print_outcome(run_id: &str, result: Option<&str>) {
    println!("✔ {run_id}");
    if let Some(text) = result {
        println!("\n──────── result ────────\n{text}\n─────────────────────────");
    }
    println!("inspect: flow inspect {run_id}");
}

fn first<'a>(rest: &'a [String], usage: &str) -> flow::Result<&'a str> {
    rest.iter()
        .map(String::as_str)
        .find(|a| !a.starts_with('-'))
        .ok_or_else(|| FlowError::InvalidGraph(usage.to_string()))
}

fn flag(rest: &[String], name: &str) -> Option<String> {
    rest.iter()
        .position(|a| a == name)
        .and_then(|i| rest.get(i + 1))
        .cloned()
}

fn preview(text: &str) -> String {
    let one_line: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut end = one_line.len().min(80);
    while !one_line.is_char_boundary(end) {
        end -= 1;
    }
    if one_line.len() > end {
        format!("{}…", &one_line[..end])
    } else {
        one_line
    }
}

fn print_usage() {
    println!(
        "flow — P0 dynamic-workflow runtime (pilot on MiniMax)\n\n\
         USAGE:\n  \
         flow run <topic...>              run the idea-pilot flow\n  \
         flow resume <run_id>             resume; completed steps replay from cache\n  \
         flow fork <run_id> --from <step> re-run from a step on a new run\n  \
         flow inspect <run_id> [--at N]   reconstruct run state at event N\n\n\
         Requires MINIMAX_API_KEY (source ./minimax.env)."
    );
}
