use super::{
    assemble_compacted_session_with_usage, collect_key_files, estimate_session_tokens,
    format_compact_summary,
    get_compact_continuation_message, infer_latest_user_request, infer_pending_work,
    plan_compaction, summarize_messages, CompactionConfig, CompactionResult,
    CompactionSummarySource, CompactionTokenEstimateSource,
};
use crate::session::{ContentBlock, ConversationMessage, MessageRole, Session};

fn compact_session_for_test(session: &Session, config: CompactionConfig) -> CompactionResult {
    match plan_compaction(session, &config) {
        None => CompactionResult {
            summary: String::new(),
            formatted_summary: String::new(),
            compacted_session: session.clone(),
            removed_message_count: 0,
            preserved_message_count: session.messages.len(),
            tokens_before: estimate_session_tokens(session),
            tokens_after: estimate_session_tokens(session),
            summary_source: CompactionSummarySource::Skipped,
            summary_output_tokens: None,
            token_estimate_source: CompactionTokenEstimateSource::Heuristic,
        },
        Some(plan) => {
            let summary = summarize_messages(&plan.removed);
            assemble_compacted_session_with_usage(
                session,
                summary,
                CompactionSummarySource::Fallback,
                None,
                &plan,
            )
        }
    }
}

#[test]
fn formats_compact_summary_like_upstream() {
    let summary = "<analysis>scratch</analysis>\n<summary>Kept work</summary>";
    assert_eq!(format_compact_summary(summary), "Summary:\nKept work");
}

#[test]
fn manual_compaction_keeps_a_single_completed_turn_intact() {
    let session = Session {
        version: 1,
        messages: vec![
            ConversationMessage::user_text("implement the requested change"),
            ConversationMessage::assistant(vec![ContentBlock::Text {
                text: "implemented and verified".to_string(),
            }]),
        ],
        compactions: Vec::new(),
    };

    let result = compact_session_for_test(&session, CompactionConfig::manual(None));

    assert_eq!(result.removed_message_count, 0);
    assert_eq!(result.compacted_session.messages, session.messages);
}

#[test]
fn manual_compaction_preserves_the_same_recent_window_as_auto_compaction() {
    let session = Session {
        version: 1,
        messages: vec![
            ConversationMessage::user_text("first request"),
            ConversationMessage::assistant(vec![ContentBlock::Text {
                text: "first reply".to_string(),
            }]),
            ConversationMessage::user_text("second request"),
            ConversationMessage::assistant(vec![ContentBlock::Text {
                text: "second reply".to_string(),
            }]),
            ConversationMessage::user_text("current request"),
            ConversationMessage::assistant(vec![ContentBlock::Text {
                text: "current reply".to_string(),
            }]),
        ],
        compactions: Vec::new(),
    };

    let manual = plan_compaction(&session, &CompactionConfig::manual(None)).expect("manual plan");
    let automatic = plan_compaction(
        &session,
        &CompactionConfig {
            max_estimated_tokens: 0,
            ..CompactionConfig::default()
        },
    )
    .expect("automatic plan");

    assert_eq!(manual.split_index, automatic.split_index);
    assert_eq!(manual.preserved, automatic.preserved);
    assert_eq!(manual.preserved.len(), 4);
    assert!(matches!(
        &manual.preserved[0].blocks[0],
        ContentBlock::Text { text } if text == "second request"
    ));
}

#[test]
fn fallback_summary_carries_latest_todowrite_state_and_forward_plan() {
    let session = Session {
        version: 1,
        messages: vec![
            ConversationMessage::user_text("finish the migration and run tests"),
            ConversationMessage::tool_result(
                "todo-1",
                "TodoWrite",
                r#"{"oldTodos":[],"newTodos":[{"content":"Run migration tests","activeForm":"Running migration tests","status":"in_progress"},{"content":"Update the release notes","activeForm":"Updating release notes","status":"pending"}]}"#,
                false,
            ),
            ConversationMessage::assistant(vec![ContentBlock::Text {
                text: "Next: run the migration tests, then update the release notes.".to_string(),
            }]),
            ConversationMessage::user_text("continue"),
        ],
        compactions: Vec::new(),
    };

    let summary = summarize_messages(&session.messages);

    assert!(summary.contains("## Todo State"));
    assert!(summary.contains("[in_progress] Run migration tests"));
    assert!(summary.contains("[pending] Update the release notes"));
    assert!(summary.contains("## Forward Plan"));
    assert!(summary.contains("Next: run the migration tests"));
}

