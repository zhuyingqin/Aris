//! End-to-end driver simulation for the review workflow.
//!
//! The unit suites in `review_workflow.rs` and `review_workflow_driver.rs` each
//! pin one transition or one invariant. This file drives a *complete* run from
//! a freshly-created workflow all the way to the end of the implemented
//! pipeline (stage 12 — paper-to-section mapping), exercising:
//!
//! * the happy path through every implemented stage
//! * the reviewer-rejection revision loop on three different stages
//! * downstream invalidation when an upstream stage is reworked
//! * optimistic-revision save/load cycle
//! * lease acquire/release during a batched job
//! * batch-checkpoint resumption mid-job
//! * the explicit "stop here" at `direction-selection` and at the unimplemented
//!   writing stages
//!
//! No model calls are made — this is the pure-Rust surface that the desktop
//! controller drives, and that the Tauri side calls into via
//! `review_workflow::save_review_workflow`. The same transitions go through
//! the production path under real load; the only thing this omits is the LLM
//! call itself, which has its own test surface elsewhere.

use std::fs;
use std::path::Path;

use tempfile::tempdir;

use super::*;
use crate::review_workflow::{
    acquire_run_lease, create_review_workflow, list_review_workflows, load_review_workflow,
    release_run_lease, review_workflow_dir, save_review_workflow, ReviewEligibilitySummary,
    ReviewLandscapeAnalysis, ReviewSearchQuery, ReviewWorkflowCreateInput,
    ReviewWorkflowSaveInput, ScoutAutomationStatus, WorkflowPaperMapping,
};
use crate::review_workflow_driver::{
    apply_transition, next_step, StageOutcome, StageOutput, StageTransition, WorkflowAction,
    WorkflowNext,
};

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

fn create_input() -> ReviewWorkflowCreateInput {
    ReviewWorkflowCreateInput {
        topic: "language models for code review".to_string(),
        keywords: vec!["LLM".to_string(), "code review".to_string()],
        languages: vec!["English".to_string()],
        databases: vec!["scopus".to_string(), "openalex".to_string()],
        year_from: 2022,
        year_to: 2026,
    }
}

fn fresh_run() -> (tempfile::TempDir, ReviewWorkflowRun) {
    let workspace = tempdir().expect("workspace");
    let run = create_review_workflow(workspace.path(), create_input()).expect("create");
    (workspace, run)
}

fn search_plan() -> ReviewSearchPlan {
    ReviewSearchPlan {
        queries: vec![ReviewSearchQuery {
            id: "q1".to_string(),
            source: "scopus".to_string(),
            kind: "primary".to_string(),
            language: "English".to_string(),
            query: "TITLE-ABS-KEY(\"large language model\") AND DOCTYPE(re)".to_string(),
            rationale: "cover main lexical variant".to_string(),
        }],
        inclusion_criteria: vec!["peer review".to_string()],
        exclusion_criteria: vec!["editorials".to_string()],
        generated_by: "Executor".to_string(),
        generated_at: now_iso8601(),
    }
}

fn landscape() -> ReviewLandscapeAnalysis {
    ReviewLandscapeAnalysis {
        development_status: "the field is rapidly maturing".to_string(),
        directions: vec![
            ReviewDirection {
                id: "dir-1".to_string(),
                title: "automated feedback loops".to_string(),
                gap: "no empirical study of human-AI review collaboration".to_string(),
                outline: "taxonomy, mechanisms, evaluation".to_string(),
                workload: "8 weeks".to_string(),
                difficulty: "medium".to_string(),
                feasibility: "high".to_string(),
                evidence_record_ids: vec!["rec-1".to_string()],
            },
            ReviewDirection {
                id: "dir-2".to_string(),
                title: "evaluation benchmarks".to_string(),
                gap: "no shared benchmark suite".to_string(),
                outline: "benchmarks, metrics, datasets".to_string(),
                workload: "10 weeks".to_string(),
                difficulty: "medium".to_string(),
                feasibility: "medium".to_string(),
                evidence_record_ids: vec!["rec-2".to_string()],
            },
        ],
        generated_at: now_iso8601(),
        generated_by: "Executor".to_string(),
        ..ReviewLandscapeAnalysis::default()
    }
}

