use std::{
    io::Read,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use encoding_rs::{GB18030, GBK};
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::Manager;

const MAX_FILE_EDITOR_BYTES: u64 = 2 * 1024 * 1024;
const MAX_FILE_BINARY_BYTES: u64 = 40 * 1024 * 1024;
const MAX_TYPESET_DOCUMENT_SCAN_BYTES: u64 = 512 * 1024;
const MAX_TYPESET_DOCUMENTS: usize = 500;
const MAX_TYPESET_TEX_FILES: usize = 5_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTreeEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileText {
    path: String,
    content: String,
    bytes: u64,
    version: String,
}

fn file_content_version(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

/// A compilable LaTeX root document discovered in the current workspace.
/// Included chapter files are deliberately excluded: they do not contain a
/// document class and should remain part of their parent document in the UI.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypesetDocument {
    path: String,
    /// Workspace-relative path of the first-level folder owning this document,
    /// empty when the source sits directly in a library root.
    project_path: String,
    title: String,
    kind: String,
    modified_epoch_ms: u64,
    compile_state: String,
}

/// A first-level folder of a library root that holds at least one `.tex` file.
/// Chapter folders nested deeper stay inside their top-level project instead of
/// each becoming a separate library entry.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypesetProject {
    path: String,
    name: String,
    /// Every `.tex` file below the project, including chapter and include files
    /// that never appear as documents of their own.
    tex_file_count: usize,
    modified_epoch_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypesetLibrary {
    projects: Vec<TypesetProject>,
    documents: Vec<TypesetDocument>,
}

#[derive(Debug, Default)]
struct TypesetScan {
    projects: Vec<TypesetProject>,
    documents: Vec<TypesetDocument>,
    tex_file_count: usize,
}

impl TypesetScan {
    fn budget_exhausted(&self) -> bool {
        self.documents.len() >= MAX_TYPESET_DOCUMENTS
            || self.tex_file_count >= MAX_TYPESET_TEX_FILES
    }
}

fn file_tree_entry_from_path(path: &Path, root: &Path) -> Result<FileTreeEntry, String> {
    let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_dir() && !metadata.is_file() {
        return Err(format!(
            "path is not a file or directory: {}",
            path.display()
        ));
    }
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| display_workspace_path(path, root));
    Ok(FileTreeEntry {
        name,
        path: display_workspace_path(path, root),
        is_dir: metadata.is_dir(),
    })
}

fn modified_epoch_ms(metadata: &std::fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

fn latex_braced_argument(source: &str, command: &str) -> Option<String> {
    let offset = source.find(command)? + command.len();
    let remainder = &source[offset..];
    let start = remainder.find('{')?;
    let mut depth = 0usize;
    let mut escaped = false;

    for (index, ch) in remainder[start..].char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '{' {
            depth += 1;
            continue;
        }
        if ch == '}' {
            depth = depth.saturating_sub(1);
            if depth == 0 {
                let content_start = start + 1;
                return Some(remainder[content_start..start + index].to_string());
            }
        }
    }
    None
}

fn plain_latex_title(value: String) -> String {
    let mut out = String::with_capacity(value.len());
    let mut command = false;
    for ch in value.chars() {
        if command {
            if ch.is_ascii_alphabetic() || ch == '@' {
                continue;
            }
            command = false;
        }
        match ch {
            '\\' => command = true,
            '{' | '}' | '$' => {}
            '~' => out.push(' '),
            _ => out.push(ch),
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn typeset_document_kind(source: &str) -> &'static str {
    let document_class = latex_braced_argument(source, "\\documentclass")
        .unwrap_or_default()
        .to_ascii_lowercase();
    let source_lower = source.to_ascii_lowercase();
    if document_class.contains("beamer")
        && (source_lower.contains("beamerposter") || source_lower.contains("tikzposter"))
    {
        "poster"
    } else if document_class.contains("beamer") {
        "beamer"
    } else if document_class.contains("report")
        || document_class.contains("book")
        || document_class.contains("memoir")
    {
        "report"
    } else {
        "article"
    }
}

fn typeset_document_title(source: &str, path: &Path) -> String {
    let title = latex_braced_argument(source, "\\title")
        .map(plain_latex_title)
        .filter(|title| !title.is_empty());
    title.unwrap_or_else(|| {
        path.file_stem()
            .map(|name| name.to_string_lossy().replace(['_', '-'], " "))
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| "Untitled document".to_string())
    })
}

fn typeset_compile_state(source_path: &Path, source_modified_ms: u64) -> String {
    let pdf_path = source_path.with_extension("pdf");
    let Ok(pdf_metadata) = std::fs::metadata(pdf_path) else {
        return "missing".to_string();
    };
    if !pdf_metadata.is_file() {
        return "missing".to_string();
    }
    if modified_epoch_ms(&pdf_metadata) >= source_modified_ms {
        "fresh".to_string()
    } else {
        "stale".to_string()
    }
}

fn typeset_project(path: String, directory: &Path) -> TypesetProject {
    TypesetProject {
        name: directory
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path,
        tex_file_count: 0,
        modified_epoch_ms: 0,
    }
}

/// Counts one `.tex` file against its project and keeps it as a document when
/// it carries a document class of its own.
fn collect_typeset_file(
    path: &Path,
    root: &Path,
    project: &mut TypesetProject,
    scan: &mut TypesetScan,
) -> Result<(), String> {
    if !path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("tex"))
    {
        return Ok(());
    }
    scan.tex_file_count += 1;
    project.tex_file_count += 1;
    let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
    let source_modified_ms = modified_epoch_ms(&metadata);
    project.modified_epoch_ms = project.modified_epoch_ms.max(source_modified_ms);
    if metadata.len() > MAX_FILE_EDITOR_BYTES {
        return Ok(());
    }
    let handle = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    handle
        .take(MAX_TYPESET_DOCUMENT_SCAN_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    let Ok(source) = decode_text_bytes(&bytes) else {
        return Ok(());
    };
    if !source.contains("\\documentclass") {
        return Ok(());
    }
    scan.documents.push(TypesetDocument {
        path: display_workspace_path(path, root),
        project_path: project.path.clone(),
        title: typeset_document_title(&source, path),
        kind: typeset_document_kind(&source).to_string(),
        modified_epoch_ms: source_modified_ms,
        compile_state: typeset_compile_state(path, source_modified_ms),
    });
    Ok(())
}

/// Walks everything below one project folder. Nested chapter folders keep
/// reporting into the project they belong to rather than becoming projects.
fn collect_typeset_documents(
    directory: &Path,
    root: &Path,
    project: &mut TypesetProject,
    scan: &mut TypesetScan,
) -> Result<(), String> {
    if scan.budget_exhausted() {
        return Ok(());
    }

    for entry in std::fs::read_dir(directory).map_err(|error| error.to_string())? {
        if scan.budget_exhausted() {
            break;
        }
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if tools::layout::is_noisy_workspace_entry(&name) {
            continue;
        }
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            collect_typeset_documents(&path, root, project, scan)?;
        } else if file_type.is_file() {
            collect_typeset_file(&path, root, project, scan)?;
        }
    }
    Ok(())
}

