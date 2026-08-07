//! Deterministic "am I stuck on one point?" signals.
//!
//! The expensive way to detect a rabbit hole is to ask a model whether it is in
//! one — models are poor judges of this from the inside, and by construction the
//! judgement is only available at a summarization boundary. The cheap way is to
//! count: how much work has happened since the user last spoke, how much of it
//! landed on the same file, and how often the same error came back. Those are
//! pure statistics over the session, they are available on every iteration, and
//! they are what a human is actually reacting to when they say "you're going
//! down a rabbit hole".
//!
//! The counters are the sensor. [`crate::compact`] pins them into the
//! compaction summary as facts (so the judgement survives context loss) and
//! [`crate::conversation`] uses them to inject an in-band reminder at the turn
//! boundary. Neither consumer decides on its own what "stuck" means; both read
//! the thresholds here.

use crate::compact::is_internal_user_message;
use crate::session::{ContentBlock, ConversationMessage, MessageRole};

/// Tool calls since the user last spoke, past which the work is long enough to
/// be worth checking against the main line regardless of what it touched.
pub const RABBIT_HOLE_TOOL_CALLS: usize = 30;
/// Repeated operations against one file, past which the work has narrowed to a
/// single point.
pub const RABBIT_HOLE_FILE_REPEATS: usize = 8;
/// Repeats of one error signature, past which retrying is not converging.
pub const RABBIT_HOLE_ERROR_REPEATS: usize = 4;
/// Once a nudge has fired, the next one waits this many further tool calls, so
/// a genuinely long stretch of work is reminded again without a reminder on
/// every iteration.
pub const RABBIT_HOLE_RENUDGE_TOOL_CALLS: usize = 25;

const MAX_ERROR_SIGNATURE_CHARS: usize = 120;
const MAX_REPEATED_ERRORS: usize = 5;

/// Deterministic focus statistics for the work done since the user's last
/// substantive message.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FocusSignals {
    pub tool_calls: usize,
    /// The most-repeated file path and its operation count.
    pub top_file: Option<(String, usize)>,
    /// The most-repeated error signature and its occurrence count.
    pub top_error: Option<(String, usize)>,
    /// Every failure that recurred, most frequent first. A recurring failure is
    /// the one dead end that can be identified without a model's opinion.
    pub repeated_errors: Vec<(String, usize)>,
    pub distinct_files: usize,
}

impl FocusSignals {
    /// Statistics over the tail of `messages` that follows the last
    /// non-internal user message. Aris-generated continuation prompts are not
    /// user turns, so a compaction mid-rabbit-hole does not reset the window.
    #[must_use]
    pub fn from_messages(messages: &[ConversationMessage]) -> Self {
        let start = messages
            .iter()
            .rposition(|message| {
                message.role == MessageRole::User && !is_internal_user_message(message)
            })
            .map_or(0, |index| index + 1);
        Self::from_window(&messages[start..])
    }

    fn from_window(window: &[ConversationMessage]) -> Self {
        let mut tool_calls = 0usize;
        let mut file_counts: Vec<(FileTarget, usize)> = Vec::new();
        let mut error_counts: Vec<(String, usize)> = Vec::new();

        for message in window {
            for block in &message.blocks {
                match block {
                    ContentBlock::ToolUse { input, .. } => {
                        tool_calls += 1;
                        if let Some(target) = FileTarget::from_tool_input(input) {
                            bump(&mut file_counts, target);
                        }
                    }
                    ContentBlock::ToolResult {
                        tool_name,
                        output,
                        is_error: true,
                        ..
                    } => {
                        if let Some(signature) = error_signature(tool_name, output) {
                            bump(&mut error_counts, signature);
                        }
                    }
                    _ => {}
                }
            }
        }

        let mut paths = file_counts
            .iter()
            .map(|(target, _)| target.path.as_str())
            .collect::<Vec<_>>();
        paths.sort_unstable();
        paths.dedup();
        let distinct_files = paths.len();

        let mut repeated_errors = error_counts
            .iter()
            .filter(|(_, count)| *count > 1)
            .cloned()
            .collect::<Vec<_>>();
        repeated_errors.sort_by_key(|(_, count)| std::cmp::Reverse(*count));
        repeated_errors.truncate(MAX_REPEATED_ERRORS);
        Self {
            tool_calls,
            top_file: max_count(file_counts).map(|(target, count)| (target.path, count)),
            top_error: max_count(error_counts),
            repeated_errors,
            distinct_files,
        }
    }

    /// Whether any threshold is crossed.
    #[must_use]
    pub fn is_rabbit_hole(&self) -> bool {
        !self.reasons().is_empty()
    }

    /// One sentence per crossed threshold, most specific first. Empty when the
    /// work is not narrow enough to be worth flagging.
    #[must_use]
    pub fn reasons(&self) -> Vec<String> {
        let mut reasons = Vec::new();
        if let Some((signature, count)) = self
            .top_error
            .as_ref()
            .filter(|(_, count)| *count >= RABBIT_HOLE_ERROR_REPEATS)
        {
            reasons.push(format!(
                "the same failure has come back {count} times ({signature})"
            ));
        }
        if let Some((path, count)) = self
            .top_file
            .as_ref()
            .filter(|(_, count)| *count >= RABBIT_HOLE_FILE_REPEATS)
        {
            reasons.push(format!("{path} has been operated on {count} times"));
        }
        if self.tool_calls >= RABBIT_HOLE_TOOL_CALLS {
            reasons.push(format!(
                "{} tool calls have run since the user's last message",
                self.tool_calls
            ));
        }
        reasons
    }

