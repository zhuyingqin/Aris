//! Decides what the review workflow does next, and applies stage transitions.
//!
//! Two responsibilities that used to live in React ([`Workflows.tsx`]) and were
//! therefore unenforceable outside the UI:
//!
//! * [`next_step`] — a total, pure function from durable run state to the one
//!   action that should happen next. The old TypeScript version only covered the
//!   five reconnaissance stages; every later stage was driven by whichever button
//!   the user happened to press.
//! * [`apply_transition`] — the only way a stage's outputs may change. It owns
//!   stage ordering and cascading invalidation, so "re-running an upstream stage
//!   invalidates all dependent stages and outputs" is enforced by construction
//!   rather than by remembering to call a reset helper at each call site.
//!
//! Both are pure. Durability, optimistic revisions, and shape validation stay in
//! [`crate::review_workflow`]; a transition produced here is still handed to
//! `save_review_workflow`, which re-validates it.

use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::review_workflow::{
    branch_for_review_count, MatrixSearchStrategy, QueryQualityIteration, ReviewCountBranch,
    ReviewEligibilitySummary, ReviewLandscapeAnalysis, ReviewSearchPlan, ReviewWorkflowRun,
    ReviewWorkflowStage, ReviewWorkflowStageStatus, ReviewerGate, ReviewerGateStatus,
    WorkflowCoverage, WorkflowOutlineCluster, WorkflowOutlineSection, WorkflowPaperGrade,
    WorkflowPaperMapping,
};

/// Source, authentication, or infrastructure states that must pause the
/// retrieval loop instead of being retried forever.
const FAILED_SOURCE_STATUSES: [&str; 4] = ["failed", "rate_limited", "unauthorised", "unavailable"];

/// Stages the template defines but no lane implements yet. Reporting them as a
/// real step would make the controller spin; reporting `Done` would claim a
/// manuscript exists. They stop for the user instead.
const UNIMPLEMENTED_STAGES: [&str; 4] = [
    "evidence-synthesis",
    "manuscript",
    "independent-review",
    "submission-package",
];

// ---------------------------------------------------------------------------
// What happens next
// ---------------------------------------------------------------------------

