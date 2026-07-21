//! Skill discovery: search roots plus filesystem and bundled skill lookup.
//! Extracted from main.rs (Phase 1 decomposition); behavior unchanged.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Extract the `description:` field from a SKILL.md YAML frontmatter.
fn parse_skill_description(content: &str) -> Option<String> {
    let inner = content.strip_prefix("---")?.trim_start_matches('\n');
    let end = inner.find("\n---")?;
    let frontmatter = &inner[..end];
    for line in frontmatter.lines() {
        if let Some(rest) = line.strip_prefix("description:") {
            return Some(rest.trim().to_string());
        }
    }
    None
}

/// ARIS-specific skills directory (highest priority).
pub(crate) fn dirs_aris_skills() -> PathBuf {
    runtime::aris_user_skills_dir()
}

/// ARIS project-specific skills directory.
fn dirs_project_aris_skills() -> Option<PathBuf> {
    env::current_dir()
        .ok()
        .map(|cwd| runtime::aris_project_skills_dir(&cwd))
}

/// Legacy Claude Code user skills directory.
fn dirs_claude_skills() -> PathBuf {
    runtime::claude_user_skills_dir()
}

/// All skill search directories in priority order.
pub(crate) fn skill_search_dirs() -> Vec<PathBuf> {
    skill_search_dirs_with_sources()
        .into_iter()
        .map(|(dir, _)| dir)
        .collect()
}

/// All skill search directories with display source labels.
fn skill_search_dirs_with_sources() -> Vec<(PathBuf, &'static str)> {
    let mut dirs = vec![(dirs_aris_skills(), "aris")];
    if let Some(project_dir) = dirs_project_aris_skills() {
        dirs.push((project_dir, "project"));
    }
    if runtime::legacy_claude_skills_enabled() {
        dirs.push((dirs_claude_skills(), "compat"));
        if let Ok(cwd) = env::current_dir() {
            dirs.push((runtime::claude_project_skills_dir(&cwd), "compat"));
        }
    }
    dirs
}

pub(crate) fn count_filesystem_skills(dir: &Path) -> usize {
    fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter(|entry| entry.path().join("SKILL.md").exists())
                .count()
        })
        .unwrap_or(0)
}

/// Find skill content by name, checking all sources in priority order.
pub(crate) fn find_skill_content(name: &str) -> Option<String> {
    // Check filesystem dirs first (ARIS user > ARIS project > explicit compat)
    for dir in skill_search_dirs() {
        let path = dir.join(name).join("SKILL.md");
        if let Ok(content) = fs::read_to_string(&path) {
            return Some(content);
        }
    }
    // Fallback to bundled
    runtime::BUNDLED_SKILLS
        .iter()
        .find(|(n, _)| n.eq_ignore_ascii_case(name))
        .map(|(_, content)| (*content).to_string())
}

pub(crate) fn which_codex() -> Option<PathBuf> {
    let output = Command::new("which").arg("codex").output().ok()?;
    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if path.is_empty() {
            None
        } else {
            Some(PathBuf::from(path))
        }
    } else {
        None
    }
}

/// Check if a name matches a known skill in any search root.
pub(crate) fn is_known_skill(name: &str) -> bool {
    for dir in skill_search_dirs() {
        if dir.join(name).join("SKILL.md").exists() {
            return true;
        }
    }
    runtime::BUNDLED_SKILLS
        .iter()
        .any(|(skill_name, _)| skill_name.eq_ignore_ascii_case(name))
}

/// Discover all skills with source info: (name, description, source_label).
pub(crate) fn discover_all_skills() -> Vec<(String, String, &'static str)> {
    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::new();

    // Filesystem skills.
    for (dir, source) in skill_search_dirs_with_sources() {
        let Ok(entries) = fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let skill_md = entry.path().join("SKILL.md");
            if !skill_md.exists() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if seen.insert(name.clone()) {
                let desc = fs::read_to_string(&skill_md)
                    .ok()
                    .and_then(|c| parse_skill_description(&c))
                    .unwrap_or_default();
                result.push((name, desc, source));
            }
        }
    }

    // Bundled skills
    for (name, content) in runtime::BUNDLED_SKILLS {
        let name = (*name).to_string();
        if seen.insert(name.clone()) {
            let desc = parse_skill_description(content).unwrap_or_default();
            result.push((name, desc, "bundled"));
        }
    }

    result.sort_by(|a, b| a.0.cmp(&b.0));
    result
}
