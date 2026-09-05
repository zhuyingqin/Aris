use std::cmp::Reverse;
use std::collections::{BTreeMap, VecDeque};
use std::ffi::OsString;
use std::fs;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::time::Instant;

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use encoding_rs::{GB18030, GBK};
use flate2::read::{DeflateDecoder, ZlibDecoder};
use glob::Pattern;
use regex::RegexBuilder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use walkdir::WalkDir;

use crate::change_ledger::{record_text_file_change, FileChangeOperation, FileMutationContext};

const MAX_READ_FILE_CONTENT_CHARS: usize = 64_000;
/// Matches the desktop composer's own image attachment cap
/// (`MAX_IMAGE_BYTES` in `ChatComposer.tsx`) so the two entry points into the
/// model's vision input behave consistently.
const MAX_READ_IMAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_IMPLICIT_READ_FILE_CHARS: usize = 48_000;
const MAX_IMPLICIT_READ_FILE_LINES: usize = 800;
const STREAMING_TEXT_READ_THRESHOLD_BYTES: u64 = 512 * 1024;
const MAX_STREAM_LINE_PREVIEW_CHARS: usize = 8_000;
const LONG_FILE_HEAD_LINES: usize = 120;
const LONG_FILE_TAIL_LINES: usize = 40;
const LONG_FILE_MAX_OUTLINE_LINES: usize = 200;
const EDIT_CONTEXT_LINES: usize = 5;
const MAX_EDIT_CONTEXT_WINDOWS: usize = 4;
const MAX_EDIT_TOOL_DIFF_CHARS: usize = 24_000;
const MAX_STRUCTURED_PATCH_LINES: usize = 400;
const MAX_STRUCTURED_PATCH_LINE_CHARS: usize = 1_000;
const MAX_MULTI_EDIT_OPERATIONS: usize = 64;
const MAX_GLOB_SEARCH_RESULTS: usize = 100;
const READONLY_ROOTS_ENV: &str = "ARIS_READONLY_ROOTS";
pub const ABSENT_FILE_REVISION: &str = "absent";
pub const MAX_FILE_TOOL_PAYLOAD_BYTES: usize = 8 * 1024 * 1024;
const MAX_STAGED_WRITE_TOTAL_BYTES: usize = 128 * 1024 * 1024;
const STAGED_WRITE_DIR_NAME: &str = "file-writes";
const STAGED_WRITE_FORMAT_VERSION: u8 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TextFilePayload {
    #[serde(rename = "filePath")]
    pub file_path: String,
    pub content: String,
    #[serde(rename = "numLines")]
    pub num_lines: usize,
    #[serde(rename = "startLine")]
    pub start_line: usize,
    #[serde(rename = "totalLines")]
    pub total_lines: usize,
    #[serde(rename = "totalChars")]
    pub total_chars: usize,
    /// Content revision over the exact bytes on disk. Mutating tools accept
    /// this value as `expected_revision` so a model cannot overwrite changes
    /// made after the read it based its edit on.
    pub revision: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReadFileOutput {
    #[serde(rename = "type")]
    pub kind: String,
    pub file: TextFilePayload,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReadImageOutput {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(rename = "filePath")]
    pub file_path: String,
    #[serde(rename = "mediaType")]
    pub media_type: String,
    pub base64: String,
    pub bytes: usize,
}

/// `read_file` result once image files are recognized rather than rejected
/// as unreadable binary. Untagged: each variant already carries its own
/// `"type"` discriminator (`"text"` / `"image"`), matching `ReadFileOutput`'s
/// existing convention instead of introducing a second, redundant tag.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum ReadFileResult {
    Text(ReadFileOutput),
    Image(ReadImageOutput),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StructuredPatchHunk {
    #[serde(rename = "oldStart")]
    pub old_start: usize,
    #[serde(rename = "oldLines")]
    pub old_lines: usize,
    #[serde(rename = "newStart")]
    pub new_start: usize,
    #[serde(rename = "newLines")]
    pub new_lines: usize,
    pub lines: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FileChange {
    Add {
        content: String,
    },
    Delete {
        content: String,
    },
    Update {
        unified_diff: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        move_path: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WriteFileOutput {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(rename = "filePath")]
    pub file_path: String,
    pub changes: BTreeMap<String, FileChange>,
    pub content: String,
    #[serde(rename = "structuredPatch")]
    pub structured_patch: Vec<StructuredPatchHunk>,
    #[serde(rename = "originalFile")]
    pub original_file: Option<String>,
    #[serde(rename = "gitDiff")]
    pub git_diff: Option<serde_json::Value>,
    #[serde(rename = "changeId", skip_serializing_if = "Option::is_none")]
    pub change_id: Option<String>,
    pub revision: String,
    pub bytes: usize,
    pub lines: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AppendFileOutput {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(rename = "filePath")]
    pub file_path: String,
    pub created: bool,
    #[serde(rename = "appendedChars")]
    pub appended_chars: usize,
    #[serde(rename = "appendedBytes")]
    pub appended_bytes: usize,
    #[serde(rename = "totalChars")]
    pub total_chars: usize,
    #[serde(rename = "totalLines")]
    pub total_lines: usize,
    pub changes: BTreeMap<String, FileChange>,
    #[serde(rename = "structuredPatch")]
    pub structured_patch: Vec<StructuredPatchHunk>,
    #[serde(rename = "changeId", skip_serializing_if = "Option::is_none")]
    pub change_id: Option<String>,
    pub revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EditFileOutput {
    #[serde(rename = "filePath")]
    pub file_path: String,
    #[serde(skip_serializing)]
    pub updated_file: String,
    #[serde(rename = "oldString", skip_serializing)]
    pub old_string: String,
    #[serde(rename = "newString", skip_serializing)]
    pub new_string: String,
    #[serde(rename = "originalFile", skip_serializing)]
    pub original_file: String,
    #[serde(rename = "structuredPatch", skip_serializing)]
    pub structured_patch: Vec<StructuredPatchHunk>,
    pub changes: BTreeMap<String, FileChange>,
    pub context: Vec<EditContextWindow>,
    pub replacements: usize,
    #[serde(rename = "userModified")]
    pub user_modified: bool,
    #[serde(rename = "replaceAll")]
    pub replace_all: bool,
    #[serde(rename = "gitDiff", skip_serializing_if = "Option::is_none")]
    pub git_diff: Option<serde_json::Value>,
    #[serde(rename = "changeId", skip_serializing_if = "Option::is_none")]
    pub change_id: Option<String>,
    pub revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EditContextWindow {
    #[serde(rename = "startLine")]
    pub start_line: usize,
    #[serde(rename = "endLine")]
    pub end_line: usize,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MultiEditOperation {
    #[serde(rename = "oldString")]
    pub old_string: String,
    #[serde(rename = "newString")]
    pub new_string: String,
    #[serde(rename = "replaceAll")]
    pub replace_all: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MultiEditOutput {
    #[serde(rename = "filePath")]
    pub file_path: String,
    #[serde(rename = "editsApplied")]
    pub edits_applied: usize,
    pub replacements: usize,
    pub changes: BTreeMap<String, FileChange>,
    pub context: Vec<EditContextWindow>,
    #[serde(rename = "structuredPatch", skip_serializing)]
    pub structured_patch: Vec<StructuredPatchHunk>,
    #[serde(rename = "changeId", skip_serializing_if = "Option::is_none")]
    pub change_id: Option<String>,
    pub revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MultiEditValidationIssue {
    pub edit_index: usize,
    pub field: String,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    pub recovery: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MultiEditValidationError {
    pub ok: bool,
    pub code: String,
    pub atomic: bool,
    pub applied: usize,
    pub total_edits: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_revision: Option<String>,
    pub issues: Vec<MultiEditValidationIssue>,
    pub parameter_valid_but_not_applied: Vec<usize>,
    pub retry: String,
    pub message: String,
}

impl std::fmt::Display for MultiEditValidationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match serde_json::to_string_pretty(self) {
            Ok(json) => formatter.write_str(&json),
            Err(_) => formatter.write_str(&self.message),
        }
    }
}

impl std::error::Error for MultiEditValidationError {}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileRevisionConflictError {
    pub ok: bool,
    pub code: String,
    pub file_path: String,
    pub expected_revision: String,
    pub current_revision: String,
    pub retry: String,
    pub message: String,
}

impl std::fmt::Display for FileRevisionConflictError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match serde_json::to_string_pretty(self) {
            Ok(json) => formatter.write_str(&json),
            Err(_) => formatter.write_str(&self.message),
        }
    }
}

impl std::error::Error for FileRevisionConflictError {}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LargeWriteBeginOutput {
    pub ok: bool,
    pub write_id: String,
    pub file_path: String,
    pub expected_revision: String,
    pub next_sequence: usize,
    pub chunk_bytes_limit: usize,
    pub total_bytes_limit: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LargeWriteChunkOutput {
    pub ok: bool,
    pub write_id: String,
    pub accepted_sequence: usize,
    pub already_accepted: bool,
    pub next_sequence: usize,
    pub appended_bytes: usize,
    pub staged_bytes: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LargeWriteAbortOutput {
    pub ok: bool,
    pub write_id: String,
    pub aborted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum StagedWriteStatus {
    Open,
    Committing,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct StagedWriteChunk {
    bytes: usize,
    sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct StagedWriteMetadata {
    version: u8,
    write_id: String,
    target_path: String,
    expected_revision: String,
    session_id: Option<String>,
    status: StagedWriteStatus,
    chunks: Vec<StagedWriteChunk>,
    staged_bytes: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GlobSearchOutput {
    #[serde(rename = "durationMs")]
    pub duration_ms: u128,
    #[serde(rename = "numFiles")]
    pub num_files: usize,
    pub filenames: Vec<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GrepSearchInput {
    pub pattern: String,
    pub path: Option<String>,
    pub glob: Option<String>,
    #[serde(rename = "output_mode")]
    pub output_mode: Option<String>,
    #[serde(rename = "-B")]
    pub before: Option<usize>,
    #[serde(rename = "-A")]
    pub after: Option<usize>,
    #[serde(rename = "-C")]
    pub context_short: Option<usize>,
    pub context: Option<usize>,
    #[serde(rename = "-n")]
    pub line_numbers: Option<bool>,
    #[serde(rename = "-i")]
    pub case_insensitive: Option<bool>,
    #[serde(rename = "type")]
    pub file_type: Option<String>,
    pub head_limit: Option<usize>,
    pub offset: Option<usize>,
    pub multiline: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GrepSearchOutput {
    pub mode: Option<String>,
    #[serde(rename = "numFiles")]
    pub num_files: usize,
    pub filenames: Vec<String>,
    pub content: Option<String>,
    #[serde(rename = "numLines")]
    pub num_lines: Option<usize>,
    #[serde(rename = "numMatches")]
    pub num_matches: Option<usize>,
    #[serde(rename = "appliedLimit")]
    pub applied_limit: Option<usize>,
    #[serde(rename = "appliedOffset")]
    pub applied_offset: Option<usize>,
}

pub fn read_file(
    path: &str,
    offset: Option<usize>,
    limit: Option<usize>,
) -> io::Result<ReadFileOutput> {
    let absolute_path = normalize_read_path(path)?;
    if !is_pdf_path(&absolute_path)
        && fs::metadata(&absolute_path)?.len() >= STREAMING_TEXT_READ_THRESHOLD_BYTES
    {
        if let Some(output) = read_large_utf8_file_streaming(&absolute_path, offset, limit)? {
            return Ok(output);
        }
    }
    let bytes = fs::read(&absolute_path)?;
    let revision = content_revision(&bytes);
    let content = if is_pdf_path(&absolute_path) {
        extract_pdf_text_bytes(&absolute_path, &bytes)?
    } else {
        decode_text_bytes(&bytes)?
    };
    Ok(read_text_payload(
        absolute_path,
        &content,
        offset,
        limit,
        revision,
    ))
}

/// Entry point for tool dispatch: like `read_file`, but recognized image
/// formats are inlined as base64 instead of failing `decode_text_bytes` with
/// a "not a supported text file" error. The turn loop splits the returned
/// `ReadFileResult::Image` into a text tool result plus a following
/// `ContentBlock::Image`, so the model actually sees the picture instead of
/// just being told the read failed.
pub fn read_file_with_images(
    path: &str,
    offset: Option<usize>,
    limit: Option<usize>,
) -> io::Result<ReadFileResult> {
    if image_media_type(path).is_some() {
        return read_image_file(path).map(ReadFileResult::Image);
    }
    read_file(path, offset, limit).map(ReadFileResult::Text)
}

fn image_media_type(path: &str) -> Option<&'static str> {
    let extension = Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())?
        .to_ascii_lowercase();
    match extension.as_str() {
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        _ => None,
    }
}

fn read_image_file(path: &str) -> io::Result<ReadImageOutput> {
    let absolute_path = normalize_read_path(path)?;
    let bytes = fs::read(&absolute_path)?;
    if bytes.len() > MAX_READ_IMAGE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "image is {} bytes, over the {}MB read_file limit; ask the user to attach it in Chat instead so you can see it directly",
                bytes.len(),
                MAX_READ_IMAGE_BYTES / 1024 / 1024
            ),
        ));
    }
    // media_type is `Some` here: `read_file_with_images` only calls this
    // function after `image_media_type` already matched.
    let media_type = image_media_type(path).unwrap_or("application/octet-stream");
    Ok(ReadImageOutput {
        kind: "image".to_string(),
        file_path: absolute_path.to_string_lossy().into_owned(),
        media_type: media_type.to_string(),
        bytes: bytes.len(),
        base64: BASE64_STANDARD.encode(&bytes),
    })
}

fn decode_text_bytes(bytes: &[u8]) -> io::Result<String> {
    if bytes.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "file contains NUL bytes and is not a supported text file; open it in its native app",
        ));
    }

    if let Ok(content) = std::str::from_utf8(bytes) {
        return Ok(content.to_owned());
    }

    for encoding in [GB18030, GBK] {
        let (content, _, had_errors) = encoding.decode(bytes);
        if !had_errors {
            return Ok(content.into_owned());
        }
    }

    Err(io::Error::new(
        io::ErrorKind::InvalidData,
        "file is not valid UTF-8, GB18030, or GBK text; open it in its native app",
    ))
}

/// Decodes subprocess stdout/stderr as text, falling back through GB18030/GBK
/// before a lossy UTF-8 decode. CLI tools on zh-CN Windows (TeX Live, Python,
/// etc.) commonly write console output in the active local codepage (CP936)
/// rather than UTF-8; a plain `from_utf8_lossy` turns that into replacement
/// characters instead of readable text. Unlike `decode_text_bytes`, this never
/// errors — process output must always yield *something* back to the caller.
pub fn decode_process_text(bytes: &[u8]) -> String {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_string();
    }
    for encoding in [GB18030, GBK] {
        let (text, _, had_errors) = encoding.decode(bytes);
        if !had_errors {
            return text.into_owned();
        }
    }
    String::from_utf8_lossy(bytes).into_owned()
}

fn read_text_payload(
    absolute_path: PathBuf,
    content: &str,
    offset: Option<usize>,
    limit: Option<usize>,
    revision: String,
) -> ReadFileOutput {
    let lines: Vec<&str> = content.lines().collect();
    let total_chars = content.chars().count();
    if offset.is_none()
        && limit.is_none()
        && (total_chars > MAX_IMPLICIT_READ_FILE_CHARS
            || lines.len() > MAX_IMPLICIT_READ_FILE_LINES)
    {
        let content = long_file_preview(&lines, total_chars);
        return ReadFileOutput {
            kind: String::from("text"),
            file: TextFilePayload {
                file_path: display_path(&absolute_path),
                num_lines: content.lines().count(),
                start_line: 1,
                total_lines: lines.len(),
                total_chars,
                revision,
                content,
                truncated: true,
            },
        };
    }

    let start_index = offset.unwrap_or(0).min(lines.len());
    let end_index = limit.map_or(lines.len(), |limit| {
        start_index.saturating_add(limit).min(lines.len())
    });
    let selected = lines[start_index..end_index].join("\n");
    let (content, truncated) = truncate_read_content(selected);

    ReadFileOutput {
        kind: String::from("text"),
        file: TextFilePayload {
            file_path: display_path(&absolute_path),
            content,
            num_lines: end_index.saturating_sub(start_index),
            start_line: start_index.saturating_add(1),
            total_lines: lines.len(),
            total_chars,
            revision,
            truncated,
        },
    }
}

/// Stream large UTF-8 text files so an implicit preview does not first clone
/// the entire document and every line. `None` means the byte stream is not
/// UTF-8; the caller then performs the existing GB18030/GBK fallback.
fn read_large_utf8_file_streaming(
    path: &Path,
    offset: Option<usize>,
    limit: Option<usize>,
) -> io::Result<Option<ReadFileOutput>> {
    let explicit_range = offset.is_some() || limit.is_some();
    let start_index = offset.unwrap_or(0);
    let requested_limit = limit.unwrap_or(usize::MAX);
    let mut accumulator =
        StreamingTextAccumulator::new(explicit_range, start_index, requested_limit);
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut chunk = [0_u8; 64 * 1024];
    let mut pending = Vec::<u8>::new();

    loop {
        let read = file.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        let bytes = &chunk[..read];
        if bytes.contains(&0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "file contains NUL bytes and is not a supported text file; open it in its native app",
            ));
        }
        hasher.update(bytes);
        pending.extend_from_slice(bytes);
        match std::str::from_utf8(&pending) {
            Ok(text) => {
                accumulator.push_text(text);
                pending.clear();
            }
            Err(error) if error.error_len().is_none() => {
                let valid_up_to = error.valid_up_to();
                let valid = std::str::from_utf8(&pending[..valid_up_to])
                    .expect("from_utf8 valid_up_to is a valid UTF-8 boundary");
                accumulator.push_text(valid);
                pending.drain(..valid_up_to);
                if pending.len() > 3 {
                    return Ok(None);
                }
            }
            Err(_) => return Ok(None),
        }
    }
    if !pending.is_empty() {
        // An incomplete final code point is invalid UTF-8; a legacy encoding
        // fallback may still decode the complete file correctly.
        return Ok(None);
    }
    accumulator.finish_eof();
    let revision = format!("sha256:{:x}", hasher.finalize());
    Ok(Some(accumulator.into_output(path, revision)))
}

struct StreamingTextAccumulator {
    explicit_range: bool,
    start_index: usize,
    requested_limit: usize,
    total_chars: usize,
    total_lines: usize,
    current_line: String,
    current_line_chars: usize,
    current_stored_chars: usize,
    current_ends_with_cr: bool,
    any_line_truncated: bool,
    selected: Vec<String>,
    head: Vec<String>,
    tail: VecDeque<(usize, String)>,
    outline: Vec<String>,
}

impl StreamingTextAccumulator {
    fn new(explicit_range: bool, start_index: usize, requested_limit: usize) -> Self {
        Self {
            explicit_range,
            start_index,
            requested_limit,
            total_chars: 0,
            total_lines: 0,
            current_line: String::new(),
            current_line_chars: 0,
            current_stored_chars: 0,
            current_ends_with_cr: false,
            any_line_truncated: false,
            selected: Vec::new(),
            head: Vec::new(),
            tail: VecDeque::with_capacity(LONG_FILE_TAIL_LINES),
            outline: Vec::new(),
        }
    }

    fn push_text(&mut self, text: &str) {
        for character in text.chars() {
            self.total_chars = self.total_chars.saturating_add(1);
            if character == '\n' {
                self.finish_line(true);
                continue;
            }
            self.current_line_chars = self.current_line_chars.saturating_add(1);
            self.current_ends_with_cr = character == '\r';
            if self.current_stored_chars < MAX_STREAM_LINE_PREVIEW_CHARS {
                self.current_line.push(character);
                self.current_stored_chars += 1;
            }
        }
    }

    fn finish_eof(&mut self) {
        if self.current_line_chars > 0 {
            self.finish_line(false);
        }
    }

    fn finish_line(&mut self, terminated_by_newline: bool) {
        let had_cr_terminator = terminated_by_newline && self.current_ends_with_cr;
        if had_cr_terminator && self.current_line.ends_with('\r') {
            self.current_line.pop();
            self.current_stored_chars = self.current_stored_chars.saturating_sub(1);
        }
        let effective_chars = self
            .current_line_chars
            .saturating_sub(usize::from(had_cr_terminator));
        let was_truncated = effective_chars > self.current_stored_chars;
        if was_truncated {
            self.current_line.push_str(&format!(
                "… [line preview truncated from {effective_chars} chars]"
            ));
            self.any_line_truncated = true;
        }

        let line_index = self.total_lines;
        let line_number = line_index + 1;
        if self.explicit_range {
            let end = self.start_index.saturating_add(self.requested_limit);
            if line_index >= self.start_index && line_index < end {
                self.selected.push(self.current_line.clone());
            }
        } else {
            if self.head.len() < LONG_FILE_HEAD_LINES {
                self.head.push(self.current_line.clone());
            }
            if self.tail.len() == LONG_FILE_TAIL_LINES {
                self.tail.pop_front();
            }
            self.tail
                .push_back((line_number, self.current_line.clone()));
            if self.outline.len() < LONG_FILE_MAX_OUTLINE_LINES {
                let trimmed = self.current_line.trim_start();
                if is_markdown_heading(trimmed) {
                    self.outline.push(format!("L{line_number}: {trimmed}"));
                }
            }
        }
        self.total_lines = self.total_lines.saturating_add(1);
        self.current_line.clear();
        self.current_line_chars = 0;
        self.current_stored_chars = 0;
        self.current_ends_with_cr = false;
    }

    fn into_output(self, path: &Path, revision: String) -> ReadFileOutput {
        if self.explicit_range {
            let (content, output_truncated) = truncate_read_content(self.selected.join("\n"));
            let start = self.start_index.min(self.total_lines);
            return ReadFileOutput {
                kind: "text".to_string(),
                file: TextFilePayload {
                    file_path: display_path(path),
                    num_lines: self.selected.len(),
                    start_line: start.saturating_add(1),
                    total_lines: self.total_lines,
                    total_chars: self.total_chars,
                    revision,
                    content,
                    truncated: self.any_line_truncated || output_truncated,
                },
            };
        }

        let mut out = vec![format!(
            "[read_file long-file preview: full file is {} lines / {} chars. This preview is intentionally partial. Use read_file with offset/limit to read one section window at a time.]",
            self.total_lines, self.total_chars
        )];
        if !self.outline.is_empty() {
            out.push(String::new());
            out.push(format!(
                "[outline: first {} markdown heading lines]",
                self.outline.len()
            ));
            out.extend(self.outline);
        }
        if !self.head.is_empty() {
            out.push(String::new());
            out.push(format!("[head: lines 1-{}]", self.head.len()));
            out.extend(numbered_lines(
                &self.head.iter().map(String::as_str).collect::<Vec<_>>(),
                1,
            ));
        }
        let tail = self
            .tail
            .into_iter()
            .filter(|(line_number, _)| *line_number > self.head.len())
            .collect::<Vec<_>>();
        if let (Some((first, _)), Some((last, _))) = (tail.first(), tail.last()) {
            out.push(String::new());
            out.push(format!("[tail: lines {first}-{last}]"));
            out.extend(
                tail.into_iter()
                    .map(|(line_number, line)| format!("L{line_number}: {line}")),
            );
        }
        let (content, _output_truncated) = truncate_read_content(out.join("\n"));
        let preview_lines = content.lines().count();
        ReadFileOutput {
            kind: "text".to_string(),
            file: TextFilePayload {
                file_path: display_path(path),
                num_lines: preview_lines,
                start_line: 1,
                total_lines: self.total_lines,
                total_chars: self.total_chars,
                revision,
                content,
                truncated: true,
            },
        }
    }
}

#[must_use]
pub fn content_revision(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("sha256:{:x}", hasher.finalize())
}

pub fn file_revision(path: &str) -> io::Result<String> {
    let path = normalize_read_path(path)?;
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("sha256:{:x}", hasher.finalize()))
}

