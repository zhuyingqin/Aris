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
