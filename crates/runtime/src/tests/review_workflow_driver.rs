use tempfile::tempdir;

use super::*;
use crate::review_workflow::{
    create_review_workflow, MatrixConcept, MatrixSearchPath, PrimaryCandidateScore,
    PrimaryPathAdmission, PrimaryPathAllocation, ReviewDirection, ReviewSearchQuery,
    ReviewWorkflowCreateInput, ScoutAutomationStatus, WorkflowBatchCheckpoint,
    WorkflowOutlineCluster, WorkflowSourceCoverage,
};

fn run() -> ReviewWorkflowRun {
    let workspace = tempdir().expect("workspace");
    create_review_workflow(
        workspace.path(),
        ReviewWorkflowCreateInput {
            topic: "large language models for scientific discovery".to_string(),
            keywords: vec!["LLM".to_string()],
            languages: vec!["English".to_string()],
            databases: vec!["scopus".to_string()],
            year_from: 2022,
            year_to: 2026,
        },
    )
    .expect("create")
}

fn stage_mut<'a>(run: &'a mut ReviewWorkflowRun, id: &str) -> &'a mut ReviewWorkflowStage {
    run.stages
        .iter_mut()
        .find(|stage| stage.id == id)
        .expect("stage exists")
}

/// Marks every stage up to and including `id` as passed with a satisfied gate,
/// so a test can start from a mid-pipeline state without replaying it.
fn pass_through(run: &mut ReviewWorkflowRun, id: &str) {
    let ordinal = run
        .stages
        .iter()
        .find(|stage| stage.id == id)
        .expect("stage exists")
        .ordinal;
    for stage in &mut run.stages {
        if stage.ordinal > ordinal {
            continue;
        }
        stage.status = ReviewWorkflowStageStatus::Passed;
        if stage.reviewer_gate.required {
            stage.reviewer_gate.status = ReviewerGateStatus::Approved;
        }
    }
    let next_id = run
        .stages
        .iter()
        .find(|stage| stage.ordinal == ordinal + 1)
        .map(|stage| stage.id.clone());
    if let Some(next_id) = next_id {
        run.active_stage_id = next_id;
    }
}

fn exhausted_coverage() -> WorkflowCoverage {
    WorkflowCoverage {
        total_hits: Some(80),
        fetched: 80,
        unique: 74,
        exhausted: true,
        next_cursor: None,
        truncated_reason: None,
        skipped_sources: Vec::new(),
        failed_sources: Vec::new(),
        source_attempts: Vec::new(),
    }
}

fn partial_coverage(next_cursor: Option<&str>) -> WorkflowCoverage {
    WorkflowCoverage {
        exhausted: false,
        next_cursor: next_cursor.map(ToString::to_string),
        ..exhausted_coverage()
    }
}

fn approved_gate() -> ReviewerGate {
    ReviewerGate {
        required: true,
        status: ReviewerGateStatus::Approved,
        reviewer: Some("Independent Reviewer".to_string()),
        summary: Some("通过".to_string()),
        issues: Vec::new(),
        reviewed_at: Some(crate::now_iso8601()),
    }
}

fn search_plan() -> ReviewSearchPlan {
    ReviewSearchPlan {
        queries: vec![ReviewSearchQuery {
            id: "q1".to_string(),
            source: "scopus".to_string(),
            kind: "primary".to_string(),
            language: "English".to_string(),
            query: "TITLE-ABS-KEY(\"large language model\") AND DOCTYPE(re)".to_string(),
            rationale: "覆盖命名变体".to_string(),
        }],
        inclusion_criteria: Vec::new(),
        exclusion_criteria: Vec::new(),
        generated_by: "Executor".to_string(),
        generated_at: crate::now_iso8601(),
    }
}

fn landscape_analysis() -> ReviewLandscapeAnalysis {
    ReviewLandscapeAnalysis {
        development_status: "现状".to_string(),
        directions: vec![ReviewDirection {
            id: "direction-1".to_string(),
            title: "方向一".to_string(),
            gap: "空白".to_string(),
            outline: "组织".to_string(),
            workload: "8 周".to_string(),
            difficulty: "medium".to_string(),
            feasibility: "可行".to_string(),
            evidence_record_ids: Vec::new(),
        }],
        generated_at: crate::now_iso8601(),
        generated_by: "Executor".to_string(),
        ..ReviewLandscapeAnalysis::default()
    }
}

fn matrix_strategy() -> MatrixSearchStrategy {
    MatrixSearchStrategy {
        mode: "stable".to_string(),
        concepts: vec![MatrixConcept {
            role: "A".to_string(),
            entity: "wind farm".to_string(),
            rationale: "背景".to_string(),
            terms: vec!["wind farm".to_string()],
        }],
        paths: vec![MatrixSearchPath {
            id: "abc".to_string(),
            combination: "A+B+C".to_string(),
            target: "核心".to_string(),
            strategic_intent: "最高精度".to_string(),
            query: "TITLE-ABS-KEY((a) AND (b))".to_string(),
            action_guide: "优先".to_string(),
            expected_results: "相关研究".to_string(),
            review_value: "主体".to_string(),
        }],
        exclusion_advice: "谨慎".to_string(),
        exclusion_query: None,
        syntax_checks: Vec::new(),
        generated_at: crate::now_iso8601(),
        generated_by: "Executor".to_string(),
    }
}

// ---------------------------------------------------------------------------
// next_step
// ---------------------------------------------------------------------------

#[test]
fn a_fresh_run_starts_by_generating_the_search_plan() {
    let run = run();
    assert_eq!(
        next_step(&run),
        WorkflowNext::ExecutorStep(WorkflowStep {
            stage_id: "scope-and-plan".to_string(),
            action: WorkflowAction::GeneratePlan,
            reason: "尚无检索计划，需要生成数据源特定的检索式。".to_string(),
        })
    );
}