fn long_file_preview(lines: &[&str], total_chars: usize) -> String {
    let total_lines = lines.len();
    let mut out = Vec::new();
    out.push(format!(
        "[read_file long-file preview: full file is {total_lines} lines / {total_chars} chars. This preview is intentionally partial. Use read_file with offset/limit to read one section window at a time.]"
    ));

    let outline = markdown_outline_lines(lines);
    if !outline.is_empty() {
        out.push(String::new());
        out.push(format!(
            "[outline: first {} markdown heading lines]",
            outline.len()
        ));
        out.extend(outline);
    }

    let head_end = LONG_FILE_HEAD_LINES.min(total_lines);
    if head_end > 0 {
        out.push(String::new());
        out.push(format!("[head: lines 1-{head_end}]"));
        out.extend(numbered_lines(&lines[..head_end], 1));
    }

    let tail_start = total_lines
        .saturating_sub(LONG_FILE_TAIL_LINES)
        .max(head_end);
    if tail_start < total_lines {
        out.push(String::new());
        out.push(format!("[tail: lines {}-{total_lines}]", tail_start + 1));
        out.extend(numbered_lines(&lines[tail_start..], tail_start + 1));
    }

    let preview = out.join("\n");
    truncate_read_content(preview).0
}

fn markdown_outline_lines(lines: &[&str]) -> Vec<String> {
    lines
        .iter()
        .enumerate()
        .filter_map(|(index, line)| {
            let trimmed = line.trim_start();
            is_markdown_heading(trimmed).then(|| format!("L{}: {trimmed}", index + 1))
        })
        .take(LONG_FILE_MAX_OUTLINE_LINES)
        .collect()
}

fn is_markdown_heading(line: &str) -> bool {
    let hashes = line.chars().take_while(|ch| *ch == '#').count();
    (1..=6).contains(&hashes) && line.chars().nth(hashes).is_some_and(char::is_whitespace)
}

fn numbered_lines(lines: &[&str], start_line: usize) -> Vec<String> {
    lines
        .iter()
        .enumerate()
        .map(|(offset, line)| format!("L{}: {line}", start_line + offset))
        .collect()
}

fn truncate_read_content(content: String) -> (String, bool) {
    if content.chars().count() <= MAX_READ_FILE_CONTENT_CHARS {
        return (content, false);
    }

    let mut truncated = content
        .chars()
        .take(MAX_READ_FILE_CONTENT_CHARS)
        .collect::<String>();
    truncated.push_str(
        "\n\n[read_file truncated: selected content exceeded 64000 characters. Use a narrower offset/limit window or grep_search.]",
    );
    (truncated, true)
}

pub fn write_file(path: &str, content: &str) -> io::Result<WriteFileOutput> {
    let context = FileMutationContext::from_env("write_file");
    write_file_with_context(path, content, &context)
}

/// Replace a workspace file's whole contents without ever leaving a truncated
/// file at its path.
///
/// `fs::write` truncates the destination to zero and then writes, so a process
/// that dies in between has destroyed the old contents without having produced
/// the new ones — the file ends up worse than before the edit, and the change
/// ledger cannot help because it records the intended change, not the crash
/// state. `write_replace` writes a sibling temporary file, fsyncs it, and
/// renames it over the destination, so the path only ever holds the complete
/// old contents or the complete new ones.
///
/// The rename means the destination inherits the temporary file's permissions,
/// so an existing file's mode is captured first and restored afterwards.
/// Without that, editing a `chmod +x` script would silently drop its executable
/// bit. A failure to restore is not worth failing the write over: the content
/// landed, and the mode is recoverable.
/// Call only while holding the destination's [`crate::atomic_file::with_path_lock`].
pub(crate) fn replace_file_contents_unlocked(
    absolute_path: &Path,
    content: &str,
) -> io::Result<()> {
    let permissions = fs::metadata(absolute_path)
        .ok()
        .map(|metadata| metadata.permissions());
    crate::atomic_file::write_replace_unlocked(absolute_path, content.as_bytes())?;
    if let Some(permissions) = permissions {
        let _ = fs::set_permissions(absolute_path, permissions);
    }
    Ok(())
}

fn read_optional_utf8(path: &Path) -> io::Result<Option<String>> {
    match fs::read(path) {
        Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|error| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "`{}` is not valid UTF-8 at byte {}; text mutation was refused without lossy decoding",
                    path.display(),
                    error.utf8_error().valid_up_to()
                ),
            )
        }),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn current_revision(content: Option<&str>) -> String {
    content.map_or_else(
        || ABSENT_FILE_REVISION.to_string(),
        |content| content_revision(content.as_bytes()),
    )
}

fn validate_expected_revision(
    path: &Path,
    expected_revision: Option<&str>,
    current_content: Option<&str>,
) -> io::Result<()> {
    let Some(expected_revision) = expected_revision else {
        // Compatibility for internal callers and persisted invocations from
        // before revision tokens were added. New tool schemas require one.
        return Ok(());
    };
    let expected_revision = expected_revision.trim();
    let current_revision = current_revision(current_content);
    let valid_hash = expected_revision
        .strip_prefix("sha256:")
        .is_some_and(|hash| hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()));
    if expected_revision != ABSENT_FILE_REVISION && !valid_hash {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "expected_revision must be `{ABSENT_FILE_REVISION}` for a new path or the `sha256:...` revision returned by read_file"
            ),
        ));
    }
    if expected_revision == current_revision {
        return Ok(());
    }

    let error = FileRevisionConflictError {
        ok: false,
        code: "revision_conflict".to_string(),
        file_path: display_path(path),
        expected_revision: expected_revision.to_string(),
        current_revision,
        retry: "Re-read the current file or focused window, rebuild the edit against that revision, and retry once. No changes were written.".to_string(),
        message: "The target changed after the caller's source read; the stale mutation was rejected. No changes were written.".to_string(),
    };
    Err(io::Error::new(io::ErrorKind::Other, error))
}

pub fn write_file_with_context(
    path: &str,
    content: &str,
    context: &FileMutationContext,
) -> io::Result<WriteFileOutput> {
    write_file_with_context_expected(path, content, None, context)
}