/// One unit of work the controller can dispatch.
///
/// Executor and Reviewer actions are separate variants of [`WorkflowNext`], not
/// a flag on the action: an Executor must never be able to satisfy a gate by
/// declaring its own output acceptable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowAction {
    GeneratePlan,
    ReviewPlan,
    ApproveRevisedPlan,
    CreateSearchPreview,
    ExecuteSearch,
    ContinueSearch,
    ReviewSearchQuality,
    ScreenEligibility,
    ReviewCoverageBranch,
    AnalyzeLandscape,
    ReviewLandscape,
    BuildMatrixStrategy,
    ReviewMatrixStrategy,
    RunPilotQuery,
    ReviewPilotQuality,
    BuildPrimaryLibrary,
    ContinuePrimarySearch,
    ReviewPrimaryLibrary,
    GradePapers,
    BuildOutlineClusters,
    BuildOutline,
    ReviewOutline,
    MapSections,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowStep {
    pub stage_id: String,
    pub action: WorkflowAction,
    /// Why this step is next, in the user's language. Carried into the turn so
    /// the transcript explains itself without re-deriving state.
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum WorkflowNext {
    /// The Executor produces or revises an artifact.
    ExecutorStep(WorkflowStep),
    /// The independent Reviewer judges an artifact. Never merged into the
    /// Executor step, even when `reviewer_disabled` makes both run on the same
    /// model — the gate still has to record that nobody reviewed it.
    ReviewerStep(WorkflowStep),
    /// Automation stops and the user decides. Restarting is a user action.
    AwaitUser {
        stage_id: String,
        reason: String,
    },
    /// Automation stopped on a condition it must not retry past.
    Paused {
        stage_id: String,
        reason: String,
    },
    Done,
}

impl WorkflowNext {
    /// The stage this outcome concerns, for logging and for the turn tail.
    #[must_use]
    pub fn stage_id(&self) -> Option<&str> {
        match self {
            Self::ExecutorStep(step) | Self::ReviewerStep(step) => Some(&step.stage_id),
            Self::AwaitUser { stage_id, .. } | Self::Paused { stage_id, .. } => Some(stage_id),
            Self::Done => None,
        }
    }

    /// True when the controller should dispatch a model turn for this outcome.
    #[must_use]
    pub const fn is_runnable(&self) -> bool {
        matches!(self, Self::ExecutorStep(_) | Self::ReviewerStep(_))
    }
}

fn executor(stage_id: &str, action: WorkflowAction, reason: &str) -> WorkflowNext {
    WorkflowNext::ExecutorStep(WorkflowStep {
        stage_id: stage_id.to_string(),
        action,
        reason: reason.to_string(),
    })
}

fn reviewer(stage_id: &str, action: WorkflowAction, reason: &str) -> WorkflowNext {
    WorkflowNext::ReviewerStep(WorkflowStep {
        stage_id: stage_id.to_string(),
        action,
        reason: reason.to_string(),
    })
}

fn await_user(stage_id: &str, reason: &str) -> WorkflowNext {
    WorkflowNext::AwaitUser {
        stage_id: stage_id.to_string(),
        reason: reason.to_string(),
    }
}

fn paused(stage_id: &str, reason: &str) -> WorkflowNext {
    WorkflowNext::Paused {
        stage_id: stage_id.to_string(),
        reason: reason.to_string(),
    }
}

/// The single next action for a run, derived only from durable state.
///
/// Total over the whole 16-stage template: an app restart, a crashed turn, or a
/// session that was compacted away all resolve to the same answer, because none
/// of them are inputs.
#[must_use]
pub fn next_step(run: &ReviewWorkflowRun) -> WorkflowNext {
    let Some(stage) = run
        .stages
        .iter()
        .find(|stage| stage.id == run.active_stage_id)
    else {
        return paused(
            &run.active_stage_id,
            "工作流指向了一个不存在的阶段，需要人工修复。",
        );
    };
    step_for_stage(run, stage)
}

/// The step a given stage needs, independent of which stage is currently active.
///
/// Split out so [`advance_to_next_stage`] can look past a finished stage without
/// cloning the run — a run carries every grade and mapping, and this is
/// evaluated on every controller tick.
fn step_for_stage(run: &ReviewWorkflowRun, stage: &ReviewWorkflowStage) -> WorkflowNext {
    if UNIMPLEMENTED_STAGES.contains(&stage.id.as_str()) {
        return await_user(
            &stage.id,
            "该阶段的写作流水线尚未实现，综述知识库到此为止。",
        );
    }
    match stage.id.as_str() {
        "scope-and-plan" => scope_and_plan_step(run, stage),
        "review-landscape-search" => review_landscape_search_step(run, stage),
        "review-eligibility" => review_eligibility_step(run, stage),
        "coverage-and-branch" => coverage_and_branch_step(run, stage),
        "gap-analysis" => gap_analysis_step(run, stage),
        "direction-selection" => direction_selection_step(run, stage),
        "matrix-strategy" => matrix_strategy_step(run, stage),
        "query-quality-loop" => query_quality_step(run, stage),
        "primary-library" => primary_library_step(run, stage),
        "batch-grading" => batch_grading_step(run, stage),
        "outline" => outline_step(run, stage),
        "section-mapping" => section_mapping_step(run, stage),
        // Kept as a defensive compatibility branch for an in-memory legacy run;
        // template v3 migrates persisted runs away from this removed stage.
        "zotero-organization" => await_user(
            &stage.id,
            "Zotero 结构化重构已从当前版本移除；当前版本止于论文到章节映射。",
        ),
        other => paused(other, "未知阶段，无法决定下一步。"),
    }
}

fn scope_and_plan_step(run: &ReviewWorkflowRun, stage: &ReviewWorkflowStage) -> WorkflowNext {
    let gate = stage.reviewer_gate.status;
    if run.search_plan.is_none() {
        return executor(
            &stage.id,
            WorkflowAction::GeneratePlan,
            "尚无检索计划，需要生成数据源特定的检索式。",
        );
    }
    if gate == ReviewerGateStatus::Rejected {
        return executor(
            &stage.id,
            WorkflowAction::GeneratePlan,
            "Reviewer 拒绝了当前检索计划，按其问题重新生成。",
        );
    }
    if gate == ReviewerGateStatus::Pending {
        return reviewer(
            &stage.id,
            WorkflowAction::ReviewPlan,
            "检索计划已生成，等待独立 Reviewer 审查。",
        );
    }
    if run.plan_approved {
        return advance_to_next_stage(run, stage);
    }
    // The doc grants one user approval for the whole bounded reconnaissance
    // loop; a Reviewer-approved revision inside that loop does not ask again.
    if is_automation_running(run) {
        executor(
            &stage.id,
            WorkflowAction::ApproveRevisedPlan,
            "Reviewer 已批准修订后的检索计划，自动继续本轮侦察。",
        )
    } else {
        await_user(
            &stage.id,
            "检索计划已通过审查，等待用户确认后开始外部检索。",
        )
    }
}

fn review_landscape_search_step(
    run: &ReviewWorkflowRun,
    stage: &ReviewWorkflowStage,
) -> WorkflowNext {
    if run.search_protocol_id.is_none() {
        return executor(
            &stage.id,
            WorkflowAction::CreateSearchPreview,
            "需要先生成可预览的检索协议，外部检索才可审计。",
        );
    }
    let Some(coverage) = run.coverage.as_ref() else {
        return executor(
            &stage.id,
            WorkflowAction::ExecuteSearch,
            "协议已就绪，执行首轮综述检索。",
        );
    };
    if !coverage.exhausted {
        if coverage_has_failure(coverage) {
            return paused(
                &stage.id,
                "检索遇到来源失败或鉴权问题，已暂停以便人工处理后续续读。",
            );
        }
        return if coverage.next_cursor.is_some() {
            executor(
                &stage.id,
                WorkflowAction::ContinueSearch,
                "检索尚未耗尽且有可用游标，继续续读。",
            )
        } else {
            paused(
                &stage.id,
                "检索结果未标记为完整，且没有可用续读游标；已暂停等待人工检查。",
            )
        };
    }
    match stage.reviewer_gate.status {
        ReviewerGateStatus::Pending | ReviewerGateStatus::NotRequired => reviewer(
            &stage.id,
            WorkflowAction::ReviewSearchQuality,
            "检索覆盖已耗尽，等待 Reviewer 审查回收质量。",
        ),
        ReviewerGateStatus::Rejected => paused(
            &stage.id,
            "Reviewer 拒绝了检索回收质量，等待返回检索计划修订。",
        ),
        ReviewerGateStatus::Approved | ReviewerGateStatus::Skipped => {
            advance_to_next_stage(run, stage)
        }
    }
}

/// A stage the run is sitting on that still owes its own work.
///
/// "The output is missing" stopped being able to express this once a finished
/// stage could be reopened from the desktop: the rewind keeps the output so the
/// user can edit it, and the stage still has to be redone. Reading only the
/// output made a reopened stage look finished, so the driver reported the
/// *next* stage's work and skipped straight over the step the user had just
/// gone back to. Mirrored by `stageNeedsRework` in
/// `desktop/src/workflows/workflowEngine.ts`.
const fn stage_needs_rework(stage: &ReviewWorkflowStage) -> bool {
    matches!(
        stage.status,
        ReviewWorkflowStageStatus::WaitingUser | ReviewWorkflowStageStatus::RevisionRequired
    )
}

fn review_eligibility_step(run: &ReviewWorkflowRun, stage: &ReviewWorkflowStage) -> WorkflowNext {
    if run.review_eligibility.complete && !stage_needs_rework(stage) {
        advance_to_next_stage(run, stage)
    } else {
        reviewer(
            &stage.id,
            WorkflowAction::ScreenEligibility,
            "候选记录尚未完成真实综述资格核验。",
        )
    }
}

fn coverage_and_branch_step(run: &ReviewWorkflowRun, stage: &ReviewWorkflowStage) -> WorkflowNext {
    match stage.reviewer_gate.status {
        ReviewerGateStatus::Pending
        | ReviewerGateStatus::Rejected
        | ReviewerGateStatus::NotRequired => reviewer(
            &stage.id,
            WorkflowAction::ReviewCoverageBranch,
            "需要 Reviewer 确认覆盖状态与数量分支的计算依据。",
        ),
        ReviewerGateStatus::Approved | ReviewerGateStatus::Skipped => {
            if run.review_count_branch == ReviewCountBranch::Insufficient {
                paused(&stage.id, "合格综述少于 10 篇，需要回到检索计划扩大范围。")
            } else {
                advance_to_next_stage(run, stage)
            }
        }
    }
}

fn gap_analysis_step(run: &ReviewWorkflowRun, stage: &ReviewWorkflowStage) -> WorkflowNext {
    if run.landscape_analysis.is_none() {
        return executor(
            &stage.id,
            WorkflowAction::AnalyzeLandscape,
            "尚无综述格局分析，需要分批归纳后综合出候选方向。",
        );
    }
    // Checked before the gate: a reopened stage on a run with independent
    // review switched off carries a `Skipped` gate, which would otherwise read
    // as "already settled" and advance past the step being reworked.
    if stage_needs_rework(stage) {
        return executor(
            &stage.id,
            WorkflowAction::AnalyzeLandscape,
            "阶段已重新打开，需要按新的范围重做格局分析。",
        );
    }
    if stage.reviewer_gate.status == ReviewerGateStatus::Pending {
        return reviewer(
            &stage.id,
            WorkflowAction::ReviewLandscape,
            "格局分析已生成，等待独立 Reviewer 审查。",
        );
    }
    if stage.reviewer_gate.status == ReviewerGateStatus::Rejected {
        return executor(
            &stage.id,
            WorkflowAction::AnalyzeLandscape,
            "Reviewer 拒绝了格局分析，按其问题重做。",
        );
    }
    advance_to_next_stage(run, stage)
}

fn direction_selection_step(run: &ReviewWorkflowRun, stage: &ReviewWorkflowStage) -> WorkflowNext {
    if run.selected_direction_id.is_none() {
        // The one place automation is designed to stop: the direction changes
        // every downstream scope, so it is the user's call, not the model's.
        return await_user(&stage.id, "自动侦察已完成，等待用户从候选方向中选择一个。");
    }
    // A reopened stage keeps the previous `selected_direction_id` around so the
    // user can see what was chosen before; that alone must not read as settled,
    // or a rework would fall straight through to matrix-strategy.
    if stage_needs_rework(stage) {
        return await_user(
            &stage.id,
            "方向选择阶段已重新打开，等待用户重新确认研究方向。",
        );
    }
    advance_to_next_stage(run, stage)
}

fn matrix_strategy_step(run: &ReviewWorkflowRun, stage: &ReviewWorkflowStage) -> WorkflowNext {
    if run.matrix_strategy.is_none() {
        return executor(
            &stage.id,
            WorkflowAction::BuildMatrixStrategy,
            "需要把所选方向分解为 A/B/C 语义群并生成四条矩阵路径。",
        );
    }
    match stage.reviewer_gate.status {
        ReviewerGateStatus::Pending | ReviewerGateStatus::NotRequired => reviewer(
            &stage.id,
            WorkflowAction::ReviewMatrixStrategy,
            "矩阵策略已生成，等待独立 Reviewer 审查。",
        ),
        ReviewerGateStatus::Rejected => executor(
            &stage.id,
            WorkflowAction::BuildMatrixStrategy,
            "Reviewer 拒绝了矩阵策略，按其问题重做。",
        ),
        ReviewerGateStatus::Approved | ReviewerGateStatus::Skipped => {
            if run.matrix_plan_approved {
                advance_to_next_stage(run, stage)
            } else {
                await_user(&stage.id, "矩阵策略已通过审查，等待用户确认后开始试检。")
            }
        }
    }
}

fn query_quality_step(run: &ReviewWorkflowRun, stage: &ReviewWorkflowStage) -> WorkflowNext {
    let Some(latest) = run.query_quality_iterations.last() else {
        return executor(
            &stage.id,
            WorkflowAction::RunPilotQuery,
            "需要按日期抽取 100 篇试检样本并统计相关度。",
        );
    };
    // Once the quality decision has been recorded, stop so the UI can show its
    // concrete defects and the user can explicitly carry them back to the
    // matrix-strategy stage. Asking the Reviewer again here loses that handoff
    // and running another pilot would repeat the rejected query.
    if stage.status == ReviewWorkflowStageStatus::RevisionRequired
        || latest.reviewer_status == Some(ReviewerGateStatus::Rejected)
    {
        return await_user(
            &stage.id,
            "试检质量未通过；先展示问题清单，再返回矩阵策略把意见写入修订提示词。",
        );
    }
    if latest.reviewer_status.is_none() && !latest.reviewer_approved {
        return reviewer(
            &stage.id,
            WorkflowAction::ReviewPilotQuality,
            "试检结果已统计，等待 Reviewer 判断是否继续或修订查询。",
        );
    }
    // Roughly 50% title/abstract relevance is the documented minimum signal to
    // continue; below it the query is revised rather than scaled up.
    if latest.estimated_precision < 0.5 {
        return await_user(
            &stage.id,
            "试检查准率低于 50%；先展示确定性质量问题，再返回矩阵策略修订查询。",
        );
    }
    advance_to_next_stage(run, stage)
}

fn primary_library_step(run: &ReviewWorkflowRun, stage: &ReviewWorkflowStage) -> WorkflowNext {
    let Some(coverage) = run.primary_coverage.as_ref() else {
        return executor(
            &stage.id,
            WorkflowAction::BuildPrimaryLibrary,
            "需要用已批准策略执行原始文献全量检索。",
        );
    };
    if !crate::review_workflow::primary_library_ready(run) {
        if coverage_has_failure(coverage) {
            return paused(
                &stage.id,
                "原始文献检索遇到来源失败或鉴权问题，已暂停等待人工处理。",
            );
        }
        return if coverage.next_cursor.is_some() {
            executor(
                &stage.id,
                WorkflowAction::ContinuePrimarySearch,
                "原始文献检索尚未耗尽，继续续读。",
            )
        } else {
            paused(
                &stage.id,
                "原始文献检索未耗尽且没有续读游标，已暂停等待人工检查。",
            )
        };
    }
    match stage.reviewer_gate.status {
        ReviewerGateStatus::Pending | ReviewerGateStatus::NotRequired => reviewer(
            &stage.id,
            WorkflowAction::ReviewPrimaryLibrary,
            "原始文献库已达到目标或覆盖耗尽，等待独立 Reviewer 审查建库边界。",
        ),
        ReviewerGateStatus::Rejected => paused(
            &stage.id,
            "独立 Reviewer 拒绝了当前原始文献库，等待用户检查范围后重新建库。",
        ),
        ReviewerGateStatus::Approved | ReviewerGateStatus::Skipped => {
            advance_to_next_stage(run, stage)
        }
    }
}

fn batch_grading_step(run: &ReviewWorkflowRun, stage: &ReviewWorkflowStage) -> WorkflowNext {
    let primary_ready = run
        .stages
        .iter()
        .find(|candidate| candidate.id == "primary-library")
        .is_some_and(|primary| {
            primary.status == ReviewWorkflowStageStatus::Passed
                && matches!(
                    primary.reviewer_gate.status,
                    ReviewerGateStatus::Approved | ReviewerGateStatus::Skipped
                )
                && crate::review_workflow::primary_library_ready(run)
        });
    if !primary_ready {
        return paused(
            &stage.id,
            "原始文献库未完成覆盖条件与 Reviewer gate，不能开始分级。",
        );
    }
    if run.paper_grades.len() < run.primary_record_ids.len() {
        return reviewer(
            &stage.id,
            WorkflowAction::GradePapers,
            "原始文献尚未全部完成 A/B/C/D 分级。",
        );
    }
    match stage.reviewer_gate.status {
        ReviewerGateStatus::Pending | ReviewerGateStatus::NotRequired => reviewer(
            &stage.id,
            WorkflowAction::GradePapers,
            "全部原始文献已完成分级，等待独立 Reviewer 确认分级结果。",
        ),
        ReviewerGateStatus::Rejected => reviewer(
            &stage.id,
            WorkflowAction::GradePapers,
            "Reviewer 拒绝了当前分级结果，需要重新核对后再次提交。",
        ),
        ReviewerGateStatus::Approved | ReviewerGateStatus::Skipped => {
            advance_to_next_stage(run, stage)
        }
    }
}

fn outline_step(run: &ReviewWorkflowRun, stage: &ReviewWorkflowStage) -> WorkflowNext {
    if run.outline_clusters.is_empty() {
        return executor(
            &stage.id,
            WorkflowAction::BuildOutlineClusters,
            "需要先从 A/B 级文献构建可见、可复用的主题聚类。",
        );
    }
    if run.outline.is_empty() {
        return executor(
            &stage.id,
            WorkflowAction::BuildOutline,
            "主题聚类已经就绪，可据此构建到 x.x 层级的写作大纲。",
        );
    }
    if stage.status == ReviewWorkflowStageStatus::WaitingUser {
        return await_user(&stage.id, "大纲正在等待用户完成编辑并保存。");
    }
    if stage.status != ReviewWorkflowStageStatus::Passed {
        if stage.reviewer_gate.status == ReviewerGateStatus::Rejected {
            return await_user(&stage.id, "大纲需要根据 Reviewer 意见修改后重新提交审查。");
        }
        return reviewer(
            &stage.id,
            WorkflowAction::ReviewOutline,
            "大纲已生成或被用户修改，等待独立 Reviewer 重新审查。",
        );
    }
    advance_to_next_stage(run, stage)
}

fn section_mapping_step(run: &ReviewWorkflowRun, stage: &ReviewWorkflowStage) -> WorkflowNext {
    if stage.status != ReviewWorkflowStageStatus::Passed {
        return reviewer(
            &stage.id,
            WorkflowAction::MapSections,
            "尚未完成 A/B 级文献的章节映射审查。",
        );
    }
    advance_to_next_stage(run, stage)
}

/// The step for the stage after `stage`, or `Done` when it was the last one.
///
/// Reached only when the current stage is genuinely finished, so the recursion
/// always moves forward and terminates at the end of the template.
fn advance_to_next_stage(run: &ReviewWorkflowRun, stage: &ReviewWorkflowStage) -> WorkflowNext {
    // `active_stage_id` may not have caught up yet — the controller is expected
    // to apply a transition that moves it. Reporting the following stage's work
    // keeps the controller from idling on a stage that is already finished.
    run.stages
        .iter()
        .find(|candidate| candidate.ordinal == stage.ordinal + 1)
        .map_or(WorkflowNext::Done, |next| step_for_stage(run, next))
}

const fn is_automation_running(run: &ReviewWorkflowRun) -> bool {
    matches!(
        run.scout_automation_status,
        Some(crate::review_workflow::ScoutAutomationStatus::Running)
    )
}

fn coverage_has_failure(coverage: &WorkflowCoverage) -> bool {
    !coverage.failed_sources.is_empty()
        || coverage.source_attempts.iter().any(|attempt| {
            FAILED_SOURCE_STATUSES.contains(&attempt.status.as_str())
                || attempt.failure_message.is_some()
        })
}

// ---------------------------------------------------------------------------
// Applying a transition
// ---------------------------------------------------------------------------

/// The outputs one stage owns.
///
/// Modelled per stage rather than as a free-form patch so a stage can only ever
/// write its own fields: the compiler, not a reviewer, rules out a grading step
/// that quietly rewrites the search plan.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum StageOutput {
    SearchPlan(Box<ReviewSearchPlan>),
    PlanApproved,
    SearchExecution {
        protocol_id: String,
        search_run_id: String,
        record_ids: Vec<String>,
        coverage: Box<WorkflowCoverage>,
    },
    Eligibility(Box<ReviewEligibilitySummary>),
    CountBranch(ReviewCountBranch),
    Landscape(Box<ReviewLandscapeAnalysis>),
    Direction(String),
    MatrixStrategy(Box<MatrixSearchStrategy>),
    MatrixPlanApproved,
    MatrixPilot {
        protocol_id: String,
        search_run_id: String,
        path_id: String,
        record_ids: Vec<String>,
        coverage: Box<WorkflowCoverage>,
    },
    QueryQualityIteration(Box<QueryQualityIteration>),
    PrimaryLibrary {
        protocol_id: String,
        search_run_id: String,
        record_ids: Vec<String>,
        coverage: Box<WorkflowCoverage>,
    },
    Grades(Vec<WorkflowPaperGrade>),
    OutlineClusters {
        clusters: Vec<WorkflowOutlineCluster>,
        fingerprint: String,
    },
    Outline(Vec<WorkflowOutlineSection>),
    Mappings(Vec<WorkflowPaperMapping>),
}

