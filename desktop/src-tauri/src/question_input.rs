//! Reads `AskUserQuestion` input the way models actually write it.
//!
//! The tool takes one flat question object, but models trained on other
//! agents' `AskUserQuestion` (`{"questions": [{...}]}`) keep reaching for that
//! shape. Every observed failure still stated its question unambiguously: a
//! flat object carrying the closing `]}` of a wrapper that was never opened,
//! the wrapper itself, XML-style `{"item": [...]}` lists, or `"false"` for a
//! boolean. Those are read rather than rejected; only input with no
//! recoverable question fails, with the same messages as before.

use serde_json::{Map, Value};

/// The question to show, as the canonical flat object the UI and the work-task
/// board render, plus the text of any further questions the payload carried.
/// The card asks one question per call, so those are reported back to the
/// model instead of being silently dropped.
#[derive(Debug)]
pub(crate) struct QuestionInput {
    pub(crate) question: Value,
    pub(crate) unasked: Vec<String>,
}

pub(crate) fn read_question_input(input: &str) -> Result<QuestionInput, String> {
    let values = parse_lenient(input).map_err(|error| {
        // Naming the expected shape matters as much as the parse position: a
        // bare "must be valid JSON" invites a retry that adds a `questions`
        // wrapper instead of fixing the object.
        format!(
            "AskUserQuestion input must be valid JSON: {error}. Expected one object shaped \
             {{\"question\": \"...\", \"options\": [{{\"label\": \"...\"}}]}}, not an array of \
             questions."
        )
    })?;
    let mut questions = Vec::new();
    for value in values {
        collect_questions(value, &mut questions);
    }
    let mut questions = questions.into_iter();
    let first = questions.next().ok_or_else(|| {
        "AskUserQuestion input must be an object with `question` and `options`.".to_string()
    })?;
    let question = canonical_question(&first)?;
    let unasked = questions
        .filter_map(|object| non_empty_text(object.get("question")))
        .collect();
    Ok(QuestionInput { question, unasked })
}

impl QuestionInput {
    /// The tool result for the user's answer, naming any questions the card
    /// did not show so the model asks them in follow-up calls.
    pub(crate) fn tool_result(&self, answer: String) -> String {
        if self.unasked.is_empty() {
            return answer;
        }
        let unasked = self
            .unasked
            .iter()
            .map(|question| format!("- {question}"))
            .collect::<Vec<_>>()
            .join("\n");
        format!(
            "{answer}\n\nOnly the first question was shown: AskUserQuestion asks one question per \
             call. Not asked yet:\n{unasked}"
        )
    }
}

/// Strict JSON first; otherwise drop stray closers and read what remains as
/// one or more values. The strict error is the one reported, since its
/// position refers to the text the model actually wrote.
fn parse_lenient(input: &str) -> Result<Vec<Value>, serde_json::Error> {
    let strict = match serde_json::from_str::<Value>(input) {
        Ok(value) => return Ok(vec![value]),
        Err(error) => error,
    };
    parse_sequence(&drop_stray_closers(input)).ok_or(strict)
}

/// Values written back to back, optionally comma-separated: the shape of a
/// model emitting one object per question.
fn parse_sequence(text: &str) -> Option<Vec<Value>> {
    let mut values = Vec::new();
    let mut rest = text.trim_start();
    while !rest.is_empty() {
        let mut stream = serde_json::Deserializer::from_str(rest).into_iter::<Value>();
        let value = stream.next()?.ok()?;
        if !(value.is_object() || value.is_array()) {
            return None;
        }
        rest = rest[stream.byte_offset()..]
            .trim_start_matches(|ch: char| ch.is_whitespace() || ch == ',');
        values.push(value);
    }
    (!values.is_empty()).then_some(values)
}

