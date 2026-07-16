use std::path::{Path, PathBuf};

use encoding_rs::{GB18030, GBK};
use serde::Serialize;
use serde_json::json;

const MAX_FILE_EDITOR_BYTES: u64 = 2 * 1024 * 1024;
const MAX_FILE_BINARY_BYTES: u64 = 40 * 1024 * 1024;

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

fn resolve_open_path(path: &str) -> Result<PathBuf, String> {
    let raw = path.trim().trim_matches(|ch| matches!(ch, '`' | '<' | '>'));
    if raw.is_empty() {
        return Err("file path is empty".to_string());
    }

    let resolve = |candidate: &str| {
        let path = Path::new(candidate);
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            crate::state::workspace_dir().join(path)
        }
    };
    let direct = resolve(raw);
    let target = if direct.exists() {
        direct
    } else {
        resolve(strip_location_suffix(raw))
    };
    if !target.exists() {
        return Err(format!("file does not exist: {}", target.display()));
    }
    target.canonicalize().map_err(|error| error.to_string())
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

fn resolve_workspace_existing_path(path: &str) -> Result<(PathBuf, PathBuf), String> {
    let root = workspace_root()?;
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
    if !target.starts_with(&root) {
        return Err("path is outside the current workspace".to_string());
    }
    if target == root {
        return Err("operation is not allowed on the workspace root".to_string());
    }
    let metadata = std::fs::metadata(&target).map_err(|error| error.to_string())?;
    if !metadata.is_dir() && !metadata.is_file() {
        return Err(format!(
            "path is not a file or directory: {}",
            target.display()
        ));
    }
    Ok((root, target))
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
    let (_root, target) = resolve_workspace_existing_path(&path)?;

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

#[tauri::command]
pub fn file_list_dir(path: Option<String>) -> Result<Vec<FileTreeEntry>, String> {
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
    })
}

#[tauri::command]
pub fn file_write_text(path: String, content: String) -> Result<FileText, String> {
    if content.len() as u64 > MAX_FILE_EDITOR_BYTES {
        return Err(format!(
            "content is too large for the Lab editor ({} bytes, limit {} bytes)",
            content.len(),
            MAX_FILE_EDITOR_BYTES
        ));
    }
    let (root, target) = resolve_workspace_file(&path)?;
    std::fs::write(&target, content).map_err(|error| error.to_string())?;
    let content = std::fs::read_to_string(&target).map_err(|error| error.to_string())?;
    let bytes = std::fs::metadata(&target)
        .map_err(|error| error.to_string())?
        .len();
    Ok(FileText {
        path: display_workspace_path(&target, &root),
        content,
        bytes,
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
    std::fs::write(&target, content).map_err(|error| error.to_string())?;
    let metadata = std::fs::metadata(&target).map_err(|error| error.to_string())?;
    let content = std::fs::read_to_string(&target).map_err(|error| error.to_string())?;
    Ok(FileText {
        path: display_workspace_path(&target, &root),
        content,
        bytes: metadata.len(),
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
    let (root, source) = resolve_workspace_existing_path(&path)?;
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
    let (root, source) = resolve_workspace_existing_path(&path)?;
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
    let (_root, target) = resolve_workspace_existing_path(&path)?;
    let metadata = std::fs::metadata(&target).map_err(|error| error.to_string())?;
    if metadata.is_dir() {
        std::fs::remove_dir_all(&target).map_err(|error| error.to_string())
    } else {
        std::fs::remove_file(&target).map_err(|error| error.to_string())
    }
}

#[tauri::command]
pub fn file_read_bytes(path: String) -> Result<Vec<u8>, String> {
    let (_root, target) = resolve_workspace_file(&path)?;
    let metadata = std::fs::metadata(&target).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_FILE_BINARY_BYTES {
        return Err(format!(
            "file is too large to preview ({} bytes, limit {} bytes)",
            metadata.len(),
            MAX_FILE_BINARY_BYTES
        ));
    }
    std::fs::read(&target).map_err(|error| error.to_string())
}

#[cfg(test)]
mod text_decode_tests {
    use super::*;

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
}

/// Search files by glob pattern. Requires a non-empty query to avoid
/// scanning the whole tree. Returns up to 50 matching paths.
#[tauri::command]
pub fn file_search(pattern: String, root: Option<String>) -> Result<Vec<String>, String> {
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

#[tauri::command]
pub fn project_chat_starters() -> Vec<String> {
    let root = crate::state::workspace_dir();
    let mut starters = vec![
        "Explain this project's architecture and key modules.".to_string(),
        "Inspect the current project and identify the highest-risk issues.".to_string(),
    ];
    if root.join("package.json").exists() && root.join("Cargo.toml").exists() {
        starters.push("Run the frontend and Rust tests, then fix any failures.".to_string());
    } else if root.join("package.json").exists() {
        starters.push("Run the project tests and fix any failures.".to_string());
    } else if root.join("Cargo.toml").exists() {
        starters.push("Run the Rust test suite and fix any failures.".to_string());
    } else {
        starters
            .push("Find the project's test commands, run them, and fix any failures.".to_string());
    }
    starters
}

#[cfg(test)]
#[path = "tests/files.rs"]
mod tests;
