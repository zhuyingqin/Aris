//! EventSink trait for passive event logging.
//!
//! The runtime emits events (tool calls, skill invocations, errors) to an
//! injected `EventSink`. The default `NoopEventSink` discards everything.
//! The CLI layer can provide a `JsonlEventSink` that writes to disk.

use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// A single event emitted by the runtime.
#[derive(Debug, Clone)]
pub struct RuntimeEvent {
    pub timestamp: String,
    pub session_id: String,
    pub event_type: EventType,
}

#[derive(Debug, Clone)]
pub enum EventType {
    ToolCall {
        tool_name: String,
        /// Truncated summary of input (never full content)
        input_summary: String,
        is_error: bool,
    },
    EvidenceObservation {
        tool_name: String,
        novelty: String,
        fingerprint: Option<String>,
        consecutive_no_new: usize,
        unique_evidence: usize,
        total_observations: usize,
    },
    ContextCheckpoint {
        reason: String,
        iteration: usize,
        tool_calls: usize,
        /// Whole-request estimates: messages *plus* the system prompt and tool
        /// schemas. The `SessionCompactionRecord` for the same checkpoint counts
        /// messages only, so the two differ by exactly `context_overhead_tokens`
        /// — recorded here so a reader can reconcile them instead of reading two
        /// unequal numbers for one event as a contradiction.
        tokens_before: usize,
        tokens_after: usize,
        context_overhead_tokens: usize,
        removed_messages: usize,
    },
    SkillInvoke {
        skill_name: String,
        args: String,
    },
    UserPrompt {
        /// Only populated in "content" logging mode; otherwise empty
        preview: String,
        is_slash_command: bool,
    },
    SessionStart {
        model: String,
    },
    SessionEnd,
    /// A compaction shipped the deterministic summary instead of an LLM one.
    ///
    /// The degraded summary is visible in the transcript, but nothing used to
    /// say *why* — and the most common cause, "no summarizer model was ever
    /// resolved for this provider", makes zero requests and so leaves no trace
    /// at all in a wire log. A user looking at a summary that lists ANSI escape
    /// codes as key files has no way to distinguish that from a provider
    /// outage.
    CompactionSummaryFallback {
        reason: String,
    },
    /// The model-visible tool array changed mid-turn.
    ///
    /// Emitted because the turn-start routing snapshot is not the whole story:
    /// a `ToolSearch` can grow the live set past what that snapshot recorded,
    /// and every such change re-cuts the head of the prompt. Without this event
    /// a diagnostics bundle reports the turn-start count as both the minimum
    /// and the maximum and the re-cache looks like it came from nowhere.
    ToolRoutingChanged {
        activated: Vec<String>,
        deactivated: Vec<String>,
        active_tool_count: usize,
    },
}

impl fmt::Display for EventType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ToolCall { tool_name, .. } => write!(f, "tool_call:{tool_name}"),
            Self::EvidenceObservation {
                tool_name, novelty, ..
            } => write!(f, "tool_evidence:{tool_name}:{novelty}"),
            Self::ContextCheckpoint { reason, .. } => write!(f, "context_checkpoint:{reason}"),
            Self::SkillInvoke { skill_name, .. } => write!(f, "skill_invoke:{skill_name}"),
            Self::UserPrompt { .. } => write!(f, "user_prompt"),
            Self::SessionStart { model } => write!(f, "session_start:{model}"),
            Self::SessionEnd => write!(f, "session_end"),
            Self::ToolRoutingChanged {
                active_tool_count, ..
            } => write!(f, "tool_routing_changed:{active_tool_count}"),
            Self::CompactionSummaryFallback { reason } => {
                write!(f, "compaction_summary_fallback:{reason}")
            }
        }
    }
}

/// Logging detail level.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MetaLoggingLevel {
    /// No logging (default).
    #[default]
    Off,
    /// Log event types, tool names, skill names — no prompt content.
    Metadata,
    /// Log event types plus truncated prompt/input previews.
    Content,
}

impl MetaLoggingLevel {
    #[must_use]
    pub fn parse(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "metadata" | "meta" => Self::Metadata,
            "content" | "full" => Self::Content,
            _ => Self::Off,
        }
    }
}

/// Trait for receiving runtime events.
pub trait EventSink: Send {
    fn emit(&mut self, event: &RuntimeEvent);
}

/// Discards all events. Zero overhead.
pub struct NoopEventSink;

impl EventSink for NoopEventSink {
    fn emit(&mut self, _event: &RuntimeEvent) {}
}

/// Writes events as JSONL to a file.
pub struct JsonlEventSink {
    path: PathBuf,
    level: MetaLoggingLevel,
    session_id: String,
}

impl JsonlEventSink {
    pub fn new(path: PathBuf, level: MetaLoggingLevel, session_id: String) -> Self {
        Self {
            path,
            level,
            session_id,
        }
    }

