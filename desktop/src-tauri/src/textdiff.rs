//! Text diff and three-way merge, computed by Git.
//!
//! The desktop used to carry its own Myers implementation for this. It was
//! correct for small edits and quietly wrong for large ones: past an edit
//! distance of 800 it abandoned the search and reported "every old line
//! removed, every new line added". That shape is indistinguishable from a real
//! rewrite, so the three-way merge built on it collapsed every local edit and
//! every incoming edit into one conflict group whose only resolutions were
//! "take all of theirs" or "take all of mine" — a rewrite of one chapter could
//! silently discard the author's unrelated work in another part of the file.
//!
//! Git already solves this, and two of its commands need no repository at all:
//! `diff --no-index` compares two loose files and `merge-file` merges three.
//! Neither reads or writes an index, so nothing here can disturb the user's
//! staging area, HEAD, or history — which is what made adopting Git safe for
//! projects that are not repositories, and for those that are.
//!
//! The `.tex` hunk headers come from Git's built-in `tex` userdiff driver, via
//! the attributes file in [`crate::git::tex_attributes_file`].

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Beyond this, a "diff" is not review material — it is a rewrite. The old
/// implementation crossed a similar threshold and lied about what it found;
/// this one says so, because a reviewer who is shown 40,000 synthetic hunks
/// learns to click Accept without reading.
const MAX_REVIEWABLE_CHANGED_LINES: usize = 20_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffLineKind {
    Context,
    Added,
    Removed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: DiffLineKind,
    pub text: String,
    pub old_line: Option<usize>,
    pub new_line: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub old_start: usize,
    /// Number of old-side lines in the Git range. A zero-length range uses
    /// `old_start` as an insertion boundary, not a one-based line number.
    pub old_lines: usize,
    pub new_start: usize,
    /// Number of new-side lines in the Git range. See [`DiffHunk::old_lines`].
    pub new_lines: usize,
    /// The enclosing `\section{...}` (or equivalent) Git attributes it to.
    /// Empty when the driver could not name one.
    pub header: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextDiff {
    pub added: usize,
    pub removed: usize,
    pub hunks: Vec<DiffHunk>,
    /// Physical text-line counts as understood by Git. A trailing line
    /// terminator does not create an extra empty line.
    pub before_line_count: usize,
    pub after_line_count: usize,
    /// Git reports a missing final newline as hunk metadata. Preserve the
    /// underlying fact so accepting an EOF-only change can reproduce bytes
    /// rather than replacing an identical-looking line with itself.
    pub before_ends_with_newline: bool,
    pub after_ends_with_newline: bool,
    /// Set when the change is too large to present as reviewable hunks. The
    /// caller must say so rather than render a synthetic whole-file
    /// replacement — see [`MAX_REVIEWABLE_CHANGED_LINES`].
    pub too_large_to_chunk: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    /// The merged text. On conflict this carries Git's `<<<<<<<` markers, and
    /// the caller decides whether to present or reject it.
    pub content: String,
    pub conflicts: usize,
    pub clean: bool,
}

/// A scratch directory that removes itself.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Result<Self, String> {
        let base = std::env::temp_dir().join(format!(
            "somniq-textdiff-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or_default()
        ));
        std::fs::create_dir_all(&base)
            .map_err(|error| format!("could not create a scratch directory: {error}"))?;
        let scratch = Self(base);
        // The attributes travel with the comparison rather than being read from
        // the config directory. That directory is derived from environment the
        // process can change at runtime, which made the `tex` driver — and so
        // every section-labelled hunk header — silently depend on whatever had
        // last touched it.
        std::fs::write(scratch.attributes_path(), crate::git::TEX_DIFF_ATTRIBUTES)
            .map_err(|error| format!("could not stage diff attributes: {error}"))?;
        Ok(scratch)
    }

    fn attributes_path(&self) -> PathBuf {
        self.0.join("somniq.gitattributes")
    }

    /// Write one side of the comparison, keeping the caller's extension so the
    /// `tex` userdiff driver matches and hunk headers carry section names.
    fn write(&self, name: &str, extension: &str, content: &str) -> Result<PathBuf, String> {
        let file = if extension.is_empty() {
            self.0.join(name)
        } else {
            self.0.join(format!("{name}.{extension}"))
        };
        std::fs::write(&file, content.as_bytes())
            .map_err(|error| format!("could not stage text for comparison: {error}"))?;
        Ok(file)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn extension_of(path_hint: &str) -> String {
    Path::new(path_hint)
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| value.chars().all(|c| c.is_ascii_alphanumeric()))
        .unwrap_or("tex")
        .to_string()
}

