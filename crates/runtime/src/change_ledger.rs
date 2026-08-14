use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::event_sink::now_iso8601;
use crate::file_ops::StructuredPatchHunk;
use crate::paths::workspace_root_from_env;

const CHANGE_LEDGER_DIR_NAME: &str = "changes";
const LEDGER_FILE_NAME: &str = "ledger.jsonl";
const BLOBS_DIR_NAME: &str = "blobs";
const DEFAULT_SESSION_ID: &str = "local";
const MAX_REVERT_BLOB_BYTES: usize = 2_000_000;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FileMutationContext {
    pub session_id: Option<String>,
    pub turn_id: Option<String>,
    pub tool_use_id: Option<String>,
    pub tool_name: String,
}

impl FileMutationContext {
    #[must_use]
    pub fn from_env(tool_name: impl Into<String>) -> Self {
        Self {
            session_id: non_empty_env("ARIS_SESSION_ID"),
            turn_id: non_empty_env("ARIS_TURN_ID"),
            tool_use_id: non_empty_env("ARIS_TOOL_USE_ID"),
            tool_name: tool_name.into(),
        }
    }

    #[must_use]
    pub fn with_tool_use_id(mut self, tool_use_id: Option<String>) -> Self {
        self.tool_use_id = tool_use_id.filter(|value| !value.trim().is_empty());
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FileChangeOperation {
    Create,
    Update,
    Append,
    Delete,
    Rename,
    Revert,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FileChangeStatus {
    Applied,
    Reverted,
    Conflict,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileSnapshot {
    pub exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blob_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub byte_len: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_count: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeRecord {
    pub change_id: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_use_id: Option<String>,
    pub tool_name: String,
    pub path: String,
    pub canonical_path: String,
    pub operation: FileChangeOperation,
    pub before: FileSnapshot,
    pub after: FileSnapshot,
    pub unified_diff: String,
    pub structured_patch: Vec<StructuredPatchHunk>,
    pub timestamp: String,
    pub status: FileChangeStatus,
    pub reversible: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub non_reversible_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reverts: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reverted_by: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeListInput {
    #[serde(default, alias = "session_id")]
    pub session_id: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeGetInput {
    #[serde(alias = "change_id")]
    pub change_id: String,
    #[serde(default, alias = "session_id")]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeRevertInput {
    #[serde(alias = "change_id")]
    pub change_id: String,
    #[serde(default, alias = "session_id")]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeListOutput {
    pub ledger_root: String,
    pub records: Vec<FileChangeRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeGetOutput {
    pub ledger_root: String,
    pub record: FileChangeRecord,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeRevertOutput {
    pub change_id: String,
    pub file_path: String,
    pub reverted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revert_change_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

pub fn record_text_file_change(
    context: &FileMutationContext,
    path: &Path,
    operation: FileChangeOperation,
    before_content: Option<&str>,
    after_content: Option<&str>,
    structured_patch: Vec<StructuredPatchHunk>,
    unified_diff: String,
    reverts: Option<String>,
) -> io::Result<Option<FileChangeRecord>> {
    if before_content == after_content {
        return Ok(None);
    }

    let session_id = context
        .session_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(DEFAULT_SESSION_ID)
        .to_string();
    let ledger_root = change_ledger_root_for_path(path);
    let session_dir = session_change_dir(&ledger_root, &session_id);
    fs::create_dir_all(&session_dir)?;

    let before = snapshot_for_content(&session_dir, before_content)?;
    let after = snapshot_for_content(&session_dir, after_content)?;
    let reversible = is_reversible(&before, &after);
    let non_reversible_reason = (!reversible).then(|| {
        "file content exceeded the revert blob limit, so only hashes were recorded".to_string()
    });
    let timestamp = now_iso8601();
    let change_id = make_change_id(
        &session_id,
        context.tool_use_id.as_deref(),
        &context.tool_name,
        path,
        before.content_hash.as_deref(),
        after.content_hash.as_deref(),
    );
    let record = FileChangeRecord {
        change_id,
        session_id,
        turn_id: context.turn_id.clone(),
        tool_use_id: context.tool_use_id.clone(),
        tool_name: context.tool_name.clone(),
        path: display_path(path),
        canonical_path: display_path(path),
        operation,
        before,
        after,
        unified_diff,
        structured_patch,
        timestamp,
        status: FileChangeStatus::Applied,
        reversible,
        non_reversible_reason,
        reverts,
        reverted_by: None,
    };
    append_record(&session_dir, &record)?;
    Ok(Some(record))
}

pub fn list_file_changes(input: FileChangeListInput) -> io::Result<FileChangeListOutput> {
    let ledger_root = change_ledger_root_from_env();
    let mut records = load_records(&ledger_root, input.session_id.as_deref())?;
    apply_reverted_status(&mut records);
    records.sort_by(|left, right| left.timestamp.cmp(&right.timestamp));
    if let Some(limit) = input.limit {
        let keep_from = records.len().saturating_sub(limit);
        records = records.split_off(keep_from);
    }
    Ok(FileChangeListOutput {
        ledger_root: display_path(&ledger_root),
        records,
    })
}

pub fn get_file_change(input: FileChangeGetInput) -> io::Result<FileChangeGetOutput> {
    let ledger_root = change_ledger_root_from_env();
    let mut records = load_records(&ledger_root, input.session_id.as_deref())?;
    apply_reverted_status(&mut records);
    let record = records
        .into_iter()
        .find(|record| record.change_id == input.change_id)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "change_id not found"))?;
    Ok(FileChangeGetOutput {
        ledger_root: display_path(&ledger_root),
        record,
    })
}

pub fn revert_file_change(
    input: FileChangeRevertInput,
    context: &FileMutationContext,
) -> io::Result<FileChangeRevertOutput> {
    let ledger_root = change_ledger_root_from_env();
    let mut records = load_records(&ledger_root, input.session_id.as_deref())?;
    apply_reverted_status(&mut records);
    let record = records
        .into_iter()
        .find(|record| record.change_id == input.change_id)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "change_id not found"))?;

    if record.status == FileChangeStatus::Reverted {
        return Ok(FileChangeRevertOutput {
            change_id: record.change_id,
            file_path: record.path,
            reverted: false,
            revert_change_id: record.reverted_by,
            conflict: None,
            reason: Some("change has already been reverted".to_string()),
        });
    }
    if !record.reversible {
        return Ok(FileChangeRevertOutput {
            change_id: record.change_id,
            file_path: record.path,
            reverted: false,
            revert_change_id: None,
            conflict: None,
            reason: record.non_reversible_reason,
        });
    }

    let path = PathBuf::from(&record.canonical_path);
    let current_content = read_optional_text(&path)?;
    if let Some(conflict) = revert_conflict(&record, current_content.as_deref()) {
        return Ok(FileChangeRevertOutput {
            change_id: record.change_id,
            file_path: record.path,
            reverted: false,
            revert_change_id: None,
            conflict: Some(conflict),
            reason: None,
        });
    }

    let before_content = load_snapshot_content(&ledger_root, &record.session_id, &record.before)?;
    if let Some(content) = before_content.as_deref() {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&path, content)?;
    } else if path.exists() {
        fs::remove_file(&path)?;
    }

    let after_revert_content = read_optional_text(&path)?;
    let patch = make_patch(
        current_content.as_deref().unwrap_or(""),
        after_revert_content.as_deref().unwrap_or(""),
    );
    let diff = make_unified_diff(
        &display_path(&path),
        current_content.as_deref().unwrap_or(""),
        after_revert_content.as_deref().unwrap_or(""),
    );
    let mut revert_context = context.clone();
    revert_context.session_id = Some(record.session_id.clone());
    if revert_context.tool_name.trim().is_empty() {
        revert_context.tool_name = "change_revert".to_string();
    }
    let revert_record = record_text_file_change(
        &revert_context,
        &path,
        FileChangeOperation::Revert,
        current_content.as_deref(),
        after_revert_content.as_deref(),
        patch,
        diff,
        Some(record.change_id.clone()),
    )?;

    Ok(FileChangeRevertOutput {
        change_id: record.change_id,
        file_path: record.path,
        reverted: true,
        revert_change_id: revert_record.map(|record| record.change_id),
        conflict: None,
        reason: None,
    })
}

#[must_use]
pub fn change_ledger_root_from_env() -> PathBuf {
    crate::somniq_project_dir(workspace_root_from_env()).join(CHANGE_LEDGER_DIR_NAME)
}

#[must_use]
pub fn change_ledger_root_for_path(path: &Path) -> PathBuf {
    project_root_for_path(path)
        .join(crate::SOMNIQ_PROJECT_DIR_NAME)
        .join(CHANGE_LEDGER_DIR_NAME)
}

fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

fn snapshot_for_content(session_dir: &Path, content: Option<&str>) -> io::Result<FileSnapshot> {
    let Some(content) = content else {
        return Ok(FileSnapshot {
            exists: false,
            content_hash: None,
            blob_ref: None,
            byte_len: None,
            line_count: None,
        });
    };

    let content_hash = sha256_hex(content.as_bytes());
    let blob_ref = if content.len() <= MAX_REVERT_BLOB_BYTES {
        let blobs_dir = session_dir.join(BLOBS_DIR_NAME);
        fs::create_dir_all(&blobs_dir)?;
        let blob_path = blobs_dir.join(&content_hash);
        if !blob_path.exists() {
            fs::write(&blob_path, content)?;
        }
        Some(content_hash.clone())
    } else {
        None
    };

    Ok(FileSnapshot {
        exists: true,
        content_hash: Some(content_hash),
        blob_ref,
        byte_len: Some(content.len()),
        line_count: Some(content.lines().count()),
    })
}

fn is_reversible(before: &FileSnapshot, after: &FileSnapshot) -> bool {
    (!before.exists || before.blob_ref.is_some()) && (!after.exists || after.blob_ref.is_some())
}

fn append_record(session_dir: &Path, record: &FileChangeRecord) -> io::Result<()> {
    let ledger_path = session_dir.join(LEDGER_FILE_NAME);
    let line = serde_json::to_string(record).map_err(io::Error::other)?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(ledger_path)?;
    file.write_all(line.as_bytes())?;
    file.write_all(b"\n")?;
    file.flush()
}

fn load_records(ledger_root: &Path, session_id: Option<&str>) -> io::Result<Vec<FileChangeRecord>> {
    let mut records = Vec::new();
    if let Some(session_id) = session_id {
        read_records_file(
            &session_change_dir(ledger_root, session_id).join(LEDGER_FILE_NAME),
            &mut records,
        )?;
        return Ok(records);
    }
    let Ok(entries) = fs::read_dir(ledger_root) else {
        return Ok(records);
    };
    for entry in entries {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            read_records_file(&entry.path().join(LEDGER_FILE_NAME), &mut records)?;
        }
    }
    Ok(records)
}

fn read_records_file(path: &Path, records: &mut Vec<FileChangeRecord>) -> io::Result<()> {
    let Ok(content) = fs::read_to_string(path) else {
        return Ok(());
    };
    for (index, line) in content.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let record = serde_json::from_str::<FileChangeRecord>(line).map_err(|error| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "invalid change ledger record at {}:{}: {error}",
                    path.display(),
                    index + 1
                ),
            )
        })?;
        records.push(record);
    }
    Ok(())
}