    /// Default path: `~/.config/SomniQ/meta/events.jsonl`
    #[must_use]
    pub fn default_path() -> PathBuf {
        let home = crate::home_dir();
        PathBuf::from(home)
            .join(".config")
            .join("SomniQ")
            .join("meta")
            .join("events.jsonl")
    }
}

impl EventSink for JsonlEventSink {
    fn emit(&mut self, event: &RuntimeEvent) {
        if self.level == MetaLoggingLevel::Off {
            return;
        }

        let record = match &event.event_type {
            EventType::ToolCall {
                tool_name,
                input_summary,
                is_error,
            } => {
                let event_name = if *is_error {
                    "tool_failure"
                } else {
                    "tool_call"
                };
                let summary = if self.level == MetaLoggingLevel::Content {
                    sanitize_field(input_summary, 200)
                } else {
                    String::new()
                };
                format!(
                    r#"{{"ts":"{}","session":"{}","event":"{}","tool":"{}","input_summary":"{}"}}"#,
                    event.timestamp,
                    escape_json(&sanitize_field(&self.session_id, 60)),
                    event_name,
                    escape_json(&sanitize_field(tool_name, 60)),
                    escape_json(&summary),
                )
            }
            EventType::EvidenceObservation {
                tool_name,
                novelty,
                fingerprint,
                consecutive_no_new,
                unique_evidence,
                total_observations,
            } => format!(
                r#"{{"ts":"{}","session":"{}","event":"tool_evidence","tool":"{}","novelty":"{}","fingerprint":{},"consecutive_no_new":{},"unique_evidence":{},"total_observations":{}}}"#,
                event.timestamp,
                escape_json(&sanitize_field(&self.session_id, 60)),
                escape_json(&sanitize_field(tool_name, 60)),
                escape_json(&sanitize_field(novelty, 20)),
                fingerprint.as_ref().map_or_else(
                    || "null".to_string(),
                    |value| format!("\"{}\"", escape_json(&sanitize_field(value, 20))),
                ),
                consecutive_no_new,
                unique_evidence,
                total_observations,
            ),
            EventType::ContextCheckpoint {
                reason,
                iteration,
                tool_calls,
                tokens_before,
                tokens_after,
                context_overhead_tokens,
                removed_messages,
            } => format!(
                r#"{{"ts":"{}","session":"{}","event":"context_checkpoint","reason":"{}","iteration":{},"tool_calls":{},"tokens_before":{},"tokens_after":{},"context_overhead_tokens":{},"removed_messages":{}}}"#,
                event.timestamp,
                escape_json(&sanitize_field(&self.session_id, 60)),
                escape_json(&sanitize_field(reason, 40)),
                iteration,
                tool_calls,
                tokens_before,
                tokens_after,
                context_overhead_tokens,
                removed_messages,
            ),
            EventType::SkillInvoke { skill_name, args } => {
                let args_field = if self.level == MetaLoggingLevel::Content {
                    sanitize_field(args, 200)
                } else {
                    String::new()
                };
                format!(
                    r#"{{"ts":"{}","session":"{}","event":"skill_invoke","skill":"{}","args":"{}"}}"#,
                    event.timestamp,
                    escape_json(&sanitize_field(&self.session_id, 60)),
                    escape_json(&sanitize_field(skill_name, 60)),
                    escape_json(&args_field),
                )
            }
            EventType::UserPrompt {
                preview,
                is_slash_command,
            } => {
                if *is_slash_command {
                    let cmd = if self.level == MetaLoggingLevel::Content {
                        sanitize_field(preview, 100)
                    } else {
                        // In metadata mode, just record that a slash command was used
                        preview.split_whitespace().next().unwrap_or("").to_string()
                    };
                    format!(
                        r#"{{"ts":"{}","session":"{}","event":"slash_command","command":"{}"}}"#,
                        event.timestamp,
                        escape_json(&sanitize_field(&self.session_id, 60)),
                        escape_json(&cmd),
                    )
                } else if self.level == MetaLoggingLevel::Content {
                    format!(
                        r#"{{"ts":"{}","session":"{}","event":"user_prompt","preview":"{}"}}"#,
                        event.timestamp,
                        escape_json(&sanitize_field(&self.session_id, 60)),
                        escape_json(&sanitize_field(preview, 100)),
                    )
                } else {
                    // Metadata mode: log that a prompt was sent, but not its content
                    format!(
                        r#"{{"ts":"{}","session":"{}","event":"user_prompt"}}"#,
                        event.timestamp, self.session_id,
                    )
                }
            }
            EventType::SessionStart { model } => {
                format!(
                    r#"{{"ts":"{}","session":"{}","event":"session_start","model":"{}"}}"#,
                    event.timestamp,
                    escape_json(&sanitize_field(&self.session_id, 60)),
                    escape_json(&sanitize_field(model, 60)),
                )
            }
            EventType::SessionEnd => {
                format!(
                    r#"{{"ts":"{}","session":"{}","event":"session_end"}}"#,
                    event.timestamp, self.session_id,
                )
            }
            EventType::CompactionSummaryFallback { reason } => {
                format!(
                    r#"{{"ts":"{}","session":"{}","event":"compaction_summary_fallback","reason":"{}"}}"#,
                    event.timestamp,
                    escape_json(&sanitize_field(&self.session_id, 60)),
                    escape_json(&sanitize_field(reason, 80)),
                )
            }
            EventType::ToolRoutingChanged {
                activated,
                deactivated,
                active_tool_count,
            } => {
                format!(
                    r#"{{"ts":"{}","session":"{}","event":"tool_routing_changed","activated":{},"deactivated":{},"active_tool_count":{}}}"#,
                    event.timestamp,
                    escape_json(&sanitize_field(&self.session_id, 60)),
                    json_string_array(activated),
                    json_string_array(deactivated),
                    active_tool_count,
                )
            }
        };

        // Best-effort write; never crash the runtime on log failure
        let _ = write_line(&self.path, &record);
    }
}

