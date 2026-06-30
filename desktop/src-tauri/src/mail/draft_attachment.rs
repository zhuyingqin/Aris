//! Resolve local draft attachment paths into bounded in-memory payloads.

use std::path::{Path, PathBuf};

use super::model::{MailDraft, MailDraftAttachment};

const MAX_ATTACHMENT_BYTES: u64 = 20 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES: u64 = 25 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct ResolvedDraftAttachment {
    pub filename: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

pub fn resolve_all(draft: &MailDraft) -> Result<Vec<ResolvedDraftAttachment>, String> {
    let mut total = 0_u64;
    let mut resolved = Vec::new();
    for attachment in &draft.attachments {
        let item = resolve_one(attachment)?;
        total = total
            .checked_add(item.bytes.len() as u64)
            .ok_or_else(|| "mail attachments are too large".to_string())?;
        if total > MAX_TOTAL_ATTACHMENT_BYTES {
            return Err(format!(
                "mail attachments exceed {} MB total limit",
                MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024
            ));
        }
        resolved.push(item);
    }
    Ok(resolved)
}

fn resolve_one(attachment: &MailDraftAttachment) -> Result<ResolvedDraftAttachment, String> {
    let path = resolve_path(&attachment.path)?;
    let metadata = std::fs::metadata(&path)
        .map_err(|error| format!("could not read attachment {}: {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("attachment is not a file: {}", path.display()));
    }
    if metadata.len() > MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "attachment {} exceeds {} MB limit",
            path.display(),
            MAX_ATTACHMENT_BYTES / 1024 / 1024
        ));
    }
    let bytes = std::fs::read(&path)
        .map_err(|error| format!("could not read attachment {}: {error}", path.display()))?;
    let filename = if attachment.filename.trim().is_empty() {
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("attachment.bin")
            .to_string()
    } else {
        attachment.filename.trim().to_string()
    };
    let filename = safe_filename(&filename);
    let mime_type = if attachment.mime_type.trim().is_empty() {
        guess_mime_type(&filename)
    } else {
        attachment.mime_type.trim().to_string()
    };
    Ok(ResolvedDraftAttachment {
        filename,
        mime_type,
        bytes,
    })
}

fn resolve_path(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("attachment path is required".to_string());
    }
    let path = PathBuf::from(trimmed);
    if path.is_absolute() {
        Ok(path)
    } else {
        std::env::current_dir()
            .map_err(|error| error.to_string())
            .map(|cwd| cwd.join(path))
    }
}

pub fn safe_filename(value: &str) -> String {
    let filename = Path::new(value)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("attachment.bin")
        .trim();
    let cleaned = filename
        .chars()
        .map(|ch| match ch {
            '\r' | '\n' | '"' | '\\' => '_',
            _ => ch,
        })
        .collect::<String>();
    let cleaned = cleaned.trim_matches(['.', ' ']).trim();
    if cleaned.is_empty() {
        "attachment.bin".to_string()
    } else {
        cleaned.to_string()
    }
}

fn guess_mime_type(filename: &str) -> String {
    let lower = filename.to_ascii_lowercase();
    let mime = if lower.ends_with(".pdf") {
        "application/pdf"
    } else if lower.ends_with(".txt") {
        "text/plain"
    } else if lower.ends_with(".md") || lower.ends_with(".markdown") {
        "text/markdown"
    } else if lower.ends_with(".csv") {
        "text/csv"
    } else if lower.ends_with(".json") {
        "application/json"
    } else if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".docx") {
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    } else if lower.ends_with(".xlsx") {
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    } else {
        "application/octet-stream"
    };
    mime.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_filename_strips_paths_and_header_breaks() {
        assert_eq!(safe_filename("../paper.pdf"), "paper.pdf");
        assert_eq!(safe_filename("bad\r\nname.pdf"), "bad__name.pdf");
        assert_eq!(safe_filename("  "), "attachment.bin");
    }
}
