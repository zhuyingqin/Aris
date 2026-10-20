//! Keep local document reads from taking over the user's Word/WPS session.
//! This is a preflight for common scripting mistakes, not a shell sandbox.

use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;

pub const LOCAL_DOCUMENT_READ_GUIDANCE: &str = "Read local documents from their saved file snapshot. Prefer read_docx/read_file/read_files for DOCX and file parsers for other formats; these reads do not include unsaved edits in Word/WPS. Never attach to or create Word/WPS automation objects to read a document, call Application.Quit/Documents.Close, close an editor window, or terminate an editor process to release a file lock. If a file is locked or access is denied, try a readable saved copy; otherwise explain that the current saved file cannot be read and let the user save/export a copy while keeping the editor open. Legacy .doc conversion must work on a copy without controlling the user's editor.";

fn rejection(reason: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        format!("document_safety: {reason}. {LOCAL_DOCUMENT_READ_GUIDANCE}"),
    )
}

/// Runs before spawning either a foreground command or a background service.
/// Also inspect directly invoked script files: moving a COM one-liner to a
/// Python/PowerShell helper must not make that same operation acceptable.
pub fn ensure_document_command_safe(command: &str) -> io::Result<()> {
    check_source(command)?;
    for path in invoked_scripts(command) {
        let Ok(file) = std::fs::File::open(&path) else {
            continue; // The command itself will report a missing/unreadable script.
        };
        let mut source = Vec::new();
        file.take(1024 * 1024 + 1).read_to_end(&mut source)?;
        if source.len() > 1024 * 1024 {
            return Err(rejection(
                "document command preflight cannot inspect a script over 1 MiB",
            ));
        }
        check_source(&script_text(&source))?;
    }
    Ok(())
}

