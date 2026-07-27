use super::*;

#[test]
fn goal_lifecycle_and_brief_are_project_scoped() {
    let root = tempfile::tempdir().expect("temp project");
    fs::write(
        root.path().join("AGENTS.md"),
        "# Guidance\n\n## Product north star\n\nBuild durable research continuity.\n",
    )
    .expect("write agents");

    let goal = start_project_goal(
        root.path(),
        ProjectGoalDraft {
            objective: "Implement project goals".to_string(),
            success_criteria: vec!["Goal survives new conversations".to_string()],
            recent_status: "Implementation started".to_string(),
        },
        Some("session-1".to_string()),
    )
    .expect("start goal");
    assert_eq!(goal.status, ProjectGoalStatus::Active);
    assert!(project_goal_path(root.path()).is_file());

    let paused = pause_project_goal(root.path()).expect("pause goal");
    assert_eq!(paused.status, ProjectGoalStatus::Paused);
    let resumed = resume_project_goal(root.path()).expect("resume goal");
    assert_eq!(resumed.status, ProjectGoalStatus::Active);
    update_project_goal_progress(root.path(), "Focused tests pass").expect("progress");
    let complete = complete_project_goal(root.path(), Some("All checks pass")).expect("complete");
    assert_eq!(complete.status, ProjectGoalStatus::Complete);

    let brief = project_brief(root.path()).expect("project brief");
    assert_eq!(brief.mission, "Build durable research continuity.");
    assert_eq!(brief.goal.expect("goal").recent_status, "All checks pass");
}

#[test]
fn project_goal_prompt_includes_success_criteria_and_evidence_rule() {
    let root = tempfile::tempdir().expect("temp project");
    start_project_goal(
        root.path(),
        ProjectGoalDraft {
            objective: "Ship independently reviewed Chat changes".to_string(),
            success_criteria: vec![
                "Reviewer uses a distinct model identity".to_string(),
                "Focused tests pass".to_string(),
            ],
            recent_status: "Implementation started".to_string(),
        },
        Some("session-review".to_string()),
    )
    .expect("start goal");

    let prompt = render_project_goal_prompt(root.path());
    assert!(prompt.contains("[0] Reviewer uses a distinct model identity"));
    assert!(prompt.contains("[1] Focused tests pass"));
    assert!(prompt.contains("independent Reviewer passes"));
    assert!(prompt.contains("polished prose"));
}

#[test]
fn independent_review_can_verify_specific_goal_criteria_with_evidence() {
    let root = tempfile::tempdir().expect("temp project");
    start_project_goal(
        root.path(),
        ProjectGoalDraft {
            objective: "Ship review gate".to_string(),
            success_criteria: vec![
                "Reviewer is independent".to_string(),
                "Tests pass".to_string(),
            ],
            recent_status: String::new(),
        },
        None,
    )
    .expect("start goal");

    let goal = update_project_goal_verified_progress(
        root.path(),
        "Independent identity verified",
        &[0, 99],
        &["executor and reviewer identities differ".to_string()],
        "openai / reviewer-model",
    )
    .expect("update verified progress")
    .expect("goal");

    assert_eq!(goal.verified_criteria.len(), 1);
    assert_eq!(goal.verified_criteria[0].criterion_index, 0);
    assert_eq!(
        goal.verified_criteria[0].reviewer,
        "openai / reviewer-model"
    );
    let prompt = render_project_goal_prompt(root.path());
    assert!(prompt.contains("[verified] [0] Reviewer is independent"));
    assert!(prompt.contains("[pending] [1] Tests pass"));
}

#[test]
fn verified_progress_ignores_empty_or_invalid_criterion_sets() {
    let root = tempfile::tempdir().expect("temp project");
    start_project_goal(
        root.path(),
        ProjectGoalDraft {
            objective: "Ship review gate".to_string(),
            success_criteria: vec!["Focused tests pass".to_string()],
            recent_status: "Not started".to_string(),
        },
        None,
    )
    .expect("start goal");

    let goal = update_project_goal_verified_progress(
        root.path(),
        "Unrelated research completed",
        &[99],
        &["some unrelated evidence".to_string()],
        "independent reviewer",
    )
    .expect("ignore invalid progress")
    .expect("goal");

    assert_eq!(goal.recent_status, "Not started");
    assert!(goal.verified_criteria.is_empty());
}