#[test]
fn a_generated_plan_waits_for_the_independent_reviewer() {
    let mut run = run();
    run.search_plan = Some(search_plan());
    let next = next_step(&run);
    assert!(matches!(next, WorkflowNext::ReviewerStep(_)));
    assert_eq!(
        next,
        WorkflowNext::ReviewerStep(WorkflowStep {
            stage_id: "scope-and-plan".to_string(),
            action: WorkflowAction::ReviewPlan,
            reason: "检索计划已生成，等待独立 Reviewer 审查。".to_string(),
        })
    );
}

#[test]
fn a_rejected_plan_goes_back_to_the_executor() {
    let mut run = run();
    run.search_plan = Some(search_plan());
    stage_mut(&mut run, "scope-and-plan").reviewer_gate.status = ReviewerGateStatus::Rejected;
    assert!(
        matches!(next_step(&run), WorkflowNext::ExecutorStep(step) if step.action == WorkflowAction::GeneratePlan)
    );
}

#[test]
fn an_approved_plan_needs_a_user_confirmation_unless_the_loop_is_already_running() {
    let mut run = run();
    run.search_plan = Some(search_plan());
    stage_mut(&mut run, "scope-and-plan").reviewer_gate.status = ReviewerGateStatus::Approved;

    run.scout_automation_status = Some(ScoutAutomationStatus::Idle);
    assert!(matches!(next_step(&run), WorkflowNext::AwaitUser { .. }));

    // One user approval authorizes the whole bounded reconnaissance loop, so a
    // Reviewer-approved revision inside it must not ask again.
    run.scout_automation_status = Some(ScoutAutomationStatus::Running);
    assert!(matches!(
        next_step(&run),
        WorkflowNext::ExecutorStep(step) if step.action == WorkflowAction::ApproveRevisedPlan
    ));
}

#[test]
fn a_partial_search_continues_only_when_it_has_a_cursor() {
    let mut run = run();
    pass_through(&mut run, "scope-and-plan");
    run.search_plan = Some(search_plan());
    run.plan_approved = true;
    run.search_protocol_id = Some("protocol-1".to_string());

    run.coverage = Some(partial_coverage(Some("cursor-2")));
    assert!(matches!(
        next_step(&run),
        WorkflowNext::ExecutorStep(step) if step.action == WorkflowAction::ContinueSearch
    ));

    run.coverage = Some(partial_coverage(None));
    assert!(matches!(next_step(&run), WorkflowNext::Paused { .. }));
}

#[test]
fn a_failed_source_pauses_the_loop_instead_of_retrying_forever() {
    let mut run = run();
    pass_through(&mut run, "scope-and-plan");
    run.search_protocol_id = Some("protocol-1".to_string());
    let mut coverage = partial_coverage(Some("cursor-2"));
    coverage.source_attempts = vec![WorkflowSourceCoverage {
        source: "scopus".to_string(),
        status: "unauthorised".to_string(),
        total_hits: None,
        fetched: 0,
        unique: 0,
        exhausted: false,
        next_cursor: None,
        truncated_reason: None,
        failure_message: None,
    }];
    run.coverage = Some(coverage);

    // A usable cursor is present, but an unauthorised source means the missing
    // records are not recoverable by paging.
    assert!(matches!(next_step(&run), WorkflowNext::Paused { .. }));
}

#[test]
fn an_insufficient_branch_pauses_rather_than_analyzing_a_thin_landscape() {
    let mut run = run();
    pass_through(&mut run, "review-eligibility");
    stage_mut(&mut run, "coverage-and-branch")
        .reviewer_gate
        .status = ReviewerGateStatus::Approved;
    run.review_count_branch = ReviewCountBranch::Insufficient;
    assert!(matches!(next_step(&run), WorkflowNext::Paused { .. }));
}

#[test]
fn automation_stops_for_the_user_at_direction_selection() {
    let mut run = run();
    pass_through(&mut run, "gap-analysis");
    run.scout_automation_status = Some(ScoutAutomationStatus::Running);
    assert_eq!(
        next_step(&run),
        WorkflowNext::AwaitUser {
            stage_id: "direction-selection".to_string(),
            reason: "自动侦察已完成，等待用户从候选方向中选择一个。".to_string(),
        }
    );
}

#[test]
fn a_low_precision_pilot_revises_the_query_instead_of_scaling_it_up() {
    let mut run = run();
    pass_through(&mut run, "matrix-strategy");
    run.selected_direction_id = Some("direction-1".to_string());
    run.landscape_analysis = Some(landscape_analysis());
    run.matrix_strategy = Some(matrix_strategy());
    run.query_quality_iterations = vec![QueryQualityIteration {
        id: "iteration-1".to_string(),
        iteration: 1,
        path_id: "abc".to_string(),
        query: "TITLE-ABS-KEY(a)".to_string(),
        sample_record_ids: Vec::new(),
        sample_size: 100,
        relevant_count: 30,
        low_relevance_count: 70,
        estimated_precision: 0.3,
        false_positive_patterns: Vec::new(),
        adjustment_directions: Vec::new(),
        recommendation: "修订".to_string(),
        reviewer_status: Some(ReviewerGateStatus::Approved),
        reviewer_summary: Some("样本噪声过高。".to_string()),
        reviewer_issues: vec!["收紧共享缩写。".to_string()],
        quality_issues: vec!["估计查准率 30%，低于 50% 下限。".to_string()],
        reviewer_approved: true,
        created_at: crate::now_iso8601(),
    }];
    assert_eq!(
        next_step(&run),
        WorkflowNext::AwaitUser {
            stage_id: "query-quality-loop".to_string(),
            reason: "试检查准率低于 50%；先展示确定性质量问题，再返回矩阵策略修订查询。"
                .to_string(),
        }
    );
}

#[test]
fn grading_runs_until_every_primary_record_has_a_grade() {
    let mut run = run();
    pass_through(&mut run, "primary-library");
    run.primary_target_results = 2;
    run.primary_record_ids = vec!["paper-0".to_string(), "paper-1".to_string()];
    run.primary_coverage = Some(exhausted_coverage());
    run.paper_grades = vec![WorkflowPaperGrade {
        record_id: "paper-0".to_string(),
        original_index: 1,
        grade: "A".to_string(),
        key_finding: "finding".to_string(),
        rationale: "rationale".to_string(),
        method: "independent_reviewer_batched".to_string(),
    }];
    assert!(matches!(
        next_step(&run),
        WorkflowNext::ReviewerStep(step) if step.action == WorkflowAction::GradePapers
    ));
}