pub fn write_file_with_context_expected(
    path: &str,
    content: &str,
    expected_revision: Option<&str>,
    context: &FileMutationContext,
) -> io::Result<WriteFileOutput> {
    let absolute_path = normalize_path_allow_missing(path)?;
    let (original_file, content) = crate::atomic_file::with_path_lock(&absolute_path, || {
        let original_file = read_optional_utf8(&absolute_path)?;
        validate_expected_revision(&absolute_path, expected_revision, original_file.as_deref())?;
        let content = harmonize_write_eol(original_file.as_deref(), content);
        // `replace_file_contents_unlocked` creates the parent directory itself.
        replace_file_contents_unlocked(&absolute_path, &content)?;
        Ok::<_, io::Error>((original_file, content))
    })?;

    let file_path = display_path(&absolute_path);
    let structured_patch = make_patch(original_file.as_deref().unwrap_or(""), &content);
    let changes = make_file_changes(&file_path, original_file.as_deref(), Some(&content));
    let unified_diff =
        make_unified_diff(&file_path, original_file.as_deref().unwrap_or(""), &content);
    let operation = if original_file.is_some() {
        FileChangeOperation::Update
    } else {
        FileChangeOperation::Create
    };
    let change_id = record_text_file_change(
        context,
        &absolute_path,
        operation,
        original_file.as_deref(),
        Some(&content),
        structured_patch.clone(),
        unified_diff,
        None,
    )?
    .map(|record| record.change_id);

    Ok(WriteFileOutput {
        kind: if original_file.is_some() {
            String::from("update")
        } else {
            String::from("create")
        },
        file_path,
        changes,
        content: content.clone(),
        structured_patch,
        original_file,
        git_diff: None,
        change_id,
        revision: content_revision(content.as_bytes()),
        bytes: content.len(),
        lines: content.lines().count(),
    })
}

pub fn append_file(
    path: &str,
    content: &str,
    create_if_missing: bool,
) -> io::Result<AppendFileOutput> {
    let context = FileMutationContext::from_env("append_file");
    append_file_with_context(path, content, create_if_missing, &context)
}

pub fn append_file_with_context(
    path: &str,
    content: &str,
    create_if_missing: bool,
    context: &FileMutationContext,
) -> io::Result<AppendFileOutput> {
    append_file_with_context_expected(path, content, create_if_missing, None, context)
}

pub fn append_file_with_context_expected(
    path: &str,
    content: &str,
    create_if_missing: bool,
    expected_revision: Option<&str>,
    context: &FileMutationContext,
) -> io::Result<AppendFileOutput> {
    let absolute_path = normalize_path_allow_missing(path)?;
    let (created, original_file, appended_content, updated) = crate::atomic_file::with_path_lock(
        &absolute_path,
        || {
            let original_file = read_optional_utf8(&absolute_path)?;
            let created = original_file.is_none();
            validate_expected_revision(
                &absolute_path,
                expected_revision,
                original_file.as_deref(),
            )?;
            if created && !create_if_missing {
                // Name the resolved absolute path: this error's main job is to
                // make a one-character path typo visible.
                return Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    format!(
                        "file `{}` does not exist, so there is nothing to append to. Check the path for a typo. If this file really should be created, pass create_if_missing=true and expected_revision=`absent`.",
                        absolute_path.display()
                    ),
                ));
            }
            let appended_content = harmonize_write_eol(original_file.as_deref(), content);
            let mut updated = original_file.clone().unwrap_or_default();
            updated.push_str(&appended_content);
            // Compose in memory and replace atomically. A crash can no longer
            // leave a prefix of the appended chunk at the destination.
            replace_file_contents_unlocked(&absolute_path, &updated)?;
            Ok::<_, io::Error>((created, original_file, appended_content, updated))
        },
    )?;

    let file_path = display_path(&absolute_path);
    let structured_patch = make_patch(original_file.as_deref().unwrap_or(""), &updated);
    let changes = make_file_changes(&file_path, original_file.as_deref(), Some(&updated));
    let unified_diff =
        make_unified_diff(&file_path, original_file.as_deref().unwrap_or(""), &updated);
    let operation = if created {
        FileChangeOperation::Create
    } else {
        FileChangeOperation::Append
    };
    let change_id = record_text_file_change(
        context,
        &absolute_path,
        operation,
        original_file.as_deref(),
        Some(&updated),
        structured_patch.clone(),
        unified_diff,
        None,
    )?
    .map(|record| record.change_id);

    Ok(AppendFileOutput {
        kind: String::from("append"),
        file_path,
        created,
        appended_chars: appended_content.chars().count(),
        appended_bytes: appended_content.len(),
        total_chars: updated.chars().count(),
        total_lines: updated.lines().count(),
        changes,
        structured_patch,
        change_id,
        revision: content_revision(updated.as_bytes()),
    })
}

pub fn edit_file(
    path: &str,
    old_string: &str,
    new_string: &str,
    replace_all: bool,
) -> io::Result<EditFileOutput> {
    let context = FileMutationContext::from_env("edit_file");
    edit_file_with_context(path, old_string, new_string, replace_all, &context)
}

pub fn edit_file_with_context(
    path: &str,
    old_string: &str,
    new_string: &str,
    replace_all: bool,
    context: &FileMutationContext,
) -> io::Result<EditFileOutput> {
    edit_file_with_context_expected(path, old_string, new_string, replace_all, None, context)
}

pub fn edit_file_with_context_expected(
    path: &str,
    old_string: &str,
    new_string: &str,
    replace_all: bool,
    expected_revision: Option<&str>,
    context: &FileMutationContext,
) -> io::Result<EditFileOutput> {
    let absolute_path = normalize_path(path)?;
    if old_string.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "old_string must not be empty",
        ));
    }
    if normalize_newlines(old_string) == normalize_newlines(new_string) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "old_string and new_string must differ",
        ));
    }
    if replacement_character_count(new_string) > replacement_character_count(old_string) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            lossy_unicode_edit_message("new_string", false),
        ));
    }

    let (original_file, updated, replacements) = crate::atomic_file::with_path_lock(
        &absolute_path,
        || {
            let original_file = read_optional_utf8(&absolute_path)?.ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::NotFound,
                    format!("file `{}` does not exist", absolute_path.display()),
                )
            })?;
            validate_expected_revision(&absolute_path, expected_revision, Some(&original_file))?;
            let matches = find_edit_matches(&original_file, old_string);
            if matches.is_empty() {
                if old_string.contains('\u{fffd}') {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        lossy_unicode_edit_message("old_string", true),
                    ));
                }
                return Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    edit_not_found_message(&original_file, old_string),
                ));
            }
            if !replace_all && matches.len() > 1 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!(
                        "old_string matches {} locations in the file; add surrounding context to make it unique, or set replace_all=true to replace every match",
                        matches.len()
                    ),
                ));
            }

            let selected = if replace_all {
                &matches[..]
            } else {
                &matches[..1]
            };
            let replacements = selected.len();
            let updated = splice_ranges(&original_file, selected, new_string);
            replace_file_contents_unlocked(&absolute_path, &updated)?;
            Ok::<_, io::Error>((original_file, updated, replacements))
        },
    )?;

    let file_path = display_path(&absolute_path);
    let structured_patch = make_patch(&original_file, &updated);
    let unified_diff = make_unified_diff(&file_path, &original_file, &updated);
    let changes = make_compact_update_changes(&file_path, &unified_diff);
    let context_windows = edit_context_windows(&updated, &structured_patch);
    let change_id = record_text_file_change(
        context,
        &absolute_path,
        FileChangeOperation::Update,
        Some(&original_file),
        Some(&updated),
        structured_patch.clone(),
        unified_diff,
        None,
    )?
    .map(|record| record.change_id);

    Ok(EditFileOutput {
        file_path,
        updated_file: updated.clone(),
        old_string: old_string.to_owned(),
        new_string: new_string.to_owned(),
        original_file,
        structured_patch,
        changes,
        context: context_windows,
        replacements,
        user_modified: false,
        replace_all,
        git_diff: None,
        change_id,
        revision: content_revision(updated.as_bytes()),
    })
}

pub fn multi_edit_file(path: &str, edits: &[MultiEditOperation]) -> io::Result<MultiEditOutput> {
    let context = FileMutationContext::from_env("multi_edit");
    multi_edit_file_with_context(path, edits, &context)
}

pub fn multi_edit_file_with_context(
    path: &str,
    edits: &[MultiEditOperation],
    context: &FileMutationContext,
) -> io::Result<MultiEditOutput> {
    multi_edit_file_with_context_expected(path, edits, None, context)
}

pub fn multi_edit_file_with_context_expected(
    path: &str,
    edits: &[MultiEditOperation],
    expected_revision: Option<&str>,
    context: &FileMutationContext,
) -> io::Result<MultiEditOutput> {
    if edits.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "edits must contain at least one replacement",
        ));
    }
    if edits.len() > MAX_MULTI_EDIT_OPERATIONS {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "edits contains {} replacements; the per-call limit is {MAX_MULTI_EDIT_OPERATIONS}",
                edits.len()
            ),
        ));
    }

    // Validate every parameter independently before touching the filesystem.
    // This is what lets one retry fix every U+FFFD field in a large batch
    // instead of failing edit 3, then edit 4, one round-trip at a time.
    let parameter_issues = multi_edit_parameter_issues(edits);
    if !parameter_issues.is_empty() {
        return Err(multi_edit_validation_io_error(
            edits.len(),
            None,
            parameter_issues,
        ));
    }

    let absolute_path = normalize_path(path)?;
    let (original_file, updated, replacements) = crate::atomic_file::with_path_lock(
        &absolute_path,
        || {
            let original_file = read_optional_utf8(&absolute_path)?.ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::NotFound,
                    format!("file `{}` does not exist", absolute_path.display()),
                )
            })?;
            validate_expected_revision(&absolute_path, expected_revision, Some(&original_file))?;
            let base_revision = content_revision(original_file.as_bytes());
            let mut updated = original_file.clone();
            let mut replacements = 0usize;

            // Later edits intentionally see earlier in-memory edits, but no
            // bytes reach disk until every ordered replacement has validated.
            for (index, edit) in edits.iter().enumerate() {
                let edit_index = index + 1;
                let matches = find_edit_matches(&updated, &edit.old_string);
                if matches.is_empty() {
                    let (code, message, recovery) = if edit.old_string.contains('\u{fffd}') {
                        (
                            "lossy_unicode_source",
                            "old_string contains U+FFFD and does not exactly match the current file",
                            "Re-read a focused current-file window and copy exact UTF-8 source text before retrying.",
                        )
                    } else {
                        (
                            "old_string_not_found",
                            "old_string was not found after applying the preceding in-memory edits",
                            "Re-read the current focused window, then use a shorter stable unique old_string.",
                        )
                    };
                    return Err(multi_edit_validation_io_error(
                        edits.len(),
                        Some(base_revision.clone()),
                        vec![MultiEditValidationIssue {
                            edit_index,
                            field: "old_string".to_string(),
                            code: code.to_string(),
                            message: format!(
                                "{message}: {}",
                                edit_not_found_message(&updated, &edit.old_string)
                            ),
                            preview: Some(preview_error_line(&edit.old_string)),
                            recovery: recovery.to_string(),
                        }],
                    ));
                }
                if !edit.replace_all && matches.len() > 1 {
                    return Err(multi_edit_validation_io_error(
                        edits.len(),
                        Some(base_revision.clone()),
                        vec![MultiEditValidationIssue {
                            edit_index,
                            field: "old_string".to_string(),
                            code: "ambiguous_match".to_string(),
                            message: format!(
                                "old_string matches {} locations in the current in-memory file",
                                matches.len()
                            ),
                            preview: Some(preview_error_line(&edit.old_string)),
                            recovery: "Add surrounding context to make old_string unique, or set replace_all=true only when every match should change.".to_string(),
                        }],
                    ));
                }

                let selected = if edit.replace_all {
                    &matches[..]
                } else {
                    &matches[..1]
                };
                replacements = replacements.saturating_add(selected.len());
                updated = splice_ranges(&updated, selected, &edit.new_string);
            }

            if updated == original_file {
                return Err(multi_edit_validation_io_error(
                    edits.len(),
                    Some(base_revision),
                    vec![MultiEditValidationIssue {
                        edit_index: 0,
                        field: "edits".to_string(),
                        code: "no_net_change".to_string(),
                        message: "the ordered edit batch produces no net file change".to_string(),
                        preview: None,
                        recovery:
                            "Remove cancelling replacements or revise the intended final text."
                                .to_string(),
                    }],
                ));
            }

            // One atomic replacement makes the entire batch visible at once.
            replace_file_contents_unlocked(&absolute_path, &updated)?;
            Ok::<_, io::Error>((original_file, updated, replacements))
        },
    )?;

    let file_path = display_path(&absolute_path);
    let structured_patch = make_patch(&original_file, &updated);
    let unified_diff = make_unified_diff(&file_path, &original_file, &updated);
    let changes = make_compact_update_changes(&file_path, &unified_diff);
    let context_windows = edit_context_windows(&updated, &structured_patch);
    let change_id = record_text_file_change(
        context,
        &absolute_path,
        FileChangeOperation::Update,
        Some(&original_file),
        Some(&updated),
        structured_patch.clone(),
        unified_diff,
        None,
    )?
    .map(|record| record.change_id);

    Ok(MultiEditOutput {
        file_path,
        edits_applied: edits.len(),
        replacements,
        changes,
        context: context_windows,
        structured_patch,
        change_id,
        revision: content_revision(updated.as_bytes()),
    })
}

fn multi_edit_parameter_issues(edits: &[MultiEditOperation]) -> Vec<MultiEditValidationIssue> {
    let mut issues = Vec::new();
    for (index, edit) in edits.iter().enumerate() {
        let edit_index = index + 1;
        if edit.old_string.is_empty() {
            issues.push(MultiEditValidationIssue {
                edit_index,
                field: "old_string".to_string(),
                code: "empty_old_string".to_string(),
                message: "old_string must not be empty".to_string(),
                preview: None,
                recovery: "Provide a short stable unique span copied from the current file."
                    .to_string(),
            });
        }
        if normalize_newlines(&edit.old_string) == normalize_newlines(&edit.new_string) {
            issues.push(MultiEditValidationIssue {
                edit_index,
                field: "old_string,new_string".to_string(),
                code: "no_op".to_string(),
                message: "old_string and new_string must differ".to_string(),
                preview: Some(preview_error_line(&edit.new_string)),
                recovery: "Remove this edit or provide text that changes the file.".to_string(),
            });
        }
        if replacement_character_count(&edit.new_string)
            > replacement_character_count(&edit.old_string)
        {
            issues.push(MultiEditValidationIssue {
                edit_index,
                field: "new_string".to_string(),
                code: "lossy_unicode".to_string(),
                message: "new_string introduces the Unicode replacement character U+FFFD (`�`), which indicates decoded or copied text loss".to_string(),
                preview: Some(preview_error_line(&edit.new_string)),
                recovery: "Regenerate this new_string from intact UTF-8 text; a file re-read is only needed if the reported revision has changed.".to_string(),
            });
        }
    }
    issues
}

