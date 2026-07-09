use std::ffi::OsString;
use std::time::{SystemTime, UNIX_EPOCH};

use super::{file_read, strip_location_suffix};

struct EnvGuard {
    key: &'static str,
    previous: Option<OsString>,
}

impl EnvGuard {
    fn unset(key: &'static str) -> Self {
        let previous = std::env::var_os(key);
        std::env::remove_var(key);
        Self { key, previous }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        if let Some(previous) = self.previous.as_ref() {
            std::env::set_var(self.key, previous);
        } else {
            std::env::remove_var(self.key);
        }
    }
}

fn temp_path(name: &str) -> std::path::PathBuf {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    std::env::temp_dir().join(format!("somniq-desktop-{name}-{unique}"))
}

#[test]
fn file_read_defaults_to_first_200_lines() {
    let _env = EnvGuard::unset("ARIS_WORKSPACE_ROOT");
    let path = temp_path("long-lines.txt");
    let content = (1..=250)
        .map(|line| format!("line-{line}"))
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(&path, content).expect("write file");

    let output = file_read(path.display().to_string(), None).expect("file_read should work");

    assert!(output.contains("line-1"));
    assert!(output.contains("line-200"));
    assert!(!output.contains("line-201"));
    let _ = std::fs::remove_file(path);
}

#[test]
fn file_read_truncates_very_long_single_line() {
    let _env = EnvGuard::unset("ARIS_WORKSPACE_ROOT");
    let path = temp_path("long-single-line.json");
    std::fs::write(&path, "x".repeat(210_000)).expect("write file");

    let output = file_read(path.display().to_string(), Some(1)).expect("file_read should work");

    assert!(output.len() < 210_000);
    assert!(output.contains("[read_file truncated:"));
    let _ = std::fs::remove_file(path);
}

#[test]
fn local_file_links_may_include_line_and_column_locations() {
    assert_eq!(strip_location_suffix("src/main.rs:42"), "src/main.rs");
    assert_eq!(strip_location_suffix("src/main.rs:42:7"), "src/main.rs");
    assert_eq!(
        strip_location_suffix(r"C:\Project\src\main.rs:42"),
        r"C:\Project\src\main.rs"
    );
}