#[test]
fn a_fully_graded_corpus_still_waits_for_its_own_reviewer_gate() {
    let mut run = run();
    pass_through(&mut run, "primary-library");
    run.primary_target_results = 1;
    run.primary_record_ids = vec!["paper-0".to_string()];
    run.primary_coverage = Some(exhausted_coverage());
    run.paper_grades = vec![WorkflowPaperGrade {
        record_id: "paper-0".to_string(),
        original_index: 1,
        grade: "A".to_string(),
        key_finding: "finding".to_string(),
        rationale: "rationale".to_string(),
        method: "independent_reviewer_batched".to_string(),
    }];
    // Every record has a grade, but batch-grading's own reviewer gate has not
    // been recorded as approved yet: advancing here would leave active_stage_id
    // stuck on batch-grading while next_step reports outline's work.
    assert!(matches!(
        next_step(&run),
        WorkflowNext::ReviewerStep(step)
            if step.stage_id == "batch-grading" && step.action == WorkflowAction::GradePapers
    ));

    stage_mut(&mut run, "batch-grading").reviewer_gate.status = ReviewerGateStatus::Approved;
    assert!(matches!(
        next_step(&run),
        WorkflowNext::ExecutorStep(step)
            if step.stage_id == "outline" && step.action == WorkflowAction::BuildOutlineClusters
    ));
}

#[test]
fn a_reopened_direction_selection_waits_instead_of_falling_through() {
    let mut run = run();
    pass_through(&mut run, "gap-analysis");
    run.selected_direction_id = Some("direction-1".to_string());
    // Advancing normally: a selection with no rework in progress moves on.
    assert!(matches!(
        next_step(&run),
        WorkflowNext::ExecutorStep(step)
            if step.stage_id == "matrix-strategy" && step.action == WorkflowAction::BuildMatrixStrategy
    ));

    // A reopened stage keeps the previous selection around for the user to see,
    // but must not read as settled — otherwise the rework is skipped entirely.
    stage_mut(&mut run, "direction-selection").status = ReviewWorkflowStageStatus::WaitingUser;
    assert_eq!(
        next_step(&run),
        WorkflowNext::AwaitUser {
            stage_id: "direction-selection".to_string(),
            reason: "方向选择阶段已重新打开，等待用户重新确认研究方向。".to_string(),
        }
    );
}

#[test]
fn edited_outline_waits_for_the_user_then_dispatches_the_independent_reviewer() {
    let mut run = run();
    pass_through(&mut run, "batch-grading");
    run.outline_clusters = vec![WorkflowOutlineCluster {
        id: "theme-1".to_string(),
        title: "Theme".to_string(),
        claim: "Claim".to_string(),
        record_ids: vec!["paper-0".to_string()],
        evidence_gaps: Vec::new(),
        contested: Vec::new(),
    }];
    run.outline = vec![WorkflowOutlineSection {
        id: "1".to_string(),
        title: "Introduction".to_string(),
        purpose: "State the review claim".to_string(),
        record_ids: vec!["paper-0".to_string()],
        children: Vec::new(),
    }];
    assert_eq!(run.outline[0].record_ids, vec!["paper-0"]);
    assert_eq!(
        serde_json::to_value(&run.outline[0]).expect("outline json")["recordIds"][0],
        "paper-0"
    );
    {
        let outline = stage_mut(&mut run, "outline");
        outline.status = ReviewWorkflowStageStatus::WaitingUser;
        outline.reviewer_gate.status = ReviewerGateStatus::Pending;
    }

    assert!(matches!(
        next_step(&run),
        WorkflowNext::AwaitUser { stage_id, .. } if stage_id == "outline"
    ));

    stage_mut(&mut run, "outline").status = ReviewWorkflowStageStatus::WaitingReviewer;
    assert!(matches!(
        next_step(&run),
        WorkflowNext::ReviewerStep(step)
            if step.stage_id == "outline" && step.action == WorkflowAction::ReviewOutline
    ));
}

#[test]
fn outline_requires_visible_clusters_before_dispatching_outline_generation() {
    let mut run = run();
    pass_through(&mut run, "batch-grading");

    assert!(matches!(
        next_step(&run),
        WorkflowNext::ExecutorStep(step)
            if step.stage_id == "outline" && step.action == WorkflowAction::BuildOutlineClusters
    ));

    run.outline_clusters = vec![WorkflowOutlineCluster {
        id: "theme-1".to_string(),
        title: "Theme".to_string(),
        claim: "Claim".to_string(),
        record_ids: vec!["paper-0".to_string()],
        evidence_gaps: Vec::new(),
        contested: Vec::new(),
    }];
    assert!(matches!(
        next_step(&run),
        WorkflowNext::ExecutorStep(step)
            if step.stage_id == "outline" && step.action == WorkflowAction::BuildOutline
    ));
}

#[test]
fn reaching_the_primary_target_waits_for_the_real_reviewer_gate() {
    let mut run = run();
    pass_through(&mut run, "query-quality-loop");
    run.primary_target_results = 2;
    run.primary_record_ids = vec!["paper-0".to_string(), "paper-1".to_string()];
    run.primary_coverage = Some(partial_coverage(Some("cursor-1")));
    let primary = stage_mut(&mut run, "primary-library");
    primary.status = ReviewWorkflowStageStatus::Partial;
    primary.reviewer_gate.status = ReviewerGateStatus::Pending;

    assert!(matches!(
        next_step(&run),
        WorkflowNext::ReviewerStep(step)
            if step.stage_id == "primary-library"
                && step.action == WorkflowAction::ReviewPrimaryLibrary
    ));
}

