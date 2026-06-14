use std::fs;
use std::path::PathBuf;

use serde::Serialize;

use crate::{home_dir, knowledge_memory_dir};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct KnowledgeMemoryEntry {
    pub name: String,
    pub description: String,
    pub path: PathBuf,
}

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
            let content = fs::read_to_string(&path).ok()?;
            let (name, description) = parse_frontmatter(&content);
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

pub fn render_knowledge_memory_prompt() -> String {
    let entries = load_knowledge_memory_catalog();
    let dir = knowledge_memory_dir();
    if entries.is_empty() {
        return format!(
            "# ARIS Knowledge Memory\n\
             Long-form reference notes belong in `{}` as individual Markdown files. \
             This store is loaded on demand with read_file; do not use it for user preferences or short stable facts.",
            dir.display()
        );
    }
    let catalog = entries
        .iter()
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
    format!(
        "# ARIS Knowledge Memory\n\
         These are long-form reference notes. Load a relevant file on demand with read_file. \
         Stable facts/preferences belong in the `memory` tool; task history belongs in `session_search`.\n\n{catalog}"
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