#[test]
fn continuation_treats_preserved_tail_as_authoritative() {
    let message = get_compact_continuation_message("<summary>old</summary>", true, true);
    assert!(message.contains("Recent messages are preserved verbatim and are authoritative"));
    assert!(message.contains("If the summary conflicts"));
}

#[test]
fn leaves_small_sessions_unchanged() {
    let session = Session {
        version: 1,
        messages: vec![ConversationMessage::user_text("hello")],
        compactions: Vec::new(),
    };

    let result = compact_session_for_test(&session, CompactionConfig::default());
    assert_eq!(result.removed_message_count, 0);
    assert_eq!(result.compacted_session, session);
    assert!(result.summary.is_empty());
    assert!(result.formatted_summary.is_empty());
}

#[test]
fn compacts_older_messages_into_a_user_summary() {
    // Session: User → Assistant → Tool → Assistant
    // With preserve=2, initial_keep_from = 2 (Tool), scan forward → no User
    // → preserved is empty, all 4 messages summarized, only the continuation
    // User message remains.
    let session = Session {
        version: 1,
        messages: vec![
            ConversationMessage::user_text("one ".repeat(200)),
            ConversationMessage::assistant(vec![ContentBlock::Text {
                text: "two ".repeat(200),
            }]),
            ConversationMessage::tool_result("1", "bash", "ok ".repeat(200), false),
            ConversationMessage {
                role: MessageRole::Assistant,
                blocks: vec![ContentBlock::Text {
                    text: "recent".to_string(),
                }],
                usage: None,
            },
        ],
        compactions: Vec::new(),
    };

    let result = compact_session_for_test(
        &session,
        CompactionConfig {
            preserve_recent_messages: 2,
            max_estimated_tokens: 1,
            ..CompactionConfig::default()
        },
    );

    // The safe split keeps the final assistant tail instead of collapsing
    // the model view to only one synthetic summary message.
    assert_eq!(result.removed_message_count, 3);
    assert_eq!(result.compacted_session.messages.len(), 2);
    assert_eq!(result.compacted_session.messages[0].role, MessageRole::User);
    assert_eq!(
        result.compacted_session.messages[1].role,
        MessageRole::Assistant
    );
    assert!(matches!(
        &result.compacted_session.messages[0].blocks[0],
        ContentBlock::Text { text } if text.contains("Summary:")
    ));
    assert!(result.formatted_summary.contains("Scope:"));
    assert!(result.formatted_summary.contains("Key timeline"));
    assert_eq!(result.tokens_before, estimate_session_tokens(&session));
    assert_eq!(
        result.tokens_after,
        estimate_session_tokens(&result.compacted_session)
    );
    assert_eq!(result.compacted_session.compactions.len(), 1);
}

#[test]
fn preservation_window_starts_mid_tool_chain_is_moved_to_next_user() {
    // Session shape: Oldest[0..=3] summarized, Tail[4..]=Tool,Assistant,User,Assistant.
    // With preserve=4, initial_keep_from=4 points at Tool (dangling tool_result).
    // Forward scan should skip Tool and Assistant, land on User at index 6.
    // Expected: preserved = [User, Assistant], removed_count = 6 (0..6).
    let session = Session {
        version: 1,
        messages: vec![
            ConversationMessage::user_text("old ".repeat(300)),
            ConversationMessage::assistant(vec![ContentBlock::ToolUse {
                id: "t1".into(),
                name: "bash".into(),
                input: "{}".into(),
            }]),
            ConversationMessage::tool_result("t1", "bash", "ok", false),
            ConversationMessage::assistant(vec![ContentBlock::Text {
                text: "old-reply".into(),
            }]),
            // Tail window starts here (dangling tool_result — its tool_use at
            // index 1 is in the removed portion if we stopped naively).
            ConversationMessage::tool_result("t1", "bash", "done", false),
            ConversationMessage::assistant(vec![ContentBlock::Text {
                text: "assistant-text".into(),
            }]),
            ConversationMessage::user_text("next question"),
            ConversationMessage::assistant(vec![ContentBlock::Text {
                text: "answer".into(),
            }]),
        ],
        compactions: Vec::new(),
    };

    let result = compact_session_for_test(
        &session,
        CompactionConfig {
            preserve_recent_messages: 4,
            max_estimated_tokens: 1,
            ..CompactionConfig::default()
        },
    );

    // The split avoids orphaning the second tool result while preserving
    // more recent tail context than the old forward-to-user scan.
    assert_eq!(result.removed_message_count, 5);
    assert_eq!(result.compacted_session.messages.len(), 4);
    assert_eq!(result.compacted_session.messages[0].role, MessageRole::User);
    assert_eq!(
        result.compacted_session.messages[1].role,
        MessageRole::Assistant
    );
    assert_eq!(result.compacted_session.messages[2].role, MessageRole::User);
    assert!(matches!(
        &result.compacted_session.messages[2].blocks[0],
        ContentBlock::Text { text } if text == "next question"
    ));
    assert_eq!(
        result.compacted_session.messages[3].role,
        MessageRole::Assistant
    );
}

