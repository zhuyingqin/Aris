//! Desktop commands for the project knowledge base — thin wrappers over the
//! shared kernel implementation in `tools::knowledge`, so the desktop UI, CLI
//! agents, and Chat all operate on the same `papers/knowledge.db` contract.
//!
//! Confirmation authority lives here: `knowledge_upsert` only ever writes
//! drafts (`allow_confirm = false`), and `knowledge_confirm` — driven solely by
//! the user's review UI — is the one path that promotes a draft to `confirmed`.
//! `knowledge_generate` asks the configured chat model (via the shared
//! `run_oneshot`) to propose candidate points from a paper's reading record,
//! then persists them as drafts for the human to filter.

use serde_json::{json, Value};
use tauri::State;

use runtime::ConversationMessage;

use crate::literature::run_oneshot;
use crate::projects::{self, ProjectState};

fn project_base(projects_state: &ProjectState) -> Result<std::path::PathBuf, String> {
    projects::current_project_path(projects_state)
}

#[tauri::command]
pub fn knowledge_load(projects_state: State<ProjectState>) -> Result<Value, String> {
    tools::knowledge::knowledge_load_at(&project_base(&projects_state)?)
}

#[tauri::command]
pub fn knowledge_search(
    projects_state: State<ProjectState>,
    query: String,
    limit: Option<usize>,
) -> Result<Value, String> {
    let base = project_base(&projects_state)?;
    let limit = limit.unwrap_or(8).clamp(1, 50);
    let result = tools::knowledge::knowledge_search_at(&base, &query, limit)?;
    serde_json::to_value(result).map_err(|e| e.to_string())
}

/// Record proposed points as DRAFTS (never confirms — confirmation is a
/// separate user action via `knowledge_confirm`).
#[tauri::command]
pub fn knowledge_upsert(
    projects_state: State<ProjectState>,
    points: Vec<Value>,
) -> Result<Value, String> {
    let base = project_base(&projects_state)?;
    let parsed = parse_points(points)?;
    let stats = tools::knowledge::knowledge_upsert_at(&base, &parsed, false)?;
    serde_json::to_value(stats).map_err(|e| e.to_string())
}

/// The ONLY path that confirms a knowledge point. Invoked by the review UI.
#[tauri::command]
pub fn knowledge_confirm(projects_state: State<ProjectState>, kp_id: String) -> Result<(), String> {
    tools::knowledge::knowledge_confirm_at(&project_base(&projects_state)?, &kp_id)
}

#[tauri::command]
pub fn knowledge_reject(
    projects_state: State<ProjectState>,
    kp_id: String,
) -> Result<bool, String> {
    tools::knowledge::knowledge_delete_at(&project_base(&projects_state)?, &kp_id)
}

/// Ask the configured chat model to propose candidate knowledge points from a
/// paper's reading record (brief + evidence + answer chains), persist them as
/// drafts, and return the candidates (with evidence) for the review UI.
#[tauri::command]
pub async fn knowledge_generate(
    projects_state: State<'_, ProjectState>,
    paper_id: String,
) -> Result<Value, String> {
    let base = project_base(&projects_state)?;
    tauri::async_runtime::spawn_blocking(move || generate_candidates(&base, &paper_id))
        .await
        .map_err(|e| e.to_string())?
}

fn parse_points(points: Vec<Value>) -> Result<Vec<tools::knowledge::KnowledgePointInput>, String> {
    points
        .into_iter()
        .map(|point| serde_json::from_value(point).map_err(|e| e.to_string()))
        .collect()
}

