use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use runtime::{ContentBlock, ConversationMessage, MessageRole, Session};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

const TIMELINE_VERSION: u32 = 1;
const MAIN_BRANCH_ID: &str = "main";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionTimeline {
    pub version: u32,
    pub session_id: String,
    pub active_branch_id: String,
    pub active_head_id: Option<String>,
    pub source_message_count: usize,
    pub branches: Vec<TimelineBranch>,
    pub nodes: Vec<TimelineNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TimelineBranch {
    pub id: String,
    pub name: String,
    pub root_node_id: String,
    pub head_node_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TimelineNode {
    pub id: String,
    pub kind: TimelineNodeKind,
    pub branch_id: String,
    pub parent_id: Option<String>,
    pub children: Vec<String>,
    pub message_index: Option<usize>,
    pub block_index: Option<usize>,
    pub turn_index: Option<usize>,
    pub role: Option<String>,
    pub label: String,
    pub preview: Option<String>,
    pub content_hash: String,
    pub tool_use_id: Option<String>,
    pub tool_name: Option<String>,
    pub file_paths: Vec<String>,
    pub diff: Option<TimelineDiff>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TimelineNodeKind {
    Root,
    SystemMessage,
    UserTurn,
    AssistantReply,
    ToolCall,
    ToolResult,
    FileDiff,
}

impl TimelineNodeKind {
    fn as_id_part(&self) -> &'static str {
        match self {
            Self::Root => "root",
            Self::SystemMessage => "system",
            Self::UserTurn => "user",
            Self::AssistantReply => "assistant",
            Self::ToolCall => "tool-call",
            Self::ToolResult => "tool-result",
            Self::FileDiff => "file-diff",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TimelineDiff {
    pub file_path: String,
    pub hunks: usize,
    pub added_lines: usize,
    pub removed_lines: usize,
    pub patch_hash: String,
    pub change_id: Option<String>,
}

struct TimelineBuilder {
    nodes: Vec<TimelineNode>,
    next_ordinal: usize,
    last_node_id: Option<String>,
}

impl TimelineBuilder {
    fn new() -> Self {
        Self {
            nodes: Vec::new(),
            next_ordinal: 0,
            last_node_id: None,
        }
    }

    fn push(&mut self, input: NewTimelineNode) -> String {
        let id = format!(
            "n{:04}-{}-{}",
            self.next_ordinal,
            input.kind.as_id_part(),
            short_hash(&input.identity)
        );
        self.next_ordinal += 1;
        let node = TimelineNode {
            id: id.clone(),
            kind: input.kind,
            branch_id: MAIN_BRANCH_ID.to_string(),
            parent_id: input.parent_id,
            children: Vec::new(),
            message_index: input.message_index,
            block_index: input.block_index,
            turn_index: input.turn_index,
            role: input.role,
            label: input.label,
            preview: input.preview,
            content_hash: sha256_hex(input.identity.as_bytes()),
            tool_use_id: input.tool_use_id,
            tool_name: input.tool_name,
            file_paths: input.file_paths,
            diff: input.diff,
        };
        self.nodes.push(node);
        self.last_node_id = Some(id.clone());
        id
    }

    fn finish(mut self, session_id: &str, source_message_count: usize) -> SessionTimeline {
        let mut children_by_parent: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for node in &self.nodes {
            if let Some(parent_id) = &node.parent_id {
                children_by_parent
                    .entry(parent_id.clone())
                    .or_default()
                    .push(node.id.clone());
            }
        }
        for node in &mut self.nodes {
            node.children = children_by_parent.remove(&node.id).unwrap_or_default();
        }

        let root_node_id = self
            .nodes
            .first()
            .map(|node| node.id.clone())
            .unwrap_or_default();
        let head_node_id = self
            .last_node_id
            .clone()
            .unwrap_or_else(|| root_node_id.clone());

        SessionTimeline {
            version: TIMELINE_VERSION,
            session_id: session_id.to_string(),
            active_branch_id: MAIN_BRANCH_ID.to_string(),
            active_head_id: self.last_node_id,
            source_message_count,
            branches: vec![TimelineBranch {
                id: MAIN_BRANCH_ID.to_string(),
                name: MAIN_BRANCH_ID.to_string(),
                root_node_id,
                head_node_id,
            }],
            nodes: self.nodes,
        }
    }
}

struct NewTimelineNode {
    kind: TimelineNodeKind,
    parent_id: Option<String>,
    message_index: Option<usize>,
    block_index: Option<usize>,
    turn_index: Option<usize>,
    role: Option<String>,
    label: String,
    preview: Option<String>,
    identity: String,
    tool_use_id: Option<String>,
    tool_name: Option<String>,
    file_paths: Vec<String>,
    diff: Option<TimelineDiff>,
}

impl NewTimelineNode {
    fn root(session_id: &str, source_message_count: usize) -> Self {
        Self {
            kind: TimelineNodeKind::Root,
            parent_id: None,
            message_index: None,
            block_index: None,
            turn_index: None,
            role: None,
            label: "session root".to_string(),
            preview: Some(format!("{source_message_count} message(s)")),
            identity: format!("root|{session_id}|{source_message_count}"),
            tool_use_id: None,
            tool_name: None,
            file_paths: Vec::new(),
            diff: None,
        }
    }
}

#[must_use]
pub fn timeline_from_session(session_id: &str, session: &Session) -> SessionTimeline {
    let mut builder = TimelineBuilder::new();
    builder.push(NewTimelineNode::root(session_id, session.messages.len()));

    let mut turn_index = 0usize;
    for (message_index, message) in session.messages.iter().enumerate() {
        match message.role {
            MessageRole::System => {
                push_message_node(
                    &mut builder,
                    TimelineNodeKind::SystemMessage,
                    message,
                    message_index,
                    None,
                    "system message",
                );
            }
            MessageRole::User => {
                turn_index += 1;
                push_message_node(
                    &mut builder,
                    TimelineNodeKind::UserTurn,
                    message,
                    message_index,
                    Some(turn_index),
                    &format!("user turn {turn_index}"),
                );
            }
            MessageRole::Assistant => {
                push_message_node(
                    &mut builder,
                    TimelineNodeKind::AssistantReply,
                    message,
                    message_index,
                    Some(turn_index),
                    &format!("assistant reply {turn_index}"),
                );
                push_tool_call_nodes(&mut builder, message, message_index, turn_index);
            }
            MessageRole::Tool => {
                push_tool_result_nodes(&mut builder, message, message_index, turn_index);
            }
        }
    }

    builder.finish(session_id, session.messages.len())
}

pub fn save_timeline_for_session(
    session_id: &str,
    session: &Session,
    session_path: &Path,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let timeline_path = timeline_path_for_session_path(session_path);
    if let Some(parent) = timeline_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let timeline = timeline_from_session(session_id, session);
    let data = serde_json::to_string_pretty(&timeline)?;
    fs::write(&timeline_path, format!("{data}\n"))?;
    Ok(timeline_path)
}

#[must_use]
pub fn timeline_path_for_session_path(session_path: &Path) -> PathBuf {
    let file_name = session_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("session.json");
    let timeline_name = if let Some(stem) = file_name.strip_suffix(".json") {
        format!("{stem}.timeline.json")
    } else {
        format!("{file_name}.timeline.json")
    };
    session_path.with_file_name(timeline_name)
}

pub fn render_timeline_report(
    session_id: &str,
    session_path: &Path,
    session: &Session,
    max_nodes: usize,
) -> Result<String, Box<dyn std::error::Error>> {
    let timeline_path = save_timeline_for_session(session_id, session, session_path)?;
    let timeline = timeline_from_session(session_id, session);
    Ok(render_timeline_summary(
        &timeline,
        &timeline_path,
        max_nodes,
    ))
}

#[must_use]
pub fn render_timeline_summary(
    timeline: &SessionTimeline,
    timeline_path: &Path,
    max_nodes: usize,
) -> String {
    let branch_count = timeline.branches.len();
    let node_count = timeline.nodes.len();
    let diff_count = timeline
        .nodes
        .iter()
        .filter(|node| node.kind == TimelineNodeKind::FileDiff)
        .count();
    let tool_call_count = timeline
        .nodes
        .iter()
        .filter(|node| node.kind == TimelineNodeKind::ToolCall)
        .count();
    let active_head = timeline.active_head_id.as_deref().unwrap_or("<none>");
    let mut lines = vec![
        "Timeline".to_string(),
        format!("  Session          {}", timeline.session_id),
        format!("  File             {}", timeline_path.display()),
        format!("  Branches         {branch_count}"),
        format!("  Nodes            {node_count}"),
        format!("  Tool calls       {tool_call_count}"),
        format!("  File diffs       {diff_count}"),
        format!("  Active head      {active_head}"),
        String::new(),
        "Recent nodes".to_string(),
    ];

    let start = timeline.nodes.len().saturating_sub(max_nodes);
    for node in timeline.nodes.iter().skip(start) {
        lines.push(format!(
            "  {id:<28} {kind:<15} parent={parent:<28} {label}",
            id = node.id,
            kind = node.kind.as_id_part(),
            parent = node.parent_id.as_deref().unwrap_or("-"),
            label = node.label,
        ));
        if let Some(preview) = &node.preview {
            lines.push(format!("    preview: {preview}"));
        }
        if !node.file_paths.is_empty() {
            lines.push(format!("    files: {}", node.file_paths.join(", ")));
        }
        if let Some(diff) = &node.diff {
            lines.push(format!(
                "    diff: {} hunks={} +{} -{}",
                diff.file_path, diff.hunks, diff.added_lines, diff.removed_lines
            ));
        }
    }
    lines.join("\n")
}

fn push_message_node(
    builder: &mut TimelineBuilder,
    kind: TimelineNodeKind,
    message: &ConversationMessage,
    message_index: usize,
    turn_index: Option<usize>,
    label: &str,
) {
    let role = role_label(message.role).to_string();
    let preview = message_preview(message);
    let identity = format!("message|{message_index}|{role}|{preview}");
    let parent_id = builder.last_node_id.clone();
    builder.push(NewTimelineNode {
        kind,
        parent_id,
        message_index: Some(message_index),
        block_index: None,
        turn_index,
        role: Some(role),
        label: label.to_string(),
        preview: Some(preview),
        identity,
        tool_use_id: None,
        tool_name: None,
        file_paths: Vec::new(),
        diff: None,
    });
}

fn push_tool_call_nodes(
    builder: &mut TimelineBuilder,
    message: &ConversationMessage,
    message_index: usize,
    turn_index: usize,
) {
    for (block_index, block) in message.blocks.iter().enumerate() {
        let ContentBlock::ToolUse { id, name, input } = block else {
            continue;
        };
        let file_paths = paths_from_json(input);
        let parent_id = builder.last_node_id.clone();
        builder.push(NewTimelineNode {
            kind: TimelineNodeKind::ToolCall,
            parent_id,
            message_index: Some(message_index),
            block_index: Some(block_index),
            turn_index: Some(turn_index),
            role: Some("assistant".to_string()),
            label: format!("tool call: {name}"),
            preview: Some(compact_preview(input, 160)),
            identity: format!("tool_call|{message_index}|{block_index}|{id}|{name}|{input}"),
            tool_use_id: Some(id.clone()),
            tool_name: Some(name.clone()),
            file_paths,
            diff: None,
        });
    }
}

fn push_tool_result_nodes(
    builder: &mut TimelineBuilder,
    message: &ConversationMessage,
    message_index: usize,
    turn_index: usize,
) {
    for (block_index, block) in message.blocks.iter().enumerate() {
        let ContentBlock::ToolResult {
            tool_use_id,
            tool_name,
            output,
            is_error,
        } = block
        else {
            continue;
        };
        let diff = diff_from_tool_result(tool_name, output);
        let mut file_paths = paths_from_json(output);
        if let Some(diff) = &diff {
            if !file_paths.iter().any(|path| path == &diff.file_path) {
                file_paths.push(diff.file_path.clone());
            }
        }
        let parent_id = builder.last_node_id.clone();
        let tool_result_id = builder.push(NewTimelineNode {
            kind: TimelineNodeKind::ToolResult,
            parent_id,
            message_index: Some(message_index),
            block_index: Some(block_index),
            turn_index: Some(turn_index),
            role: Some("tool".to_string()),
            label: format!("tool result: {tool_name} error={is_error}"),
            preview: Some(compact_preview(output, 160)),
            identity: format!(
                "tool_result|{message_index}|{block_index}|{tool_use_id}|{tool_name}|{output}"
            ),
            tool_use_id: Some(tool_use_id.clone()),
            tool_name: Some(tool_name.clone()),
            file_paths: file_paths.clone(),
            diff: None,
        });
        if let Some(diff) = diff {
            builder.push(NewTimelineNode {
                kind: TimelineNodeKind::FileDiff,
                parent_id: Some(tool_result_id),
                message_index: Some(message_index),
                block_index: Some(block_index),
                turn_index: Some(turn_index),
                role: Some("tool".to_string()),
                label: format!("file diff: {}", diff.file_path),
                preview: Some(format!(
                    "{} hunk(s), +{}, -{}",
                    diff.hunks, diff.added_lines, diff.removed_lines
                )),
                identity: format!(
                    "file_diff|{message_index}|{block_index}|{tool_use_id}|{}|{}",
                    diff.file_path, diff.patch_hash
                ),
                tool_use_id: Some(tool_use_id.clone()),
                tool_name: Some(tool_name.clone()),
                file_paths,
                diff: Some(diff),
            });
        }
    }
}

fn diff_from_tool_result(tool_name: &str, output: &str) -> Option<TimelineDiff> {
    if !matches!(
        tool_name,
        "write_file" | "append_file" | "edit_file" | "multi_edit" | "NotebookEdit"
    ) {
        return None;
    }
    let value: Value = serde_json::from_str(output).ok()?;
    if let Some(diff) = diff_from_codex_changes(&value) {
        return Some(diff);
    }
    let file_path = value
        .get("filePath")
        .or_else(|| value.get("notebookPath"))
        .or_else(|| value.get("notebook_path"))
        .and_then(Value::as_str)?
        .to_string();
    let change_id = change_id_from_value(&value);
    let Some(hunks) = value.get("structuredPatch").and_then(Value::as_array) else {
        return diff_from_file_pair(&file_path, &value);
    };
    if hunks.is_empty() {
        return diff_from_file_pair(&file_path, &value);
    }

    let mut added_lines = 0usize;
    let mut removed_lines = 0usize;
    let mut patch_identity = String::new();
    for hunk in hunks {
        if let Some(lines) = hunk.get("lines").and_then(Value::as_array) {
            for line in lines.iter().filter_map(Value::as_str) {
                patch_identity.push_str(line);
                patch_identity.push('\n');
                if line.starts_with('+') && !line.starts_with("+++") {
                    added_lines += 1;
                } else if line.starts_with('-') && !line.starts_with("---") {
                    removed_lines += 1;
                }
            }
        }
    }

    Some(TimelineDiff {
        file_path,
        hunks: hunks.len(),
        added_lines,
        removed_lines,
        patch_hash: sha256_hex(patch_identity.as_bytes()),
        change_id,
    })
}

fn diff_from_codex_changes(value: &Value) -> Option<TimelineDiff> {
    let changes = value.get("changes")?.as_object()?;
    for (file_path, change) in changes {
        let kind = change.get("type").and_then(Value::as_str)?;
        let display_path = change
            .get("move_path")
            .and_then(Value::as_str)
            .unwrap_or(file_path);
        match kind {
            "update" => {
                let unified_diff = change.get("unified_diff").and_then(Value::as_str)?;
                if unified_diff.trim().is_empty() {
                    continue;
                }
                let (added_lines, removed_lines) = count_unified_diff_lines(unified_diff);
                if added_lines == 0 && removed_lines == 0 {
                    continue;
                }
                return Some(TimelineDiff {
                    file_path: display_path.to_string(),
                    hunks: unified_diff
                        .lines()
                        .filter(|line| line.starts_with("@@ "))
                        .count()
                        .max(1),
                    added_lines,
                    removed_lines,
                    patch_hash: sha256_hex(unified_diff.as_bytes()),
                    change_id: change_id_from_value(value),
                });
            }
            "add" => {
                let content = change
                    .get("content")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                return Some(TimelineDiff {
                    file_path: display_path.to_string(),
                    hunks: 1,
                    added_lines: content.lines().count(),
                    removed_lines: 0,
                    patch_hash: sha256_hex(content.as_bytes()),
                    change_id: change_id_from_value(value),
                });
            }
            "delete" => {
                let content = change
                    .get("content")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                return Some(TimelineDiff {
                    file_path: display_path.to_string(),
                    hunks: 1,
                    added_lines: 0,
                    removed_lines: content.lines().count(),
                    patch_hash: sha256_hex(content.as_bytes()),
                    change_id: change_id_from_value(value),
                });
            }
            _ => {}
        }
    }
    None
}

fn count_unified_diff_lines(unified_diff: &str) -> (usize, usize) {
    let mut added_lines = 0usize;
    let mut removed_lines = 0usize;
    for line in unified_diff.lines() {
        if line.starts_with('+') && !line.starts_with("+++") {
            added_lines += 1;
        } else if line.starts_with('-') && !line.starts_with("---") {
            removed_lines += 1;
        }
    }
    (added_lines, removed_lines)
}

fn diff_from_file_pair(file_path: &str, value: &Value) -> Option<TimelineDiff> {
    let original = value
        .get("original_file")
        .or_else(|| value.get("originalFile"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let updated = value
        .get("updated_file")
        .or_else(|| value.get("updatedFile"))
        .or_else(|| value.get("content"))
        .and_then(Value::as_str)?;
    if original == updated {
        return None;
    }

    let original_lines = original.lines().collect::<Vec<_>>();
    let updated_lines = updated.lines().collect::<Vec<_>>();
    let mut start = 0usize;
    while start < original_lines.len()
        && start < updated_lines.len()
        && original_lines[start] == updated_lines[start]
    {
        start += 1;
    }

    let mut old_end = original_lines.len();
    let mut new_end = updated_lines.len();
    while old_end > start
        && new_end > start
        && original_lines[old_end - 1] == updated_lines[new_end - 1]
    {
        old_end -= 1;
        new_end -= 1;
    }

    let added_lines = new_end.saturating_sub(start);
    let removed_lines = old_end.saturating_sub(start);
    if added_lines == 0 && removed_lines == 0 {
        return None;
    }

    let mut patch_identity = String::new();
    for line in &original_lines[start..old_end] {
        patch_identity.push('-');
        patch_identity.push_str(line);
        patch_identity.push('\n');
    }
    for line in &updated_lines[start..new_end] {
        patch_identity.push('+');
        patch_identity.push_str(line);
        patch_identity.push('\n');
    }

    Some(TimelineDiff {
        file_path: file_path.to_string(),
        hunks: 1,
        added_lines,
        removed_lines,
        patch_hash: sha256_hex(patch_identity.as_bytes()),
        change_id: change_id_from_value(value),
    })
}

fn change_id_from_value(value: &Value) -> Option<String> {
    value
        .get("changeId")
        .or_else(|| value.get("change_id"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToString::to_string)
}

fn paths_from_json(raw: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
    };
    let mut paths = BTreeSet::new();
    collect_paths_from_value(&value, &mut paths);
    paths.into_iter().collect()
}

fn collect_paths_from_value(value: &Value, paths: &mut BTreeSet<String>) {
    match value {
        Value::Object(map) => {
            for (key, value) in map {
                if key == "changes" {
                    if let Some(changes) = value.as_object() {
                        paths.extend(changes.keys().cloned());
                    }
                }
                if matches!(
                    key.as_str(),
                    "path"
                        | "filePath"
                        | "file_path"
                        | "move_path"
                        | "notebook_path"
                        | "notebookPath"
                ) {
                    if let Some(path) = value.as_str() {
                        paths.insert(path.to_string());
                    }
                }
                collect_paths_from_value(value, paths);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_paths_from_value(item, paths);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
    }
}

fn message_preview(message: &ConversationMessage) -> String {
    let mut parts = Vec::new();
    for block in &message.blocks {
        match block {
            ContentBlock::Text { text } => parts.push(text.clone()),
            ContentBlock::Image { media_type, data } => {
                parts.push(format!("image {media_type}: {} base64 chars", data.len()));
            }
            ContentBlock::ToolUse { name, input, .. } => {
                parts.push(format!("tool_use {name}: {input}"));
            }
            ContentBlock::ToolResult {
                tool_name,
                output,
                is_error,
                ..
            } => parts.push(format!(
                "tool_result {tool_name} error={is_error}: {output}"
            )),
            ContentBlock::Thinking { thinking, .. } => {
                parts.push(format!("thinking: {thinking}"));
            }
        }
    }
    compact_preview(&parts.join("\n"), 180)
}

fn role_label(role: MessageRole) -> &'static str {
    match role {
        MessageRole::System => "system",
        MessageRole::User => "user",
        MessageRole::Assistant => "assistant",
        MessageRole::Tool => "tool",
    }
}

fn compact_preview(value: &str, max_chars: usize) -> String {
    let compacted = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if compacted.chars().count() <= max_chars {
        return compacted;
    }
    let mut truncated = compacted.chars().take(max_chars).collect::<String>();
    truncated.push_str("...");
    truncated
}

fn short_hash(value: &str) -> String {
    sha256_hex(value.as_bytes()).chars().take(12).collect()
}

fn sha256_hex(data: &[u8]) -> String {
    let hash = Sha256::digest(data);
    hash.iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

#[cfg(test)]
#[path = "tests/timeline.rs"]
mod tests;
