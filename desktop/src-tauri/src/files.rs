use serde_json::json;

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
mod tests {
    use std::ffi::OsString;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::file_read;

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
        std::env::temp_dir().join(format!("aris-desktop-{name}-{unique}"))
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
}