fn generate_candidates(base: &std::path::Path, paper_id: &str) -> Result<Value, String> {
    let library = tools::literature::library_load_at(base)?;
    let paper = library["papers"]
        .as_array()
        .and_then(|papers| {
            papers
                .iter()
                .find(|paper| paper["id"].as_str() == Some(paper_id))
        })
        .ok_or_else(|| format!("paper `{paper_id}` not found in the library"))?;

    let project_focus = library["projectFocus"].clone();
    let prompt = build_generation_prompt(paper, &project_focus);
    let raw = run_oneshot(GENERATION_SYSTEM, ConversationMessage::user_text(prompt))?;
    let candidates = parse_candidates(&raw, paper_id)?;
    if candidates.is_empty() {
        return Ok(json!({
            "candidates": [],
            "warning": "The model returned no anchored knowledge points for this paper.",
        }));
    }

    let stats = tools::knowledge::knowledge_upsert_at(base, &candidates, false)?;
    // Pair each stored id back with the candidate so the UI can render cards.
    let cards: Vec<Value> = candidates
        .iter()
        .zip(stats.ids.iter())
        .map(|(point, id)| {
            json!({
                "id": id,
                "question": point.question,
                "answer": point.answer,
                "statement": point.statement,
                "kind": point.kind,
                "status": "draft",
                "sourcePaperId": point.source_paper_id,
                "evidence": point.evidence.iter().map(evidence_json).collect::<Vec<_>>(),
            })
        })
        .collect();
    Ok(json!({ "candidates": cards }))
}

fn evidence_json(item: &tools::knowledge::EvidenceInput) -> Value {
    json!({
        "paperId": item.paper_id,
        "page": item.page,
        "quote": item.quote,
        "role": item.role,
        "annotationId": item.annotation_id,
        "evidenceId": item.evidence_id,
    })
}

const GENERATION_SYSTEM: &str = "You distill a researcher's reading of one paper into reusable \
knowledge points. Each point pairs the original question, the answer the reader reached, and a \
condensed one-sentence statement, and MUST be grounded in evidence drawn ONLY from the material \
provided (page + verbatim quote). Never invent pages, quotes, or claims that the provided text does \
not support. Respond with a single JSON array and nothing else.";

fn build_generation_prompt(paper: &Value, project_focus: &Value) -> String {
    let title = paper["title"].as_str().unwrap_or("(untitled)");
    let paper_id = paper["id"].as_str().unwrap_or("");
    let mut sections = vec![format!("PAPER\nid: {paper_id}\ntitle: {title}")];

    if let Some(abstract_text) = paper["abstract"].as_str().filter(|t| !t.trim().is_empty()) {
        sections.push(format!("ABSTRACT\n{abstract_text}"));
    }
    if project_focus.is_object() {
        sections.push(format!(
            "PROJECT FOCUS (the reader's frame — favour points relevant to this)\n{}",
            serde_json::to_string_pretty(project_focus).unwrap_or_default()
        ));
    }
    if let Some(brief) = paper.get("brief").filter(|b| b.is_object()) {
        sections.push(format!(
            "BRIEF\n{}",
            serde_json::to_string_pretty(brief).unwrap_or_default()
        ));
    }
    if let Some(evidence) = paper["evidence"].as_array().filter(|e| !e.is_empty()) {
        sections.push(format!(
            "EVIDENCE NOTES (page-anchored excerpts the reader saved)\n{}",
            serde_json::to_string_pretty(evidence).unwrap_or_default()
        ));
    }
    if let Some(chains) = paper["answerChains"].as_array().filter(|c| !c.is_empty()) {
        sections.push(format!(
            "ANSWER CHAINS (question -> answer -> supporting annotations)\n{}",
            serde_json::to_string_pretty(chains).unwrap_or_default()
        ));
    }
    if let Some(annotations) = paper["pdfAnnotations"].as_array().filter(|a| !a.is_empty()) {
        sections.push(format!(
            "PDF ANNOTATIONS (id, page, quote — use ids as annotationId anchors)\n{}",
            serde_json::to_string_pretty(annotations).unwrap_or_default()
        ));
    }

    sections.push(format!(
        "TASK\nPropose up to 6 knowledge points the reader would want to reuse in future research. \
         Return ONLY a JSON array; each element:\n\
         {{\n  \"question\": string,           // the question this answers\n\
         \"answer\": string,             // the reader's answer, 1-3 sentences\n\
         \"statement\": string,          // one-sentence condensed conclusion for retrieval\n\
         \"kind\": string,               // finding | method | definition | relation\n\
         \"evidence\": [ {{ \"paperId\": \"{paper_id}\", \"page\": number, \"quote\": string, \
         \"annotationId\": string (optional), \"evidenceId\": string (optional) }} ]\n}}\n\
         Every point MUST include at least one evidence item with a verbatim quote taken from the \
         material above. Drop any point you cannot anchor."
    ));
    sections.join("\n\n")
}

