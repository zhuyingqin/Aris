//! Replay the L0 / L1 memory changes on prepared real-data copies.
//!
//! Inputs come from experiments/memory/scripts/prep_replay.py and hold private
//! text; nothing here writes outside the given scratch copies / temp store.
//!
//!   cargo run -p runtime --example memory_replay -- l0 <replay/l0.json>
//!   cargo run -p runtime --example memory_replay -- l1 <replay/l1.json>
//!
//! Prints aggregate hit rates only.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::time::Instant;

use runtime::{
    is_research_memory_session_id, search_sessions_filtered, sync_sessions_dir, LessonCall, LessonDraft, LessonGates, LessonJob, LessonStore, LessonTurn,
    SessionSearchFilter, SessionSearchResult,
};
use serde_json::Value;

fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn l0(path: &str) {
    let probes: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(path).expect("read")).expect("json");
    let dirs: BTreeSet<String> = probes
        .iter()
        .filter_map(|p| p["sessions_dir"].as_str().map(ToOwned::to_owned))
        .collect();
    // Gold = the probe's source turn and its neighbours. Each turn starts at a
    // user message carrying one of the markers and runs to the next user text
    // message; a hit is a returned window that covers any message of them.
    let mut gold_ranges: Vec<Vec<(usize, usize)>> = Vec::new();
    for probe in &probes {
        let dir = Path::new(probe["sessions_dir"].as_str().unwrap_or_default());
        let gold = probe["gold_session"].as_str().unwrap_or_default();
        let markers: Vec<String> = probe["markers"]
            .as_array()
            .map(|items| items.iter().filter_map(Value::as_str).map(collapse).collect())
            .unwrap_or_default();
        let mut ranges = Vec::new();
        if let Ok(SessionSearchResult::Read { messages, .. }) =
            search_sessions_filtered(dir, None, Some(gold), 1, 0, SessionSearchFilter::default())
        {
            let is_user_text = |m: &runtime::SessionSearchMessage| {
                m.role == "user" && !m.content.starts_with("tool result")
            };
            for (position, message) in messages.iter().enumerate() {
                let content = collapse(&message.content);
                if !is_user_text(message) || !markers.iter().any(|marker| content.contains(marker.as_str())) {
                    continue;
                }
                let end = messages[position + 1..]
                    .iter()
                    .find(|later| is_user_text(later))
                    .map_or(usize::MAX, |later| later.index.saturating_sub(1));
                ranges.push((message.index, end));
            }
        }
        gold_ranges.push(ranges);
    }
    println!(
        "probes whose gold turn was located: {}/{}",
        gold_ranges.iter().filter(|ranges| !ranges.is_empty()).count(),
        probes.len()
    );
    let run = |label: &str| {
        let mut table: BTreeMap<(String, usize), (usize, usize)> = BTreeMap::new();
        let started = Instant::now();
        let mut searches = 0usize;
        for (probe, ranges) in probes.iter().zip(&gold_ranges) {
            let dir = Path::new(probe["sessions_dir"].as_str().unwrap_or_default());
            let question = probe["question"].as_str().unwrap_or_default();
            let gold = probe["gold_session"].as_str().unwrap_or_default();
            let split = probe["split"].as_str().unwrap_or("dev").to_string();
            // MEMORY_REPLAY_NO_TIME=1 searches all history (no time lock), to
            // separate ranking from how the time filter treats old sessions.
            let time_end_ms = if std::env::var_os("MEMORY_REPLAY_NO_TIME").is_some() {
                None
            } else {
                probe["time_end_ms"].as_i64()
            };
            let filter = SessionSearchFilter {
                time_start_ms: None,
                time_end_ms,
                prefer_recent: false,
            };
            searches += 1;
            // Production shape: ask for 8, drop non-chat sessions (paper
            // reading, workflows...), then the first 2 are injected.
            let Ok(SessionSearchResult::Search { results, .. }) =
                search_sessions_filtered(dir, Some(question), None, 8, 5, filter)
            else {
                continue;
            };
            let results: Vec<_> = results
                .into_iter()
                .filter(|hit| is_research_memory_session_id(&hit.session_id))
                .collect();
            for limit in [2usize, 3] {
                let hit = results.iter().take(limit).any(|result| {
                    result.session_id == gold
                        && result.messages.iter().any(|message| {
                            ranges
                                .iter()
                                .any(|(lo, hi)| (*lo..=*hi).contains(&message.index))
                        })
                });
                let entry = table.entry((split.clone(), limit)).or_default();
                entry.0 += usize::from(hit);
                entry.1 += 1;
            }
        }
        let per_query_ms = started.elapsed().as_secs_f64() * 1000.0 / searches.max(1) as f64;
        for ((split, limit), (hits, total)) in &table {
            println!(
                "{label:8} {split:5} top{limit} sessions: {hits}/{total} = {:.1}%",
                100.0 * *hits as f64 / *total as f64
            );
        }
        println!("{label:8} mean query time {per_query_ms:.1} ms");
    };
    run("before");
    let started = Instant::now();
    for dir in &dirs {
        sync_sessions_dir(Path::new(dir)).expect("repair");
    }
    println!("backfill/repair of {} indexes: {:.1} s", dirs.len(), started.elapsed().as_secs_f64());
    run("after");
}