#[test]
fn preserved_window_drops_when_no_user_in_tail() {
    // Session: user messages are only at index 0, rest is tool/assistant.
    // With preserve=2, forward scan from index N-2 finds no User → drop all
    // preserved, keep only the summary.
    let session = Session {
        version: 1,
        messages: vec![
            ConversationMessage::user_text("question ".repeat(300)),
            ConversationMessage::assistant(vec![ContentBlock::ToolUse {
                id: "t".into(),
                name: "bash".into(),
                input: "{}".into(),
            }]),
            ConversationMessage::tool_result("t", "bash", "result", false),
            ConversationMessage::assistant(vec![ContentBlock::Text {
                text: "final".into(),
            }]),
        ],
        compactions: Vec::new(),
    };

    let result = compact_session_for_test(
        &session,
        CompactionConfig {
            preserve_recent_messages: 2,
            max_estimated_tokens: 1,
            ..CompactionConfig::default()
        },
    );

    // The final assistant response is a safe tail and should remain verbatim.
    assert_eq!(result.removed_message_count, 3);
    assert_eq!(result.compacted_session.messages.len(), 2);
    assert_eq!(result.compacted_session.messages[0].role, MessageRole::User);
    assert_eq!(
        result.compacted_session.messages[1].role,
        MessageRole::Assistant
    );
}

#[test]
fn truncates_long_blocks_in_summary() {
    let summary = super::summarize_block(&ContentBlock::Text {
        text: "x".repeat(2_000),
    });
    assert!(summary.contains(" ... "));
    assert!(summary.chars().count() <= 450);
}

#[test]
fn estimates_cjk_text_by_characters_not_utf8_bytes() {
    let cjk = "上下文压缩质量很重要";
    let ascii = "context compression quality matters";

    assert_eq!(super::estimate_text_tokens(cjk), cjk.chars().count() + 1);
    assert_eq!(
        super::estimate_text_tokens(ascii),
        ((ascii.chars().count() as f64) / 3.5).round() as usize + 1
    );
}

#[test]
fn extracts_key_files_from_message_content() {
    let files = collect_key_files(&[ConversationMessage::user_text(
        "Update rust/crates/runtime/src/compact.rs and rust/crates/rusty-claude-cli/src/main.rs next.",
    )]);
    assert!(files.contains(&"rust/crates/runtime/src/compact.rs".to_string()));
    assert!(files.contains(&"rust/crates/rusty-claude-cli/src/main.rs".to_string()));
}

#[test]
fn infers_pending_work_from_recent_messages() {
    let pending = infer_pending_work(&[
        ConversationMessage::user_text("done"),
        ConversationMessage::assistant(vec![ContentBlock::Text {
            text: "Next: update tests and follow up on remaining CLI polish.".to_string(),
        }]),
    ]);
    assert_eq!(pending.len(), 1);
    assert!(pending[0].contains("Next: update tests"));
}

#[test]
fn latest_compacted_user_request_ignores_assistant_tail() {
    let latest = infer_latest_user_request(&[
        ConversationMessage::user_text("old request"),
        ConversationMessage::assistant(vec![ContentBlock::Text {
            text: "Assistant says the current work is old.".to_string(),
        }]),
        ConversationMessage::user_text("new request"),
        ConversationMessage::assistant(vec![ContentBlock::Text {
            text: "I will keep working on it.".to_string(),
        }]),
    ]);

    assert_eq!(latest.as_deref(), Some("new request"));
}

