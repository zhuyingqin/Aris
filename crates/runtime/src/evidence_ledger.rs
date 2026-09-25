//! Per-turn evidence novelty tracking for tool loops.
//!
//! Tool-call count is not progress: several differently phrased calls can keep
//! returning the same page, status, empty result, or failure. This ledger uses
//! deterministic fingerprints to distinguish a new observation from another
//! copy of an observation the turn already has. It never judges whether the
//! evidence is good; it only records whether it is new.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::OnceLock;

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::compact::is_internal_user_message;
use crate::session::{ContentBlock, ConversationMessage, MessageRole};

pub const NO_NEW_EVIDENCE_NUDGE_CALLS: usize = 4;
pub const NO_NEW_EVIDENCE_BLOCK_CALLS: usize = 6;
const POLLING_BLOCK_MULTIPLIER: usize = 2;
const MIN_IDENTICAL_INVOCATIONS_TO_BLOCK: usize = 3;
const MIN_IDENTICAL_OUTCOMES_TO_BLOCK: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvidenceGuardMode {
    Off,
    Nudge,
    Block,
}

impl EvidenceGuardMode {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Nudge => "nudge",
            Self::Block => "block",
        }
    }
}

#[must_use]
pub fn evidence_guard_mode() -> EvidenceGuardMode {
    static MODE: OnceLock<EvidenceGuardMode> = OnceLock::new();
    *MODE.get_or_init(|| {
        match std::env::var("ARIS_EVIDENCE_LOOP_GUARD")
            .unwrap_or_else(|_| "block".to_string())
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "off" | "0" | "false" => EvidenceGuardMode::Off,
            "nudge" | "shadow" | "warn" => EvidenceGuardMode::Nudge,
            _ => EvidenceGuardMode::Block,
        }
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvidenceNovelty {
    New,
    Repeated,
    Empty,
}

impl EvidenceNovelty {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::New => "new",
            Self::Repeated => "repeated",
            Self::Empty => "empty",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvidenceObservation {
    pub tool_name: String,
    pub novelty: EvidenceNovelty,
    pub fingerprint: Option<String>,
    pub consecutive_no_new: usize,
    pub unique_evidence: usize,
    pub total_observations: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvidenceLoopBlock {
    pub message: String,
    pub consecutive_no_new: usize,
    pub identical_invocations: usize,
    pub identical_outcomes: usize,
}

#[derive(Debug, Clone, Default)]
pub struct EvidenceLedger {
    seen_evidence: HashSet<String>,
    invocation_counts: HashMap<String, usize>,
    repeated_outcomes: HashMap<String, (String, usize)>,
    total_observations: usize,
    repeated_observations: usize,
    empty_observations: usize,
    consecutive_no_new: usize,
    last_nudged_at: Option<usize>,
}

impl EvidenceLedger {
    #[must_use]
    pub fn observe(
        &mut self,
        tool_name: &str,
        input: &str,
        output: &str,
        is_error: bool,
    ) -> EvidenceObservation {
        let invocation = invocation_fingerprint(tool_name, input);
        *self
            .invocation_counts
            .entry(invocation.clone())
            .or_default() += 1;
        self.total_observations += 1;

        let fingerprint = evidence_fingerprint(tool_name, output, is_error);
        let novelty = match fingerprint.as_ref() {
            None => {
                self.empty_observations += 1;
                self.consecutive_no_new += 1;
                EvidenceNovelty::Empty
            }
            Some(fingerprint) if self.seen_evidence.insert(fingerprint.clone()) => {
                self.consecutive_no_new = 0;
                self.last_nudged_at = None;
                EvidenceNovelty::New
            }
            Some(_) => {
                self.repeated_observations += 1;
                self.consecutive_no_new += 1;
                EvidenceNovelty::Repeated
            }
        };

        let outcome = fingerprint.as_deref().unwrap_or("empty").to_string();
        let repeated = self
            .repeated_outcomes
            .entry(invocation)
            .or_insert_with(|| (outcome.clone(), 0));
        if repeated.0 == outcome {
            repeated.1 += 1;
        } else {
            *repeated = (outcome, 1);
        }

        EvidenceObservation {
            tool_name: tool_name.to_string(),
            novelty,
            fingerprint: fingerprint.map(|fingerprint| fingerprint[..12].to_string()),
            consecutive_no_new: self.consecutive_no_new,
            unique_evidence: self.seen_evidence.len(),
            total_observations: self.total_observations,
        }
    }

    #[must_use]
    pub fn block_repeated_invocation(
        &self,
        tool_name: &str,
        input: &str,
    ) -> Option<EvidenceLoopBlock> {
        let threshold = if is_polling_tool(tool_name) {
            NO_NEW_EVIDENCE_BLOCK_CALLS.saturating_mul(POLLING_BLOCK_MULTIPLIER)
        } else {
            NO_NEW_EVIDENCE_BLOCK_CALLS
        };
        if self.consecutive_no_new < threshold {
            return None;
        }
        let invocation = invocation_fingerprint(tool_name, input);
        let identical_invocations = self
            .invocation_counts
            .get(&invocation)
            .copied()
            .unwrap_or_default();
        let identical_outcomes = self
            .repeated_outcomes
            .get(&invocation)
            .map(|(_, count)| *count)
            .unwrap_or_default();
        if identical_invocations < MIN_IDENTICAL_INVOCATIONS_TO_BLOCK
            || identical_outcomes < MIN_IDENTICAL_OUTCOMES_TO_BLOCK
        {
            return None;
        }
        Some(EvidenceLoopBlock {
            message: format!(
                "Evidence loop blocked: `{tool_name}` has already run with the same input {identical_invocations} times and produced the same outcome {identical_outcomes} times; the last {} completed tool calls added no distinct evidence. Change the hypothesis, source, target, or mechanism before trying another tool, or stop and report the unresolved gap.",
                self.consecutive_no_new
            ),
            consecutive_no_new: self.consecutive_no_new,
            identical_invocations,
            identical_outcomes,
        })
    }

    pub fn take_nudge(&mut self) -> Option<String> {
        if self.consecutive_no_new < NO_NEW_EVIDENCE_NUDGE_CALLS
            || self
                .last_nudged_at
                .is_some_and(|last| self.consecutive_no_new < last + NO_NEW_EVIDENCE_NUDGE_CALLS)
        {
            return None;
        }
        self.last_nudged_at = Some(self.consecutive_no_new);
        Some(format!(
            "Evidence check (generated by Aris from tool results, not by the user): the last {} completed tool calls added no distinct evidence. The next action must change the hypothesis, source, target, or mechanism and state what new observation it can produce. If no such action remains, stop and report the evidence gathered, the repeated result, and the unresolved gap.",
            self.consecutive_no_new
        ))
    }

    #[must_use]
    pub fn facts(&self) -> Vec<String> {
        if self.total_observations == 0 {
            return Vec::new();
        }
        let mut facts = vec![format!(
            "{} distinct evidence result(s) across {} completed tool call(s); {} repeated and {} empty",
            self.seen_evidence.len(),
            self.total_observations,
            self.repeated_observations,
            self.empty_observations
        )];
        if self.consecutive_no_new > 0 {
            facts.push(format!(
                "the current no-new-evidence streak is {} tool call(s)",
                self.consecutive_no_new
            ));
        }
        facts
    }

    #[must_use]
    pub fn from_messages(messages: &[ConversationMessage]) -> Self {
        let start = messages
            .iter()
            .rposition(|message| {
                message.role == MessageRole::User && !is_internal_user_message(message)
            })
            .map_or(0, |index| index + 1);
        let mut inputs = HashMap::<String, (String, String)>::new();
        let mut ledger = Self::default();
        for message in &messages[start..] {
            for block in &message.blocks {
                match block {
                    ContentBlock::ToolUse { id, name, input } => {
                        inputs.insert(id.clone(), (name.clone(), input.clone()));
                    }
                    ContentBlock::ToolResult {
                        tool_use_id,
                        tool_name,
                        output,
                        is_error,
                    } => {
                        let input = inputs
                            .get(tool_use_id)
                            .map(|(_, input)| input.as_str())
                            .unwrap_or("{}");
                        let _ = ledger.observe(tool_name, input, output, *is_error);
                    }
                    ContentBlock::Text { .. }
                    | ContentBlock::Image { .. }
                    | ContentBlock::Thinking { .. } => {}
                }
            }
        }
        ledger
    }
}

fn invocation_fingerprint(tool_name: &str, input: &str) -> String {
    let normalized = serde_json::from_str::<Value>(input)
        .ok()
        .map(|value| canonical_json(&value, None))
        .unwrap_or_else(|| collapse_whitespace(input));
    digest(&format!("{}\n{normalized}", tool_name.to_ascii_lowercase()))
}

fn evidence_fingerprint(tool_name: &str, output: &str, is_error: bool) -> Option<String> {
    let output = strip_runtime_notes(output).trim();
    if output.is_empty() {
        return None;
    }
    let parsed = serde_json::from_str::<Value>(output).ok();
    let normalized = if let Some(sha256) = parsed.as_ref().and_then(referenced_artifact_sha256) {
        // Artifact paths include the tool-use id and therefore differ across
        // identical calls. The content hash is the evidence identity; using
        // the path would make a restored/compacted ledger treat every copy as
        // new merely because it was written under another file name.
        format!("artifact:{sha256}")
    } else if is_error {
        crate::focus_trace::error_signature(tool_name, output)
            .unwrap_or_else(|| collapse_whitespace(output))
    } else {
        parsed
            .map(|value| canonical_json(&value, None))
            .unwrap_or_else(|| collapse_whitespace(output))
    };
    if normalized.trim().is_empty() {
        None
    } else {
        Some(digest(&format!(
            "{}\n{normalized}",
            tool_name.to_ascii_lowercase()
        )))
    }
}

fn referenced_artifact_sha256(value: &Value) -> Option<&str> {
    let object = value.as_object()?;
    if object.get("status").and_then(Value::as_str) != Some("referenced")
        || object
            .get("persistedOutputPath")
            .and_then(Value::as_str)
            .is_none()
    {
        return None;
    }
    object
        .get("sha256")
        .and_then(Value::as_str)
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

fn canonical_json(value: &Value, key: Option<&str>) -> String {
    if key.is_some_and(is_volatile_key) {
        return String::new();
    }
    match value {
        Value::Object(object) => {
            let sorted = object
                .iter()
                .filter(|(key, _)| !is_volatile_key(key))
                .map(|(key, value)| (key, canonical_json(value, Some(key))))
                .collect::<BTreeMap<_, _>>();
            serde_json::to_string(&sorted).unwrap_or_default()
        }
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(|item| canonical_json(item, None))
                .collect::<Vec<_>>()
                .join(",")
        ),
        _ => serde_json::to_string(value).unwrap_or_default(),
    }
}

fn is_volatile_key(key: &str) -> bool {
    matches!(
        key.to_ascii_lowercase().as_str(),
        "elapsedms"
            | "elapsed_ms"
            | "durationms"
            | "duration_ms"
            | "timestamp"
            | "updatedat"
            | "startedat"
            | "finishedat"
            | "requestid"
            | "traceid"
            | "heartbeat"
    )
}

fn strip_runtime_notes(output: &str) -> &str {
    [
        "\n\nEvidence check (generated by Aris",
        "\n\nMain-line check (generated by Aris",
    ]
    .into_iter()
    .filter_map(|marker| output.find(marker))
    .min()
    .map_or(output, |index| &output[..index])
}

fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn digest(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

fn is_polling_tool(tool_name: &str) -> bool {
    let name = tool_name.to_ascii_lowercase();
    name == "sleep"
        || name.contains("wait_for")
        || name.contains("status")
        || name.contains("read_thread")
        || name.contains("get_handoff_status")
}

#[cfg(test)]
#[path = "tests/evidence_ledger.rs"]
mod tests;
