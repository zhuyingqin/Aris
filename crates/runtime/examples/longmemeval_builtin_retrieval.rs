//! Build an isolated LongMemEval index with SomniQ's real builtin
//! `session_search` implementation and export Top-5 hits for paired comparison.

use std::collections::HashMap;
use std::env;
use std::fs::{self, File};
use std::io::BufReader;
use std::path::Path;
use std::time::Instant;

use runtime::{search_sessions, ContentBlock, ConversationMessage, Session, SessionSearchResult};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
struct LongMemEvalTurn {
    role: String,
    content: String,
}

#[derive(Deserialize)]
struct LongMemEvalRecord {
    question_id: String,
    question_type: String,
    question: String,
    haystack_dates: Vec<String>,
    haystack_session_ids: Vec<String>,
    haystack_sessions: Vec<Vec<LongMemEvalTurn>>,
}

#[derive(Deserialize)]
struct SelectionEntry {
    question_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BuiltinMessage {
    index: usize,
    role: String,
    content: String,
    anchor: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BuiltinHit {
    source_session_id: String,
    snippet: String,
    match_message_index: usize,
    messages: Vec<BuiltinMessage>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BuiltinResult {
    question_id: String,
    question_type: String,
    source_sessions: usize,
    source_messages: usize,
    index_latency_ms: u128,
    recall_latency_ms: u128,
    hits: Vec<BuiltinHit>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Output {
    schema_version: u32,
    implementation: &'static str,
    limit: usize,
    window: usize,
    results: Vec<BuiltinResult>,
}

fn sanitize_component(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect()
}

fn marker(session_id: &str, date: &str) -> String {
    format!("[LongMemEval session_id={session_id} date={date}]")
}

fn conversation_message(
    turn: &LongMemEvalTurn,
    session_id: &str,
    date: &str,
) -> ConversationMessage {
    let content = format!("{}\n{}", marker(session_id, date), turn.content);
    if turn.role == "assistant" {
        ConversationMessage::assistant(vec![ContentBlock::Text { text: content }])
    } else {
        ConversationMessage::user_text(content)
    }
}

fn load_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    let file =
        File::open(path).map_err(|error| format!("cannot open {}: {error}", path.display()))?;
    serde_json::from_reader(BufReader::new(file))
        .map_err(|error| format!("cannot parse {}: {error}", path.display()))
}

fn run(dataset_path: &Path, selection_path: &Path, output_path: &Path) -> Result<(), String> {
    let dataset: Vec<LongMemEvalRecord> = load_json(dataset_path)?;
    let selection: Vec<SelectionEntry> = load_json(selection_path)?;
    let selected_order = selection
        .iter()
        .enumerate()
        .map(|(index, entry)| (entry.question_id.as_str(), index))
        .collect::<HashMap<_, _>>();
    let mut selected = dataset
        .into_iter()
        .filter(|record| selected_order.contains_key(record.question_id.as_str()))
        .collect::<Vec<_>>();
    selected.sort_by_key(|record| selected_order[record.question_id.as_str()]);
    if selected.len() != selection.len() {
        return Err(format!(
            "selection contains {} ids but only {} exist in the dataset",
            selection.len(),
            selected.len()
        ));
    }

    let scratch = tempfile::tempdir().map_err(|error| error.to_string())?;
    let mut results = Vec::with_capacity(selected.len());
    for (record_index, record) in selected.iter().enumerate() {
        let sessions_dir = scratch
            .path()
            .join(format!(
                "{:03}-{}",
                record_index,
                sanitize_component(&record.question_id)
            ))
            .join("sessions");
        fs::create_dir_all(&sessions_dir).map_err(|error| error.to_string())?;
        let mut indexed_to_source = HashMap::new();
        let mut source_messages = 0;
        let index_started = Instant::now();
        for (session_index, turns) in record.haystack_sessions.iter().enumerate() {
            let source_session_id = record
                .haystack_session_ids
                .get(session_index)
                .ok_or_else(|| format!("{} has a missing session id", record.question_id))?;
            let date = record
                .haystack_dates
                .get(session_index)
                .ok_or_else(|| format!("{} has a missing session date", record.question_id))?;
            let indexed_id = format!(
                "{:03}-{}",
                session_index,
                sanitize_component(source_session_id)
            );
            indexed_to_source.insert(indexed_id.clone(), source_session_id.clone());
            let mut session = Session::new();
            for turn in turns {
                session
                    .messages
                    .push(conversation_message(turn, source_session_id, date));
                source_messages += 1;
            }
            session
                .save_to_path(sessions_dir.join(format!("{indexed_id}.json")))
                .map_err(|error| error.to_string())?;
        }
        let index_latency_ms = index_started.elapsed().as_millis();
        let recall_started = Instant::now();
        let search_result = search_sessions(&sessions_dir, Some(&record.question), None, 5, 5)?;
        let recall_latency_ms = recall_started.elapsed().as_millis();
        let SessionSearchResult::Search { results: hits, .. } = search_result else {
            return Err(format!(
                "{} returned a non-search result",
                record.question_id
            ));
        };
        let hits = hits
            .into_iter()
            .map(|hit| BuiltinHit {
                source_session_id: indexed_to_source
                    .get(&hit.session_id)
                    .cloned()
                    .unwrap_or(hit.session_id),
                snippet: hit.snippet,
                match_message_index: hit.match_message_index,
                messages: hit
                    .messages
                    .into_iter()
                    .map(|message| BuiltinMessage {
                        index: message.index,
                        role: message.role,
                        content: message.content,
                        anchor: message.anchor,
                    })
                    .collect(),
            })
            .collect();
        results.push(BuiltinResult {
            question_id: record.question_id.clone(),
            question_type: record.question_type.clone(),
            source_sessions: record.haystack_sessions.len(),
            source_messages,
            index_latency_ms,
            recall_latency_ms,
            hits,
        });
        println!(
            "[{}/{}] {} builtin indexed={}ms recall={}ms",
            record_index + 1,
            selected.len(),
            record.question_id,
            index_latency_ms,
            recall_latency_ms
        );
    }

    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let output = Output {
        schema_version: 1,
        implementation: "runtime::search_sessions",
        limit: 5,
        window: 5,
        results,
    };
    let bytes = serde_json::to_vec_pretty(&output).map_err(|error| error.to_string())?;
    fs::write(output_path, bytes).map_err(|error| error.to_string())
}

fn main() {
    let arguments = env::args().collect::<Vec<_>>();
    if arguments.len() != 4 {
        eprintln!(
            "Usage: longmemeval_builtin_retrieval <dataset.json> <selection.json> <output.json>"
        );
        std::process::exit(2);
    }
    if let Err(error) = run(
        Path::new(&arguments[1]),
        Path::new(&arguments[2]),
        Path::new(&arguments[3]),
    ) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
