use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::{home_dir, knowledge_memory_dir};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct KnowledgeMemoryEntry {
    pub name: String,
    pub description: String,
    pub path: PathBuf,
}

/// Maximum number of knowledge-memory entries listed inline in the system
/// prompt. The catalog is an on-demand index, not content; capping it keeps the
/// cached system-prompt prefix bounded as `memories/` grows. Entries are
/// name-sorted, so the cut is deterministic (cache-friendly), and `read_file`
/// still reaches anything past the cap.
const KNOWLEDGE_CATALOG_LIMIT: usize = 40;

/// Upper bound on lines scanned while streaming a note's frontmatter head. The
/// frontmatter is a tiny `---...---` block, so this only needs to be large
/// enough for a generous header; it also stops an unterminated fence from
/// pulling us through the whole body of a large note.
const MAX_FRONTMATTER_LINES: usize = 256;

#[must_use]
pub fn load_knowledge_memory_catalog() -> Vec<KnowledgeMemoryEntry> {
    let dir = knowledge_memory_dir();
    if !dir.exists() {
        return Vec::new();
    }
    let Ok(read_dir) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut entries = read_dir
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink())
                || path.extension().is_none_or(|extension| extension != "md")
            {
                return None;
            }
            let (name, description) = read_frontmatter(&path).ok()?;
            Some(KnowledgeMemoryEntry {
                name: name.unwrap_or_else(|| {
                    path.file_stem()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string()
                }),
                description: description.unwrap_or_default(),
                path,
            })
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| left.name.cmp(&right.name));
    entries
}

#[must_use]
pub fn render_knowledge_memory_prompt() -> String {
    let entries = load_knowledge_memory_catalog();
    let dir = knowledge_memory_dir();
    render_knowledge_catalog(&entries, &dir)
}

fn render_knowledge_catalog(entries: &[KnowledgeMemoryEntry], dir: &Path) -> String {
    if entries.is_empty() {
        return format!(
            "# ARIS Knowledge Memory\n\
             Long-form reference notes belong in `{}` as individual Markdown files. \
             This store is loaded on demand with read_file; do not use it for user preferences or short stable facts.",
            dir.display()
        );
    }
    let total = entries.len();
    let catalog = entries
        .iter()
        .take(KNOWLEDGE_CATALOG_LIMIT)
        .map(|entry| {
            let description = if entry.description.is_empty() {
                String::new()
            } else {
                format!(" - {}", sanitize(&entry.description, 120))
            };
            format!(
                "- {}{}: `{}`",
                sanitize(&entry.name, 60),
                description,
                entry.path.display()
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let overflow = if total > KNOWLEDGE_CATALOG_LIMIT {
        format!(
            "\n- …and {} more reference notes in `{}`; list that directory and read_file to load them on demand.",
            total - KNOWLEDGE_CATALOG_LIMIT,
            dir.display()
        )
    } else {
        String::new()
    };
    format!(
        "# ARIS Knowledge Memory\n\
         These are long-form reference notes. Load a relevant file on demand with read_file. \
         Stable facts/preferences belong in the `memory` tool; task history belongs in `session_search`.\n\n{catalog}{overflow}"
    )
}

pub fn migrate_legacy_knowledge_memory() {
    let legacy_path = PathBuf::from(home_dir())
        .join(".config")
        .join("aris")
        .join("memory.md");
    if !legacy_path.exists() {
        return;
    }
    let Ok(content) = fs::read_to_string(&legacy_path) else {
        return;
    };
    if content.trim().is_empty() {
        return;
    }
    let dir = knowledge_memory_dir();
    let target = dir.join("legacy.md");
    if target.exists() || fs::create_dir_all(&dir).is_err() {
        return;
    }
    let migrated = format!(
        "---\nname: Legacy Memory\ndescription: Migrated from memory.md\n---\n\n{}",
        content.trim()
    );
    let _ = fs::write(target, migrated);
}

/// Read just the frontmatter head of a note instead of `read_to_string`-ing the
/// whole (possibly large) file on every catalog rebuild. Streams line by line
/// via `BufReader` and stops at the closing `---` fence, so the body is never
/// touched; an unterminated fence is bounded by `MAX_FRONTMATTER_LINES`. Reading
/// line by line (rather than a fixed byte prefix) also avoids splitting a
/// multi-byte UTF-8 character — e.g. a CJK `description:` — mid-read.
fn read_frontmatter(path: &Path) -> std::io::Result<(Option<String>, Option<String>)> {
    let file = fs::File::open(path)?;
    let mut reader = BufReader::new(file);
    let mut head = String::new();
    let mut line = String::new();
    let mut fences = 0u8;
    for _ in 0..MAX_FRONTMATTER_LINES {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            break; // EOF
        }
        head.push_str(&line);
        if line.trim() == "---" {
            fences += 1;
            if fences == 2 {
                break; // closing fence — never read the body
            }
        } else if fences == 0 {
            break; // first line isn't a fence — no frontmatter
        }
    }
    Ok(parse_frontmatter(&head))
}

fn parse_frontmatter(content: &str) -> (Option<String>, Option<String>) {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        return (None, None);
    }
    let rest = trimmed[3..].trim_start_matches('\n');
    let Some(end) = rest.find("\n---") else {
        return (None, None);
    };
    let mut name = None;
    let mut description = None;
    for line in rest[..end].lines() {
        if let Some(value) = line.strip_prefix("name:") {
            name = Some(value.trim().to_string());
        } else if let Some(value) = line.strip_prefix("description:") {
            description = Some(value.trim().to_string());
        }
    }
    (name, description)
}

fn sanitize(value: &str, limit: usize) -> String {
    value
        .chars()
        .filter(|character| !character.is_control() || *character == '\n')
        .take(limit)
        .collect::<String>()
        .replace('\n', " ")
}

#[cfg(test)]
#[path = "tests/knowledge_memory.rs"]
mod tests;
