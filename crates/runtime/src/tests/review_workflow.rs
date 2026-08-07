use tempfile::tempdir;

use super::*;

fn create_input() -> ReviewWorkflowCreateInput {
    ReviewWorkflowCreateInput {
        topic: "large language models for scientific discovery".to_string(),
        keywords: vec!["LLM".to_string(), "scientific discovery".to_string()],
        languages: vec!["English".to_string()],
        databases: vec!["openalex".to_string(), "scopus".to_string()],
        year_from: 2022,
        year_to: 2026,
    }
}

#[test]
fn creates_and_lists_a_durable_review_workflow() {
    let workspace = tempdir().expect("workspace");
    let run = create_review_workflow(workspace.path(), create_input()).expect("create");

    assert_eq!(run.protocol_version, REVIEW_WORKFLOW_PROTOCOL_VERSION);
    assert_eq!(run.context_policy.abstract_batch_size, 50);
    assert_eq!(run.stages.len(), 16);
    assert_eq!(run.stages[0].status, ReviewWorkflowStageStatus::Ready);
    assert!(run.stages[0].reviewer_gate.required);
    assert!(run.stages[1].reviewer_gate.required);

    let loaded = load_review_workflow(workspace.path(), &run.id)
        .expect("load")
        .expect("run");
    assert_eq!(loaded, run);

    let summaries = list_review_workflows(workspace.path()).expect("list");
    assert_eq!(summaries.len(), 1);
    assert_eq!(summaries[0].id, run.id);
}

#[test]
fn loading_a_legacy_run_repairs_a_passed_active_stage() {
    let workspace = tempdir().expect("workspace");
    let mut run = create_review_workflow(workspace.path(), create_input()).expect("create");
    run.stages[0].status = ReviewWorkflowStageStatus::Passed;
    run.stages[1].status = ReviewWorkflowStageStatus::Ready;

    let normalized = migrate_run(run).expect("legacy active stage is normalized");
    assert_eq!(normalized.active_stage_id, "review-landscape-search");
}

#[test]
fn loading_legacy_non_ab_grade_mappings_removes_them() {
    let workspace = tempdir().expect("workspace");
    let mut run = create_review_workflow(workspace.path(), create_input()).expect("create");
    run.primary_record_ids = vec![
        "paper-a".to_string(),
        "paper-c".to_string(),
        "paper-d".to_string(),
    ];
    run.paper_grades = vec![
        WorkflowPaperGrade {
            record_id: "paper-a".to_string(),
            original_index: 1,
            grade: "A".to_string(),
            key_finding: "included".to_string(),
            rationale: "core evidence".to_string(),
            method: "independent_reviewer_batched".to_string(),
        },
        WorkflowPaperGrade {
            record_id: "paper-c".to_string(),
            original_index: 2,
            grade: "c".to_string(),
            key_finding: "context only".to_string(),
            rationale: "lower priority".to_string(),
            method: "independent_reviewer_batched".to_string(),
        },
        WorkflowPaperGrade {
            record_id: "paper-d".to_string(),
            original_index: 3,
            grade: "d".to_string(),
            key_finding: "not included".to_string(),
            rationale: "out of scope".to_string(),
            method: "independent_reviewer_batched".to_string(),
        },
    ];
    run.paper_mappings = vec![
        WorkflowPaperMapping {
            record_id: "paper-a".to_string(),
            original_index: 1,
            zotero_locator: "A Author 2024".to_string(),
            direct_section_id: Some("2.1".to_string()),
            indirect_section_id: None,
            contribution: "valid mapping".to_string(),
        },
        WorkflowPaperMapping {
            record_id: "paper-c".to_string(),
            original_index: 2,
            zotero_locator: "C Author 2024".to_string(),
            direct_section_id: Some("2.1".to_string()),
            indirect_section_id: Some("3.2".to_string()),
            contribution: "legacy mapping".to_string(),
        },
        WorkflowPaperMapping {
            record_id: "paper-d".to_string(),
            original_index: 3,
            zotero_locator: "D Author 2024".to_string(),
            direct_section_id: Some("2.1".to_string()),
            indirect_section_id: Some("3.2".to_string()),
            contribution: "legacy mapping".to_string(),
        },
    ];

    let normalized = migrate_run(run).expect("legacy mapping is normalized");
    assert_eq!(normalized.paper_mappings.len(), 1);
    assert_eq!(normalized.paper_mappings[0].record_id, "paper-a");
}

#[test]
fn writing_a_passed_active_stage_advances_the_server_cursor() {
    let workspace = tempdir().expect("workspace");
    let run = create_review_workflow(workspace.path(), create_input()).expect("create");
    let mut next = run.clone();
    next.reviewer_disabled = true;
    next.stages[0].status = ReviewWorkflowStageStatus::Passed;
    next.stages[0].reviewer_gate.status = ReviewerGateStatus::Skipped;
    next.stages[1].status = ReviewWorkflowStageStatus::Ready;

    let saved = save_review_workflow(
        workspace.path(),
        ReviewWorkflowSaveInput {
            expected_revision: run.revision,
            run: next,
            actor: "Executor".to_string(),
            action: "stale_active_stage".to_string(),
            summary: "attempted stale active stage write".to_string(),
            stage_id: Some("scope-and-plan".to_string()),
            lease_owner_turn_id: None,
        },
    )
    .expect("server canonicalizes the active stage");
    assert_eq!(saved.active_stage_id, "review-landscape-search");
}

#[test]
fn legacy_query_quality_round_defaults_new_review_provenance() {
    let iteration: QueryQualityIteration = serde_json::from_value(serde_json::json!({
        "id": "quality-1",
        "iteration": 1,
        "pathId": "abc",
        "query": "TITLE-ABS-KEY(a AND b AND c)",
        "sampleRecordIds": [],
        "sampleSize": 100,
        "relevantCount": 24,
        "lowRelevanceCount": 76,
        "estimatedPrecision": 0.24,
        "falsePositivePatterns": ["shared acronym"],
        "adjustmentDirections": ["tighten concept C"],
        "recommendation": "revise",
        "reviewerApproved": false,
        "createdAt": "2026-08-03T00:00:00Z"
    }))
    .expect("legacy query-quality iteration");

    assert_eq!(iteration.reviewer_status, None);
    assert_eq!(iteration.reviewer_summary, None);
    assert!(iteration.reviewer_issues.is_empty());
    assert!(iteration.quality_issues.is_empty());
}

#[test]
fn renames_and_deletes_a_durable_review_workflow() {
    let workspace = tempdir().expect("workspace");
    let run = create_review_workflow(workspace.path(), create_input()).expect("create");

    let renamed = rename_review_workflow(workspace.path(), &run.id, "  LLM discovery review  ")
        .expect("rename");
    assert_eq!(renamed.title, "LLM discovery review");
    assert_eq!(renamed.revision, run.revision + 1);
    assert_eq!(
        renamed.events.last().expect("rename event").action,
        "workflow_renamed"
    );
    assert_eq!(
        list_review_workflows(workspace.path()).expect("list")[0].title,
        "LLM discovery review"
    );

    delete_review_workflow(workspace.path(), &run.id).expect("delete");
    assert!(load_review_workflow(workspace.path(), &run.id)
        .expect("load")
        .is_none());
    assert!(list_review_workflows(workspace.path())
        .expect("list")
        .is_empty());
}