fn multi_edit_validation_io_error(
    total_edits: usize,
    base_revision: Option<String>,
    mut issues: Vec<MultiEditValidationIssue>,
) -> io::Error {
    for issue in &mut issues {
        if issue.edit_index > 0 {
            issue.message = format!("edit {}: {}", issue.edit_index, issue.message);
        }
    }
    let invalid_indexes = issues
        .iter()
        .filter_map(|issue| (issue.edit_index > 0).then_some(issue.edit_index))
        .collect::<std::collections::BTreeSet<_>>();
    let parameter_valid_but_not_applied = (1..=total_edits)
        .filter(|index| !invalid_indexes.contains(index))
        .collect();
    io::Error::new(
        io::ErrorKind::InvalidInput,
        MultiEditValidationError {
            ok: false,
            code: "multi_edit_validation_failed".to_string(),
            atomic: true,
            applied: 0,
            total_edits,
            base_revision,
            issues,
            parameter_valid_but_not_applied,
            retry: "Correct every reported field, preserve the same batch order, and retry as one atomic multi_edit. Re-read only when an issue says the source is stale or the revision changed.".to_string(),
            message: "The complete edit batch was rejected during preflight. No changes were written".to_string(),
        },
    )
}

/// Start a staged whole-file write. Chunks live under SomniQ-owned temporary
/// storage; the destination is not touched until `commit_large_write` performs
/// one revision-checked atomic replacement.
pub fn begin_large_write(
    path: &str,
    expected_revision: &str,
    context: &FileMutationContext,
) -> io::Result<LargeWriteBeginOutput> {
    let target_path = normalize_path_allow_missing(path)?;
    crate::atomic_file::with_path_lock(&target_path, || {
        let current = read_optional_utf8(&target_path)?;
        validate_expected_revision(&target_path, Some(expected_revision), current.as_deref())
    })?;

    let stage_root = staged_write_root()?;
    fs::create_dir_all(&stage_root)?;
    let write_id = create_staged_write_id(&stage_root)?;
    let (metadata_path, part_path) = staged_write_paths(&stage_root, &write_id)?;
    let metadata = StagedWriteMetadata {
        version: STAGED_WRITE_FORMAT_VERSION,
        write_id: write_id.clone(),
        target_path: display_path(&target_path),
        expected_revision: expected_revision.trim().to_string(),
        session_id: context.session_id.clone(),
        status: StagedWriteStatus::Open,
        chunks: Vec::new(),
        staged_bytes: 0,
    };

    fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&part_path)?
        .sync_all()?;
    if let Err(error) = save_staged_write_metadata(&metadata_path, &metadata) {
        let _ = fs::remove_file(&part_path);
        return Err(error);
    }

    Ok(LargeWriteBeginOutput {
        ok: true,
        write_id,
        file_path: display_path(&target_path),
        expected_revision: expected_revision.trim().to_string(),
        next_sequence: 0,
        chunk_bytes_limit: MAX_FILE_TOOL_PAYLOAD_BYTES,
        total_bytes_limit: MAX_STAGED_WRITE_TOTAL_BYTES,
    })
}

pub fn append_write_chunk(
    write_id: &str,
    sequence: usize,
    content: &str,
    context: &FileMutationContext,
) -> io::Result<LargeWriteChunkOutput> {
    if content.len() > MAX_FILE_TOOL_PAYLOAD_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "chunk is {} bytes; the per-call byte limit is {MAX_FILE_TOOL_PAYLOAD_BYTES}",
                content.len()
            ),
        ));
    }
    let stage_root = staged_write_root()?;
    let (metadata_path, part_path) = staged_write_paths(&stage_root, write_id)?;
    let chunk_hash = content_revision(content.as_bytes());

    crate::atomic_file::with_path_lock(&metadata_path, || {
        let mut metadata = load_staged_write_metadata(&metadata_path)?;
        authorize_staged_write(&metadata, context)?;
        if metadata.status != StagedWriteStatus::Open {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "the staged write is already committing; no chunk was appended",
            ));
        }

        if sequence < metadata.chunks.len() {
            let accepted = &metadata.chunks[sequence];
            if accepted.bytes == content.len() && accepted.sha256 == chunk_hash {
                return Ok(LargeWriteChunkOutput {
                    ok: true,
                    write_id: write_id.to_string(),
                    accepted_sequence: sequence,
                    already_accepted: true,
                    next_sequence: metadata.chunks.len(),
                    appended_bytes: 0,
                    staged_bytes: metadata.staged_bytes,
                });
            }
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!(
                    "sequence {sequence} was already accepted with different content; retry the original chunk or abort this staged write"
                ),
            ));
        }
        if sequence != metadata.chunks.len() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "out-of-order chunk: received sequence {sequence}, expected {}",
                    metadata.chunks.len()
                ),
            ));
        }
        let next_total = metadata
            .staged_bytes
            .checked_add(content.len())
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "staged byte count overflow")
            })?;
        if next_total > MAX_STAGED_WRITE_TOTAL_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "staged file would be {next_total} bytes; the staged-write limit is {MAX_STAGED_WRITE_TOTAL_BYTES} bytes"
                ),
            ));
        }

        let mut part = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&part_path)?;
        let actual_len = usize::try_from(part.metadata()?.len()).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidData, "staged file length overflow")
        })?;
        if actual_len == metadata.staged_bytes {
            part.seek(SeekFrom::End(0))?;
            part.write_all(content.as_bytes())?;
            part.sync_all()?;
        } else if actual_len == next_total {
            // Recovery for a process interruption after the chunk was fsynced
            // but before its metadata update became visible.
            part.seek(SeekFrom::Start(metadata.staged_bytes as u64))?;
            let mut tail = vec![0_u8; content.len()];
            part.read_exact(&mut tail)?;
            if tail != content.as_bytes() {
                return Err(staged_write_corruption_error(write_id));
            }
        } else {
            return Err(staged_write_corruption_error(write_id));
        }

        metadata.chunks.push(StagedWriteChunk {
            bytes: content.len(),
            sha256: chunk_hash,
        });
        metadata.staged_bytes = next_total;
        save_staged_write_metadata_unlocked(&metadata_path, &metadata)?;
        Ok(LargeWriteChunkOutput {
            ok: true,
            write_id: write_id.to_string(),
            accepted_sequence: sequence,
            already_accepted: false,
            next_sequence: metadata.chunks.len(),
            appended_bytes: content.len(),
            staged_bytes: metadata.staged_bytes,
        })
    })
}

pub fn commit_large_write(
    write_id: &str,
    context: &FileMutationContext,
) -> io::Result<WriteFileOutput> {
    let stage_root = staged_write_root()?;
    let (metadata_path, part_path) = staged_write_paths(&stage_root, write_id)?;
    let metadata = crate::atomic_file::with_path_lock(&metadata_path, || {
        let mut metadata = load_staged_write_metadata(&metadata_path)?;
        authorize_staged_write(&metadata, context)?;
        if metadata.status != StagedWriteStatus::Open {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "the staged write is already committing",
            ));
        }
        metadata.status = StagedWriteStatus::Committing;
        save_staged_write_metadata_unlocked(&metadata_path, &metadata)?;
        Ok::<_, io::Error>(metadata)
    })?;

    let commit_result = (|| {
        let staged_bytes = fs::read(&part_path)?;
        verify_staged_write_bytes(&metadata, &staged_bytes)?;
        let staged_content = String::from_utf8(staged_bytes).map_err(|error| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "staged content is not valid UTF-8 at byte {}; commit was rejected without modifying the destination",
                    error.utf8_error().valid_up_to()
                ),
            )
        })?;
        let target_path = normalize_path_allow_missing(&metadata.target_path)?;
        let (original_file, content) = crate::atomic_file::with_path_lock(&target_path, || {
            let original_file = read_optional_utf8(&target_path)?;
            validate_expected_revision(
                &target_path,
                Some(&metadata.expected_revision),
                original_file.as_deref(),
            )?;
            let content = harmonize_write_eol(original_file.as_deref(), &staged_content);
            replace_file_contents_unlocked(&target_path, &content)?;
            Ok::<_, io::Error>((original_file, content))
        })?;

        let file_path = display_path(&target_path);
        let structured_patch = make_patch(original_file.as_deref().unwrap_or(""), &content);
        let unified_diff =
            make_unified_diff(&file_path, original_file.as_deref().unwrap_or(""), &content);
        let changes = make_file_changes(&file_path, original_file.as_deref(), Some(&content));
        let operation = if original_file.is_some() {
            FileChangeOperation::Update
        } else {
            FileChangeOperation::Create
        };
        let change_id = record_text_file_change(
            context,
            &target_path,
            operation,
            original_file.as_deref(),
            Some(&content),
            structured_patch.clone(),
            unified_diff,
            None,
        )?
        .map(|record| record.change_id);

        Ok::<_, io::Error>(WriteFileOutput {
            kind: if original_file.is_some() {
                "update".to_string()
            } else {
                "create".to_string()
            },
            file_path,
            changes,
            content: content.clone(),
            structured_patch,
            original_file,
            git_diff: None,
            change_id,
            revision: content_revision(content.as_bytes()),
            bytes: content.len(),
            lines: content.lines().count(),
        })
    })();

    match commit_result {
        Ok(output) => {
            // Exact known files only; a stale empty directory is harmless.
            let _ = fs::remove_file(&part_path);
            let _ = fs::remove_file(&metadata_path);
            Ok(output)
        }
        Err(error) => {
            // A revision conflict or transient write failure remains retryable
            // or abortable. Do not discard successfully staged chunks.
            let _ = crate::atomic_file::with_path_lock(&metadata_path, || {
                let Ok(mut current) = load_staged_write_metadata(&metadata_path) else {
                    return;
                };
                current.status = StagedWriteStatus::Open;
                let _ = save_staged_write_metadata_unlocked(&metadata_path, &current);
            });
            Err(error)
        }
    }
}

pub fn abort_large_write(
    write_id: &str,
    context: &FileMutationContext,
) -> io::Result<LargeWriteAbortOutput> {
    let stage_root = staged_write_root()?;
    let (metadata_path, part_path) = staged_write_paths(&stage_root, write_id)?;
    let aborted = crate::atomic_file::with_path_lock(&metadata_path, || {
        let metadata = match load_staged_write_metadata(&metadata_path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error),
        };
        authorize_staged_write(&metadata, context)?;
        if part_path.exists() {
            fs::remove_file(&part_path)?;
        }
        if metadata_path.exists() {
            fs::remove_file(&metadata_path)?;
        }
        Ok(true)
    })?;
    Ok(LargeWriteAbortOutput {
        ok: true,
        write_id: write_id.to_string(),
        aborted,
    })
}

fn staged_write_root() -> io::Result<PathBuf> {
    let workspace = workspace_root()?.unwrap_or(crate::execution_current_dir()?);
    Ok(crate::somniq_project_tmp_dir(workspace).join(STAGED_WRITE_DIR_NAME))
}

fn create_staged_write_id(stage_root: &Path) -> io::Result<String> {
    for _ in 0..16 {
        let mut random = [0_u8; 16];
        getrandom::fill(&mut random).map_err(|error| io::Error::other(error.to_string()))?;
        let write_id = format!(
            "wrt_{}",
            random
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        let (metadata_path, part_path) = staged_write_paths(stage_root, &write_id)?;
        if !metadata_path.exists() && !part_path.exists() {
            return Ok(write_id);
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate a unique staged-write id",
    ))
}

fn staged_write_paths(stage_root: &Path, write_id: &str) -> io::Result<(PathBuf, PathBuf)> {
    let suffix = write_id
        .strip_prefix("wrt_")
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid staged-write id"))?;
    if suffix.len() != 32 || !suffix.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid staged-write id",
        ));
    }
    Ok((
        stage_root.join(format!("{write_id}.json")),
        stage_root.join(format!("{write_id}.part")),
    ))
}

fn load_staged_write_metadata(path: &Path) -> io::Result<StagedWriteMetadata> {
    let bytes = fs::read(path)?;
    let metadata = serde_json::from_slice::<StagedWriteMetadata>(&bytes).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid staged-write metadata: {error}"),
        )
    })?;
    if metadata.version != STAGED_WRITE_FORMAT_VERSION {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "unsupported staged-write metadata version {}",
                metadata.version
            ),
        ));
    }
    Ok(metadata)
}

fn save_staged_write_metadata(path: &Path, metadata: &StagedWriteMetadata) -> io::Result<()> {
    let bytes = serde_json::to_vec(metadata).map_err(io::Error::other)?;
    crate::atomic_file::write_replace(path, bytes)
}

fn save_staged_write_metadata_unlocked(
    path: &Path,
    metadata: &StagedWriteMetadata,
) -> io::Result<()> {
    let bytes = serde_json::to_vec(metadata).map_err(io::Error::other)?;
    crate::atomic_file::write_replace_unlocked(path, &bytes)
}

fn authorize_staged_write(
    metadata: &StagedWriteMetadata,
    context: &FileMutationContext,
) -> io::Result<()> {
    if metadata.write_id.trim().is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "staged-write metadata has no write id",
        ));
    }
    if let Some(owner) = metadata.session_id.as_deref() {
        if context.session_id.as_deref() != Some(owner) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "the staged write belongs to a different session",
            ));
        }
    }
    Ok(())
}

fn verify_staged_write_bytes(metadata: &StagedWriteMetadata, bytes: &[u8]) -> io::Result<()> {
    if bytes.len() != metadata.staged_bytes {
        return Err(staged_write_corruption_error(&metadata.write_id));
    }
    let mut offset = 0usize;
    for chunk in &metadata.chunks {
        let end = offset.checked_add(chunk.bytes).ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "staged chunk offset overflow")
        })?;
        let Some(content) = bytes.get(offset..end) else {
            return Err(staged_write_corruption_error(&metadata.write_id));
        };
        if content_revision(content) != chunk.sha256 {
            return Err(staged_write_corruption_error(&metadata.write_id));
        }
        offset = end;
    }
    if offset != bytes.len() {
        return Err(staged_write_corruption_error(&metadata.write_id));
    }
    Ok(())
}

fn staged_write_corruption_error(write_id: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!(
            "staged write `{write_id}` is inconsistent with its durable chunk metadata; abort it and begin a new staged write. The destination was not modified"
        ),
    )
}

fn normalize_newlines(text: &str) -> String {
    text.replace("\r\n", "\n")
}

/// `read_file` presents LF-normalized text to the model (`str::lines` drops
/// `\r`), so a faithfully copied multi-line `old_string` never byte-matches a
/// CRLF file. Exact byte matches win; otherwise fall back to a line-ending- and
/// BOM-insensitive scan and map hits back to byte ranges in the original.
fn find_edit_matches(original: &str, old_string: &str) -> Vec<(usize, usize)> {
    let exact = original
        .match_indices(old_string)
        .map(|(start, matched)| (start, start + matched.len()))
        .collect::<Vec<_>>();
    if !exact.is_empty() {
        return exact;
    }

    let (normalized, offsets) = normalized_haystack(original);
    let needle_owned = normalize_newlines(old_string);
    let needle = needle_owned
        .strip_prefix('\u{feff}')
        .unwrap_or(&needle_owned);
    if needle.is_empty() {
        return Vec::new();
    }
    normalized
        .match_indices(needle)
        .map(|(start, matched)| (offsets[start], offsets[start + matched.len() - 1] + 1))
        .collect()
}