fn parse_candidates(
    raw: &str,
    paper_id: &str,
) -> Result<Vec<tools::knowledge::KnowledgePointInput>, String> {
    let array = extract_json_array(raw)
        .ok_or_else(|| "the model did not return a JSON array of knowledge points".to_string())?;
    let Value::Array(items) = array else {
        return Ok(Vec::new());
    };
    let mut points = Vec::new();
    for item in items {
        let Ok(mut point) =
            serde_json::from_value::<tools::knowledge::KnowledgePointInput>(item.clone())
        else {
            continue;
        };
        // Enforce the iron rule: keep only anchored points, default the paperId
        // to this paper, and clear any model-supplied id/status (drafts only).
        point.evidence.retain(|e| {
            !e.quote.trim().is_empty() || e.annotation_id.is_some() || e.evidence_id.is_some()
        });
        for evidence in &mut point.evidence {
            if evidence.paper_id.trim().is_empty() {
                evidence.paper_id = paper_id.to_string();
            }
        }
        if point.evidence.is_empty() || point.statement.trim().is_empty() {
            continue;
        }
        point.id = None;
        point.status = None;
        point.source_paper_id = Some(paper_id.to_string());
        points.push(point);
    }
    Ok(points)
}

/// Pull the first balanced JSON array out of an LLM reply (handles ```json
/// fences and surrounding prose).
fn extract_json_array(raw: &str) -> Option<Value> {
    if let Ok(value @ Value::Array(_)) = serde_json::from_str::<Value>(raw.trim()) {
        return Some(value);
    }
    let start = raw.find('[')?;
    let mut depth = 0_i32;
    let mut in_string = false;
    let mut escaped = false;
    for (offset, ch) in raw[start..].char_indices() {
        match ch {
            '"' if !escaped => in_string = !in_string,
            '\\' if in_string => {
                escaped = !escaped;
                continue;
            }
            '[' if !in_string => depth += 1,
            ']' if !in_string => {
                depth -= 1;
                if depth == 0 {
                    let end = start + offset + 1;
                    return serde_json::from_str::<Value>(&raw[start..end]).ok();
                }
            }
            _ => {}
        }
        escaped = false;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{extract_json_array, parse_candidates};

    #[test]
    fn extracts_json_array_from_fenced_reply() {
        let raw = "Here you go:\n```json\n[{\"question\":\"q\",\"answer\":\"a\",\
                   \"statement\":\"s\",\"evidence\":[{\"paperId\":\"arxiv:1\",\"page\":2,\
                   \"quote\":\"hello\"}]}]\n```\nDone.";
        let array = extract_json_array(raw).expect("array");
        assert!(array.is_array());
        assert_eq!(array.as_array().unwrap().len(), 1);
    }

    #[test]
    fn drops_candidates_without_anchors_and_defaults_paper_id() {
        let raw = "[\
            {\"question\":\"q1\",\"answer\":\"a1\",\"statement\":\"s1\",\
             \"evidence\":[{\"paperId\":\"\",\"page\":3,\"quote\":\"grounded\"}]},\
            {\"question\":\"q2\",\"answer\":\"a2\",\"statement\":\"s2\",\"evidence\":[]}\
        ]";
        let points = parse_candidates(raw, "arxiv:42").expect("parse");
        assert_eq!(points.len(), 1);
        assert_eq!(points[0].statement, "s1");
        assert_eq!(points[0].evidence[0].paper_id, "arxiv:42");
        assert_eq!(points[0].source_paper_id.as_deref(), Some("arxiv:42"));
    }
}