    /// The counters as flat facts for a compaction summary. Always rendered
    /// when there is any work in the window — the summary states the numbers
    /// and lets the reader judge, rather than only speaking up past a
    /// threshold.
    #[must_use]
    pub fn facts(&self) -> Vec<String> {
        if self.tool_calls == 0 {
            return Vec::new();
        }
        let mut facts = vec![format!(
            "{} tool calls since the user's last message, touching {} distinct file(s)",
            self.tool_calls, self.distinct_files
        )];
        if let Some((path, count)) = &self.top_file {
            if *count > 1 {
                facts.push(format!("{path} operated on {count} times"));
            }
        }
        if let Some((signature, count)) = &self.top_error {
            if *count > 1 {
                facts.push(format!("failure repeated {count} times: {signature}"));
            }
        }
        facts
    }

    /// Failures that recurred often enough to be a tried-and-failed approach
    /// rather than a transient error. This is the only dead end identifiable
    /// without a model's opinion, so it is what survives compaction verbatim.
    #[must_use]
    pub fn dead_ends(&self) -> Vec<String> {
        self.repeated_errors
            .iter()
            .filter(|(_, count)| *count >= RABBIT_HOLE_ERROR_REPEATS)
            .map(|(signature, count)| {
                format!("{signature} — recurred {count} times without resolving")
            })
            .collect()
    }

    /// The in-band reminder text, or `None` when no threshold is crossed. The
    /// wording deliberately asks for a decision rather than ordering a stop:
    /// the counters prove narrowness, not wrongness, and a long stretch on one
    /// file is often exactly right.
    #[must_use]
    pub fn nudge(&self) -> Option<String> {
        let reasons = self.reasons();
        if reasons.is_empty() {
            return None;
        }
        Some(format!(
            "Main-line check (generated by Aris from the session, not by the user): {}. \
             Before continuing, state in one line what this work is serving — the project's main line, \
             a listed secondary stream, or neither — and whether the current approach is converging. \
             If it is not converging, switch approach or park this and return to the main line \
             instead of retrying the same thing. If it is on the main line and converging, say so \
             briefly and carry on.",
            reasons.join("; ")
        ))
    }
}

/// What a tool call targeted: the file, plus the region when the tool named
/// one. Reads carry an `offset`, so paging through a long file produces many
/// distinct targets — ordinary work — while edits (which carry no offset) and
/// repeated reads of one region collapse onto a single target, which is the
/// narrow-focus signal.
#[derive(Debug, Clone, PartialEq, Eq)]
struct FileTarget {
    path: String,
    offset: Option<i64>,
}

impl FileTarget {
    /// Several path spellings are accepted because MCP tools do not share the
    /// built-ins' `path` convention.
    fn from_tool_input(input: &str) -> Option<Self> {
        let value = serde_json::from_str::<serde_json::Value>(input).ok()?;
        let path = ["path", "file_path", "filePath", "notebook_path"]
            .iter()
            .find_map(|key| value.get(key).and_then(serde_json::Value::as_str))
            .map(str::trim)
            .filter(|path| !path.is_empty())?
            .to_string();
        Some(Self {
            path,
            offset: value.get("offset").and_then(serde_json::Value::as_i64),
        })
    }
}

fn bump<K: PartialEq>(counts: &mut Vec<(K, usize)>, key: K) {
    if let Some(entry) = counts.iter_mut().find(|(existing, _)| existing == &key) {
        entry.1 += 1;
    } else {
        counts.push((key, 1));
    }
}

/// Highest count, ties broken by first occurrence so the result is stable.
fn max_count<K>(counts: Vec<(K, usize)>) -> Option<(K, usize)> {
    counts
        .into_iter()
        .reduce(|best, item| if item.1 > best.1 { item } else { best })
}

/// Whether a main-line reminder is due, given where the last one fired in the
/// current window. Pure so the re-arm rule is testable on its own.
pub(crate) fn focus_nudge_due(last_nudge_tool_calls: Option<usize>, tool_calls: usize) -> bool {
    match last_nudge_tool_calls {
        None => true,
        // The window shrank, so a compaction dropped the older part of the
        // stretch the recorded count referred to. Keeping it would suppress the
        // reminder for another full stretch right after a session has already
        // spent an entire context on one point.
        Some(last) if tool_calls < last => true,
        Some(last) => tool_calls >= last.saturating_add(RABBIT_HOLE_RENUDGE_TOOL_CALLS),
    }
}

/// A stable identity for an error, so the same failure recurring with different
/// line numbers or offsets still counts as a repeat. Digit runs are collapsed
/// because that is what usually varies between otherwise identical failures.
fn error_signature(tool_name: &str, output: &str) -> Option<String> {
    let first_line = output.lines().map(str::trim).find(|line| !line.is_empty())?;
    let mut normalized = String::with_capacity(first_line.len());
    let mut last_was_digit = false;
    for character in first_line.chars() {
        if character.is_ascii_digit() {
            if !last_was_digit {
                normalized.push('#');
            }
            last_was_digit = true;
            continue;
        }
        last_was_digit = false;
        normalized.extend(character.to_lowercase());
    }
    let normalized = normalized.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return None;
    }
    let normalized = normalized
        .chars()
        .take(MAX_ERROR_SIGNATURE_CHARS)
        .collect::<String>();
    Some(format!("{tool_name}: {normalized}"))
}

#[cfg(test)]
#[path = "tests/focus_trace.rs"]
mod tests;