fn check_source(source: &str) -> io::Result<()> {
    // Quoted search patterns are data, not an attempt to launch automation.
    if literal_read_query(source) {
        return Ok(());
    }
    static AUTOMATION: OnceLock<Regex> = OnceLock::new();
    static WORD_TARGET: OnceLock<Regex> = OnceLock::new();
    let automation = AUTOMATION.get_or_init(|| {
        Regex::new(r"(?i)\bnew-object\b|\bnew\s+|\b(?:getactiveobject|getobject|createobject|dispatch(?:ex)?|ensuredispatch|gettypefromprogid|clsidfromprogid)\s*\(")
            .expect("automation activation pattern")
    });
    let word_target = WORD_TARGET.get_or_init(|| {
        Regex::new(r#"(?i)\b(?:word|kwps|wps)\.application\b|\bmicrosoft\.office\.interop\.word\b|\bgetobject\s*\([^\r\n]*\.doc[xm]?["']"#)
            .expect("Word/WPS automation target pattern")
    });
    // The ProgID can be held in a variable or appear after an optional first
    // GetObject argument; do not require it to sit next to the activation API.
    if automation.is_match(source) && word_target.is_match(source) {
        return Err(rejection(
            "Word/WPS automation can affect documents the user is editing",
        ));
    }
    if has_termination(source) {
        static EDITOR: OnceLock<Regex> = OnceLock::new();
        let editor = EDITOR.get_or_init(|| {
            Regex::new(r"(?i)\b(?:winword|wps|wpspdf|kwps)(?:\.exe)?\b")
                .expect("document editor process pattern")
        });
        if editor.is_match(source) {
            return Err(rejection(
                "ending a Word/WPS process can discard unsaved edits",
            ));
        }
        check_editor_pids(source)?;
    }
    Ok(())
}

fn script_text(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        let little_endian = bytes[0] == 0xff;
        let words: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|pair| {
                if little_endian {
                    u16::from_le_bytes([pair[0], pair[1]])
                } else {
                    u16::from_be_bytes([pair[0], pair[1]])
                }
            })
            .collect();
        String::from_utf16_lossy(&words)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

fn literal_read_query(source: &str) -> bool {
    static QUERY: OnceLock<Regex> = OnceLock::new();
    static QUOTED: OnceLock<Regex> = OnceLock::new();
    let query = QUERY.get_or_init(|| {
        Regex::new(r"(?i)^\s*(?:rg|grep|cat|get-content|select-string)\b").expect("read query")
    });
    if !query.is_match(source) || source.contains("$(") || source.contains('`') {
        return false;
    }
    let quoted = QUOTED
        .get_or_init(|| Regex::new(r#""[^"\r\n]*"|'[^'\r\n]*'"#).expect("quoted search literals"));
    let unquoted = quoted.replace_all(source.trim(), "");
    !unquoted.contains([';', '|', '&', '\r', '\n', '`', '$'])
}

fn has_termination(source: &str) -> bool {
    static TERMINATION: OnceLock<Regex> = OnceLock::new();
    TERMINATION.get_or_init(|| {
        Regex::new(r"(?i)\b(?:stop-process|taskkill(?:\.exe)?|tskill|pkill|killall)\b|\.(?:kill|terminate|closemainwindow)\s*\(|\bos\.kill\s*\(")
            .expect("process termination pattern")
    })
    .is_match(source)
}

#[cfg(any(windows, test))]
fn protects_pid(source: &str, mut is_editor: impl FnMut(u32) -> bool) -> bool {
    static NUMBER: OnceLock<Regex> = OnceLock::new();
    NUMBER
        .get_or_init(|| Regex::new(r"\b[0-9]{1,10}\b").expect("PID pattern"))
        .find_iter(source)
        .filter_map(|value| value.as_str().parse::<u32>().ok())
        .any(&mut is_editor)
}

#[cfg(windows)]
fn check_editor_pids(source: &str) -> io::Result<()> {
    // A second call often says only `Stop-Process -Id 1234`, after a process
    // lookup in the previous call. Resolve literal PIDs without touching them.
    let output = crate::hidden_command("tasklist.exe")
        .args(["/FO", "CSV", "/NH"])
        .output()
        .map_err(|_| rejection("could not verify the target process before stopping it"))?;
    if !output.status.success() {
        return Err(rejection(
            "could not verify the target process before stopping it",
        ));
    }
    let editors: Vec<u32> = crate::decode_process_text(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut fields = line.trim().trim_matches('"').split("\",\"");
            let name = fields.next()?.to_ascii_lowercase();
            matches!(
                name.as_str(),
                "winword.exe" | "wps.exe" | "wpspdf.exe" | "kwps.exe"
            )
            .then(|| fields.next()?.parse::<u32>().ok())
            .flatten()
        })
        .collect();
    if protects_pid(source, |pid| editors.contains(&pid)) {
        return Err(rejection("the target PID belongs to a Word/WPS editor"));
    }
    Ok(())
}

#[cfg(not(windows))]
fn check_editor_pids(_source: &str) -> io::Result<()> {
    Ok(())
}

fn invoked_scripts(command: &str) -> Vec<PathBuf> {
    static TOKEN: OnceLock<Regex> = OnceLock::new();
    let tokens = TOKEN.get_or_init(|| {
        Regex::new(r#""([^"\r\n]*)"|'([^'\r\n]*)'|([;|&\r\n]+)|([^\s;|&]+)"#)
            .expect("script invocation tokens")
    });
    let mut interpreter = false;
    let mut command_start = true;
    let mut scripts = Vec::new();
    for capture in tokens.captures_iter(command) {
        if capture.get(3).is_some() {
            interpreter = false;
            command_start = true;
            continue;
        }
        let token = capture
            .get(1)
            .or_else(|| capture.get(2))
            .or_else(|| capture.get(4))
            .expect("token value")
            .as_str();
        let program = token
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(token)
            .to_ascii_lowercase();
        if matches!(
            program.as_str(),
            "python"
                | "python3"
                | "python.exe"
                | "python3.exe"
                | "py"
                | "py.exe"
                | "powershell"
                | "powershell.exe"
                | "pwsh"
                | "pwsh.exe"
                | "cscript"
                | "cscript.exe"
                | "wscript"
                | "wscript.exe"
        ) {
            interpreter = true;
        } else if (interpreter || command_start)
            && Path::new(token).extension().is_some_and(|ext| {
                ["py", "ps1", "vbs"]
                    .iter()
                    .any(|name| ext.eq_ignore_ascii_case(name))
            })
        {
            let path = Path::new(token);
            let path = if path.is_absolute() {
                path.to_path_buf()
            } else {
                crate::execution_current_dir()
                    .unwrap_or_default()
                    .join(path)
            };
            scripts.push(path);
            interpreter = false;
        }
        command_start = token == ".";
    }
    scripts
}

/// Give locked reads a safe recovery path instead of inviting COM/process kill.
pub fn document_read_error(error: io::Error) -> String {
    if error.kind() == io::ErrorKind::PermissionDenied
        || matches!(error.raw_os_error(), Some(32 | 33))
    {
        format!("document_read_unavailable: {error}. {LOCAL_DOCUMENT_READ_GUIDANCE}")
    } else {
        error.to_string()
    }
}

#[cfg(test)]
#[path = "tests/document_safety.rs"]
mod tests;
