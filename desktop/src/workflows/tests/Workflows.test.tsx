// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useStore } from "../../store";
import type { LiteraturePaper } from "../../literature/literatureTypes";
import type { LiteratureProtocolPreview, ReviewWorkflowRun } from "../workflowTypes";
import Workflows, {
  MATRIX_PILOT_MAX_ATTEMPTS,
  MatrixWorkspace,
  OutlineWorkspace,
  QueryQualityWorkspace,
  SearchCoveragePanel,
  SearchResultsList,
  WorkflowHome,
  matrixPilotAttemptCount,
  normalizePaperSectionMapping,
  paperMappingsForSection,
  paperSectionMappingCategories,
  paperSectionMappingStats,
  queryQualityIterationNeedsRevision,
  recoverOutlineClustersFromDigests,
  workflowPhaseLabel,
} from "../Workflows";

beforeEach(() => {
  localStorage.clear();
  useStore.setState({
    tab: "workflows",
    currentProject: {
      id: "workflow-test-project",
      name: "Workflow test",
      path: "browser preview",
      addedAt: 0,
      lastOpenedAt: 0,
    },
    pendingChatInput: null,
    pendingChatHandoff: null,
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("Workflows", () => {
  it("rejects C/D papers from section mapping", () => {
    expect(() => normalizePaperSectionMapping(
      {
        recordId: "paper-c",
        originalIndex: 7,
        grade: "c",
        keyFinding: "out of scope",
      },
      "Example Author 2026",
      {
        directSectionId: "2.1",
        indirectSectionId: "3.2",
        contribution: "Reviewer-returned contribution",
      },
      new Set(["2.1", "3.2"]),
    )).toThrow("Only A/B-grade papers");
  });

  it("reports live review progress separately from assigned section mappings", () => {
    const stats = paperSectionMappingStats({
      paperGrades: [
        { recordId: "paper-a", originalIndex: 1, grade: "A", keyFinding: "", rationale: "", method: "review" },
        { recordId: "paper-b", originalIndex: 2, grade: "B", keyFinding: "", rationale: "", method: "review" },
        { recordId: "paper-c", originalIndex: 3, grade: "C", keyFinding: "", rationale: "", method: "review" },
      ],
      paperMappings: [],
      batchCheckpoint: {
        kind: "mapping",
        stageId: "section-mapping",
        inputFingerprint: "mapping-input",
        batchSize: 2,
        completedBatches: 1,
        totalBatches: 1,
        partial: {
          kind: "mapping",
          mappings: [
            { recordId: "paper-a", originalIndex: 1, zoteroLocator: "A Author", directSectionId: "2.1", contribution: "core" },
            { recordId: "paper-b", originalIndex: 2, zoteroLocator: "B Author", contribution: "none" },
          ],
        },
        updatedAt: "2026-08-05T00:00:00Z",
      },
      stages: [{ id: "section-mapping", ordinal: 12, title: "", description: "", status: "in_progress", reviewerGate: { required: true, status: "pending", issues: [] } }],
    });

    expect(stats.processed).toBe(2);
    expect(stats.eligible).toBe(2);
    expect(stats.assignedMappings.map((mapping) => mapping.recordId)).toEqual(["paper-a"]);
  });

  it("groups mapped papers by direct and indirect outline sections", () => {
    const run = {
      paperGrades: [
        { recordId: "paper-a", originalIndex: 1, grade: "A", keyFinding: "", rationale: "", method: "review" },
        { recordId: "paper-b", originalIndex: 2, grade: "B", keyFinding: "", rationale: "", method: "review" },
      ],
      paperMappings: [
        { recordId: "paper-a", originalIndex: 1, zoteroLocator: "A Author", directSectionId: "2.1", contribution: "core" },
        { recordId: "paper-b", originalIndex: 2, zoteroLocator: "B Author", indirectSectionId: "2.1", contribution: "context" },
      ],
      outline: [
        { id: "1", title: "Introduction", purpose: "", children: [] },
        { id: "2", title: "Methods", purpose: "", children: [{ id: "2.1", title: "Data", purpose: "", children: [] }] },
      ],
      stages: [],
    };

    expect(paperSectionMappingCategories(run)).toEqual([
      { id: "1", title: "Introduction", count: 0 },
      { id: "2", title: "Methods", count: 0 },
      { id: "2.1", title: "Data", count: 2 },
    ]);
    expect(paperMappingsForSection(run.paperMappings, "2.1").map((mapping) => mapping.recordId)).toEqual(["paper-a", "paper-b"]);
  });

  it("allows user confirmation of a matrix strategy when independent review was explicitly skipped", async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    const run = {
      matrixStrategy: {
        mode: "stable",
        concepts: [],
        paths: [],
        exclusionAdvice: "",
        syntaxChecks: [],
        generatedAt: "2026-08-02T00:00:00Z",
        generatedBy: "Executor",
      },
      matrixPlanApproved: false,
      stages: [{
        id: "matrix-strategy",
        ordinal: 7,
        title: "矩阵式 Scopus 策略",
        description: "",
        status: "waiting_user",
        reviewerGate: { required: true, status: "skipped", issues: [] },
      }],
    } as unknown as ReviewWorkflowRun;

    render(
      <MatrixWorkspace
        run={run}
        busy={null}
        onGenerate={vi.fn()}
        onApplyPilotFeedback={vi.fn()}
        onApprove={onApprove}
      />,
    );

    const approve = screen.getByRole("button", { name: "确认并进入试检" });
    expect(approve.hasAttribute("disabled")).toBe(false);
    await user.click(approve);
    expect(onApprove).toHaveBeenCalledOnce();
  });

  it("offers matrix revision rather than leaving an empty workspace when a pilot returns no records", async () => {
    const user = userEvent.setup();
    const onOptimize = vi.fn();
    const onRevise = vi.fn();
    const run = {
      matrixSearchProtocolId: "matrix-protocol-1",
      matrixSearchRunId: "matrix-run-1",
      matrixRecordIds: [],
      queryQualityIterations: [],
      stages: [{
        id: "query-quality-loop",
        ordinal: 8,
        title: "试检与误检优化循环",
        description: "",
        status: "in_progress",
        reviewerGate: { required: true, status: "pending", issues: [] },
      }],
    } as unknown as ReviewWorkflowRun;

    render(
      <QueryQualityWorkspace
        run={run}
        busy={null}
        preview={null}
        onPreview={vi.fn()}
        onExecute={vi.fn()}
        onAnalyze={vi.fn()}
        onOptimize={onOptimize}
        onRevise={onRevise}
        onOpenMatrixStage={vi.fn()}
        onOpenPrimaryStage={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "试检未获得可分析记录" })).toBeTruthy();
    // The zero-result execution is round 1; the revision it funds is the
    // strategy for round 2. Keep the denominator tied to the product bound.
    await user.click(screen.getByRole("button", {
      name: `基于零结果生成第 2/${MATRIX_PILOT_MAX_ATTEMPTS} 轮策略`,
    }));
    expect(onOptimize).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "返回矩阵策略修订" }));
    expect(onRevise).toHaveBeenCalledOnce();
  });

  it("explains each revision as a term change with its evidence, and shows no paper list", async () => {
    const user = userEvent.setup();
    const round = (iteration: number, query: string, precision: number, patterns: string[]) => ({
      id: `quality-${iteration}`,
      iteration,
      pathId: "abc",
      query,
      sampleRecordIds: [],
      sampleSize: 100,
      relevantCount: Math.round(precision * 100),
      lowRelevanceCount: 100 - Math.round(precision * 100),
      estimatedPrecision: precision,
      falsePositivePatterns: patterns,
      adjustmentDirections: patterns.length ? ["收紧 A 语义群"] : [],
      recommendation: `第 ${iteration} 轮结论`,
      reviewerApproved: false,
      createdAt: "2026-08-03T00:00:00Z",
    });
    const run = {
      matrixStrategy: {
        mode: "expanded",
        concepts: [],
        paths: [{
          id: "abc",
          combination: "A+B+C",
          target: "核心组合",
          strategicIntent: "",
          query: 'TITLE-ABS-KEY(llm AND "time series" AND forecasting)',
          actionGuide: "",
          expectedResults: "",
          reviewValue: "",
        }],
        exclusionAdvice: "",
        syntaxChecks: [],
        generatedAt: "2026-08-03T00:00:00Z",
        generatedBy: "Executor",
      },
      matrixPlanApproved: false,
      matrixRecordIds: [],
      queryQualityIterations: [
        round(1, "TITLE-ABS-KEY(llm AND battery)", 0.2, ["电池材料误检"]),
        round(2, 'TITLE-ABS-KEY(llm AND "time series")', 0.45, ["时序但非预测任务"]),
      ],
      // Two pilots executed, both analysed: the newest round is the current one.
      events: [
        { sequence: 1, timestamp: "", actor: "Executor", action: "matrix_pilot_executed", summary: "" },
        { sequence: 2, timestamp: "", actor: "Executor", action: "matrix_pilot_executed", summary: "" },
      ],
      stages: [{
        id: "query-quality-loop",
        ordinal: 8,
        title: "试检与误检优化循环",
        description: "",
        status: "revision_required",
        reviewerGate: { required: true, status: "rejected", issues: [] },
      }],
    } as unknown as ReviewWorkflowRun;

    render(
      <QueryQualityWorkspace
        run={run}
        busy={null}
        preview={null}
        onPreview={vi.fn()}
        onExecute={vi.fn()}
        onAnalyze={vi.fn()}
        onOptimize={vi.fn()}
        onRevise={vi.fn()}
        onOpenMatrixStage={vi.fn()}
        onOpenPrimaryStage={vi.fn()}
      />,
    );

    // Round 2 is explained by what it changed relative to round 1 ...
    expect(screen.getByText("检索式迭代记录")).toBeTruthy();
    expect(screen.getByText("+time series")).toBeTruthy();
    expect(screen.getByText("−battery")).toBeTruthy();
    // ... by the evidence from round 1 that drove the change ...
    expect(screen.getByText("误检共性：电池材料误检")).toBeTruthy();
    // ... and by what it bought.
    expect(screen.getByText(/查准率 45%（\+25 个百分点）/)).toBeTruthy();
    const queryDisclosures = document.querySelectorAll<HTMLDetailsElement>(".wf-revision-query-details");
    expect(queryDisclosures.length).toBe(3);
    expect(queryDisclosures[0].open).toBe(false);
    await user.click(within(queryDisclosures[0]).getByText("检索式"));
    expect(queryDisclosures[0].open).toBe(true);
    // The current matrix query is already different from round 2, so the old
    // rejection becomes evidence for a pending round rather than another
    // invitation to revise the strategy a second time.
    expect(screen.getByText("尚未试检")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "返回矩阵策略并立即重新生成" })).toBeNull();

    // The library does not move between rounds, so this stage lists no papers.
    expect(screen.queryByRole("heading", { name: "检索到的论文" })).toBeNull();
  });

  it("shows rejected pilot issues before returning to the matrix revision loop", async () => {
    const user = userEvent.setup();
    const onRevise = vi.fn();
    const run = {
      matrixRecordIds: ["paper-1", "paper-2", "paper-3", "paper-4"],
      queryQualityIterations: [{
        id: "quality-1",
        iteration: 1,
        pathId: "abc",
        query: "TITLE-ABS-KEY(llm AND time W/3 series)",
        sampleRecordIds: ["paper-1", "paper-2", "paper-3", "paper-4"],
        sampleSize: 4,
        relevantCount: 1,
        lowRelevanceCount: 3,
        estimatedPrecision: 0.25,
        falsePositivePatterns: ["time series 只作为数据类型出现"],
        adjustmentDirections: ["把预测任务词加入 C 语义群并收紧邻近关系"],
        recommendation: "当前查询噪声过高。",
        reviewerStatus: "rejected",
        reviewerSummary: "核心现象约束不足，不能进入全量检索。",
        reviewerIssues: ["C 语义群缺少 forecasting 与 decision support 约束。"],
        qualityIssues: ["估计查准率 25%，低于约 50% 的进入下限。"],
        reviewerApproved: false,
        createdAt: "2026-08-03T00:00:00Z",
      }],
      events: [{ sequence: 1, timestamp: "", actor: "Executor", action: "matrix_pilot_executed", summary: "" }],
      stages: [{
        id: "query-quality-loop",
        ordinal: 8,
        title: "试检与误检优化循环",
        description: "",
        status: "revision_required",
        reviewerGate: {
          required: true,
          status: "rejected",
          summary: "核心现象约束不足，不能进入全量检索。",
          issues: ["C 语义群缺少 forecasting 与 decision support 约束。"],
        },
      }],
    } as unknown as ReviewWorkflowRun;

    render(
      <QueryQualityWorkspace
        run={run}
        busy={null}
        preview={null}
        onPreview={vi.fn()}
        onExecute={vi.fn()}
        onAnalyze={vi.fn()}
        onOptimize={vi.fn()}
        onRevise={onRevise}
        onOpenMatrixStage={vi.fn()}
        onOpenPrimaryStage={vi.fn()}
      />,
    );

    expect(screen.getByText("当前试检未通过，需要修订矩阵策略")).toBeTruthy();
    expect(screen.getByText("核心现象约束不足，不能进入全量检索。")).toBeTruthy();
    expect(screen.getByText("估计查准率 25%，低于约 50% 的进入下限。")).toBeTruthy();
    expect(screen.getByText("C 语义群缺少 forecasting 与 decision support 约束。")).toBeTruthy();
    expect(screen.getAllByText(/把预测任务词加入 C 语义群并收紧邻近关系/).length).toBeGreaterThanOrEqual(1);

    await user.click(screen.getByRole("button", { name: "返回矩阵策略并立即重新生成" }));
    expect(onRevise).toHaveBeenCalledOnce();
  });

  it("treats a legacy reviewer-approved round below the precision floor as requiring regeneration", () => {
    const legacyRound = {
      id: "legacy-quality-1",
      iteration: 1,
      pathId: "abc",
      query: "TITLE-ABS-KEY(llm AND time W/3 series)",
      sampleRecordIds: [],
      sampleSize: 98,
      relevantCount: 24,
      lowRelevanceCount: 74,
      estimatedPrecision: 24 / 98,
      falsePositivePatterns: [],
      adjustmentDirections: [],
      recommendation: "审核模型已关闭，但确定性质量门禁未通过。",
      // Legacy semantics: this was the independent lane result, not the
      // overall pilot result. There is deliberately no reviewerStatus field.
      reviewerApproved: true,
      createdAt: "2026-08-03T00:00:00Z",
    };

    expect(queryQualityIterationNeedsRevision(legacyRound)).toBe(true);
  });

  it("does not exhaust the strategy-round budget when the same pilot was executed repeatedly", () => {
    const run = {
      matrixSearchRunId: "latest-search-run",
      queryQualityIterations: [{
        id: "quality-1",
        iteration: 1,
        pathId: "abc",
        query: "TITLE-ABS-KEY(a AND b AND c)",
        sampleRecordIds: [],
        sampleSize: 98,
        relevantCount: 24,
        lowRelevanceCount: 74,
        estimatedPrecision: 24 / 98,
        falsePositivePatterns: [],
        adjustmentDirections: [],
        recommendation: "需要修订",
        reviewerApproved: false,
        createdAt: "2026-08-03T00:00:00Z",
      }],
      events: Array.from({ length: 4 }, (_, index) => ({
        sequence: index + 1,
        timestamp: "2026-08-03T00:00:00Z",
        actor: "Executor",
        action: "matrix_pilot_executed",
        summary: "same query retry",
      })),
      stages: [{
        id: "query-quality-loop",
        ordinal: 8,
        title: "试检与误检优化循环",
        description: "",
        status: "revision_required",
        reviewerGate: { required: true, status: "rejected", issues: [] },
      }],
    } as unknown as ReviewWorkflowRun;

    expect(matrixPilotAttemptCount(run)).toBe(1);
  });

  it("carries rejected pilot issues into an explicit matrix prompt-revision action", async () => {
    const user = userEvent.setup();
    const onApplyPilotFeedback = vi.fn();
    const run = {
      reviewerDisabled: false,
      matrixStrategy: {
        mode: "expanded",
        concepts: [],
        paths: [{
          id: "abc",
          combination: "A+B+C",
          target: "核心组合",
          strategicIntent: "",
          query: "TITLE-ABS-KEY(llm AND time W/3 series)",
          actionGuide: "",
          expectedResults: "",
          reviewValue: "",
        }],
        exclusionAdvice: "",
        syntaxChecks: [],
        generatedAt: "2026-08-03T00:00:00Z",
        generatedBy: "Executor",
      },
      matrixPlanApproved: false,
      queryQualityIterations: [{
        id: "quality-1",
        iteration: 1,
        pathId: "abc",
        query: "TITLE-ABS-KEY(llm AND time W/3 series)",
        sampleRecordIds: [],
        sampleSize: 100,
        relevantCount: 24,
        lowRelevanceCount: 76,
        estimatedPrecision: 0.24,
        falsePositivePatterns: ["泛化的时间序列数据论文"],
        adjustmentDirections: ["加入 forecasting 任务约束"],
        recommendation: "需要收紧 C 语义群。",
        reviewerStatus: "rejected",
        reviewerSummary: "任务边界不清晰。",
        reviewerIssues: ["没有限定预测或决策支持场景。"],
        qualityIssues: ["估计查准率 24%，低于约 50% 的进入下限。"],
        reviewerApproved: false,
        createdAt: "2026-08-03T00:00:00Z",
      }],
      events: [{ sequence: 1, timestamp: "", actor: "Executor", action: "matrix_pilot_executed", summary: "" }],
      stages: [{
        id: "matrix-strategy",
        ordinal: 7,
        title: "矩阵式 Scopus 策略",
        description: "",
        status: "revision_required",
        reviewerGate: { required: true, status: "pending", issues: ["没有限定预测或决策支持场景。"] },
      }, {
        id: "query-quality-loop",
        ordinal: 8,
        title: "试检与误检优化循环",
        description: "",
        status: "revision_required",
        reviewerGate: { required: true, status: "rejected", issues: ["没有限定预测或决策支持场景。"] },
      }],
    } as unknown as ReviewWorkflowRun;

    render(
      <MatrixWorkspace
        run={run}
        busy={null}
        onGenerate={vi.fn()}
        onApplyPilotFeedback={onApplyPilotFeedback}
        onApprove={vi.fn()}
      />,
    );

    expect(screen.getByText("待按第 1 轮问题修订矩阵提示词")).toBeTruthy();
    expect(screen.getByText("没有限定预测或决策支持场景。")).toBeTruthy();
    const applyButtons = screen.getAllByRole("button", { name: /按试检审查建议重新生成/ });
    await user.click(applyButtons[0]);
    expect(onApplyPilotFeedback).toHaveBeenCalledOnce();
  });

  it("keeps the full-library next step visible after a pilot is approved", async () => {
    const user = userEvent.setup();
    const onOpenPrimaryStage = vi.fn();
    const run = {
      matrixRecordIds: ["paper-1"],
      queryQualityIterations: [{
        id: "quality-1",
        iteration: 1,
        pathId: "abc",
        query: "TITLE-ABS-KEY(a AND b AND c)",
        sampleRecordIds: ["paper-1"],
        sampleSize: 1,
        relevantCount: 1,
        lowRelevanceCount: 0,
        estimatedPrecision: 1,
        falsePositivePatterns: [],
        adjustmentDirections: [],
        recommendation: "样本质量通过。",
        reviewerApproved: true,
        createdAt: "2026-08-03T00:00:00Z",
      }],
      events: [],
      stages: [{
        id: "query-quality-loop",
        ordinal: 8,
        title: "试检与误检优化循环",
        description: "",
        status: "passed",
        reviewerGate: { required: true, status: "approved", issues: [] },
      }],
    } as unknown as ReviewWorkflowRun;

    render(
      <QueryQualityWorkspace
        run={run}
        busy={null}
        preview={null}
        onPreview={vi.fn()}
        onExecute={vi.fn()}
        onAnalyze={vi.fn()}
        onOptimize={vi.fn()}
        onRevise={vi.fn()}
        onOpenMatrixStage={vi.fn()}
        onOpenPrimaryStage={onOpenPrimaryStage}
      />,
    );

    await user.click(screen.getByRole("button", { name: "进入高质量原始文献库" }));
    expect(onOpenPrimaryStage).toHaveBeenCalledOnce();
  });

  it("routes a revised strategy back to its confirmation gate instead of piloting it unconfirmed", async () => {
    const user = userEvent.setup();
    const onPreview = vi.fn();
    const onOpenMatrixStage = vi.fn();
    const run = {
      matrixStrategy: {
        mode: "expanded",
        concepts: [],
        paths: [{
          id: "abc-v2",
          combination: "A+B+C",
          target: "核心组合",
          strategicIntent: "",
          query: "TITLE-ABS-KEY(a AND b AND c)",
          actionGuide: "",
          expectedResults: "",
          reviewValue: "",
        }],
        exclusionAdvice: "",
        syntaxChecks: [],
        generatedAt: "2026-08-02T00:00:00Z",
        generatedBy: "Executor",
      },
      matrixPlanApproved: false,
      matrixRecordIds: [],
      queryQualityIterations: [],
      events: [],
      stages: [{
        id: "query-quality-loop",
        ordinal: 8,
        title: "试检与误检优化循环",
        description: "",
        status: "ready",
        reviewerGate: { required: true, status: "pending", issues: [] },
      }],
    } as unknown as ReviewWorkflowRun;

    render(
      <QueryQualityWorkspace
        run={run}
        busy={null}
        preview={null}
        onPreview={onPreview}
        onExecute={vi.fn()}
        onAnalyze={vi.fn()}
        onOptimize={vi.fn()}
        onRevise={vi.fn()}
        onOpenMatrixStage={onOpenMatrixStage}
        onOpenPrimaryStage={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "生成 100 篇试检预览" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "前往确认矩阵策略" }));
    expect(onOpenMatrixStage).toHaveBeenCalledOnce();
    expect(onPreview).not.toHaveBeenCalled();
  });

  it("follows the path ids of the current strategy after an optimisation round replaced them", () => {
    const runWithPath = (pathId: string) => ({
      matrixStrategy: {
        mode: "expanded",
        concepts: [],
        paths: [{
          id: pathId,
          combination: "A+B+C",
          target: "核心组合",
          strategicIntent: "",
          query: "TITLE-ABS-KEY(a AND b AND c)",
          actionGuide: "",
          expectedResults: "",
          reviewValue: "",
        }],
        exclusionAdvice: "",
        syntaxChecks: [],
        generatedAt: "2026-08-02T00:00:00Z",
        generatedBy: "Executor",
      },
      matrixPlanApproved: true,
      matrixRecordIds: [],
      queryQualityIterations: [],
      events: [],
      stages: [{
        id: "query-quality-loop",
        ordinal: 8,
        title: "试检与误检优化循环",
        description: "",
        status: "ready",
        reviewerGate: { required: true, status: "pending", issues: [] },
      }],
    } as unknown as ReviewWorkflowRun);

    const props = {
      busy: null,
      preview: null,
      onPreview: vi.fn(),
      onExecute: vi.fn(),
      onAnalyze: vi.fn(),
      onOptimize: vi.fn(),
      onRevise: vi.fn(),
      onOpenMatrixStage: vi.fn(),
      onOpenPrimaryStage: vi.fn(),
    };
    const view = render(<QueryQualityWorkspace run={runWithPath("abc-v1")} {...props} />);
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("abc-v1");

    // The optimisation round replaces the strategy; the mount-time selection
    // must not survive it as an id that no longer exists.
    view.rerender(<QueryQualityWorkspace run={runWithPath("abc-v2")} {...props} />);
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("abc-v2");
  });

  it("names the tool an Executor called, since a workflow turn emits no tool card", () => {
    // Background workflow turns record `chat-tool` events instead of emitting
    // them, so this label is the only live evidence that the Executor probed a
    // query rather than answering from the prompt alone.
    expect(workflowPhaseLabel("tool", "WorkflowScopusProbe")).toBe("调用工具 · WorkflowScopusProbe");
    expect(workflowPhaseLabel("tool", "  ")).toBe("调用工具");
    expect(workflowPhaseLabel("tool")).toBe("调用工具");
    expect(workflowPhaseLabel("thinking", "ignored")).toBe("推演中");
    expect(workflowPhaseLabel("text", "streamed answer")).toBe("生成中");
  });

  it("switches the pilot path without asking for a second execution confirmation", () => {
    const run = {
      matrixStrategy: {
        mode: "expanded",
        concepts: [],
        paths: [
          { id: "abc", combination: "A+B+C", target: "核心", strategicIntent: "", query: "TITLE-ABS-KEY(a)", actionGuide: "", expectedResults: "", reviewValue: "" },
          { id: "ac", combination: "A+C", target: "背景", strategicIntent: "", query: "TITLE-ABS-KEY(b)", actionGuide: "", expectedResults: "", reviewValue: "" },
        ],
        exclusionAdvice: "",
        syntaxChecks: [],
        generatedAt: "2026-08-03T00:00:00Z",
        generatedBy: "Executor",
      },
      matrixPlanApproved: true,
      matrixRecordIds: [],
      queryQualityIterations: [],
      events: [],
      stages: [{
        id: "query-quality-loop",
        ordinal: 8,
        title: "试检与误检优化循环",
        description: "",
        status: "ready",
        reviewerGate: { required: true, status: "pending", issues: [] },
      }],
    } as unknown as ReviewWorkflowRun;

    render(
      <QueryQualityWorkspace
        run={run}
        busy={null}
        preview={null}
        onPreview={vi.fn()}
        onExecute={vi.fn()}
        onAnalyze={vi.fn()}
        onOptimize={vi.fn()}
        onRevise={vi.fn()}
        onOpenMatrixStage={vi.fn()}
        onOpenPrimaryStage={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "ac" } });
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("ac");
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("executes a compact Scopus pilot preview without a redundant checkbox", async () => {
    const user = userEvent.setup();
    const onExecute = vi.fn();
    const run = {
      matrixSearchProtocolId: "matrix-protocol-1",
      matrixRecordIds: [],
      queryQualityIterations: [],
      events: [],
      stages: [{
        id: "query-quality-loop",
        ordinal: 8,
        title: "试检与误检优化循环",
        description: "",
        status: "waiting_user",
        reviewerGate: { required: true, status: "pending", issues: [] },
      }],
    } as unknown as ReviewWorkflowRun;
    const preview: LiteratureProtocolPreview = {
      protocol: { id: "matrix-protocol-1", revision: 1, maxResults: 100 },
      plan: [{
        source: "scopus",
        query: "TITLE-ABS-KEY((large language model) AND (time series forecasting) AND uncertainty)",
        queryVariants: [],
        maxResults: 100,
        sortOrder: "publication_date_desc",
        adapterStatus: "ready",
        coverageNote: "Searches Scopus with the complete query.",
      }],
      maxResults: 100,
    };

    render(
      <QueryQualityWorkspace
        run={run}
        busy={null}
        preview={preview}
        externalConfirmed={true}
        onExternalConfirmed={vi.fn()}
        onPreview={vi.fn()}
        onExecute={onExecute}
        onAnalyze={vi.fn()}
        onOptimize={vi.fn()}
        onRevise={vi.fn()}
        onOpenMatrixStage={vi.fn()}
        onOpenPrimaryStage={vi.fn()}
      />,
    );

    expect(screen.getByText("外部试检预览")).toBeTruthy();
    expect(screen.getByText("publication_date_desc")).toBeTruthy();
    const confirmation = screen.getByRole("checkbox") as HTMLInputElement;
    expect(confirmation.checked).toBe(true);
    const query = document.querySelector<HTMLDetailsElement>(".wf-pilot-preview .wf-revision-query-details");
    expect(query?.open).toBe(false);
    await user.click(screen.getByRole("button", { name: "执行试检" }));
    expect(onExecute).toHaveBeenCalledOnce();
  });

  it("does not claim a stage is running when its last action failed", () => {
    const run = {
      matrixSearchProtocolId: "matrix-protocol-1",
      matrixSearchRunId: "matrix-run-1",
      matrixRecordIds: ["paper-1"],
      queryQualityIterations: [],
      events: [],
      stages: [{
        id: "query-quality-loop",
        ordinal: 8,
        title: "试检与误检优化循环",
        description: "",
        // What a pilot leaves behind: the stage is underway, waiting for the
        // analysis step. After that step fails the state is identical, so the
        // label must not be the one used for live execution.
        status: "in_progress",
        summary: "上一次操作失败：Scopus HTTP 429",
        reviewerGate: { required: true, status: "pending", issues: [] },
      }],
    } as unknown as ReviewWorkflowRun;

    render(
      <QueryQualityWorkspace
        run={run}
        busy={null}
        preview={null}
        onPreview={vi.fn()}
        onExecute={vi.fn()}
        onAnalyze={vi.fn()}
        onOptimize={vi.fn()}
        onRevise={vi.fn()}
        onOpenMatrixStage={vi.fn()}
        onOpenPrimaryStage={vi.fn()}
      />,
    );

    expect(screen.getByText("进行中 · 待继续")).toBeTruthy();
    expect(screen.queryByText("运行中")).toBeNull();
  });

  it("presents search coverage as a complete source-aware summary", () => {
    render(
      <SearchCoveragePanel coverage={{
        totalHits: 35,
        fetched: 35,
        unique: 35,
        exhausted: true,
        skippedSources: [],
        failedSources: [],
        sourceAttempts: [{
          source: "scopus",
          status: "completed",
          totalHits: 35,
          fetched: 35,
          unique: 35,
          exhausted: true,
        }],
      }} />,
    );

    expect(screen.getByRole("heading", { name: "检索覆盖概览" })).toBeTruthy();
    expect(screen.getByText("1/1 个来源完成")).toBeTruthy();
    expect(screen.getByText("Scopus")).toBeTruthy();
    expect(screen.getByText("已遍历完全部分页")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "数据源完成度" }).getAttribute("value")).toBe("100");
  });

  it("reads a bounded pilot sample as a sample, not as a truncated sweep", () => {
    const pilot = {
      totalHits: 361,
      fetched: 100,
      unique: 98,
      exhausted: false,
      truncatedReason: "protocol_max_results",
      skippedSources: [],
      failedSources: [],
      sourceAttempts: [{
        source: "scopus",
        status: "completed",
        totalHits: 361,
        fetched: 100,
        unique: 98,
        exhausted: false,
        truncatedReason: "protocol_max_results",
      }],
    };

    const view = render(<SearchCoveragePanel coverage={pilot} sampling />);
    // A pilot that stopped at its sample size did what it was told; the
    // full-sweep alarm ("0/1 个来源完成", "未完成", a 0% bar) is a false one.
    expect(screen.getByText("样本 98/361 篇")).toBeTruthy();
    expect(screen.getByText("已达样本上限")).toBeTruthy();
    expect(screen.queryByText("0/1 个来源完成")).toBeNull();
    expect(screen.queryByText("未完成")).toBeNull();
    expect(screen.queryByRole("progressbar", { name: "数据源完成度" })).toBeNull();

    // The same coverage on a full sweep must still raise that alarm.
    view.rerender(<SearchCoveragePanel coverage={pilot} />);
    expect(screen.getByText("0/1 个来源完成")).toBeTruthy();
    expect(screen.getByText("未完成")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "数据源完成度" })).toBeTruthy();

    // A funnel that did lose records has to show every count it lost them at.
    expect(screen.getByText("361")).toBeTruthy();
    expect(screen.getByText("100")).toBeTruthy();
    expect(screen.getByText("98")).toBeTruthy();
  });

  it("says what happened at each step instead of printing one count six times", () => {
    const settled = {
      totalHits: 37,
      fetched: 37,
      unique: 37,
      exhausted: true,
      skippedSources: [],
      failedSources: [],
      sourceAttempts: [{
        source: "scopus",
        status: "completed",
        totalHits: 37,
        fetched: 37,
        unique: 37,
        exhausted: true,
      }],
    };

    render(<SearchCoveragePanel coverage={settled} sampling />);

    // 总命中 → 已获取 → 去重后 and the one-source breakdown used to repeat "37"
    // six times over. Each step now states what it did, not the same number.
    expect(screen.getAllByText("37")).toHaveLength(1);
    expect(screen.getByText("全部取回")).toBeTruthy();
    expect(screen.getByText("无重复")).toBeTruthy();
    expect(screen.getByText("样本 37 篇")).toBeTruthy();
    // A pilot that ran out of hits before its cap did not hit the cap.
    expect(screen.getByText("已覆盖全部命中")).toBeTruthy();
    expect(screen.queryByText("已达样本上限")).toBeNull();
    // One source has no breakdown to give, but which source, and whether it
    // finished, still has to be on screen.
    expect(screen.queryByText("数据源明细")).toBeNull();
    expect(screen.getByText("Scopus")).toBeTruthy();
    expect(screen.getByText("已遍历完全部分页")).toBeTruthy();
  });

  it("keeps the side rail focused on stage state and artifacts", async () => {
    const user = userEvent.setup();
    render(<Workflows />);

    await user.type(
      await screen.findByPlaceholderText("例如：大语言模型在科学发现中的应用、局限与评估"),
      "大语言模型与时间序列综述",
    );
    await user.click(screen.getByRole("button", { name: "创建并进入计划阶段" }));
    await screen.findByRole("heading", { name: "研究范围与检索计划" });

    const storageKey = "somniq-review-workflows-v1:workflow-test-project";
    const [run] = JSON.parse(localStorage.getItem(storageKey) ?? "[]") as Array<Record<string, unknown>>;
    run.reviewerDisabled = true;
    run.activeStageId = "batch-grading";
    // Four attempts at the same search each register their own artifact.
    run.artifacts = ["a", "b", "c", "d"].map((suffix, index) => ({
      id: `artifact-${suffix}`,
      kind: "primary_library_snapshot",
      title: "原始研究文献库检索快照",
      uri: `literature-run://run-178581002500${index}-cba503f`,
      createdAt: `2026-08-03T${14 + index}:00:00.000Z`,
    }));
    run.batchCheckpoint = {
      kind: "grading",
      stageId: "batch-grading",
      inputFingerprint: "fingerprint",
      batchSize: 20,
      completedBatches: 44,
      totalBatches: 74,
      partial: { kind: "grading", grades: [] },
      updatedAt: "2026-08-03T14:19:00.000Z",
    };
    const stages = run.stages as Array<Record<string, unknown>>;
    const grading = stages.find((stage) => stage.id === "batch-grading")!;
    grading.status = "ready";
    grading.summary = "已完成 44/74 批分级，等待剩余批次。";
    localStorage.setItem(storageKey, JSON.stringify([run]));

    cleanup();
    render(<Workflows />);
    await user.click(await screen.findByRole("button", { name: "打开" }));

    const rail = await screen.findByLabelText("综述工作流阶段");
    await user.click(within(rail).getByRole("button", { name: /A\/B\/C\/D 批量分级/ }));

    const inspector = within(await screen.findByLabelText("阶段详情"));
    // The stage's own state leads: what it is, where it got to.
    expect(inspector.getByText("已完成 44/74 批分级，等待剩余批次。")).toBeTruthy();
    expect(inspector.getByRole("progressbar", { name: "批处理进度" }).getAttribute("value")).toBe("44");
    // Reviewer results and event history belong to the main workflow workspaces,
    // not this compact side rail.
    expect(inspector.queryByText("独立审查")).toBeNull();
    expect(inspector.queryByText("已关闭")).toBeNull();
    expect(inspector.queryByText("待审查")).toBeNull();
    expect(inspector.queryByText("该阶段需要独立 Reviewer 批准后才能通过。")).toBeNull();
    expect(inspector.queryByText("最近动态")).toBeNull();
    // Four identical artifacts are one thing that happened four times, and the
    // storage handle is not something a reader can act on.
    expect(inspector.getByText("共 4 次")).toBeTruthy();
    expect(inspector.getAllByText("原始研究文献库检索快照")).toHaveLength(1);
    expect(inspector.queryByText(/literature-run:\/\//)).toBeNull();
    expect(inspector.queryByText("PRIMARY_LIBRARY_SNAPSHOT")).toBeNull();
    expect(inspector.getByText("文献库快照")).toBeTruthy();
    // Static run settings wait behind a disclosure instead of holding a card.
    expect(inspector.getByText("运行参数")).toBeTruthy();
    expect(inspector.queryByText(/retrieve_relevant_sections_on_demand/)).toBeNull();
  });

  it("returns to the preceding stage without treating back navigation as resume", async () => {
    const user = userEvent.setup();
    render(<Workflows />);

    await user.type(
      await screen.findByPlaceholderText("例如：大语言模型在科学发现中的应用、局限与评估"),
      "大语言模型与时间序列综述",
    );
    await user.click(screen.getByRole("button", { name: "创建并进入计划阶段" }));
    await screen.findByRole("heading", { name: "研究范围与检索计划" });

    const storageKey = "somniq-review-workflows-v1:workflow-test-project";
    const [run] = JSON.parse(localStorage.getItem(storageKey) ?? "[]") as Array<Record<string, unknown>>;
    run.activeStageId = "batch-grading";
    const stages = run.stages as Array<Record<string, unknown>>;
    stages.find((stage) => stage.id === "batch-grading")!.status = "ready";
    localStorage.setItem(storageKey, JSON.stringify([run]));

    cleanup();
    render(<Workflows />);
    await user.click(await screen.findByRole("button", { name: "打开" }));

    const rail = await screen.findByLabelText("综述工作流阶段");
    const batch = within(rail).getByRole("button", { name: /A\/B\/C\/D 批量分级/ });
    const outline = within(rail).getByRole("button", { name: /数据驱动的综述大纲/ });
    const mapping = within(rail).getByRole("button", { name: /论文到章节映射/ });
    await user.click(mapping);

    expect(screen.getByRole("button", { name: "返回上一步" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "继续当前执行阶段" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "返回上一步" }));
    expect(outline.getAttribute("aria-pressed")).toBe("true");
    expect(batch.getAttribute("aria-pressed")).toBe("false");

    await user.click(screen.getByRole("button", { name: "继续当前执行阶段" }));
    expect(batch.getAttribute("aria-pressed")).toBe("true");
  });

  it("rewinds the run onto an earlier stage so it can be changed, not only re-read", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Workflows />);

    await user.type(
      await screen.findByPlaceholderText("例如：大语言模型在科学发现中的应用、局限与评估"),
      "大语言模型与时间序列综述",
    );
    await user.click(screen.getByRole("button", { name: "创建并进入计划阶段" }));
    await screen.findByRole("heading", { name: "研究范围与检索计划" });

    const storageKey = "somniq-review-workflows-v1:workflow-test-project";
    const [run] = JSON.parse(localStorage.getItem(storageKey) ?? "[]") as Array<Record<string, unknown>>;
    const stages = run.stages as Array<Record<string, unknown>>;
    const mapping = stages.find((stage) => stage.id === "section-mapping")!;
    for (const stage of stages) {
      if ((stage.ordinal as number) >= (mapping.ordinal as number)) continue;
      stage.status = "passed";
      stage.reviewerGate = { required: true, status: "approved", issues: [] };
      stage.completedAt = "2026-08-01T00:00:00Z";
    }
    mapping.status = "ready";
    run.activeStageId = "section-mapping";
    localStorage.setItem(storageKey, JSON.stringify([run]));

    cleanup();
    render(<Workflows />);
    await user.click(await screen.findByRole("button", { name: "打开" }));

    const rail = await screen.findByLabelText("综述工作流阶段");
    await user.click(within(rail).getByRole("button", { name: /A\/B\/C\/D 批量分级/ }));
    // Browsing a finished stage stays read-only — the change is that read-only
    // now has a way out other than jumping back to the newest stage.
    expect(document.querySelector(".wf-stage-workspace-fieldset")?.hasAttribute("disabled")).toBe(true);

    await user.click(screen.getByRole("button", { name: "回到这一步修改" }));

    await waitFor(() => expect(screen.queryByText("当前阶段为只读查看")).toBeNull());
    expect(document.querySelector(".wf-stage-workspace-fieldset")?.hasAttribute("disabled")).toBe(false);
    // The confirmation has to name what the rewind costs before it happens.
    expect(confirm.mock.calls[0][0]).toContain("论文到章节映射");

    const [saved] = JSON.parse(localStorage.getItem(storageKey) ?? "[]") as Array<Record<string, unknown>>;
    const savedStages = saved.stages as Array<Record<string, unknown>>;
    expect(saved.activeStageId).toBe("batch-grading");
    expect(savedStages.find((stage) => stage.id === "batch-grading")!.status).toBe("waiting_user");
    expect(savedStages.find((stage) => stage.id === "outline")!.status).toBe("not_started");
    expect(savedStages.find((stage) => stage.id === "section-mapping")!.status).toBe("not_started");
    confirm.mockRestore();
  });

  it("recovers outline themes from the digests instead of a fixed topic taxonomy", () => {
    const evidenceIds = new Set(["p-1", "p-2", "p-3"]);
    const clusters = recoverOutlineClustersFromDigests(
      [
        {
          themes: [
            { name: "阴离子对溶剂化壳层的调控", claims: ["阴离子决定内层结构"], recordIds: ["p-1", "p-2"] },
            { name: "界面副反应的抑制路径", claims: ["成膜添加剂抑制析氢"], recordIds: ["p-3"] },
          ],
          transitions: [],
          evidenceGaps: ["缺少原位表征"],
          contested: ["是否存在阴离子直接吸附"],
        },
        {
          // Same theme, second batch: the merge is by name, so this must add
          // evidence to the existing cluster rather than open a duplicate.
          themes: [{ name: "阴离子对溶剂化壳层的调控", claims: ["浓度改变配位数"], recordIds: ["p-3"] }],
          transitions: [],
          evidenceGaps: [],
          contested: [],
        },
      ],
      evidenceIds,
    );

    // Whatever this review is about, it is not the time-series/hallucination
    // taxonomy the recovery used to hardcode.
    expect(clusters.map((cluster) => cluster.title)).toEqual([
      "阴离子对溶剂化壳层的调控",
      "界面副反应的抑制路径",
    ]);
    expect(clusters[0].recordIds).toEqual(["p-1", "p-2", "p-3"]);
    expect(clusters[0].claim).toContain("阴离子决定内层结构");
    expect(clusters[0].contested).toContain("是否存在阴离子直接吸附");
    // Evidence that is not A/B-graded never enters a cluster.
    expect(clusters.flatMap((cluster) => cluster.recordIds).every((id) => evidenceIds.has(id))).toBe(true);
  });

  it("records a skipped gate when section mapping runs with independent review off", async () => {
    const user = userEvent.setup();
    render(<Workflows />);

    await user.type(
      await screen.findByPlaceholderText("例如：大语言模型在科学发现中的应用、局限与评估"),
      "大语言模型与时间序列综述",
    );
    await user.click(screen.getByRole("button", { name: "创建并进入计划阶段" }));
    await screen.findByRole("heading", { name: "研究范围与检索计划" });

    const storageKey = "somniq-review-workflows-v1:workflow-test-project";
    const [run] = JSON.parse(localStorage.getItem(storageKey) ?? "[]") as Array<Record<string, unknown>>;
    const stages = run.stages as Array<Record<string, unknown>>;
    const mapping = stages.find((stage) => stage.id === "section-mapping")!;
    for (const stage of stages) {
      if ((stage.ordinal as number) >= (mapping.ordinal as number)) continue;
      stage.status = "passed";
      stage.reviewerGate = { required: true, status: "skipped", issues: [] };
    }
    mapping.status = "ready";
    run.activeStageId = "section-mapping";
    run.reviewerDisabled = true;
    run.outline = [{ id: "1", title: "引言", purpose: "背景", children: [] }];
    // Only D grades, so the stage takes the branch that finishes without a
    // model call — the one that used to sign itself "Independent Reviewer".
    run.primaryRecordIds = ["p-1"];
    run.paperGrades = [{ recordId: "p-1", originalIndex: 1, grade: "D", keyFinding: "", rationale: "", method: "" }];
    localStorage.setItem(storageKey, JSON.stringify([run]));

    cleanup();
    render(<Workflows />);
    await user.click(await screen.findByRole("button", { name: "打开" }));
    await user.click(await screen.findByRole("button", { name: "映射 A/B 级论文" }));

    await waitFor(() => {
      const [saved] = JSON.parse(localStorage.getItem(storageKey) ?? "[]") as Array<Record<string, unknown>>;
      const savedStages = saved.stages as Array<Record<string, unknown>>;
      const gate = savedStages.find((stage) => stage.id === "section-mapping")!.reviewerGate as Record<string, unknown>;
      // `approved` here would put an independent Reviewer's name on work that
      // no Reviewer ever saw, and carry it downstream forever.
      expect(gate.status).toBe("skipped");
      expect(gate.reviewer).not.toBe("Independent Reviewer");
    });
  });

  it("offers no rewind for a stage the run has not reached", async () => {
    const user = userEvent.setup();
    render(<Workflows />);

    await user.type(
      await screen.findByPlaceholderText("例如：大语言模型在科学发现中的应用、局限与评估"),
      "大语言模型与时间序列综述",
    );
    await user.click(screen.getByRole("button", { name: "创建并进入计划阶段" }));
    await screen.findByRole("heading", { name: "研究范围与检索计划" });

    const rail = await screen.findByLabelText("综述工作流阶段");
    await user.click(within(rail).getByRole("button", { name: /论文到章节映射/ }));

    expect(screen.getByText("当前阶段为只读查看")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "回到这一步修改" })).toBeNull();
  });

  it("requires a visible theme-cluster step before initial outline generation", async () => {
    const user = userEvent.setup();
    const onGenerate = vi.fn(async () => undefined);
    const onBuildClusters = vi.fn(async () => undefined);
    const run = {
      activeStageId: "outline",
      stages: [{
        id: "outline",
        ordinal: 11,
        title: "Evidence-driven review outline",
        description: "",
        status: "ready",
        reviewerGate: { required: true, status: "pending", issues: [] },
      }],
      outline: [],
      outlineClusters: [],
      paperGrades: [{ recordId: "p-1", originalIndex: 1, grade: "A", keyFinding: "", rationale: "", method: "" }],
    } as unknown as ReviewWorkflowRun;

    render(<OutlineWorkspace run={run} busy={null} onGenerate={onGenerate} onBuildClusters={onBuildClusters} />);

    expect(screen.getByRole("heading", { name: "先构建主题聚类" })).toBeTruthy();
    const button = screen.getByRole("button", { name: "构建主题聚类" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    await user.click(button);
    await waitFor(() => expect(onBuildClusters).toHaveBeenCalledOnce());
    expect(onGenerate).not.toHaveBeenCalled();
  });

  it("keeps cluster recovery enabled when an older outline has no saved clusters", async () => {
    const user = userEvent.setup();
    const onBuildClusters = vi.fn(async () => undefined);
    const run = {
      activeStageId: "outline",
      stages: [{
        id: "outline",
        ordinal: 11,
        title: "Evidence-driven review outline",
        description: "",
        status: "waiting_user",
        reviewerGate: { required: true, status: "pending", issues: [] },
      }],
      outline: [{ id: "1", title: "Legacy outline", purpose: "A saved outline is still readable.", children: [] }],
      outlineClusters: [],
      paperGrades: [{ recordId: "p-1", originalIndex: 1, grade: "A", keyFinding: "", rationale: "", method: "" }],
    } as unknown as ReviewWorkflowRun;

    render(<OutlineWorkspace run={run} busy={null} onGenerate={vi.fn()} onBuildClusters={onBuildClusters} />);

    const recover = screen.getByRole("button", { name: "构建主题聚类" });
    expect((recover as HTMLButtonElement).disabled).toBe(false);
    await user.click(recover);
    await waitFor(() => expect(onBuildClusters).toHaveBeenCalledWith(true));
  });

  it("shows persisted clusters and generates an outline without rebuilding them", async () => {
    const user = userEvent.setup();
    const onGenerate = vi.fn(async () => undefined);
    const onBuildClusters = vi.fn(async () => undefined);
    const run = {
      activeStageId: "outline",
      stages: [{
        id: "outline",
        ordinal: 11,
        title: "Evidence-driven review outline",
        description: "",
        status: "waiting_user",
        reviewerGate: { required: true, status: "pending", issues: [] },
      }],
      outline: [],
      outlineClusterFingerprint: "outline-current",
      outlineClusters: [{
        id: "theme-1",
        title: "Unified detection and calibration",
        claim: "Detection and uncertainty measurement must be compared in one evidence framework.",
        recordIds: ["p-1", "p-2"],
        evidenceGaps: ["No shared benchmark"],
        contested: ["Calibration benefit varies by task"],
      }],
      paperGrades: [{ recordId: "p-1", originalIndex: 1, grade: "A", keyFinding: "", rationale: "", method: "" }],
    } as unknown as ReviewWorkflowRun;

    render(<OutlineWorkspace run={run} busy={null} onGenerate={onGenerate} onBuildClusters={onBuildClusters} />);

    expect(screen.getByRole("region", { name: "主题聚类" })).toBeTruthy();
    expect(screen.getByText("Unified detection and calibration")).toBeTruthy();
    expect(screen.getByText("No shared benchmark")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "生成综述大纲" }));
    await waitFor(() => expect(onGenerate).toHaveBeenCalledOnce());
    expect(onBuildClusters).not.toHaveBeenCalled();
  });

  it("puts multiple persisted clusters on a horizontal rail with explicit navigation", async () => {
    const user = userEvent.setup();
    const scrollBy = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollBy", {
      configurable: true,
      value: scrollBy,
    });
    const run = {
      activeStageId: "outline",
      stages: [{
        id: "outline",
        ordinal: 11,
        title: "Evidence-driven review outline",
        description: "",
        status: "waiting_user",
        reviewerGate: { required: true, status: "pending", issues: [] },
      }],
      outline: [],
      outlineClusterFingerprint: "outline-current",
      outlineClusters: ["Detection", "Calibration", "Evaluation"].map((title, index) => ({
        id: `theme-${index + 1}`,
        title,
        claim: `${title} supplies a distinct evidence-backed review theme.`,
        recordIds: ["p-1"],
        evidenceGaps: [],
        contested: [],
      })),
      paperGrades: [{ recordId: "p-1", originalIndex: 1, grade: "A", keyFinding: "", rationale: "", method: "" }],
    } as unknown as ReviewWorkflowRun;

    render(<OutlineWorkspace run={run} busy={null} onGenerate={vi.fn()} />);

    expect(screen.getByLabelText("主题聚类横向列表")).toBeTruthy();
    expect(screen.getByText("3 个主题")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "查看下一个主题聚类" }));
    expect(scrollBy).toHaveBeenCalledWith({ left: 280, behavior: "smooth" });
    await user.click(screen.getByRole("button", { name: "查看上一个主题聚类" }));
    expect(scrollBy).toHaveBeenLastCalledWith({ left: -280, behavior: "smooth" });
  });

  it("numbers outline sections once and shows what each section rests on", async () => {
    const user = userEvent.setup();
    const run = {
      outline: [
        {
          id: "1",
          title: "引言",
          purpose: "论证两条技术线必须放在同一框架下讨论。",
          recordIds: [],
          children: [
            { id: "1.1", title: "研究背景与动机", purpose: "零样本结果说明 LLM 已进入时序主干。", recordIds: ["p-1", "p-2"], children: [] },
          ],
        },
        {
          id: "2",
          title: "分类体系：按不确定度来源划分",
          purpose: "按来源分类比按模型族分类更能解释成因差异。",
          recordIds: ["p-3"],
          children: [
            {
              id: "2.1",
              title: "数据侧不确定度",
              purpose: "分布漂移构成第一类误差来源。",
              recordIds: ["p-4", "p-5", "p-6"],
              children: [
                { id: "2.1.1", title: "分布漂移", purpose: "跨域迁移下的校准崩塌。", recordIds: ["p-7"], children: [] },
              ],
            },
          ],
        },
      ],
      paperGrades: [{ recordId: "p-1", originalIndex: 1, grade: "A", keyFinding: "", rationale: "", method: "" }],
    } as unknown as ReviewWorkflowRun;

    render(<OutlineWorkspace run={run} busy={null} onGenerate={vi.fn()} />);

    // The section number lives in `section.id`. An <ol> used to add its own on
    // top of it, so every row read "1. 1 引言" / "2. 1.2 核心问题界定".
    expect(document.querySelector(".wf-outline-tree ol")).toBeNull();
    expect(screen.getAllByText("1.1")).toHaveLength(1);
    expect(screen.getAllByText("2.1.1")).toHaveLength(1);
    // Evidence per section is what makes the outline data-driven rather than a
    // template, so it is on the row.
    expect(screen.getByText("3 篇")).toBeTruthy();
    expect(screen.getByText("有证据的末节")).toBeTruthy();

    // The whole outline has to be readable as a skeleton, not only as a wall.
    await user.click(screen.getByRole("button", { name: "只看章标题" }));
    expect(document.querySelectorAll(".wf-outline-chapter[open]")).toHaveLength(0);
    expect(screen.getByText("分类体系：按不确定度来源划分")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "展开全部" }));
    expect(document.querySelectorAll(".wf-outline-chapter[open]")).toHaveLength(2);
  });

  it("submits feedback for an AI outline revision instead of editing the generated snapshot in place", async () => {
    const user = userEvent.setup();
    const onRevise = vi.fn(async () => true);
    const run = {
      activeStageId: "outline",
      stages: [{
        id: "outline",
        ordinal: 11,
        title: "Evidence-driven review outline",
        description: "",
        status: "waiting_user",
        reviewerGate: { required: true, status: "pending", issues: [] },
      }],
      outline: [
        { id: "1", title: "Introduction", purpose: "State the review claim.", children: [] },
        { id: "2", title: "Review Method", purpose: "Search strategy, database, date range, inclusion and exclusion, final count 42.", children: [] },
        { id: "3", title: "Taxonomy", purpose: "One taxonomy organizes the evidence.", children: [] },
        { id: "4", title: "Evaluation", purpose: "Benchmarks, dataset and metrics.", children: [] },
        { id: "5", title: "Comparative analysis", purpose: "Cross-study comparison and disagreement.", children: [] },
        { id: "6", title: "Challenges and future directions", purpose: "Known challenges, open problems, research agenda, and evidence gaps.", children: [] },
        { id: "7", title: "Conclusion", purpose: "Conclude the review claim.", children: [] },
      ],
    } as unknown as ReviewWorkflowRun;

    render(<OutlineWorkspace run={run} busy={null} onGenerate={vi.fn()} onRevise={onRevise} />);
    expect(screen.queryByDisplayValue("Introduction")).toBeNull();
    await user.click(screen.getByRole("button", { name: "提出修改意见" }));
    const feedback = "合并检测和量化章节，并保留对应证据。";
    await user.type(screen.getByRole("textbox", { name: "大纲修改意见" }), feedback);
    await user.click(screen.getByRole("button", { name: "让 AI 根据意见修改" }));

    await waitFor(() => expect(onRevise).toHaveBeenCalledWith(feedback));
  });

  it("brings the revision feedback input into view when feedback mode opens", async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi.fn();
    const previous = HTMLElement.prototype.scrollIntoView;
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const run = {
      activeStageId: "outline",
      stages: [{
        id: "outline",
        ordinal: 11,
        title: "Evidence-driven review outline",
        description: "",
        status: "waiting_user",
        reviewerGate: { required: true, status: "pending", issues: [] },
      }],
      outline: [{ id: "1", title: "Introduction", purpose: "State the review claim.", children: [] }],
      paperGrades: [],
    } as unknown as ReviewWorkflowRun;

    try {
      render(<OutlineWorkspace run={run} busy={null} onGenerate={vi.fn()} />);
      await user.click(screen.getByRole("button", { name: "提出修改意见" }));
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" }));
    } finally {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: previous,
      });
    }
  });

  it("reopens a completed outline before collecting feedback for AI revision", async () => {
    const user = userEvent.setup();
    const onBeginRevision = vi.fn(async () => true);
    const run = {
      activeStageId: "section-mapping",
      stages: [{
        id: "outline",
        ordinal: 11,
        title: "Evidence-driven review outline",
        description: "",
        status: "passed",
        reviewerGate: { required: true, status: "approved", issues: [] },
      }],
      outline: [{ id: "1", title: "Introduction", purpose: "State the review claim.", children: [] }],
      paperGrades: [],
    } as unknown as ReviewWorkflowRun;

    render(<OutlineWorkspace run={run} busy={null} onGenerate={vi.fn()} onBeginRevision={onBeginRevision} />);

    await user.click(screen.getByRole("button", { name: "提出修改意见" }));
    await waitFor(() => expect(onBeginRevision).toHaveBeenCalledOnce());
    expect(screen.getByRole("textbox", { name: "大纲修改意见" })).toBeTruthy();
  });

  it("keeps the per-source breakdown once there is more than one source", () => {
    render(
      <SearchCoveragePanel coverage={{
        totalHits: 60,
        fetched: 60,
        unique: 58,
        exhausted: true,
        skippedSources: [],
        failedSources: [],
        sourceAttempts: [
          { source: "scopus", status: "completed", totalHits: 42, fetched: 41, unique: 40, exhausted: true },
          { source: "openalex", status: "completed", totalHits: 20, fetched: 19, unique: 18, exhausted: true },
        ],
      }} />,
    );

    expect(screen.getByText("数据源明细")).toBeTruthy();
    expect(screen.getByText("42")).toBeTruthy();
    expect(screen.getByText("18")).toBeTruthy();
  });

  it("lists retrieved paper titles and abstracts with honest missing metadata states", async () => {
    const user = userEvent.setup();
    const papers = [
      {
        id: "doi:10.1000/with-abstract",
        title: "Foundation Models for Time Series: A Survey",
        authors: ["Alice Chen", "Bruno Silva"],
        year: 2025,
        venue: "ACM Computing Surveys",
        source: "scopus",
        abstract: "This survey reviews recent foundation models for time-series analysis and identifies open evaluation gaps. ".repeat(6),
      },
      {
        id: "doi:10.1000/no-abstract",
        title: "A Review of Temporal Representation Learning",
        authors: [],
        year: 2024,
        venue: "",
        source: "openalex",
        abstract: "",
      },
    ] as LiteraturePaper[];

    render(
      <SearchResultsList
        recordIds={[papers[0].id, papers[1].id, "doi:10.1000/unresolved"]}
        papers={papers}
        loading={false}
        error=""
      />,
    );

    expect(screen.getByRole("heading", { name: "检索到的论文" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: papers[0].title })).toBeTruthy();
    expect(screen.getByText(/This survey reviews recent foundation models/)).toBeTruthy();
    expect(screen.getByText("2025")).toBeTruthy();
    expect(screen.getByText("Alice Chen、Bruno Silva")).toBeTruthy();
    expect(screen.getByText("当前元数据源未提供摘要，可在后续资格核验时补充或查阅论文原文。")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "论文详情暂不可用" })).toBeTruthy();
    expect(screen.getByText(/已读取 2\/3 篇论文详情/)).toBeTruthy();

    const toggle = screen.getByRole("button", { name: "展开摘要" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await user.click(toggle);
    expect(screen.getByRole("button", { name: "收起摘要" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("makes a clicked stage visibly distinct from the workflow's active step", async () => {
    const user = userEvent.setup();
    render(<Workflows />);

    await user.type(
      await screen.findByPlaceholderText("例如：大语言模型在科学发现中的应用、局限与评估"),
      "大语言模型与时间序列综述",
    );
    await user.click(screen.getByRole("button", { name: "创建并进入计划阶段" }));

    const rail = await screen.findByLabelText("综述工作流阶段");
    const selectedStage = within(rail).getByRole("button", { name: /矩阵式 Scopus 策略/ });
    const activeStage = within(rail).getByRole("button", { name: /综述侦察与方向发现/ });
    expect(activeStage.classList.contains("active")).toBe(true);
    expect(selectedStage.classList.contains("inspected")).toBe(false);

    await user.click(selectedStage);

    expect(selectedStage.classList.contains("inspected")).toBe(true);
    expect(selectedStage.getAttribute("aria-pressed")).toBe("true");
    expect(within(selectedStage).getByText("正在查看 · 未开始")).toBeTruthy();
    expect(activeStage.classList.contains("active")).toBe(true);
    expect(await screen.findByRole("heading", { name: "矩阵式 Scopus 检索策略" })).toBeTruthy();
  });

  it("shows the stage transcript and the run's model controls on a later stage, not only on stage 01", async () => {
    const user = userEvent.setup();
    render(<Workflows />);

    await user.type(
      await screen.findByPlaceholderText("例如：大语言模型在科学发现中的应用、局限与评估"),
      "大语言模型与时间序列综述",
    );
    await user.click(screen.getByRole("button", { name: "创建并进入计划阶段" }));

    // Stage 01 owns the model controls historically; they must survive the move.
    expect(await screen.findByRole("heading", { name: "研究范围与检索计划" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: /Executor 模型/ })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "启用独立 Reviewer" })).toBeTruthy();

    const rail = await screen.findByLabelText("综述工作流阶段");
    await user.click(within(rail).getByRole("button", { name: /试检与误检优化循环/ }));

    expect(await screen.findByRole("heading", { name: "试检与误检优化循环" })).toBeTruthy();
    // The model is a run-level setting; reaching it must not require walking
    // back to the first stage.
    expect(screen.getByRole("combobox", { name: /Executor 模型/ })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "启用独立 Reviewer" })).toBeTruthy();
    // Several stage descriptions point at "下方「运行过程」"; the panel has to
    // actually be mounted for that to be true.
    expect(screen.getByText("运行过程")).toBeTruthy();
    expect(screen.getByText(/该阶段还没有运行记录/)).toBeTruthy();
  });

  it("reports the pilot's Scopus source coverage instead of a bare record count", async () => {
    const user = userEvent.setup();
    render(<Workflows />);

    await user.type(
      await screen.findByPlaceholderText("例如：大语言模型在科学发现中的应用、局限与评估"),
      "大语言模型与时间序列综述",
    );
    await user.click(screen.getByRole("button", { name: "创建并进入计划阶段" }));
    await screen.findByRole("heading", { name: "研究范围与检索计划" });

    const storageKey = "somniq-review-workflows-v1:workflow-test-project";
    const [run] = JSON.parse(localStorage.getItem(storageKey) ?? "[]") as Array<Record<string, unknown>>;
    run.matrixSearchProtocolId = "matrix-protocol-1";
    run.matrixSearchRunId = "matrix-run-1";
    run.matrixSearchPathId = "abc";
    run.matrixRecordIds = ["doi:10.1000/pilot-a", "doi:10.1000/pilot-b"];
    run.matrixCoverage = {
      totalHits: 2,
      fetched: 2,
      unique: 2,
      exhausted: true,
      skippedSources: [],
      failedSources: [],
      sourceAttempts: [{
        source: "scopus",
        status: "completed",
        totalHits: 2,
        fetched: 2,
        unique: 2,
        exhausted: true,
      }],
    };
    localStorage.setItem(storageKey, JSON.stringify([run]));

    cleanup();
    render(<Workflows />);
    await user.click(await screen.findByRole("button", { name: "打开" }));

    const rail = await screen.findByLabelText("综述工作流阶段");
    await user.click(within(rail).getByRole("button", { name: /试检与误检优化循环/ }));

    expect(await screen.findByRole("heading", { name: "试检与误检优化循环" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "检索覆盖概览" })).toBeTruthy();
    // The pilot panel reports a bounded sample, not source-sweep completion.
    // The sample is every hit here, so it is stated once rather than as "2/2".
    expect(screen.getByText("样本 2 篇")).toBeTruthy();
    // The pilot stage deliberately lists no papers: its record set does not
    // move between rounds, so the query's evolution is what belongs here.
    expect(screen.queryByRole("heading", { name: "检索到的论文" })).toBeNull();
    expect(screen.getByRole("button", { name: "分析 2 篇试检结果" })).toBeTruthy();
  });

  it("keeps the active run openable while its automation is busy", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(
      <WorkflowHome
        summaries={[{
          id: "active-run",
          title: "Active review",
          topic: "Time-series foundation models",
          status: "running",
          activeStageId: "review-eligibility",
          revision: 13,
          updatedAt: "2026-07-31T18:56:47Z",
        }]}
        activeId="active-run"
        busy
        error=""
        onOpen={onOpen}
        onCreate={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onDismissError={vi.fn()}
      />,
    );

    const open = screen.getByRole("button", { name: "打开" }) as HTMLButtonElement;
    expect(open.disabled).toBe(false);
    expect((screen.getByRole("button", { name: "重命名" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "删除" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(open);
    expect(onOpen).toHaveBeenCalledWith("active-run");
  });

  it("creates a durable run and enforces plan review before search", async () => {
    const user = userEvent.setup();
    render(<Workflows />);

    expect(await screen.findByRole("heading", { name: "从研究主题到可投稿综述论文" })).toBeTruthy();
    await user.type(
      screen.getByPlaceholderText("例如：大语言模型在科学发现中的应用、局限与评估"),
      "大语言模型在科学发现中的应用",
    );
    await user.type(
      screen.getByPlaceholderText("large language model, scientific discovery, evaluation"),
      "large language model, scientific discovery",
    );
    await user.click(screen.getByRole("button", { name: "创建并进入计划阶段" }));

    expect(await screen.findByRole("heading", { name: "研究范围与检索计划" })).toBeTruthy();
    const rail = screen.getByLabelText("综述工作流阶段");
    expect(within(rail).getByText("0/12 步骤通过")).toBeTruthy();
    expect(within(rail).getByRole("button", { name: /综述侦察与方向发现/ })).toBeTruthy();
    expect(within(rail).getAllByRole("button")).toHaveLength(12);
    await user.click(screen.getByRole("button", { name: "生成并审查检索计划" }));

    expect(await screen.findByText("检索式矩阵")).toBeTruthy();
    expect(screen.queryByText("浏览器预览：使用内置审查规则验证了检索式矩阵。")).toBeNull();
    await user.click(screen.getByRole("button", { name: "确认检索式并开始侦察" }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "近五年综述全量检索" })).toBeTruthy();
    });
    expect(screen.getByText(/未遍历完时，不进入数量分支/)).toBeTruthy();

    const stored = JSON.parse(
      localStorage.getItem("somniq-review-workflows-v1:workflow-test-project") ?? "[]",
    ) as Array<{ planApproved: boolean; scoutAutomationStatus?: string; activeStageId: string; events: unknown[] }>;
    expect(stored).toHaveLength(1);
    expect(stored[0].planApproved).toBe(true);
    expect(stored[0].scoutAutomationStatus).toBe("running");
    expect(stored[0].activeStageId).toBe("review-landscape-search");
    expect(stored[0].events.length).toBeGreaterThanOrEqual(3);

    await user.click(screen.getByRole("button", { name: "工作流首页" }));
    expect(await screen.findByRole("heading", { name: "工作流首页" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "打开" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "重命名" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "删除" })).toBeTruthy();
  });

  it("makes a rejected plan actionable from the plan workspace", async () => {
    const user = userEvent.setup();
    const view = render(<Workflows />);

    await user.type(
      await screen.findByPlaceholderText("例如：大语言模型在科学发现中的应用、局限与评估"),
      "大语言模型在科学发现中的应用",
    );
    await user.click(screen.getByRole("button", { name: "创建并进入计划阶段" }));
    await user.click(screen.getByRole("button", { name: "生成并审查检索计划" }));
    await screen.findByText("检索式矩阵");

    const storageKey = "somniq-review-workflows-v1:workflow-test-project";
    const [rejectedRun] = JSON.parse(localStorage.getItem(storageKey) ?? "[]") as Array<{
      status: string;
      stages: Array<{
        id: string;
        status: string;
        reviewerGate: { status: string; summary?: string; issues: string[] };
      }>;
    }>;
    const planStage = rejectedRun.stages.find((stage) => stage.id === "scope-and-plan")!;
    rejectedRun.status = "revision_required";
    planStage.status = "revision_required";
    planStage.reviewerGate = {
      status: "rejected",
      summary: "检索式缺少足够的同义词覆盖。",
      issues: ["为每个数据源补充同义词变体。"],
    };
    localStorage.setItem(storageKey, JSON.stringify([rejectedRun]));

    view.unmount();
    render(<Workflows />);
    await user.click(await screen.findByRole("button", { name: "打开" }));

    expect((await screen.findAllByText("检索式缺少足够的同义词覆盖。")).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("button", { name: "基于建议重新生成" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "完整重新生成" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "保存当前计划并重新审查" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "保存当前计划并重新审查" }));
    await user.click(await screen.findByRole("button", { name: "确认检索式并开始侦察" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "近五年综述全量检索" })).toBeTruthy();
    });
  });

  it("allows an explicitly skipped reviewer gate to continue to search", async () => {
    const user = userEvent.setup();
    render(<Workflows />);

    await user.type(
      await screen.findByPlaceholderText("例如：大语言模型在科学发现中的应用、局限与评估"),
      "大语言模型在科学发现中的应用",
    );
    await user.click(screen.getByRole("button", { name: "创建并进入计划阶段" }));
    const reviewerSwitch = screen.getByRole("switch", { name: "启用独立 Reviewer" });
    expect(reviewerSwitch.getAttribute("aria-checked")).toBe("true");
    const topbar = document.querySelector<HTMLElement>(".wf-topbar")!;
    expect(within(topbar).getByRole("combobox", { name: /模型/ })).toBeTruthy();
    expect(within(topbar).getByRole("switch", { name: "启用独立 Reviewer" })).toBe(reviewerSwitch);
    await user.click(reviewerSwitch);
    expect(reviewerSwitch.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByText("审核模型已关闭")).toBeNull();
    expect(reviewerSwitch.textContent).toContain("已关闭");

    await user.click(screen.getByRole("button", { name: "生成并审查检索计划" }));
    await user.click(await screen.findByRole("button", { name: "确认检索式并开始侦察" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "近五年综述全量检索" })).toBeTruthy();
    });
  });

  it("hands the current workflow to a dedicated Chat conversation with durable context", async () => {
    const user = userEvent.setup();
    render(<Workflows />);

    await user.type(
      await screen.findByPlaceholderText("例如：大语言模型在科学发现中的应用、局限与评估"),
      "大语言模型在科学发现中的应用",
    );
    await user.click(screen.getByRole("button", { name: "创建并进入计划阶段" }));
    const discuss = await waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>(".wf-discuss");
      expect(button).toBeTruthy();
      return button!;
    });
    fireEvent.click(discuss);

    const handoff = useStore.getState().pendingChatHandoff;
    expect(useStore.getState().tab).toBe("chat");
    expect(handoff?.projectId).toBe("workflow-test-project");
    expect(handoff?.conversationKey).toMatch(/^review-workflow:review-preview-/);
    expect(handoff?.sessionId).toMatch(/^wf-review-preview-/);
    expect(handoff?.workflowRunId).toMatch(/^review-preview-/);
    expect(handoff?.activate).toBe(true);
    expect(handoff?.draft).toBe("请指出当前阶段的主要风险和最小可执行下一步。");
    expect(handoff?.input).toBe("");
    expect(handoff?.projectedTurns).toBeUndefined();
  });
});