/// Scans one library root: every first-level folder holding at least one `.tex`
/// file becomes a project, and loose `.tex` files in the root itself are
/// gathered into a project standing for the root. Folders without any `.tex`
/// file are not projects and never reach the library.
fn collect_typeset_library(
    library_root: &Path,
    root: &Path,
    scan: &mut TypesetScan,
) -> Result<(), String> {
    if scan.budget_exhausted() {
        return Ok(());
    }
    let root_project_path = if library_root == root {
        String::new()
    } else {
        display_workspace_path(library_root, root)
    };
    let mut root_project = typeset_project(root_project_path, library_root);

    for entry in std::fs::read_dir(library_root).map_err(|error| error.to_string())? {
        if scan.budget_exhausted() {
            break;
        }
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if tools::layout::is_noisy_workspace_entry(&name) {
            continue;
        }
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            let mut project = typeset_project(display_workspace_path(&path, root), &path);
            collect_typeset_documents(&path, root, &mut project, scan)?;
            if project.tex_file_count > 0 {
                scan.projects.push(project);
            }
        } else if file_type.is_file() {
            collect_typeset_file(&path, root, &mut root_project, scan)?;
        }
    }

    if root_project.tex_file_count > 0 {
        scan.projects.push(root_project);
    }
    Ok(())
}

fn mojibake_score(text: &str) -> usize {
    text.chars()
        .filter(|ch| {
            if matches!(
                ch,
                '\u{fffd}' | '\u{e000}'..='\u{f8ff}' | '\u{f0000}'..='\u{ffffd}'
                    | '\u{100000}'..='\u{10fffd}'
            ) {
                return true;
            }
            matches!(
                ch,
                '�' | '锛'
                    | '銆'
                    | '鈥'
                    | '€'
                    | '鎶'
                    | '璁'
                    | '绋'
                    | '瀹'
                    | ''
                    | ''
                    | ''
                    | ''
                    | ''
                    | ''
                    | ''
                    | ''
                    | ''
            )
        })
        .count()
}

fn windows_936_private_use_bytes(ch: char) -> Option<[u8; 2]> {
    let code = ch as u32;
    if (0xe000..=0xe233).contains(&code) {
        let offset = code - 0xe000;
        return Some([0xaa + (offset / 94) as u8, 0xa1 + (offset % 94) as u8]);
    }
    if (0xe234..=0xe4c5).contains(&code) {
        let offset = code - 0xe234;
        return Some([0xf8 + (offset / 94) as u8, 0xa1 + (offset % 94) as u8]);
    }
    if (0xe4c6..=0xe765).contains(&code) {
        let offset = code - 0xe4c6;
        let mut low = 0x40 + (offset % 96) as u8;
        if low >= 0x7f {
            low += 1;
        }
        return Some([0xa1 + (offset / 96) as u8, low]);
    }

    const SINGLE_ROW_SEGMENTS: &[(u32, u32, u8, u8, bool)] = &[
        (0xe766, 0xe76b, 0xa2, 0xab, false),
        (0xe76c, 0xe76d, 0xa2, 0xe3, false),
        (0xe76e, 0xe76f, 0xa2, 0xef, false),
        (0xe770, 0xe771, 0xa2, 0xfd, false),
        (0xe772, 0xe77c, 0xa4, 0xf4, false),
        (0xe77d, 0xe784, 0xa5, 0xf7, false),
        (0xe785, 0xe78c, 0xa6, 0xb9, false),
        (0xe78d, 0xe793, 0xa6, 0xd9, false),
        (0xe794, 0xe795, 0xa6, 0xec, false),
        (0xe796, 0xe796, 0xa6, 0xf3, false),
        (0xe797, 0xe79f, 0xa6, 0xf6, false),
        (0xe7a0, 0xe7ae, 0xa7, 0xc2, false),
        (0xe7af, 0xe7bb, 0xa7, 0xf2, false),
        (0xe7bc, 0xe7c6, 0xa8, 0x96, false),
        (0xe7c7, 0xe7c7, 0xa8, 0xbc, false),
        (0xe7c8, 0xe7c8, 0xa8, 0xbf, false),
        (0xe7c9, 0xe7cc, 0xa8, 0xc1, false),
        (0xe7cd, 0xe7e1, 0xa8, 0xea, false),
        (0xe7e2, 0xe7e2, 0xa9, 0x58, false),
        (0xe7e3, 0xe7e3, 0xa9, 0x5b, false),
        (0xe7e4, 0xe7e6, 0xa9, 0x5d, false),
        (0xe7e7, 0xe7f3, 0xa9, 0x89, false),
        (0xe7f4, 0xe800, 0xa9, 0x97, false),
        (0xe801, 0xe80f, 0xa9, 0xf0, false),
        (0xe810, 0xe814, 0xd7, 0xfa, false),
        (0xe815, 0xe864, 0xfe, 0x50, true),
    ];
    for &(start, end, high, low_start, skip_7f) in SINGLE_ROW_SEGMENTS {
        if (start..=end).contains(&code) {
            let mut low = low_start + (code - start) as u8;
            if skip_7f && low >= 0x7f {
                low += 1;
            }
            return Some([high, low]);
        }
    }
    None
}