/// LF-normalized copy of `original` (CRLF collapsed to LF, leading BOM
/// dropped) plus a map from each normalized byte index to its byte index in
/// `original`. Only whole bytes are ever dropped, so UTF-8 validity holds.
fn normalized_haystack(original: &str) -> (String, Vec<usize>) {
    let bytes = original.as_bytes();
    let mut normalized = Vec::with_capacity(bytes.len());
    let mut offsets = Vec::with_capacity(bytes.len());
    let mut index = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        3
    } else {
        0
    };
    while index < bytes.len() {
        if bytes[index] == b'\r' && bytes.get(index + 1) == Some(&b'\n') {
            index += 1;
            continue;
        }
        normalized.push(bytes[index]);
        offsets.push(index);
        index += 1;
    }
    let normalized =
        String::from_utf8(normalized).expect("dropping CR and BOM bytes preserves UTF-8 validity");
    (normalized, offsets)
}

/// Replaces each range with `new_string` converted to the replaced region's
/// line-ending style, so edits stop planting LF islands inside CRLF files.
fn splice_ranges(original: &str, ranges: &[(usize, usize)], new_string: &str) -> String {
    let mut updated = String::with_capacity(original.len() + new_string.len());
    let mut cursor = 0;
    for &(start, end) in ranges {
        updated.push_str(&original[cursor..start]);
        updated.push_str(&match_eol(new_string, eol_for_range(original, start, end)));
        cursor = end;
    }
    updated.push_str(&original[cursor..]);
    updated
}

fn eol_counts(text: &str) -> (usize, usize) {
    let crlf = text.matches("\r\n").count();
    let bare_lf = text.matches('\n').count() - crlf;
    (crlf, bare_lf)
}

fn eol_for_range(original: &str, start: usize, end: usize) -> &'static str {
    let (crlf, bare_lf) = eol_counts(&original[start..end]);
    if crlf != bare_lf {
        return if crlf > bare_lf { "\r\n" } else { "\n" };
    }
    let (crlf, bare_lf) = eol_counts(original);
    if crlf > bare_lf {
        "\r\n"
    } else {
        "\n"
    }
}

fn match_eol(text: &str, eol: &str) -> String {
    let normalized = normalize_newlines(text);
    if eol == "\r\n" {
        normalized.replace('\n', "\r\n")
    } else {
        normalized
    }
}

/// Models emit LF-only content; writing it verbatim over an existing CRLF file
/// flips every line ending in the diff. Full-file writes and appends adopt the
/// existing file's dominant ending; brand-new files are written verbatim.
fn harmonize_write_eol(original: Option<&str>, content: &str) -> String {
    let Some(original) = original else {
        return content.to_owned();
    };
    let (crlf, bare_lf) = eol_counts(original);
    if crlf == 0 && bare_lf == 0 {
        return content.to_owned();
    }
    match_eol(content, if crlf > bare_lf { "\r\n" } else { "\n" })
}

fn replacement_character_count(text: &str) -> usize {
    text.chars()
        .filter(|character| *character == '\u{fffd}')
        .count()
}

fn lossy_unicode_edit_message(field: &str, source_must_be_reread: bool) -> String {
    let recovery = if source_must_be_reread {
        "re-read a focused current-file window and copy exact UTF-8 source text"
    } else {
        "regenerate the replacement from intact UTF-8 text; re-read only if the file revision changed"
    };
    format!(
        "{field} contains or introduces the Unicode replacement character U+FFFD (`�`), which usually means text was decoded or copied with data loss; {recovery} before retrying. No changes were written"
    )
}

fn edit_not_found_message(original: &str, old_string: &str) -> String {
    let needle_owned = normalize_newlines(old_string);
    let needle_lines = needle_owned.lines().map(str::trim).collect::<Vec<_>>();
    let file_lines = original.lines().map(str::trim).collect::<Vec<_>>();
    if !needle_lines.is_empty() {
        if let Some(start) = file_lines
            .windows(needle_lines.len())
            .position(|window| window == needle_lines)
        {
            return format!(
                "old_string not found in file, though lines {}-{} match it when indentation and trailing whitespace are ignored; re-read the file and copy the exact text",
                start + 1,
                start + needle_lines.len()
            );
        }
    }
    if let Some(message) = drifting_block_message(&file_lines, &needle_lines) {
        return message;
    }
    String::from(
        "old_string not found in file; if the file may have changed since it was last read, call read_file again and take old_string from the current contents",
    )
}

fn drifting_block_message(file_lines: &[&str], needle_lines: &[&str]) -> Option<String> {
    if needle_lines.len() < 4 {
        return None;
    }
    let (anchor_offset, anchor) = needle_lines
        .iter()
        .enumerate()
        .find(|(_, line)| line.chars().count() >= 8 && !line.is_empty())?;
    let anchor_hits = file_lines
        .iter()
        .enumerate()
        .filter_map(|(index, line)| (*line == *anchor).then_some(index))
        .collect::<Vec<_>>();
    if anchor_hits.len() != 1 || anchor_hits[0] < anchor_offset {
        return None;
    }

    let start = anchor_hits[0] - anchor_offset;
    let mismatch = needle_lines.iter().enumerate().find(|(offset, expected)| {
        file_lines
            .get(start + offset)
            .is_none_or(|actual| actual != *expected)
    })?;
    let mismatch_offset = mismatch.0;
    if mismatch_offset == 0 {
        return None;
    }

    let expected = preview_error_line(mismatch.1);
    let actual = file_lines.get(start + mismatch_offset).map_or_else(
        || "<end of file>".to_string(),
        |line| preview_error_line(line),
    );
    let suggested_end = start
        .saturating_add(needle_lines.len())
        .min(file_lines.len())
        .max(start + 1);
    Some(format!(
        "old_string block starts at file line {}, but first differs at file line {}: expected `{expected}`, found `{actual}`. Re-read lines {}-{suggested_end} and split the change into shorter unique replacements instead of matching the entire block",
        start + 1,
        start + mismatch_offset + 1,
        start + 1,
    ))
}

fn preview_error_line(line: &str) -> String {
    const MAX_CHARS: usize = 120;
    let total = line.chars().count();
    if total <= MAX_CHARS {
        return line.to_string();
    }
    let preview = line.chars().take(MAX_CHARS).collect::<String>();
    format!("{preview}…")
}

pub fn glob_search(pattern: &str, path: Option<&str>) -> io::Result<GlobSearchOutput> {
    let started = Instant::now();
    let root = workspace_root()?;
    let readable_roots = readable_roots(root.as_deref())?;
    let base_dir = path
        .map(|path| normalize_search_base(path, root.as_deref(), &readable_roots))
        .transpose()?
        .unwrap_or(match root.as_ref() {
            Some(root) => root.clone(),
            None => crate::execution_current_dir()?,
        });
    let search_path = if Path::new(pattern).is_absolute() {
        PathBuf::from(pattern)
    } else {
        base_dir.join(pattern)
    };
    if root.is_some() {
        ensure_glob_search_allowed(&search_path, &readable_roots)?;
    }
    let search_pattern = search_path.to_string_lossy().into_owned();
    let relative_filter = Pattern::new(pattern)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error.to_string()))?;
    let absolute_filter = Pattern::new(&display_path(&search_path))
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error.to_string()))?;

    let mut matches = if let Some(fast_matches) = fast_glob_matches(
        &base_dir,
        &relative_filter,
        &absolute_filter,
        root.as_ref(),
        &readable_roots,
    )? {
        fast_matches
    } else {
        let mut matches = Vec::new();
        let entries = glob::glob(&search_pattern)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error.to_string()))?;
        for entry in entries.flatten() {
            if !entry.is_file() {
                continue;
            }
            if root.is_some() {
                let Ok(canonical) = entry.canonicalize() else {
                    continue;
                };
                if is_under_any_root(&canonical, &readable_roots) {
                    matches.push(canonical);
                }
            } else {
                matches.push(entry);
            }
        }
        matches
    };

    matches.sort_by_key(|path| {
        fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .ok()
            .map(Reverse)
    });

    let truncated = matches.len() > MAX_GLOB_SEARCH_RESULTS;
    let filenames = matches
        .into_iter()
        .take(MAX_GLOB_SEARCH_RESULTS)
        .map(|path| display_path(&path))
        .collect::<Vec<_>>();

    Ok(GlobSearchOutput {
        duration_ms: started.elapsed().as_millis(),
        num_files: filenames.len(),
        filenames,
        truncated,
    })
}

pub fn grep_search(input: &GrepSearchInput) -> io::Result<GrepSearchOutput> {
    let root = workspace_root()?;
    let base_path = input
        .path
        .as_deref()
        .map(normalize_read_path)
        .transpose()?
        .unwrap_or(match root.as_ref() {
            Some(root) => root.clone(),
            None => crate::execution_current_dir()?,
        });

    let regex = RegexBuilder::new(&input.pattern)
        .case_insensitive(input.case_insensitive.unwrap_or(false))
        .dot_matches_new_line(input.multiline.unwrap_or(false))
        .build()
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error.to_string()))?;

    let glob_filter = input
        .glob
        .as_deref()
        .map(Pattern::new)
        .transpose()
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error.to_string()))?;
    let file_type = input.file_type.as_deref();
    let output_mode = input
        .output_mode
        .clone()
        .unwrap_or_else(|| String::from("files_with_matches"));
    let context = input.context.or(input.context_short).unwrap_or(0);

    let mut filenames = Vec::new();
    let mut content_lines = Vec::new();
    let mut total_matches = 0usize;

    for file_path in collect_search_files(&base_path)? {
        if !matches_optional_filters(&file_path, glob_filter.as_ref(), file_type) {
            continue;
        }

        let Ok(file_contents) = fs::read_to_string(&file_path) else {
            continue;
        };

        if output_mode == "count" {
            let count = regex.find_iter(&file_contents).count();
            if count > 0 {
                filenames.push(display_path(&file_path));
                total_matches += count;
            }
            continue;
        }

        let lines: Vec<&str> = file_contents.lines().collect();
        let mut matched_lines = Vec::new();
        for (index, line) in lines.iter().enumerate() {
            if regex.is_match(line) {
                total_matches += 1;
                matched_lines.push(index);
            }
        }

        if matched_lines.is_empty() {
            continue;
        }

        filenames.push(display_path(&file_path));
        if output_mode == "content" {
            for index in matched_lines {
                let start = index.saturating_sub(input.before.unwrap_or(context));
                let end = (index + input.after.unwrap_or(context) + 1).min(lines.len());
                for (current, line) in lines.iter().enumerate().take(end).skip(start) {
                    let prefix = if input.line_numbers.unwrap_or(true) {
                        format!("{}:{}:", display_path(&file_path), current + 1)
                    } else {
                        format!("{}:", display_path(&file_path))
                    };
                    content_lines.push(format!("{prefix}{line}"));
                }
            }
        }
    }

    let (filenames, applied_limit, applied_offset) =
        apply_limit(filenames, input.head_limit, input.offset);
    let content_output = if output_mode == "content" {
        let (lines, limit, offset) = apply_limit(content_lines, input.head_limit, input.offset);
        return Ok(GrepSearchOutput {
            mode: Some(output_mode),
            num_files: filenames.len(),
            filenames,
            num_lines: Some(lines.len()),
            content: Some(lines.join("\n")),
            num_matches: None,
            applied_limit: limit,
            applied_offset: offset,
        });
    } else {
        None
    };

    Ok(GrepSearchOutput {
        mode: Some(output_mode.clone()),
        num_files: filenames.len(),
        filenames,
        content: content_output,
        num_lines: None,
        num_matches: (output_mode == "count").then_some(total_matches),
        applied_limit,
        applied_offset,
    })
}

fn collect_search_files(base_path: &Path) -> io::Result<Vec<PathBuf>> {
    if base_path.is_file() {
        return Ok(vec![base_path.to_path_buf()]);
    }

    if let Some(files) = collect_search_files_fast(base_path)? {
        return Ok(files);
    }

    collect_search_files_walk(base_path)
}

fn collect_search_files_walk(base_path: &Path) -> io::Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    for entry in WalkDir::new(base_path) {
        let entry = entry.map_err(|error| io::Error::other(error.to_string()))?;
        if entry.file_type().is_file() {
            files.push(entry.path().to_path_buf());
        }
    }
    Ok(files)
}

fn fast_glob_matches(
    base_dir: &Path,
    relative_filter: &Pattern,
    absolute_filter: &Pattern,
    workspace_root: Option<&PathBuf>,
    readable_roots: &[PathBuf],
) -> io::Result<Option<Vec<PathBuf>>> {
    let Some(files) = collect_search_files_fast(base_dir)? else {
        return Ok(None);
    };

    let mut matches = Vec::new();
    for file in files {
        let relative = file.strip_prefix(base_dir).unwrap_or(file.as_path());
        if !relative_filter.matches(&display_path(relative))
            && !relative_filter.matches_path(relative)
            && !absolute_filter.matches(&display_path(&file))
            && !absolute_filter.matches_path(&file)
        {
            continue;
        }

        if workspace_root.is_some() {
            let Ok(canonical) = file.canonicalize() else {
                continue;
            };
            if is_under_any_root(&canonical, readable_roots) {
                matches.push(canonical);
            }
        } else {
            matches.push(file);
        }
    }

    Ok(Some(matches))
}

fn collect_search_files_fast(base_path: &Path) -> io::Result<Option<Vec<PathBuf>>> {
    if let Some(files) = git_ls_files(base_path)? {
        return Ok(Some(files));
    }
    rg_files(base_path)
}

fn git_ls_files(base_path: &Path) -> io::Result<Option<Vec<PathBuf>>> {
    let output = match crate::hidden_command("git")
        .args([
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ])
        .current_dir(base_path)
        .output()
    {
        Ok(output) => output,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };

    if !output.status.success() {
        return Ok(None);
    }

    let files = output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
        .map(|entry| base_path.join(String::from_utf8_lossy(entry).as_ref()))
        .filter(|path| path.is_file())
        .collect::<Vec<_>>();
    Ok(Some(files))
}