impl StageOutput {
    /// The stage allowed to produce this output.
    const fn owner_stage_id(&self) -> &'static str {
        match self {
            Self::SearchPlan(_) | Self::PlanApproved => "scope-and-plan",
            Self::SearchExecution { .. } => "review-landscape-search",
            Self::Eligibility(_) => "review-eligibility",
            Self::CountBranch(_) => "coverage-and-branch",
            Self::Landscape(_) => "gap-analysis",
            Self::Direction(_) => "direction-selection",
            Self::MatrixStrategy(_) | Self::MatrixPlanApproved => "matrix-strategy",
            Self::MatrixPilot { .. } | Self::QueryQualityIteration(_) => "query-quality-loop",
            Self::PrimaryLibrary { .. } => "primary-library",
            Self::Grades(_) => "batch-grading",
            Self::OutlineClusters { .. } | Self::Outline(_) => "outline",
            Self::Mappings(_) => "section-mapping",
        }
    }
}

/// How the stage itself ends up after the transition.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StageOutcome {
    InProgress,
    WaitingUser,
    WaitingReviewer,
    RevisionRequired,
    Blocked,
    Partial,
    Passed,
}

impl StageOutcome {
    const fn as_status(self) -> ReviewWorkflowStageStatus {
        match self {
            Self::InProgress => ReviewWorkflowStageStatus::InProgress,
            Self::WaitingUser => ReviewWorkflowStageStatus::WaitingUser,
            Self::WaitingReviewer => ReviewWorkflowStageStatus::WaitingReviewer,
            Self::RevisionRequired => ReviewWorkflowStageStatus::RevisionRequired,
            Self::Blocked => ReviewWorkflowStageStatus::Blocked,
            Self::Partial => ReviewWorkflowStageStatus::Partial,
            Self::Passed => ReviewWorkflowStageStatus::Passed,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageTransition {
    pub stage_id: String,
    pub outcome: StageOutcome,
    #[serde(default)]
    pub output: Option<StageOutput>,
    #[serde(default)]
    pub gate: Option<ReviewerGate>,
    #[serde(default)]
    pub summary: Option<String>,
    /// Moves `active_stage_id` to the next stage and marks it ready. Only
    /// meaningful together with `StageOutcome::Passed`.
    #[serde(default)]
    pub advance: bool,
}

/// Applies one stage transition to a run, cascading invalidation downstream.
///
/// The returned run is a candidate: `save_review_workflow` still re-validates
/// its shape and the optimistic revision. What this function guarantees is that
/// no stage can write another stage's outputs, and that reworking a stage cannot
/// leave stale downstream results behind — the failure mode the TypeScript
/// `resetStagesAfter` had, since it reset stage *statuses* while leaving
/// `landscapeAnalysis`, `paperGrades`, `outline` and friends in place.
pub fn apply_transition(
    previous: &ReviewWorkflowRun,
    transition: StageTransition,
) -> Result<ReviewWorkflowRun, String> {
    let stage = previous
        .stages
        .iter()
        .find(|stage| stage.id == transition.stage_id)
        .ok_or_else(|| format!("unknown review workflow stage `{}`", transition.stage_id))?;
    let ordinal = stage.ordinal;

    if let Some(output) = &transition.output {
        let owner = output.owner_stage_id();
        if owner != transition.stage_id {
            return Err(format!(
                "stage {} cannot write output owned by stage {owner}",
                transition.stage_id
            ));
        }
    }
    if transition.outcome == StageOutcome::Passed
        && stage.reviewer_gate.required
        && !matches!(
            transition
                .gate
                .as_ref()
                .map_or(stage.reviewer_gate.status, |gate| gate.status),
            ReviewerGateStatus::Approved | ReviewerGateStatus::Skipped
        )
    {
        return Err(format!(
            "stage {} cannot pass before the independent Reviewer approves it",
            transition.stage_id
        ));
    }
    ensure_predecessors_passed(previous, ordinal)?;

    let mut next = previous.clone();
    // Unconditional: every transition either rewrites this stage's outputs or
    // reopens it, and both make downstream results unsound. Doing it before the
    // write keeps the new output from being cleared by its own transition.
    invalidate_downstream(&mut next, ordinal);
    if let Some(output) = transition.output {
        write_output(&mut next, output);
    }

    let Some(stage) = next
        .stages
        .iter_mut()
        .find(|stage| stage.id == transition.stage_id)
    else {
        return Err(format!(
            "unknown review workflow stage `{}`",
            transition.stage_id
        ));
    };
    stage.status = transition.outcome.as_status();
    if stage.started_at.is_none() {
        stage.started_at = Some(crate::now_iso8601());
    }
    // Reopening a stage clears its completion time: a stage that is being
    // reworked must not keep reading as finished.
    stage.completed_at = match transition.outcome {
        StageOutcome::Passed => stage
            .completed_at
            .clone()
            .or_else(|| Some(crate::now_iso8601())),
        _ => None,
    };
    if let Some(summary) = transition.summary {
        stage.summary = Some(summary);
    }
    if let Some(gate) = transition.gate {
        // `required` is part of the stage template, not of a verdict.
        let required = stage.reviewer_gate.required;
        stage.reviewer_gate = ReviewerGate { required, ..gate };
    }

    if transition.advance && transition.outcome == StageOutcome::Passed {
        if let Some(following) = next
            .stages
            .iter_mut()
            .find(|candidate| candidate.ordinal == ordinal + 1)
        {
            following.status = ReviewWorkflowStageStatus::Ready;
            let following_id = following.id.clone();
            next.active_stage_id = following_id;
        }
    } else {
        next.active_stage_id.clone_from(&transition.stage_id);
    }
    Ok(next)
}

/// Rejects acting on a stage whose predecessors have not passed.
///
/// Reworking an earlier stage is always allowed — that is the revision loop —
/// so only forward jumps are blocked.
fn ensure_predecessors_passed(run: &ReviewWorkflowRun, ordinal: u32) -> Result<(), String> {
    if let Some(blocking) = run
        .stages
        .iter()
        .filter(|stage| stage.ordinal < ordinal)
        .find(|stage| stage.status != ReviewWorkflowStageStatus::Passed)
    {
        return Err(format!(
            "stage {} cannot start before stage {} passes",
            run.stages
                .iter()
                .find(|stage| stage.ordinal == ordinal)
                .map_or("?", |stage| stage.id.as_str()),
            blocking.id
        ));
    }
    Ok(())
}

/// Clears every output and stage state produced after `ordinal`.
///
/// The field list is the inverse of [`StageOutput::owner_stage_id`]; keeping the
/// two next to each other is what makes "a stage owns its outputs" checkable.
fn invalidate_downstream(run: &mut ReviewWorkflowRun, ordinal: u32) {
    let stage_ordinal = |id: &str| {
        run.stages
            .iter()
            .find(|stage| stage.id == id)
            .map_or(u32::MAX, |stage| stage.ordinal)
    };
    let after = |id: &str| stage_ordinal(id) > ordinal;

    if after("scope-and-plan") {
        run.search_plan = None;
        run.plan_approved = false;
    }
    if after("review-landscape-search") {
        run.search_protocol_id = None;
        run.search_run_id = None;
        run.search_record_ids.clear();
        run.coverage = None;
    }
    if after("review-eligibility") {
        run.review_eligibility = ReviewEligibilitySummary::default();
    }
    if after("coverage-and-branch") {
        run.review_count_branch = ReviewCountBranch::Unknown;
    }
    if after("gap-analysis") {
        run.landscape_analysis = None;
    }
    if after("direction-selection") {
        run.selected_direction_id = None;
    }
    if after("matrix-strategy") {
        run.matrix_strategy = None;
        run.matrix_plan_approved = false;
    }
    if after("query-quality-loop") {
        run.matrix_search_protocol_id = None;
        run.matrix_search_run_id = None;
        run.matrix_search_path_id = None;
        run.matrix_record_ids.clear();
        run.matrix_coverage = None;
        run.query_quality_iterations.clear();
    }
    if after("primary-library") {
        run.primary_search_protocol_id = None;
        run.primary_search_run_id = None;
        run.primary_path_allocations.clear();
        run.primary_path_candidates.clear();
        run.primary_path_admissions.clear();
        run.primary_candidate_scores.clear();
        run.primary_record_ids.clear();
        run.primary_coverage = None;
    }
    if after("batch-grading") {
        run.paper_grades.clear();
    }
    if after("outline") {
        run.outline_clusters.clear();
        run.outline_cluster_fingerprint = None;
        run.outline.clear();
    }
    if after("section-mapping") {
        run.paper_mappings.clear();
    }
    // A checkpoint belongs to the job that created it; a job downstream of the
    // reworked stage no longer has inputs it can be resumed against.
    if run
        .batch_checkpoint
        .as_ref()
        .is_some_and(|checkpoint| stage_ordinal(&checkpoint.stage_id) > ordinal)
    {
        run.batch_checkpoint = None;
    }

    for stage in &mut run.stages {
        if stage.ordinal <= ordinal {
            continue;
        }
        stage.status = ReviewWorkflowStageStatus::NotStarted;
        stage.started_at = None;
        stage.completed_at = None;
        stage.summary = None;
        stage.reviewer_gate = ReviewerGate {
            required: stage.reviewer_gate.required,
            status: if stage.reviewer_gate.required {
                ReviewerGateStatus::Pending
            } else {
                ReviewerGateStatus::NotRequired
            },
            reviewer: None,
            summary: None,
            issues: Vec::new(),
            reviewed_at: None,
        };
    }
}

fn write_output(run: &mut ReviewWorkflowRun, output: StageOutput) {
    match output {
        StageOutput::SearchPlan(plan) => {
            run.search_plan = Some(*plan);
            // A new plan is not an approved plan, whatever the previous one was.
            run.plan_approved = false;
        }
        StageOutput::PlanApproved => run.plan_approved = true,
        StageOutput::SearchExecution {
            protocol_id,
            search_run_id,
            record_ids,
            coverage,
        } => {
            run.search_protocol_id = Some(protocol_id);
            run.search_run_id = Some(search_run_id);
            run.search_record_ids = record_ids;
            run.coverage = Some(*coverage);
        }
        StageOutput::Eligibility(summary) => run.review_eligibility = *summary,
        StageOutput::CountBranch(branch) => run.review_count_branch = branch,
        StageOutput::Landscape(analysis) => run.landscape_analysis = Some(*analysis),
        StageOutput::Direction(id) => run.selected_direction_id = Some(id),
        StageOutput::MatrixStrategy(strategy) => {
            run.matrix_strategy = Some(*strategy);
            run.matrix_plan_approved = false;
        }
        StageOutput::MatrixPlanApproved => run.matrix_plan_approved = true,
        StageOutput::MatrixPilot {
            protocol_id,
            search_run_id,
            path_id,
            record_ids,
            coverage,
        } => {
            run.matrix_search_protocol_id = Some(protocol_id);
            run.matrix_search_run_id = Some(search_run_id);
            run.matrix_search_path_id = Some(path_id);
            run.matrix_record_ids = record_ids;
            run.matrix_coverage = Some(*coverage);
        }
        StageOutput::QueryQualityIteration(iteration) => {
            run.query_quality_iterations.push(*iteration);
        }
        StageOutput::PrimaryLibrary {
            protocol_id,
            search_run_id,
            record_ids,
            coverage,
        } => {
            run.primary_search_protocol_id = Some(protocol_id);
            run.primary_search_run_id = Some(search_run_id);
            run.primary_record_ids = record_ids;
            run.primary_coverage = Some(*coverage);
        }
        StageOutput::Grades(grades) => run.paper_grades = grades,
        StageOutput::OutlineClusters {
            clusters,
            fingerprint,
        } => {
            run.outline_clusters = clusters;
            run.outline_cluster_fingerprint = Some(fingerprint);
            run.outline.clear();
        }
        StageOutput::Outline(sections) => run.outline = sections,
        StageOutput::Mappings(mappings) => run.paper_mappings = mappings,
    }
}

/// The branch implied by the run's own eligibility result.
///
/// Convenience over [`branch_for_review_count`] so a caller cannot accidentally
/// count raw hits: the argument is derived here, not passed in.
#[must_use]
pub fn branch_from_eligibility(run: &ReviewWorkflowRun) -> ReviewCountBranch {
    if !run.review_eligibility.complete {
        return ReviewCountBranch::Unknown;
    }
    let exhausted = run
        .coverage
        .as_ref()
        .is_some_and(|coverage| coverage.exhausted);
    let eligible =
        u64::try_from(run.review_eligibility.eligible_record_ids.len()).unwrap_or(u64::MAX);
    branch_for_review_count(eligible, exhausted)
}

// ---------------------------------------------------------------------------
// Deterministic Scopus query gates
// ---------------------------------------------------------------------------

const SCOPUS_REVIEW_QUERY_MAX_CHARS: usize = 1_200;
const SCOPUS_REVIEW_QUERY_MAX_OR_OPERATORS: usize = 20;
const SCOPUS_REVIEW_QUERY_MAX_QUOTED_PHRASES: usize = 18;
const SCOPUS_EXCLUSION_MAX_TERMS: usize = 5;

fn pattern(source: &'static str, cell: &'static OnceLock<Regex>) -> &'static Regex {
    cell.get_or_init(|| Regex::new(source).expect("static review workflow pattern compiles"))
}

fn title_abs_key_pattern() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    pattern(r"(?i)\bTITLE-ABS-KEY\s*\(", &CELL)
}

fn or_operator_pattern() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    pattern(r"(?i)\bOR\b", &CELL)
}