fn encode_windows_936_mojibake(content: &str) -> Option<Vec<u8>> {
    let mut bytes = Vec::with_capacity(content.len());
    for ch in content.chars() {
        if let Some(encoded) = windows_936_private_use_bytes(ch) {
            bytes.extend_from_slice(&encoded);
            continue;
        }
        let mut scalar = [0; 4];
        let (encoded, _, had_errors) = GBK.encode(ch.encode_utf8(&mut scalar));
        if had_errors {
            return None;
        }
        bytes.extend_from_slice(&encoded);
    }
    Some(bytes)
}

fn repair_utf8_mojibake(content: &str) -> String {
    let original_score = mojibake_score(content);
    if original_score < 2 {
        return content.to_string();
    }
    if let Some(encoded) = encode_windows_936_mojibake(content) {
        if let Ok(repaired) = String::from_utf8(encoded) {
            if mojibake_score(&repaired) < original_score {
                return repaired;
            }
        }
    }
    for encoding in [GBK, GB18030] {
        let (encoded, _, had_errors) = encoding.encode(content);
        if had_errors {
            continue;
        }
        let Ok(repaired) = String::from_utf8(encoded.into_owned()) else {
            continue;
        };
        if mojibake_score(&repaired) < original_score {
            return repaired;
        }
    }
    content.to_string()
}

fn decode_text_bytes(bytes: &[u8]) -> Result<String, String> {
    if let Ok(content) = std::str::from_utf8(bytes) {
        return Ok(repair_utf8_mojibake(content));
    }
    let (content, _, had_errors) = GB18030.decode(bytes);
    if !had_errors {
        return Ok(content.into_owned());
    }
    let (content, _, had_errors) = GBK.decode(bytes);
    if !had_errors {
        return Ok(content.into_owned());
    }
    Err("file is not valid UTF-8/GB18030 text; open it in its native app".to_string())
}

fn strip_location_suffix(path: &str) -> &str {
    let Some((candidate, suffix)) = path.rsplit_once(':') else {
        return path;
    };
    if !suffix.chars().all(|ch| ch.is_ascii_digit()) {
        return path;
    }
    let Some((without_line, line)) = candidate.rsplit_once(':') else {
        return candidate;
    };
    if line.chars().all(|ch| ch.is_ascii_digit()) {
        without_line
    } else {
        candidate
    }
}

fn is_editor_location_fragment(fragment: &str) -> bool {
    let Some(location) = fragment
        .strip_prefix('L')
        .or_else(|| fragment.strip_prefix('l'))
    else {
        return fragment
            .strip_prefix("line-")
            .is_some_and(|line| !line.is_empty() && line.chars().all(|ch| ch.is_ascii_digit()));
    };
    let (line, column) = location
        .split_once('C')
        .or_else(|| location.split_once('c'))
        .map_or((location, None), |(line, column)| (line, Some(column)));
    !line.is_empty()
        && line.chars().all(|ch| ch.is_ascii_digit())
        && column.map_or(true, |column| {
            !column.is_empty() && column.chars().all(|ch| ch.is_ascii_digit())
        })
}

fn is_editor_location_query(query: &str) -> bool {
    let mut saw_line = false;
    for field in query.split('&') {
        let Some((key, value)) = field.split_once('=') else {
            return false;
        };
        if value.is_empty() || !value.chars().all(|ch| ch.is_ascii_digit()) {
            return false;
        }
        match key.to_ascii_lowercase().as_str() {
            "line" | "linenumber" => saw_line = true,
            "column" | "col" => {}
            _ => return false,
        }
    }
    saw_line
}