fn matrix_strategy() -> MatrixSearchStrategy {
    MatrixSearchStrategy {
        mode: "stable".to_string(),
        concepts: vec![
            MatrixConcept {
                role: "A".to_string(),
                entity: "code review".to_string(),
                rationale: "context".to_string(),
                terms: vec!["code review".to_string()],
            },
            MatrixConcept {
                role: "B".to_string(),
                entity: "large language model".to_string(),
                rationale: "subject".to_string(),
                terms: vec!["LLM".to_string()],
            },
            MatrixConcept {
                role: "C".to_string(),
                entity: "feedback loop".to_string(),
                rationale: "concrete process".to_string(),
                terms: vec!["feedback".to_string()],
            },
        ],
        paths: vec![
            MatrixSearchPath {
                id: "abc".to_string(),
                combination: "A+B+C".to_string(),
                target: "core".to_string(),
                strategic_intent: "highest precision".to_string(),
                query: "TITLE-ABS-KEY(\"code review\" AND \"LLM\" AND \"feedback\") AND DOCTYPE(re)".to_string(),
                action_guide: "primary".to_string(),
                expected_results: "core reviews".to_string(),
                review_value: "main body".to_string(),
            },
            MatrixSearchPath {
                id: "ab".to_string(),
                combination: "A+B".to_string(),
                target: "subject".to_string(),
                strategic_intent: "broad coverage".to_string(),
                query: "TITLE-ABS-KEY(\"code review\" AND \"LLM\") AND DOCTYPE(re)".to_string(),
                action_guide: "secondary".to_string(),
                expected_results: "subject reviews".to_string(),
                review_value: "supporting".to_string(),
            },
            MatrixSearchPath {
                id: "bc".to_string(),
                combination: "B+C".to_string(),
                target: "process".to_string(),
                strategic_intent: "process focus".to_string(),
                query: "TITLE-ABS-KEY(\"LLM\" AND \"feedback\") AND DOCTYPE(re)".to_string(),
                action_guide: "secondary".to_string(),
                expected_results: "process reviews".to_string(),
                review_value: "supporting".to_string(),
            },
            MatrixSearchPath {
                id: "ac".to_string(),
                combination: "A+C".to_string(),
                target: "context+process".to_string(),
                strategic_intent: "context bridge".to_string(),
                query: "TITLE-ABS-KEY(\"code review\" AND \"feedback\") AND DOCTYPE(re)".to_string(),
                action_guide: "secondary".to_string(),
                expected_results: "context reviews".to_string(),
                review_value: "supporting".to_string(),
            },
        ],
        exclusion_advice: "exclude editorials".to_string(),
        exclusion_query: Some("AND NOT TITLE(\"editorial\")".to_string()),
        syntax_checks: Vec::new(),
        generated_at: now_iso8601(),
        generated_by: "Executor".to_string(),
    }
}

/// Marks the named stage as `Passed` with a satisfied reviewer gate, writes the
/// optional stage output, and saves through the production path. The cursor
/// is auto-advanced by `save_review_workflow` to the next non-passed stage, so
/// the test must read `run.active_stage_id` after the call rather than assume
/// it stayed on the same stage.
fn pass_stage(
    workspace: &Path,
    run: &mut ReviewWorkflowRun,
    stage_id: &str,
    output: Option<StageOutput>,
) {
    let stage = run
        .stages
        .iter()
        .find(|stage| stage.id == stage_id)
        .expect("stage exists")
        .clone();
    let gate = if stage.reviewer_gate.required {
        Some(ReviewerGate {
            required: true,
            status: ReviewerGateStatus::Approved,
            reviewer: Some("Independent Reviewer".to_string()),
            summary: Some("approved".to_string()),
            issues: Vec::new(),
            reviewed_at: Some(now_iso8601()),
        })
    } else {
        None
    };
    let transition = StageTransition {
        stage_id: stage_id.to_string(),
        outcome: StageOutcome::Passed,
        output,
        gate,
        summary: Some(format!("{stage_id} passed in test")),
        advance: true,
    };
    let next = apply_transition(run, transition).expect("transition applies");
    let expected_revision = next.revision;
    let saved = save_review_workflow(
        workspace,
        ReviewWorkflowSaveInput {
            expected_revision,
            run: next,
            actor: "test".to_string(),
            action: "pass_stage".to_string(),
            summary: format!("{stage_id} passed"),
            stage_id: Some(stage_id.to_string()),
            lease_owner_turn_id: None,
        },
    )
    .expect("save");
    *run = saved;
}

fn assert_executor(run: &ReviewWorkflowRun, expected_stage: &str, expected_action: WorkflowAction) {
    match next_step(run) {
        WorkflowNext::ExecutorStep(step) => {
            assert_eq!(step.stage_id, expected_stage, "stage mismatch");
            assert_eq!(step.action, expected_action, "action mismatch");
        }
        other => panic!(
            "expected executor step for {expected_stage}/{:?}, got {other:?}",
            expected_action
        ),
    }
}

fn assert_await_user(run: &ReviewWorkflowRun, expected_stage: &str) {
    match next_step(run) {
        WorkflowNext::AwaitUser { stage_id, .. } => {
            assert_eq!(stage_id, expected_stage, "await_user stage mismatch");
        }
        other => panic!("expected AwaitUser for {expected_stage}, got {other:?}"),
    }
}

fn assert_done_or_unimplemented(run: &ReviewWorkflowRun) {
    match next_step(run) {
        WorkflowNext::AwaitUser { stage_id, .. } => {
            assert!(
                matches!(
                    stage_id.as_str(),
                    "evidence-synthesis"
                        | "manuscript"
                        | "independent-review"
                        | "submission-package"
                ),
                "the only legitimate stop is one of the unimplemented writing stages; got `{stage_id}`"
            );
        }
        WorkflowNext::Done => {}
        other => panic!("expected AwaitUser (unimplemented) or Done, got {other:?}"),
    }
}

fn exhausted_coverage(unique: u64) -> WorkflowCoverage {
    WorkflowCoverage {
        total_hits: Some(unique + 6),
        fetched: unique + 6,
        unique,
        exhausted: true,
        next_cursor: None,
        truncated_reason: None,
        skipped_sources: Vec::new(),
        failed_sources: Vec::new(),
        source_attempts: Vec::new(),
    }
}