fn quoted_phrase_pattern() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    pattern(r#""[^"]+""#, &CELL)
}

fn exclusion_pattern() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    pattern(r"(?i)\bAND\s+NOT\s+TITLE\s*\(([^)]*)\)", &CELL)
}

fn placeholder_pattern() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    pattern(
        r"(?i)[（【\{]\s*(A|B|C|概念|填入|placeholder)\s*[）】\}]",
        &CELL,
    )
}

fn contains_cjk(value: &str) -> bool {
    value.chars().any(|character| {
        matches!(character,
            '\u{3400}'..='\u{4dbf}' | '\u{4e00}'..='\u{9fff}' | '\u{f900}'..='\u{faff}')
    })
}

/// Removes redundant wrapping parentheses only when they enclose the whole
/// expression.  That gives the outer-level scan below a stable surface without
/// trying to parse Scopus's full Boolean grammar.
fn strip_outer_query_parentheses(mut query: &str) -> &str {
    loop {
        let trimmed = query.trim();
        if !trimmed.starts_with('(') || !trimmed.ends_with(')') {
            return trimmed;
        }
        let bytes = trimmed.as_bytes();
        let mut depth = 0_u32;
        let mut quoted = false;
        let mut wraps_entire_query = true;
        let mut index = 0;
        while index < bytes.len() {
            match bytes[index] {
                b'\\' if quoted && index + 1 < bytes.len() => index += 1,
                b'"' => quoted = !quoted,
                b'(' if !quoted => depth = depth.saturating_add(1),
                b')' if !quoted => {
                    depth = depth.saturating_sub(1);
                    if depth == 0 && index + 1 != bytes.len() {
                        wraps_entire_query = false;
                        break;
                    }
                }
                _ => {}
            }
            index += 1;
        }
        if !wraps_entire_query || quoted || depth != 0 {
            return trimmed;
        }
        query = &trimmed[1..trimmed.len() - 1];
    }
}

