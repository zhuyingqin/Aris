use super::{format_compact_report, format_cost_report};
use crate::{CompactionResult, CompactionSummarySource, Session, TokenUsage};

#[test]
fn cost_report_renders_all_token_categories() {
    let report = format_cost_report(TokenUsage {
        input_tokens: 12,
        output_tokens: 8,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 5,
    });

    assert!(report.contains("Input tokens     12"));
    assert!(report.contains("Cache read       5"));
    assert!(report.contains("Total tokens     28"));
}

#[test]
fn compact_report_distinguishes_skipped_and_compacted_results() {
    let skipped = format_compact_report(&CompactionResult {
        summary: String::new(),
        formatted_summary: String::new(),
        compacted_session: Session::new(),
        removed_message_count: 0,
        preserved_message_count: 0,
        tokens_before: 40,
        tokens_after: 40,
        summary_source: CompactionSummarySource::Fallback,
        summary_output_tokens: None,
        token_estimate_source: crate::CompactionTokenEstimateSource::Heuristic,
    });
    assert!(skipped.contains("Result           skipped"));

    let compacted = format_compact_report(&CompactionResult {
        summary: "summary".to_string(),
        formatted_summary: "Summary:\nsummary".to_string(),
        compacted_session: Session::new(),
        removed_message_count: 2,
        preserved_message_count: 4,
        tokens_before: 100,
        tokens_after: 60,
        summary_source: CompactionSummarySource::Fallback,
        summary_output_tokens: None,
        token_estimate_source: crate::CompactionTokenEstimateSource::Heuristic,
    });
    assert!(compacted.contains("Result           compacted"));
    assert!(compacted.contains("Tokens saved     40"));
}
