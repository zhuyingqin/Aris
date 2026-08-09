//! Capture files for `run_in_background` shell commands.
//!
//! Background processes used to get `Stdio::null()`, so a dev server that
//! failed to bind its port looked exactly like one that came up fine — which is
//! precisely why a model reaches for `npm run dev &` in the foreground instead.
//! Writing to a file under `.somniq/tmp/background/` keeps the start-up banner,
//! the port, and any crash readable with `read_file` while the service runs.

use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct BackgroundLog {
    path: PathBuf,
    file: File,
}

impl BackgroundLog {
    /// stdout handle for the child.
    pub fn stdout(&self) -> io::Result<Stdio> {
        Ok(Stdio::from(self.file.try_clone()?))
    }

    /// stderr handle for the child. A separate descriptor onto the same file so
    /// both streams interleave in the order the service printed them.
    pub fn stderr(&self) -> io::Result<Stdio> {
        Ok(Stdio::from(self.file.try_clone()?))
    }

    #[must_use]
    pub fn display(&self) -> String {
        self.path.display().to_string().replace('\\', "/")
    }
}

/// Create the capture file for `command`. Returns `None` when the workspace is
/// not writable — the command still runs, it just runs without a log.
#[must_use]
pub fn create(cwd: &Path, command: &str) -> Option<BackgroundLog> {
    let directory = cwd.join(".somniq").join("tmp").join("background");
    std::fs::create_dir_all(&directory).ok()?;
    let path = directory.join(file_name(command));
    let file = File::create(&path).ok()?;
    Some(BackgroundLog { path, file })
}

fn file_name(command: &str) -> String {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis());
    format!("{stamp}-{}.log", slug(command))
}

/// A short, filesystem-safe hint of what is running, so a directory listing is
/// readable without opening every file.
fn slug(command: &str) -> String {
    const MAX: usize = 40;
    let mut slug = String::new();
    let mut last_was_dash = false;
    for character in command.chars() {
        if slug.chars().count() >= MAX {
            break;
        }
        if character.is_ascii_alphanumeric() {
            slug.push(character.to_ascii_lowercase());
            last_was_dash = false;
        } else if !last_was_dash && !slug.is_empty() {
            slug.push('-');
            last_was_dash = true;
        }
    }
    let trimmed = slug.trim_matches('-');
    if trimmed.is_empty() {
        String::from("command")
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
#[path = "tests/background_log.rs"]
mod tests;