/// True when a review-only document type sits at the top level of an
/// AND-only expression.  A `DOCTYPE(re)` nested below an `OR` is not enough:
/// that branch would still let non-review records through.
fn has_outer_scopus_review_document_type(query: &str) -> bool {
    let normalized = strip_outer_query_parentheses(query);
    let bytes = normalized.as_bytes();
    let mut depth = 0_u32;
    let mut quoted = false;
    let mut has_top_level_review_type = false;
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' if quoted && index + 1 < bytes.len() => {
                index += 2;
                continue;
            }
            b'"' => {
                quoted = !quoted;
                index += 1;
                continue;
            }
            b'(' if !quoted => {
                depth = depth.saturating_add(1);
                index += 1;
                continue;
            }
            b')' if !quoted => {
                depth = depth.saturating_sub(1);
                index += 1;
                continue;
            }
            byte if !quoted && depth == 0 && byte.is_ascii_alphabetic() => {
                let start = index;
                while index < bytes.len() && bytes[index].is_ascii_alphabetic() {
                    index += 1;
                }
                let word = &normalized[start..index];
                if word.eq_ignore_ascii_case("OR") {
                    return false;
                }
                if !word.eq_ignore_ascii_case("DOCTYPE") {
                    continue;
                }
                let mut argument_start = index;
                while argument_start < bytes.len() && bytes[argument_start].is_ascii_whitespace() {
                    argument_start += 1;
                }
                if bytes.get(argument_start) != Some(&b'(') {
                    continue;
                }
                let Some(relative_end) = normalized[argument_start + 1..].find(')') else {
                    continue;
                };
                let argument_end = argument_start + 1 + relative_end;
                if normalized[argument_start + 1..argument_end]
                    .trim()
                    .eq_ignore_ascii_case("re")
                {
                    has_top_level_review_type = true;
                }
                index = argument_end + 1;
                continue;
            }
            _ => {}
        }
        index += 1;
    }
    !quoted && depth == 0 && has_top_level_review_type
}