fn normalize_open_reference(path: &str) -> Result<String, String> {
    let raw = path
        .trim()
        .trim_matches(|ch| matches!(ch, '`' | '<' | '>' | '"' | '\''));
    if raw.is_empty() {
        return Err("file path is empty".to_string());
    }
    let mut normalized = urlencoding::decode(raw)
        .map_err(|error| format!("invalid encoded file path: {error}"))?
        .into_owned();

    let lower = normalized.to_ascii_lowercase();
    if lower.starts_with("vscode://file/") {
        normalized = normalized["vscode://file/".len()..].to_string();
    } else if lower.starts_with("file://") {
        let mut rest = normalized["file://".len()..].to_string();
        if rest.to_ascii_lowercase().starts_with("localhost/") {
            rest = rest["localhost".len()..].to_string();
        }
        if rest.len() >= 3
            && rest.starts_with('/')
            && rest.as_bytes()[1].is_ascii_alphabetic()
            && rest.as_bytes()[2] == b':'
        {
            rest.remove(0);
        } else if !rest.starts_with('/')
            && !(rest.len() >= 2
                && rest.as_bytes()[0].is_ascii_alphabetic()
                && rest.as_bytes()[1] == b':')
        {
            rest.insert_str(0, "//");
        }
        normalized = rest;
    }
    if normalized.len() >= 3
        && normalized.starts_with('/')
        && normalized.as_bytes()[1].is_ascii_alphabetic()
        && normalized.as_bytes()[2] == b':'
    {
        normalized.remove(0);
    }

    if let Some((candidate, fragment)) = normalized.rsplit_once('#') {
        if is_editor_location_fragment(fragment) {
            normalized.truncate(candidate.len());
        }
    }
    if let Some((candidate, query)) = normalized.rsplit_once('?') {
        if is_editor_location_query(query) {
            normalized.truncate(candidate.len());
        }
    }
    Ok(normalized)
}

fn resolve_open_path(path: &str) -> Result<PathBuf, String> {
    let normalized = normalize_open_reference(path)?;
    let raw = normalized.as_str();
    let workspace = crate::state::workspace_dir();

    let resolve = |candidate: &str| {
        let path = Path::new(candidate);
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            workspace.join(path)
        }
    };

    // Try the path as written, then with any trailing `:line[:col]` editor
    // location stripped. For each form, fall back to re-anchoring a stale
    // absolute prefix onto the current workspace so links generated against a
    // moved or renamed config dir (a different drive, a legacy `aris` → `SomniQ`
    // migration, or a location the model simply guessed) still open.
    for candidate in [raw, strip_location_suffix(raw)] {
        let direct = resolve(candidate);
        if direct.exists() {
            return direct.canonicalize().map_err(|error| error.to_string());
        }
        if let Some(reanchored) = reanchor_to_workspace(candidate, &workspace) {
            if reanchored.exists() {
                return reanchored.canonicalize().map_err(|error| error.to_string());
            }
        }
    }

    let target = resolve(strip_location_suffix(raw));
    Err(format!("file does not exist: {}", target.display()))
}

/// Recover a workspace file whose link carries a stale absolute prefix.
///
/// Links to generated files sometimes embed an absolute path that no longer
/// resolves: the config dir moved to another drive, a legacy `aris` directory
/// was migrated to `SomniQ`, or the model guessed the absolute location. In each
/// case the workspace-relative tail is still correct, so we locate the workspace
/// directory-name segment (e.g. `desktop-workspace`) inside the path and
/// re-anchor whatever follows it onto the real workspace root.
fn reanchor_to_workspace(candidate: &str, workspace: &Path) -> Option<PathBuf> {
    let anchor = workspace.file_name()?.to_str()?;
    let normalized = candidate.replace('\\', "/");
    let needle = format!("/{anchor}/");
    let tail = normalized.rsplit_once(needle.as_str())?.1;
    if tail.is_empty() {
        return None;
    }
    Some(workspace.join(tail))
}

fn workspace_root() -> Result<PathBuf, String> {
    crate::state::workspace_dir()
        .canonicalize()
        .map_err(|error| error.to_string())
}

pub(crate) fn display_workspace_path(path: &Path, root: &Path) -> String {
    path.strip_prefix(root)
        .ok()
        .filter(|relative| !relative.as_os_str().is_empty())
        .unwrap_or(path)
        .display()
        .to_string()
        .replace('\\', "/")
}

fn resolve_workspace_dir(path: Option<String>) -> Result<PathBuf, String> {
    let root = workspace_root()?;
    let raw = path.unwrap_or_default();
    let trimmed = raw.trim();
    let candidate = if trimmed.is_empty() || trimmed == "." {
        root.clone()
    } else {
        let path = Path::new(trimmed);
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            root.join(path)
        }
    };
    let target = candidate
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !target.is_dir() {
        return Err(format!("path is not a directory: {}", target.display()));
    }
    if !target.starts_with(&root) {
        return Err("directory is outside the current workspace".to_string());
    }
    Ok(target)
}

pub(crate) fn resolve_workspace_file(path: &str) -> Result<(PathBuf, PathBuf), String> {
    let root = workspace_root()?;
    let raw = path.trim().trim_matches(|ch| matches!(ch, '`' | '<' | '>'));
    if raw.is_empty() {
        return Err("file path is empty".to_string());
    }
    let candidate = {
        let path = Path::new(raw);
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            root.join(path)
        }
    };
    let target = candidate
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !target.is_file() {
        return Err(format!("path is not a file: {}", target.display()));
    }
    if !target.starts_with(&root) {
        return Err("file is outside the current workspace".to_string());
    }
    Ok((root, target))
}

fn resolve_workspace_existing_path(
    path: &str,
    allow_root: bool,
) -> Result<(PathBuf, PathBuf), String> {
    let root = workspace_root()?;
    resolve_existing_path_within(&root, path, allow_root)
}