#[test]
fn count_branch_waits_for_exhausted_coverage() {
    assert_eq!(
        branch_for_review_count(76, false),
        ReviewCountBranch::Unknown
    );
    assert_eq!(
        branch_for_review_count(9, true),
        ReviewCountBranch::Insufficient
    );
    assert_eq!(
        branch_for_review_count(10, true),
        ReviewCountBranch::Focused
    );
    assert_eq!(branch_for_review_count(50, true), ReviewCountBranch::Broad);
}

#[test]
fn reviewer_gate_prevents_unreviewed_stage_from_passing() {
    let workspace = tempdir().expect("workspace");
    let run = create_review_workflow(workspace.path(), create_input()).expect("create");
    let mut next = run.clone();
    next.stages[0].status = ReviewWorkflowStageStatus::Passed;

    let error = save_review_workflow(
        workspace.path(),
        ReviewWorkflowSaveInput {
            expected_revision: run.revision,
            run: next,
            actor: "executor".to_string(),
            action: "plan_generated".to_string(),
            summary: "generated the search plan".to_string(),
            stage_id: Some("scope-and-plan".to_string()),
            lease_owner_turn_id: None,
        },
    )
    .expect_err("gate must reject");
    assert!(error.contains("Reviewer"));
}

/// Marks a stage the way a completed run does, so a test can walk the cursor
/// forward without reproducing every stage's own evidence invariants.
fn mark_passed(stage: &mut ReviewWorkflowStage) {
    stage.status = ReviewWorkflowStageStatus::Passed;
    stage.completed_at = Some("2026-08-01T00:00:00Z".to_string());
    if stage.reviewer_gate.required {
        stage.reviewer_gate.status = ReviewerGateStatus::Approved;
        stage.reviewer_gate.reviewer = Some("Independent Reviewer".to_string());
        stage.reviewer_gate.reviewed_at = Some("2026-08-01T00:00:00Z".to_string());
    }
}

fn save_input(
    previous: &ReviewWorkflowRun,
    next: ReviewWorkflowRun,
    action: &str,
    stage_id: &str,
) -> ReviewWorkflowSaveInput {
    ReviewWorkflowSaveInput {
        expected_revision: previous.revision,
        run: next,
        actor: "user".to_string(),
        action: action.to_string(),
        summary: "test transition".to_string(),
        stage_id: Some(stage_id.to_string()),
        lease_owner_turn_id: None,
    }
}

/// Pins the shape the desktop's "回到这一步修改" rewind writes.
///
/// The ledger has always permitted a backward cursor move, but nothing produced
/// one until the client gained a general reopen, so the accepting branch was
/// never exercised. A regression here would surface as a workflow that can only
/// ever move forwards.
#[test]
fn accepts_reopening_an_upstream_stage_once_downstream_work_is_cleared() {
    let workspace = tempdir().expect("workspace");
    let run = create_review_workflow(workspace.path(), create_input()).expect("create");

    let mut advanced = run.clone();
    mark_passed(&mut advanced.stages[0]);
    advanced.active_stage_id = "review-landscape-search".to_string();
    let run = save_review_workflow(
        workspace.path(),
        save_input(&run, advanced, "plan_approved", "scope-and-plan"),
    )
    .expect("advance to the search stage");

    let mut advanced = run.clone();
    mark_passed(&mut advanced.stages[1]);
    advanced.active_stage_id = "review-eligibility".to_string();
    let run = save_review_workflow(
        workspace.path(),
        save_input(&run, advanced, "search_completed", "review-landscape-search"),
    )
    .expect("advance to the eligibility stage");

    // What the client sends when the user reopens stage 01: the stage itself is
    // no longer passed, everything after it is back to not-started, and the
    // cursor moves back two stages at once.
    let mut reopened = run.clone();
    for stage in &mut reopened.stages {
        if stage.ordinal == 1 {
            stage.status = ReviewWorkflowStageStatus::WaitingUser;
            stage.completed_at = None;
            stage.reviewer_gate.status = ReviewerGateStatus::Pending;
            stage.reviewer_gate.reviewer = None;
            stage.reviewer_gate.reviewed_at = None;
        } else {
            stage.status = ReviewWorkflowStageStatus::NotStarted;
            stage.completed_at = None;
            if stage.reviewer_gate.required {
                stage.reviewer_gate.status = ReviewerGateStatus::Pending;
                stage.reviewer_gate.reviewer = None;
                stage.reviewer_gate.reviewed_at = None;
            }
        }
    }
    reopened.active_stage_id = "scope-and-plan".to_string();
    reopened.plan_approved = false;
    let saved = save_review_workflow(
        workspace.path(),
        save_input(&run, reopened, "stage_reopened", "scope-and-plan"),
    )
    .expect("a cleared rewind is a legal transition");

    assert_eq!(saved.active_stage_id, "scope-and-plan");
    assert_eq!(saved.stages[0].status, ReviewWorkflowStageStatus::WaitingUser);
    assert_eq!(saved.events.last().expect("event").action, "stage_reopened");
    // The cursor survives a reload: nothing normalises it back onto the stage
    // the run had reached.
    let reloaded = load_review_workflow(workspace.path(), &saved.id)
        .expect("load")
        .expect("run");
    assert_eq!(reloaded.active_stage_id, "scope-and-plan");
}

#[test]
fn rejects_a_rewind_that_leaves_a_passed_stage_behind_it() {
    let workspace = tempdir().expect("workspace");
    let run = create_review_workflow(workspace.path(), create_input()).expect("create");

    let mut advanced = run.clone();
    mark_passed(&mut advanced.stages[0]);
    advanced.active_stage_id = "review-landscape-search".to_string();
    let run = save_review_workflow(
        workspace.path(),
        save_input(&run, advanced, "plan_approved", "scope-and-plan"),
    )
    .expect("advance to the search stage");

    let mut advanced = run.clone();
    mark_passed(&mut advanced.stages[1]);
    advanced.active_stage_id = "review-eligibility".to_string();
    let run = save_review_workflow(
        workspace.path(),
        save_input(&run, advanced, "search_completed", "review-landscape-search"),
    )
    .expect("advance to the eligibility stage");

    // Rewinding without discarding the search that stage 01 produced would let
    // a finished search outlive the plan it came from.
    let mut reopened = run.clone();
    reopened.stages[0].status = ReviewWorkflowStageStatus::WaitingUser;
    reopened.stages[0].completed_at = None;
    reopened.active_stage_id = "scope-and-plan".to_string();
    // Two rules can catch this — the passed stage has an unfinished predecessor,
    // and the rewind left a passed stage behind the cursor. Which one reports
    // first is an implementation detail; that the write is refused and the
    // ledger is untouched is not.
    save_review_workflow(
        workspace.path(),
        save_input(&run, reopened, "stage_reopened", "scope-and-plan"),
    )
    .expect_err("stale downstream work must block the rewind");

    let stored = load_review_workflow(workspace.path(), &run.id)
        .expect("load")
        .expect("run");
    assert_eq!(stored.active_stage_id, "review-eligibility");
    assert_eq!(stored.revision, run.revision);
}