#[test]
fn latest_user_request_ignores_internal_resume_messages() {
    let prior = get_compact_continuation_message(
        "<summary>\n## Current Focus\n- Active user goal: keep prior compacted goal\n</summary>",
        true,
        false,
    );
    let latest = infer_latest_user_request(&[
        ConversationMessage::user_text("repair Aris context compression focus loss"),
        ConversationMessage::user_text(
            "Continue the unfinished task from the exact point where the previous response stopped (max_tokens).",
        ),
        ConversationMessage::user_text(
            "Your latest assistant message is empty. Otherwise continue the work now.",
        ),
        ConversationMessage::user_text(prior),
    ]);

    assert_eq!(
        latest.as_deref(),
        Some("repair Aris context compression focus loss")
    );
}

#[test]
fn fallback_summary_rolls_forward_prior_compaction_focus() {
    let prior = get_compact_continuation_message(
        "<summary>\n## Current Focus\n- Active user goal: repair Aris context compression focus loss.\n\n## Active Issues\n- Fallback summary may lose the old focus during repeated compaction.\n</summary>",
        true,
        false,
    );
    let summary = summarize_messages(&[
        ConversationMessage::user_text(prior),
        ConversationMessage::assistant(vec![ContentBlock::Text {
            text: "Inspected compact.rs and found the fallback summary path.".to_string(),
        }]),
    ]);

    assert!(summary.contains("## Prior Compaction Summary"));
    assert!(summary.contains("repair Aris context compression focus loss"));
    assert!(summary.contains("Active user goal from prior compacted state"));
    assert!(!summary.contains("Active user goal: This session is being continued"));
}

/// Diagnostic: end-to-end behavior of context compression on a realistic
/// mixed CJK + English session. Run with `--nocapture` to see numbers.
#[test]
fn diagnostic_e2e_compression() {
    // Build a session large enough to actually trigger compaction.
    // Each text block is ~3500 chars → ~900 backend tokens. 12 blocks
    // × ~900 = ~10800 tokens, just over the 10k default threshold.
    let cjk_chunk =
        "你好世界，这是一个测试用的中文句子，用于观察压缩前后的 token 数变化。".repeat(40);
    let eng_chunk = "The quick brown fox jumps over the lazy dog. ".repeat(40);
    let mut messages: Vec<ConversationMessage> = Vec::new();
    for i in 0..6 {
        let body = format!("Turn {i}: {cjk_chunk}{eng_chunk}");
        messages.push(ConversationMessage::user_text(body.clone()));
        messages.push(ConversationMessage::assistant(vec![ContentBlock::Text {
            text: format!("Reply {i}: {cjk_chunk}{eng_chunk}"),
        }]));
    }
    let session = Session {
        version: 1,
        messages,
        compactions: Vec::new(),
    };

    // 1. Compute backend estimate.
    let backend_before = estimate_session_tokens(&session);

    // 2. Compute a frontend-shaped estimate on the same session for
    //    comparison. (Mirror Chat.tsx estimateTokens heuristic.)
    let mut chars = 0usize;
    let mut cjk = 0usize;
    for m in &session.messages {
        for b in &m.blocks {
            if let ContentBlock::Text { text } = b {
                chars += text.chars().count();
                cjk += text
                    .chars()
                    .filter(|c| {
                        let u = *c as u32;
                        (0x4E00..=0x9FFF).contains(&u)
                            || (0x3400..=0x4DBF).contains(&u)
                            || (0xF900..=0xFAFF).contains(&u)
                    })
                    .count();
            }
        }
    }
    let non_cjk = chars.saturating_sub(cjk);
    let frontend_before = cjk + ((non_cjk as f64) / 3.5).round() as usize;

    // 3. Apply compaction with default config (preserve 4 recent,
    //    max 10k est.).
    let result = compact_session_for_test(&session, CompactionConfig::default());
    let backend_after = estimate_session_tokens(&result.compacted_session);

    // 4. Print: shows real numbers, not descriptions.
    eprintln!(
        "==== E2E CONTEXT COMPRESSION DIAGNOSTIC ====\n\
         session messages: {} (6 user + 6 assistant turns)\n\
         total chars (chars().count()): {}\n\
         total bytes (text.len()):    {}\n\
         CJK chars:                   {}\n\
         backend estimate BEFORE: {} tokens\n\
         frontend estimate BEFORE: {} tokens\n\
         backend / frontend ratio: {:.2}×\n\
         ---- compaction ----\n\
         removed_message_count: {}\n\
         compacted_session.messages: {}\n\
         backend estimate AFTER: {} tokens\n\
         tokens saved: {} ({:.1}%)\n\
         summary preview (first 250 chars):\n{}\n\
         ============================================",
        session.messages.len(),
        chars,
        session
            .messages
            .iter()
            .flat_map(|m| m.blocks.iter())
            .map(|b| match b {
                ContentBlock::Text { text } => text.len(),
                _ => 0,
            })
            .sum::<usize>(),
        cjk,
        backend_before,
        frontend_before,
        backend_before as f64 / frontend_before.max(1) as f64,
        result.removed_message_count,
        result.compacted_session.messages.len(),
        backend_after,
        backend_before.saturating_sub(backend_after),
        100.0 * (backend_before.saturating_sub(backend_after)) as f64
            / backend_before.max(1) as f64,
        result.summary.chars().take(250).collect::<String>(),
    );

    // Real behavior we want to confirm:
    assert!(
        result.removed_message_count > 0,
        "compaction must fire above 10k threshold"
    );
    assert!(
        backend_after < backend_before,
        "compaction must reduce tokens"
    );
    // Compaction reduces by a meaningful fraction (heuristic summary, not
    // LLM — actual ratio depends on tool/role mix; 30%+ is the realistic
    // floor for content-heavy sessions).
    let saved_pct = 100.0 * (backend_before.saturating_sub(backend_after)) as f64
        / backend_before.max(1) as f64;
    assert!(
        saved_pct > 30.0,
        "compaction should save at least 30%, got {:.1}% (before={} after={})",
        saved_pct,
        backend_before,
        backend_after,
    );
    // After compaction, the 4 preserved recent messages + summary should
    // leave us at <60% of the original token count.
    assert!(
        backend_after * 10 < backend_before * 6,
        "compacted session should be <60% of original size, got before={} after={} ({:.1}%)",
        backend_before,
        backend_after,
        saved_pct,
    );
}

