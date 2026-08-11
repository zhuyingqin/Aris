//! Compare SomniQ's authoritative Session retrieval (R0) with the builtin
//! research-memory prompt surface (R0 + R1 + R2 + R3) on a fixed LongMemEval
//! selection. The benchmark is retrieval-only and uses no network model.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::env;
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Write};
use std::path::Path;
use std::time::Instant;

use runtime::{
    search_sessions, ContentBlock, ConversationMessage, ResearchMemoryCapture, ResearchMemoryStore,
    Session, SessionSearchResult,
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
struct LongMemEvalTurn {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct LongMemEvalRecord {
    question_id: String,
    question_type: String,
    question: String,
    haystack_dates: Vec<String>,
    haystack_session_ids: Vec<String>,
    haystack_sessions: Vec<Vec<LongMemEvalTurn>>,
}

#[derive(Debug, Deserialize)]
struct SelectionEntry {
    question_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionMessageResult {
    role: String,
    content: String,
    anchor: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionHitResult {
    source_session_id: String,
    messages: Vec<SessionMessageResult>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AtomResult {
    id: String,
    kind: String,
    status: String,
    statement: String,
    source_session_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CardResult {
    id: String,
    kind: String,
    summary: String,
    source_session_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileResult {
    content: String,
    source_session_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FusedSessionResult {
    source_session_id: String,
    score: f64,
    sources: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LayerStatsResult {
    atoms: u64,
    cards: u64,
    profiles: u64,
    conflicts: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaseResult {
    question_id: String,
    question_type: String,
    source_sessions: usize,
    source_messages: usize,
    captured_turns: usize,
    r0_index_latency_ms: u128,
    layered_index_latency_ms: u128,
    r0_recall_latency_ms: u128,
    layered_recall_latency_ms: u128,
    r0_hits: Vec<SessionHitResult>,
    r1_atoms: Vec<AtomResult>,
    r2_cards: Vec<CardResult>,
    r3_profile: Option<ProfileResult>,
    fused_top5: Vec<FusedSessionResult>,
    layer_stats: LayerStatsResult,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Output {
    schema_version: u32,
    implementation: &'static str,
    dataset_path: String,
    selection_path: String,
    cases: Vec<CaseResult>,
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

fn captures_for_session(
    project_id: &str,
    session_id: &str,
    date: &str,
    turns: &[LongMemEvalTurn],
) -> Vec<ResearchMemoryCapture> {
    let mut captures = Vec::new();
    let mut pending_user: Option<(usize, String)> = None;
    for (index, turn) in turns.iter().enumerate() {
        match turn.role.as_str() {
            "user" => pending_user = Some((index, turn.content.clone())),
            "assistant" => {
                let Some((user_index, user_text)) = pending_user.take() else {
                    continue;
                };
                if user_text.trim().is_empty() || turn.content.trim().is_empty() {
                    continue;
                }
                captures.push(ResearchMemoryCapture {
                    project_id: project_id.to_string(),
                    session_id: session_id.to_string(),
                    source_event_ids: vec![format!(
                        "longmemeval:{session_id}:{user_index}:{index}"
                    )],
                    user_text,
                    assistant_text: turn.content.clone(),
                    occurred_at: date.to_string(),
                });
            }
            _ => {}
        }
    }
    captures
}

fn rrf_add(
    scores: &mut BTreeMap<String, (f64, BTreeSet<String>)>,
    session_id: &str,
    rank: usize,
    source: &str,
) {
    let entry = scores
        .entry(session_id.to_string())
        .or_insert_with(|| (0.0, BTreeSet::new()));
    entry.0 += 1.0 / (60.0 + rank as f64);
    entry.1.insert(source.to_string());
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
    let store = ResearchMemoryStore::new(scratch.path().join("research-memory.sqlite3"));
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let checkpoint_path = output_path.with_extension("partial.jsonl");
    let checkpoint_file = File::create(&checkpoint_path)
        .map_err(|error| format!("cannot create {}: {error}", checkpoint_path.display()))?;
    let mut checkpoint = BufWriter::new(checkpoint_file);
    let mut cases = Vec::with_capacity(selected.len());
    for (record_index, record) in selected.iter().enumerate() {
        let project_id = format!("longmemeval:{}", record.question_id);
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
        let mut source_messages = 0_usize;
        let mut all_captures = Vec::new();

        let r0_index_started = Instant::now();
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
            all_captures.extend(captures_for_session(
                &project_id,
                source_session_id,
                date,
                turns,
            ));
        }
        let r0_index_latency_ms = r0_index_started.elapsed().as_millis();

        let layered_index_started = Instant::now();
        store.enqueue_captures(&all_captures)?;
        println!(
            "[{}/{}] {} enqueued {} captures in {}ms",
            record_index + 1,
            selected.len(),
            record.question_id,
            all_captures.len(),
            layered_index_started.elapsed().as_millis()
        );
        let mut drain_round = 0_usize;
        loop {
            let drain_started = Instant::now();
            let completed = store.drain_outbox(100)?;
            drain_round += 1;
            println!(
                "[{}/{}] {} drain {} completed {} in {}ms",
                record_index + 1,
                selected.len(),
                record.question_id,
                drain_round,
                completed,
                drain_started.elapsed().as_millis()
            );
            if completed < 100 {
                break;
            }
        }
        let layered_index_latency_ms = layered_index_started.elapsed().as_millis();

        let r0_recall_started = Instant::now();
        let search_result = search_sessions(&sessions_dir, Some(&record.question), None, 5, 5)?;
        let r0_recall_latency_ms = r0_recall_started.elapsed().as_millis();
        let SessionSearchResult::Search { results: hits, .. } = search_result else {
            return Err(format!(
                "{} returned a non-search result",
                record.question_id
            ));
        };
        let r0_hits = hits
            .into_iter()
            .map(|hit| SessionHitResult {
                source_session_id: indexed_to_source
                    .get(&hit.session_id)
                    .cloned()
                    .unwrap_or(hit.session_id),
                messages: hit
                    .messages
                    .into_iter()
                    .map(|message| SessionMessageResult {
                        role: message.role,
                        content: message.content,
                        anchor: message.anchor,
                    })
                    .collect(),
            })
            .collect::<Vec<_>>();

        let layered_recall_started = Instant::now();
        let recall = store.recall(&project_id, &record.question, 5, 2)?;
        let layered_recall_latency_ms = layered_recall_started.elapsed().as_millis();
        let snapshot = store.snapshot(&project_id, 200)?;
        // Cards and profiles may cite atoms older than the snapshot UI limit. Read the
        // complete provenance map so the benchmark does not under-count R2/R3 evidence.
        let connection = Connection::open(store.path()).map_err(|error| error.to_string())?;
        let mut statement = connection
            .prepare(
                "SELECT id, source_session_id FROM research_memory_atoms
                 WHERE project_id=?1 AND deleted=0",
            )
            .map_err(|error| error.to_string())?;
        let atom_sessions = statement
            .query_map([&project_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<HashMap<_, _>, _>>()
            .map_err(|error| error.to_string())?;

        let r1_atoms = recall
            .atoms
            .iter()
            .map(|atom| AtomResult {
                id: atom.id.clone(),
                kind: atom.kind.clone(),
                status: atom.status.clone(),
                statement: atom.statement.clone(),
                source_session_id: atom.source_session_id.clone(),
            })
            .collect::<Vec<_>>();
        let r2_cards = recall
            .cards
            .iter()
            .map(|card| CardResult {
                id: card.id.clone(),
                kind: card.kind.clone(),
                summary: card.summary.clone(),
                source_session_ids: card
                    .atom_ids
                    .iter()
                    .filter_map(|atom_id| atom_sessions.get(atom_id))
                    .cloned()
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect(),
            })
            .collect::<Vec<_>>();
        let r3_profile = recall.profile.as_ref().map(|profile| ProfileResult {
            content: profile.content.clone(),
            source_session_ids: profile
                .atom_ids
                .iter()
                .filter_map(|atom_id| atom_sessions.get(atom_id))
                .cloned()
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect(),
        });

        let mut fused_scores = BTreeMap::new();
        for (rank, hit) in r0_hits.iter().enumerate() {
            rrf_add(&mut fused_scores, &hit.source_session_id, rank + 1, "r0");
        }
        let mut seen_r1 = BTreeSet::new();
        for (rank, atom) in r1_atoms.iter().enumerate() {
            if seen_r1.insert(atom.source_session_id.clone()) {
                rrf_add(&mut fused_scores, &atom.source_session_id, rank + 1, "r1");
            }
        }
        let mut seen_r2 = BTreeSet::new();
        for (rank, card) in r2_cards.iter().enumerate() {
            for session_id in &card.source_session_ids {
                if seen_r2.insert(session_id.clone()) {
                    rrf_add(&mut fused_scores, session_id, rank + 1, "r2");
                }
            }
        }
        let mut fused_top5 = fused_scores
            .into_iter()
            .map(|(source_session_id, (score, sources))| FusedSessionResult {
                source_session_id,
                score,
                sources: sources.into_iter().collect(),
            })
            .collect::<Vec<_>>();
        fused_top5.sort_by(|left, right| {
            right
                .score
                .total_cmp(&left.score)
                .then_with(|| left.source_session_id.cmp(&right.source_session_id))
        });
        fused_top5.truncate(5);

        cases.push(CaseResult {
            question_id: record.question_id.clone(),
            question_type: record.question_type.clone(),
            source_sessions: record.haystack_sessions.len(),
            source_messages,
            captured_turns: all_captures.len(),
            r0_index_latency_ms,
            layered_index_latency_ms,
            r0_recall_latency_ms,
            layered_recall_latency_ms,
            r0_hits,
            r1_atoms,
            r2_cards,
            r3_profile,
            fused_top5,
            layer_stats: LayerStatsResult {
                atoms: snapshot.stats.atom_count,
                cards: snapshot.stats.card_count,
                profiles: snapshot.stats.profile_count,
                conflicts: snapshot.stats.conflict_count,
            },
        });
        println!(
            "[{}/{}] {} R0={}ms layers={}ms recall=({}ms+{}ms) atoms={} cards={}",
            record_index + 1,
            selected.len(),
            record.question_id,
            r0_index_latency_ms,
            layered_index_latency_ms,
            r0_recall_latency_ms,
            layered_recall_latency_ms,
            snapshot.stats.atom_count,
            snapshot.stats.card_count,
        );
        serde_json::to_writer(
            &mut checkpoint,
            cases.last().expect("case was just appended"),
        )
        .map_err(|error| error.to_string())?;
        checkpoint
            .write_all(b"\n")
            .and_then(|()| checkpoint.flush())
            .map_err(|error| error.to_string())?;
    }

    let output = Output {
        schema_version: 1,
        implementation: "SomniQ builtin research memory R0-R3",
        dataset_path: dataset_path.display().to_string(),
        selection_path: selection_path.display().to_string(),
        cases,
    };
    fs::write(
        output_path,
        serde_json::to_vec_pretty(&output).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

fn main() {
    let arguments = env::args().collect::<Vec<_>>();
    if arguments.len() != 4 {
        eprintln!(
            "Usage: longmemeval_research_layers <dataset.json> <selection.json> <output.json>"
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
