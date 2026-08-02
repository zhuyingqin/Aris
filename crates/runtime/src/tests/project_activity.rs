use super::*;

#[test]
fn project_activity_is_refreshable_and_project_scoped() {
    let root = tempfile::tempdir().expect("temp project");
    let first = save_project_activity(
        root.path(),
        ProjectActivityDraft {
            core_focus: "Build conversation-aware project summaries".to_string(),
            related_work: vec![
                "Review every saved conversation".to_string(),
                "Refresh only when the source changes".to_string(),
            ],
            conversation_count: 3,
            message_count: 18,
            question_count: 9,
            session_cursors: Default::default(),
            context_checkpoints: Default::default(),
            reviewer: "openai / gpt-reviewer".to_string(),
            source_fingerprint: "sha256:first".to_string(),
        },
    )
    .expect("save first activity");
    assert_eq!(first.conversation_count, 3);
    assert_eq!(first.question_count, 9);
    assert!(project_activity_path(root.path()).is_file());

    let second = save_project_activity(
        root.path(),
        ProjectActivityDraft {
            core_focus: "Validate the refreshed summary in the desktop UI".to_string(),
            related_work: Vec::new(),
            conversation_count: 4,
            message_count: 22,
            question_count: 12,
            session_cursors: Default::default(),
            context_checkpoints: Default::default(),
            reviewer: "openai / gpt-reviewer".to_string(),
            source_fingerprint: "sha256:second".to_string(),
        },
    )
    .expect("refresh activity");

    assert_ne!(first.core_focus, second.core_focus);
    assert_eq!(
        load_project_activity(root.path())
            .expect("load activity")
            .expect("activity")
            .source_fingerprint,
        "sha256:second"
    );

    clear_project_activity(root.path()).expect("clear generated activity");
    assert!(load_project_activity(root.path())
        .expect("load cleared activity")
        .is_none());
}

#[test]
fn project_activity_cleans_and_bounds_llm_output() {
    let root = tempfile::tempdir().expect("temp project");
    let activity = save_project_activity(
        root.path(),
        ProjectActivityDraft {
            core_focus: "  Build   a durable summary  ".to_string(),
            related_work: (0..8)
                .map(|index| format!(" related   work {index} "))
                .collect(),
            conversation_count: 1,
            message_count: 2,
            question_count: 1,
            session_cursors: Default::default(),
            context_checkpoints: Default::default(),
            reviewer: String::new(),
            source_fingerprint: "fingerprint".to_string(),
        },
    )
    .expect("save activity");

    assert_eq!(activity.core_focus, "Build a durable summary");
    assert_eq!(activity.related_work.len(), MAX_RELATED_WORK_ITEMS);
    assert_eq!(activity.reviewer, "LLM reviewer");
}

#[test]
fn context_checkpoint_updates_do_not_claim_an_llm_review() {
    let root = tempfile::tempdir().expect("temp project");
    let activity = save_project_activity(
        root.path(),
        ProjectActivityDraft {
            core_focus: "Keep the project summary current".to_string(),
            related_work: Vec::new(),
            conversation_count: 1,
            message_count: 6,
            question_count: 3,
            session_cursors: Default::default(),
            context_checkpoints: Default::default(),
            reviewer: "reviewer".to_string(),
            source_fingerprint: "fingerprint".to_string(),
        },
    )
    .expect("save activity");

    let updated = update_project_activity_tracking(
        root.path(),
        None,
        "chat-a".to_string(),
        ProjectActivityContextCheckpoint {
            context_tokens: 90_000,
            compaction_budget: 100_000,
        },
    )
    .expect("update checkpoint")
    .expect("activity");

    assert_eq!(updated.reviewed_at, activity.reviewed_at);
    assert_eq!(updated.core_focus, activity.core_focus);
    assert_eq!(updated.context_checkpoints["chat-a"].context_tokens, 90_000);
}