/// Diagnostic: characterize the gap between frontend (chars/3.5 + CJK)
/// and backend (bytes/4+1) estimates across content types. Run with
/// `--nocapture` to see numbers.
#[test]
fn diagnostic_estimate_gap_across_content() {
    // Helper to compute both estimates on a string and report.
    fn measure(label: &str, body: &str) {
        let chars = body.chars().count();
        let bytes = body.len();
        let cjk = body
            .chars()
            .filter(|c| {
                let u = *c as u32;
                (0x4E00..=0x9FFF).contains(&u)
                    || (0x3400..=0x4DBF).contains(&u)
                    || (0xF900..=0xFAFF).contains(&u)
            })
            .count();
        let non_cjk = chars.saturating_sub(cjk);
        // Frontend (Chat.tsx): CJK = 1 tok/char, others = chars/3.5.
        let frontend = cjk + ((non_cjk as f64) / 3.5).round() as usize;
        // Backend (estimate_session_tokens): text.len() bytes / 4 + 1.
        let backend = bytes / 4 + 1;
        let ratio = backend as f64 / frontend.max(1) as f64;
        eprintln!(
            "  {:<14} chars={:>5} bytes={:>5} cjk={:>4} → frontend={:>4} tok, backend={:>4} tok, ratio={:.2}×",
            label, chars, bytes, cjk, frontend, backend, ratio
        );
    }

    eprintln!("==== ESTIMATE GAP DIAGNOSTIC (per 1 text block) ====");
    measure(
        "pure_zh",
        &"你好世界这是一个测试用的中文句子用于观察token数变化。".repeat(5),
    );
    measure(
        "pure_en",
        &"The quick brown fox jumps over the lazy dog. ".repeat(10),
    );
    measure(
        "mixed",
        &"你好 world, this is a mixed 中英文 sentence for testing token estimation accuracy."
            .repeat(5),
    );
    measure(
        "code",
        &"fn main() { let x = vec![1, 2, 3]; println!(\"{:?}\", x); }",
    );
    measure(
        "json",
        &r#"{"name":"aris","version":"0.4.2","features":["chat","lab","literature"]}"#,
    );
    eprintln!("==================================================");
    // Always passes — this is purely informational.
}