fn apply_reverted_status(records: &mut [FileChangeRecord]) {
    let reverted = records
        .iter()
        .filter_map(|record| {
            record
                .reverts
                .clone()
                .map(|target| (target, record.change_id.clone()))
        })
        .collect::<Vec<_>>();
    for record in records {
        if let Some((_, revert_id)) = reverted
            .iter()
            .find(|(target, _)| target == &record.change_id)
        {
            record.status = FileChangeStatus::Reverted;
            record.reverted_by = Some(revert_id.clone());
        }
    }
}

fn load_snapshot_content(
    ledger_root: &Path,
    session_id: &str,
    snapshot: &FileSnapshot,
) -> io::Result<Option<String>> {
    if !snapshot.exists {
        return Ok(None);
    }
    let blob_ref = snapshot
        .blob_ref
        .as_ref()
        .ok_or_else(|| io::Error::other("snapshot blob is unavailable"))?;
    let path = session_change_dir(ledger_root, session_id)
        .join(BLOBS_DIR_NAME)
        .join(blob_ref);
    fs::read_to_string(path).map(Some)
}

fn revert_conflict(record: &FileChangeRecord, current_content: Option<&str>) -> Option<String> {
    match (record.after.exists, current_content) {
        (true, Some(content)) => {
            let current_hash = sha256_hex(content.as_bytes());
            let expected = record.after.content_hash.as_deref().unwrap_or_default();
            (current_hash != expected).then(|| {
                format!(
                    "current file hash {current_hash} does not match recorded after hash {expected}"
                )
            })
        }
        (true, None) => {
            Some("file is missing but the recorded change expected it to exist".to_string())
        }
        (false, Some(_)) => {
            Some("file exists but the recorded change expected it to be absent".to_string())
        }
        (false, None) => None,
    }
}