fn l1(path: &str) {
    let input: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("read")).expect("json");
    let mut notes: Vec<&Value> = input["notes"].as_array().expect("notes").iter().collect();
    notes.sort_by_key(|note| note["session_start"].as_i64().unwrap_or_default());
    let mut events: Vec<&Value> = input["events"].as_array().expect("events").iter().collect();
    events.sort_by_key(|event| event["session_start"].as_i64().unwrap_or_default());
    let store_path = std::env::temp_dir().join(format!(
        "aris-lesson-replay-{}.sqlite3",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&store_path);
    let store = LessonStore::new(&store_path);
    // MEMORY_REPLAY_GATES: comma list of class, paths, stock; "none"
    // for none; unset for the product default.
    let gates = match std::env::var("MEMORY_REPLAY_GATES") {
        Ok(list) => {
            let on = |name: &str| list.split(',').any(|item| item.trim() == name);
            LessonGates {
                error_class: on("class"),
                ignore_paths: on("paths"),
                ignore_stock_wording: on("stock"),
                ..LessonGates::default()
            }
        }
        Err(_) => LessonGates::default(),
    };
    // MEMORY_REPLAY_MIN_SHARED=<n>: the shared-word floor.
    let gates = match std::env::var("MEMORY_REPLAY_MIN_SHARED").ok().and_then(|value| value.parse().ok()) {
        Some(min_shared) => LessonGates { min_shared, ..gates },
        None => gates,
    };
    println!("gates: {gates:?}");
    // MEMORY_REPLAY_JSON=<path>: write every event's attachments there.
    let export = std::env::var_os("MEMORY_REPLAY_JSON");
    let mut rows: Vec<Value> = Vec::new();
    let mut by_statement: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut next = 0usize;
    let mut table: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    let mut shared: BTreeMap<(&str, usize), usize> = BTreeMap::new();
    let started = Instant::now();
    for event in &events {
        let start = event["session_start"].as_i64().unwrap_or_default();
        while next < notes.len() && notes[next]["session_start"].as_i64().unwrap_or_default() < start {
            let note = notes[next];
            let id = note["id"].as_str().unwrap_or_default().to_string();
            let statement = note["statement"].as_str().unwrap_or_default().to_string();
            by_statement.entry(statement.clone()).or_default().push(id.clone());
            let job = LessonJob {
                id: 0,
                project_id: note["project"].as_str().unwrap_or_default().to_string(),
                session_id: note["session"].as_str().unwrap_or_default().to_string(),
                // The failed call the note was written from (enrich_l1_notes.py),
                // so the store can record its kind.
                turn: LessonTurn {
                    user: String::new(),
                    assistant: String::new(),
                    calls: vec![LessonCall {
                        id: id.clone(),
                        name: note["tool"].as_str().unwrap_or_default().to_string(),
                        input: runtime::lesson_input_digest(note["input"].as_str().unwrap_or_default()),
                        failed: true,
                        error: runtime::lesson_error_digest(note["error"].as_str().unwrap_or_default()),
                    }],
                },
                created_at_ms: 0,
                attempts: 0,
            };
            let draft = LessonDraft {
                job_index: 0,
                statement,
                tool: note["tool"].as_str().unwrap_or_default().to_string(),
                tool_use_id: id.clone(),
                fix_tool_use_id: None,
                cause_key: id,
            };
            store.insert_lessons(&[job], &[draft]).expect("insert");
            next += 1;
        }
        let recalled = store
            .recall_for_failure_gated(
                event["tool"].as_str().unwrap_or_default(),
                event["input"].as_str().unwrap_or_default(),
                event["output"].as_str().unwrap_or_default(),
                gates,
            )
            .expect("recall");
        let split = event["split"].as_str().unwrap_or("dev").to_string();
        if std::env::var_os("MEMORY_REPLAY_DUMP").is_some() && split.starts_with("neg") && !recalled.is_empty() {
            // Diagnostic (private text, stdout only): why a negative got a lesson.
            let tool = event["tool"].as_str().unwrap_or_default();
            let output = event["output"].as_str().unwrap_or_default();
            let error = runtime::lesson_error_digest(output);
            println!(
                "NEG tool={tool} class={:?}\n    error: {}",
                runtime::error_class(&error),
                error.chars().take(160).collect::<String>()
            );
            for lesson in &recalled {
                println!(
                    "    -> shared={} {}",
                    lesson.shared_words,
                    lesson.statement.chars().take(150).collect::<String>()
                );
            }
        }
        let gold: BTreeSet<&str> = event["gold"]
            .as_array()
            .map(|items| items.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let positive = if split.starts_with("neg") {
            !recalled.is_empty()
        } else {
            recalled.iter().any(|lesson| {
                by_statement
                    .get(&lesson.statement)
                    .is_some_and(|ids| ids.iter().any(|id| gold.contains(id.as_str())))
            })
        };
        if export.is_some() {
            // Per-event attachments for offline judging (private text).
            rows.push(serde_json::json!({
                "index": rows.len(),
                "id": event["id"].as_str().unwrap_or_default(),
                "split": split,
                "tool": event["tool"].as_str().unwrap_or_default(),
                "input": event["input"].as_str().unwrap_or_default().chars().take(400).collect::<String>(),
                "error": runtime::lesson_error_digest(event["output"].as_str().unwrap_or_default()),
                "positive": positive,
                "lessons": recalled.iter().map(|lesson| serde_json::json!({
                    "statement": lesson.statement,
                    "notes": by_statement.get(&lesson.statement).cloned().unwrap_or_default(),
                    "shared": lesson.shared_words,
                })).collect::<Vec<_>>(),
            }));
        }
        if std::env::var_os("MEMORY_REPLAY_SHARED").is_some() {
            // Diagnostic: shared distinctive words of the top lesson, for a
            // correct hit vs a wrong attachment.
            if let Some(top) = recalled.first() {
                let kind = if split.starts_with("neg") { "wrong" } else if positive { "right" } else { "miss" };
                *shared.entry((kind, top.shared_words.min(8))).or_default() += 1;
            }
        }
        let entry = table.entry(split).or_default();
        entry.0 += usize::from(positive);
        entry.1 += 1;
    }
    if let Some(path) = &export {
        std::fs::write(path, serde_json::to_string(&rows).expect("json")).expect("write export");
    }
    if !shared.is_empty() {
        println!("top lesson shared words (capped at 8): {shared:?}");
    }
    for (split, (hits, total)) in &table {
        let label = if split.starts_with("neg") { "attached (should be low)" } else { "found the right lesson" };
        println!(
            "{split:5} {label}: {hits}/{total} = {:.1}%",
            100.0 * *hits as f64 / *total as f64
        );
    }
    println!(
        "mean recall time {:.2} ms",
        started.elapsed().as_secs_f64() * 1000.0 / events.len().max(1) as f64
    );
    let _ = std::fs::remove_file(&store_path);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match (args.get(1).map(String::as_str), args.get(2)) {
        (Some("l0"), Some(path)) => l0(path),
        (Some("l1"), Some(path)) => l1(path),
        _ => eprintln!("usage: memory_replay (l0|l1) <input.json>"),
    }
}