#[test]
fn rejects_branching_a_partial_search() {
    let workspace = tempdir().expect("workspace");
    let run = create_review_workflow(workspace.path(), create_input()).expect("create");
    let mut next = run.clone();
    next.coverage = Some(WorkflowCoverage {
        total_hits: Some(100),
        fetched: 50,
        unique: 47,
        exhausted: false,
        next_cursor: Some("cursor".to_string()),
        truncated_reason: Some("page_limit".to_string()),
        skipped_sources: Vec::new(),
        failed_sources: Vec::new(),
        source_attempts: Vec::new(),
    });
    next.review_count_branch = ReviewCountBranch::Focused;

    let error = save_review_workflow(
        workspace.path(),
        ReviewWorkflowSaveInput {
            expected_revision: run.revision,
            run: next,
            actor: "executor".to_string(),
            action: "search_updated".to_string(),
            summary: "updated partial coverage".to_string(),
            stage_id: Some("review-landscape-search".to_string()),
            lease_owner_turn_id: None,
        },
    )
    .expect_err("partial search must not branch");
    assert!(error.contains("coverage"));
}

#[test]
fn rejects_branching_before_true_review_eligibility_is_complete() {
    let workspace = tempdir().expect("workspace");
    let run = create_review_workflow(workspace.path(), create_input()).expect("create");
    let mut next = run.clone();
    next.coverage = Some(WorkflowCoverage {
        total_hits: Some(80),
        fetched: 80,
        unique: 74,
        exhausted: true,
        next_cursor: None,
        truncated_reason: None,
        skipped_sources: Vec::new(),
        failed_sources: Vec::new(),
        source_attempts: Vec::new(),
    });
    next.search_record_ids = (0..74).map(|index| format!("paper-{index}")).collect();
    next.review_count_branch = ReviewCountBranch::Broad;

    let error = save_review_workflow(
        workspace.path(),
        ReviewWorkflowSaveInput {
            expected_revision: run.revision,
            run: next,
            actor: "executor".to_string(),
            action: "branch_attempted".to_string(),
            summary: "attempted to branch from raw records".to_string(),
            stage_id: Some("review-eligibility".to_string()),
            lease_owner_turn_id: None,
        },
    )
    .expect_err("raw search records must not drive review-count branching");
    assert!(error.contains("eligibility"));
}

#[test]
fn accepts_branch_calculated_from_eligible_recent_reviews() {
    let workspace = tempdir().expect("workspace");
    let run = create_review_workflow(workspace.path(), create_input()).expect("create");
    let mut next = run.clone();
    next.coverage = Some(WorkflowCoverage {
        total_hits: Some(80),
        fetched: 80,
        unique: 74,
        exhausted: true,
        next_cursor: None,
        truncated_reason: None,
        skipped_sources: Vec::new(),
        failed_sources: Vec::new(),
        source_attempts: Vec::new(),
    });
    next.search_record_ids = (0..74).map(|index| format!("paper-{index}")).collect();
    next.review_eligibility = ReviewEligibilitySummary {
        candidate_record_ids: next.search_record_ids.clone(),
        eligible_record_ids: (0..21).map(|index| format!("paper-{index}")).collect(),
        excluded_record_ids: (21..74).map(|index| format!("paper-{index}")).collect(),
        missing_abstract_record_ids: Vec::new(),
        complete: true,
        method: "independent_reviewer".to_string(),
        screened_at: Some(now_iso8601()),
    };
    next.review_count_branch = ReviewCountBranch::Focused;

    let saved = save_review_workflow(
        workspace.path(),
        ReviewWorkflowSaveInput {
            expected_revision: run.revision,
            run: next,
            actor: "Independent Reviewer".to_string(),
            action: "eligibility_approved".to_string(),
            summary: "confirmed 21 recent review papers".to_string(),
            stage_id: Some("review-eligibility".to_string()),
            lease_owner_turn_id: None,
        },
    )
    .expect("eligible review count should be accepted");
    assert_eq!(saved.review_count_branch, ReviewCountBranch::Focused);
}

#[test]
fn migrates_a_v1_run_without_losing_the_active_stage() {
    let workspace = tempdir().expect("workspace");
    let run = create_review_workflow(workspace.path(), create_input()).expect("create");
    let path = run_path(workspace.path(), &run.id);
    let mut value = serde_json::to_value(&run).expect("serialize");
    value["templateVersion"] = serde_json::json!(1);
    value["activeStageId"] = serde_json::json!("formal-protocol");
    let mut legacy_stage = serde_json::to_value(
        run.stages
            .iter()
            .find(|stage| stage.id == "matrix-strategy")
            .expect("matrix stage"),
    )
    .expect("legacy stage");
    legacy_stage["id"] = serde_json::json!("formal-protocol");
    value["stages"] = serde_json::json!([legacy_stage]);
    for field in [
        "contextPolicy",
        "reviewSearchIteration",
        "searchRevisionReason",
        "previousEligibleReviewCount",
        "reviewEligibility",
        "landscapeAnalysis",
        "selectedDirectionId",
        "matrixStrategy",
        "matrixPlanApproved",
        "matrixSearchProtocolId",
        "matrixSearchRunId",
        "matrixSearchPathId",
        "matrixRecordIds",
        "matrixCoverage",
        "queryQualityIterations",
        "primarySearchProtocolId",
        "primarySearchRunId",
        "primaryTargetResults",
        "primaryRecordIds",
        "primaryCoverage",
        "paperGrades",
        "outline",
        "paperMappings",
    ] {
        value.as_object_mut().expect("run object").remove(field);
    }
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&value).expect("encode legacy run"),
    )
    .expect("write legacy run");

    let migrated = load_review_workflow(workspace.path(), &run.id)
        .expect("load")
        .expect("migrated run");
    assert_eq!(migrated.template_version, REVIEW_WORKFLOW_TEMPLATE_VERSION);
    assert_eq!(migrated.active_stage_id, "matrix-strategy");
    assert_eq!(migrated.stages.len(), 16);
    assert_eq!(migrated.context_policy, WorkflowContextPolicy::default());
}

#[test]
fn upgrades_the_former_twenty_paper_batch_default() {
    let workspace = tempdir().expect("workspace");
    let run = create_review_workflow(workspace.path(), create_input()).expect("create");
    let path = run_path(workspace.path(), &run.id);
    let mut value = serde_json::to_value(&run).expect("serialize");
    value["contextPolicy"]["abstractBatchSize"] = serde_json::json!(20);
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&value).expect("encode legacy batch default"),
    )
    .expect("write legacy run");

    let migrated = load_review_workflow(workspace.path(), &run.id)
        .expect("load")
        .expect("migrated run");
    assert_eq!(migrated.context_policy.abstract_batch_size, 50);
}

#[test]
fn removes_the_legacy_zotero_stage_when_migrating_template_v2() {
    let workspace = tempdir().expect("workspace");
    let run = create_review_workflow(workspace.path(), create_input()).expect("create");
    let path = run_path(workspace.path(), &run.id);
    let mut value = serde_json::to_value(&run).expect("serialize");
    value["templateVersion"] = serde_json::json!(2);
    value["activeStageId"] = serde_json::json!("zotero-organization");
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&value).expect("encode template v2 run"),
    )
    .expect("write template v2 run");

    let migrated = load_review_workflow(workspace.path(), &run.id)
        .expect("load")
        .expect("migrated run");
    assert_eq!(migrated.template_version, REVIEW_WORKFLOW_TEMPLATE_VERSION);
    assert_eq!(migrated.active_stage_id, "evidence-synthesis");
    assert_eq!(migrated.stages.len(), 16);
    assert!(migrated
        .stages
        .iter()
        .all(|stage| stage.id != "zotero-organization"));
    assert_eq!(migrated.status, ReviewWorkflowStatus::WaitingUser);
    assert_eq!(
        migrated
            .stages
            .iter()
            .find(|stage| stage.id == "evidence-synthesis")
            .expect("evidence stage")
            .status,
        ReviewWorkflowStageStatus::WaitingUser
    );
}

