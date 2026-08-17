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
            matches_existing_intent: false,
            supporting_evidence_ids: vec!["message-1".to_string(), "message-2".to_string()],
            redirection_evidence_ids: Vec::new(),
        }),
    )
    .expect("apply review")
    .expect("emerging intent");
    assert_eq!(emerging.status, ProjectIntentStatus::Emerging);
    assert_eq!(emerging.supporting_evidence.len(), 2);
    assert_eq!(emerging.supporting_evidence[0].id, "message-1");

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
            matches_existing_intent: false,
            supporting_evidence_ids: Vec::new(),
            redirection_evidence_ids: Vec::new(),
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
            matches_existing_intent: false,
            supporting_evidence_ids: Vec::new(),
            redirection_evidence_ids: Vec::new(),
        }),
    )
    .expect("apply later task")
    .expect("intent remains");
    assert_eq!(
        unchanged.objective,
        "Build a local-first, auditable research workspace."
    );
    assert!(project_intent_path(root.path()).is_file());

    record_project_intent_observations(
        root.path(),
        "session-3",
        vec![
            ProjectIntentObservation {
                id: "message-2".to_string(),
                text: "Move the project toward a local experiment evidence workspace.".to_string(),
            },
            ProjectIntentObservation {
                id: "message-3".to_string(),
                text: "The durable outcome is reproducible research continuity across runs."
                    .to_string(),
            },
            ProjectIntentObservation {
                id: "message-4".to_string(),
                text: "Keep the research workspace local and auditable as the main product."
                    .to_string(),
            },
        ],
    )
    .expect("record sustained redirection");
    let pending = load_project_intent_state(root.path()).expect("load pending evidence");
    assert!(project_intent_needs_review(&pending));
    let updated = apply_project_intent_review(
        root.path(),
        Some(ProjectIntentDraft {
            objective: "Build a local, auditable research evidence workspace.".to_string(),
            confidence: 94,
            matches_existing_intent: false,
            supporting_evidence_ids: vec![
                "message-2".to_string(),
                "message-3".to_string(),
                "message-4".to_string(),
            ],
            redirection_evidence_ids: vec![
                "message-2".to_string(),
                "message-3".to_string(),
                "message-4".to_string(),
            ],
        }),
    )
    .expect("apply updated intent")
    .expect("updated intent");
    assert_eq!(
        updated.objective,
        "Build a local, auditable research evidence workspace."
    );
}

#[test]
fn established_intent_batches_new_evidence_and_survives_ring_buffer_pruning() {
    let root = tempfile::tempdir().expect("temp project");
    for index in 0..24 {
        record_project_intent_observations(
            root.path(),
            "session-1",
            vec![ProjectIntentObservation {
                id: format!("message-{index}"),
                text: format!("Durable research workspace requirement number {index}"),
            }],
        )
        .expect("record initial evidence");
    }
    apply_project_intent_review(
        root.path(),
        Some(ProjectIntentDraft {
            objective: "Build a durable research workspace.".to_string(),
            confidence: 95,
            matches_existing_intent: false,
            supporting_evidence_ids: vec!["message-0".to_string(), "message-1".to_string()],
            redirection_evidence_ids: Vec::new(),
        }),
    )
    .expect("establish intent");

    for index in 24..26 {
        let state = record_project_intent_observations(
            root.path(),
            "session-2",
            vec![ProjectIntentObservation {
                id: format!("message-{index}"),
                text: format!("Redirect the durable product outcome number {index}"),
            }],
        )
        .expect("record batched evidence");
        assert!(!project_intent_needs_review(&state));
    }
    let due = record_project_intent_observations(
        root.path(),
        "session-2",
        vec![ProjectIntentObservation {
            id: "message-26".to_string(),
            text: "Redirect the durable product outcome number 26".to_string(),
        }],
    )
    .expect("record threshold evidence");
    assert_eq!(due.evidence.len(), 24);
    assert!(project_intent_needs_review(&due));
}

#[test]
fn a_new_intent_without_valid_user_citations_is_not_applied() {
    let root = tempfile::tempdir().expect("temp project");
    for index in 0..2 {
        record_project_intent_observations(
            root.path(),
            "session-1",
            vec![ProjectIntentObservation {
                id: format!("message-{index}"),
                text: format!("Build an auditable research workspace requirement {index}"),
            }],
        )
        .expect("record evidence");
    }

    let intent = apply_project_intent_review(
        root.path(),
        Some(ProjectIntentDraft {
            objective: "Build an auditable research workspace.".to_string(),
            confidence: 99,
            matches_existing_intent: false,
            supporting_evidence_ids: vec!["missing-id".to_string()],
            redirection_evidence_ids: Vec::new(),
        }),
    )
    .expect("apply unsupported review");
    assert!(intent.is_none());
}