/// Diagnostic: threshold firing at 70% (warn) and 90% (compact), to confirm
/// the engine's policy matches what the roadmap says.
#[test]
fn diagnostic_threshold_triggers() {
    // Mirror engine::context_action logic locally for unit-testability.
    fn action(used: u64, window: u64) -> &'static str {
        if window == 0 {
            return "None";
        }
        let usage = used as f64 / window as f64;
        if usage >= 0.90 {
            "Compact"
        } else if usage >= 0.70 {
            "Warn"
        } else {
            "None"
        }
    }

    // Test against a 200k context (Claude Sonnet/Opus default).
    let win = 200_000u64;
    let cases = [
        (0, "None"),
        (50_000, "None"),     // 25%
        (139_999, "None"),    // 69.9995%
        (140_000, "Warn"),    // 70%
        (179_999, "Warn"),    // 89.9995%
        (180_000, "Compact"), // 90%
        (200_000, "Compact"), // 100%
    ];
    eprintln!("==== THRESHOLD TRIGGER DIAGNOSTIC (window=200k) ====");
    for (used, expected) in cases {
        let got = action(used, win);
        let pct = 100.0 * used as f64 / win as f64;
        eprintln!(
            "  used={:>7} ({:>5.2}%) → {} (expected {})",
            used, pct, got, expected
        );
        assert_eq!(got, expected, "mismatch at used={}", used);
    }

    // Now check the gap when frontend shows X% but backend sees Y%.
    // Frontend estimate tends to be roughly aligned with backend for
    // mixed CJK/English content (within ±25% in our previous test).
    // The user's view: when frontend ring shows 70%, what's backend's?
    // We don't have a frontend to call, but we can reason: if frontend
    // over-counts by ~25%, then frontend 70% = backend 70%/1.25 = 56%.
    // If under-counts by 25%, frontend 70% = backend 87.5%.
    // The exact gap is content-dependent, which is the *real* problem
    // we're trying to surface.
    eprintln!("\nGap analysis (qualitative):");
    eprintln!("  frontend rings uses estimateTokens(turns) on UI-side turns");
    eprintln!("  backend threshold uses estimate_session_tokens on session.messages");
    eprintln!("  both are heuristic; their ratio depends on CJK/ASCII mix");
    eprintln!("================================================");
}