#[test]
fn the_unimplemented_writing_pipeline_stops_for_the_user_instead_of_claiming_done() {
    let mut run = run();
    pass_through(&mut run, "section-mapping");
    assert_eq!(
        next_step(&run),
        WorkflowNext::AwaitUser {
            stage_id: "evidence-synthesis".to_string(),
            reason: "该阶段的写作流水线尚未实现，综述知识库到此为止。".to_string(),
        }
    );
}

#[test]
fn section_mapping_completion_uses_stage_status_not_mapping_count() {
    let mut run = run();
    pass_through(&mut run, "outline");
    run.paper_grades = vec![
        WorkflowPaperGrade {
            record_id: "paper-a".to_string(),
            original_index: 1,
            grade: "A".to_string(),
            key_finding: "core result".to_string(),
            rationale: "high relevance".to_string(),
            method: "independent_reviewer_batched".to_string(),
        },
        WorkflowPaperGrade {
            record_id: "paper-b".to_string(),
            original_index: 2,
            grade: "B".to_string(),
            key_finding: "reviewed without a suitable section".to_string(),
            rationale: "not useful for this outline".to_string(),
            method: "independent_reviewer_batched".to_string(),
        },
        WorkflowPaperGrade {
            record_id: "paper-d".to_string(),
            original_index: 3,
            grade: "D".to_string(),
            key_finding: "out of scope".to_string(),
            rationale: "not relevant".to_string(),
            method: "independent_reviewer_batched".to_string(),
        },
    ];
    run.paper_mappings = vec![WorkflowPaperMapping {
        record_id: "paper-a".to_string(),
        original_index: 1,
        zotero_locator: "A Author 2026".to_string(),
        direct_section_id: Some("2.1".to_string()),
        indirect_section_id: None,
        contribution: "mapped core result".to_string(),
    }];
    let mapping_stage = stage_mut(&mut run, "section-mapping");
    mapping_stage.status = ReviewWorkflowStageStatus::Passed;
    mapping_stage.reviewer_gate.status = ReviewerGateStatus::Approved;

    assert!(matches!(
        next_step(&run),
        WorkflowNext::AwaitUser { stage_id, .. } if stage_id == "evidence-synthesis"
    ));
}

#[test]
fn a_finished_stage_reports_the_next_stages_work_without_waiting_for_active_stage_id() {
    // The controller applies a transition to move `activeStageId`; until it
    // does, idling would stall the run.
    let mut run = run();
    run.search_plan = Some(search_plan());
    run.plan_approved = true;
    stage_mut(&mut run, "scope-and-plan").reviewer_gate.status = ReviewerGateStatus::Approved;
    stage_mut(&mut run, "scope-and-plan").status = ReviewWorkflowStageStatus::Passed;
    assert_eq!(run.active_stage_id, "scope-and-plan");
    assert!(matches!(
        next_step(&run),
        WorkflowNext::ExecutorStep(step) if step.action == WorkflowAction::CreateSearchPreview
    ));
}

#[test]
fn an_unknown_active_stage_pauses_instead_of_panicking() {
    let mut run = run();
    run.active_stage_id = "no-such-stage".to_string();
    assert!(matches!(next_step(&run), WorkflowNext::Paused { .. }));
}

// ---------------------------------------------------------------------------
// apply_transition
// ---------------------------------------------------------------------------