fn read_optional_text(path: &Path) -> io::Result<Option<String>> {
    match fs::read_to_string(path) {
        Ok(content) => Ok(Some(content)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn session_change_dir(ledger_root: &Path, session_id: &str) -> PathBuf {
    ledger_root.join(sanitize_component(session_id))
}

fn sanitize_component(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    if sanitized.is_empty() {
        DEFAULT_SESSION_ID.to_string()
    } else {
        sanitized
    }
}

fn project_root_for_path(path: &Path) -> PathBuf {
    if let Some(root) =
        crate::execution_env_var_os(crate::ARIS_WORKSPACE_ROOT_ENV).map(PathBuf::from)
    {
        return root;
    }
    let anchor = path.parent().unwrap_or(path);
    for ancestor in anchor.ancestors() {
        if ancestor.join(crate::SOMNIQ_PROJECT_DIR_NAME).exists() || ancestor.join(".git").exists()
        {
            return ancestor.to_path_buf();
        }
    }
    let cwd = crate::execution_current_dir().unwrap_or_else(|_| PathBuf::from("."));
    if path.starts_with(&cwd) {
        cwd
    } else {
        anchor.to_path_buf()
    }
}

fn make_change_id(
    session_id: &str,
    tool_use_id: Option<&str>,
    tool_name: &str,
    path: &Path,
    before_hash: Option<&str>,
    after_hash: Option<&str>,
) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(session_id.as_bytes());
    hasher.update(tool_use_id.unwrap_or_default().as_bytes());
    hasher.update(tool_name.as_bytes());
    hasher.update(path.to_string_lossy().as_bytes());
    hasher.update(before_hash.unwrap_or_default().as_bytes());
    hasher.update(after_hash.unwrap_or_default().as_bytes());
    hasher.update(nanos.to_string().as_bytes());
    let full = format!("{:x}", hasher.finalize());
    format!("chg_{}", &full[..16])
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn make_patch(original: &str, updated: &str) -> Vec<StructuredPatchHunk> {
    if original == updated {
        return Vec::new();
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

    let mut lines = Vec::new();
    for line in &original_lines[start..old_end] {
        lines.push(format!("-{line}"));
    }
    for line in &updated_lines[start..new_end] {
        lines.push(format!("+{line}"));
    }

    vec![StructuredPatchHunk {
        old_start: start + 1,
        old_lines: old_end.saturating_sub(start),
        new_start: start + 1,
        new_lines: new_end.saturating_sub(start),
        lines,
    }]
}

fn make_unified_diff(file_path: &str, original: &str, updated: &str) -> String {
    let hunks = make_patch(original, updated);
    if hunks.is_empty() {
        return String::new();
    }

    let mut diff = format!("--- {file_path}\n+++ {file_path}");
    for hunk in hunks {
        diff.push('\n');
        diff.push_str(&format!(
            "@@ -{} +{} @@",
            unified_range(hunk.old_start, hunk.old_lines),
            unified_range(hunk.new_start, hunk.new_lines),
        ));
        for line in hunk.lines {
            diff.push('\n');
            diff.push_str(&line);
        }
    }
    diff
}

fn unified_range(start: usize, lines: usize) -> String {
    if lines == 1 {
        start.to_string()
    } else {
        format!("{start},{lines}")
    }
}

#[cfg(test)]
#[path = "tests/change_ledger.rs"]
mod tests;
