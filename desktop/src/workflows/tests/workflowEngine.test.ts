import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  applyStageFailure,
  assertMatrixStrategyIterationChange,
  batchInputFingerprint,
  chunkItems,
  currentWorkflowStageId,
  deterministicPlan,
  enforceScopusJournalArticleType,
  enforceScopusReviewDocumentType,
  hasEnforcedScopusReviewDocumentType,
  invalidateDownstream,
  mergeActivityLog,
  matrixStrategyIterationPrompt,
  normalizedPlan,
  normalizeLandscapeAnalysis,
  normalizeMatrixStrategy,
  nextScoutAutomationAction,
  outlineCoverageIssues,
  outlineEditIssues,
  outlineShapeIssues,
  renumberOutline,
  normalizePrimaryLibraryPathAllocations,
  parsePaperGradeBatch,
  parsePrimarySelectionBatch,
  parseModelJson,
  primaryLibraryMatrixPaths,
  primaryPathCandidatesFromRun,
  primaryPathVariantBudgets,
  primaryRecordIdsFromAdmissions,
  selectPrimaryPathAdmission,
  downstreamStagesWithWork,
  previousWorkflowStageId,
  reopenStage,
  reviewSearchPlanPreflightIssues,
  runWithRetry,
  scopusQueryTermDelta,
  scopusQueryTerms,
  scopusReviewQueryIssues,
  usableCheckpoint,
  validateScopusQuery,
} from "../workflowEngine";
import type { ReviewWorkflowRun, WorkflowBatchCheckpoint, WorkflowOutlineSection } from "../workflowTypes";

const run = {
  topic: "anion design in zinc-ion batteries",
  keywords: ["anion", "zinc-ion battery", "interface"],
} as ReviewWorkflowRun;

const direction = {
  id: "direction-1",
  title: "Interfacial solvation pathways controlled by electrolyte anions",
  gap: "Existing reviews do not compare process-level pathways.",
  outline: "",
  workload: "",
  difficulty: "medium",
  feasibility: "",
  evidenceRecordIds: [],
};

/**
 * Which run fields each stage owns, shared verbatim with the Rust driver's own
 * test. Read from disk rather than imported so no bundler config decides
 * whether the two languages are actually looking at the same file.
 */
const stageOutputs: Record<string, string[]> = JSON.parse(
  readFileSync(
    new URL(
      "../../../../crates/runtime/src/tests/fixtures/workflow_stage_outputs.json",
      import.meta.url,
    ),
    "utf8",
  ),
).stageOutputs;

/** Shared with the Rust driver's own test; see the file's `_comment`. */
const nextStepCases: Array<{
  name: string;
  state: Record<string, never> & {
    activeStageId: string;
    automationRunning: boolean;
    gateStatus: string;
    /** Absent means `ready`; a reopened stage is the reason this exists. */
    stageStatus?: string;
    hasSearchPlan?: boolean;
    planApproved?: boolean;
    hasSearchProtocol?: boolean;
    coverage?: { exhausted: boolean; hasNextCursor: boolean; hasFailure: boolean };
    eligibilityComplete?: boolean;
    hasLandscape?: boolean;
  };
  ts: string | null;
  automatable: boolean;
}> = JSON.parse(
  readFileSync(
    new URL(
      "../../../../crates/runtime/src/tests/fixtures/workflow_next_step.json",
      import.meta.url,
    ),
    "utf8",
  ),
).cases;

const STAGE_IDS = [
  "scope-and-plan",
  "review-landscape-search",
  "review-eligibility",
  "coverage-and-branch",
  "gap-analysis",
  "direction-selection",
  "matrix-strategy",
  "query-quality-loop",
  "primary-library",
  "batch-grading",
  "outline",
  "section-mapping",
  "evidence-synthesis",
  "manuscript",
  "independent-review",
  "submission-package",
];

const coverage = {
  totalHits: 80,
  fetched: 80,
  unique: 74,
  exhausted: true,
  skippedSources: [],
  failedSources: [],
  sourceAttempts: [],
};

/**
 * A run where every stage-owned field holds a non-default value, so a field that
 * should have been cleared cannot pass by already looking empty.
 */
function fullyPopulatedRun(): ReviewWorkflowRun {
  return {
    ...run,
    activeStageId: "section-mapping",
    stages: STAGE_IDS.map((id, index) => ({
      id,
      ordinal: index + 1,
      title: id,
      description: id,
      status: "passed" as const,
      reviewerGate: { required: true, status: "approved" as const, issues: [] },
    })),
    searchPlan: deterministicPlan({ ...run, databases: ["scopus"] } as ReviewWorkflowRun),
    planApproved: true,
    searchProtocolId: "protocol-1",
    searchRunId: "search-1",
    searchRecordIds: ["paper-0"],
    coverage,
    reviewEligibility: {
      candidateRecordIds: ["paper-0"],
      eligibleRecordIds: ["paper-0"],
      excludedRecordIds: [],
      missingAbstractRecordIds: [],
      complete: true,
      method: "independent_reviewer",
    },
    reviewCountBranch: "focused",
    landscapeAnalysis: {
      developmentStatus: "status",
      majorProblems: [],
      newcomerNotes: [],
      temporalTrends: [],
      topicEvolution: [],
      reviewGaps: [],
      directions: [direction],
      generatedAt: "2026-08-01T00:00:00Z",
      generatedBy: "Executor",
    },
    selectedDirectionId: "direction-1",
    matrixStrategy: {
      mode: "stable",
      concepts: [],
      paths: [],
      exclusionAdvice: "",
      syntaxChecks: [],
      generatedAt: "2026-08-01T00:00:00Z",
      generatedBy: "Executor",
    },
    matrixPlanApproved: true,
    matrixSearchProtocolId: "matrix-protocol-1",
    matrixSearchRunId: "matrix-search-1",
    matrixSearchPathId: "abc",
    matrixRecordIds: ["paper-0"],
    matrixCoverage: coverage,
    queryQualityIterations: [{
      id: "iteration-1",
      iteration: 1,
      pathId: "abc",
      query: "TITLE-ABS-KEY(a)",
      sampleRecordIds: [],
      sampleSize: 100,
      relevantCount: 60,
      lowRelevanceCount: 40,
      estimatedPrecision: 0.6,
      falsePositivePatterns: [],
      adjustmentDirections: [],
      recommendation: "继续",
      reviewerApproved: true,
      createdAt: "2026-08-01T00:00:00Z",
    }],
    primarySearchProtocolId: "primary-protocol-1",
    primarySearchRunId: "primary-search-1",
    // Deliberately not the 500 default: a stage invalidator that "resets" this
    // user-chosen corpus size to the default would otherwise diff as unchanged
    // and slip past the parity check below.
    primaryTargetResults: 800,
    primaryPathAllocations: [
      { id: "abc", maxResults: 280, rationale: "core intersection" },
      { id: "ab", maxResults: 320, rationale: "domain corpus" },
      { id: "bc", maxResults: 110, rationale: "method seed" },
      { id: "ac", maxResults: 90, rationale: "baseline seed" },
    ],
    primaryPathCandidates: { abc: ["paper-0"] },
    primaryPathAdmissions: [{
      pathId: "abc",
      quota: 280,
      candidateRecordIds: ["paper-0"],
      admittedRecordIds: ["paper-0"],
      deferredRecordIds: [],
      shortfallReason: "candidate pool smaller than the quota",
      selectedAt: "2026-08-01T00:00:00Z",
      method: "independent_reviewer_batched",
    }],
    primaryCandidateScores: [{
      recordId: "paper-0",
      pathId: "abc",
      relevant: true,
      grade: "A",
      keyFinding: "finding",
      rationale: "rationale",
      citationCount: 12,
      year: 2024,
      admitted: true,
    }],
    primaryRecordIds: ["paper-0"],
    primaryCoverage: coverage,
    paperGrades: [{
      recordId: "paper-0",
      originalIndex: 1,
      grade: "A",
      keyFinding: "finding",
      rationale: "rationale",
      method: "independent_reviewer_batched",
    }],
    outlineClusters: [{
      id: "cluster-1",
      title: "Theme",
      claim: "Claim",
      recordIds: ["paper-0"],
      evidenceGaps: [],
      contested: [],
    }],
    outlineClusterFingerprint: "outline-1-deadbeef",
    outline: [{ id: "1", title: "引言", purpose: "背景", children: [] }],
    paperMappings: [{
      recordId: "paper-0",
      originalIndex: 1,
      zoteroLocator: "Paper Author 2024",
      directSectionId: "1",
      contribution: "贡献",
    }],
    batchCheckpoint: {
      kind: "grading",
      stageId: "batch-grading",
      inputFingerprint: "grading-1-deadbeef",
      batchSize: 20,
      completedBatches: 1,
      totalBatches: 2,
      partial: { kind: "grading", grades: [] },
      updatedAt: "2026-08-01T00:00:00Z",
    },
  } as ReviewWorkflowRun;
}