/// A run where every stage-owned field holds a non-default value, so a field
/// that should have been cleared cannot pass by already looking empty.
fn fully_populated_run() -> ReviewWorkflowRun {
    let mut run = run();
    pass_through(&mut run, "section-mapping");
    run.search_plan = Some(search_plan());
    run.plan_approved = true;
    run.search_protocol_id = Some("protocol-1".to_string());
    run.search_run_id = Some("search-1".to_string());
    run.search_record_ids = vec!["paper-0".to_string()];
    run.coverage = Some(exhausted_coverage());
    run.review_eligibility.complete = true;
    run.review_eligibility.eligible_record_ids = vec!["paper-0".to_string()];
    run.review_count_branch = ReviewCountBranch::Focused;
    run.landscape_analysis = Some(landscape_analysis());
    run.selected_direction_id = Some("direction-1".to_string());
    run.matrix_strategy = Some(matrix_strategy());
    run.matrix_plan_approved = true;
    run.matrix_search_protocol_id = Some("matrix-protocol-1".to_string());
    run.matrix_search_run_id = Some("matrix-search-1".to_string());
    run.matrix_search_path_id = Some("abc".to_string());
    run.matrix_record_ids = vec!["paper-0".to_string()];
    run.matrix_coverage = Some(exhausted_coverage());
    run.query_quality_iterations = vec![QueryQualityIteration {
        id: "iteration-1".to_string(),
        iteration: 1,
        path_id: "abc".to_string(),
        query: "TITLE-ABS-KEY(a)".to_string(),
        sample_record_ids: Vec::new(),
        sample_size: 100,
        relevant_count: 60,
        low_relevance_count: 40,
        estimated_precision: 0.6,
        false_positive_patterns: Vec::new(),
        adjustment_directions: Vec::new(),
        recommendation: "继续".to_string(),
        reviewer_status: Some(ReviewerGateStatus::Approved),
        reviewer_summary: Some("试检质量通过。".to_string()),
        reviewer_issues: Vec::new(),
        quality_issues: Vec::new(),
        reviewer_approved: true,
        created_at: crate::now_iso8601(),
    }];
    run.primary_search_protocol_id = Some("primary-protocol-1".to_string());
    run.primary_search_run_id = Some("primary-search-1".to_string());
    run.primary_path_allocations = vec![
        PrimaryPathAllocation {
            id: "abc".to_string(),
            max_results: 180,
            rationale: "core intersection".to_string(),
        },
        PrimaryPathAllocation {
            id: "ab".to_string(),
            max_results: 180,
            rationale: "domain corpus".to_string(),
        },
        PrimaryPathAllocation {
            id: "bc".to_string(),
            max_results: 80,
            rationale: "method seed".to_string(),
        },
        PrimaryPathAllocation {
            id: "ac".to_string(),
            max_results: 60,
            rationale: "baseline seed".to_string(),
        },
    ];
    run.primary_path_candidates = [("abc".to_string(), vec!["paper-0".to_string()])]
        .into_iter()
        .collect();
    run.primary_path_admissions = vec![PrimaryPathAdmission {
        path_id: "abc".to_string(),
        quota: 180,
        candidate_record_ids: vec!["paper-0".to_string()],
        admitted_record_ids: vec!["paper-0".to_string()],
        deferred_record_ids: Vec::new(),
        shortfall_reason: Some("candidate pool smaller than the quota".to_string()),
        selected_at: "2026-08-01T00:00:00Z".to_string(),
        method: "independent_reviewer_batched".to_string(),
    }];
    run.primary_candidate_scores = vec![PrimaryCandidateScore {
        record_id: "paper-0".to_string(),
        path_id: "abc".to_string(),
        relevant: true,
        grade: "A".to_string(),
        key_finding: "finding".to_string(),
        rationale: "rationale".to_string(),
        citation_count: Some(12),
        year: Some(2024),
        admitted: true,
    }];
    run.primary_record_ids = vec!["paper-0".to_string()];
    run.primary_coverage = Some(exhausted_coverage());
    run.paper_grades = vec![WorkflowPaperGrade {
        record_id: "paper-0".to_string(),
        original_index: 1,
        grade: "A".to_string(),
        key_finding: "finding".to_string(),
        rationale: "rationale".to_string(),
        method: "independent_reviewer_batched".to_string(),
    }];
    run.outline_clusters = vec![WorkflowOutlineCluster {
        id: "cluster-1".to_string(),
        title: "Theme".to_string(),
        claim: "Claim".to_string(),
        record_ids: vec!["paper-0".to_string()],
        evidence_gaps: Vec::new(),
        contested: Vec::new(),
    }];
    run.outline_cluster_fingerprint = Some("outline-1-deadbeef".to_string());
    run.outline = vec![WorkflowOutlineSection {
        id: "1".to_string(),
        title: "引言".to_string(),
        purpose: "背景".to_string(),
        record_ids: vec!["paper-0".to_string()],
        children: Vec::new(),
    }];
    run.paper_mappings = vec![WorkflowPaperMapping {
        record_id: "paper-0".to_string(),
        original_index: 1,
        zotero_locator: "Paper Author 2024".to_string(),
        direct_section_id: Some("1".to_string()),
        indirect_section_id: None,
        contribution: "贡献".to_string(),
    }];
    run.batch_checkpoint = Some(WorkflowBatchCheckpoint {
        kind: "grading".to_string(),
        stage_id: "batch-grading".to_string(),
        input_fingerprint: "grading-1-deadbeef".to_string(),
        batch_size: 20,
        completed_batches: 1,
        total_batches: 2,
        partial: serde_json::json!({ "kind": "grading", "grades": [] }),
        updated_at: crate::now_iso8601(),
    });
    run
}

#[test]
fn reworking_an_upstream_stage_clears_every_downstream_output() {
    let run = fully_populated_run();

    let reworked = apply_transition(
        &run,
        StageTransition {
            stage_id: "scope-and-plan".to_string(),
            outcome: StageOutcome::InProgress,
            output: Some(StageOutput::SearchPlan(Box::new(search_plan()))),
            gate: None,
            summary: None,
            advance: false,
        },
    )
    .expect("reworking the first stage is always allowed");

    // This is the invariant the TypeScript `resetStagesAfter` never enforced: it
    // reset stage statuses while leaving every downstream result in place.
    assert!(reworked.coverage.is_none());
    assert!(reworked.search_record_ids.is_empty());
    assert!(!reworked.review_eligibility.complete);
    assert_eq!(reworked.review_count_branch, ReviewCountBranch::Unknown);
    assert!(reworked.landscape_analysis.is_none());
    assert!(reworked.selected_direction_id.is_none());
    assert!(reworked.matrix_strategy.is_none());
    assert!(!reworked.matrix_plan_approved);
    assert!(reworked.matrix_coverage.is_none());
    assert!(reworked.primary_coverage.is_none());
    assert!(reworked.paper_grades.is_empty());
    assert!(reworked.outline.is_empty());
    assert!(reworked.paper_mappings.is_empty());
    assert!(reworked.batch_checkpoint.is_none());

    // The stage's own new output survives its own invalidation sweep.
    assert!(reworked.search_plan.is_some());
    // A new plan is never a confirmed plan.
    assert!(!reworked.plan_approved);
    for stage in reworked.stages.iter().skip(1) {
        assert_eq!(stage.status, ReviewWorkflowStageStatus::NotStarted);
        assert!(stage.completed_at.is_none());
    }
}

/// Shared with `desktop/src/workflows/tests/workflowEngine.test.ts`. Both suites
/// derive their expectations from this one file, so the Rust and TypeScript
/// invalidation tables cannot drift apart.
const STAGE_OUTPUT_FIXTURE: &str = include_str!("fixtures/workflow_stage_outputs.json");