/// Compare two texts with `git diff --no-index`.
///
/// Returns `Err` when Git is unavailable so the caller can fall back; a
/// difference is a normal result, not an error, even though Git exits 1 for it.
pub fn text_diff(
    before: &str,
    after: &str,
    path_hint: &str,
    context_lines: usize,
) -> Result<TextDiff, String> {
    if before == after {
        return Ok(TextDiff {
            added: 0,
            removed: 0,
            hunks: Vec::new(),
            before_line_count: text_line_count(before),
            after_line_count: text_line_count(after),
            before_ends_with_newline: before.ends_with('\n'),
            after_ends_with_newline: after.ends_with('\n'),
            too_large_to_chunk: false,
        });
    }
    let scratch = Scratch::new()?;
    let extension = extension_of(path_hint);
    let old_path = scratch.write("before", &extension, before)?;
    let new_path = scratch.write("after", &extension, after)?;

    let output = crate::git::diff_command(&scratch.0)
        // Compare the supplied bytes, independent of the user's checkout
        // conversion policy (notably core.autocrlf=true on Windows).
        .args(["-c", "core.autocrlf=false", "-c", "core.safecrlf=false"])
        .args([
            "-c",
            &format!(
                "core.attributesFile={}",
                scratch.attributes_path().display()
            ),
        ])
        .args([
            "diff",
            "--no-index",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            &format!("-U{context_lines}"),
        ])
        .arg(&old_path)
        .arg(&new_path)
        .output()
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => "Git is not available on PATH".to_string(),
            _ => format!("could not run Git: {error}"),
        })?;

    // 0 = identical, 1 = differences. Anything else is a real failure.
    match output.status.code() {
        Some(0 | 1) => {}
        _ => {
            return Err(format!(
                "git diff failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ))
        }
    }
    Ok(parse_unified_diff(
        &String::from_utf8_lossy(&output.stdout),
        before,
        after,
    ))
}

/// Merge `local` and `incoming` over their common `base`.
///
/// `git merge-file` takes three loose files and touches no repository state.
/// Its exit code is the number of conflicts, so a conflicted merge still
/// returns content — with markers — rather than failing.
pub fn three_way_merge(
    base: &str,
    local: &str,
    incoming: &str,
    path_hint: &str,
) -> Result<MergeResult, String> {
    let scratch = Scratch::new()?;
    let extension = extension_of(path_hint);
    let base_path = scratch.write("base", &extension, base)?;
    let local_path = scratch.write("local", &extension, local)?;
    let incoming_path = scratch.write("incoming", &extension, incoming)?;

    let output = crate::git::diff_command(&scratch.0)
        .args([
            "-c",
            &format!(
                "core.attributesFile={}",
                scratch.attributes_path().display()
            ),
        ])
        .args(["merge-file", "-p", "--diff3"])
        .args(["-L", "your changes", "-L", "before", "-L", "incoming"])
        .arg(&local_path)
        .arg(&base_path)
        .arg(&incoming_path)
        .output()
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => "Git is not available on PATH".to_string(),
            _ => format!("could not run Git: {error}"),
        })?;

    let code = output.status.code().unwrap_or(-1);
    if code < 0 {
        return Err(format!(
            "git merge-file failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(MergeResult {
        content: String::from_utf8_lossy(&output.stdout).into_owned(),
        conflicts: usize::try_from(code).unwrap_or(0),
        clean: code == 0,
    })
}

fn text_line_count(content: &str) -> usize {
    content.lines().count()
}

impl TextDiff {
    /// Render the same parsed hunks for Chat's patch view. Stats and the patch
    /// now share the exact comparison used by Typeset, including EOF metadata.
    pub fn unified_patch(&self, path: &str, before_exists: bool, after_exists: bool) -> String {
        if self.hunks.is_empty() {
            return String::new();
        }
        let mut output = format!(
            "--- {}\n+++ {}\n",
            if before_exists { path } else { "/dev/null" },
            if after_exists { path } else { "/dev/null" },
        );
        for hunk in &self.hunks {
            output.push_str(&format!(
                "@@ -{},{} +{},{} @@{}\n",
                hunk.old_start, hunk.old_lines, hunk.new_start, hunk.new_lines,
                if hunk.header.is_empty() { String::new() } else { format!(" {}", hunk.header) },
            ));
            for line in &hunk.lines {
                output.push(match line.kind {
                    DiffLineKind::Added => '+',
                    DiffLineKind::Removed => '-',
                    DiffLineKind::Context => ' ',
                });
                output.push_str(&line.text);
                output.push('\n');
                if (!self.before_ends_with_newline && line.old_line == Some(self.before_line_count))
                    || (!self.after_ends_with_newline && line.new_line == Some(self.after_line_count))
                {
                    output.push_str("\\ No newline at end of file\n");
                }
            }
        }
        output
    }
}