#[test]
fn low_confidence_redirection_does_not_replace_or_repeatedly_review_established_intent() {
    let root = tempfile::tempdir().expect("temp project");
    for index in 0..3 {
        record_project_intent_observations(
            root.path(),
            "session-1",
            vec![ProjectIntentObservation {
                id: format!("initial-{index}"),
                text: format!("Build a durable research workspace requirement {index}"),
            }],
        )
        .expect("record initial evidence");
    }
    apply_project_intent_review(
        root.path(),
        Some(ProjectIntentDraft {
            objective: "Build a durable research workspace.".to_string(),
            confidence: 95,
            matches_existing_intent: false,
            supporting_evidence_ids: vec!["initial-0".to_string(), "initial-1".to_string()],
            redirection_evidence_ids: Vec::new(),
        }),
    )
    .expect("establish intent");

    for index in 0..3 {
        record_project_intent_observations(
            root.path(),
            "session-2",
            vec![ProjectIntentObservation {
                id: format!("uncertain-{index}"),
                text: format!("Possibly redirect the product toward another outcome {index}"),
            }],
        )
        .expect("record uncertain evidence");
    }
    let intent = apply_project_intent_review(
        root.path(),
        Some(ProjectIntentDraft {
            objective: "Build an unrelated product.".to_string(),
            confidence: 60,
            matches_existing_intent: false,
            supporting_evidence_ids: Vec::new(),
            redirection_evidence_ids: Vec::new(),
        }),
    )
    .expect("review uncertain redirection")
    .expect("preserve intent");

    assert_eq!(intent.objective, "Build a durable research workspace.");
    assert_eq!(intent.status, ProjectIntentStatus::Established);
    assert!(!project_intent_needs_review(
        &load_project_intent_state(root.path()).expect("load reviewed state")
    ));
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

#[test]
fn established_intent_replacement_requires_cited_explicit_redirection_evidence() {
    let root = tempfile::tempdir().expect("temp project");
    for index in 0..3 {
        record_project_intent_observations(
            root.path(),
            "session-initial",
            vec![ProjectIntentObservation {
                id: format!("initial-{index}"),
                text: format!("Build a durable research workspace requirement {index}"),
            }],
        )
        .expect("record initial evidence");
    }
    apply_project_intent_review(
        root.path(),
        Some(ProjectIntentDraft {
            objective: "Build a durable research workspace.".to_string(),
            confidence: 95,
            matches_existing_intent: false,
            supporting_evidence_ids: vec!["initial-0".to_string(), "initial-1".to_string()],
            redirection_evidence_ids: Vec::new(),
        }),
    )
    .expect("establish intent");

    for index in 0..3 {
        record_project_intent_observations(
            root.path(),
            "session-new-work",
            vec![ProjectIntentObservation {
                id: format!("new-work-{index}"),
                text: format!("Implement a short-lived UI experiment {index}"),
            }],
        )
        .expect("record non-redirection evidence");
    }
    let preserved = apply_project_intent_review(
        root.path(),
        Some(ProjectIntentDraft {
            objective: "Build an unrelated product.".to_string(),
            confidence: 100,
            matches_existing_intent: false,
            supporting_evidence_ids: Vec::new(),
            redirection_evidence_ids: Vec::new(),
        }),
    )
    .expect("review unsupported redirection")
    .expect("preserve established intent");

    assert_eq!(preserved.objective, "Build a durable research workspace.");
    assert_eq!(preserved.status, ProjectIntentStatus::Established);
}

#[test]
fn equivalent_objective_wording_preserves_the_established_text() {
    let root = tempfile::tempdir().expect("temp project");
    for index in 0..3 {
        record_project_intent_observations(
            root.path(),
            "session-1",
            vec![ProjectIntentObservation {
                id: format!("message-{index}"),
                text: format!("Build a durable research workspace requirement {index}"),
            }],
        )
        .expect("record initial evidence");
    }
    apply_project_intent_review(
        root.path(),
        Some(ProjectIntentDraft {
            objective: "Build a durable research workspace.".to_string(),
            confidence: 95,
            matches_existing_intent: false,
            supporting_evidence_ids: vec!["message-0".to_string(), "message-1".to_string()],
            redirection_evidence_ids: Vec::new(),
        }),
    )
    .expect("establish intent");

    let preserved = apply_project_intent_review(
        root.path(),
        Some(ProjectIntentDraft {
            objective: "Build a durable research workspace!".to_string(),
            confidence: 96,
            matches_existing_intent: false,
            supporting_evidence_ids: Vec::new(),
            redirection_evidence_ids: Vec::new(),
        }),
    )
    .expect("apply equivalent wording")
    .expect("intent remains");

    assert_eq!(preserved.objective, "Build a durable research workspace.");
}

#[test]
fn loading_intent_evidence_orders_it_and_migrates_legacy_user_roles() {
    let root = tempfile::tempdir().expect("temp project");
    let path = project_intent_path(root.path());
    std::fs::create_dir_all(path.parent().expect("intent parent")).expect("create intent dir");
    std::fs::write(
        &path,
        r#"{
          "intent": null,
          "evidence": [
            {"id":"later","sessionId":"s","text":"Build a durable research workspace","observedAt":"2026-01-02T00:00:00Z"},
            {"id":"earlier","sessionId":"s","text":"Keep research work auditable","observedAt":"2026-01-01T00:00:00Z"}
          ],
          "reviewedEvidenceCount": 0
        }"#,
    )
    .expect("write legacy intent state");

    let state = load_project_intent_state(root.path()).expect("load sorted intent state");
    assert_eq!(state.evidence[0].id, "earlier");
    assert_eq!(state.evidence[1].id, "later");
    assert!(state
        .evidence
        .iter()
        .all(|item| item.role == ProjectIntentEvidenceRole::User));
}