#[test]
fn migrates_legacy_search_stage_to_an_explicit_unreviewed_gate() {
    let workspace = tempdir().expect("workspace");
    let run = create_review_workflow(workspace.path(), create_input()).expect("create");
    let path = run_path(workspace.path(), &run.id);
    let mut value = serde_json::to_value(&run).expect("serialize");
    let search_stage = value["stages"]
        .as_array_mut()
        .expect("stages")
        .iter_mut()
        .find(|stage| stage["id"] == "review-landscape-search")
        .expect("search stage");
    search_stage["status"] = serde_json::json!("passed");
    search_stage["completedAt"] = serde_json::json!(run.updated_at.clone());
    search_stage["reviewerGate"] = serde_json::json!({
        "required": false,
        "status": "not_required",
        "issues": []
    });
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&value).expect("encode legacy run"),
    )
    .expect("write legacy run");

    let migrated = load_review_workflow(workspace.path(), &run.id)
        .expect("load")
        .expect("migrated run");
    let gate = &migrated.stages[1].reviewer_gate;
    assert!(gate.required);
    assert_eq!(gate.status, ReviewerGateStatus::Skipped);
    assert_eq!(gate.reviewer.as_deref(), Some("Legacy workflow migration"));
}

/// The primary-library backfill runs on every load, so anything it rewrites is
/// rewritten again each time the run is opened. A rejection is a review that
/// happened: overwriting it with the deterministic coverage verdict threw away
/// the issues the user was being asked to fix, and left the stage claiming it
/// was merely waiting for a Reviewer that had in fact already answered.
#[test]
fn loading_a_rejected_primary_library_keeps_the_reviewer_verdict() {
    let workspace = tempdir().expect("workspace");
    let run = create_review_workflow(workspace.path(), create_input()).expect("create");
    let path = run_path(workspace.path(), &run.id);
    let mut value = serde_json::to_value(&run).expect("serialize");
    value["activeStageId"] = serde_json::json!("primary-library");
    value["primaryTargetResults"] = serde_json::json!(50);
    value["primaryRecordIds"] = serde_json::json!((0..60)
        .map(|index| format!("paper-{index}"))
        .collect::<Vec<_>>());
    value["primaryCoverage"] = serde_json::json!({
        "totalHits": 60,
        "fetched": 60,
        "unique": 60,
        "exhausted": true,
        "skippedSources": [],
        "failedSources": [],
        "sourceAttempts": []
    });
    let primary_stage = value["stages"]
        .as_array_mut()
        .expect("stages")
        .iter_mut()
        .find(|stage| stage["id"] == "primary-library")
        .expect("primary stage");
    primary_stage["status"] = serde_json::json!("revision_required");
    primary_stage["reviewerGate"] = serde_json::json!({
        "required": true,
        "status": "rejected",
        "reviewer": "Independent Reviewer",
        "summary": "A+C 路径只回收到 3 篇，语料偏向单一方法。",
        "issues": ["A+C 覆盖不足", "去重后年份分布集中在 2024"],
        "reviewedAt": "2026-08-01T00:00:00Z"
    });
    std::fs::write(&path, serde_json::to_vec_pretty(&value).expect("encode")).expect("write");

    let migrated = load_review_workflow(workspace.path(), &run.id)
        .expect("load")
        .expect("migrated run");
    let primary_stage = migrated
        .stages
        .iter()
        .find(|stage| stage.id == "primary-library")
        .expect("primary stage");
    assert_eq!(
        primary_stage.reviewer_gate.status,
        ReviewerGateStatus::Rejected
    );
    assert_eq!(primary_stage.reviewer_gate.issues.len(), 2);
    assert_eq!(
        primary_stage.reviewer_gate.summary.as_deref(),
        Some("A+C 路径只回收到 3 篇，语料偏向单一方法。")
    );
    assert_eq!(
        primary_stage.status,
        ReviewWorkflowStageStatus::RevisionRequired
    );
    // A rejected corpus still blocks grading and keeps the cursor on the stage
    // that has to be fixed.
    assert_eq!(migrated.active_stage_id, "primary-library");
    assert_eq!(
        migrated
            .stages
            .iter()
            .find(|stage| stage.id == "batch-grading")
            .expect("grading stage")
            .status,
        ReviewWorkflowStageStatus::NotStarted
    );
}

#[test]
fn legacy_primary_library_advances_at_the_default_corpus_target() {
    let workspace = tempdir().expect("workspace");
    let run = create_review_workflow(workspace.path(), create_input()).expect("create");
    let path = run_path(workspace.path(), &run.id);
    let mut value = serde_json::to_value(&run).expect("serialize");
    value
        .as_object_mut()
        .expect("run object")
        .remove("primaryTargetResults");
    value["activeStageId"] = serde_json::json!("primary-library");
    value["primaryRecordIds"] = serde_json::json!((0..749)
        .map(|index| format!("paper-{index}"))
        .collect::<Vec<_>>());
    value["primaryCoverage"] = serde_json::json!({
        "totalHits": null,
        "fetched": 787,
        "unique": 749,
        "exhausted": false,
        "nextCursor": "{\"abc\":\"__exhausted__\",\"ba\":\"opaque\"}",
        "truncatedReason": "provider_has_more_results",
        "skippedSources": [],
        "failedSources": [],
        "sourceAttempts": []
    });
    let primary_stage = value["stages"]
        .as_array_mut()
        .expect("stages")
        .iter_mut()
        .find(|stage| stage["id"] == "primary-library")
        .expect("primary stage");
    primary_stage["status"] = serde_json::json!("partial");
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&value).expect("encode legacy run"),
    )
    .expect("write legacy run");

    let migrated = load_review_workflow(workspace.path(), &run.id)
        .expect("load")
        .expect("migrated run");
    assert_eq!(
        migrated.primary_target_results,
        DEFAULT_PRIMARY_TARGET_RESULTS
    );
    // Reaching the deterministic corpus target is not an independent review.
    // Legacy runs are therefore resumed at the explicit Reviewer gate instead
    // of silently manufacturing approval from the target counter.
    assert_eq!(migrated.active_stage_id, "primary-library");
    let primary_stage = migrated
        .stages
        .iter()
        .find(|stage| stage.id == "primary-library")
        .expect("primary stage");
    assert_eq!(
        primary_stage.status,
        ReviewWorkflowStageStatus::WaitingReviewer
    );
    assert_eq!(
        primary_stage.reviewer_gate.status,
        ReviewerGateStatus::Pending
    );
    assert!(
        !migrated
            .primary_coverage
            .as_ref()
            .expect("coverage")
            .exhausted
    );
    assert!(migrated
        .primary_coverage
        .as_ref()
        .expect("coverage")
        .next_cursor
        .is_some());
}