describe("workflowEngine", () => {
  it("accepts an LLM-proposed primary allocation without imposing fixed ratios", () => {
    const allocations = normalizePrimaryLibraryPathAllocations([
      { id: "abc", maxResults: 90, rationale: "high-precision intersection" },
      { id: "ab", maxResults: 210, rationale: "domain corpus" },
      { id: "bc", maxResults: 110, rationale: "method seed" },
      { id: "ac", maxResults: 90, rationale: "baseline seed" },
    ], 500);
    expect(allocations.map((item) => item.maxResults)).toEqual([90, 210, 110, 90]);
    expect(() => normalizePrimaryLibraryPathAllocations([
      { id: "abc", maxResults: 1, rationale: "core" },
      { id: "ab", maxResults: 1, rationale: "domain" },
      { id: "bc", maxResults: 250, rationale: "method" },
      { id: "ac", maxResults: 248, rationale: "baseline" },
    ], 500)).toThrow("不能主导");
  });

  it("renumbers edited outline nodes and rejects incomplete node fields", () => {
    const edited: WorkflowOutlineSection[] = [{
      id: "old",
      title: "第一章",
      purpose: "论证范围",
      children: [{ id: "old-child", title: "", purpose: "证据", children: [] }],
    }];

    const normalized = renumberOutline(edited);
    expect(normalized[0].id).toBe("1");
    expect(normalized[0].children[0].id).toBe("1.1");
    expect(outlineEditIssues(normalized)).toEqual(expect.arrayContaining([
      expect.stringContaining("1.1"),
    ]));
  });

  it("uses the persisted active stage rather than inferring a replacement from local badges", () => {
    const stages = [
      { id: "scope-and-plan", ordinal: 1, status: "passed" },
      { id: "review-landscape-search", ordinal: 2, status: "ready" },
      { id: "review-eligibility", ordinal: 3, status: "not_started" },
    ] as unknown as ReviewWorkflowRun["stages"];

    expect(currentWorkflowStageId(stages, "scope-and-plan")).toBe("scope-and-plan");
    expect(currentWorkflowStageId(stages, "review-landscape-search")).toBe("review-landscape-search");
    expect(previousWorkflowStageId(stages, "review-landscape-search")).toBe("scope-and-plan");
    expect(previousWorkflowStageId(stages, "scope-and-plan")).toBeUndefined();
  });

  it("keeps focused reviews from becoming a stack of domain surveys", () => {
    const broad = Array.from({ length: 9 }, (_, index) => ({
      id: String(index + 1),
      title: index < 2 ? `Application ${index + 1}` : `Core question ${index + 1}`,
      purpose: "Evidence for the central review question.",
      children: [],
    }));
    const issues = outlineShapeIssues(broad);
    expect(issues).toEqual(expect.arrayContaining([
      expect.stringContaining("8"),
      expect.stringContaining("应用证据"),
    ]));
  });

  it("accepts a compact review outline when required coverage is present", () => {
    const outline: WorkflowOutlineSection[] = [
      { id: "1", title: "引言", purpose: "界定问题与贡献。", children: [] },
      {
        id: "2",
        title: "综述方法",
        purpose: "报告检索式、数据库、年份范围、纳入排除标准、筛选流程和最终纳入篇数为 42 篇。",
        children: [],
      },
      { id: "3", title: "分类体系与主体方法", purpose: "按一条主轴组织方法。", children: [] },
      { id: "4", title: "评测基准、数据集与指标", purpose: "比较基准、数据集和指标。", children: [] },
      { id: "5", title: "横向比较、结论分歧与综合讨论", purpose: "解释跨研究比较和分歧。", children: [] },
      { id: "6", title: "主要问题与未来工作", purpose: "将每个方向配对到挑战。", children: [] },
      { id: "7", title: "结论", purpose: "收束证据边界。", children: [] },
    ];

    expect(outlineCoverageIssues(outline)).toEqual([]);
    expect(outlineCoverageIssues([...outline, {
      id: "8",
      title: "领域特定应用",
      purpose: "只有摘要证据确实需要时才增加的主体章。",
      children: [],
    }])).toEqual([]);
  });

  it("accepts method subheadings with an actual included-study count", () => {
    const outline: WorkflowOutlineSection[] = [
      { id: "1", title: "引言", purpose: "界定问题与贡献。", children: [] },
      {
        id: "2",
        title: "综述方法",
        purpose: "保证检索和筛选过程可复现。",
        children: [
          { id: "2.1", title: "检索策略与数据库", purpose: "报告检索式和数据库。", children: [] },
          { id: "2.2", title: "发表年份与纳入/排除标准", purpose: "界定时间范围和筛选规则。", children: [] },
          { id: "2.3", title: "筛选流程与实际纳入文献数", purpose: "实际纳入 1477 篇原始研究。", children: [] },
        ],
      },
      { id: "3", title: "分类体系：按方法族划分", purpose: "以唯一主轴组织证据。", children: [] },
      { id: "4", title: "评测基准、数据集与指标", purpose: "比较基准、数据集和指标。", children: [] },
      { id: "5", title: "横向比较、结论分歧与综合讨论", purpose: "解释跨研究比较和分歧。", children: [] },
      { id: "6", title: "主要问题与未来工作", purpose: "将每个方向配对到挑战。", children: [] },
      { id: "7", title: "结论", purpose: "收束证据边界。", children: [] },
    ];

    expect(outlineCoverageIssues(outline)).toEqual([]);
  });

  it("rejects an outline that hides methods but does not hard-cap chapter count", () => {
    const outline: WorkflowOutlineSection[] = [
      { id: "1", title: "引言", purpose: "问题。", children: [] },
      { id: "2", title: "背景与方法", purpose: "检索式、数据库、年份范围、纳入排除和最终篇数。", children: [] },
      { id: "3", title: "分类体系与主体方法", purpose: "分类。", children: [] },
      { id: "4", title: "评测基准、数据集与指标", purpose: "评测。", children: [] },
      { id: "5", title: "横向比较与结论分歧", purpose: "比较。", children: [] },
      { id: "6", title: "挑战与未来方向", purpose: "挑战和方向。", children: [] },
      { id: "7", title: "结论", purpose: "结论。", children: [] },
      { id: "8", title: "附加章节", purpose: "不应为凑数添加。", children: [] },
      { id: "9", title: "再加一章", purpose: "不应为凑数添加。", children: [] },
    ];

    const issues = outlineCoverageIssues(outline);
    expect(issues).toEqual(expect.arrayContaining([
      expect.stringContaining("综述方法"),
    ]));
    const withMethod = outline.map((section, index) => index === 1
      ? {
        ...section,
        title: "综述方法",
        purpose: "检索式、数据库、年份范围、纳入排除标准和最终纳入篇数为 42 篇。",
      }
      : section);
    expect(outlineCoverageIssues(withMethod)).toEqual([]);
  });

  it("repairs literal control characters inside model JSON strings", () => {
    const parsed = parseModelJson<{ summary: string; items: Array<{ index: number; eligible: boolean }> }>(
      '```json\n{"summary":"line one\nline two\tchecked","items":[{"index":0,"eligible":true}]}\n```',
    );

    expect(parsed.summary).toBe("line one\nline two\tchecked");
    expect(parsed.items).toEqual([{ index: 0, eligible: true }]);
  });

  it("repairs missing separators in structured model JSON", () => {
    const parsed = parseModelJson<{ summary: string; items: Array<{ index: number; eligible: boolean }> }>(
      '{"summary":"batch checked" "items":[{"index":0,"eligible":false}]}',
    );

    expect(parsed).toEqual({
      summary: "batch checked",
      items: [{ index: 0, eligible: false }],
    });
  });

  it("skips an illustrative schema block and takes the real payload", () => {
    const parsed = parseModelJson<{ concepts: Array<{ role: string }> }>(
      '下面是修订后的结构：\n```json\n{\n  "concepts": [ ... ],\n  "paths": [ ... ]\n}\n```\n实际输出：\n'
      + '```json\n{"concepts":[{"role":"A"}],"paths":[{"id":"abc"}]}\n```\n备注：已放宽 B 语义群。',
    );

    expect(parsed.concepts).toEqual([{ role: "A" }]);
  });

  it("refuses a prose-only reply instead of repairing it into a bare string", () => {
    expect(() => parseModelJson('```text\n本轮无法给出检索式。\n```')).toThrow();
  });

  it("recovers binary screening verdicts when reason quotes break JSON", () => {
    const parsed = parsePrimarySelectionBatch(
      '{"items":[{"index":0,"relevant":true,"reason":"作者称 "核心" 结果相关"},'
        + '{"index":1,"relevant":false,"reason":"研究对象完全不同"}]}',
      2,
    );

    expect(parsed.map(({ index, relevant }) => ({ index, relevant }))).toEqual([
      { index: 0, relevant: true },
      { index: 1, relevant: false },
    ]);
  });

  it("recovers grading indexes and grades when a batch item is missing colons", () => {
    const parsed = parsePaperGradeBatch(
      '{"items":[{"index":0,"grade" "A","keyFinding":"core result","rationale":"direct"},'
        + '{"index":1,"grade" "B","keyFinding":"supporting result","rationale":"indirect"}]}',
      2,
    );

    expect(parsed.map(({ index, grade }) => ({ index, grade }))).toEqual([
      { index: 0, grade: "A" },
      { index: 1, grade: "B" },
    ]);
  });

  it("retries one failed model operation before succeeding", async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new SyntaxError("malformed model JSON"))
      .mockResolvedValueOnce("valid result");
    const onRetry = vi.fn();

    await expect(runWithRetry(2, operation, onRetry)).resolves.toBe("valid result");
    expect(operation).toHaveBeenNthCalledWith(1, 1);
    expect(operation).toHaveBeenNthCalledWith(2, 2);
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("surfaces the final error after the retry budget is exhausted", async () => {
    const operation = vi.fn().mockRejectedValue(new Error("still malformed"));

    await expect(runWithRetry(2, operation)).rejects.toThrow("still malformed");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("chunks bounded model inputs without dropping records", () => {
    expect(chunkItems([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("rejects incomplete Scopus matrix syntax", () => {
    expect(validateScopusQuery("TITLE-ABS-KEY((anion AND battery)")).toContain("括号配对失败");
  });

  it("normalizes a complete four-path matrix", () => {
    const path = (id: string, combination: string, body: string) => ({
      id,
      combination,
      target: combination,
      strategicIntent: "intent",
      query: `TITLE-ABS-KEY((${body}) AND (electrolyte OR solvation))`,
      actionGuide: "pilot",
      expectedResults: "papers",
      reviewValue: "body",
    });
    const strategy = normalizeMatrixStrategy({
      concepts: [
        { role: "A", entity: "battery", rationale: "context", terms: ["zinc-ion batter*"] },
        { role: "B", entity: "anion", rationale: "subject", terms: ["anion*"] },
        { role: "C", entity: "solvation", rationale: "process", terms: ["solvation"] },
      ],
      paths: [
        path("abc", "A+B+C", "anion OR electrolyte"),
        path("ba", "B+A", "anion OR battery"),
        path("bc", "B+C", "anion OR solvation"),
        path("ac", "A+C", "battery OR solvation"),
      ],
    }, run, direction, "expanded");
    expect(strategy.paths).toHaveLength(4);
    expect(strategy.syntaxChecks.every((item) =>
      !/失败|缺少/.test(item)
      && (!item.includes("发现占位符") || item.includes("未发现占位符")),
    )).toBe(true);
    const primaryPaths = primaryLibraryMatrixPaths(strategy);
    expect(primaryPaths.map((item) => [item.id, item.combination, item.sourcePathId])).toEqual([
      ["abc", "A+B+C", "abc"],
      ["ab", "A+B", "ba"],
      ["bc", "B+C", "bc"],
      ["ac", "A+C", "ac"],
    ]);
    expect(primaryPaths.every((item) =>
      item.query.endsWith("AND DOCTYPE(ar) AND SRCTYPE(j)"),
    )).toBe(true);
  });

  it("enforces Scopus journal research-article filters idempotently", () => {
    const filtered = enforceScopusJournalArticleType("TITLE-ABS-KEY(llm AND forecasting)");
    expect(filtered).toBe("(TITLE-ABS-KEY(llm AND forecasting)) AND DOCTYPE(ar) AND SRCTYPE(j)");
    expect(enforceScopusJournalArticleType(filtered)).toBe(filtered);
  });

  it("requires an iteration to change the trialled query and injects its evidence into the prompt", () => {
    const path = (id: string, combination: string, body: string) => ({
      id,
      combination,
      target: combination,
      strategicIntent: "intent",
      query: `TITLE-ABS-KEY((${body}) AND (electrolyte OR solvation))`,
      actionGuide: "pilot",
      expectedResults: "papers",
      reviewValue: "body",
    });
    const previous = normalizeMatrixStrategy({
      concepts: [
        { role: "A", entity: "battery", rationale: "context", terms: ["zinc-ion batter*"] },
        { role: "B", entity: "anion", rationale: "subject", terms: ["anion*"] },
        { role: "C", entity: "solvation", rationale: "process", terms: ["solvation"] },
      ],
      paths: [
        path("abc", "A+B+C", "anion OR electrolyte"),
        path("ab", "A+B", "anion OR battery"),
        path("bc", "B+C", "anion OR solvation"),
        path("ac", "A+C", "battery OR solvation"),
      ],
    }, run, direction, "expanded");
    const feedback = {
      attempt: 1,
      maxAttempts: 2,
      pathId: "abc",
      query: previous.paths[0].query,
      recordCount: 100,
      sampleSize: 100,
      estimatedPrecision: 0.32,
      falsePositivePatterns: ["medical electrolyte studies"],
      adjustmentDirections: ["tighten the battery context"],
      reviewerSummary: "The phenomenon boundary is not operationalized.",
      reviewerIssues: ["Add an explicit solvation-process constraint."],
      qualityIssues: ["Estimated precision 32% is below the 50% floor."],
    };

    expect(() => assertMatrixStrategyIterationChange(previous, previous, feedback)).toThrow("query 未改变");
    const revised = {
      ...previous,
      paths: previous.paths.map((item) => item.id === "abc"
        ? { ...item, query: item.query.replace("anion OR electrolyte", "anion W/3 battery") }
        : item),
    };
    expect(() => assertMatrixStrategyIterationChange(previous, revised, feedback)).not.toThrow();

    const prompt = matrixStrategyIterationPrompt(run, direction, previous, feedback);
    expect(prompt).toContain("medical electrolyte studies");
    expect(prompt).toContain("tighten the battery context");
    expect(prompt).toContain("The phenomenon boundary is not operationalized.");
    expect(prompt).toContain("Add an explicit solvation-process constraint.");
    expect(prompt).toContain("Estimated precision 32% is below the 50% floor.");
    expect(prompt).toContain("必须关闭的问题清单");
    expect(prompt).toContain("与旧 query 不同");
  });

  it("reports a revision as the terms that moved, not as a rewritten string", () => {
    const before = 'TITLE-ABS-KEY((anion* OR "zinc-ion batter*") AND (solvation W/3 shell))';
    // Same concepts, reformatted, with one synonym swapped and one dropped.
    const after = 'TITLE-ABS-KEY( ( anion*  OR electrolyte ) AND ( (solvation W/3 shell) ) )';

    const delta = scopusQueryTermDelta(before, after);
    expect(delta.added).toEqual(["electrolyte"]);
    expect(delta.removed).toEqual(['zinc-ion batter*']);

    // Operators, field codes and proximity markers are structure, not concepts.
    expect(scopusQueryTerms('TITLE-ABS-KEY(a W/3 b AND NOT c)')).toEqual(["a", "b", "c"]);
    // Whitespace-only reformatting is not a change.
    expect(scopusQueryTermDelta(before, before.replace(/\s+/g, "  "))).toEqual({ added: [], removed: [] });
  });

  it("resumes an interrupted false-positive analysis instead of re-judging every record", () => {
    const recordIds = ["paper-0", "paper-1", "paper-2", "paper-3"];
    const fingerprint = batchInputFingerprint("query_quality", recordIds, 2, 2400, "TITLE-ABS-KEY(a)");
    const checkpoint: WorkflowBatchCheckpoint = {
      kind: "query_quality",
      stageId: "query-quality-loop",
      inputFingerprint: fingerprint,
      batchSize: 2,
      completedBatches: 1,
      totalBatches: 2,
      partial: {
        kind: "query_quality",
        judgments: [
          { recordId: "paper-0", relevant: true, reason: "on topic", cause: "core concept" },
          { recordId: "paper-1", relevant: false, reason: "other field", cause: "shared acronym" },
        ],
      },
      updatedAt: "2026-08-03T00:00:00Z",
    };
    const run = { batchCheckpoint: checkpoint } as ReviewWorkflowRun;

    expect(usableCheckpoint(run, "query_quality", fingerprint, 2)).toBe(checkpoint);
    // The query is part of the fingerprint: judging a different query's sample
    // must start clean rather than merge verdicts about another query.
    const otherQuery = batchInputFingerprint("query_quality", recordIds, 2, 2400, "TITLE-ABS-KEY(b)");
    expect(usableCheckpoint(run, "query_quality", otherQuery, 2)).toBeNull();
    expect(usableCheckpoint(run, "grading", fingerprint, 2)).toBeNull();
  });

  it("leaves a failed action on the stage that owns it without changing its phase", () => {
    const run = fullyPopulatedRun();
    const before = run.stages.find((stage) => stage.id === "query-quality-loop")!.status;

    applyStageFailure(run, "query-quality-loop", "Scopus HTTP 429");

    const stage = run.stages.find((item) => item.id === "query-quality-loop")!;
    expect(stage.summary).toBe("上一次操作失败：Scopus HTTP 429");
    // The action failed; the stage did not change phase, so a retry is still
    // the obvious next step rather than a forced rework.
    expect(stage.status).toBe(before);
    // No other stage is touched.
    expect(run.stages.filter((item) => item.summary?.startsWith("上一次操作失败")).length).toBe(1);

    // An unknown stage id is a no-op rather than a thrown error inside a catch.
    expect(() => applyStageFailure(run, "no-such-stage", "boom")).not.toThrow();
  });

  it("agrees with the Rust driver about when the workflow can proceed on its own", () => {
    // Two independent implementations decide what happens next: the driver
    // answers the model, this one drives the reconnaissance loop. The fixture
    // records both answers per state — including where they legitimately differ
    // — so drift on either side fails here instead of showing up as a model and
    // a UI that disagree about the same run.
    for (const test of nextStepCases) {
      const state = test.state;
      const stageId = state.activeStageId;
      const candidate = {
        ...run,
        activeStageId: stageId,
        scoutAutomationStatus: state.automationRunning ? "running" : "idle",
        searchPlan: state.hasSearchPlan ? deterministicPlan({ ...run, databases: ["scopus"] } as ReviewWorkflowRun) : undefined,
        planApproved: state.planApproved ?? false,
        searchProtocolId: state.hasSearchProtocol ? "protocol-1" : undefined,
        coverage: state.coverage
          ? {
            totalHits: 10,
            fetched: 10,
            unique: 10,
            exhausted: state.coverage.exhausted,
            nextCursor: state.coverage.hasNextCursor ? "cursor-1" : undefined,
            skippedSources: [],
            failedSources: state.coverage.hasFailure ? ["scopus"] : [],
            sourceAttempts: [],
          }
          : undefined,
        reviewEligibility: {
          candidateRecordIds: [],
          eligibleRecordIds: [],
          excludedRecordIds: [],
          missingAbstractRecordIds: [],
          complete: state.eligibilityComplete ?? false,
          method: "",
        },
        landscapeAnalysis: state.hasLandscape
          ? { directions: [], generatedAt: "", generatedBy: "" }
          : undefined,
        stages: STAGE_IDS.map((id, index) => ({
          id,
          ordinal: index + 1,
          title: id,
          description: id,
          status: id === stageId ? (state.stageStatus ?? "ready") : "ready",
          reviewerGate: {
            required: true,
            status: id === stageId ? state.gateStatus : "pending",
            issues: [],
          },
        })),
      } as unknown as ReviewWorkflowRun;

      expect(nextScoutAutomationAction(candidate), test.name).toBe(test.ts);
    }
  });

  it("requires at least three candidate review directions", () => {
    expect(() => normalizeLandscapeAnalysis({
      directions: [{ ...direction }],
    })).toThrow("至少 3 个");
  });
});

describe("review reconnaissance controller", () => {
  const scoutRun = (activeStageId: string, overrides: Partial<ReviewWorkflowRun> = {}) => ({
    scoutAutomationStatus: "running",
    activeStageId,
    planApproved: false,
    searchProtocolId: "protocol-1",
    searchRecordIds: [],
    reviewEligibility: { complete: false },
    stages: [{
      id: activeStageId,
      reviewerGate: { required: true, status: "pending", issues: [] },
    }],
    ...overrides,
  } as unknown as ReviewWorkflowRun);

  it("generates or approves a revised plan without asking the user again", () => {
    expect(nextScoutAutomationAction(scoutRun("scope-and-plan", { searchPlan: undefined }))).toBe("generate_plan");
    const reviewed = scoutRun("scope-and-plan", {
      searchPlan: { queries: [], inclusionCriteria: [], exclusionCriteria: [], generatedBy: "Executor", generatedAt: "now" },
    });
    reviewed.stages[0].reviewerGate.status = "approved";
    expect(nextScoutAutomationAction(reviewed)).toBe("approve_revised_plan");
  });

  it("continues valid cursors but pauses source failures or ambiguous partial coverage", () => {
    const partial = scoutRun("review-landscape-search", {
      coverage: {
        fetched: 20,
        unique: 18,
        exhausted: false,
        nextCursor: "cursor-2",
        skippedSources: [],
        failedSources: [],
        sourceAttempts: [],
      },
    });
    expect(nextScoutAutomationAction(partial)).toBe("continue_search");
    partial.coverage!.failedSources = ["scopus"];
    expect(nextScoutAutomationAction(partial)).toBe("pause_source_failure");
    partial.coverage!.failedSources = [];
    partial.coverage!.nextCursor = undefined;
    expect(nextScoutAutomationAction(partial)).toBe("pause_missing_cursor");
  });

  it("orders quality review, eligibility, coverage review, and landscape analysis", () => {
    const exhausted = scoutRun("review-landscape-search", {
      coverage: { fetched: 30, unique: 27, exhausted: true, skippedSources: [], failedSources: [], sourceAttempts: [] },
    });
    expect(nextScoutAutomationAction(exhausted)).toBe("review_search_quality");
    expect(nextScoutAutomationAction(scoutRun("review-eligibility"))).toBe("screen_review_eligibility");
    expect(nextScoutAutomationAction(scoutRun("coverage-and-branch"))).toBe("review_coverage_branch");
    expect(nextScoutAutomationAction(scoutRun("gap-analysis"))).toBe("analyze_landscape");
  });

  it("can retry a rejected coverage gate after the user resumes automation", () => {
    const rejected = scoutRun("coverage-and-branch", {
      reviewCountBranch: "focused",
      coverage: {
        fetched: 30,
        unique: 27,
        exhausted: true,
        skippedSources: [],
        failedSources: [],
        sourceAttempts: [],
      },
    });
    rejected.stages[0].reviewerGate.status = "rejected";
    expect(nextScoutAutomationAction(rejected)).toBe("review_coverage_branch");
  });

  it("stops at direction selection for explicit user choice", () => {
    expect(nextScoutAutomationAction(scoutRun("direction-selection"))).toBeNull();
  });

  it("redoes a reopened stage instead of reporting nothing left to do", () => {
    // A rewind keeps the stage's output so the user can see what they are
    // changing, so "the output exists" stopped meaning "this stage is done".
    // Reading only the output left `恢复自动运行` switching the badge to
    // 自动运行中 over a loop with no action to take.
    const eligibility = scoutRun("review-eligibility", {
      reviewEligibility: { complete: true } as ReviewWorkflowRun["reviewEligibility"],
    });
    expect(nextScoutAutomationAction(eligibility)).toBeNull();
    eligibility.stages[0].status = "waiting_user";
    expect(nextScoutAutomationAction(eligibility)).toBe("screen_review_eligibility");

    const landscape = scoutRun("gap-analysis", {
      landscapeAnalysis: { directions: [], generatedAt: "", generatedBy: "" } as unknown as ReviewWorkflowRun["landscapeAnalysis"],
    });
    landscape.stages[0].reviewerGate.status = "approved";
    expect(nextScoutAutomationAction(landscape)).toBeNull();
    landscape.stages[0].status = "revision_required";
    expect(nextScoutAutomationAction(landscape)).toBe("analyze_landscape");
  });

  it("sees a reopened stage on a run with independent review switched off", () => {
    // The gate reads `skipped` there, which is not `pending` and not a
    // rejection — every gate-shaped test for "still owes work" misses it.
    const landscape = scoutRun("gap-analysis", {
      reviewerDisabled: true,
      landscapeAnalysis: { directions: [], generatedAt: "", generatedBy: "" } as unknown as ReviewWorkflowRun["landscapeAnalysis"],
    });
    landscape.stages[0].reviewerGate.status = "skipped";
    landscape.stages[0].status = "waiting_user";
    expect(nextScoutAutomationAction(landscape)).toBe("analyze_landscape");
  });
});

describe("batched job checkpoints", () => {
  const fingerprint = batchInputFingerprint("grading", ["a", "b", "c"], 20, 2400);

  const checkpointed = (overrides: Partial<WorkflowBatchCheckpoint> = {}) => ({
    paperGrades: [],
    batchCheckpoint: {
      kind: "grading",
      stageId: "batch-grading",
      inputFingerprint: fingerprint,
      batchSize: 20,
      completedBatches: 2,
      totalBatches: 5,
      partial: { kind: "grading", grades: [] },
      updatedAt: "2026-07-30T00:00:00Z",
      ...overrides,
    },
  } as unknown as ReviewWorkflowRun);

  it("separates fingerprints by record set, order, and batch policy", () => {
    expect(batchInputFingerprint("grading", ["a", "b", "c"], 20, 2400)).toBe(fingerprint);
    expect(batchInputFingerprint("grading", ["a", "c", "b"], 20, 2400)).not.toBe(fingerprint);
    expect(batchInputFingerprint("grading", ["a", "b"], 20, 2400)).not.toBe(fingerprint);
    expect(batchInputFingerprint("grading", ["a", "b", "c"], 10, 2400)).not.toBe(fingerprint);
    expect(batchInputFingerprint("grading", ["a", "b", "c"], 20, 1200)).not.toBe(fingerprint);
    expect(batchInputFingerprint("mapping", ["a", "b", "c"], 20, 2400)).not.toBe(fingerprint);
  });

  it("resumes a checkpoint that matches the job it started", () => {
    const resumed = usableCheckpoint(checkpointed(), "grading", fingerprint, 5);
    expect(resumed?.completedBatches).toBe(2);
  });

  it("discards a checkpoint whose inputs changed instead of merging it", () => {
    const stale = batchInputFingerprint("grading", ["a", "b", "d"], 20, 2400);
    expect(usableCheckpoint(checkpointed(), "grading", stale, 5)).toBeNull();
  });

  it("discards a checkpoint from a different job or batch count", () => {
    expect(usableCheckpoint(checkpointed(), "mapping", fingerprint, 5)).toBeNull();
    expect(usableCheckpoint(checkpointed(), "grading", fingerprint, 4)).toBeNull();
    expect(usableCheckpoint(
      checkpointed({ partial: { kind: "mapping", mappings: [] } }),
      "grading",
      fingerprint,
      5,
    )).toBeNull();
  });

  it("starts clean when no batch has finished", () => {
    expect(usableCheckpoint(checkpointed({ completedBatches: 0 }), "grading", fingerprint, 5)).toBeNull();
    expect(usableCheckpoint({} as ReviewWorkflowRun, "grading", fingerprint, 5)).toBeNull();
  });
});

describe("mergeActivityLog", () => {
  const entry = (id: string, completedAt: string, detail = "ok") => ({
    id,
    stageId: "gap-analysis",
    actor: "Executor",
    title: "Executor 综合综述格局与候选方向",
    status: "completed" as const,
    detail,
    startedAt: completedAt,
    completedAt,
  });

  it("appends new calls in the order they finished", () => {
    const merged = mergeActivityLog(
      [entry("a", "2026-07-31T08:00:00Z")],
      [entry("c", "2026-07-31T08:02:00Z"), entry("b", "2026-07-31T08:01:00Z")],
      60,
      6_000,
    );
    expect(merged.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("lets a re-recorded call replace its older copy instead of duplicating it", () => {
    const merged = mergeActivityLog(
      [entry("a", "2026-07-31T08:00:00Z", "first attempt")],
      [entry("a", "2026-07-31T08:05:00Z", "retried answer")],
      60,
      6_000,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].detail).toBe("retried answer");
  });

  it("keeps the newest entries and truncates detail so a save stays bounded", () => {
    const many = Array.from({ length: 8 }, (_, index) =>
      entry(`id-${index}`, `2026-07-31T08:0${index}:00Z`, "x".repeat(50)));
    const merged = mergeActivityLog([], many, 3, 20);
    expect(merged.map((item) => item.id)).toEqual(["id-5", "id-6", "id-7"]);
    expect(merged[0].detail).toHaveLength(20);
  });
});

describe("review search plan", () => {
  const planRun = {
    topic: "reservoir computing",
    keywords: ["reservoir computing", "echo state network"],
    databases: ["scopus", "arxiv"],
    yearFrom: 2022,
    yearTo: 2026,
  } as ReviewWorkflowRun;

  it("keeps one query per source when the model returns a variant ladder", () => {
    const plan = normalizedPlan({
      queries: [
        { id: "s1", source: "scopus", kind: "broader", language: "English", query: "TITLE-ABS-KEY(\"reservoir computing\")", rationale: "recall" },
        { id: "s2", source: "scopus", kind: "stricter", language: "English", query: "TITLE(\"reservoir computing\")", rationale: "precision" },
        { id: "s3", source: "scopus", kind: "synonym", language: "English", query: "TITLE-ABS-KEY(\"echo state network\")", rationale: "synonyms" },
        { id: "a1", source: "arxiv", kind: "base", language: "English", query: "reservoir computing", rationale: "base" },
      ],
      inclusionCriteria: ["2022-2026"],
      exclusionCriteria: ["editorials"],
    }, planRun);

    expect(plan.queries).toHaveLength(2);
    expect(plan.queries.map((query) => query.source)).toEqual(["scopus", "arxiv"]);
    // The first query for a source wins; the ladder below it is dropped.
    expect(plan.queries[0].query).toContain("TITLE-ABS-KEY");
    expect(plan.queries[0].query).toContain("DOCTYPE(re)");
    expect(plan.queries.every((query) => query.kind === "primary")).toBe(true);
  });

  it("drops queries for sources the run did not select", () => {
    const plan = normalizedPlan({
      queries: [
        { id: "w1", source: "web-of-science", kind: "base", language: "English", query: "TS=(reservoir computing)", rationale: "off-protocol" },
        { id: "s1", source: "scopus", kind: "base", language: "English", query: "TITLE-ABS-KEY(\"reservoir computing\")", rationale: "in protocol" },
      ],
    }, planRun);

    expect(plan.queries.map((query) => query.source)).toEqual(["scopus"]);
  });

  it("falls back to one field-level query per source with no invented exclusions", () => {
    const plan = deterministicPlan(planRun);

    expect(plan.queries).toHaveLength(2);
    const scopus = plan.queries.find((query) => query.source === "scopus")!;
    expect(scopus.query).toContain('TITLE-ABS-KEY("reservoir computing" OR "echo state network")');
    expect(scopus.query).toContain("DOCTYPE(re)");
    expect(scopus.query).not.toContain('TITLE-ABS-KEY("review" OR "survey"');
    // Guessing which titles are false friends would silently drop real papers.
    expect(scopus.query).not.toContain("AND NOT");
  });

  it("adds a non-bypassable Scopus review-type condition to incomplete or mixed document filters", () => {
    expect(enforceScopusReviewDocumentType('TITLE-ABS-KEY("reservoir computing")'))
      .toBe('(TITLE-ABS-KEY("reservoir computing")) AND DOCTYPE(re)');
    expect(enforceScopusReviewDocumentType('TITLE-ABS-KEY("reservoir computing") AND (DOCTYPE(re) OR DOCTYPE(ar))'))
      .toBe('(TITLE-ABS-KEY("reservoir computing") AND (DOCTYPE(re) OR DOCTYPE(ar))) AND DOCTYPE(re)');
    expect(hasEnforcedScopusReviewDocumentType('TITLE-ABS-KEY("reservoir computing") AND DOCTYPE(re)')).toBe(true);
    expect(hasEnforcedScopusReviewDocumentType('TITLE-ABS-KEY("reservoir computing") AND (DOCTYPE(re) OR DOCTYPE(ar))')).toBe(false);
    expect(hasEnforcedScopusReviewDocumentType('TITLE-ABS-KEY("reservoir computing") OR DOCTYPE(re)')).toBe(false);
    expect(enforceScopusReviewDocumentType('TITLE-ABS-KEY("reservoir computing") OR DOCTYPE(re)'))
      .toBe('(TITLE-ABS-KEY("reservoir computing") OR DOCTYPE(re)) AND DOCTYPE(re)');
  });

  it("rejects Chinese natural-language and combinatorial Scopus queries before review", () => {
    const chinesePlan = normalizedPlan({
      queries: [{
        id: "s1",
        source: "scopus",
        kind: "primary",
        language: "English",
        query: 'TITLE-ABS-KEY("研究大语言模型与时间序列结合") AND DOCTYPE(re)',
        rationale: "bad translation",
      }],
    }, { ...planRun, databases: ["scopus"] });
    expect(reviewSearchPlanPreflightIssues(chinesePlan).join(" ")).toContain("不得出现中文");

    const variants = Array.from(
      { length: 25 },
      (_, index) => `"large language model variant ${index} ${"x".repeat(32)}"`,
    ).join(" OR ");
    const longIssues = scopusReviewQueryIssues(`TITLE-ABS-KEY(${variants}) AND DOCTYPE(re)`);
    expect(longIssues.some((issue) => issue.includes("过长"))).toBe(true);
    expect(longIssues.some((issue) => issue.includes("个 OR"))).toBe(true);
    expect(longIssues.some((issue) => issue.includes("引号短语"))).toBe(true);
  });

  it("rejects Chinese matrix queries before they can be probed or executed", () => {
    expect(validateScopusQuery("TITLE-ABS-KEY(研究 AND model)")).toContain("发现中文");
  });

  it("accepts a compact English concept-family Scopus review query", () => {
    const query = 'TITLE-ABS-KEY(("large language model" OR LLM) AND ("time series" OR "time-series")) AND DOCTYPE(re)';
    expect(scopusReviewQueryIssues(query)).toEqual([]);
  });

  it("clears exactly the fields the shared fixture assigns downstream", () => {
    // The Rust `invalidate_downstream` asserts against this same file. Whichever
    // side forgets a new stage output fails here, instead of the two drifting
    // apart until a reworked stage silently keeps stale results.
    const populated = fullyPopulatedRun();
    const ordinalOf = (id: string) => {
      const stage = populated.stages.find((candidate) => candidate.id === id);
      if (!stage) throw new Error(`fixture names unknown stage \`${id}\``);
      return stage.ordinal;
    };

    for (const stage of populated.stages) {
      if (!(stage.id in stageOutputs)) continue;
      const next = structuredClone(populated);
      invalidateDownstream(next, stage.id);

      const changed = Object.keys(populated)
        .filter((key) => !["stages", "activeStageId", "batchCheckpoint"].includes(key))
        .filter((key) => {
          const before = (populated as unknown as Record<string, unknown>)[key];
          const after = (next as unknown as Record<string, unknown>)[key];
          return JSON.stringify(before) !== JSON.stringify(after);
        })
        .sort();
      const expected = Object.entries(stageOutputs)
        .filter(([owner]) => ordinalOf(owner) > stage.ordinal)
        .flatMap(([, fields]) => fields)
        .sort();

      expect({ from: stage.id, changed }).toEqual({ from: stage.id, changed: expected });
    }
  });

  it("keeps the user's corpus size when an upstream stage is reworked", () => {
    // The target is what the user asked for, not something a stage produced.
    // Resetting it here silently shrank an 800-paper run back to the 500
    // default on every upstream rework, which is why `restartPrimaryLibrary`
    // used to save and restore it by hand.
    for (const stageId of ["scope-and-plan", "direction-selection", "query-quality-loop"]) {
      const reworked = structuredClone(fullyPopulatedRun());
      invalidateDownstream(reworked, stageId);
      expect({ stageId, target: reworked.primaryTargetResults })
        .toEqual({ stageId, target: 800 });
      // The records built from it are still gone; only the request survives.
      expect(reworked.primaryRecordIds).toEqual([]);
    }
  });

  it("drops a batch checkpoint that belongs to an invalidated stage", () => {
    const populated = fullyPopulatedRun();
    const kept = structuredClone(populated);
    invalidateDownstream(kept, "batch-grading");
    // The checkpoint's own stage is not downstream of itself.
    expect(kept.batchCheckpoint).toBeDefined();

    const dropped = structuredClone(populated);
    invalidateDownstream(dropped, "primary-library");
    expect(dropped.batchCheckpoint).toBeUndefined();
  });

  it("rewinds the cursor onto an earlier stage while keeping that stage's own work", () => {
    const reopened = reopenStage(fullyPopulatedRun(), "matrix-strategy");

    // The point of reopening is to edit what is there, so the strategy stays.
    expect(reopened.matrixStrategy).toBeDefined();
    expect(reopened.selectedDirectionId).toBe("direction-1");
    // Its confirmation does not: a stage the run is sitting on cannot also be
    // a stage the user already signed off.
    expect(reopened.matrixPlanApproved).toBe(false);
    expect(reopened.activeStageId).toBe("matrix-strategy");
    expect(reopened.status).toBe("waiting_user");

    const stage = reopened.stages.find((item) => item.id === "matrix-strategy")!;
    expect(stage.status).toBe("waiting_user");
    expect(stage.completedAt).toBeUndefined();
    expect(stage.reviewerGate.status).toBe("pending");

    // Everything after it is gone, which is what the Rust ledger demands before
    // it accepts a backward cursor move.
    expect(reopened.stages.filter((item) => item.ordinal > stage.ordinal)
      .every((item) => item.status === "not_started")).toBe(true);
    expect(reopened.matrixRecordIds).toEqual([]);
    expect(reopened.primaryRecordIds).toEqual([]);
    expect(reopened.paperGrades).toEqual([]);
    expect(reopened.outline).toEqual([]);
    expect(reopened.paperMappings).toEqual([]);
    expect(reopened.batchCheckpoint).toBeUndefined();
  });

  it("keeps a reviewer-disabled run out of a gate it can never satisfy", () => {
    const disabled = reopenStage({ ...fullyPopulatedRun(), reviewerDisabled: true }, "gap-analysis");
    // `pending` would strand the stage: no reviewer runs, so nothing would ever
    // clear it. `skipped` is the honest record and stays distinct from approval.
    expect(disabled.stages.find((item) => item.id === "gap-analysis")!.reviewerGate.status).toBe("skipped");
  });

  it("pauses the reconnaissance controller when its own stage is reopened", () => {
    const scout = reopenStage(
      { ...fullyPopulatedRun(), scoutAutomationStatus: "completed" },
      "review-eligibility",
    );
    expect(scout.scoutAutomationStatus).toBe("paused");
    expect(scout.scoutPauseReason).toContain("review-eligibility");

    // A stage the controller does not drive leaves its state alone.
    const past = reopenStage(
      { ...fullyPopulatedRun(), scoutAutomationStatus: "completed" },
      "batch-grading",
    );
    expect(past.scoutAutomationStatus).toBe("completed");
  });

  it("names only the downstream stages that actually hold work", () => {
    const populated = fullyPopulatedRun();
    populated.stages.find((stage) => stage.id === "manuscript")!.status = "not_started";
    populated.stages.find((stage) => stage.id === "independent-review")!.status = "not_started";
    populated.stages.find((stage) => stage.id === "submission-package")!.status = "not_started";

    expect(downstreamStagesWithWork(populated, "batch-grading").map((stage) => stage.id))
      .toEqual(["outline", "section-mapping", "evidence-synthesis"]);
    expect(downstreamStagesWithWork(populated, "submission-package")).toEqual([]);
  });

  describe("primary library quality selection", () => {
    it("attributes each record to the earliest matrix path that returned it", () => {
      const { candidates, unattributed } = primaryPathCandidatesFromRun(
        ["r1", "r2", "r3", "r4", "r5"],
        [
          { recordId: "r1", variantRanks: { abc: 1 } },
          { recordId: "r2", variantRanks: { abc: 2, ab: 5 } },
          { recordId: "r3", variantRanks: { ab: 1 } },
          { recordId: "r4", variantRanks: { bc: 1 } },
          { recordId: "r5", variantRanks: {} },
        ] as never,
      );
      expect(candidates.abc).toEqual(["r1", "r2"]);
      expect(candidates.ab).toEqual(["r3"]);
      expect(candidates.bc).toEqual(["r4"]);
      expect(candidates.ac).toEqual([]);
      expect(unattributed).toEqual(["r5"]);
    });

    it("keeps every related candidate in retrieval order and removes only unrelated ones", () => {
      const admission = selectPrimaryPathAdmission("abc", 2, ["r1", "r2", "r3", "r4"], new Map([
        ["r1", { relevant: true }],
        ["r2", { relevant: false }],
        ["r3", { relevant: true }],
        ["r4", { relevant: false }],
      ]), "test", "2026-08-01T00:00:00Z");
      expect(admission.admittedRecordIds).toEqual(["r1", "r3"]);
      expect(admission.deferredRecordIds).toEqual(["r2", "r4"]);
      expect(admission.shortfallReason).toBeUndefined();
    });

    it("reports a shortfall instead of admitting completely unrelated records", () => {
      const admission = selectPrimaryPathAdmission("abc", 3, ["r1", "r2", "r3"], new Map([
        ["r1", { relevant: true }],
        ["r2", { relevant: false }],
        ["r3", { relevant: false }],
      ]), "test", "2026-08-01T00:00:00Z");
      expect(admission.admittedRecordIds).toEqual(["r1"]);
      expect(admission.shortfallReason).toContain("完全无关");
      expect(admission.deferredRecordIds).toEqual(["r2", "r3"]);
    });

    it("deduplicates the admitted union across paths in canonical order", () => {
      const admissions = [
        { pathId: "abc", quota: 1, admittedRecordIds: ["r1", "r2"], deferredRecordIds: [], candidateRecordIds: ["r1", "r2"], selectedAt: "t", method: "m" },
        { pathId: "ab", quota: 1, admittedRecordIds: ["r2", "r3"], deferredRecordIds: [], candidateRecordIds: ["r2", "r3"], selectedAt: "t", method: "m" },
      ];
      expect(primaryRecordIdsFromAdmissions(admissions as never)).toEqual(["r1", "r2", "r3"]);
    });

    it("treats path allocation as a hard retrieval budget without multiplying it", () => {
      const budgets = primaryPathVariantBudgets(
        [
          { id: "abc", maxResults: 10, rationale: "" },
          { id: "ab", maxResults: 10, rationale: "" },
        ] as never,
        { abc: Array.from({ length: 10 }, (_, i) => `c${i}`) },
      );
      expect(budgets.abc).toBe(0);
      expect(budgets.ab).toBe(10);
    });
  });
});