#[test]
fn invalidation_clears_exactly_the_fields_the_shared_fixture_assigns_downstream() {
    let fixture: serde_json::Value =
        serde_json::from_str(STAGE_OUTPUT_FIXTURE).expect("fixture parses");
    let stage_outputs = fixture["stageOutputs"]
        .as_object()
        .expect("stageOutputs is an object");
    let run = fully_populated_run();
    let ordinal_of = |id: &str| {
        run.stages
            .iter()
            .find(|stage| stage.id == id)
            .unwrap_or_else(|| panic!("fixture names unknown stage `{id}`"))
            .ordinal
    };

    for stage in &run.stages {
        // Only stages that own outputs are meaningful here; the writing stages
        // beyond `section-mapping` have no typed fields yet.
        if !stage_outputs.contains_key(&stage.id) {
            continue;
        }
        let applied = apply_transition(
            &run,
            StageTransition {
                stage_id: stage.id.clone(),
                outcome: StageOutcome::InProgress,
                output: None,
                gate: None,
                summary: None,
                advance: false,
            },
        )
        .unwrap_or_else(|error| panic!("transition on {}: {error}", stage.id));

        let before = serde_json::to_value(&run).expect("serialize");
        let after = serde_json::to_value(&applied).expect("serialize");
        let mut changed = before
            .as_object()
            .expect("run object")
            .iter()
            .filter(|(key, value)| after.get(*key) != Some(*value))
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        // Bookkeeping the transition always touches, unrelated to ownership.
        changed
            .retain(|key| !matches!(key.as_str(), "stages" | "activeStageId" | "batchCheckpoint"));
        changed.sort();

        let mut expected = stage_outputs
            .iter()
            .filter(|(owner, _)| ordinal_of(owner) > stage.ordinal)
            .flat_map(|(_, fields)| {
                fields
                    .as_array()
                    .expect("field list")
                    .iter()
                    .map(|field| field.as_str().expect("field name").to_string())
            })
            .collect::<Vec<_>>();
        expected.sort();

        assert_eq!(
            changed, expected,
            "invalidating from `{}` cleared the wrong field set",
            stage.id
        );
    }
}

#[test]
fn a_stage_cannot_write_another_stages_output() {
    let run = run();
    let error = apply_transition(
        &run,
        StageTransition {
            stage_id: "scope-and-plan".to_string(),
            outcome: StageOutcome::InProgress,
            output: Some(StageOutput::Grades(Vec::new())),
            gate: None,
            summary: None,
            advance: false,
        },
    )
    .expect_err("stage ownership must be enforced");
    assert!(error.contains("cannot write output owned by stage batch-grading"));
}

#[test]
fn a_forward_jump_past_an_unfinished_stage_is_rejected() {
    let run = run();
    let error = apply_transition(
        &run,
        StageTransition {
            stage_id: "gap-analysis".to_string(),
            outcome: StageOutcome::InProgress,
            output: Some(StageOutput::Landscape(Box::new(landscape_analysis()))),
            gate: None,
            summary: None,
            advance: false,
        },
    )
    .expect_err("stage ordering must be enforced");
    assert!(error.contains("cannot start before stage scope-and-plan passes"));
}

#[test]
fn passing_a_gated_stage_requires_a_satisfied_gate() {
    let run = run();
    let error = apply_transition(
        &run,
        StageTransition {
            stage_id: "scope-and-plan".to_string(),
            outcome: StageOutcome::Passed,
            output: None,
            gate: None,
            summary: None,
            advance: true,
        },
    )
    .expect_err("an unreviewed gate must block");
    assert!(error.contains("independent Reviewer"));

    let passed = apply_transition(
        &run,
        StageTransition {
            stage_id: "scope-and-plan".to_string(),
            outcome: StageOutcome::Passed,
            output: Some(StageOutput::PlanApproved),
            gate: Some(approved_gate()),
            summary: Some("已确认检索计划。".to_string()),
            advance: true,
        },
    )
    .expect("an approved gate passes the stage");
    assert_eq!(passed.active_stage_id, "review-landscape-search");
    assert_eq!(passed.stages[1].status, ReviewWorkflowStageStatus::Ready);
    assert!(passed.stages[0].completed_at.is_some());
    assert!(passed.plan_approved);
}

#[test]
fn a_transition_cannot_rewrite_whether_a_gate_is_required() {
    let run = run();
    let mut gate = approved_gate();
    gate.required = false;
    let applied = apply_transition(
        &run,
        StageTransition {
            stage_id: "scope-and-plan".to_string(),
            outcome: StageOutcome::WaitingUser,
            output: None,
            gate: Some(gate),
            summary: None,
            advance: false,
        },
    )
    .expect("gate verdicts apply");
    assert!(applied.stages[0].reviewer_gate.required);
}

#[test]
fn reopening_a_passed_stage_clears_its_completion_time() {
    let run = run();
    let passed = apply_transition(
        &run,
        StageTransition {
            stage_id: "scope-and-plan".to_string(),
            outcome: StageOutcome::Passed,
            output: Some(StageOutput::PlanApproved),
            gate: Some(approved_gate()),
            summary: None,
            advance: false,
        },
    )
    .expect("pass");
    assert!(passed.stages[0].completed_at.is_some());

    let reopened = apply_transition(
        &passed,
        StageTransition {
            stage_id: "scope-and-plan".to_string(),
            outcome: StageOutcome::RevisionRequired,
            output: None,
            gate: None,
            summary: None,
            advance: false,
        },
    )
    .expect("reopen");
    assert!(reopened.stages[0].completed_at.is_none());
}

#[test]
fn branch_is_derived_from_eligible_reviews_not_raw_hits() {
    let mut run = run();
    run.search_record_ids = (0..74).map(|index| format!("paper-{index}")).collect();
    run.coverage = Some(exhausted_coverage());

    // Screening incomplete: no branch may be claimed from raw hits.
    assert_eq!(branch_from_eligibility(&run), ReviewCountBranch::Unknown);

    run.review_eligibility.complete = true;
    run.review_eligibility.eligible_record_ids =
        (0..21).map(|index| format!("paper-{index}")).collect();
    assert_eq!(branch_from_eligibility(&run), ReviewCountBranch::Focused);

    run.coverage = Some(partial_coverage(Some("cursor")));
    assert_eq!(branch_from_eligibility(&run), ReviewCountBranch::Unknown);
}

// ---------------------------------------------------------------------------
// Deterministic Scopus gates
// ---------------------------------------------------------------------------