fn rg_files(base_path: &Path) -> io::Result<Option<Vec<PathBuf>>> {
    let output = match crate::hidden_command("rg")
        .args(["--files", "--hidden", "-g", "!.git", "-g", "!.git/**"])
        .current_dir(base_path)
        .output()
    {
        Ok(output) => output,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };

    if !output.status.success() {
        return Ok(None);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let files = stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| base_path.join(line))
        .filter(|path| path.is_file())
        .collect::<Vec<_>>();
    Ok(Some(files))
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn matches_optional_filters(
    path: &Path,
    glob_filter: Option<&Pattern>,
    file_type: Option<&str>,
) -> bool {
    if let Some(glob_filter) = glob_filter {
        let path_string = path.to_string_lossy();
        if !glob_filter.matches(&path_string) && !glob_filter.matches_path(path) {
            return false;
        }
    }

    if let Some(file_type) = file_type {
        let extension = path.extension().and_then(|extension| extension.to_str());
        if extension != Some(file_type) {
            return false;
        }
    }

    true
}

fn apply_limit<T>(
    items: Vec<T>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> (Vec<T>, Option<usize>, Option<usize>) {
    let offset_value = offset.unwrap_or(0);
    let mut items = items.into_iter().skip(offset_value).collect::<Vec<_>>();
    let explicit_limit = limit.unwrap_or(250);
    if explicit_limit == 0 {
        return (items, None, (offset_value > 0).then_some(offset_value));
    }

    let truncated = items.len() > explicit_limit;
    items.truncate(explicit_limit);
    (
        items,
        truncated.then_some(explicit_limit),
        (offset_value > 0).then_some(offset_value),
    )
}

type PdfUnicodeMap = BTreeMap<Vec<u8>, String>;

/// `ToUnicode` maps resolved per font resource name (`F15`), with a
/// document-wide union kept as the fallback.
///
/// One merged map is not good enough for a real paper. A LaTeX PDF carries a
/// dozen subset fonts whose codes collide — `0x72` is `r` in the body font and
/// `∇` in a math font — so a merged map silently hands back another font's
/// glyph and titles come out as `Mnemonics T∇aining`. Resolving
/// `/Font << /F15 23 0 R >>` → `23 0 obj /ToUnicode 40 0 R` → the `CMap` in
/// object 40 keeps them apart. The union fallback preserves behaviour for PDFs
/// whose resource chain cannot be resolved (or does not exist).
#[derive(Debug, Default)]
struct PdfFontMaps {
    by_resource_name: BTreeMap<String, PdfUnicodeMap>,
    fallback: PdfUnicodeMap,
}

impl PdfFontMaps {
    fn resolve(&self, resource_name: Option<&str>) -> &PdfUnicodeMap {
        resource_name
            .and_then(|name| self.by_resource_name.get(name))
            .unwrap_or(&self.fallback)
    }
}

#[derive(Debug)]
struct PdfObject<'a> {
    id: u32,
    body: &'a [u8],
}

#[derive(Debug)]
struct PdfStream<'a> {
    dict: &'a [u8],
    data: &'a [u8],
    object_id: Option<u32>,
}

#[derive(Debug)]
struct DecodedPdfStream<'a> {
    dict: &'a [u8],
    data: Vec<u8>,
    object_id: Option<u32>,
}

#[derive(Debug, Clone)]
enum PdfToken {
    String(Vec<u8>),
    Array(Vec<PdfToken>),
    Number(f32),
    Word(String),
}

fn is_pdf_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
}

fn extract_pdf_text_bytes(path: &Path, bytes: &[u8]) -> io::Result<String> {
    let Some(normalized) = extract_pdf_text_from_bytes(&bytes) else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("`{}` is not a PDF file", path.display()),
        ));
    };
    if normalized.trim().is_empty() {
        Ok(format!(
            "[PDF text extraction found no readable text in `{}`. The PDF may be scanned/image-only or use an unsupported encoding.]",
            path.display()
        ))
    } else {
        Ok(normalized)
    }
}

/// Extracts readable text from in-memory PDF bytes.
///
/// Returns `None` when the bytes are not a PDF, and an empty string when the
/// document carries no extractable text layer (scanned or image-only). Callers
/// that already have the bytes in hand — a downloaded HTTP body, for instance —
/// use this instead of round-tripping through a temporary file.
pub fn extract_pdf_text_from_bytes(bytes: &[u8]) -> Option<String> {
    if !bytes.starts_with(b"%PDF") {
        return None;
    }

    let mut decoded_streams = Vec::new();
    for stream in pdf_streams(bytes) {
        let data = decode_pdf_stream(stream.dict, stream.data);
        if !data.is_empty() {
            decoded_streams.push(DecodedPdfStream {
                dict: stream.dict,
                data,
                object_id: stream.object_id,
            });
        }
    }

    let font_maps = build_pdf_font_maps(bytes, &decoded_streams);

    let mut extracted = String::new();
    for stream in &decoded_streams {
        if looks_like_cmap_stream(&stream.data) || looks_like_image_stream(stream.dict) {
            continue;
        }
        if !looks_like_page_content_stream(&stream.data) {
            continue;
        }
        let text = extract_pdf_content_text(&stream.data, &font_maps);
        if !text.trim().is_empty() {
            if !extracted.trim().is_empty() {
                extracted.push_str("\n\n");
            }
            extracted.push_str(&text);
        }
    }

    Some(normalize_pdf_text(&extracted))
}

fn pdf_streams(bytes: &[u8]) -> Vec<PdfStream<'_>> {
    let mut streams = Vec::new();
    let mut cursor = 0;
    while let Some(relative_stream_pos) = find_subslice(&bytes[cursor..], b"stream") {
        let stream_pos = cursor + relative_stream_pos;
        let stream_data_start = skip_stream_newline(bytes, stream_pos + b"stream".len());
        let Some(relative_end_pos) = find_subslice(&bytes[stream_data_start..], b"endstream")
        else {
            break;
        };
        let stream_data_end = stream_data_start + relative_end_pos;
        if stream_data_end < stream_data_start {
            cursor = stream_pos + b"stream".len();
            continue;
        }

        let dict_start = rfind_subslice(&bytes[..stream_pos], b"<<").unwrap_or(stream_pos);
        streams.push(PdfStream {
            dict: &bytes[dict_start..stream_pos],
            data: &bytes[stream_data_start..stream_data_end],
            object_id: pdf_object_id_before(bytes, dict_start),
        });
        cursor = stream_data_end + b"endstream".len();
    }
    streams
}

/// Object number of the `N G obj` header immediately preceding `dict_start`.
fn pdf_object_id_before(bytes: &[u8], dict_start: usize) -> Option<u32> {
    let window = &bytes[dict_start.saturating_sub(64)..dict_start];
    let obj_keyword = rfind_subslice(window, b"obj")?;
    parse_pdf_object_header(&window[..obj_keyword])
}

/// Parses the `N G` of an `N G obj` header from the bytes preceding `obj`.
fn parse_pdf_object_header(prefix: &[u8]) -> Option<u32> {
    let text = String::from_utf8_lossy(prefix);
    let mut fields = text.split_ascii_whitespace().rev();
    fields.next()?.parse::<u32>().ok()?;
    fields.next()?.parse::<u32>().ok()
}

/// Indexes every `N G obj … endobj` body, including the dictionary-only objects
/// (fonts and resource dictionaries) that [`pdf_streams`] skips.
fn pdf_objects(bytes: &[u8]) -> Vec<PdfObject<'_>> {
    let mut objects = Vec::new();
    let mut cursor = 0;
    while let Some(relative) = find_subslice(&bytes[cursor..], b" obj") {
        let keyword_start = cursor + relative;
        let body_start = keyword_start + b" obj".len();
        cursor = body_start;
        let header_start = keyword_start.saturating_sub(24);
        let Some(id) = parse_pdf_object_header(&bytes[header_start..keyword_start]) else {
            continue;
        };
        let body_end = find_subslice(&bytes[body_start..], b"endobj")
            .map_or(bytes.len(), |offset| body_start + offset);
        objects.push(PdfObject {
            id,
            body: &bytes[body_start..body_end],
        });
    }
    objects
}

/// Resolves `/Font << /Fxx N 0 R >>` → `N 0 obj /ToUnicode M 0 R` → the `CMap`
/// in object `M`, so text drawn under `/Fxx` decodes through its own font's map.
///
/// Every parsed `CMap` also lands in the union fallback: a PDF whose resource
/// chain is absent or unresolvable then behaves exactly as it did before, which
/// is what keeps loosely-structured and synthetic PDFs readable.
fn build_pdf_font_maps(bytes: &[u8], decoded_streams: &[DecodedPdfStream<'_>]) -> PdfFontMaps {
    let mut font_maps = PdfFontMaps::default();

    let mut cmaps_by_object: BTreeMap<u32, PdfUnicodeMap> = BTreeMap::new();
    for stream in decoded_streams {
        if !looks_like_cmap_stream(&stream.data) {
            continue;
        }
        let mut map = PdfUnicodeMap::new();
        parse_to_unicode_cmap(&stream.data, &mut map);
        if map.is_empty() {
            continue;
        }
        font_maps
            .fallback
            .extend(map.iter().map(|(code, text)| (code.clone(), text.clone())));
        if let Some(object_id) = stream.object_id {
            cmaps_by_object.insert(object_id, map);
        }
    }
    if cmaps_by_object.is_empty() {
        return font_maps;
    }

    let objects = pdf_objects(bytes);
    let mut cmap_by_font_object: BTreeMap<u32, u32> = BTreeMap::new();
    for object in &objects {
        if let Some(cmap_id) = pdf_indirect_reference(object.body, b"/ToUnicode") {
            cmap_by_font_object.insert(object.id, cmap_id);
        }
    }
    if cmap_by_font_object.is_empty() {
        return font_maps;
    }

    for object in &objects {
        for (resource_name, font_object) in pdf_font_resource_entries(object.body) {
            let Some(cmap) = cmap_by_font_object
                .get(&font_object)
                .and_then(|cmap_id| cmaps_by_object.get(cmap_id))
            else {
                continue;
            };
            // A name reused across resource dictionaries merges rather than
            // overwrites; that is still per-font-name, not document-wide.
            font_maps
                .by_resource_name
                .entry(resource_name)
                .or_default()
                .extend(cmap.iter().map(|(code, text)| (code.clone(), text.clone())));
        }
    }

    font_maps
}

/// Reads the object number out of a `<key> N G R` entry.
fn pdf_indirect_reference(body: &[u8], key: &[u8]) -> Option<u32> {
    let value_start = find_subslice(body, key)? + key.len();
    let value_end = (value_start + 32).min(body.len());
    let text = String::from_utf8_lossy(&body[value_start..value_end]);
    let mut fields = text.split_ascii_whitespace();
    let object_id = fields.next()?.parse::<u32>().ok()?;
    fields.next()?.parse::<u32>().ok()?;
    (fields.next()? == "R").then_some(object_id)
}

/// Reads the `/Name N G R` pairs out of every `/Font << … >>` resource
/// dictionary in an object body.
fn pdf_font_resource_entries(body: &[u8]) -> Vec<(String, u32)> {
    let mut entries = Vec::new();
    let mut cursor = 0;
    while let Some(relative) = find_subslice(&body[cursor..], b"/Font") {
        let after_key = cursor + relative + b"/Font".len();
        cursor = after_key;
        let Some(open) = find_subslice(&body[after_key..], b"<<") else {
            break;
        };
        // `/Font` must introduce an inline dictionary; `/Font 7 0 R` and
        // unrelated keys that merely start with `/Font` are not resource maps.
        if body[after_key..after_key + open]
            .iter()
            .any(|byte| !is_pdf_whitespace(*byte))
        {
            continue;
        }
        let inner_start = after_key + open + b"<<".len();
        let Some(close) = find_subslice(&body[inner_start..], b">>") else {
            break;
        };
        entries.extend(parse_pdf_name_reference_pairs(
            &body[inner_start..inner_start + close],
        ));
        cursor = inner_start + close;
    }
    entries
}

fn parse_pdf_name_reference_pairs(dict: &[u8]) -> Vec<(String, u32)> {
    let text = String::from_utf8_lossy(dict);
    let fields = text.split_ascii_whitespace().collect::<Vec<_>>();
    let mut pairs = Vec::new();
    for window in fields.windows(4) {
        let (name, object_id, generation, marker) = (window[0], window[1], window[2], window[3]);
        if !name.starts_with('/') || marker != "R" || generation.parse::<u32>().is_err() {
            continue;
        }
        if let Ok(object_id) = object_id.parse::<u32>() {
            pairs.push((name[1..].to_string(), object_id));
        }
    }
    pairs
}

fn skip_stream_newline(bytes: &[u8], index: usize) -> usize {
    if bytes.get(index) == Some(&b'\r') && bytes.get(index + 1) == Some(&b'\n') {
        index + 2
    } else if matches!(bytes.get(index), Some(b'\n' | b'\r')) {
        index + 1
    } else {
        index
    }
}

fn decode_pdf_stream(dict: &[u8], data: &[u8]) -> Vec<u8> {
    if ascii_contains(dict, b"/FlateDecode") || ascii_contains(dict, b"/Fl") {
        if let Some(decoded) = inflate_pdf_stream(data) {
            return decoded;
        }
    }
    trim_pdf_stream_data(data).to_vec()
}

fn inflate_pdf_stream(data: &[u8]) -> Option<Vec<u8>> {
    for candidate in [data, trim_pdf_stream_data(data)] {
        if let Some(decoded) = decode_zlib(candidate) {
            return Some(decoded);
        }
        if let Some(decoded) = decode_deflate(candidate) {
            return Some(decoded);
        }
    }
    None
}

fn decode_zlib(data: &[u8]) -> Option<Vec<u8>> {
    let mut decoder = ZlibDecoder::new(data);
    let mut out = Vec::new();
    decoder.read_to_end(&mut out).ok()?;
    Some(out)
}

fn decode_deflate(data: &[u8]) -> Option<Vec<u8>> {
    let mut decoder = DeflateDecoder::new(data);
    let mut out = Vec::new();
    decoder.read_to_end(&mut out).ok()?;
    Some(out)
}

fn trim_pdf_stream_data(data: &[u8]) -> &[u8] {
    let mut end = data.len();
    while end > 0 && matches!(data[end - 1], b'\n' | b'\r' | b'\t' | b' ') {
        end -= 1;
    }
    &data[..end]
}

fn looks_like_cmap_stream(data: &[u8]) -> bool {
    ascii_contains(data, b"begincmap")
        || ascii_contains(data, b"beginbfchar")
        || ascii_contains(data, b"beginbfrange")
}

fn looks_like_image_stream(dict: &[u8]) -> bool {
    ascii_contains(dict, b"/Subtype") && ascii_contains(dict, b"/Image")
}

fn looks_like_page_content_stream(data: &[u8]) -> bool {
    ascii_contains(data, b"BT")
        && (ascii_contains(data, b"Tj")
            || ascii_contains(data, b"TJ")
            || ascii_contains(data, b" T*")
            || ascii_contains(data, b" ET"))
}

fn parse_to_unicode_cmap(data: &[u8], map: &mut PdfUnicodeMap) {
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum CMapMode {
        BfChar,
        BfRange,
    }

    let text = String::from_utf8_lossy(data);
    let mut mode = None;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.contains("beginbfchar") {
            mode = Some(CMapMode::BfChar);
            continue;
        }
        if trimmed.contains("beginbfrange") {
            mode = Some(CMapMode::BfRange);
            continue;
        }
        if trimmed.contains("endbfchar") || trimmed.contains("endbfrange") {
            mode = None;
            continue;
        }

        let hex_values = hex_strings_in_line(trimmed);
        match mode {
            Some(CMapMode::BfChar) => {
                for pair in hex_values.chunks(2) {
                    if pair.len() == 2 {
                        let source = hex_to_bytes(&pair[0]);
                        let target = unicode_hex_to_string(&pair[1]);
                        if !source.is_empty() && !target.is_empty() {
                            map.insert(source, target);
                        }
                    }
                }
            }
            Some(CMapMode::BfRange) => parse_cmap_range(trimmed, &hex_values, map),
            None => {}
        }
    }
}

