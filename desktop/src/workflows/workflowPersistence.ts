import {
  reviewWorkflowCreate,
  reviewWorkflowDelete,
  reviewWorkflowLoad,
  reviewWorkflowRename,
  reviewWorkflowSave,
  reviewWorkflowsList,
} from "../api/tauri";
// The ledger lives in Rust, so these calls follow the backend rather than the
// webview: `aris-devserver` serves them to a plain browser too.
import { hasNativeBackend } from "../api/transport";
import type {
  ReviewWorkflowCreateInput,
  ReviewWorkflowRun,
  ReviewWorkflowSaveInput,
  ReviewWorkflowSummary,
} from "./workflowTypes";

const PREVIEW_STORAGE_PREFIX = "somniq-review-workflows-v1";

/** Mirrors `REVIEW_WORKFLOW_TEMPLATE_VERSION` in
 * `crates/runtime/src/review_workflow.rs`. Bump both together, and update
 * `idMap` in `migratePreviewRun` for whatever stage ids moved. */
const REVIEW_WORKFLOW_TEMPLATE_VERSION = 3;

function isOutlineMappedGrade(grade: string) {
  const normalized = grade.trim().toUpperCase();
  return normalized === "A" || normalized === "B";
}

function hasAssignedOutlineSection(mapping: { directSectionId?: string; indirectSectionId?: string }) {
  return Boolean(mapping.directSectionId?.trim() || mapping.indirectSectionId?.trim());
}

function previewKey(projectId: string) {
  return `${PREVIEW_STORAGE_PREFIX}:${projectId || "default"}`;
}

function previewRuns(projectId: string): ReviewWorkflowRun[] {
  try {
    const raw = localStorage.getItem(previewKey(projectId));
    return raw
      ? (JSON.parse(raw) as ReviewWorkflowRun[]).map(migratePreviewRun)
      : [];
  } catch {
    return [];
  }
}

function savePreviewRuns(projectId: string, runs: ReviewWorkflowRun[]) {
  localStorage.setItem(previewKey(projectId), JSON.stringify(runs));
}

function previewSummary(run: ReviewWorkflowRun): ReviewWorkflowSummary {
  return {
    id: run.id,
    title: run.title,
    topic: run.topic,
    status: run.status,
    activeStageId: run.activeStageId,
    revision: run.revision,
    updatedAt: run.updatedAt,
  };
}