#[test]
fn a_review_document_type_is_forced_at_the_outermost_level() {
    assert_eq!(
        enforce_scopus_review_document_type("TITLE-ABS-KEY(llm)"),
        "(TITLE-ABS-KEY(llm)) AND DOCTYPE(re)"
    );
    // Already review-only queries are left alone so the filter is not doubled.
    assert_eq!(
        enforce_scopus_review_document_type("TITLE-ABS-KEY(llm) AND DOCTYPE(re)"),
        "TITLE-ABS-KEY(llm) AND DOCTYPE(re)"
    );
    // An inner non-review DOCTYPE cannot broaden the result set: it gets wrapped.
    assert_eq!(
        enforce_scopus_review_document_type("TITLE-ABS-KEY(llm) AND DOCTYPE(ar)"),
        "(TITLE-ABS-KEY(llm) AND DOCTYPE(ar)) AND DOCTYPE(re)"
    );
    assert!(has_enforced_scopus_review_document_type(
        "TITLE-ABS-KEY(llm) AND DOCTYPE(re)"
    ));
    assert!(!has_enforced_scopus_review_document_type(
        "TITLE-ABS-KEY(llm) OR DOCTYPE(re)"
    ));
    assert_eq!(
        enforce_scopus_review_document_type("TITLE-ABS-KEY(llm) OR DOCTYPE(re)"),
        "(TITLE-ABS-KEY(llm) OR DOCTYPE(re)) AND DOCTYPE(re)"
    );
    assert!(has_enforced_scopus_review_document_type(
        "(TITLE-ABS-KEY(llm) OR DOCTYPE(re)) AND DOCTYPE(re)"
    ));
    assert!(!has_enforced_scopus_review_document_type(
        "TITLE-ABS-KEY(llm)"
    ));
}

#[test]
fn the_preflight_rejects_chinese_bloated_and_over_excluded_queries() {
    let issues = scopus_review_query_issues("TITLE-ABS-KEY(大语言模型) AND DOCTYPE(re)");
    assert!(issues.iter().any(|issue| issue.contains("不得出现中文")));

    let terms = (0..25)
        .map(|index| format!("\"term {index}\""))
        .collect::<Vec<_>>()
        .join(" OR ");
    let issues = scopus_review_query_issues(&format!("TITLE-ABS-KEY({terms}) AND DOCTYPE(re)"));
    assert!(issues.iter().any(|issue| issue.contains("个 OR")));
    assert!(issues.iter().any(|issue| issue.contains("个引号短语")));

    let issues = scopus_review_query_issues(
        "TITLE-ABS-KEY(llm) AND DOCTYPE(re) AND NOT TITLE(a OR b OR c OR d OR e OR f)",
    );
    assert!(issues.iter().any(|issue| issue.contains("AND NOT TITLE")));

    let issues = scopus_review_query_issues("(llm) AND DOCTYPE(re)");
    assert!(issues.iter().any(|issue| issue.contains("TITLE-ABS-KEY")));

    let issues =
        scopus_review_query_issues("TITLE-ABS-KEY(\"large language model\" OR llm AND DOCTYPE(re)");
    assert!(issues.iter().any(|issue| issue.contains("括号配对失败")));

    let issues =
        scopus_review_query_issues("TITLE-ABS-KEY(\"large language model) AND DOCTYPE(re)");
    assert!(issues.iter().any(|issue| issue.contains("双引号未成对")));

    assert!(scopus_review_query_issues(
        "TITLE-ABS-KEY(\"large language model\" OR llm) AND DOCTYPE(re)"
    )
    .is_empty());
}

#[test]
fn plan_preflight_only_judges_scopus_queries() {
    let mut plan = search_plan();
    plan.queries.push(ReviewSearchQuery {
        id: "q2".to_string(),
        source: "openalex".to_string(),
        kind: "primary".to_string(),
        language: "English".to_string(),
        // Would fail every Scopus rule; OpenAlex does not use that syntax.
        query: "大语言模型 综述".to_string(),
        rationale: "中文检索".to_string(),
    });
    assert!(review_search_plan_preflight_issues(&plan).is_empty());

    plan.queries[0].query = "大语言模型".to_string();
    let issues = review_search_plan_preflight_issues(&plan);
    assert!(!issues.is_empty());
    assert!(issues.iter().all(|issue| issue.starts_with("Scopus：")));
}

#[test]
fn matrix_query_syntax_checks_render_their_persisted_labels() {
    let checks = validate_scopus_query("TITLE-ABS-KEY((a) AND (b))");
    assert!(checks.iter().all(|check| check.passed));
    assert_eq!(
        checks
            .iter()
            .map(ScopusSyntaxCheck::label)
            .collect::<Vec<_>>(),
        vec![
            "括号配对通过",
            "TITLE-ABS-KEY 字段通过",
            "布尔运算符通过",
            "未发现占位符",
        ]
    );

    let checks = validate_scopus_query("TITLE-ABS-KEY((a) AND （概念）");
    assert_eq!(checks[0].label(), "括号配对失败");
    assert_eq!(checks[3].label(), "发现占位符");

    // A stray closing parenthesis is unbalanced even though the count evens out.
    assert!(!validate_scopus_query(")TITLE-ABS-KEY(a AND b")[0].passed);
}

// ---------------------------------------------------------------------------
// Session binding
// ---------------------------------------------------------------------------

#[test]
fn a_run_is_bound_to_one_durable_session_that_cannot_be_repointed() {
    let workspace = tempdir().expect("workspace");
    let run = create_review_workflow(
        workspace.path(),
        ReviewWorkflowCreateInput {
            topic: "session binding".to_string(),
            keywords: Vec::new(),
            languages: Vec::new(),
            databases: Vec::new(),
            year_from: 2022,
            year_to: 2026,
        },
    )
    .expect("create");
    assert_eq!(
        run.session_id.as_deref(),
        Some(crate::review_workflow::workflow_session_id(&run.id).as_str())
    );

    let mut repointed = run.clone();
    repointed.session_id = Some("wf-somewhere-else".to_string());
    let error = crate::review_workflow::save_review_workflow(
        workspace.path(),
        crate::review_workflow::ReviewWorkflowSaveInput {
            expected_revision: run.revision,
            run: repointed,
            actor: "user".to_string(),
            action: "repoint".to_string(),
            summary: "attempted to repoint the session".to_string(),
            stage_id: Some("scope-and-plan".to_string()),
            lease_owner_turn_id: None,
        },
    )
    .expect_err("a live run must not be repointed at another transcript");
    assert!(error.contains("session cannot be repointed"));
}