fn write_line(path: &PathBuf, line: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(file, "{line}")
}

fn json_string_array(values: &[String]) -> String {
    let items = values
        .iter()
        .map(|value| format!("\"{}\"", escape_json(&sanitize_field(value, 80))))
        .collect::<Vec<_>>()
        .join(",");
    format!("[{items}]")
}

/// Sanitize a string: truncate and remove control chars.
fn sanitize_field(s: &str, max_len: usize) -> String {
    s.chars()
        .filter(|c| !c.is_control() || *c == '\n')
        .take(max_len)
        .collect::<String>()
        .replace('\n', " ")
}

/// Minimal JSON string escaping.
fn escape_json(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t")
}

/// Current UTC date as `YYYY-MM-DD`. Used to inject the real "today" into
/// system prompts (e.g. `ProjectContext::current_date`) — replacing the
/// previously hard-coded `DEFAULT_DATE` constant that froze on the day the
/// constant was last edited and made models refuse later real-world dates
/// as "future/prompt injection".
#[must_use]
pub fn today_iso() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let days = secs / 86400;
    let (year, month, day) = days_to_ymd(days);
    format!("{year:04}-{month:02}-{day:02}")
}

/// Generate an ISO 8601 UTC timestamp.
#[must_use]
pub fn now_iso8601() -> String {
    iso8601_from_epoch_secs(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    )
}

/// Seconds since the Unix epoch, for timestamp arithmetic.
#[must_use]
pub fn epoch_secs_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Render an epoch second count in the same fixed-width UTC form as
/// [`now_iso8601`].
///
/// Fixed width matters beyond looks: two timestamps produced here compare
/// correctly with plain string ordering, which is how lease expiry is checked
/// without pulling in a date parser.
#[must_use]
pub fn iso8601_from_epoch_secs(secs: u64) -> String {
    // Simple UTC timestamp without chrono dependency
    let days = secs / 86400;
    let time_of_day = secs % 86400;
    let hours = time_of_day / 3600;
    let minutes = (time_of_day % 3600) / 60;
    let seconds = time_of_day % 60;
    // Approximate date calculation (good enough for logging)
    let (year, month, day) = days_to_ymd(days);
    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}Z")
}

fn days_to_ymd(days_since_epoch: u64) -> (u64, u64, u64) {
    // Algorithm from http://howardhinnant.github.io/date_algorithms.html
    let z = days_since_epoch + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jsonl_sink_records_evidence_metadata_without_tool_content() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("events.jsonl");
        let mut sink = JsonlEventSink::new(
            path.clone(),
            MetaLoggingLevel::Metadata,
            "session-1".to_string(),
        );

        sink.emit(&RuntimeEvent {
            timestamp: "2026-09-13T00:00:00Z".to_string(),
            session_id: "session-1".to_string(),
            event_type: EventType::EvidenceObservation {
                tool_name: "read_file".to_string(),
                novelty: "repeated".to_string(),
                fingerprint: Some("abcdef123456".to_string()),
                consecutive_no_new: 4,
                unique_evidence: 1,
                total_observations: 5,
            },
        });

        let record = fs::read_to_string(path).expect("event record");
        let value: serde_json::Value = serde_json::from_str(record.trim()).expect("valid JSON");
        assert_eq!(value["event"], "tool_evidence");
        assert_eq!(value["novelty"], "repeated");
        assert_eq!(value["consecutive_no_new"], 4);
        assert_eq!(value["fingerprint"], "abcdef123456");
        assert!(value.get("output").is_none());
    }
}