/// Forces a review-only document type at the outermost level of a Scopus query.
///
/// The reconnaissance stage maps a topic through reviews that Scopus itself
/// classifies as reviews. A title/abstract mention of "review" is not an
/// equivalent filter: primary studies routinely use that word when discussing
/// prior work. Wrapping keeps the condition non-bypassable even when the model
/// emits a malformed inner `DOCTYPE` clause.
#[must_use]
pub fn enforce_scopus_review_document_type(query: &str) -> String {
    let normalized = query.trim();
    if has_outer_scopus_review_document_type(normalized) {
        normalized.to_string()
    } else {
        format!("({normalized}) AND DOCTYPE(re)")
    }
}

/// True only when the stored query already carries a non-bypassable review filter.
#[must_use]
pub fn has_enforced_scopus_review_document_type(query: &str) -> bool {
    has_outer_scopus_review_document_type(query.trim())
}

/// Cheap deterministic checks every Scopus query must pass before an independent
/// Reviewer is allowed to approve the plan.
///
/// These target provider validity and catastrophic query shapes; domain
/// judgement stays with the Reviewer.
#[must_use]
pub fn scopus_review_query_issues(query: &str) -> Vec<String> {
    let normalized = query.trim();
    let mut issues = Vec::new();
    if !title_abs_key_pattern().is_match(normalized) {
        issues.push("Scopus 检索式必须使用 TITLE-ABS-KEY(...) 承载主题词族。".to_string());
    }
    if !has_enforced_scopus_review_document_type(normalized) {
        issues.push("Scopus 检索式必须在最外层强制限定 DOCTYPE(re)。".to_string());
    }
    if contains_cjk(normalized) {
        issues.push(
            "Scopus query 中不得出现中文；请把中文主题翻译为通行的英文学术术语，中文只写在 rationale 中。"
                .to_string(),
        );
    }
    let length = normalized.chars().count();
    if length > SCOPUS_REVIEW_QUERY_MAX_CHARS {
        issues.push(format!(
            "Scopus query 过长（{length} 字符，上限 {SCOPUS_REVIEW_QUERY_MAX_CHARS}）；请改为 1–3 个概念词族，不要枚举介词、单复数和连字符的组合。"
        ));
    }
    let or_operators = or_operator_pattern().find_iter(normalized).count();
    if or_operators > SCOPUS_REVIEW_QUERY_MAX_OR_OPERATORS {
        issues.push(format!(
            "Scopus query 含 {or_operators} 个 OR（上限 {SCOPUS_REVIEW_QUERY_MAX_OR_OPERATORS}）；请删除短语排列组合，仅保留真实同义词。"
        ));
    }
    let quoted_phrases = quoted_phrase_pattern().find_iter(normalized).count();
    if quoted_phrases > SCOPUS_REVIEW_QUERY_MAX_QUOTED_PHRASES {
        issues.push(format!(
            "Scopus query 含 {quoted_phrases} 个引号短语（上限 {SCOPUS_REVIEW_QUERY_MAX_QUOTED_PHRASES}）；请把共同概念拆成 OR 词族后用 AND 连接。"
        ));
    }
    if let Some(exclusion) = exclusion_pattern()
        .captures(normalized)
        .map(|capture| capture[1].to_string())
    {
        let exclusion_terms = or_operator_pattern().find_iter(&exclusion).count() + 1;
        if exclusion_terms > SCOPUS_EXCLUSION_MAX_TERMS {
            issues.push(format!(
                "AND NOT TITLE 排除了 {exclusion_terms} 个词（上限 {SCOPUS_EXCLUSION_MAX_TERMS}）；仅保留由上一轮误检样本证明的假阳性词。"
            ));
        }
    }
    issues
}