#[test]
fn a_legacy_run_without_a_session_is_backfilled_deterministically() {
    let workspace = tempdir().expect("workspace");
    let run = create_review_workflow(
        workspace.path(),
        ReviewWorkflowCreateInput {
            topic: "legacy binding".to_string(),
            keywords: Vec::new(),
            languages: Vec::new(),
            databases: Vec::new(),
            year_from: 2022,
            year_to: 2026,
        },
    )
    .expect("create");
    let path = crate::review_workflow::review_workflow_dir(workspace.path())
        .join(format!("{}.json", run.id));
    let mut value = serde_json::to_value(&run).expect("serialize");
    value
        .as_object_mut()
        .expect("run object")
        .remove("sessionId");
    std::fs::write(&path, serde_json::to_vec_pretty(&value).expect("encode")).expect("write");

    let loaded = crate::review_workflow::load_review_workflow(workspace.path(), &run.id)
        .expect("load")
        .expect("run");
    assert_eq!(
        loaded.session_id,
        Some(crate::review_workflow::workflow_session_id(&run.id))
    );
}

/// Shared with `desktop/src/workflows/tests/workflowEngine.test.ts`. Two
/// independent implementations decide what the workflow does next — this driver
/// answers the model through `ReviewWorkflowState`, and the desktop's
/// `nextScoutAutomationAction` drives the reconnaissance loop. Nothing else made
/// them agree, so each side asserts its own half of this file.
const NEXT_STEP_FIXTURE: &str = include_str!("fixtures/workflow_next_step.json");

#[test]
fn next_step_matches_the_shared_contract_with_the_desktop_loop() {
    let fixture: serde_json::Value =
        serde_json::from_str(NEXT_STEP_FIXTURE).expect("fixture parses");
    let cases = fixture["cases"].as_array().expect("cases is an array");
    assert!(!cases.is_empty(), "the shared contract must not be empty");

    for case in cases {
        let name = case["name"].as_str().expect("case name");
        let state = &case["state"];
        let stage_id = state["activeStageId"].as_str().expect("activeStageId");

        let mut run = run();
        run.active_stage_id = stage_id.to_string();
        run.scout_automation_status = state["automationRunning"]
            .as_bool()
            .unwrap_or(false)
            .then_some(ScoutAutomationStatus::Running);
        if state["hasSearchPlan"].as_bool().unwrap_or(false) {
            run.search_plan = Some(search_plan());
        }
        run.plan_approved = state["planApproved"].as_bool().unwrap_or(false);
        if state["hasSearchProtocol"].as_bool().unwrap_or(false) {
            run.search_protocol_id = Some("protocol-1".to_string());
        }
        if let Some(coverage) = state.get("coverage").filter(|value| !value.is_null()) {
            let exhausted = coverage["exhausted"].as_bool().unwrap_or(false);
            let cursor = coverage["hasNextCursor"].as_bool().unwrap_or(false);
            let mut built = if exhausted {
                exhausted_coverage()
            } else {
                partial_coverage(cursor.then_some("cursor-1"))
            };
            if coverage["hasFailure"].as_bool().unwrap_or(false) {
                built.failed_sources = vec!["scopus".to_string()];
            }
            run.coverage = Some(built);
        }
        run.review_eligibility.complete = state["eligibilityComplete"].as_bool().unwrap_or(false);
        if state["hasLandscape"].as_bool().unwrap_or(false) {
            run.landscape_analysis = Some(landscape_analysis());
        }
        let gate_status = match state["gateStatus"].as_str().expect("gateStatus") {
            "pending" => ReviewerGateStatus::Pending,
            "approved" => ReviewerGateStatus::Approved,
            "rejected" => ReviewerGateStatus::Rejected,
            "skipped" => ReviewerGateStatus::Skipped,
            "not_required" => ReviewerGateStatus::NotRequired,
            other => panic!("{name}: unknown gate status `{other}`"),
        };
        // Absent means `ready`; a reopened stage keeps its output and is the
        // reason the stage's own status has to be expressible here at all.
        let stage_status = match state["stageStatus"].as_str() {
            None => ReviewWorkflowStageStatus::Ready,
            Some("ready") => ReviewWorkflowStageStatus::Ready,
            Some("in_progress") => ReviewWorkflowStageStatus::InProgress,
            Some("waiting_user") => ReviewWorkflowStageStatus::WaitingUser,
            Some("waiting_reviewer") => ReviewWorkflowStageStatus::WaitingReviewer,
            Some("revision_required") => ReviewWorkflowStageStatus::RevisionRequired,
            Some(other) => panic!("{name}: unknown stage status `{other}`"),
        };
        for stage in &mut run.stages {
            if stage.id == stage_id {
                stage.reviewer_gate.status = gate_status;
                stage.status = stage_status;
            }
        }

        let expected = &case["rust"];
        let actual = next_step(&run);
        let kind = expected["kind"].as_str().expect("kind");
        let action = expected["action"].as_str();
        match (&actual, kind) {
            (WorkflowNext::ExecutorStep(step), "executor")
            | (WorkflowNext::ReviewerStep(step), "reviewer") => {
                let expected_action = action.unwrap_or_else(|| panic!("{name}: missing action"));
                assert_eq!(
                    format!("{:?}", step.action),
                    expected_action,
                    "{name}: wrong action",
                );
            }
            (WorkflowNext::AwaitUser { .. }, "user") => {}
            (WorkflowNext::Paused { .. }, "paused") => {}
            (WorkflowNext::Done, "done") => {}
            (other, _) => panic!("{name}: expected `{kind}` but the driver returned {other:?}"),
        }

        // The one property both implementations must agree on, independent of
        // how each names its steps.
        let automatable = matches!(
            actual,
            WorkflowNext::ExecutorStep(_) | WorkflowNext::ReviewerStep(_),
        );
        let contract = case["automatable"].as_bool().expect("automatable");
        let automation_running = state["automationRunning"].as_bool().unwrap_or(false);
        if automation_running {
            assert_eq!(automatable, contract, "{name}: automatable disagrees");
        }
    }
}
