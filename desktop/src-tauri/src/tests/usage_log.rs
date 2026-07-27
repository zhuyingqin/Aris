use super::*;

#[test]
fn summary_aggregates_usage_by_model() {
    let path = temp_usage_path("aggregate");
    let entries = vec![
        UsageLogEntry {
            created_at: 1,
            session_id: "s1".to_string(),
            role: "executor".to_string(),
            server: "https://api.openai.com/v1".to_string(),
            model: "gpt-5.5".to_string(),
            provider: "openai".to_string(),
            input_tokens: 400,
            output_tokens: 80,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 600,
        },
        UsageLogEntry {
            created_at: 2,
            session_id: "s2".to_string(),
            role: "reviewer".to_string(),
            server: "https://api.openai.com/v1".to_string(),
            model: "gpt-5.5".to_string(),
            provider: "openai".to_string(),
            input_tokens: 100,
            output_tokens: 20,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
        },
    ];
    write_entries(&path, &entries);

    let summary = summarize_usage_log(&path, 10).expect("summary");

    assert_eq!(summary.requests, 2);
    assert_eq!(summary.prompt_tokens, 1100);
    assert_eq!(summary.total_tokens, 1200);
    assert_eq!(summary.by_model.len(), 1);
    assert_eq!(summary.by_server.len(), 1);
    assert_eq!(summary.by_server[0].server, "https://api.openai.com/v1");
    assert_eq!(summary.by_model[0].cache_read_input_tokens, 600);
    assert_eq!(summary.recent[0].role, "reviewer");
    let _ = fs::remove_file(path);
}

#[test]
fn append_skips_empty_usage() {
    let usage = TokenUsage::default();
    assert!(!has_billable_tokens(&usage));
}

#[test]
fn legacy_usage_entries_default_to_executor_role() {
    let entry: UsageLogEntry = serde_json::from_str(
        r#"{"createdAt":1,"sessionId":"legacy","server":"","model":"m","provider":"p","inputTokens":1,"outputTokens":1,"cacheCreationInputTokens":0,"cacheReadInputTokens":0}"#,
    )
    .expect("legacy usage entry");

    assert_eq!(entry.role, "executor");
}

fn write_entries(path: &Path, entries: &[UsageLogEntry]) {
    let mut content = String::new();
    for entry in entries {
        content.push_str(&serde_json::to_string(entry).expect("json"));
        content.push('\n');
    }
    fs::write(path, content).expect("write usage log");
}

fn temp_usage_path(name: &str) -> PathBuf {
    let suffix = now_epoch_secs();
    std::env::temp_dir().join(format!(
        "somniq-usage-log-{name}-{}-{suffix}.jsonl",
        std::process::id()
    ))
}