/// Removes closing brackets that close nothing, close the wrong kind of
/// container, or close the root object while more of its members follow.
///
/// Those are the leftovers of a `{"questions": [{...}]}` wrapper written
/// around a flat object: `...]}]}` at the end, or `...]}], "question": ...}`
/// part-way through. Nothing is ever added, so truncated input stays invalid.
fn drop_stray_closers(input: &str) -> String {
    let chars = input.chars().collect::<Vec<_>>();
    let mut repaired = String::with_capacity(input.len());
    let mut open = Vec::new();
    let mut in_string = false;
    let mut escaped = false;
    for (index, &ch) in chars.iter().enumerate() {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            repaired.push(ch);
            continue;
        }
        match ch {
            '"' => in_string = true,
            '{' => open.push('}'),
            '[' => open.push(']'),
            '}' | ']' => {
                if open.last() != Some(&ch)
                    || (ch == '}' && open.len() == 1 && members_follow(&chars[index + 1..]))
                {
                    continue;
                }
                open.pop();
            }
            _ => {}
        }
        repaired.push(ch);
    }
    repaired
}

/// Whether the text after a root `}` continues that object: any further stray
/// closers, then a comma and a key.
fn members_follow(rest: &[char]) -> bool {
    let mut significant = rest
        .iter()
        .copied()
        .filter(|ch| !ch.is_whitespace())
        .skip_while(|ch| matches!(ch, '}' | ']'));
    significant.next() == Some(',') && significant.next() == Some('"')
}

fn collect_questions(value: Value, questions: &mut Vec<Map<String, Value>>) {
    match unwrap_items(value) {
        Value::Array(items) => {
            for item in items {
                collect_questions(item, questions);
            }
        }
        Value::Object(mut object) => match object.remove("questions") {
            Some(inner) if !object.contains_key("question") => collect_questions(inner, questions),
            _ => questions.push(object),
        },
        _ => {}
    }
}

/// `{"item": [...]}`: some models wrap every list XML-style.
fn unwrap_items(value: Value) -> Value {
    match value {
        Value::Object(mut object) if object.len() == 1 => {
            match object.remove("item").or_else(|| object.remove("items")) {
                Some(inner) => inner,
                None => Value::Object(object),
            }
        }
        other => other,
    }
}

fn canonical_question(object: &Map<String, Value>) -> Result<Value, String> {
    let question = non_empty_text(object.get("question")).ok_or_else(|| {
        "AskUserQuestion input must include a non-empty `question` string.".to_string()
    })?;
    let Some(Value::Array(options)) = object.get("options").cloned().map(unwrap_items) else {
        return Err("AskUserQuestion input must include an `options` array.".to_string());
    };
    let options = options
        .iter()
        .filter_map(canonical_option)
        .collect::<Vec<_>>();
    if options.is_empty() {
        return Err(
            "AskUserQuestion input must include at least one option with a non-empty `label`."
                .to_string(),
        );
    }
    let mut canonical = Map::new();
    canonical.insert("question".into(), Value::String(question));
    if let Some(header) = non_empty_text(object.get("header")) {
        canonical.insert("header".into(), Value::String(header));
    }
    canonical.insert("options".into(), Value::Array(options));
    for key in ["multiSelect", "allowCustom"] {
        if let Some(flag) = object.get(key).and_then(flag) {
            canonical.insert(key.into(), Value::Bool(flag));
        }
    }
    Ok(Value::Object(canonical))
}

/// An option object, or a bare label string.
fn canonical_option(option: &Value) -> Option<Value> {
    let (label, description) = match option {
        Value::String(label) => (trimmed(label)?, None),
        Value::Object(object) => (
            non_empty_text(object.get("label"))?,
            non_empty_text(object.get("description")),
        ),
        _ => return None,
    };
    let mut canonical = Map::new();
    canonical.insert("label".into(), Value::String(label));
    if let Some(description) = description {
        canonical.insert("description".into(), Value::String(description));
    }
    Some(Value::Object(canonical))
}

fn non_empty_text(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).and_then(trimmed)
}

fn trimmed(text: &str) -> Option<String> {
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

fn flag(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(flag) => Some(*flag),
        Value::String(text) if text.trim().eq_ignore_ascii_case("true") => Some(true),
        Value::String(text) if text.trim().eq_ignore_ascii_case("false") => Some(false),
        _ => None,
    }
}

#[cfg(test)]
#[path = "tests/question_input.rs"]
mod tests;
