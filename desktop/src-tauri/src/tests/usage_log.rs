use super::*;

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

#[test]
fn debug_export_usage_filter_keeps_only_the_requested_session() {
    let content = concat!(
        "{\"createdAt\":1,\"sessionId\":\"chat-a\",\"server\":\"\",\"model\":\"m\",\"provider\":\"p\",\"inputTokens\":1,\"outputTokens\":1,\"cacheCreationInputTokens\":0,\"cacheReadInputTokens\":0}\n",
        "{not valid json}\n",
        "{\"createdAt\":2,\"sessionId\":\"chat-b\",\"server\":\"\",\"model\":\"m\",\"provider\":\"p\",\"inputTokens\":2,\"outputTokens\":2,\"cacheCreationInputTokens\":0,\"cacheReadInputTokens\":0}\n",
    );

    let filtered = filter_usage_log_for_session(content, "chat-b");
    let lines = filtered.lines().collect::<Vec<_>>();
    assert_eq!(lines.len(), 1);
    assert!(lines[0].contains("\"sessionId\":\"chat-b\""));
}