#[test]
fn resumes_a_confirmed_legacy_reconnaissance_run_without_an_automation_field() {
    let workspace = tempdir().expect("workspace");
    let run = create_review_workflow(workspace.path(), create_input()).expect("create");
    let path = run_path(workspace.path(), &run.id);
    let mut value = serde_json::to_value(&run).expect("serialize");
    value["planApproved"] = serde_json::json!(true);
    value["status"] = serde_json::json!("running");
    value["activeStageId"] = serde_json::json!("review-landscape-search");
    value
        .as_object_mut()
        .expect("run object")
        .remove("scoutAutomationStatus");
    value
        .as_object_mut()
        .expect("run object")
        .remove("scoutRevisionLimit");
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&value).expect("encode legacy run"),
    )
    .expect("write legacy run");

    let migrated = load_review_workflow(workspace.path(), &run.id)
        .expect("load")
        .expect("migrated run");
    assert_eq!(
        migrated.scout_automation_status,
        Some(ScoutAutomationStatus::Running)
    );
    assert_eq!(migrated.scout_revision_limit, Some(4));
}

#[test]
fn optimistic_revision_allows_only_one_concurrent_writer() {
    let workspace = tempdir().expect("workspace");
    let run = create_review_workflow(workspace.path(), create_input()).expect("create");
    let workspace = std::sync::Arc::new(workspace);
    let handles = (0..2)
        .map(|index| {
            let workspace = workspace.clone();
            let mut next = run.clone();
            next.title = format!("concurrent title {index}");
            std::thread::spawn(move || {
                save_review_workflow(
                    workspace.path(),
                    ReviewWorkflowSaveInput {
                        expected_revision: next.revision,
                        run: next,
                        actor: "executor".to_string(),
                        action: "concurrent_update".to_string(),
                        summary: "concurrent update".to_string(),
                        stage_id: Some("scope-and-plan".to_string()),
                        lease_owner_turn_id: None,
                    },
                )
            })
        })
        .collect::<Vec<_>>();
    let results = handles
        .into_iter()
        .map(|handle| handle.join().expect("thread"))
        .collect::<Vec<_>>();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(results.iter().filter(|result| result.is_err()).count(), 1);
}