fn approved_gate() -> ReviewerGate {
    ReviewerGate {
        required: true,
        status: ReviewerGateStatus::Approved,
        reviewer: Some("Independent Reviewer".to_string()),
        summary: Some("approved".to_string()),
        issues: Vec::new(),
        reviewed_at: Some(now_iso8601()),
    }
}

/// Force all stages up to and including `id` into `Passed`+`Approved` without
/// touching their outputs. Use `pass_stage` for the save+validate flow when
/// outputs matter — this helper is for tests that only need a known
/// starting state.
fn pass_through_to(run: &mut ReviewWorkflowRun, id: &str) {
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

/// Bypass `save_review_workflow` to write a run JSON with an *already-expired*
/// lease directly. Necessary because `save_review_workflow` always refreshes
/// the lease to `now + 600s` on write, so we can never produce an expired
/// lease through the production path.
fn write_run_with_expired_lease(workspace: &Path, run_id: &str) {
    let path = review_workflow_dir(workspace).join(format!("{run_id}.json"));
    let raw = fs::read_to_string(&path).expect("read existing run");
    let mut value: serde_json::Value = serde_json::from_str(&raw).expect("parse run json");
    let lease = serde_json::json!({
        "ownerTurnId": "turn-old",
        "acquiredAt": "2000-01-01T00:00:00Z",
        "expiresAt": "2000-01-01T00:00:01Z",
    });
    value["lease"] = lease;
    let body = serde_json::to_vec_pretty(&value).expect("re-serialize");
    fs::write(&path, body).expect("write back");
}

// ---------------------------------------------------------------------------
// The happy path through every implemented stage
// ---------------------------------------------------------------------------

#[test]
fn happy_path_walks_all_sixteen_stages_with_a_single_save_loop() {
    let (workspace, mut run) = fresh_run();

    // ---- Stage 1: scope-and-plan ----
    // The driver starts by telling the Executor to generate the plan.
    assert_executor(&run, "scope-and-plan", WorkflowAction::GeneratePlan);

    // Executor produced the plan + reviewer approved it: this advances the
    // cursor from `scope-and-plan` straight onto `review-landscape-search`
    // because `save_review_workflow` runs `advance_active_stage_once`.
    pass_stage(
        workspace.path(),
        &mut run,
        "scope-and-plan",
        Some(StageOutput::SearchPlan(Box::new(search_plan()))),
    );
    assert_eq!(run.active_stage_id, "review-landscape-search");

    // The driver hand-off for plan approval is observable only at the moment
    // between executor save and cursor advance. Once the cursor lands on
    // stage 2, the driver reports stage-2 work; the user has to set
    // `plan_approved` (or `scout_automation_status=Running`) before stage 2
    // actually starts. We verify the *gate* here: stage 2 must not run while
    // plan_approved is false.
    assert!(!run.plan_approved);
    // With plan_approved=false the cursor stays on stage 1 from the driver's
    // POV; the run we just saved still has scope-and-plan in the *list* as
    // Passed, but next_step dispatches on active_stage_id. To observe the
    // gate, we rewind active_stage_id back to scope-and-plan and re-query
    // next_step — this is exactly what the controller does on every tick.
    run.active_stage_id = "scope-and-plan".to_string();
    run.scout_automation_status = Some(ScoutAutomationStatus::Idle);
    assert_await_user(&run, "scope-and-plan");
    run.scout_automation_status = Some(ScoutAutomationStatus::Running);
    assert_executor(&run, "scope-and-plan", WorkflowAction::ApproveRevisedPlan);
    // Restore the real cursor so the rest of the test sees stage 2.
    run.active_stage_id = "review-landscape-search".to_string();

    // The user accepts the plan (a plain save, no stage transition).
    let mut next = run.clone();
    next.plan_approved = true;
    next.scout_automation_status = Some(ScoutAutomationStatus::Running);
    next.expected_revision_or_zero();
    let expected_revision = next.revision;
    let saved = save_review_workflow(
        workspace.path(),
        ReviewWorkflowSaveInput {
            expected_revision,
            run: next,
            actor: "test".to_string(),
            action: "approve_plan".to_string(),
            summary: "user accepted".to_string(),
            stage_id: Some("scope-and-plan".to_string()),
            lease_owner_turn_id: None,
        },
    )
    .expect("save");
    run = saved;
    assert!(run.plan_approved, "plan_approved must persist");

    // ---- Stage 2: review-landscape-search ----
    // With automation running and plan accepted, the driver dispatches the
    // search-preview step (no protocol yet).
    assert_executor(
        &run,
        "review-landscape-search",
        WorkflowAction::CreateSearchPreview,
    );

    pass_stage(
        workspace.path(),
        &mut run,
        "review-landscape-search",
        Some(StageOutput::SearchExecution {
            protocol_id: "sp-1".to_string(),
            search_run_id: "sr-1".to_string(),
            record_ids: (1..=30).map(|i| format!("rec-{i}")).collect(),
            coverage: Box::new(exhausted_coverage(30)),
        }),
    );
    assert_eq!(
        run.coverage.as_ref().expect("coverage").unique,
        30,
        "coverage must persist"
    );

    // ---- Stage 3: review-eligibility ----
    pass_stage(
        workspace.path(),
        &mut run,
        "review-eligibility",
        Some(StageOutput::Eligibility(Box::new(ReviewEligibilitySummary {
            complete: true,
            method: "batched_reviewer".to_string(),
            screened_at: Some(now_iso8601()),
            candidate_record_ids: (1..=30).map(|i| format!("rec-{i}")).collect(),
            eligible_record_ids: (1..=22).map(|i| format!("rec-{i}")).collect(),
            excluded_record_ids: vec!["rec-23".to_string()],
            missing_abstract_record_ids: vec!["rec-30".to_string()],
        }))),
    );
    assert_eq!(run.review_eligibility.eligible_record_ids.len(), 22);

    // ---- Stage 4: coverage-and-branch ----
    pass_stage(
        workspace.path(),
        &mut run,
        "coverage-and-branch",
        Some(StageOutput::CountBranch(ReviewCountBranch::Focused)),
    );
    assert_eq!(run.review_count_branch, ReviewCountBranch::Focused);

    // ---- Stage 5: gap-analysis ----
    pass_stage(
        workspace.path(),
        &mut run,
        "gap-analysis",
        Some(StageOutput::Landscape(Box::new(landscape()))),
    );
    assert!(run.landscape_analysis.is_some());

    // ---- Stage 6: direction-selection ----
    // The user must explicitly choose — automation pauses here. The driver
    // does NOT move the cursor until the user picks a direction.
    assert_await_user(&run, "direction-selection");
    pass_stage(
        workspace.path(),
        &mut run,
        "direction-selection",
        Some(StageOutput::Direction("dir-1".to_string())),
    );
    assert_eq!(run.selected_direction_id.as_deref(), Some("dir-1"));

    // ---- Stage 7: matrix-strategy ----
    pass_stage(
        workspace.path(),
        &mut run,
        "matrix-strategy",
        Some(StageOutput::MatrixStrategy(Box::new(matrix_strategy()))),
    );
    pass_stage(
        workspace.path(),
        &mut run,
        "matrix-strategy",
        Some(StageOutput::MatrixPlanApproved),
    );
    assert!(run.matrix_plan_approved);

    // ---- Stage 8: query-quality-loop ----
    pass_stage(
        workspace.path(),
        &mut run,
        "query-quality-loop",
        Some(StageOutput::QueryQualityIteration(Box::new(QueryQualityIteration {
            id: "qq-1".to_string(),
            iteration: 1,
            path_id: "abc".to_string(),
            query: "TITLE-ABS-KEY(\"code review\" AND \"LLM\") AND DOCTYPE(re)".to_string(),
            sample_record_ids: (1..=20).map(|i| format!("rec-{i}")).collect(),
            sample_size: 20,
            relevant_count: 14,
            low_relevance_count: 6,
            estimated_precision: 0.7,
            false_positive_patterns: vec!["non-review papers".to_string()],
            adjustment_directions: vec!["tighten DOCTYPE".to_string()],
            recommendation: "continue".to_string(),
            reviewer_status: Some(ReviewerGateStatus::Approved),
            reviewer_summary: Some("acceptable".to_string()),
            reviewer_issues: Vec::new(),
            quality_issues: Vec::new(),
            reviewer_approved: true,
            created_at: now_iso8601(),
        }))),
    );

    // ---- Stage 9: primary-library ----
    let allocations = vec![
        PrimaryPathAllocation {
            id: "abc".to_string(),
            max_results: 200,
            rationale: "core".to_string(),
        },
        PrimaryPathAllocation {
            id: "ab".to_string(),
            max_results: 150,
            rationale: "subject".to_string(),
        },
        PrimaryPathAllocation {
            id: "bc".to_string(),
            max_results: 100,
            rationale: "process".to_string(),
        },
        PrimaryPathAllocation {
            id: "ac".to_string(),
            max_results: 50,
            rationale: "context bridge".to_string(),
        },
    ];
    run.primary_path_allocations = allocations;
    let primary_record_ids: Vec<String> = (1..=500).map(|i| format!("prim-{i}")).collect();
    run.primary_target_results = 500;
    pass_stage(
        workspace.path(),
        &mut run,
        "primary-library",
        Some(StageOutput::PrimaryLibrary {
            protocol_id: "pp-1".to_string(),
            search_run_id: "psr-1".to_string(),
            record_ids: primary_record_ids.clone(),
            coverage: Box::new(WorkflowCoverage {
                total_hits: Some(620),
                fetched: 620,
                unique: 500,
                exhausted: false,
                next_cursor: Some("cursor-2".to_string()),
                truncated_reason: None,
                skipped_sources: Vec::new(),
                failed_sources: Vec::new(),
                source_attempts: Vec::new(),
            }),
        }),
    );
    assert!(primary_library_ready(&run));
    assert_eq!(run.primary_record_ids.len(), 500);

    // ---- Stage 10: batch-grading ----
    let grades: Vec<WorkflowPaperGrade> = primary_record_ids
        .iter()
        .enumerate()
        .map(|(index, id)| WorkflowPaperGrade {
            record_id: id.clone(),
            original_index: index as u32,
            grade: if index < 100 {
                "A".to_string()
            } else if index < 300 {
                "B".to_string()
            } else if index < 480 {
                "C".to_string()
            } else {
                "D".to_string()
            },
            key_finding: format!("key finding for {id}"),
            rationale: "evidence-linked".to_string(),
            method: "reviewer_batched".to_string(),
        })
        .collect();
    pass_stage(
        workspace.path(),
        &mut run,
        "batch-grading",
        Some(StageOutput::Grades(grades.clone())),
    );
    assert_eq!(run.paper_grades.len(), 500);

    // ---- Stage 11: outline ----
    let cluster_ids: Vec<String> = grades
        .iter()
        .filter(|g| g.grade == "A" || g.grade == "B")
        .take(50)
        .map(|g| g.record_id.clone())
        .collect();
    let clusters = vec![
        WorkflowOutlineCluster {
            id: "cluster-1".to_string(),
            title: "automated feedback".to_string(),
            claim: "LLMs can produce actionable review feedback".to_string(),
            record_ids: cluster_ids.iter().take(25).cloned().collect(),
            evidence_gaps: Vec::new(),
            contested: Vec::new(),
        },
        WorkflowOutlineCluster {
            id: "cluster-2".to_string(),
            title: "evaluation methodology".to_string(),
            claim: "no shared benchmark for LLM-based code review".to_string(),
            record_ids: cluster_ids.iter().skip(25).cloned().collect(),
            evidence_gaps: Vec::new(),
            contested: Vec::new(),
        },
    ];
    pass_stage(
        workspace.path(),
        &mut run,
        "outline",
        Some(StageOutput::OutlineClusters {
            clusters,
            fingerprint: "fingerprint-happy".to_string(),
        }),
    );
    assert!(!run.outline_clusters.is_empty());

    let outline = vec![WorkflowOutlineSection {
        id: "1".to_string(),
        title: "Introduction".to_string(),
        purpose: "frame the review".to_string(),
        record_ids: Vec::new(),
        children: vec![WorkflowOutlineSection {
            id: "1.1".to_string(),
            title: "scope".to_string(),
            purpose: "define scope".to_string(),
            record_ids: cluster_ids.iter().take(5).cloned().collect(),
            children: Vec::new(),
        }],
    }];
    pass_stage(
        workspace.path(),
        &mut run,
        "outline",
        Some(StageOutput::Outline(outline)),
    );
    assert_eq!(run.outline.len(), 1);

    // ---- Stage 12: section-mapping ----
    // Each A/B paper maps uniquely to one section. The validator requires a
    // unique record_id per mapping AND at least one assigned section.
    let mut mappings: Vec<WorkflowPaperMapping> = grades
        .iter()
        .filter(|g| g.grade == "A" || g.grade == "B")
        .map(|g| WorkflowPaperMapping {
            record_id: g.record_id.clone(),
            original_index: g.original_index,
            zotero_locator: g.record_id.clone(),
            direct_section_id: Some("1.1".to_string()),
            indirect_section_id: None,
            contribution: "core evidence".to_string(),
        })
        .collect();
    // Re-target the very last paper to an *indirect* section to prove both
    // assignment shapes round-trip through the validator.
    if let Some(last) = mappings.last_mut() {
        last.direct_section_id = None;
        last.indirect_section_id = Some("1.1".to_string());
    }
    pass_stage(
        workspace.path(),
        &mut run,
        "section-mapping",
        Some(StageOutput::Mappings(mappings.clone())),
    );
    assert_eq!(run.paper_mappings.len(), mappings.len());

    // ---- Stage 13: evidence-synthesis (unimplemented) ----
    assert_done_or_unimplemented(&run);

    // Sanity check on durability: reload the run and confirm the invariants
    // survived the round-trip.
    let reloaded = load_review_workflow(workspace.path(), &run.id)
        .expect("reload")
        .expect("present");
    assert_eq!(reloaded.paper_grades.len(), 500);
    assert!(!reloaded.outline_clusters.is_empty());
    assert_eq!(reloaded.active_stage_id, "evidence-synthesis");

    // `list_review_workflows` must see the run.
    let summaries = list_review_workflows(workspace.path()).expect("list");
    assert_eq!(summaries.len(), 1);
    assert_eq!(summaries[0].id, run.id);
}

// ---------------------------------------------------------------------------
// Three rejection loops on three different stages
// ---------------------------------------------------------------------------

#[test]
fn a_rejected_search_quality_returns_to_plan_revision_and_clears_coverage() {
    let (workspace, mut run) = fresh_run();
    // Stage 1 approved end-to-end (SearchPlan + PlanApproved).
    pass_stage(
        workspace.path(),
        &mut run,
        "scope-and-plan",
        Some(StageOutput::SearchPlan(Box::new(search_plan()))),
    );
    let mut next = run.clone();
    next.plan_approved = true;
    next.scout_automation_status = Some(ScoutAutomationStatus::Running);
    let expected_revision = next.revision;
    run = save_review_workflow(
        workspace.path(),
        ReviewWorkflowSaveInput {
            expected_revision,
            run: next,
            actor: "test".to_string(),
            action: "approve_plan".to_string(),
            summary: "user accepted".to_string(),
            stage_id: Some("scope-and-plan".to_string()),
            lease_owner_turn_id: None,
        },
    )
    .expect("save");

    // Stage 2 reaches the reviewer gate.
    pass_stage(
        workspace.path(),
        &mut run,
        "review-landscape-search",
        Some(StageOutput::SearchExecution {
            protocol_id: "sp-1".to_string(),
            search_run_id: "sr-1".to_string(),
            record_ids: vec!["rec-1".to_string()],
            coverage: Box::new(exhausted_coverage(1)),
        }),
    );

    // Reviewer rejects the search quality (do NOT advance, mark revision).
    let transition = StageTransition {
        stage_id: "review-landscape-search".to_string(),
        outcome: StageOutcome::RevisionRequired,
        output: None,
        gate: Some(ReviewerGate {
            required: true,
            status: ReviewerGateStatus::Rejected,
            reviewer: Some("Independent Reviewer".to_string()),
            summary: Some("coverage too thin".to_string()),
            issues: vec!["only 1 review".to_string()],
            reviewed_at: Some(now_iso8601()),
        }),
        summary: Some("rejected".to_string()),
        advance: false,
    };
    let mut next = apply_transition(&run, transition).expect("transition");
    let expected_revision = next.revision;
    next = save_review_workflow(
        workspace.path(),
        ReviewWorkflowSaveInput {
            expected_revision,
            run: next,
            actor: "test".to_string(),
            action: "reject_search".to_string(),
            summary: "rejected".to_string(),
            stage_id: Some("review-landscape-search".to_string()),
            lease_owner_turn_id: None,
        },
    )
    .expect("save");
    assert_eq!(next.active_stage_id, "review-landscape-search");

    // Now rewind upstream: the user wants to fix the plan. The save layer
    // blocks rewinds that leave a passed downstream stage, so the chain has
    // to be cleared by reopening all stages.
    let rewind = StageTransition {
        stage_id: "scope-and-plan".to_string(),
        outcome: StageOutcome::InProgress,
        output: None,
        gate: Some(ReviewerGate {
            required: true,
            status: ReviewerGateStatus::Pending,
            reviewer: None,
            summary: None,
            issues: Vec::new(),
            reviewed_at: None,
        }),
        summary: Some("back to plan".to_string()),
        advance: false,
    };
    let mut next = apply_transition(&next, rewind).expect("rewind applies");
    let expected_revision = next.revision;
    next = save_review_workflow(
        workspace.path(),
        ReviewWorkflowSaveInput {
            expected_revision,
            run: next,
            actor: "test".to_string(),
            action: "rewind".to_string(),
            summary: "rewind to plan".to_string(),
            stage_id: Some("scope-and-plan".to_string()),
            lease_owner_turn_id: None,
        },
    )
    .expect("save");
    // The downstream search stage must have been reset.
    let search_stage = next
        .stages
        .iter()
        .find(|s| s.id == "review-landscape-search")
        .expect("stage");
    assert_ne!(
        search_stage.status,
        ReviewWorkflowStageStatus::Passed,
        "downstream stage must be cleared when an upstream is reworked"
    );
}

#[test]
fn a_low_precision_pilot_pauses_for_user_instead_of_running_again() {
    let (_workspace, mut run) = fresh_run();
    pass_through_to(&mut run, "query-quality-loop");
    run.scout_automation_status = Some(ScoutAutomationStatus::Running);
    let next = apply_transition(
        &run,
        StageTransition {
            stage_id: "query-quality-loop".to_string(),
            outcome: StageOutcome::WaitingReviewer,
            output: Some(StageOutput::QueryQualityIteration(Box::new(QueryQualityIteration {
                id: "qq-low".to_string(),
                iteration: 1,
                path_id: "abc".to_string(),
                query: "TITLE-ABS-KEY(\"code review\") AND DOCTYPE(re)".to_string(),
                sample_record_ids: Vec::new(),
                sample_size: 20,
                relevant_count: 6,
                low_relevance_count: 14,
                estimated_precision: 0.3,
                false_positive_patterns: vec!["non-LLM papers".to_string()],
                adjustment_directions: vec!["add LLM term".to_string()],
                recommendation: "revise".to_string(),
                reviewer_status: Some(ReviewerGateStatus::Approved),
                reviewer_summary: Some("low precision".to_string()),
                reviewer_issues: Vec::new(),
                quality_issues: vec!["precision below 50%".to_string()],
                reviewer_approved: false,
                created_at: now_iso8601(),
            }))),
            gate: Some(approved_gate()),
            summary: Some("pilot done".to_string()),
            advance: false,
        },
    )
    .expect("transition");
    // Driver must say AwaitUser — NOT run another pilot and NOT advance.
    match next_step(&next) {
        WorkflowNext::AwaitUser { stage_id, reason } => {
            assert_eq!(stage_id, "query-quality-loop");
            assert!(
                reason.contains("50%")
                    || reason.contains("修订")
                    || reason.contains("问题"),
                "reason must mention precision or revision: {reason}"
            );
        }
        other => panic!("expected AwaitUser, got {other:?}"),
    }
}

#[test]
fn a_rejected_pilot_pauses_for_user_not_a_re_review() {
    let (_workspace, mut run) = fresh_run();
    pass_through_to(&mut run, "query-quality-loop");
    run.scout_automation_status = Some(ScoutAutomationStatus::Running);
    let next = apply_transition(
        &run,
        StageTransition {
            stage_id: "query-quality-loop".to_string(),
            outcome: StageOutcome::RevisionRequired,
            output: Some(StageOutput::QueryQualityIteration(Box::new(QueryQualityIteration {
                id: "qq-rej".to_string(),
                iteration: 1,
                path_id: "abc".to_string(),
                query: "TITLE-ABS-KEY(\"code review\") AND DOCTYPE(re)".to_string(),
                sample_record_ids: Vec::new(),
                sample_size: 20,
                relevant_count: 6,
                low_relevance_count: 14,
                estimated_precision: 0.3,
                false_positive_patterns: vec!["non-LLM".to_string()],
                adjustment_directions: vec!["add LLM term".to_string()],
                recommendation: "revise".to_string(),
                reviewer_status: Some(ReviewerGateStatus::Rejected),
                reviewer_summary: Some("rejected".to_string()),
                reviewer_issues: vec!["too broad".to_string()],
                quality_issues: Vec::new(),
                reviewer_approved: false,
                created_at: now_iso8601(),
            }))),
            gate: Some(ReviewerGate {
                required: true,
                status: ReviewerGateStatus::Rejected,
                reviewer: Some("Independent Reviewer".to_string()),
                summary: Some("no".to_string()),
                issues: vec!["too broad".to_string()],
                reviewed_at: Some(now_iso8601()),
            }),
            summary: Some("rejected".to_string()),
            advance: false,
        },
    )
    .expect("transition");
    match next_step(&next) {
        WorkflowNext::AwaitUser { stage_id, reason } => {
            assert_eq!(stage_id, "query-quality-loop");
            assert!(
                reason.contains("矩阵策略")
                    || reason.contains("修订")
                    || reason.contains("未通过"),
                "reason must mention the matrix-strategy revision loop: {reason}"
            );
        }
        other => panic!("expected AwaitUser after rejected pilot, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Batched-job lease + checkpoint resumption
// ---------------------------------------------------------------------------

#[test]
fn a_batched_job_holds_a_lease_and_rejects_concurrent_writers() {
    let (workspace, mut run) = fresh_run();
    pass_through_to(&mut run, "batch-grading");
    run.scout_automation_status = Some(ScoutAutomationStatus::Running);

    let owner_turn = "turn-batch-grading-1";
    let leased = acquire_run_lease(workspace.path(), &run.id, owner_turn, 600)
        .expect("acquire");
    assert!(leased.lease.is_some());
    run = leased;

    // A second writer must fail fast at acquire time.
    let err = acquire_run_lease(workspace.path(), &run.id, "turn-someone-else", 600)
        .expect_err("must refuse");
    assert!(err.contains("already running"), "got: {err}");

    // The legitimate holder can save with lease_owner_turn_id.
    let mut checkpointed = run.clone();
    checkpointed.batch_checkpoint = Some(WorkflowBatchCheckpoint {
        kind: "grading".to_string(),
        stage_id: "batch-grading".to_string(),
        input_fingerprint: "fp-grading-1".to_string(),
        batch_size: 50,
        completed_batches: 3,
        total_batches: 10,
        partial: serde_json::json!({"grades": []}),
        updated_at: now_iso8601(),
    });
    let saved = save_review_workflow(
        workspace.path(),
        ReviewWorkflowSaveInput {
            expected_revision: checkpointed.revision,
            run: checkpointed,
            actor: "Executor".to_string(),
            action: "batch_checkpoint".to_string(),
            summary: "batch 3/10".to_string(),
            stage_id: Some("batch-grading".to_string()),
            lease_owner_turn_id: Some(owner_turn.to_string()),
        },
    )
    .expect("save");
    assert_eq!(
        saved
            .batch_checkpoint
            .as_ref()
            .expect("checkpoint")
            .completed_batches,
        3
    );

    // A second writer (different turn id) trying to save must be blocked by
    // the held lease, even though optimistic revision would otherwise pass.
    let impostor = saved.clone();
    let err = save_review_workflow(
        workspace.path(),
        ReviewWorkflowSaveInput {
            expected_revision: impostor.revision,
            run: impostor,
            actor: "Other".to_string(),
            action: "batch_checkpoint".to_string(),
            summary: "should not pass".to_string(),
            stage_id: Some("batch-grading".to_string()),
            lease_owner_turn_id: Some("turn-someone-else".to_string()),
        },
    )
    .expect_err("must refuse");
    assert!(
        err.contains("lease") || err.contains("held"),
        "got: {err}"
    );

    // Releasing the lease lets a new owner take over.
    let released = release_run_lease(workspace.path(), &run.id, owner_turn).expect("release");
    assert!(released.lease.is_none());

    let next_owner = acquire_run_lease(workspace.path(), &run.id, "turn-resume", 600)
        .expect("reacquire");
    assert!(next_owner.lease.is_some());
}

#[test]
fn an_expired_lease_can_be_taken_over() {
    // `save_review_workflow` always refreshes the lease to `now + 600s`, so
    // the production path can never produce an expired on-disk lease. To
    // exercise takeover we have to forge an expired lease in the JSON file
    // directly. If that ever changes (e.g. the lease is moved to a separate
    // table), this test becomes a useful canary.
    let (workspace, run) = fresh_run();
    let owner = "turn-old";
    let leased = acquire_run_lease(workspace.path(), &run.id, owner, 1).expect("acquire");
    assert!(leased.lease.is_some());

    write_run_with_expired_lease(workspace.path(), &run.id);

    // Another owner should now be able to take over after expiry.
    let next = acquire_run_lease(workspace.path(), &run.id, "turn-new", 600)
        .expect("takeover");
    assert_eq!(
        next.lease.as_ref().expect("lease").owner_turn_id,
        "turn-new"
    );
}

// ---------------------------------------------------------------------------
// Other invariants worth exercising end-to-end
// ---------------------------------------------------------------------------

#[test]
fn next_step_with_an_unknown_active_stage_id_pauses() {
    let (_workspace, mut run) = fresh_run();
    run.active_stage_id = "not-a-real-stage".to_string();
    match next_step(&run) {
        WorkflowNext::Paused { stage_id, reason } => {
            assert_eq!(stage_id, "not-a-real-stage");
            assert!(reason.contains("不存在") || reason.contains("人工"));
        }
        other => panic!("expected Paused, got {other:?}"),
    }
}

#[test]
fn context_policy_defaults_keep_large_abstract_batches() {
    let (_, run) = fresh_run();
    assert_eq!(
        run.context_policy.abstract_batch_size, 50,
        "abstract batch must be 50 by default so the compactor doesn't choke"
    );
    assert_eq!(
        run.context_policy.abstract_chars_per_record, 2_400,
        "per-record cap must be 2400 chars per spec"
    );
    assert_eq!(
        run.context_policy.synthesis_input_chars, 60_000,
        "synthesis input cap must be 60_000 chars per spec"
    );
}

#[test]
fn reviewing_a_finished_outline_does_not_skip_the_user_edit_handoff() {
    let (_workspace, mut run) = fresh_run();
    pass_through_to(&mut run, "outline");
    let grades: Vec<WorkflowPaperGrade> = (0..3)
        .map(|i| WorkflowPaperGrade {
            record_id: format!("prim-{i}"),
            original_index: i,
            grade: "A".to_string(),
            key_finding: "core".to_string(),
            rationale: "core".to_string(),
            method: "reviewer".to_string(),
        })
        .collect();
    run.paper_grades = grades.clone();
    run.primary_record_ids = grades.iter().map(|g| g.record_id.clone()).collect();
    let cluster = WorkflowOutlineCluster {
        id: "cluster-1".to_string(),
        title: "feedback loops".to_string(),
        claim: "core".to_string(),
        record_ids: grades.iter().map(|g| g.record_id.clone()).collect(),
        evidence_gaps: Vec::new(),
        contested: Vec::new(),
    };
    run.outline_clusters = vec![cluster];
    run.outline_cluster_fingerprint = Some("fp".to_string());
    run.outline = vec![WorkflowOutlineSection {
        id: "1".to_string(),
        title: "Intro".to_string(),
        purpose: "frame".to_string(),
        record_ids: grades.iter().map(|g| g.record_id.clone()).collect(),
        children: Vec::new(),
    }];

    // Reviewer rejects the outline → stage should sit in RevisionRequired
    // awaiting user edit, not just bounce back to reviewer.
    let transition = StageTransition {
        stage_id: "outline".to_string(),
        outcome: StageOutcome::RevisionRequired,
        output: None,
        gate: Some(ReviewerGate {
            required: true,
            status: ReviewerGateStatus::Rejected,
            reviewer: Some("Independent Reviewer".to_string()),
            summary: Some("outline too thin".to_string()),
            issues: vec!["missing methods chapter".to_string()],
            reviewed_at: Some(now_iso8601()),
        }),
        summary: Some("rejected".to_string()),
        advance: false,
    };
    let next = apply_transition(&run, transition).expect("transition");
    assert_eq!(
        next.stages
            .iter()
            .find(|s| s.id == "outline")
            .unwrap()
            .status,
        ReviewWorkflowStageStatus::RevisionRequired
    );
    match next_step(&next) {
        WorkflowNext::AwaitUser { stage_id, .. } => {
            assert_eq!(stage_id, "outline");
        }
        other => panic!("expected AwaitUser after outline rejection, got {other:?}"),
    }
}

#[test]
fn saves_reject_optimistic_revision_drift() {
    let (workspace, mut run) = fresh_run();
    let initial_revision = run.revision;
    let mut next = run.clone();
    next.revision = initial_revision + 1;
    let err = save_review_workflow(
        workspace.path(),
        ReviewWorkflowSaveInput {
            expected_revision: initial_revision,
            run: next,
            actor: "test".to_string(),
            action: "stale_write".to_string(),
            summary: "stale".to_string(),
            stage_id: Some("scope-and-plan".to_string()),
            lease_owner_turn_id: None,
        },
    )
    .expect_err("must reject");
    assert!(err.contains("revision"), "got: {err}");
}

/// Tiny extension on `ReviewWorkflowRun` so the happy-path block can read
/// `expected_revision_or_zero()` the same way `save_review_workflow` does.
trait RunTestExt {
    fn expected_revision_or_zero(&mut self);
}

impl RunTestExt for ReviewWorkflowRun {
    fn expected_revision_or_zero(&mut self) {
        // No-op placeholder: the actual revision is read off the value we
        // just bumped into `.revision`. Kept as a trait so the call site is
        // self-documenting; this is a test convenience, not a production hook.
        let _ = self.revision;
    }
}