/// Fidelity benchmark: realistic 12-turn CORS debugging session with
/// 10 embedded facts at known positions. The heuristic summary
/// truncates each block to 160 chars, so facts buried past that
/// boundary are dropped from the timeline. After an LLM-summary
/// upgrade, all 10 should be preserved.
#[test]
fn compression_fidelity_benchmark() {
    // Build a long text with the fact at a controlled position.
    //   fact_at_start=true  → prefix + fact + fill    (fact in first 160 chars)
    //   fact_at_start=false → prefix + fill + fact + fill  (fact past 160 chars)
    fn long(
        prefix: &str,
        fact: &str,
        fill: &str,
        target_len: usize,
        fact_at_start: bool,
    ) -> String {
        let mut s = String::with_capacity(target_len + fact.len() + prefix.len());
        s.push_str(prefix);
        if fact_at_start {
            // fact right after the prefix → survives 160-char truncation
            s.push_str(fact);
            while s.chars().count() < target_len {
                s.push_str(fill);
            }
        } else {
            // fill first so fact lands ~50 chars before target_len end,
            // i.e. well past the 160-char truncation boundary
            let desired = target_len.saturating_sub(fact.chars().count() + 50);
            while s.chars().count() < desired {
                s.push_str(fill);
            }
            s.push_str(fact);
            while s.chars().count() < target_len {
                s.push_str(fill);
            }
        }
        s
    }

    // Build the 12-turn session. Each turn ~3500 chars so 12 turns
    // ≈ 12 × 3500 / 4 = 10500 backend tokens → triggers compaction
    // (default threshold is 10_000). preserve_recent_messages = 4,
    // so turns 9-12 are kept verbatim and turns 1-8 are summarized.
    let target = 3500usize;

    // Turn 1 (User): report CORS errors. FACT_API_URL placed EARLY so the
    // heuristic timeline (truncated to 160 chars per block) preserves it.
    let t1 = long(
        "User asks about CORS errors. ",
        "FACT_API_URL: api.example.com | ",
        "Generic context about React app setup. ",
        target,
        true,
    );

    // Turn 2 (Assistant): suggest installing cors. FACT_NPM_PKG BURIED — past
    // the 160-char truncation boundary, the heuristic timeline drops it.
    // Note: parameter order is (prefix, FACT, fill). The FACT_NPM_PKG text
    // lives in arg2 so it's only placed near the END of the string.
    let t2 = long(
        "Assistant recommends npm package. ",
        "FACT_NPM_PKG: npm install cors | ",
        "Generic discussion about middleware order and Express setup. ",
        target,
        false,
    );

    // Turn 3 (User): report second error. FACT_CREDENTIALS_ERR EARLY (kept).
    let t3 = long(
        "User reports new error after install. ",
        "FACT_CREDENTIALS_ERR: Access-Control-Allow-Credentials must be true | ",
        "Stack trace details. ",
        target,
        true,
    );

    // Turn 4 (Assistant): explain credentials flag. FACT_FIX_CREDENTIALS BURIED (lost).
    let t4 = long(
        "Assistant explains the credentials flag. ",
        "FACT_FIX_CREDENTIALS: cors({ origin: 'http://localhost:3000', credentials: true }) | ",
        "Background on the CORS spec and preflight. ",
        target,
        false,
    );

    // Turn 5 (User): curl test result. FACT_CURL_STATUS EARLY (kept).
    let t5 = long(
        "User runs curl test. ",
        "FACT_CURL_STATUS: HTTP 200 OK but missing ACA-O header | ",
        "Verbose nginx logs. ",
        target,
        true,
    );

    // Turn 6 (Assistant): reverse-proxy hint. FACT_REVERSE_PROXY BURIED (lost).
    let t6 = long(
        "Assistant suggests debugging. ",
        "FACT_REVERSE_PROXY: check nginx config for proxy_pass OPTIONS handling | ",
        "Discussion of preflight handling. ",
        target,
        false,
    );

    // Turn 7 (User): OPTIONS preflight result. FACT_PREFLIGHT EARLY (kept).
    let t7 = long(
        "User runs OPTIONS preflight. ",
        "FACT_PREFLIGHT: returns 204 with no Access-Control headers | ",
        "Verbose preflight response. ",
        target,
        true,
    );

    // Turn 8 (Assistant): fix with explicit preflight. FACT_EXPLICIT_PREFLIGHT BURIED (lost).
    let t8 = long(
        "Assistant provides code fix. ",
        "FACT_EXPLICIT_PREFLIGHT: app.options('*', cors()) handles preflight | ",
        "Discussion of express middleware patterns. ",
        target,
        false,
    );

    // Turn 9-12 are PRESERVED VERBATIM. Embed FACT_10 anywhere — it's safe.
    let t9 = long(
        "User: works now but auth header missing. ",
        "FACT_AUTH_HEADER: Authorization header not sent with withCredentials | ",
        "Browser devtools network tab. ",
        target,
        true,
    );
    let t10 = long(
        "Assistant: explains withCredentials on xhr. ",
        "FACT_XHR_CREDS: xhr.withCredentials = true required | ",
        "Sample fetch vs xhr code. ",
        target,
        true,
    );
    let t11 = long(
        "User: 401 from backend. ",
        "FACT_401_ERROR: HTTP 401 Unauthorized on token validation | ",
        "Backend logs. ",
        target,
        true,
    );
    let t12 = long(
        "Assistant: check token expiry. ",
        "FACT_TOKEN_EXPIRY: JWT exp claim shows token expired | ",
        "Suggested refresh flow. ",
        target,
        true,
    );

    let session = Session {
        version: 1,
        messages: vec![
            ConversationMessage::user_text(t1),
            ConversationMessage::assistant(vec![ContentBlock::Text { text: t2 }]),
            ConversationMessage::user_text(t3),
            ConversationMessage::assistant(vec![ContentBlock::Text { text: t4 }]),
            ConversationMessage::user_text(t5),
            ConversationMessage::assistant(vec![ContentBlock::Text { text: t6 }]),
            ConversationMessage::user_text(t7),
            ConversationMessage::assistant(vec![ContentBlock::Text { text: t8 }]),
            ConversationMessage::user_text(t9),
            ConversationMessage::assistant(vec![ContentBlock::Text { text: t10 }]),
            ConversationMessage::user_text(t11),
            ConversationMessage::assistant(vec![ContentBlock::Text { text: t12 }]),
        ],
        compactions: Vec::new(),
    };

    // 10 probes. Each has a question (for human reading) and one or
    // more keyphrases (any match counts as preserved). The marker
    // "EARLY" means the fact is in the first 160 chars of its turn
    // → should survive 160-char block truncation in the heuristic.
    // "BURIED" means past 160 → heuristic drops it. "PRESERVED" means
    // it's in the last 4 turns → kept verbatim regardless of summary.
    struct Probe {
        q: &'static str,
        kind: &'static str,
        keys: &'static [&'static str],
    }
    let probes: &[Probe] = &[
        Probe {
            q: "API endpoint URL?",
            kind: "EARLY",
            keys: &["FACT_API_URL", "api.example.com"],
        },
        Probe {
            q: "Frontend port?",
            kind: "BURIED",
            keys: &["localhost:3000"],
        },
        Probe {
            q: "NPM package installed?",
            kind: "BURIED",
            keys: &["FACT_NPM_PKG", "npm install cors"],
        },
        Probe {
            q: "Second error message?",
            kind: "EARLY",
            keys: &[
                "FACT_CREDENTIALS_ERR",
                "Access-Control-Allow-Credentials must be true",
            ],
        },
        Probe {
            q: "Fix for credentials?",
            kind: "BURIED",
            keys: &["FACT_FIX_CREDENTIALS", "credentials: true"],
        },
        Probe {
            q: "curl HTTP status?",
            kind: "EARLY",
            keys: &["FACT_CURL_STATUS", "HTTP 200 OK but missing"],
        },
        Probe {
            q: "Reverse proxy hint?",
            kind: "BURIED",
            keys: &["FACT_REVERSE_PROXY", "nginx config"],
        },
        Probe {
            q: "Preflight response?",
            kind: "EARLY",
            keys: &["FACT_PREFLIGHT", "returns 204"],
        },
        Probe {
            q: "Explicit preflight fix?",
            kind: "BURIED",
            keys: &["FACT_EXPLICIT_PREFLIGHT", "app.options"],
        },
        Probe {
            q: "Final 401 + token expiry?",
            kind: "PRESERVED",
            keys: &[
                "FACT_401_ERROR",
                "FACT_TOKEN_EXPIRY",
                "401 Unauthorized",
                "JWT exp",
            ],
        },
    ];

    // Run current heuristic compaction.
    let result = compact_session_for_test(&session, CompactionConfig::default());
    let tokens_before = estimate_session_tokens(&session);
    let tokens_after = estimate_session_tokens(&result.compacted_session);

    // The LLM after compaction sees: continuation message (wrapping the
    // summary) + 4 preserved messages. Serialize the whole thing.
    let mut compacted_view = String::new();
    for m in &result.compacted_session.messages {
        for b in &m.blocks {
            match b {
                ContentBlock::Text { text } => compacted_view.push_str(text),
                ContentBlock::ToolResult { output, .. } => compacted_view.push_str(output),
                _ => {}
            }
            compacted_view.push('\n');
        }
    }

    // Score each probe.
    let mut passed = 0usize;
    let mut by_kind = std::collections::BTreeMap::<&str, (usize, usize)>::new(); // (passed, total)
    eprintln!("==== COMPRESSION FIDELITY BENCHMARK ====");
    eprintln!(
        "session: {} messages, {} → {} backend tokens ({:.1}% saved)",
        session.messages.len(),
        tokens_before,
        tokens_after,
        100.0 * (tokens_before as f64 - tokens_after as f64) / tokens_before as f64,
    );
    eprintln!();
    eprintln!(
        "  {:>4}  {:>10}  {:<32}  keyphrases",
        "PASS", "POSITION", "QUESTION"
    );
    eprintln!("  {}", "-".repeat(78));
    for probe in probes {
        let found = probe.keys.iter().any(|k| compacted_view.contains(k));
        if found {
            passed += 1;
        }
        let entry = by_kind.entry(probe.kind).or_insert((0, 0));
        entry.1 += 1;
        if found {
            entry.0 += 1;
        }
        eprintln!(
            "  {:>4}  {:>10}  {:<32}  {:?}",
            if found { "✓" } else { "✗" },
            probe.kind,
            probe.q,
            probe.keys,
        );
    }
    eprintln!();
    eprintln!("Score by fact position:");
    for (kind, (p, t)) in &by_kind {
        eprintln!(
            "  {:>10}: {}/{} ({:.0}%)",
            kind,
            p,
            t,
            100.0 * *p as f64 / *t as f64,
        );
    }
    eprintln!();
    eprintln!(
        "TOTAL: {}/{} ({:.0}%)",
        passed,
        probes.len(),
        100.0 * passed as f64 / probes.len() as f64,
    );
    eprintln!("=========================================");

    // Sanity: compaction must fire and tokens must drop.
    assert!(result.removed_message_count > 0, "compaction must fire");
    assert!(tokens_after < tokens_before, "tokens must drop");
    // Don't assert on the score itself — that's the metric we're measuring.
    // Future LLM-summary upgrade should push this to 10/10.
}