#[test]
fn the_stage_transcript_survives_a_save_and_reload() {
    let workspace = tempdir().expect("workspace");
    let run = create_review_workflow(workspace.path(), create_input()).expect("create");

    let mut next = run.clone();
    next.activity_log.push(WorkflowActivityEntry {
        id: "wf-plan-review-1".to_string(),
        stage_id: "scope-and-plan".to_string(),
        actor: "Independent Reviewer".to_string(),
        title: "Reviewer 审查检索计划".to_string(),
        model: Some("gpt-5.6".to_string()),
        status: WorkflowActivityStatus::Completed,
        detail: Some(r#"{"approved":true,"summary":"检索式覆盖充分。"}"#.to_string()),
        started_at: "2026-07-31T08:00:00Z".to_string(),
        completed_at: "2026-07-31T08:00:41Z".to_string(),
    });
    let saved = save_review_workflow(
        workspace.path(),
        ReviewWorkflowSaveInput {
            expected_revision: next.revision,
            run: next,
            actor: "Independent Reviewer".to_string(),
            action: "plan_reviewed".to_string(),
            summary: "Reviewer 审查检索计划。".to_string(),
            stage_id: Some("scope-and-plan".to_string()),
            lease_owner_turn_id: None,
        },
    )
    .expect("save");

    let loaded = load_review_workflow(workspace.path(), &run.id)
        .expect("load")
        .expect("run");
    assert_eq!(loaded, saved);
    assert_eq!(loaded.activity_log.len(), 1);
    let entry = &loaded.activity_log[0];
    assert_eq!(entry.stage_id, "scope-and-plan");
    assert_eq!(entry.status, WorkflowActivityStatus::Completed);
    assert!(entry
        .detail
        .as_deref()
        .expect("detail")
        .contains("检索式覆盖充分"));
}

fn checkpoint(completed: usize, total: usize) -> WorkflowBatchCheckpoint {
    WorkflowBatchCheckpoint {
        kind: "grading".to_string(),
        stage_id: "batch-grading".to_string(),
        input_fingerprint: "grading-3-deadbeef".to_string(),
        batch_size: 20,
        completed_batches: completed,
        total_batches: total,
        partial: serde_json::json!({ "kind": "grading", "grades": [] }),
        updated_at: now_iso8601(),
    }
}

fn save_checkpoint(
    workspace: &std::path::Path,
    run: &ReviewWorkflowRun,
    checkpoint: Option<WorkflowBatchCheckpoint>,
) -> Result<ReviewWorkflowRun, String> {
    let mut next = run.clone();
    next.batch_checkpoint = checkpoint;
    save_review_workflow(
        workspace,
        ReviewWorkflowSaveInput {
            expected_revision: run.revision,
            run: next,
            actor: "Executor".to_string(),
            action: "batch_checkpoint".to_string(),
            summary: "batch progress".to_string(),
            stage_id: Some("batch-grading".to_string()),
            lease_owner_turn_id: None,
        },
    )
}

#[test]
fn persists_partial_batch_progress_across_saves() {
    let workspace = tempdir().expect("workspace");
    let run = create_review_workflow(workspace.path(), create_input()).expect("create");

    let first = save_checkpoint(workspace.path(), &run, Some(checkpoint(1, 5))).expect("first");
    let second = save_checkpoint(workspace.path(), &first, Some(checkpoint(2, 5))).expect("second");

    let loaded = load_review_workflow(workspace.path(), &run.id)
        .expect("load")
        .expect("run");
    let stored = loaded.batch_checkpoint.expect("checkpoint survives reload");
    assert_eq!(stored.completed_batches, 2);
    assert_eq!(stored.total_batches, 5);
    assert_eq!(second.revision, run.revision + 2);
}

#[test]
fn accepts_a_primary_library_selection_checkpoint() {
    let workspace = tempdir().expect("workspace");
    let run = create_review_workflow(workspace.path(), create_input()).expect("create");
    let mut selection = checkpoint(1, 5);
    selection.kind = "primary-select".to_string();
    selection.stage_id = "primary-library".to_string();
    selection.input_fingerprint = "primary-select-3-deadbeef".to_string();
    selection.partial = serde_json::json!({ "kind": "primary-select", "scores": [] });

    let saved = save_checkpoint(workspace.path(), &run, Some(selection))
        .expect("primary selection progress is resumable");

    assert_eq!(
        saved
            .batch_checkpoint
            .as_ref()
            .expect("checkpoint")
            .kind,
        "primary-select"
    );
}

#[test]
fn rejects_a_checkpoint_that_claims_more_batches_than_it_has() {
    let workspace = tempdir().expect("workspace");
    let run = create_review_workflow(workspace.path(), create_input()).expect("create");

    let error = save_checkpoint(workspace.path(), &run, Some(checkpoint(6, 5)))
        .expect_err("overrun must be rejected");
    assert!(error.contains("batch checkpoint completed"));

    let mut unknown = checkpoint(1, 5);
    unknown.kind = "translation".to_string();
    let error = save_checkpoint(workspace.path(), &run, Some(unknown))
        .expect_err("unknown kind must be rejected");
    assert!(error.contains("unknown batch checkpoint kind"));

    let mut orphan = checkpoint(1, 5);
    orphan.stage_id = "no-such-stage".to_string();
    let error = save_checkpoint(workspace.path(), &run, Some(orphan))
        .expect_err("orphan stage must be rejected");
    assert!(error.contains("stage that does not exist"));

    let mut unfingerprinted = checkpoint(1, 5);
    unfingerprinted.input_fingerprint = "   ".to_string();
    let error = save_checkpoint(workspace.path(), &run, Some(unfingerprinted))
        .expect_err("missing fingerprint must be rejected");
    assert!(error.contains("input fingerprint"));
}

#[test]
fn partial_grades_are_allowed_and_blank_mappings_are_not() {
    // Mapping reviews may decide a paper has no useful section. Those reviews
    // stay in the batch checkpoint while only assigned sections enter the
    // canonical mapping artifact.
    let workspace = tempdir().expect("workspace");
    let run = create_review_workflow(workspace.path(), create_input()).expect("create");
    let mut next = run.clone();
    next.primary_record_ids = vec!["paper-0".to_string(), "paper-1".to_string()];
    next.paper_grades = vec![WorkflowPaperGrade {
        record_id: "paper-0".to_string(),
        original_index: 1,
        grade: "A".to_string(),
        key_finding: "finding".to_string(),
        rationale: "rationale".to_string(),
        method: "independent_reviewer_batched".to_string(),
    }];
    let saved = save_review_workflow(
        workspace.path(),
        ReviewWorkflowSaveInput {
            expected_revision: run.revision,
            run: next,
            actor: "Executor".to_string(),
            action: "batch_checkpoint".to_string(),
            summary: "one of two graded".to_string(),
            stage_id: Some("batch-grading".to_string()),
            lease_owner_turn_id: None,
        },
    )
    .expect("a subset of grades is a legal intermediate state");

    let mut partial_mapping = saved.clone();
    partial_mapping.paper_grades.push(WorkflowPaperGrade {
        record_id: "paper-1".to_string(),
        original_index: 2,
        grade: "B".to_string(),
        key_finding: "finding".to_string(),
        rationale: "rationale".to_string(),
        method: "independent_reviewer_batched".to_string(),
    });
    partial_mapping.paper_mappings = vec![WorkflowPaperMapping {
        record_id: "paper-0".to_string(),
        original_index: 1,
        zotero_locator: "Paper Author 2024".to_string(),
        direct_section_id: None,
        indirect_section_id: None,
        contribution: "contribution".to_string(),
    }];
    let error = save_review_workflow(
        workspace.path(),
        ReviewWorkflowSaveInput {
            expected_revision: saved.revision,
            run: partial_mapping.clone(),
            actor: "Executor".to_string(),
            action: "batch_checkpoint".to_string(),
            summary: "one of two mapped".to_string(),
            stage_id: Some("section-mapping".to_string()),
            lease_owner_turn_id: None,
        },
    )
    .expect_err("blank mappings must not reach the canonical field");
    assert!(error.contains("assign at least one outline section"));

    partial_mapping.paper_mappings[0].direct_section_id = Some("2.1".to_string());
    let saved_mapping = save_review_workflow(
        workspace.path(),
        ReviewWorkflowSaveInput {
            expected_revision: saved.revision,
            run: partial_mapping,
            actor: "Executor".to_string(),
            action: "section_mapping_completed".to_string(),
            summary: "one assigned mapping after two reviews".to_string(),
            stage_id: Some("section-mapping".to_string()),
            lease_owner_turn_id: None,
        },
    )
    .expect("assigned mappings may be a subset of reviewed A/B grades");
    assert_eq!(saved_mapping.paper_mappings.len(), 1);
}

#[test]
fn consecutive_batch_checkpoints_collapse_into_one_event() {
    let workspace = tempdir().expect("workspace");
    let run = create_review_workflow(workspace.path(), create_input()).expect("create");
    let baseline = run.events.len();

    let mut current = run;
    for completed in 1..=8 {
        current = save_checkpoint(workspace.path(), &current, Some(checkpoint(completed, 8)))
            .expect("checkpoint");
    }
    assert_eq!(current.events.len(), baseline + 1);
    assert_eq!(
        current.events.last().expect("event").action,
        "batch_checkpoint"
    );

    // A different action still records its own entry, and a later checkpoint
    // after it starts a new line rather than reviving the collapsed one.
    let mut renamed = current.clone();
    renamed.title = "renamed".to_string();
    let current = save_review_workflow(
        workspace.path(),
        ReviewWorkflowSaveInput {
            expected_revision: current.revision,
            run: renamed,
            actor: "user".to_string(),
            action: "workflow_renamed".to_string(),
            summary: "renamed the run".to_string(),
            stage_id: Some("batch-grading".to_string()),
            lease_owner_turn_id: None,
        },
    )
    .expect("rename");
    assert_eq!(current.events.len(), baseline + 2);

    let current =
        save_checkpoint(workspace.path(), &current, Some(checkpoint(8, 8))).expect("resume");
    assert_eq!(current.events.len(), baseline + 3);
}

#[test]
fn a_skipped_gate_passes_a_stage_but_never_looks_approved() {
    let workspace = tempdir().expect("workspace");
    let run = create_review_workflow(workspace.path(), create_input()).expect("create");
    assert!(!run.reviewer_disabled);

    let mut next = run.clone();
    next.reviewer_disabled = true;
    next.stages[0].status = ReviewWorkflowStageStatus::Passed;
    next.stages[0].reviewer_gate.status = ReviewerGateStatus::Skipped;
    let saved = save_review_workflow(
        workspace.path(),
        ReviewWorkflowSaveInput {
            expected_revision: run.revision,
            run: next,
            actor: "Executor".to_string(),
            action: "plan_review_skipped".to_string(),
            summary: "independent review is switched off for this run".to_string(),
            stage_id: Some("scope-and-plan".to_string()),
            lease_owner_turn_id: None,
        },
    )
    .expect("an explicitly skipped gate may pass its stage");
    assert_eq!(
        saved.stages[0].reviewer_gate.status,
        ReviewerGateStatus::Skipped
    );

    // The marker survives a reload, and re-enabling the reviewer later must not
    // make an already-skipped run unsavable.
    let reloaded = load_review_workflow(workspace.path(), &run.id)
        .expect("load")
        .expect("run");
    assert_eq!(
        reloaded.stages[0].reviewer_gate.status,
        ReviewerGateStatus::Skipped
    );
    let mut re_enabled = reloaded.clone();
    re_enabled.reviewer_disabled = false;
    save_review_workflow(
        workspace.path(),
        ReviewWorkflowSaveInput {
            expected_revision: reloaded.revision,
            run: re_enabled,
            actor: "user".to_string(),
            action: "reviewer_re_enabled".to_string(),
            summary: "turned independent review back on".to_string(),
            stage_id: Some("scope-and-plan".to_string()),
            lease_owner_turn_id: None,
        },
    )
    .expect("turning the reviewer back on must not invalidate past skips");
}

#[test]
fn a_lease_keeps_a_second_batched_loop_out_of_the_same_run() {
    let workspace = tempdir().expect("workspace");
    let run = create_review_workflow(workspace.path(), create_input()).expect("create");

    let held = acquire_run_lease(workspace.path(), &run.id, "job-a", RUN_LEASE_TTL_SECS)
        .expect("first loop takes the run");
    assert_eq!(held.lease.as_ref().expect("lease").owner_turn_id, "job-a");

    let error = acquire_run_lease(workspace.path(), &run.id, "job-b", RUN_LEASE_TTL_SECS)
        .expect_err("a second loop must be refused");
    assert!(error.contains("already running under lease `job-a`"));

    // Re-acquiring as the same owner is how a resumed job reclaims its run.
    acquire_run_lease(workspace.path(), &run.id, "job-a", RUN_LEASE_TTL_SECS)
        .expect("the holder may refresh its own lease");

    let released =
        release_run_lease(workspace.path(), &run.id, "job-a").expect("the holder may release");
    assert!(released.lease.is_none());
    acquire_run_lease(workspace.path(), &run.id, "job-b", RUN_LEASE_TTL_SECS)
        .expect("a released run is free again");
}

#[test]
fn an_expired_lease_is_taken_over_instead_of_stranding_the_run() {
    let workspace = tempdir().expect("workspace");
    let run = create_review_workflow(workspace.path(), create_input()).expect("create");

    // A zero TTL is the state an app killed mid-job leaves behind.
    let stale = acquire_run_lease(workspace.path(), &run.id, "job-a", 0).expect("acquire");
    let lease = stale.lease.as_ref().expect("lease");
    assert!(lease.is_expired(&now_iso8601()));

    let taken = acquire_run_lease(workspace.path(), &run.id, "job-b", RUN_LEASE_TTL_SECS)
        .expect("an expired lease must not strand the run");
    assert_eq!(taken.lease.expect("lease").owner_turn_id, "job-b");
}

#[test]
fn a_held_run_rejects_writes_from_anyone_but_the_holder() {
    let workspace = tempdir().expect("workspace");
    let run = create_review_workflow(workspace.path(), create_input()).expect("create");
    let held =
        acquire_run_lease(workspace.path(), &run.id, "job-a", RUN_LEASE_TTL_SECS).expect("acquire");

    // The optimistic revision alone would let this through: the second loop
    // reads a fresh revision before each save, so both interleave cleanly while
    // staging checkpoints computed from different partial results.
    let error = save_review_workflow(
        workspace.path(),
        ReviewWorkflowSaveInput {
            expected_revision: held.revision,
            run: held.clone(),
            actor: "Executor".to_string(),
            action: "batch_checkpoint".to_string(),
            summary: "a second loop writing over a live job".to_string(),
            stage_id: Some("batch-grading".to_string()),
            lease_owner_turn_id: None,
        },
    )
    .expect_err("a foreign writer must be refused");
    assert!(error.contains("held by lease `job-a`"));

    // Echoing the lease back is not proof: any writer that loads the run gets it
    // in the payload for free. Ownership has to be asserted out-of-band.
    let error = save_review_workflow(
        workspace.path(),
        ReviewWorkflowSaveInput {
            expected_revision: held.revision,
            run: held.clone(),
            actor: "Executor".to_string(),
            action: "batch_checkpoint".to_string(),
            summary: "echoing the lease it just read".to_string(),
            stage_id: Some("batch-grading".to_string()),
            lease_owner_turn_id: Some("job-b".to_string()),
        },
    )
    .expect_err("a writer holding the wrong owner id must be refused");
    assert!(error.contains("held by lease `job-a`"));

    // The holder's own save goes through, and refreshes the lease as it does.
    let mut owner_write = held.clone();
    owner_write.title = "held run".to_string();
    let saved = save_review_workflow(
        workspace.path(),
        ReviewWorkflowSaveInput {
            expected_revision: held.revision,
            run: owner_write,
            actor: "Executor".to_string(),
            action: "batch_checkpoint".to_string(),
            summary: "the holder saves a batch".to_string(),
            stage_id: Some("batch-grading".to_string()),
            lease_owner_turn_id: Some("job-a".to_string()),
        },
    )
    .expect("the holder may save");
    let refreshed = saved.lease.expect("lease survives the save");
    assert_eq!(refreshed.owner_turn_id, "job-a");
    assert!(!refreshed.is_expired(&now_iso8601()));
}

#[test]
fn a_primary_target_cannot_forge_independent_reviewer_approval() {
    let workspace = tempdir().expect("workspace");
    let run = create_review_workflow(workspace.path(), create_input()).expect("create");
    let mut next = run.clone();
    for stage in &mut next.stages {
        if stage.ordinal < 9 {
            stage.status = ReviewWorkflowStageStatus::Passed;
            if stage.reviewer_gate.required {
                stage.reviewer_gate.status = ReviewerGateStatus::Approved;
            }
        }
    }
    next.active_stage_id = "scope-and-plan".to_string();
    next.primary_record_ids = (0..500).map(|index| format!("paper-{index}")).collect();
    next.primary_coverage = Some(WorkflowCoverage {
        total_hits: None,
        fetched: 500,
        unique: 500,
        exhausted: false,
        next_cursor: Some("cursor".to_string()),
        truncated_reason: None,
        skipped_sources: Vec::new(),
        failed_sources: Vec::new(),
        source_attempts: Vec::new(),
    });
    let primary = next
        .stages
        .iter_mut()
        .find(|stage| stage.id == "primary-library")
        .expect("primary stage");
    primary.status = ReviewWorkflowStageStatus::Passed;
    primary.reviewer_gate.status = ReviewerGateStatus::Approved;
    primary.reviewer_gate.reviewer = Some(LEGACY_COVERAGE_TARGET_VALIDATOR_REVIEWER.to_string());

    let error = save_review_workflow(
        workspace.path(),
        ReviewWorkflowSaveInput {
            expected_revision: run.revision,
            run: next,
            actor: "Executor".to_string(),
            action: "primary_target_reached".to_string(),
            summary: "target reached".to_string(),
            stage_id: Some("primary-library".to_string()),
            lease_owner_turn_id: None,
        },
    )
    .expect_err("a deterministic target check is not an independent review");
    assert!(error.contains("independent Reviewer approval"), "{error}");
}

#[test]
fn settled_primary_quality_shortfalls_are_ready_before_provider_exhaustion() {
    let mut run = create_review_workflow(tempdir().expect("workspace").path(), create_input())
        .expect("create");
    run.primary_target_results = 500;
    run.primary_record_ids = vec!["paper-0".to_string()];
    run.primary_path_allocations = ["abc", "ab", "bc", "ac"]
        .into_iter()
        .map(|id| PrimaryPathAllocation {
            id: id.to_string(),
            max_results: 125,
            rationale: "test allocation".to_string(),
        })
        .collect();
    run.primary_path_admissions = ["abc", "ab", "bc", "ac"]
        .into_iter()
        .map(|id| PrimaryPathAdmission {
            path_id: id.to_string(),
            quota: 125,
            candidate_record_ids: vec!["paper-0".to_string()],
            admitted_record_ids: if id == "abc" {
                vec!["paper-0".to_string()]
            } else {
                Vec::new()
            },
            deferred_record_ids: Vec::new(),
            shortfall_reason: Some(
                "only candidates below the quality threshold remain".to_string(),
            ),
            selected_at: "2026-08-06T00:00:00Z".to_string(),
            method: "independent_reviewer_batched".to_string(),
        })
        .collect();
    run.primary_coverage = Some(WorkflowCoverage {
        total_hits: None,
        fetched: 4,
        unique: 1,
        exhausted: false,
        next_cursor: Some("cursor-1".to_string()),
        truncated_reason: Some("provider_has_more_results".to_string()),
        skipped_sources: Vec::new(),
        failed_sources: Vec::new(),
        source_attempts: Vec::new(),
    });

    assert!(primary_library_ready(&run));
}

#[test]
fn primary_path_allocations_must_cover_all_paths_and_preserve_the_global_target() {
    let workspace = tempdir().expect("workspace");
    let run = create_review_workflow(workspace.path(), create_input()).expect("create");
    let mut next = run.clone();
    next.primary_path_allocations = vec![
        super::PrimaryPathAllocation { id: "abc".to_string(), max_results: 80, rationale: "core".to_string() },
        super::PrimaryPathAllocation { id: "ab".to_string(), max_results: 180, rationale: "domain".to_string() },
        super::PrimaryPathAllocation { id: "bc".to_string(), max_results: 120, rationale: "methods".to_string() },
        super::PrimaryPathAllocation { id: "ac".to_string(), max_results: 120, rationale: "baselines".to_string() },
    ];
    let saved = save_review_workflow(
        workspace.path(),
        ReviewWorkflowSaveInput {
            expected_revision: run.revision,
            run: next.clone(),
            actor: "Executor".to_string(),
            action: "primary_allocation_planned".to_string(),
            summary: "LLM allocation".to_string(),
            stage_id: Some("primary-library".to_string()),
            lease_owner_turn_id: None,
        },
    )
    .expect("valid allocation");
    assert_eq!(saved.primary_path_allocations.len(), 4);

    let mut invalid = saved.clone();
    invalid.primary_path_allocations[2].max_results = 300;
    let error = save_review_workflow(
        workspace.path(),
        ReviewWorkflowSaveInput {
            expected_revision: saved.revision,
            run: invalid,
            actor: "Executor".to_string(),
            action: "primary_allocation_planned".to_string(),
            summary: "invalid LLM allocation".to_string(),
            stage_id: Some("primary-library".to_string()),
            lease_owner_turn_id: None,
        },
    )
    .expect_err("allocation cannot exceed its target");
    assert!(error.contains("allocation totals"), "{error}");
}

/// Stage 09 accumulates its candidate pool across several bounded provider
/// passes, so the pool has to survive the save that ends each pass.
///
/// While these three fields existed only in the Desktop run type, serde dropped
/// them on the way into this struct and the command handed back a run with an
/// empty pool. Every continuation then re-requested a full budget against
/// provider cursors that had already advanced, so the pool stayed at zero while
/// the paths read to exhaustion were never read again. The wire names are
/// asserted alongside the round trip because the Desktop type is hand-written:
/// a rename on either side reintroduces exactly the same silent drop.
#[test]
fn the_primary_library_candidate_pool_survives_a_save() {
    let workspace = tempdir().expect("workspace");
    let run = create_review_workflow(workspace.path(), create_input()).expect("create");
    let mut next = run.clone();
    next.primary_path_candidates = [
        ("abc".to_string(), vec!["r1".to_string(), "r2".to_string()]),
        ("ab".to_string(), vec!["r3".to_string()]),
    ]
    .into_iter()
    .collect();
    next.primary_path_admissions = vec![super::PrimaryPathAdmission {
        path_id: "abc".to_string(),
        quota: 2,
        candidate_record_ids: vec!["r1".to_string(), "r2".to_string()],
        admitted_record_ids: vec!["r1".to_string()],
        deferred_record_ids: vec!["r2".to_string()],
        shortfall_reason: Some("only one candidate graded A or B".to_string()),
        selected_at: "2026-08-05T00:00:00Z".to_string(),
        method: "executor".to_string(),
    }];
    next.primary_candidate_scores = vec![super::PrimaryCandidateScore {
        record_id: "r1".to_string(),
        path_id: "abc".to_string(),
        relevant: true,
        grade: "A".to_string(),
        key_finding: "reports the effect the review needs".to_string(),
        rationale: "directly answers the selected direction".to_string(),
        citation_count: Some(42),
        year: Some(2024),
        admitted: true,
    }];
    next.primary_record_ids = vec!["r1".to_string()];

    let wire = serde_json::to_value(&next).expect("serialize");
    assert_eq!(wire["primaryPathCandidates"]["abc"][1], "r2");
    assert_eq!(wire["primaryPathAdmissions"][0]["admittedRecordIds"][0], "r1");
    assert_eq!(wire["primaryPathAdmissions"][0]["deferredRecordIds"][0], "r2");
    assert_eq!(wire["primaryCandidateScores"][0]["citationCount"], 42);
    assert_eq!(wire["primaryCandidateScores"][0]["admitted"], true);

    let saved = save_review_workflow(
        workspace.path(),
        ReviewWorkflowSaveInput {
            expected_revision: run.revision,
            run: next.clone(),
            actor: "Executor".to_string(),
            action: "primary_candidates_selected".to_string(),
            summary: "quality selection".to_string(),
            stage_id: Some("primary-library".to_string()),
            lease_owner_turn_id: None,
        },
    )
    .expect("candidate pool is durable");
    assert_eq!(saved.primary_path_candidates, next.primary_path_candidates);
    assert_eq!(saved.primary_path_admissions, next.primary_path_admissions);
    assert_eq!(saved.primary_candidate_scores, next.primary_candidate_scores);

    let loaded = load_review_workflow(workspace.path(), &run.id)
        .expect("load")
        .expect("run");
    assert_eq!(loaded.primary_path_candidates, next.primary_path_candidates);
    assert_eq!(loaded.primary_path_admissions, next.primary_path_admissions);
    assert_eq!(loaded.primary_candidate_scores, next.primary_candidate_scores);
}

#[test]
fn rename_and_delete_are_blocked_while_a_run_lease_is_live() {
    let workspace = tempdir().expect("workspace");
    let run = create_review_workflow(workspace.path(), create_input()).expect("create");
    acquire_run_lease(
        workspace.path(),
        &run.id,
        "controller-a",
        RUN_LEASE_TTL_SECS,
    )
    .expect("lease");

    let rename_error = rename_review_workflow(workspace.path(), &run.id, "renamed")
        .expect_err("rename must not race a live controller");
    assert!(rename_error.contains("live run lease"));
    let delete_error = delete_review_workflow(workspace.path(), &run.id)
        .expect_err("delete must not race a live controller");
    assert!(delete_error.contains("live run lease"));
}

#[test]
fn a_pending_gate_still_cannot_pass_a_stage() {
    let workspace = tempdir().expect("workspace");
    let run = create_review_workflow(workspace.path(), create_input()).expect("create");
    let mut next = run.clone();
    next.reviewer_disabled = true;
    next.stages[0].status = ReviewWorkflowStageStatus::Passed;
    // Switching the reviewer off does not by itself satisfy the gate; the stage
    // has to record that it was skipped.
    let error = save_review_workflow(
        workspace.path(),
        ReviewWorkflowSaveInput {
            expected_revision: run.revision,
            run: next,
            actor: "Executor".to_string(),
            action: "plan_passed".to_string(),
            summary: "attempted to pass an unmarked gate".to_string(),
            stage_id: Some("scope-and-plan".to_string()),
            lease_owner_turn_id: None,
        },
    )
    .expect_err("an unmarked required gate must still block");
    assert!(error.contains("Reviewer"));
}