/// Resolve an existing entry beneath `root` (which must already be
/// canonicalized). `allow_root` decides whether the workspace root itself is a
/// valid target: read-only actions like revealing the folder in the file
/// manager pass `true`, while mutating actions (rename/duplicate/delete) pass
/// `false` so the root can never be renamed, copied, or removed.
fn resolve_existing_path_within(
    root: &Path,
    path: &str,
    allow_root: bool,
) -> Result<(PathBuf, PathBuf), String> {
    let raw = path.trim().trim_matches(|ch| matches!(ch, '`' | '<' | '>'));
    if raw.is_empty() {
        return Err("path is empty".to_string());
    }
    let candidate = {
        let path = Path::new(raw);
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            root.join(path)
        }
    };
    let target = candidate
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !target.starts_with(root) {
        return Err("path is outside the current workspace".to_string());
    }
    if !allow_root && target.as_path() == root {
        return Err("operation is not allowed on the workspace root".to_string());
    }
    let metadata = std::fs::metadata(&target).map_err(|error| error.to_string())?;
    if !metadata.is_dir() && !metadata.is_file() {
        return Err(format!(
            "path is not a file or directory: {}",
            target.display()
        ));
    }
    Ok((root.to_path_buf(), target))
}

pub(crate) fn resolve_workspace_output_file(path: &str) -> Result<(PathBuf, PathBuf), String> {
    resolve_workspace_output_path(path, "file")
}

fn resolve_workspace_output_path(path: &str, kind: &str) -> Result<(PathBuf, PathBuf), String> {
    let root = workspace_root()?;
    let raw = path.trim().trim_matches(|ch| matches!(ch, '`' | '<' | '>'));
    if raw.is_empty() {
        return Err(format!("{kind} path is empty"));
    }
    let candidate = {
        let path = Path::new(raw);
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            root.join(path)
        }
    };
    let parent = candidate
        .parent()
        .ok_or_else(|| format!("{kind} path must include a name"))?;
    let canonical_parent = canonicalize_path_allow_missing(parent)?;
    if !canonical_parent.starts_with(&root) {
        return Err(format!("{kind} is outside the current workspace"));
    }
    let file_name = candidate
        .file_name()
        .ok_or_else(|| format!("{kind} path must include a name"))?;
    Ok((root, canonical_parent.join(file_name)))
}

fn canonicalize_path_allow_missing(path: &Path) -> Result<PathBuf, String> {
    if path.exists() {
        return path.canonicalize().map_err(|error| error.to_string());
    }

    let mut missing = Vec::new();
    let mut ancestor = path;
    while !ancestor.exists() {
        let file_name = ancestor.file_name().ok_or_else(|| {
            format!(
                "could not resolve missing path ancestor for `{}`",
                path.display()
            )
        })?;
        missing.push(file_name.to_os_string());
        ancestor = ancestor.parent().ok_or_else(|| {
            format!(
                "could not resolve missing path ancestor for `{}`",
                path.display()
            )
        })?;
    }

    let mut canonical = ancestor.canonicalize().map_err(|error| error.to_string())?;
    for component in missing.iter().rev() {
        canonical.push(component);
    }
    Ok(lexically_normalize_path(&canonical))
}

fn lexically_normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            std::path::Component::RootDir => normalized.push(component.as_os_str()),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            std::path::Component::Normal(value) => normalized.push(value),
        }
    }
    normalized
}