fn parse_cmap_range(line: &str, hex_values: &[String], map: &mut PdfUnicodeMap) {
    if hex_values.len() < 3 {
        return;
    }
    let start = hex_to_bytes(&hex_values[0]);
    let end = hex_to_bytes(&hex_values[1]);
    if start.is_empty() || start.len() != end.len() {
        return;
    }
    let Some(start_value) = big_endian_bytes_to_u32(&start) else {
        return;
    };
    let Some(end_value) = big_endian_bytes_to_u32(&end) else {
        return;
    };
    if end_value < start_value {
        return;
    }

    let span = end_value - start_value;
    if line.contains('[') {
        for (offset, target_hex) in hex_values.iter().skip(2).enumerate() {
            let source_value =
                start_value.saturating_add(u32::try_from(offset).unwrap_or(u32::MAX));
            if source_value > end_value {
                break;
            }
            let source = u32_to_big_endian_bytes(source_value, start.len());
            let target = unicode_hex_to_string(target_hex);
            if !target.is_empty() {
                map.insert(source, target);
            }
        }
        return;
    }

    let target = hex_to_bytes(&hex_values[2]);
    let Some(target_value) = big_endian_bytes_to_u32(&target) else {
        return;
    };
    for offset in 0..=span {
        let source = u32_to_big_endian_bytes(start_value + offset, start.len());
        let target_bytes = u32_to_big_endian_bytes(target_value + offset, target.len());
        let target_text = decode_utf16be_units(&target_bytes);
        if !target_text.is_empty() {
            map.insert(source, target_text);
        }
    }
}

fn extract_pdf_content_text(data: &[u8], font_maps: &PdfFontMaps) -> String {
    let mut index = 0;
    let mut stack = Vec::new();
    let mut output = String::new();
    let mut current_font: Option<String> = None;

    while let Some(token) = next_pdf_token(data, &mut index) {
        match token {
            PdfToken::Word(word) => {
                if word == "Tf" {
                    current_font = pdf_selected_font_name(&stack);
                    stack.clear();
                } else if handle_pdf_text_operator(
                    &word,
                    &stack,
                    font_maps.resolve(current_font.as_deref()),
                    &mut output,
                ) {
                    stack.clear();
                } else if looks_like_pdf_operator(&word) {
                    stack.clear();
                } else {
                    stack.push(PdfToken::Word(word));
                }
            }
            other => {
                stack.push(other);
                if stack.len() > 64 {
                    stack.remove(0);
                }
            }
        }
    }

    normalize_pdf_text(&output)
}

/// Font resource name operand of a `/Fxx <size> Tf` selection.
fn pdf_selected_font_name(stack: &[PdfToken]) -> Option<String> {
    stack.iter().rev().find_map(|token| match token {
        PdfToken::Word(word) => word.strip_prefix('/').map(str::to_string),
        _ => None,
    })
}

fn handle_pdf_text_operator(
    operator: &str,
    stack: &[PdfToken],
    unicode_map: &PdfUnicodeMap,
    output: &mut String,
) -> bool {
    match operator {
        "BT" => true,
        "ET" | "T*" | "Td" | "TD" => {
            push_pdf_line_break(output);
            true
        }
        "Tj" => {
            if let Some(token) = stack
                .iter()
                .rev()
                .find(|token| matches!(token, PdfToken::String(_)))
            {
                push_pdf_text(output, &decode_pdf_text_token(token, unicode_map));
            }
            true
        }
        "TJ" => {
            if let Some(PdfToken::Array(items)) = stack
                .iter()
                .rev()
                .find(|token| matches!(token, PdfToken::Array(_)))
            {
                push_pdf_text(output, &decode_pdf_text_array(items, unicode_map));
            }
            true
        }
        "'" | "\"" => {
            push_pdf_line_break(output);
            if let Some(token) = stack
                .iter()
                .rev()
                .find(|token| matches!(token, PdfToken::String(_)))
            {
                push_pdf_text(output, &decode_pdf_text_token(token, unicode_map));
            }
            true
        }
        _ => false,
    }
}

fn next_pdf_token(data: &[u8], index: &mut usize) -> Option<PdfToken> {
    skip_pdf_whitespace_and_comments(data, index);
    let current = *data.get(*index)?;
    match current {
        b'(' => Some(PdfToken::String(parse_pdf_literal_string(data, index))),
        b'<' if data.get(*index + 1) != Some(&b'<') => {
            Some(PdfToken::String(parse_pdf_hex_string(data, index)))
        }
        b'[' => Some(PdfToken::Array(parse_pdf_array(data, index))),
        b']' => {
            *index += 1;
            Some(PdfToken::Word(String::from("]")))
        }
        b'<' | b'>' => {
            let end = (*index + 2).min(data.len());
            let word = String::from_utf8_lossy(&data[*index..end]).into_owned();
            *index = end;
            Some(PdfToken::Word(word))
        }
        _ => Some(parse_pdf_word(data, index)),
    }
}

fn parse_pdf_array(data: &[u8], index: &mut usize) -> Vec<PdfToken> {
    *index += 1;
    let mut items = Vec::new();
    loop {
        skip_pdf_whitespace_and_comments(data, index);
        match data.get(*index) {
            Some(b']') => {
                *index += 1;
                break;
            }
            Some(_) => {
                if let Some(token) = next_pdf_token(data, index) {
                    items.push(token);
                } else {
                    break;
                }
            }
            None => break,
        }
    }
    items
}

fn parse_pdf_literal_string(data: &[u8], index: &mut usize) -> Vec<u8> {
    *index += 1;
    let mut depth = 1usize;
    let mut out = Vec::new();
    while *index < data.len() && depth > 0 {
        let byte = data[*index];
        *index += 1;
        match byte {
            b'\\' => parse_pdf_escape(data, index, &mut out),
            b'(' => {
                depth += 1;
                out.push(byte);
            }
            b')' => {
                depth = depth.saturating_sub(1);
                if depth > 0 {
                    out.push(byte);
                }
            }
            _ => out.push(byte),
        }
    }
    out
}

fn parse_pdf_escape(data: &[u8], index: &mut usize, out: &mut Vec<u8>) {
    let Some(&byte) = data.get(*index) else {
        return;
    };
    *index += 1;
    match byte {
        b'n' => out.push(b'\n'),
        b'r' => out.push(b'\r'),
        b't' => out.push(b'\t'),
        b'b' => out.push(0x08),
        b'f' => out.push(0x0C),
        b'(' | b')' | b'\\' => out.push(byte),
        b'\r' => {
            if data.get(*index) == Some(&b'\n') {
                *index += 1;
            }
        }
        b'\n' => {}
        b'0'..=b'7' => {
            let mut value = byte - b'0';
            for _ in 0..2 {
                let Some(&next) = data.get(*index) else {
                    break;
                };
                if !(b'0'..=b'7').contains(&next) {
                    break;
                }
                *index += 1;
                value = value.saturating_mul(8).saturating_add(next - b'0');
            }
            out.push(value);
        }
        _ => out.push(byte),
    }
}

fn parse_pdf_hex_string(data: &[u8], index: &mut usize) -> Vec<u8> {
    *index += 1;
    let start = *index;
    while *index < data.len() && data[*index] != b'>' {
        *index += 1;
    }
    let raw = String::from_utf8_lossy(&data[start..*index]);
    if data.get(*index) == Some(&b'>') {
        *index += 1;
    }
    hex_to_bytes(&raw)
}

fn parse_pdf_word(data: &[u8], index: &mut usize) -> PdfToken {
    let start = *index;
    while *index < data.len() && !is_pdf_whitespace(data[*index]) && !is_pdf_delimiter(data[*index])
    {
        *index += 1;
    }
    if *index == start {
        *index += 1;
    }
    let word = String::from_utf8_lossy(&data[start..*index]).into_owned();
    word.parse::<f32>()
        .map_or(PdfToken::Word(word), PdfToken::Number)
}

fn skip_pdf_whitespace_and_comments(data: &[u8], index: &mut usize) {
    loop {
        while data
            .get(*index)
            .is_some_and(|byte| is_pdf_whitespace(*byte))
        {
            *index += 1;
        }
        if data.get(*index) == Some(&b'%') {
            while data
                .get(*index)
                .is_some_and(|byte| !matches!(byte, b'\n' | b'\r'))
            {
                *index += 1;
            }
            continue;
        }
        break;
    }
}

fn is_pdf_whitespace(byte: u8) -> bool {
    matches!(byte, b'\0' | b'\t' | b'\n' | b'\x0C' | b'\r' | b' ')
}

fn is_pdf_delimiter(byte: u8) -> bool {
    matches!(
        byte,
        b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'%'
    )
}

fn looks_like_pdf_operator(word: &str) -> bool {
    word.chars()
        .all(|ch| ch.is_ascii_alphabetic() || matches!(ch, '\'' | '"'))
}

fn decode_pdf_text_array(items: &[PdfToken], unicode_map: &PdfUnicodeMap) -> String {
    let mut out = String::new();
    for item in items {
        match item {
            PdfToken::String(_) => {
                push_pdf_text(&mut out, &decode_pdf_text_token(item, unicode_map))
            }
            PdfToken::Number(value) if *value < -120.0 => push_pdf_text(&mut out, " "),
            _ => {}
        }
    }
    out
}

fn decode_pdf_text_token(token: &PdfToken, unicode_map: &PdfUnicodeMap) -> String {
    match token {
        PdfToken::String(bytes) => decode_pdf_text_bytes(bytes, unicode_map),
        _ => String::new(),
    }
}

fn decode_pdf_text_bytes(bytes: &[u8], unicode_map: &PdfUnicodeMap) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    if let Some(decoded) = decode_utf16_with_bom(bytes) {
        return decoded;
    }
    if let Some(decoded) = decode_bytes_with_cmap(bytes, unicode_map) {
        return decoded;
    }
    if looks_like_utf16be(bytes) {
        return decode_utf16be_units(bytes);
    }
    bytes
        .iter()
        .filter_map(|byte| pdf_doc_byte(*byte))
        .collect()
}

fn decode_bytes_with_cmap(bytes: &[u8], unicode_map: &PdfUnicodeMap) -> Option<String> {
    let max_key_len = unicode_map.keys().map(Vec::len).max()?;
    let mut index = 0;
    let mut hits = 0usize;
    let mut out = String::new();
    while index < bytes.len() {
        let mut matched = false;
        for len in (1..=max_key_len).rev() {
            if index + len > bytes.len() {
                continue;
            }
            if let Some(value) = unicode_map.get(&bytes[index..index + len]) {
                out.push_str(value);
                index += len;
                hits += 1;
                matched = true;
                break;
            }
        }
        if !matched {
            if let Some(ch) = pdf_doc_byte(bytes[index]) {
                out.push(ch);
            }
            index += 1;
        }
    }
    (hits > 0).then_some(out)
}

fn decode_utf16_with_bom(bytes: &[u8]) -> Option<String> {
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return Some(decode_utf16be_units(&bytes[2..]));
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let units = bytes[2..]
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]));
        return Some(decode_utf16_units(units));
    }
    None
}

/// Whether a text-show operand is BOM-less UTF-16BE rather than single-byte or
/// CID text.
///
/// The discriminator is the high byte: genuine UTF-16BE Latin text is almost
/// entirely `00 xx` units, while single-byte text has printable ASCII in both
/// halves of every unit and never `00`. Getting this wrong is not a near miss —
/// pairing adjacent single bytes fuses them into a CJK codepoint, which is how
/// `ICLR 2023` became `䥃䱒 ㈰㈳` and erased the venue line of every paper the
/// model read. The previous `>= len / 6` threshold rounded down to zero for
/// operands shorter than twelve bytes and so accepted *every* short even-length
/// string; kerned PDF text is emitted in exactly such fragments.
fn looks_like_utf16be(bytes: &[u8]) -> bool {
    if bytes.len() < 4 || bytes.len() % 2 != 0 {
        return false;
    }
    let units = bytes.len() / 2;
    let latin_units = bytes
        .chunks_exact(2)
        .filter(|unit| unit[0] == 0 && unit[1] != 0)
        .count();
    latin_units >= 2 && latin_units * 4 >= units * 3
}

fn decode_utf16be_units(bytes: &[u8]) -> String {
    let units = bytes
        .chunks_exact(2)
        .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]));
    decode_utf16_units(units)
}

