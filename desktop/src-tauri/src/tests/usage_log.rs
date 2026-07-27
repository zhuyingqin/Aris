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