#[tauri::command]
pub fn file_open(path: String) -> Result<(), String> {
    let target = resolve_open_path(&path)?;
    #[cfg(target_os = "windows")]
    let mut command = crate::process::hidden_command("explorer.exe");
    #[cfg(target_os = "macos")]
    let mut command = crate::process::hidden_command("open");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = crate::process::hidden_command("xdg-open");

    command
        .arg(target)
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Reveals a workspace entry in the platform file manager. This is distinct
/// from `file_open`: a source file should be selected in Explorer, not opened
/// in the app associated with its extension.
#[tauri::command]
pub fn file_reveal(path: String) -> Result<(), String> {
    // Revealing is read-only, so the workspace root itself is a valid target
    // (the "Open Workspace" button opens the project folder in the file manager).
    let (_root, target) = resolve_workspace_existing_path(&path, true)?;

    #[cfg(target_os = "windows")]
    {
        let target_text = target.to_string_lossy();
        let explorer_target = if let Some(rest) = target_text.strip_prefix(r"\\?\UNC\") {
            PathBuf::from(format!(r"\\{rest}"))
        } else {
            target_text
                .strip_prefix(r"\\?\")
                .map(PathBuf::from)
                .unwrap_or_else(|| target.clone())
        };
        let mut command = crate::process::hidden_command("explorer.exe");
        if target.is_file() {
            command.arg(format!("/select,{}", explorer_target.display()));
        } else {
            command.arg(explorer_target);
        }
        return command
            .spawn()
            .map(|_| ())
            .map_err(|error| error.to_string());
    }

    #[cfg(target_os = "macos")]
    {
        let mut command = crate::process::hidden_command("open");
        if target.is_file() {
            command.arg("-R");
        }
        return command
            .arg(target)
            .spawn()
            .map(|_| ())
            .map_err(|error| error.to_string());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let directory = if target.is_dir() {
            target
        } else {
            target
                .parent()
                .ok_or_else(|| "file has no parent directory".to_string())?
                .to_path_buf()
        };
        let mut command = crate::process::hidden_command("xdg-open");
        return command
            .arg(directory)
            .spawn()
            .map(|_| ())
            .map_err(|error| error.to_string());
    }
}

fn file_list_dir_blocking(path: Option<String>) -> Result<Vec<FileTreeEntry>, String> {
    let root = workspace_root()?;
    let target = resolve_workspace_dir(path)?;
    let mut entries = Vec::new();

    for entry in std::fs::read_dir(target).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy().into_owned();
        if tools::layout::is_noisy_workspace_entry(&name) {
            continue;
        }
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if !file_type.is_dir() && !file_type.is_file() {
            continue;
        }
        let path = entry.path();
        entries.push(FileTreeEntry {
            name,
            path: display_workspace_path(&path, &root),
            is_dir: file_type.is_dir(),
        });
    }

    entries.sort_by(|left, right| {
        tools::layout::root_display_rank(&left.name)
            .cmp(&tools::layout::root_display_rank(&right.name))
            .then_with(|| right.is_dir.cmp(&left.is_dir))
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(entries)
}

/// Directory enumeration can touch a large number of filesystem entries. Keep
/// it off Tauri's command/UI thread so opening the editor remains responsive
/// while the tree is loading.
#[tauri::command]
pub async fn file_list_dir(path: Option<String>) -> Result<Vec<FileTreeEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || file_list_dir_blocking(path))
        .await
        .map_err(|error| error.to_string())?
}

/// Lists the LaTeX projects of the current workspace together with their
/// compilable root documents. A project is a first-level folder that holds at
/// least one `.tex` file, so chapter folders nested deeper stay inside their
/// parent project instead of splitting the library into one entry per
/// subfolder. Documents deliberately differ from `file_search("**/*.tex")`:
/// chapter and include files only raise their project's `.tex` count rather
/// than becoming a misleading second entry in the Typeset library.
fn typeset_list_documents_blocking() -> Result<TypesetLibrary, String> {
    let root = workspace_root()?;
    let mut scan = TypesetScan::default();
    collect_typeset_library(&root, &root, &mut scan)?;
    // The normal workspace walk intentionally hides `.somniq`, but the LaTeX
    // library must still list application-created root documents stored there.
    for directory in [
        tools::layout::papers_dir_at(&root),
        tools::layout::slides_dir_at(&root),
        tools::layout::poster_dir_at(&root),
        tools::layout::reports_dir_at(&root),
    ] {
        if directory.is_dir() {
            collect_typeset_library(&directory, &root, &mut scan)?;
        }
    }
    let TypesetScan {
        mut projects,
        mut documents,
        ..
    } = scan;
    documents.sort_by(|left, right| {
        right
            .modified_epoch_ms
            .cmp(&left.modified_epoch_ms)
            .then_with(|| left.title.to_lowercase().cmp(&right.title.to_lowercase()))
            .then_with(|| left.path.cmp(&right.path))
    });
    projects.sort_by(|left, right| {
        right
            .modified_epoch_ms
            .cmp(&left.modified_epoch_ms)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.path.cmp(&right.path))
    });
    Ok(TypesetLibrary {
        projects,
        documents,
    })
}

