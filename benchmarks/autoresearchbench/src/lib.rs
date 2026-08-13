use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskType {
    Deep,
    Wide,
}

impl TaskType {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Deep => "deep",
            Self::Wide => "wide",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Candidate {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arxiv_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentAnswer {
    #[serde(default)]
    pub candidates: Vec<Candidate>,
    #[serde(default)]
    pub none: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolTrace {
    pub call_index: usize,
    pub tool_name: String,
    pub input: Value,
    pub output_excerpt: String,
    pub is_error: bool,
    pub elapsed_ms: u128,
}

pub fn load_jsonl(path: &Path) -> Result<Vec<Value>, String> {
    let file = File::open(path).map_err(|error| format!("open {}: {error}", path.display()))?;
    let mut records = Vec::new();
    for (index, line) in BufReader::new(file).lines().enumerate() {
        let line =
            line.map_err(|error| format!("read {} line {}: {error}", path.display(), index + 1))?;
        if line.trim().is_empty() {
            continue;
        }
        let record: Value = serde_json::from_str(&line)
            .map_err(|error| format!("parse {} line {}: {error}", path.display(), index + 1))?;
        let question = record
            .get("question")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if question.trim().is_empty() {
            return Err(format!(
                "{} line {} has no question",
                path.display(),
                index + 1
            ));
        }
        records.push(record);
    }
    if records.is_empty() {
        return Err(format!("{} contains no benchmark records", path.display()));
    }
    Ok(records)
}

pub fn benchmark_user_prompt(record: &Value, task_type: TaskType) -> Result<String, String> {
    let question = record
        .get("question")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|question| !question.is_empty())
        .ok_or_else(|| "benchmark record has no question".to_string())?;
    Ok(format!(
        "Task type: {}\n\nResearch question:\n{}\n\nFind the qualifying paper or papers. Do not infer or request any hidden answer field.",
        task_type.as_str(),
        question
    ))
}

#[must_use]
pub fn infer_task_type(record: &Value) -> TaskType {
    if let Some(task_type) = record.get("type").and_then(Value::as_str) {
        if task_type.eq_ignore_ascii_case("wide") {
            return TaskType::Wide;
        }
        if task_type.eq_ignore_ascii_case("deep") {
            return TaskType::Deep;
        }
    }
    if record.get("arxiv_id").is_some_and(Value::is_array)
        || record
            .get("answer")
            .and_then(Value::as_array)
            .is_some_and(|answers| answers.len() > 1)
    {
        TaskType::Wide
    } else {
        TaskType::Deep
    }
}

#[must_use]
pub fn record_id(question: &str) -> String {
    let digest = Sha256::digest(question.as_bytes());
    digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn parse_agent_answer(text: &str, task_type: TaskType) -> Result<AgentAnswer, String> {
    let value = extract_json_value(text).ok_or_else(|| {
        "agent did not return a JSON object containing `candidates` and `none`".to_string()
    })?;
    let mut answer = answer_from_value(&value)?;
    normalize_candidates(&mut answer.candidates);
    if task_type == TaskType::Deep && answer.candidates.len() > 1 {
        answer.candidates.truncate(1);
    }
    if answer.none {
        answer.candidates.clear();
    } else if answer.candidates.is_empty() {
        answer.none = true;
    }
    Ok(answer)
}

#[must_use]
pub fn extract_json_value(text: &str) -> Option<Value> {
    let trimmed = text.trim();
    if let Ok(value) = serde_json::from_str(trimmed) {
        return Some(value);
    }

    let unfenced = trimmed
        .lines()
        .filter(|line| !line.trim_start().starts_with("```"))
        .collect::<Vec<_>>()
        .join("\n");
    if let Ok(value) = serde_json::from_str(unfenced.trim()) {
        return Some(value);
    }

    for (open, close) in [('{', '}'), ('[', ']')] {
        let Some(start) = unfenced.find(open) else {
            continue;
        };
        let Some(end) = unfenced.rfind(close) else {
            continue;
        };
        if start < end {
            if let Ok(value) = serde_json::from_str(&unfenced[start..=end]) {
                return Some(value);
            }
        }
    }
    None
}

fn answer_from_value(value: &Value) -> Result<AgentAnswer, String> {
    let (candidate_values, none) = match value {
        Value::Array(items) => (items.as_slice(), false),
        Value::Object(object) => {
            let candidates = object
                .get("candidates")
                .or_else(|| object.get("final_candidates"))
                .or_else(|| object.get("papers"))
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default();
            let none = object.get("none").and_then(Value::as_bool).unwrap_or(false)
                || object
                    .get("candidate_state")
                    .and_then(Value::as_str)
                    .is_some_and(|state| state.eq_ignore_ascii_case("none"));
            (candidates, none)
        }
        _ => return Err("agent JSON must be an object or array".to_string()),
    };

    let mut candidates = Vec::new();
    for value in candidate_values {
        if let Some(candidate) = candidate_from_value(value) {
            candidates.push(candidate);
        }
    }
    Ok(AgentAnswer { candidates, none })
}

fn candidate_from_value(value: &Value) -> Option<Candidate> {
    if let Some(title) = value
        .as_str()
        .map(str::trim)
        .filter(|title| !title.is_empty())
    {
        return Some(Candidate {
            title: title.to_string(),
            arxiv_id: None,
            url: None,
            reason: None,
        });
    }
    let object = value.as_object()?;
    let metadata = object.get("metadata").and_then(Value::as_object);
    let title = string_field(object, &["title", "paper_title"])
        .or_else(|| metadata.and_then(|value| string_field(value, &["title", "paper_title"])))?;
    let arxiv_id = string_field(object, &["arxiv_id", "arxivId", "arxiv"])
        .or_else(|| {
            metadata.and_then(|value| string_field(value, &["arxiv_id", "arxivId", "arxiv"]))
        })
        .and_then(|value| normalize_arxiv_id(&value));
    let url = string_field(object, &["url", "paper_url"])
        .or_else(|| metadata.and_then(|value| string_field(value, &["url", "paper_url"])));
    let reason = string_field(object, &["reason", "rationale", "summary"]);
    Some(Candidate {
        title,
        arxiv_id,
        url,
        reason,
    })
}

fn string_field(object: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| object.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn normalize_candidates(candidates: &mut Vec<Candidate>) {
    let mut seen = BTreeSet::new();
    candidates.retain_mut(|candidate| {
        candidate.title = candidate.title.trim().to_string();
        candidate.arxiv_id = candidate.arxiv_id.as_deref().and_then(normalize_arxiv_id);
        let key = candidate.title.to_lowercase();
        !candidate.title.is_empty() && seen.insert(key)
    });
}

#[must_use]
pub fn normalize_arxiv_id(value: &str) -> Option<String> {
    let value = value.trim();
    for (index, _) in value.char_indices() {
        let tail = &value[index..];
        let Some(dot) = tail.find('.') else {
            continue;
        };
        if dot != 4 || !tail[..dot].bytes().all(|byte| byte.is_ascii_digit()) {
            continue;
        }
        let digits = tail[dot + 1..]
            .bytes()
            .take_while(u8::is_ascii_digit)
            .count();
        if (4..=5).contains(&digits) {
            return Some(tail[..dot + 1 + digits].to_string());
        }
    }
    None
}

#[must_use]
pub fn official_candidate(candidate: &Candidate, id: usize) -> Value {
    let mut metadata = Map::new();
    metadata.insert("title".to_string(), Value::String(candidate.title.clone()));
    if let Some(arxiv_id) = &candidate.arxiv_id {
        metadata.insert("arxiv_id".to_string(), Value::String(arxiv_id.clone()));
        metadata.insert("arxivId".to_string(), Value::String(arxiv_id.clone()));
        metadata.insert("external_ids".to_string(), json!({"ArXiv": arxiv_id}));
        metadata.insert("externalIds".to_string(), json!({"ArXiv": arxiv_id}));
    }
    if let Some(url) = &candidate.url {
        metadata.insert("url".to_string(), Value::String(url.clone()));
    }
    if let Some(reason) = &candidate.reason {
        metadata.insert("summary".to_string(), Value::String(reason.clone()));
    }
    json!({
        "id": id,
        "title": candidate.title,
        "arxiv_id": candidate.arxiv_id,
        "metadata": metadata,
    })
}

#[must_use]
pub fn official_result(context: OfficialResultContext<'_>) -> Value {
    let final_candidates = context
        .answer
        .candidates
        .iter()
        .enumerate()
        .map(|(id, candidate)| official_candidate(candidate, id))
        .collect::<Vec<_>>();
    let turn_details = context
        .traces
        .iter()
        .map(|trace| {
            json!({
                "turn": trace.call_index,
                "duration": trace.elapsed_ms as f64 / 1000.0,
                "action": if trace.is_error { "error" } else { "tool" },
                "action_content": {"name": trace.tool_name, "arguments": trace.input},
                "papers_retrieved_this_turn": Value::Null,
            })
        })
        .collect::<Vec<_>>();
    json!({
        "input_data": context.input_data,
        "inference_results": [{
            "pass_id": context.pass_id,
            "status": context.status,
            "total_time": context.elapsed_seconds,
            "messages": [{"role": "assistant", "content": context.final_text}],
            "final_candidates": final_candidates,
            "final_candidate_state": if context.answer.none { "none" } else { "ids" },
            "turn_details": turn_details,
            "somniq": {
                "usage": context.usage,
                "tool_trace": context.traces,
                "reviewer": context.reviewer,
            }
        }]
    })
}

pub struct OfficialResultContext<'a> {
    pub input_data: Value,
    pub pass_id: usize,
    pub status: &'a str,
    pub elapsed_seconds: f64,
    pub answer: &'a AgentAnswer,
    pub final_text: &'a str,
    pub traces: &'a [ToolTrace],
    pub usage: Value,
    pub reviewer: Option<Value>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn infers_deep_and_wide_records() {
        assert_eq!(
            infer_task_type(&json!({"question":"q", "arxiv_id":"2601.00001"})),
            TaskType::Deep
        );
        assert_eq!(
            infer_task_type(&json!({"question":"q", "arxiv_id":["2601.00001"]})),
            TaskType::Wide
        );
    }

    #[test]
    fn parses_fenced_answer_and_normalizes_candidates() {
        let answer = parse_agent_answer(
            "result:\n```json\n{\"candidates\":[{\"title\":\" Paper A \",\"arxiv_id\":\"https://arxiv.org/abs/2601.12345v2\"},{\"title\":\"paper a\"}],\"none\":false}\n```",
            TaskType::Wide,
        )
        .expect("parse answer");
        assert_eq!(answer.candidates.len(), 1);
        assert_eq!(answer.candidates[0].title, "Paper A");
        assert_eq!(answer.candidates[0].arxiv_id.as_deref(), Some("2601.12345"));
    }

    #[test]
    fn deep_answer_keeps_only_one_candidate() {
        let answer = parse_agent_answer(
            r#"{"candidates":[{"title":"A"},{"title":"B"}],"none":false}"#,
            TaskType::Deep,
        )
        .expect("parse answer");
        assert_eq!(answer.candidates.len(), 1);
    }

    #[test]
    fn none_state_clears_candidates() {
        let answer = parse_agent_answer(
            r#"{"candidates":[{"title":"A"}],"none":true}"#,
            TaskType::Wide,
        )
        .expect("parse answer");
        assert!(answer.none);
        assert!(answer.candidates.is_empty());
    }

    #[test]
    fn official_candidate_contains_common_arxiv_fields() {
        let value = official_candidate(
            &Candidate {
                title: "Paper".to_string(),
                arxiv_id: Some("2601.12345".to_string()),
                url: None,
                reason: None,
            },
            0,
        );
        assert_eq!(value["metadata"]["external_ids"]["ArXiv"], "2601.12345");
        assert_eq!(value["metadata"]["arxivId"], "2601.12345");
    }

    #[test]
    fn user_prompt_never_contains_ground_truth_fields() {
        let record = json!({
            "question": "Find the paper from these clues",
            "answer": ["SECRET TITLE"],
            "arxiv_id": "2601.99999"
        });
        let prompt = benchmark_user_prompt(&record, TaskType::Deep).expect("build prompt");
        assert!(prompt.contains("Find the paper from these clues"));
        assert!(!prompt.contains("SECRET TITLE"));
        assert!(!prompt.contains("2601.99999"));
    }
}