/// Preflight issues across a whole plan, prefixed by source.
#[must_use]
pub fn review_search_plan_preflight_issues(plan: &ReviewSearchPlan) -> Vec<String> {
    plan.queries
        .iter()
        .filter(|query| query.source == "scopus")
        .flat_map(|query| {
            scopus_review_query_issues(&query.query)
                .into_iter()
                .map(|issue| format!("Scopus：{issue}"))
        })
        .collect()
}

/// One deterministic syntax check on a matrix-strategy query.
///
/// Typed rather than a bare string so callers can branch on `passed` instead of
/// pattern-matching Chinese prose, while [`ScopusSyntaxCheck::label`] still
/// renders the exact strings persisted in `MatrixSearchStrategy::syntax_checks`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScopusSyntaxCheck {
    pub passed: bool,
    kind: ScopusSyntaxCheckKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScopusSyntaxCheckKind {
    Parentheses,
    TitleAbsKey,
    BooleanOperator,
    Placeholder,
}

impl ScopusSyntaxCheck {
    #[must_use]
    pub const fn label(&self) -> &'static str {
        match (self.kind, self.passed) {
            (ScopusSyntaxCheckKind::Parentheses, true) => "括号配对通过",
            (ScopusSyntaxCheckKind::Parentheses, false) => "括号配对失败",
            (ScopusSyntaxCheckKind::TitleAbsKey, true) => "TITLE-ABS-KEY 字段通过",
            (ScopusSyntaxCheckKind::TitleAbsKey, false) => "缺少 TITLE-ABS-KEY",
            (ScopusSyntaxCheckKind::BooleanOperator, true) => "布尔运算符通过",
            (ScopusSyntaxCheckKind::BooleanOperator, false) => "缺少布尔运算符",
            (ScopusSyntaxCheckKind::Placeholder, true) => "未发现占位符",
            (ScopusSyntaxCheckKind::Placeholder, false) => "发现占位符",
        }
    }
}