/// The LaTeX library walks the workspace and reads source headers. Run that
/// work on Tauri's blocking pool so a large project cannot stall the desktop
/// command/UI thread while the start page is being opened.
#[tauri::command]
pub async fn typeset_list_documents() -> Result<TypesetLibrary, String> {
    tauri::async_runtime::spawn_blocking(typeset_list_documents_blocking)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn file_read_text(path: String) -> Result<FileText, String> {
    let (root, target) = resolve_workspace_file(&path)?;
    let metadata = std::fs::metadata(&target).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_FILE_EDITOR_BYTES {
        return Err(format!(
            "file is too large for the Lab editor ({} bytes, limit {} bytes)",
            metadata.len(),
            MAX_FILE_EDITOR_BYTES
        ));
    }
    let bytes = std::fs::read(&target).map_err(|error| error.to_string())?;
    let content = decode_text_bytes(&bytes)?;
    Ok(FileText {
        path: display_workspace_path(&target, &root),
        content,
        bytes: metadata.len(),
        version: file_content_version(&bytes),
    })
}

#[tauri::command]
pub fn file_write_text(
    path: String,
    content: String,
    expected_version: Option<String>,
) -> Result<FileText, String> {
    if content.len() as u64 > MAX_FILE_EDITOR_BYTES {
        return Err(format!(
            "content is too large for the Lab editor ({} bytes, limit {} bytes)",
            content.len(),
            MAX_FILE_EDITOR_BYTES
        ));
    }
    let (root, target) = resolve_workspace_file(&path)?;
    let current_bytes = std::fs::read(&target).map_err(|error| error.to_string())?;
    let current_version = file_content_version(&current_bytes);
    if expected_version
        .as_deref()
        .filter(|version| !version.trim().is_empty())
        .is_some_and(|expected| expected != current_version)
    {
        return Err(format!(
            "FILE_CONFLICT: {} changed on disk after it was opened; reload it before saving",
            display_workspace_path(&target, &root)
        ));
    }
    runtime::write_file_atomically(&target, content.as_bytes())
        .map_err(|error| error.to_string())?;
    let bytes = std::fs::read(&target).map_err(|error| error.to_string())?;
    let content = decode_text_bytes(&bytes)?;
    Ok(FileText {
        path: display_workspace_path(&target, &root),
        content,
        bytes: bytes.len() as u64,
        version: file_content_version(&bytes),
    })
}

#[tauri::command]
pub fn file_create_text(path: String, content: String) -> Result<FileText, String> {
    if content.len() as u64 > MAX_FILE_EDITOR_BYTES {
        return Err(format!(
            "content is too large for the file editor ({} bytes, limit {} bytes)",
            content.len(),
            MAX_FILE_EDITOR_BYTES
        ));
    }
    let (root, target) = resolve_workspace_output_file(&path)?;
    if target.exists() {
        return Err(format!("file already exists: {}", target.display()));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    runtime::write_file_atomically(&target, content.as_bytes())
        .map_err(|error| error.to_string())?;
    let bytes = std::fs::read(&target).map_err(|error| error.to_string())?;
    let content = decode_text_bytes(&bytes)?;
    Ok(FileText {
        path: display_workspace_path(&target, &root),
        content,
        bytes: bytes.len() as u64,
        version: file_content_version(&bytes),
    })
}

#[tauri::command]
pub fn file_create_dir(path: String) -> Result<FileTreeEntry, String> {
    let (root, target) = resolve_workspace_output_path(&path, "directory")?;
    if target.exists() {
        return Err(format!("directory already exists: {}", target.display()));
    }
    std::fs::create_dir_all(&target).map_err(|error| error.to_string())?;
    file_tree_entry_from_path(&target, &root)
}

#[tauri::command]
pub fn file_rename(path: String, new_path: String) -> Result<FileTreeEntry, String> {
    let (root, source) = resolve_workspace_existing_path(&path, false)?;
    let (_root, target) = resolve_workspace_output_path(&new_path, "target")?;
    if source == target {
        return file_tree_entry_from_path(&source, &root);
    }
    if target.exists() {
        return Err(format!("target already exists: {}", target.display()));
    }
    if source.is_dir() && target.starts_with(&source) {
        return Err("cannot move a directory inside itself".to_string());
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::rename(&source, &target).map_err(|error| error.to_string())?;
    file_tree_entry_from_path(&target, &root)
}

#[tauri::command]
pub fn file_duplicate(path: String) -> Result<FileTreeEntry, String> {
    let (root, source) = resolve_workspace_existing_path(&path, false)?;
    let target = duplicate_target_path(&source)?;
    if source.is_dir() {
        copy_directory(&source, &target)?;
    } else {
        std::fs::copy(&source, &target).map_err(|error| error.to_string())?;
    }
    file_tree_entry_from_path(&target, &root)
}

fn duplicate_target_path(source: &Path) -> Result<PathBuf, String> {
    let parent = source
        .parent()
        .ok_or_else(|| "path has no parent directory".to_string())?;
    let file_name = source
        .file_name()
        .ok_or_else(|| "path has no file name".to_string())?;
    let (stem, extension) = if source.is_dir() {
        (file_name.to_string_lossy().into_owned(), String::new())
    } else {
        let stem = source
            .file_stem()
            .unwrap_or(file_name)
            .to_string_lossy()
            .into_owned();
        let extension = source
            .extension()
            .map(|value| format!(".{}", value.to_string_lossy()))
            .unwrap_or_default();
        (stem, extension)
    };

    for index in 1..=10_000 {
        let suffix = if index == 1 {
            " copy".to_string()
        } else {
            format!(" copy {index}")
        };
        let candidate = parent.join(format!("{stem}{suffix}{extension}"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("could not find an available name for the duplicated entry".to_string())
}

fn copy_directory(source: &Path, target: &Path) -> Result<(), String> {
    std::fs::create_dir(target).map_err(|error| error.to_string())?;
    for entry in std::fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_dir() {
            copy_directory(&source_path, &target_path)?;
        } else if file_type.is_file() {
            std::fs::copy(&source_path, &target_path).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn file_delete(path: String) -> Result<(), String> {
    let (_root, target) = resolve_workspace_existing_path(&path, false)?;
    let metadata = std::fs::metadata(&target).map_err(|error| error.to_string())?;
    if metadata.is_dir() {
        std::fs::remove_dir_all(&target).map_err(|error| error.to_string())
    } else {
        std::fs::remove_file(&target).map_err(|error| error.to_string())
    }
}

#[tauri::command]
pub fn file_read_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    let (_root, target) = resolve_workspace_file(&path)?;
    let metadata = std::fs::metadata(&target).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_FILE_BINARY_BYTES {
        return Err(format!(
            "file is too large to preview ({} bytes, limit {} bytes)",
            metadata.len(),
            MAX_FILE_BINARY_BYTES
        ));
    }
    std::fs::read(&target)
        .map(tauri::ipc::Response::new)
        .map_err(|error| error.to_string())
}

/// Metadata used by clients that can load binary files incrementally.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileBinaryInfo {
    pub bytes: u64,
}

#[tauri::command]
pub fn file_read_bytes_info(path: String) -> Result<FileBinaryInfo, String> {
    let (_root, target) = resolve_workspace_file(&path)?;
    let metadata = std::fs::metadata(&target).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err(format!("path is not a file: {}", target.display()));
    }
    Ok(FileBinaryInfo {
        bytes: metadata.len(),
    })
}

const MAX_FILE_BINARY_RANGE_BYTES: u64 = 8 * 1024 * 1024;

fn read_file_byte_range(target: &Path, begin: u64, end: u64) -> Result<Vec<u8>, String> {
    let metadata = std::fs::metadata(target).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err(format!("path is not a file: {}", target.display()));
    }
    if begin > end || end > metadata.len() {
        return Err(format!(
            "invalid byte range {begin}..{end} for a {} byte file",
            metadata.len()
        ));
    }
    let length = end - begin;
    if length > MAX_FILE_BINARY_RANGE_BYTES {
        return Err(format!(
            "byte range is too large ({length} bytes, limit {MAX_FILE_BINARY_RANGE_BYTES} bytes)"
        ));
    }

    let mut file = std::fs::File::open(target).map_err(|error| error.to_string())?;
    std::io::Seek::seek(&mut file, std::io::SeekFrom::Start(begin))
        .map_err(|error| error.to_string())?;
    let capacity = usize::try_from(length).map_err(|_| "byte range is too large".to_string())?;
    let mut bytes = Vec::with_capacity(capacity);
    std::io::Read::read_to_end(&mut std::io::Read::take(file, length), &mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 != length {
        return Err(format!(
            "file changed while reading byte range: expected {length} bytes, got {}",
            bytes.len()
        ));
    }
    Ok(bytes)
}

#[tauri::command]
pub fn file_read_bytes_range(
    path: String,
    begin: u64,
    end: u64,
) -> Result<tauri::ipc::Response, String> {
    let (_root, target) = resolve_workspace_file(&path)?;
    read_file_byte_range(&target, begin, end).map(tauri::ipc::Response::new)
}

/// Grant the current webview access to exactly one already validated workspace
/// file. The asset protocol then serves it with native streaming/range support,
/// which is important for large images that cannot be decoded from an IPC blob.
#[tauri::command]
pub fn file_asset_path(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let (_root, target) = resolve_workspace_file(&path)?;
    app.asset_protocol_scope()
        .allow_file(&target)
        .map_err(|error| error.to_string())?;
    Ok(target.to_string_lossy().into_owned())
}

#[cfg(test)]
mod text_decode_tests {
    use super::*;

    #[test]
    fn content_version_is_stable_and_changes_with_bytes() {
        assert_eq!(
            file_content_version(b"draft"),
            file_content_version(b"draft")
        );
        assert_ne!(
            file_content_version(b"draft"),
            file_content_version(b"external edit")
        );
        assert!(file_content_version(b"draft").starts_with("sha256:"));
    }

    #[test]
    fn repairs_common_utf8_as_gbk_mojibake() {
        assert_eq!(repair_utf8_mojibake("鎶曠寤鸿鎸囧崡"), "投稿建议指南");
    }

    #[test]
    fn keeps_normal_utf8_chinese_text() {
        assert_eq!(repair_utf8_mojibake("投稿建议指南"), "投稿建议指南");
    }

    #[test]
    fn decodes_gbk_text_bytes() {
        let (bytes, _, had_errors) = GBK.encode("中文 LaTeX");
        assert!(!had_errors);
        assert_eq!(decode_text_bytes(&bytes).expect("decode gbk"), "中文 LaTeX");
    }

    #[test]
    fn reads_only_the_requested_file_byte_range() {
        let path = std::env::temp_dir().join(format!(
            "somniq-byte-range-{}-{}.bin",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time")
                .as_nanos()
        ));
        let source: Vec<u8> = (0..=255).collect();
        std::fs::write(&path, &source).expect("write range fixture");

        assert_eq!(
            read_file_byte_range(&path, 17, 29).expect("read range"),
            source[17..29].to_vec()
        );
        assert!(read_file_byte_range(&path, 250, 257).is_err());

        let _ = std::fs::remove_file(path);
    }
}

/// Search files by glob pattern. Requires a non-empty query to avoid
/// scanning the whole tree. Returns up to 50 matching paths.
fn file_search_blocking(pattern: String, root: Option<String>) -> Result<Vec<String>, String> {
    if pattern.is_empty() {
        return Ok(vec![]);
    }
    let result = tools::execute_tool("glob_search", &json!({ "pattern": pattern, "path": root }))
        .map_err(|e| e.to_string())?;

    // GlobSearchOutput serialises as { "filenames": [...], "numFiles": N, ... }
    let v: serde_json::Value = serde_json::from_str(&result).map_err(|e| e.to_string())?;
    let paths = v["filenames"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .filter_map(|p| p.as_str().map(str::to_string))
        .take(50)
        .collect();
    Ok(paths)
}

/// Glob searches can enumerate an entire project. Keep this filesystem work
/// off the Tauri command/UI thread; Typeset uses it to populate path
/// completion after a source is opened.
#[tauri::command]
pub async fn file_search(pattern: String, root: Option<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || file_search_blocking(pattern, root))
        .await
        .map_err(|error| error.to_string())?
}

/// Read the first N lines of a text file or extracted PDF text.
#[tauri::command]
pub fn file_read(path: String, limit: Option<u32>) -> Result<String, String> {
    let lim = limit.unwrap_or(200);
    let result = tools::execute_tool("read_file", &json!({ "path": path, "limit": lim }))
        .map_err(|e| e.to_string())?;

    // ReadFileOutput serialises as { "type": "text", "file": { "content": "..." } }
    let v: serde_json::Value = serde_json::from_str(&result).map_err(|e| e.to_string())?;
    Ok(v["file"]["content"].as_str().unwrap_or("").to_string())
}

#[cfg(test)]
#[path = "tests/files.rs"]
mod tests;