#[test]
fn active_goal_requires_explicit_replace() {
    let root = tempfile::tempdir().expect("temp project");
    let draft = ProjectGoalDraft {
        objective: "First goal".to_string(),
        success_criteria: Vec::new(),
        recent_status: String::new(),
    };
    start_project_goal(root.path(), draft, None).expect("first goal");
    let error = start_project_goal(
        root.path(),
        ProjectGoalDraft {
            objective: "Second goal".to_string(),
            success_criteria: Vec::new(),
            recent_status: String::new(),
        },
        None,
    )
    .expect_err("active goal should block start");
    assert!(error.contains("/goal replace"));
}

#[test]
fn paused_goal_requires_resume_or_explicit_replace() {
    let root = tempfile::tempdir().expect("temp project");
    start_project_goal(
        root.path(),
        ProjectGoalDraft {
            objective: "First goal".to_string(),
            success_criteria: Vec::new(),
            recent_status: String::new(),
        },
        None,
    )
    .expect("first goal");
    pause_project_goal(root.path()).expect("pause goal");

    let error = start_project_goal(
        root.path(),
        ProjectGoalDraft {
            objective: "Second goal".to_string(),
            success_criteria: Vec::new(),
            recent_status: String::new(),
        },
        None,
    )
    .expect_err("paused goal should block start");

    assert!(error.contains("/goal resume"));
    assert_eq!(
        load_project_goal(root.path())
            .expect("read goal")
            .expect("goal")
            .objective,
        "First goal"
    );
}

#[test]
fn legacy_model_identity_answer_is_not_loaded_as_a_project_goal() {
    let root = tempfile::tempdir().expect("temp project");
    let path = project_goal_path(root.path());
    fs::create_dir_all(path.parent().expect("goal parent")).expect("create goal directory");
    fs::write(
        &path,
        serde_json::json!({
            "objective": "回答用户关于助手模型身份的询问",
            "successCriteria": [
                "用户提出模型身份问题",
                "助手明确给出模型名称",
                "回答语言与用户一致（中文）"
            ],
            "verifiedCriteria": [],
            "recentStatus": "Answer completed",
            "status": "active",
            "sourceSessionId": "legacy-session",
            "createdAt": "2026-07-11T16:55:05Z",
            "updatedAt": "2026-07-11T16:55:05Z"
        })
        .to_string(),
    )
    .expect("write legacy goal");

    assert!(load_project_goal(root.path()).expect("load goal").is_none());
    assert!(project_brief(root.path())
        .expect("project brief")
        .goal
        .is_none());
    let prompt = render_project_goal_prompt(root.path());
    assert!(prompt.contains("Current milestone: none active"));
    assert!(!prompt.contains("MiniMax"));
    assert!(
        path.is_file(),
        "quarantined legacy data remains recoverable"
    );
}

#[test]
fn one_off_model_identity_answer_cannot_be_started_as_a_milestone() {
    let root = tempfile::tempdir().expect("temp project");
    let error = start_project_goal(
        root.path(),
        ProjectGoalDraft {
            objective: "Answer the user model identity question".to_string(),
            success_criteria: vec![
                "User asked for the model name".to_string(),
                "Assistant states the model name".to_string(),
            ],
            recent_status: String::new(),
        },
        Some("one-off-chat".to_string()),
    )
    .expect_err("one-off answer must not become project state");

    assert!(error.contains("cannot be stored as a project milestone"));
    assert!(!project_goal_path(root.path()).exists());
}

#[test]
fn inactive_goal_is_not_injected_as_the_current_milestone() {
    let root = tempfile::tempdir().expect("temp project");
    start_project_goal(
        root.path(),
        ProjectGoalDraft {
            objective: "Ship a durable artifact".to_string(),
            success_criteria: vec!["Artifact tests pass".to_string()],
            recent_status: String::new(),
        },
        None,
    )
    .expect("start goal");
    complete_project_goal(root.path(), Some("Delivered")).expect("complete goal");

    let prompt = render_project_goal_prompt(root.path());
    assert!(prompt.contains("Current milestone: none active"));
    assert!(!prompt.contains("Ship a durable artifact"));
    assert!(!prompt.contains("Artifact tests pass"));
}
