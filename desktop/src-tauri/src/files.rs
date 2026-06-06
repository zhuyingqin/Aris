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

/// Read the first N lines of a file.
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
    let root_arg = root.to_string_lossy().to_string();
    let mut starters = vec!["Explain this project's architecture and key modules.".to_string()];
    let dirty = crate::process::hidden_command("git")
        .args(["-C", root_arg.as_str(), "status", "--porcelain"])
        .output()
        .map(|output| output.status.success() && !output.stdout.is_empty())
        .unwrap_or(false);
    if dirty {
        starters.push(
            "Review the uncommitted changes and identify the highest-risk issues.".to_string(),
        );
    } else {
        starters
            .push("Inspect the current project and identify the highest-risk issues.".to_string());
    }
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
