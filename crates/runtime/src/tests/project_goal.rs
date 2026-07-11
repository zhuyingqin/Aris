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