export async function listWorkflowRuns(projectId: string) {
  if (hasNativeBackend()) return reviewWorkflowsList<ReviewWorkflowSummary[]>();
  return previewRuns(projectId)
    .map(previewSummary)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function loadWorkflowRun(projectId: string, id: string) {
  if (hasNativeBackend()) return reviewWorkflowLoad<ReviewWorkflowRun | null>(id);
  return previewRuns(projectId).find((run) => run.id === id) ?? null;
}

export async function createWorkflowRun(
  projectId: string,
  input: ReviewWorkflowCreateInput,
) {
  if (hasNativeBackend()) return reviewWorkflowCreate<ReviewWorkflowRun>(input);
  const run = createPreviewRun(input);
  savePreviewRuns(projectId, [run, ...previewRuns(projectId)]);
  return run;
}

export async function saveWorkflowRun(
  projectId: string,
  input: ReviewWorkflowSaveInput,
) {
  if (hasNativeBackend()) return reviewWorkflowSave<ReviewWorkflowRun>(input);
  const runs = previewRuns(projectId);
  const previous = runs.find((run) => run.id === input.run.id);
  if (!previous || previous.revision !== input.expectedRevision) {
    throw new Error("工作流已经更新，请重新加载后再试。");
  }
  const now = new Date().toISOString();
  const next: ReviewWorkflowRun = {
    ...input.run,
    revision: input.run.revision + 1,
    updatedAt: now,
    events: [
      ...input.run.events,
      {
        sequence: (input.run.events.at(-1)?.sequence ?? 0) + 1,
        timestamp: now,
        actor: input.actor,
        action: input.action,
        summary: input.summary,
        stageId: input.stageId,
      },
    ],
  };
  savePreviewRuns(projectId, runs.map((run) => run.id === next.id ? next : run));
  return next;
}

export async function renameWorkflowRun(projectId: string, id: string, title: string) {
  const normalizedTitle = title.trim().replace(/\s+/g, " ").slice(0, 240);
  if (!normalizedTitle) throw new Error("Workflow title is required.");
  if (hasNativeBackend()) return reviewWorkflowRename<ReviewWorkflowRun>(id, normalizedTitle);

  const runs = previewRuns(projectId);
  const previous = runs.find((run) => run.id === id);
  if (!previous) throw new Error("Workflow not found.");
  const now = new Date().toISOString();
  const next: ReviewWorkflowRun = {
    ...previous,
    title: normalizedTitle,
    revision: previous.revision + 1,
    updatedAt: now,
    events: [
      ...previous.events,
      {
        sequence: (previous.events.at(-1)?.sequence ?? 0) + 1,
        timestamp: now,
        actor: "user",
        action: "workflow_renamed",
        summary: "Updated workflow title.",
        stageId: previous.activeStageId,
      },
    ],
  };
  savePreviewRuns(projectId, runs.map((run) => run.id === id ? next : run));
  return next;
}

export async function deleteWorkflowRun(projectId: string, id: string) {
  if (hasNativeBackend()) {
    await reviewWorkflowDelete(id);
    return;
  }
  const runs = previewRuns(projectId);
  if (!runs.some((run) => run.id === id)) throw new Error("Workflow not found.");
  savePreviewRuns(projectId, runs.filter((run) => run.id !== id));
}

const PREVIEW_STAGES = [
  ["scope-and-plan", "研究范围与检索计划", "澄清主题，生成多语言、宽松、精确、同义词检索式，并由独立 Reviewer 审查。", true],
  ["review-landscape-search", "近五年综述全量检索", "执行可续读检索，直到所有数据源耗尽或明确记录失败、跳过与截断；独立 Reviewer 先审查检索回收质量。", true],
  ["review-eligibility", "真实综述资格核验", "按标题、摘要、文献类型和时间窗分批核验候选记录；只有确认的综述论文进入数量分支。", true],
  ["coverage-and-branch", "覆盖核验与数量分支", "仅对资格核验完成且覆盖已耗尽的真实综述计数；少于 10 篇回到检索审查。", true],
  ["gap-analysis", "趋势与综述空白", "完成领域现状、主题演变、空白探索与三个月可行性分析。", true],
  ["direction-selection", "方向选择与研究问题", "由用户从 3–5 个候选中确认方向，并冻结范围、边界和研究问题。", false],
  ["matrix-strategy", "矩阵式 Scopus 策略", "分解 A/B/C 实体、构建完整语义群和四条可执行路径，并完成语法检查与独立审查。", true],
  ["query-quality-loop", "试检与误检优化循环", "按日期抽取前 100 篇含摘要记录，识别误检共性并迭代查询。", true],
  ["primary-library", "高质量原始文献库", "使用已批准策略全量检索、续读、去重并保留覆盖状态。", true],
  ["batch-grading", "A/B/C/D 批量分级", "逐篇评估相关性并提取 1–2 句关键发现，保留分批检查点。", true],
  ["outline", "数据驱动的综述大纲", "综合高价值文献的观点、主题和证据密度，生成 x.x 层级写作大纲。", true],
  ["section-mapping", "论文到章节映射", "将每篇论文映射到直接与间接子章节，并生成一句话贡献。", true],
  ["evidence-synthesis", "全文证据与综合", "按大纲按需读取全文片段，构建证据卡、质量评价、图表与引用。", true],
  ["manuscript", "证据约束的全文写作", "按证据映射大纲逐节写作。", true],
  ["independent-review", "独立审稿与修订循环", "Reviewer 检查覆盖、偏倚、证据、论证、引用和报告规范。", true],
  ["submission-package", "投稿包", "导出正文、参考文献、图表、补充材料、方案、日志、清单与投稿信。", true],
] as const;

function createPreviewRun(input: ReviewWorkflowCreateInput): ReviewWorkflowRun {
  const now = new Date().toISOString();
  const id = `review-preview-${Date.now().toString(36)}`;
  return {
    protocolVersion: 1,
    id,
    sessionId: `wf-${id}`,
    templateId: "review-paper-from-topic",
    templateVersion: REVIEW_WORKFLOW_TEMPLATE_VERSION,
    revision: 1,
    title: `综述：${input.topic.trim()}`,
    topic: input.topic.trim(),
    keywords: input.keywords,
    languages: input.languages.length ? input.languages : ["中文", "English"],
    databases: input.databases,
    yearFrom: input.yearFrom,
    yearTo: input.yearTo,
    contextPolicy: {
      abstractBatchSize: 50,
      abstractCharsPerRecord: 2400,
      synthesisInputChars: 60000,
      fullTextStrategy: "retrieve_relevant_sections_on_demand",
    },
    status: "draft",
    activeStageId: "scope-and-plan",
    planApproved: false,
    scoutAutomationStatus: "idle",
    scoutRevisionLimit: 4,
    reviewSearchIteration: 1,
    searchRecordIds: [],
    reviewEligibility: {
      candidateRecordIds: [],
      eligibleRecordIds: [],
      excludedRecordIds: [],
      missingAbstractRecordIds: [],
      complete: false,
      method: "",
    },
    reviewCountBranch: "unknown",
    matrixPlanApproved: false,
    matrixRecordIds: [],
    queryQualityIterations: [],
    primaryTargetResults: 500,
    primaryPathAllocations: [],
    primaryRecordIds: [],
    paperGrades: [],
    outlineClusters: [],
    outline: [],
    paperMappings: [],
    stages: PREVIEW_STAGES.map(([stageId, title, description, required], index) => ({
      id: stageId,
      ordinal: index + 1,
      title,
      description,
      status: index === 0 ? "ready" : "not_started",
      reviewerGate: {
        required,
        status: required ? "pending" : "not_required",
        issues: [],
      },
    })),
    artifacts: [],
    events: [{
      sequence: 1,
      timestamp: now,
      actor: "user",
      action: "workflow_created",
      summary: "创建“从主题到可投稿综述论文”工作流。",
      stageId: "scope-and-plan",
    }],
    createdAt: now,
    updatedAt: now,
  };
}

function migratePreviewRun(run: ReviewWorkflowRun): ReviewWorkflowRun {
  const defaults = createPreviewRun({
    topic: run.topic || "未命名综述",
    keywords: run.keywords ?? [],
    languages: run.languages ?? ["中文", "English"],
    databases: run.databases ?? ["scopus", "openalex", "semantic-scholar", "crossref"],
    yearFrom: run.yearFrom ?? 2022,
    yearTo: run.yearTo ?? 2026,
  });
  const contextPolicy = {
    ...defaults.contextPolicy,
    ...run.contextPolicy,
    // 20 was the old product default; no UI exposed a lower per-run setting.
    abstractBatchSize: run.contextPolicy?.abstractBatchSize === 20
      ? defaults.contextPolicy.abstractBatchSize
      : Math.min(50, Math.max(1, run.contextPolicy?.abstractBatchSize ?? defaults.contextPolicy.abstractBatchSize)),
  };
  const idMap: Record<string, string> = {
    "direction-validation": "direction-selection",
    "formal-protocol": "matrix-strategy",
    screening: "primary-library",
    "evidence-extraction": "batch-grading",
    synthesis: "evidence-synthesis",
  };
  const previousStages = run.stages ?? [];
  const stages = defaults.stages.map((stage) => {
    // Match the run's own id first. Looking up the legacy id unconditionally
    // dropped the state of every renamed stage on each load of an already-v2
    // run — the Rust loader avoids this by returning early on templateVersion 2.
    const legacyId = Object.entries(idMap).find(([, nextId]) => nextId === stage.id)?.[0];
    const previous = previousStages.find((candidate) => candidate.id === stage.id)
      ?? (legacyId ? previousStages.find((candidate) => candidate.id === legacyId) : undefined);
    if (!previous) return stage;
    const wasLegacyOptionalSearch = stage.id === "review-landscape-search"
      && previous.reviewerGate.required === false;
    const reviewerGate = stage.reviewerGate.required
      ? wasLegacyOptionalSearch
        ? previous.status === "passed"
          ? {
              required: true as const,
              status: "skipped" as const,
              reviewer: "Legacy workflow migration",
              summary: "该阶段在旧版工作流中没有检索回收质量门禁，保留为未经独立审查。",
              issues: [],
              reviewedAt: previous.completedAt ?? run.updatedAt,
            }
          : stage.reviewerGate
        : { ...previous.reviewerGate, required: true }
      : stage.reviewerGate;
    return {
      ...stage,
      status: previous.status,
      reviewerGate,
      startedAt: previous.startedAt,
      completedAt: previous.completedAt,
      summary: previous.summary,
    };
  });
  const migratedFromRemovedZotero = run.activeStageId === "zotero-organization";
  let activeStageId = migratedFromRemovedZotero
    ? "evidence-synthesis"
    : idMap[run.activeStageId] ?? run.activeStageId;
  if (migratedFromRemovedZotero) {
    const evidenceStage = stages.find((stage) => stage.id === "evidence-synthesis");
    if (evidenceStage) {
      evidenceStage.status = "waiting_user";
      evidenceStage.summary = "Zotero 结构化重构已从当前版本移除；当前版本止于论文到章节映射。";
    }
  }
  const reconnaissanceStages = new Set([
    "review-landscape-search",
    "review-eligibility",
    "coverage-and-branch",
    "gap-analysis",
  ]);
  const reconnaissanceComplete = defaults.stages
    .findIndex((stage) => stage.id === activeStageId)
    >= defaults.stages.findIndex((stage) => stage.id === "direction-selection");
  const inferredScoutStatus = reconnaissanceComplete
    ? "completed"
    : run.planApproved && reconnaissanceStages.has(activeStageId)
      ? run.status === "waiting_user" || run.status === "revision_required" ? "paused" : "running"
      : "idle";
  const primaryTargetResults = run.primaryTargetResults ?? 500;
  const primaryRecordCount = run.primaryRecordIds?.length ?? 0;
  const primaryAdmissions = run.primaryPathAdmissions ?? [];
  // The corpus is written by binary relevance screening (see primarySelectionSettled in
  // workflowEngine). A raw record count without selection is not readiness.
  const selectionSettled = primaryAdmissions.length >= 4
    && primaryAdmissions.every((admission) =>
      admission.admittedRecordIds.length >= admission.quota || admission.shortfallReason,
    );
  const primaryReady = Boolean(
    selectionSettled
    || (run.primaryCoverage?.exhausted && primaryRecordCount > 0),
  );
  if (primaryReady) {
    const primaryStage = stages.find((stage) => stage.id === "primary-library");
    const hasShortfall = primaryAdmissions.some((admission) => admission.shortfallReason);
    const targetReached = selectionSettled && !hasShortfall;
    let primaryNeedsReview = false;
    if (primaryStage) {
      const reviewerDisabled = run.reviewerDisabled === true;
      // Mirrors `normalize_primary_library_target` in
      // `crates/runtime/src/review_workflow.rs`. Both had to learn that a
      // verdict already on the gate is not something to backfill over: a
      // rejection carries the issues the user is being asked to fix, and a real
      // approval is not re-earned by reopening the app.
      const rejected = primaryStage.reviewerGate.status === "rejected";
      // Literal must match Rust's `LEGACY_COVERAGE_TARGET_VALIDATOR_REVIEWER`
      // constant (same file) — TypeScript cannot import it. That constant's own
      // doc comment is the source of truth for what this sentinel means.
      const hasRealReview = reviewerDisabled
        || (primaryStage.reviewerGate.status === "approved"
          && primaryStage.reviewerGate.reviewer !== "Coverage target validator");
      primaryStage.summary = targetReached
        ? `已完成完全无关文献筛除，保留 ${primaryRecordCount} 篇去重原始文献；剩余分页不再阻塞后续分级。`
        : hasShortfall
          ? `筛除完全无关项后保留 ${primaryRecordCount} 篇去重原始文献；部分路径存在数量短口。`
          : `数据源已耗尽，筛选后保留 ${primaryRecordCount} 篇去重原始文献。`;
      if (reviewerDisabled || hasRealReview) {
        primaryStage.status = "passed";
        primaryStage.completedAt = primaryStage.completedAt ?? run.updatedAt;
      } else if (rejected) {
        primaryNeedsReview = true;
        primaryStage.status = "revision_required";
        primaryStage.completedAt = undefined;
      } else {
        primaryNeedsReview = true;
        primaryStage.status = "waiting_reviewer";
        primaryStage.completedAt = undefined;
      }
      if (!rejected) {
        primaryStage.reviewerGate = {
          required: true,
          status: reviewerDisabled ? "skipped" : hasRealReview ? "approved" : "pending",
          reviewer: reviewerDisabled
            ? "Executor（无独立审查）"
            : hasRealReview ? primaryStage.reviewerGate.reviewer : undefined,
          summary: targetReached
            ? `已筛除完全无关项并保留 ${primaryTargetResults} 篇去重文献；未读取的提供商分页已保留在覆盖记录中。`
            : "部分路径未达预算或来源已耗尽；数量短口已如实保留。",
          issues: primaryAdmissions
            .map((admission) => admission.shortfallReason)
            .filter((reason): reason is string => Boolean(reason)),
          reviewedAt: reviewerDisabled || hasRealReview
            ? (primaryStage.reviewerGate.reviewedAt ?? primaryStage.completedAt ?? run.updatedAt)
            : undefined,
        };
      }
    }
    const gradingStage = stages.find((stage) => stage.id === "batch-grading");
    if (!primaryNeedsReview && gradingStage?.status === "not_started") gradingStage.status = "ready";
    if (activeStageId === "primary-library" && !primaryNeedsReview) activeStageId = "batch-grading";
  }
  return {
    ...defaults,
    ...run,
    sessionId: run.sessionId ?? `wf-${run.id}`,
    templateVersion: REVIEW_WORKFLOW_TEMPLATE_VERSION,
    status: migratedFromRemovedZotero ? "waiting_user" : run.status,
    activeStageId,
    contextPolicy,
    reviewSearchIteration: run.reviewSearchIteration ?? 1,
    scoutAutomationStatus: run.scoutAutomationStatus ?? inferredScoutStatus,
    scoutPauseReason: run.scoutPauseReason
      ?? (inferredScoutStatus === "paused" ? "旧版运行在需要人工处理的状态中恢复；确认问题后可继续综述侦察。" : undefined),
    scoutRevisionLimit: run.scoutRevisionLimit ?? 4,
    reviewEligibility: run.reviewEligibility ?? defaults.reviewEligibility,
    outlineClusters: run.outlineClusters ?? [],
    outlineClusterFingerprint: run.outlineClusterFingerprint,
    matrixPlanApproved: run.matrixPlanApproved ?? false,
    matrixRecordIds: run.matrixRecordIds ?? [],
    queryQualityIterations: run.queryQualityIterations ?? [],
    primaryTargetResults,
    primaryPathAllocations: run.primaryPathAllocations ?? [],
    primaryRecordIds: run.primaryRecordIds ?? [],
    paperGrades: run.paperGrades ?? [],
    outline: run.outline ?? [],
    paperMappings: (run.paperMappings ?? []).filter((mapping) => (
      hasAssignedOutlineSection(mapping)
      && run.paperGrades?.some(
        (grade) => grade.recordId === mapping.recordId && isOutlineMappedGrade(grade.grade),
      )
    )),
    stages,
  };
}
