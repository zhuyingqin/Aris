use super::*;

#[test]
fn project_intent_requires_accumulated_evidence_and_preserves_established_goal() {
    let root = tempfile::tempdir().expect("temp project");
    let first = record_project_intent_observations(
        root.path(),
        "session-1",
        vec![ProjectIntentObservation {
            id: "message-1".to_string(),
            text: "Build a local-first research workspace.".to_string(),
        }],
    )
    .expect("record first");
    assert!(!project_intent_needs_review(&first));

    let second = record_project_intent_observations(
        root.path(),
        "session-1",
        vec![ProjectIntentObservation {
            id: "message-2".to_string(),
            text: "Research progress should remain auditable across conversations.".to_string(),
        }],
    )
    .expect("record second");
    assert!(project_intent_needs_review(&second));
    let emerging = apply_project_intent_review(
        root.path(),
        Some(ProjectIntentDraft {
            objective: "Build a local-first, auditable research workspace.".to_string(),
            confidence: 78,
        }),
    )
    .expect("apply review")
    .expect("emerging intent");
    assert_eq!(emerging.status, ProjectIntentStatus::Emerging);

    record_project_intent_observations(
        root.path(),
        "session-2",
        vec![ProjectIntentObservation {
            id: "message-1".to_string(),
            text: "Keep independent review and durable research continuity.".to_string(),
        }],
    )
    .expect("record third");
    let established = apply_project_intent_review(
        root.path(),
        Some(ProjectIntentDraft {
            objective: "Build a local-first, auditable research workspace.".to_string(),
            confidence: 92,
        }),
    )
    .expect("apply established review")
    .expect("established intent");
    assert_eq!(established.status, ProjectIntentStatus::Established);

    let unchanged = apply_project_intent_review(
        root.path(),
        Some(ProjectIntentDraft {
            objective: "Move a chat panel.".to_string(),
            confidence: 100,
        }),
    )
    .expect("apply later task")
    .expect("intent remains");
    assert_eq!(
        unchanged.objective,
        "Build a local-first, auditable research workspace."
    );
    assert!(project_intent_path(root.path()).is_file());
}

#[test]
fn project_intent_rejects_greetings_option_replies_and_short_test_pings() {
    for text in [
        "hello",
        "你好！👋",
        "A+c",
        "我再测试一下",
        "我来看看你能不能远程读到你调用工具了",
        "ok",
    ] {
        assert!(
            !is_substantive_project_intent_text(text),
            "{text:?} must not become durable project evidence"
        );
    }
    assert!(is_substantive_project_intent_text(
        "完成桌面端到手机网页的无登录远程控制"
    ));
}

#[test]
fn recording_new_evidence_prunes_legacy_noise() {
    let root = tempfile::tempdir().expect("temp project");
    let path = project_intent_path(root.path());
    std::fs::create_dir_all(path.parent().expect("intent parent")).expect("create intent dir");
    std::fs::write(
        &path,
        r#"{
          "intent": null,
          "evidence": [
            {"id":"old-1","sessionId":"s","text":"hello","observedAt":"now"},
            {"id":"old-2","sessionId":"s","text":"Build an auditable research workspace","observedAt":"now"}
          ],
          "reviewedEvidenceCount": 2
        }"#,
    )
    .expect("write legacy state");

    let state = record_project_intent_observations(
        root.path(),
        "session-2",
        vec![ProjectIntentObservation {
            id: "message-3".to_string(),
            text: "Keep independent review across every research milestone.".to_string(),
        }],
    )
    .expect("record evidence");

    assert_eq!(state.evidence.len(), 2);
    assert!(state.evidence.iter().all(|item| item.text != "hello"));
}

#[test]
fn loading_legacy_state_prunes_and_persists_noise_without_waiting_for_a_new_turn() {
    let root = tempfile::tempdir().expect("temp project");
    let path = project_intent_path(root.path());
    std::fs::create_dir_all(path.parent().expect("intent parent")).expect("create intent dir");
    std::fs::write(
        &path,
        r#"{
          "intent": null,
          "evidence": [
            {"id":"noise","sessionId":"s","text":"A+c","observedAt":"now"},
            {"id":"goal","sessionId":"s","text":"Preserve independent review evidence","observedAt":"now"}
          ],
          "reviewedEvidenceCount": 2
        }"#,
    )
    .expect("write legacy state");

    let state = load_project_intent_state(root.path()).expect("load and migrate");
    assert_eq!(state.evidence.len(), 1);
    assert_eq!(state.reviewed_evidence_count, 1);
    let persisted = std::fs::read_to_string(path).expect("read migrated state");
    assert!(!persisted.contains("A+c"));
}