/// Deterministic syntax checks for one matrix-strategy query.
#[must_use]
pub fn validate_scopus_query(query: &str) -> Vec<ScopusSyntaxCheck> {
    let mut balance: i32 = 0;
    let mut invalid = false;
    for character in query.chars() {
        if character == '(' {
            balance += 1;
        }
        if character == ')' {
            balance -= 1;
        }
        if balance < 0 {
            invalid = true;
        }
    }
    vec![
        ScopusSyntaxCheck {
            passed: !invalid && balance == 0,
            kind: ScopusSyntaxCheckKind::Parentheses,
        },
        ScopusSyntaxCheck {
            passed: query.contains("TITLE-ABS-KEY("),
            kind: ScopusSyntaxCheckKind::TitleAbsKey,
        },
        ScopusSyntaxCheck {
            passed: {
                static CELL: OnceLock<Regex> = OnceLock::new();
                pattern(r"\b(AND|OR)\b", &CELL).is_match(query)
            },
            kind: ScopusSyntaxCheckKind::BooleanOperator,
        },
        ScopusSyntaxCheck {
            passed: !placeholder_pattern().is_match(query),
            kind: ScopusSyntaxCheckKind::Placeholder,
        },
    ]
}

#[cfg(test)]
#[path = "tests/review_workflow_driver.rs"]
mod tests;