fn decode_utf16_units(units: impl Iterator<Item = u16>) -> String {
    std::char::decode_utf16(units)
        .map(|result| result.unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect()
}

fn pdf_doc_byte(byte: u8) -> Option<char> {
    fn cp(value: u32) -> Option<char> {
        char::from_u32(value)
    }

    match byte {
        0x00 => None,
        b'\n' | b'\r' | b'\t' => Some(' '),
        0x20..=0x7E => Some(char::from(byte)),
        0x80 => cp(0x20AC),
        0x82 => cp(0x201A),
        0x83 => cp(0x0192),
        0x84 => cp(0x201E),
        0x85 => cp(0x2026),
        0x86 => cp(0x2020),
        0x87 => cp(0x2021),
        0x88 => cp(0x02C6),
        0x89 => cp(0x2030),
        0x8A => cp(0x0160),
        0x8B => cp(0x2039),
        0x8C => cp(0x0152),
        0x8E => cp(0x017D),
        0x91 => cp(0x2018),
        0x92 => cp(0x2019),
        0x93 => cp(0x201C),
        0x94 => cp(0x201D),
        0x95 => cp(0x2022),
        0x96 => cp(0x2013),
        0x97 => cp(0x2014),
        0x98 => cp(0x02DC),
        0x99 => cp(0x2122),
        0x9A => cp(0x0161),
        0x9B => cp(0x203A),
        0x9C => cp(0x0153),
        0x9E => cp(0x017E),
        0x9F => cp(0x0178),
        0xA0 => Some(' '),
        0xA1..=0xFF => char::from_u32(u32::from(byte)),
        _ => None,
    }
}

fn push_pdf_text(output: &mut String, text: &str) {
    if text.is_empty() {
        return;
    }
    output.push_str(text);
}

fn push_pdf_line_break(output: &mut String) {
    if !output.ends_with('\n') {
        output.push('\n');
    }
}

fn normalize_pdf_text(input: &str) -> String {
    input
        .lines()
        .map(collapse_inline_whitespace)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn collapse_inline_whitespace(line: &str) -> String {
    let mut out = String::new();
    let mut previous_was_space = false;
    for ch in line.chars() {
        if ch.is_whitespace() {
            if !previous_was_space && !out.is_empty() {
                out.push(' ');
                previous_was_space = true;
            }
        } else {
            out.push(ch);
            previous_was_space = false;
        }
    }
    out.trim().to_string()
}

fn hex_strings_in_line(line: &str) -> Vec<String> {
    let bytes = line.as_bytes();
    let mut index = 0;
    let mut values = Vec::new();
    while index < bytes.len() {
        if bytes[index] == b'<' && bytes.get(index + 1) != Some(&b'<') {
            let start = index + 1;
            index = start;
            while index < bytes.len() && bytes[index] != b'>' {
                index += 1;
            }
            if index < bytes.len() {
                values.push(line[start..index].to_string());
            }
        }
        index += 1;
    }
    values
}

fn hex_to_bytes(raw: &str) -> Vec<u8> {
    let mut digits = raw
        .bytes()
        .filter(|byte| byte.is_ascii_hexdigit())
        .collect::<Vec<_>>();
    if digits.len() % 2 == 1 {
        digits.push(b'0');
    }
    digits
        .chunks(2)
        .filter_map(|pair| {
            let hi = hex_nibble(pair[0])?;
            let lo = hex_nibble(pair[1])?;
            Some((hi << 4) | lo)
        })
        .collect()
}

fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn unicode_hex_to_string(raw: &str) -> String {
    let bytes = hex_to_bytes(raw);
    if bytes.len() >= 2 && bytes.len() % 2 == 0 {
        decode_utf16be_units(&bytes)
    } else {
        bytes
            .iter()
            .filter_map(|byte| pdf_doc_byte(*byte))
            .collect()
    }
}

fn big_endian_bytes_to_u32(bytes: &[u8]) -> Option<u32> {
    if bytes.len() > 4 {
        return None;
    }
    let mut value = 0u32;
    for byte in bytes {
        value = (value << 8) | u32::from(*byte);
    }
    Some(value)
}

fn u32_to_big_endian_bytes(value: u32, len: usize) -> Vec<u8> {
    (0..len)
        .rev()
        .map(|shift| ((value >> (shift * 8)) & 0xFF) as u8)
        .collect()
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn rfind_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(haystack.len());
    }
    haystack
        .windows(needle.len())
        .rposition(|window| window == needle)
}

fn ascii_contains(haystack: &[u8], needle: &[u8]) -> bool {
    find_subslice(haystack, needle).is_some()
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

    let removed = &original_lines[start..old_end];
    let added = &updated_lines[start..new_end];
    let lines = bounded_patch_lines(removed, added);

    vec![StructuredPatchHunk {
        old_start: start + 1,
        old_lines: old_end.saturating_sub(start),
        new_start: start + 1,
        new_lines: new_end.saturating_sub(start),
        lines,
    }]
}

fn bounded_patch_lines(removed: &[&str], added: &[&str]) -> Vec<String> {
    let total = removed.len().saturating_add(added.len());
    if total <= MAX_STRUCTURED_PATCH_LINES {
        return removed
            .iter()
            .map(|line| compact_patch_line('-', line))
            .chain(added.iter().map(|line| compact_patch_line('+', line)))
            .collect();
    }

    let head = MAX_STRUCTURED_PATCH_LINES / 4;
    let tail = MAX_STRUCTURED_PATCH_LINES / 4;
    let captured_removed = removed.len().min(head + tail);
    let captured_added = added.len().min(head + tail);
    let omitted = total.saturating_sub(captured_removed + captured_added);
    let mut lines = Vec::with_capacity(captured_removed + captured_added + 1);
    extend_bounded_patch_side(&mut lines, '-', removed, head, tail);
    lines.push(format!(
        " [SomniQ omitted {omitted} changed lines from this bounded patch; exact before/after hashes remain in the change ledger.]"
    ));
    extend_bounded_patch_side(&mut lines, '+', added, head, tail);
    lines
}

fn extend_bounded_patch_side(
    output: &mut Vec<String>,
    prefix: char,
    lines: &[&str],
    head: usize,
    tail: usize,
) {
    if lines.len() <= head + tail {
        output.extend(lines.iter().map(|line| compact_patch_line(prefix, line)));
        return;
    }
    output.extend(
        lines
            .iter()
            .take(head)
            .map(|line| compact_patch_line(prefix, line)),
    );
    output.extend(
        lines[lines.len() - tail..]
            .iter()
            .map(|line| compact_patch_line(prefix, line)),
    );
}

fn compact_patch_line(prefix: char, line: &str) -> String {
    let total = line.chars().count();
    if total <= MAX_STRUCTURED_PATCH_LINE_CHARS {
        return format!("{prefix}{line}");
    }
    let preview = line
        .chars()
        .take(MAX_STRUCTURED_PATCH_LINE_CHARS)
        .collect::<String>();
    format!("{prefix}{preview}… [line compacted from {total} chars]")
}

fn edit_context_windows(
    updated: &str,
    structured_patch: &[StructuredPatchHunk],
) -> Vec<EditContextWindow> {
    let lines = updated.lines().collect::<Vec<_>>();
    if lines.is_empty() || structured_patch.is_empty() {
        return Vec::new();
    }

    let mut ranges = Vec::<(usize, usize)>::new();
    for hunk in structured_patch {
        let changed_start = hunk
            .new_start
            .saturating_sub(1)
            .min(lines.len().saturating_sub(1));
        let changed_lines = hunk.new_lines.max(1);
        let changed_end = changed_start.saturating_add(changed_lines).min(lines.len());
        if changed_lines <= EDIT_CONTEXT_LINES * 2 {
            ranges.push((
                changed_start.saturating_sub(EDIT_CONTEXT_LINES),
                changed_end
                    .saturating_add(EDIT_CONTEXT_LINES)
                    .min(lines.len()),
            ));
        } else {
            ranges.push((
                changed_start.saturating_sub(EDIT_CONTEXT_LINES),
                changed_start
                    .saturating_add(EDIT_CONTEXT_LINES + 1)
                    .min(lines.len()),
            ));
            let last_changed = changed_end.saturating_sub(1);
            ranges.push((
                last_changed.saturating_sub(EDIT_CONTEXT_LINES),
                last_changed
                    .saturating_add(EDIT_CONTEXT_LINES + 1)
                    .min(lines.len()),
            ));
        }
    }

    ranges.sort_unstable();
    let mut merged = Vec::<(usize, usize)>::new();
    for (start, end) in ranges {
        if let Some(last) = merged.last_mut() {
            if start <= last.1 {
                last.1 = last.1.max(end);
                continue;
            }
        }
        merged.push((start, end));
    }

    merged
        .into_iter()
        .take(MAX_EDIT_CONTEXT_WINDOWS)
        .map(|(start, end)| EditContextWindow {
            start_line: start + 1,
            end_line: end,
            content: numbered_lines(&lines[start..end], start + 1).join("\n"),
        })
        .collect()
}

fn make_compact_update_changes(
    file_path: &str,
    unified_diff: &str,
) -> BTreeMap<String, FileChange> {
    let mut changes = BTreeMap::new();
    changes.insert(
        file_path.to_string(),
        FileChange::Update {
            unified_diff: compact_tool_diff(unified_diff),
            move_path: None,
        },
    );
    changes
}

fn compact_tool_diff(unified_diff: &str) -> String {
    let total_chars = unified_diff.chars().count();
    if total_chars <= MAX_EDIT_TOOL_DIFF_CHARS {
        return unified_diff.to_string();
    }

    let marker = format!(
        "\n[SomniQ compacted this tool-result diff: {total_chars} chars total. Audited before/after hashes and a bounded patch remain available through change_get.]\n"
    );
    let remaining = MAX_EDIT_TOOL_DIFF_CHARS.saturating_sub(marker.chars().count());
    let head_chars = remaining / 2;
    let tail_chars = remaining.saturating_sub(head_chars);
    let head = unified_diff.chars().take(head_chars).collect::<String>();
    let tail = unified_diff
        .chars()
        .rev()
        .take(tail_chars)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    format!("{head}{marker}{tail}")
}

fn make_file_changes(
    file_path: &str,
    original: Option<&str>,
    updated: Option<&str>,
) -> BTreeMap<String, FileChange> {
    let mut changes = BTreeMap::new();
    match (original, updated) {
        (None, Some(updated)) => {
            changes.insert(
                file_path.to_string(),
                FileChange::Add {
                    content: compact_tool_content(updated),
                },
            );
        }
        (Some(original), None) => {
            changes.insert(
                file_path.to_string(),
                FileChange::Delete {
                    content: compact_tool_content(original),
                },
            );
        }
        (Some(original), Some(updated)) if original != updated => {
            changes.insert(
                file_path.to_string(),
                FileChange::Update {
                    unified_diff: make_unified_diff(file_path, original, updated),
                    move_path: None,
                },
            );
        }
        _ => {}
    }
    changes
}

fn compact_tool_content(content: &str) -> String {
    let total_chars = content.chars().count();
    if total_chars <= MAX_EDIT_TOOL_DIFF_CHARS {
        return content.to_string();
    }
    let marker = format!(
        "\n[SomniQ compacted this tool-result content: {total_chars} chars total. Exact content hashes remain in the change ledger.]\n"
    );
    let remaining = MAX_EDIT_TOOL_DIFF_CHARS.saturating_sub(marker.chars().count());
    let head_chars = remaining / 2;
    let tail_chars = remaining.saturating_sub(head_chars);
    let head = content.chars().take(head_chars).collect::<String>();
    let tail = content
        .chars()
        .rev()
        .take(tail_chars)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    format!("{head}{marker}{tail}")
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

fn normalize_path(path: &str) -> io::Result<PathBuf> {
    let root = workspace_root()?;
    let candidate = path_candidate(path, root.as_deref())?;
    let canonical = candidate.canonicalize()?;
    if let Some(root) = root.as_ref() {
        ensure_within_workspace(&canonical, root)?;
    }
    Ok(canonical)
}

fn normalize_read_path(path: &str) -> io::Result<PathBuf> {
    let root = workspace_root()?;
    let candidate = path_candidate(path, root.as_deref())?;
    let canonical = candidate.canonicalize().map_err(|error| {
        io::Error::new(
            error.kind(),
            format!("failed to resolve `{}`: {error}", candidate.display()),
        )
    })?;
    if root.is_some() {
        ensure_readable_path(&canonical, &readable_roots(root.as_deref())?)?;
    }
    Ok(canonical)
}

fn normalize_search_base(
    path: &str,
    workspace_root: Option<&Path>,
    readable_roots: &[PathBuf],
) -> io::Result<PathBuf> {
    let candidate = path_candidate(path, workspace_root)?;
    let canonical = candidate.canonicalize()?;
    if workspace_root.is_some() {
        ensure_search_base_allowed(&canonical, readable_roots)?;
    }
    Ok(canonical)
}

fn normalize_path_allow_missing(path: &str) -> io::Result<PathBuf> {
    let root = workspace_root()?;
    let candidate = path_candidate(path, root.as_deref())?;
    let canonical = canonicalize_allow_missing(&candidate)?;
    if let Some(root) = root.as_ref() {
        ensure_within_workspace(&canonical, root)?;
    }
    Ok(canonical)
}

fn workspace_root() -> io::Result<Option<PathBuf>> {
    let Some(raw) = crate::execution_env_var_os("ARIS_WORKSPACE_ROOT") else {
        return Ok(None);
    };
    let raw = raw.to_string_lossy();
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let root = PathBuf::from(trimmed);
    fs::create_dir_all(&root)?;
    Ok(Some(root.canonicalize()?))
}

fn readonly_roots() -> Vec<PathBuf> {
    let Some(raw) = crate::execution_env_var_os(READONLY_ROOTS_ENV) else {
        return Vec::new();
    };
    std::env::split_paths(&raw)
        .filter_map(|path| {
            if path.as_os_str().is_empty() || !path.exists() {
                return None;
            }
            path.canonicalize().ok()
        })
        .collect()
}

fn readable_roots(workspace_root: Option<&Path>) -> io::Result<Vec<PathBuf>> {
    let mut roots = Vec::new();
    if let Some(root) = workspace_root {
        roots.push(root.to_path_buf());
    }
    roots.extend(readonly_roots());
    Ok(roots)
}

fn path_candidate(path: &str, workspace_root: Option<&Path>) -> io::Result<PathBuf> {
    let path = Path::new(path);
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }
    match workspace_root {
        Some(root) => Ok(root.join(path)),
        None => Ok(crate::execution_current_dir()?.join(path)),
    }
}

fn ensure_within_workspace(path: &Path, root: &Path) -> io::Result<()> {
    if path.starts_with(root) {
        return Ok(());
    }
    Err(io::Error::new(
        io::ErrorKind::PermissionDenied,
        format!(
            "path `{}` is outside the isolated workspace `{}`",
            path.display(),
            root.display()
        ),
    ))
}

fn ensure_readable_path(path: &Path, roots: &[PathBuf]) -> io::Result<()> {
    if is_under_any_root(path, roots) {
        return Ok(());
    }
    Err(io::Error::new(
        io::ErrorKind::PermissionDenied,
        format!(
            "path `{}` is outside the isolated workspace and read-only roots",
            path.display()
        ),
    ))
}

fn ensure_search_base_allowed(base: &Path, roots: &[PathBuf]) -> io::Result<()> {
    if roots
        .iter()
        .any(|root| base.starts_with(root) || root.starts_with(base))
    {
        return Ok(());
    }
    ensure_readable_path(base, roots)
}

fn ensure_glob_search_allowed(search_path: &Path, roots: &[PathBuf]) -> io::Result<()> {
    let prefix = static_glob_prefix(search_path);
    let base = if prefix.exists() {
        prefix.canonicalize()?
    } else {
        lexically_normalize(&prefix)
    };
    ensure_search_base_allowed(&base, roots)
}

fn is_under_any_root(path: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| path.starts_with(root))
}

fn static_glob_prefix(path: &Path) -> PathBuf {
    let mut prefix = PathBuf::new();
    for component in path.components() {
        if matches!(component, Component::Normal(_)) {
            let text = component.as_os_str().to_string_lossy();
            if text.contains('*') || text.contains('?') || text.contains('[') || text.contains('{')
            {
                break;
            }
        }
        prefix.push(component.as_os_str());
    }
    if prefix.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        prefix
    }
}

fn canonicalize_allow_missing(candidate: &Path) -> io::Result<PathBuf> {
    let candidate = lexically_normalize(candidate);
    if let Ok(canonical) = candidate.canonicalize() {
        return Ok(canonical);
    }

    let mut ancestor = candidate.as_path();
    let mut missing = Vec::<OsString>::new();
    while !ancestor.exists() {
        let name = ancestor.file_name().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                format!("no existing ancestor for `{}`", candidate.display()),
            )
        })?;
        missing.push(name.to_os_string());
        ancestor = ancestor.parent().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                format!("no existing ancestor for `{}`", candidate.display()),
            )
        })?;
    }

    let mut canonical = ancestor.canonicalize()?;
    for component in missing.iter().rev() {
        canonical.push(component);
    }
    Ok(canonical)
}

fn lexically_normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(value) => normalized.push(value),
        }
    }
    normalized
}

#[cfg(test)]
#[path = "tests/file_ops.rs"]
mod tests;