fn parse_unified_diff(raw: &str, before: &str, after: &str) -> TextDiff {
    let mut hunks: Vec<DiffHunk> = Vec::new();
    let mut added = 0usize;
    let mut removed = 0usize;
    let mut old_line = 0usize;
    let mut new_line = 0usize;

    // `.lines()` strips a CR before LF, which would lose actual CRLF content
    // from the changed text. Only remove Git's transport LF here.
    for line in raw.split_terminator('\n') {
        if let Some(rest) = line.strip_prefix("@@ ") {
            if let Some((old_start, old_lines, new_start, new_lines, header)) =
                parse_hunk_header(rest)
            {
                old_line = old_start;
                new_line = new_start;
                hunks.push(DiffHunk {
                    old_start,
                    old_lines,
                    new_start,
                    new_lines,
                    header,
                    lines: Vec::new(),
                });
            }
            continue;
        }
        let Some(hunk) = hunks.last_mut() else {
            continue;
        };
        // `\ No newline at end of file` is metadata, not content.
        if line.starts_with('\\') {
            continue;
        }
        let (kind, text) = match line.split_at_checked(1) {
            Some(("+", text)) => (DiffLineKind::Added, text),
            Some(("-", text)) => (DiffLineKind::Removed, text),
            Some((" ", text)) => (DiffLineKind::Context, text),
            // An empty line inside a hunk is an unchanged empty line: git emits
            // it as a bare space that some transports trim to nothing.
            None if line.is_empty() => (DiffLineKind::Context, ""),
            _ => continue,
        };
        match kind {
            DiffLineKind::Added => {
                added += 1;
                hunk.lines.push(DiffLine {
                    kind,
                    text: text.to_string(),
                    old_line: None,
                    new_line: Some(new_line),
                });
                new_line += 1;
            }
            DiffLineKind::Removed => {
                removed += 1;
                hunk.lines.push(DiffLine {
                    kind,
                    text: text.to_string(),
                    old_line: Some(old_line),
                    new_line: None,
                });
                old_line += 1;
            }
            DiffLineKind::Context => {
                hunk.lines.push(DiffLine {
                    kind,
                    text: text.to_string(),
                    old_line: Some(old_line),
                    new_line: Some(new_line),
                });
                old_line += 1;
                new_line += 1;
            }
        }
    }

    let too_large_to_chunk = added + removed > MAX_REVIEWABLE_CHANGED_LINES;
    TextDiff {
        added,
        removed,
        hunks: if too_large_to_chunk {
            Vec::new()
        } else {
            hunks
        },
        before_line_count: text_line_count(before),
        after_line_count: text_line_count(after),
        before_ends_with_newline: before.ends_with('\n'),
        after_ends_with_newline: after.ends_with('\n'),
        too_large_to_chunk,
    }
}

/// `-1,4 +1,6 @@ \section{Alpha}` → `(1, 4, 1, 6, "\section{Alpha}")`.
fn parse_hunk_header(rest: &str) -> Option<(usize, usize, usize, usize, String)> {
    let (ranges, header) = rest.split_once("@@")?;
    let mut parts = ranges.split_whitespace();
    let old = parts.next()?.strip_prefix('-')?;
    let new = parts.next()?.strip_prefix('+')?;
    let parse_range = |range: &str| -> Option<(usize, usize)> {
        let mut values = range.splitn(2, ',');
        let start = values.next()?.parse::<usize>().ok()?;
        let lines = values
            .next()
            .map(str::parse::<usize>)
            .transpose()
            .ok()?
            .unwrap_or(1);
        Some((start, lines))
    };
    let (old_start, old_lines) = parse_range(old)?;
    let (new_start, new_lines) = parse_range(new)?;
    // Git uses a zero start for a pure insertion/deletion at the beginning of
    // a file (`-0,0 +1,3` or `-1,3 +0,0`). Preserve it: clamping to one shifts
    // hunk metadata and makes a BOF marker point at the wrong source line.
    Some((
        old_start,
        old_lines,
        new_start,
        new_lines,
        header.trim().to_string(),
    ))
}

#[tauri::command]
pub async fn text_diff_lines(
    before: String,
    after: String,
    path_hint: String,
    context_lines: Option<usize>,
) -> Result<TextDiff, String> {
    crate::blocking::off_main_thread(move || {
        text_diff(&before, &after, &path_hint, context_lines.unwrap_or(3))
    })
    .await
}

#[tauri::command]
pub async fn text_three_way_merge(
    base: String,
    local: String,
    incoming: String,
    path_hint: String,
) -> Result<MergeResult, String> {
    crate::blocking::off_main_thread(move || three_way_merge(&base, &local, &incoming, &path_hint))
        .await
}

#[cfg(test)]
#[path = "tests/textdiff.rs"]
mod tests;
