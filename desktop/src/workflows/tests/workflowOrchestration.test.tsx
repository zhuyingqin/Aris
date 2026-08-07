// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useStore } from "../../store";
import type { LiteraturePaper } from "../../literature/literatureTypes";
import type { ReviewWorkflowRun } from "../workflowTypes";
import Workflows, {
  primaryCoverageReason,
  primaryLibraryIsReady,
  primaryPathProgress,
} from "../Workflows";
import { createTauriMocks, createWorkflowLedger } from "./workflowLedgerHarness";

const ledger = createWorkflowLedger();
let mocks: ReturnType<typeof createTauriMocks>;
const installed = () => mocks;

// The factory is hoisted above every import, so it cannot reach the harness
// module. It exports stable functions that delegate at call time to whatever
// `beforeEach` installed — which keeps the real implementations in one reusable
// file while still satisfying the hoisting rule.
// Module scope calls `isTauri()` while these modules are still being imported,
// which is before any `beforeEach` can install the real harness — so the
// registry starts with just enough to answer that one question.
const apiMocks = vi.hoisted(() => ({
  current: { isTauri: () => true } as Record<string, (...args: never[]) => unknown>,
}));
vi.mock("../../api/tauri", () => {
  const names = [
    "isTauri",
    "reviewWorkflowsList", "reviewWorkflowLoad", "reviewWorkflowSave",
    "reviewWorkflowCreate", "reviewWorkflowRename", "reviewWorkflowDelete",
    "reviewWorkflowLeaseAcquire", "reviewWorkflowLeaseRelease",
    "reviewWorkflowExecutorTurn", "reviewWorkflowReviewerTurn",
    "reviewWorkflowDriveOnce", "reviewWorkflowConfirmScopePlan",
    "reviewWorkflowSubmitScopePlan", "reviewWorkflowResetScopePlan",
    "literatureLoad", "literatureApplyDelta", "literatureLlmCancel",
    "literatureSearchProtocolCreate", "literatureSearchProtocolPreview",
    "literatureSearchProtocolExecute", "listenLiteratureSearchProgress",
    "listenReviewWorkflowTurnProgress", "chatCancel", "chatModelOptions",
    "openChatCompanion",
  ];
  const module: Record<string, unknown> = {};
  for (const name of names) {
    module[name] = (...args: never[]) => {
      const installed = apiMocks.current[name];
      if (!installed) throw new Error(`unmocked tauri call: ${name}`);
      return installed(...args);
    };
  }
  return module;
});

// Paths that pick between the Rust ledger and the browser-preview store branch
// on "is there a backend", not "am I in a webview". These specs drive the
// ledger, so the backend has to look present here too.
vi.mock("../../api/transport", () => ({
  hasNativeBackend: () => true,
  transportKind: () => "tauri" as const,
  devBackendUrl: () => null,
}));

const STAGES = [
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
];

/** A run parked at the pilot stage with an approved strategy and pilot records. */
function pilotReadyRun(recordCount: number): ReviewWorkflowRun {
  const now = "2026-08-03T00:00:00Z";
  return {
    protocolVersion: 1,
    id: "review-test-1",
    sessionId: "wf-review-test-1",
    templateId: "review-paper-from-topic",
    templateVersion: 2,
    revision: 1,
    updatedAt: now,
    createdAt: now,
    title: "综述：test",
    topic: "large language models for time series",
    keywords: ["llm", "time series"],
    languages: ["English"],
    databases: ["scopus"],
    yearFrom: 2020,
    yearTo: 2026,
    contextPolicy: {
      abstractBatchSize: 20,
      abstractCharsPerRecord: 2400,
      synthesisInputChars: 60000,
      fullTextStrategy: "retrieve_relevant_sections_on_demand",
    },
    status: "running",
    activeStageId: "query-quality-loop",
    planApproved: true,
    scoutAutomationStatus: "idle",
    scoutRevisionLimit: 4,
    reviewSearchIteration: 1,
    searchRecordIds: [],
    reviewEligibility: {
      candidateRecordIds: [],
      eligibleRecordIds: [],
      excludedRecordIds: [],
      missingAbstractRecordIds: [],
      complete: true,
      method: "independent_reviewer",
    },
    reviewCountBranch: "unknown",
    selectedDirectionId: "direction-1",
    landscapeAnalysis: {
      developmentStatus: "",
      majorProblems: [],
      newcomerNotes: [],
      temporalTrends: [],
      topicEvolution: [],
      reviewGaps: [],
      directions: [{
        id: "direction-1",
        title: "LLMs for time-series forecasting",
        gap: "no process-level comparison",
        outline: "",
        workload: "",
        difficulty: "medium",
        feasibility: "",
        evidenceRecordIds: [],
      }],
      generatedAt: now,
      generatedBy: "Executor",
    },
    matrixStrategy: {
      mode: "expanded",
      concepts: [],
      paths: [{
        id: "abc",
        combination: "A+B+C",
        target: "核心组合",
        strategicIntent: "",
        query: 'TITLE-ABS-KEY(llm AND "time series")',
        actionGuide: "",
        expectedResults: "",
        reviewValue: "",
      }],
      exclusionAdvice: "",
      syntaxChecks: [],
      generatedAt: now,
      generatedBy: "Executor",
    },
    matrixPlanApproved: true,
    matrixSearchProtocolId: "protocol-1",
    matrixSearchRunId: "search-run-1",
    matrixSearchPathId: "abc",
    matrixRecordIds: Array.from({ length: recordCount }, (_, index) => `paper-${index}`),
    matrixCoverage: {
      totalHits: recordCount,
      fetched: recordCount,
      unique: recordCount,
      exhausted: true,
      skippedSources: [],
      failedSources: [],
      sourceAttempts: [],
    },
    queryQualityIterations: [],
    primaryTargetResults: 500,
    primaryRecordIds: [],
    paperGrades: [],
    outline: [],
    paperMappings: [],
    artifacts: [],
    activityLog: [],
    events: [
      { sequence: 1, timestamp: now, actor: "user", action: "review_direction_selected", summary: "" },
      { sequence: 2, timestamp: now, actor: "Executor", action: "matrix_pilot_executed", summary: "" },
    ],
    stages: STAGES.map((id, index) => ({
      id,
      ordinal: index + 1,
      title: id,
      description: "",
      status: index < 7 ? "passed" : index === 7 ? "in_progress" : "not_started",
      reviewerGate: {
        required: true,
        status: index < 7 ? "approved" : "pending",
        issues: [],
      },
    })),
  } as unknown as ReviewWorkflowRun;
}

function papers(count: number): LiteraturePaper[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `paper-${index}`,
    title: `Paper ${index}`,
    authors: ["A"],
    year: 2025,
    venue: "Venue",
    abstract: "abstract",
    tags: [],
    source: "scopus",
  } as unknown as LiteraturePaper));
}

/** One relevance verdict per record in the batch, as the analyser demands. */
function classificationReply(indices: number[]) {
  return JSON.stringify({
    items: indices.map((index) => ({
      index,
      relevant: index % 2 === 0,
      reason: "r",
      retrievalCause: "c",
    })),
  });
}

beforeEach(() => {
  localStorage.clear();
  mocks = createTauriMocks(ledger);
  apiMocks.current = mocks as unknown as Record<string, (...args: never[]) => unknown>;
  ledger.runs.clear();
  ledger.turns.length = 0;
  ledger.executorReplies.length = 0;
  ledger.reviewerReplies.length = 0;
  useStore.setState({
    tab: "workflows",
    currentProject: {
      id: "default",
      name: "Workflow test",
      path: "test",
      addedAt: 0,
      lastOpenedAt: 0,
    },
    pendingChatInput: null,
    pendingChatHandoff: null,
    literatureLibraryScope: null,
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("workflow orchestration", () => {
  it("completes the primary library at its corpus target without hiding unread Scopus pages", () => {
    const run = pilotReadyRun(20);
    run.primaryTargetResults = 500;
    run.primaryRecordIds = Array.from({ length: 500 }, (_, index) => `primary-${index}`);
    run.matrixStrategy!.paths = [
      { ...run.matrixStrategy!.paths[0], id: "abc", combination: "A+B+C" },
      { ...run.matrixStrategy!.paths[0], id: "ba", combination: "B+A" },
      { ...run.matrixStrategy!.paths[0], id: "bc", combination: "B+C" },
      { ...run.matrixStrategy!.paths[0], id: "ac", combination: "A+C" },
    ];
    // Selection settled every path, which is what makes readiness real in the
    // quality flow: `primaryRecordIds` is the admitted-union evidence, not the
    // raw provider order.
    const quotas = { abc: 115, ab: 200, bc: 100, ac: 85 } as const;
    let cursor = 0;
    run.primaryPathAdmissions = (["abc", "ab", "bc", "ac"] as const).map((pathId) => {
      const admittedRecordIds = Array.from({ length: quotas[pathId] }, () => `primary-${cursor++}`);
      return {
        pathId,
        quota: quotas[pathId],
        candidateRecordIds: admittedRecordIds,
        admittedRecordIds,
        deferredRecordIds: [],
        selectedAt: "2026-08-03T00:00:00Z",
        method: "test",
      };
    });
    run.primaryCoverage = {
      fetched: 787,
      unique: 749,
      exhausted: false,
      nextCursor: JSON.stringify({
        abc: "__exhausted__",
        ba: "opaque-ba",
        bc: "opaque-bc",
        ac: "opaque-ac",
      }),
      truncatedReason: "provider_has_more_results",
      skippedSources: [],
      failedSources: [],
      sourceAttempts: [],
    };

    expect(primaryLibraryIsReady(run)).toBe(true);
    expect(primaryCoverageReason(run.primaryCoverage)).toBe("Scopus 仍有下一页");
    expect(primaryPathProgress(run).map(({ id, status }) => [id, status])).toEqual([
      ["abc", "complete"],
      ["ab", "seeded"],
      ["bc", "seeded"],
      ["ac", "seeded"],
    ]);
  });

  it("creates the primary protocol from four journal-article matrix streams", async () => {
    const user = userEvent.setup();
    const run = pilotReadyRun(20);
    run.activeStageId = "primary-library";
    run.stages.find((stage) => stage.id === "query-quality-loop")!.status = "passed";
    run.stages.find((stage) => stage.id === "primary-library")!.status = "ready";
    run.matrixStrategy!.paths = [
      { ...run.matrixStrategy!.paths[0], id: "abc", combination: "A+B+C", query: "TITLE-ABS-KEY(a AND b AND c)" },
      { ...run.matrixStrategy!.paths[0], id: "ba", combination: "B+A", query: "TITLE-ABS-KEY(b AND a)" },
      { ...run.matrixStrategy!.paths[0], id: "bc", combination: "B+C", query: "TITLE-ABS-KEY(b AND c)" },
      { ...run.matrixStrategy!.paths[0], id: "ac", combination: "A+C", query: "TITLE-ABS-KEY(a AND c)" },
    ];
    ledger.put(run);
    ledger.executorReplies.push(JSON.stringify({
      allocations: [
        { id: "abc", maxResults: 80, rationale: "narrow core evidence" },
        { id: "ab", maxResults: 280, rationale: "selected-domain coverage" },
        { id: "bc", maxResults: 70, rationale: "representative methods" },
        { id: "ac", maxResults: 70, rationale: "representative baselines" },
      ],
    }));

    render(<Workflows />);
    await user.click(await screen.findByRole("button", { name: "打开" }));
    expect(screen.getByText("仅 Scopus 期刊研究论文")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "生成全量检索预览" }));

    await waitFor(() => expect(installed().literatureSearchProtocolCreate).toHaveBeenCalledOnce());
    const draft = installed().literatureSearchProtocolCreate.mock.calls[0][0] as {
      queryVariants: Record<string, Array<{ kind: string; query: string; maxResults?: number }>>;
      inclusionCriteria: string[];
      exclusionCriteria: string[];
    };
    expect(draft.queryVariants.scopus.map((variant) => variant.kind)).toEqual(["abc", "ab", "bc", "ac"]);
    expect(draft.queryVariants.scopus.every((variant) =>
      variant.query.endsWith("AND DOCTYPE(ar) AND SRCTYPE(j)"),
    )).toBe(true);
    // The user-entered target is a hard retrieval budget. Path allocations
    // must not be multiplied into a larger provider plan.
    expect(draft.queryVariants.scopus.map((variant) => variant.maxResults)).toEqual([80, 280, 70, 70]);
    expect(draft.inclusionCriteria.join(" ")).toContain("DOCTYPE(ar)");
    expect(draft.exclusionCriteria.join(" ")).toContain("会议论文");
  });

  it("opens the first unfinished stage instead of the last passed stage", async () => {
    const user = userEvent.setup();
    const run = pilotReadyRun(20);
    run.activeStageId = "query-quality-loop";
    run.stages.find((stage) => stage.id === "query-quality-loop")!.status = "passed";
    run.stages.find((stage) => stage.id === "primary-library")!.status = "ready";
    ledger.put(run);

    render(<Workflows />);
    await user.click(await screen.findByRole("button", { name: "打开" }));
    expect(await screen.findByRole("heading", { name: "构建高质量原始文献库" })).toBeTruthy();
  });

  it("hands the primary corpus to Literature with an exact record scope", async () => {
    const user = userEvent.setup();
    const run = pilotReadyRun(20);
    run.activeStageId = "primary-library";
    run.primarySearchProtocolId = "primary-protocol-1";
    run.primarySearchRunId = "primary-search-1";
    run.primaryRecordIds = ["paper-0", "paper-1"];
    run.primaryCoverage = {
      fetched: 2,
      unique: 2,
      exhausted: false,
      nextCursor: "opaque-next-page",
      skippedSources: [],
      failedSources: [],
      sourceAttempts: [],
    };
    run.stages.find((stage) => stage.id === "query-quality-loop")!.status = "passed";
    run.stages.find((stage) => stage.id === "primary-library")!.status = "partial";
    ledger.put(run);

    render(<Workflows />);
    await user.click(await screen.findByRole("button", { name: "打开" }));
    await user.click(await screen.findByRole("button", { name: "在文献中查看" }));

    expect(useStore.getState().tab).toBe("literature");
    expect(useStore.getState().literatureLibraryScope).toEqual({
      projectId: "default",
      title: "综述：test · 原始文献库",
      recordIds: ["paper-0", "paper-1"],
      workflowRunId: run.id,
      searchRunId: "primary-search-1",
    });
  });

  it("projects an existing Stage 10 A/B/C/D result into Literature and opens its scoped library", async () => {
    const user = userEvent.setup();
    const run = pilotReadyRun(20);
    run.activeStageId = "batch-grading";
    run.primarySearchRunId = "primary-search-graded";
    run.primaryTargetResults = 50;
    run.primaryRecordIds = ["paper-0", "paper-1"];
    run.primaryCoverage = {
      fetched: 2,
      unique: 2,
      exhausted: true,
      skippedSources: [],
      failedSources: [],
      sourceAttempts: [],
    };
    run.paperGrades = [
      {
        recordId: "paper-0",
        originalIndex: 1,
        grade: "A",
        keyFinding: "core finding",
        rationale: "direct evidence",
        method: "independent_reviewer",
      },
      {
        recordId: "paper-1",
        originalIndex: 2,
        grade: "C",
        keyFinding: "peripheral finding",
        rationale: "weak relation",
        method: "independent_reviewer",
      },
    ];
    run.stages.find((stage) => stage.id === "primary-library")!.status = "passed";
    const gradingStage = run.stages.find((stage) => stage.id === "batch-grading")!;
    // Keep this stage active while its already-produced grades are being
    // projected into Literature; a passed stage would correctly make outline
    // the current stage under the navigation contract.
    gradingStage.status = "in_progress";
    gradingStage.completedAt = "2026-08-03T23:05:00Z";
    installed().literatureLoad.mockResolvedValue({
      papers: papers(2),
      searchRuns: [],
      criteria: [],
    });
    ledger.put(run);

    render(<Workflows />);
    await user.click(await screen.findByRole("button", { name: "打开" }));
    await user.click(await screen.findByRole("button", { name: "在文献库查看 A/B/C/D" }));

    await waitFor(() => expect(installed().literatureApplyDelta).toHaveBeenCalledOnce());
    const delta = installed().literatureApplyDelta.mock.calls[0][0] as {
      upsertPapers: LiteraturePaper[];
    };
    expect(delta.upsertPapers).toHaveLength(2);
    expect(delta.upsertPapers[0].workflowGrades).toEqual([expect.objectContaining({
      workflowRunId: run.id,
      workflowTitle: run.title,
      grade: "A",
      originalIndex: 1,
      gradedAt: "2026-08-03T23:05:00Z",
    })]);
    expect(delta.upsertPapers[1].workflowGrades?.[0].grade).toBe("C");
    expect(useStore.getState().tab).toBe("literature");
    expect(useStore.getState().literatureLibraryScope).toEqual({
      projectId: "default",
      title: "综述：test · A/B/C/D 分级文献",
      recordIds: ["paper-0", "paper-1"],
      workflowRunId: run.id,
      searchRunId: "primary-search-graded",
    });
  });

  it("restarts the primary-library stage without deleting the approved matrix", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const run = pilotReadyRun(20);
    run.activeStageId = "primary-library";
    run.primarySearchProtocolId = "primary-protocol-1";
    run.primarySearchRunId = "primary-search-1";
    run.primaryRecordIds = ["paper-0", "paper-1"];
    run.primaryCoverage = {
      fetched: 2,
      unique: 2,
      exhausted: false,
      nextCursor: "opaque-next-page",
      skippedSources: [],
      failedSources: [],
      sourceAttempts: [],
    };
    run.paperGrades = [{
      recordId: "paper-0",
      originalIndex: 0,
      grade: "A",
      keyFinding: "finding",
      rationale: "relevant",
      method: "independent_reviewer",
    }];
    run.stages.find((stage) => stage.id === "query-quality-loop")!.status = "passed";
    // Reopening is only available while the primary-library stage is current;
    // a passed stage is intentionally read-only once batch grading is active.
    run.stages.find((stage) => stage.id === "primary-library")!.status = "partial";
    run.stages.find((stage) => stage.id === "batch-grading")!.status = "in_progress";
    ledger.put(run);

    render(<Workflows />);
    await user.click(await screen.findByRole("button", { name: "打开" }));
    await user.click(await screen.findByRole("button", { name: "重新开始建库" }));

    await waitFor(() => expect(ledger.get(run.id).events.at(-1)?.action).toBe("primary_library_restarted"));
    const saved = ledger.get(run.id);
    expect(confirm).toHaveBeenCalledOnce();
    expect(saved.activeStageId).toBe("primary-library");
    expect(saved.primarySearchProtocolId).toBeUndefined();
    expect(saved.primarySearchRunId).toBeUndefined();
    expect(saved.primaryRecordIds).toEqual([]);
    expect(saved.primaryCoverage).toBeUndefined();
    expect(saved.paperGrades).toEqual([]);
    expect(saved.primaryTargetResults).toBe(500);
    expect(saved.matrixStrategy).toEqual(run.matrixStrategy);
    expect(saved.stages.find((stage) => stage.id === "primary-library")?.status).toBe("ready");
    expect(saved.stages.find((stage) => stage.id === "batch-grading")?.status).toBe("not_started");
    confirm.mockRestore();
  });

  it("keeps a multi-batch analysis on the current revision instead of the one it started with", async () => {
    // 45 records at 20 per batch is three batches, so the second and third model
    // calls happen after the runner has already written checkpoints. Reusing the
    // run captured at job start is what produced
    // "expected revision 170, current revision 173" in the app.
    const user = userEvent.setup();
    const run = pilotReadyRun(45);
    ledger.put(run);
    installed().literatureLoad.mockResolvedValue({
      papers: papers(45),
      searchRuns: [],
      criteria: [],
    });
    ledger.reviewerReplies.push(
      classificationReply([...Array(20).keys()]),
      classificationReply([...Array(20).keys()].map((index) => index + 20)),
      classificationReply([40, 41, 42, 43, 44]),
      // Gate verdict for the analysis.
      JSON.stringify({ approved: true, summary: "样本质量通过。", issues: [] }),
    );
    ledger.executorReplies.push(JSON.stringify({
      patterns: ["p"],
      adjustments: ["a"],
      recommendation: "继续",
    }));

    render(<Workflows />);
    await user.click(await screen.findByRole("button", { name: "打开" }));
    await user.click(await screen.findByRole("button", { name: /分析 45 篇试检结果/ }));

    await waitFor(() => {
      expect(ledger.get(run.id).queryQualityIterations).toHaveLength(1);
    });
    // Every model turn was accepted, which only holds if each one declared the
    // revision the ledger was actually at.
    expect(ledger.turns.length).toBeGreaterThanOrEqual(4);
    const revisions = ledger.turns.map((turn) => turn.revision);
    expect([...revisions].sort((left, right) => left - right)).toEqual(revisions);
    expect(screen.queryByText(/changed on disk/)).toBeNull();
  });

  it("carries a rejected round's false positives into the next strategy", async () => {
    const user = userEvent.setup();
    const run = pilotReadyRun(20);
    ledger.put(run);
    installed().literatureLoad.mockResolvedValue({
      papers: papers(20),
      searchRuns: [],
      criteria: [],
    });
    // A precision below the 50% floor rejects the round and must hand its
    // evidence to the revision that follows.
    ledger.reviewerReplies.push(
      JSON.stringify({
        items: [...Array(20).keys()].map((index) => ({
          index,
          relevant: index < 4,
          reason: "r",
          retrievalCause: "c",
        })),
      }),
      JSON.stringify({ approved: false, summary: "查准率不足。", issues: [] }),
      // Reviewer gate on the revised strategy.
      JSON.stringify({ approved: true, summary: "结构完整。", issues: [] }),
    );
    ledger.executorReplies.push(
      JSON.stringify({
        patterns: ["电池材料误检"],
        adjustments: ["收紧 A 语义群"],
        recommendation: "修订",
      }),
      // The revised strategy: the piloted path's query must actually change.
      JSON.stringify({
        concepts: [
          { role: "A", entity: "llm", rationale: "r", terms: ["llm"] },
          { role: "B", entity: "series", rationale: "r", terms: ["\"time series\""] },
          { role: "C", entity: "forecast", rationale: "r", terms: ["forecasting"] },
        ],
        paths: [
          { id: "abc", combination: "A+B+C", target: "t", strategicIntent: "s", query: 'TITLE-ABS-KEY(llm AND "time series" AND forecasting)', actionGuide: "g", expectedResults: "e", reviewValue: "v" },
          { id: "ab", combination: "A+B", target: "t", strategicIntent: "s", query: 'TITLE-ABS-KEY(llm AND "time series")', actionGuide: "g", expectedResults: "e", reviewValue: "v" },
          { id: "bc", combination: "B+C", target: "t", strategicIntent: "s", query: 'TITLE-ABS-KEY("time series" AND forecasting)', actionGuide: "g", expectedResults: "e", reviewValue: "v" },
          { id: "ac", combination: "A+C", target: "t", strategicIntent: "s", query: "TITLE-ABS-KEY(llm AND forecasting)", actionGuide: "g", expectedResults: "e", reviewValue: "v" },
        ],
        exclusionAdvice: "",
        exclusionQuery: null,
      }),
    );

    render(<Workflows />);
    await user.click(await screen.findByRole("button", { name: "打开" }));
    await user.click(await screen.findByRole("button", { name: /分析 20 篇试检结果/ }));

    // A rejected round is persisted first, then automatically handed back to
    // the matrix stage with its false-positive evidence.
    await waitFor(() => expect(ledger.get(run.id).queryQualityIterations).toHaveLength(1));

    await waitFor(() => {
      expect(ledger.get(run.id).matrixStrategy?.paths[0].query).toContain("forecasting");
    });
    const iterationPrompt = ledger.turns.find((turn) => turn.prompt.includes("电池材料误检"));
    expect(iterationPrompt, "the revision prompt must carry the round's evidence").toBeTruthy();
    // The analysed round survives the optimisation that consumed it, so the
    // revision history has a "before" to diff against.
    const saved = ledger.get(run.id);
    expect(saved.queryQualityIterations).toHaveLength(1);
    expect(saved.queryQualityIterations[0].falsePositivePatterns).toContain("电池材料误检");
    // A revised strategy is not a confirmed one.
    expect(saved.matrixPlanApproved).toBe(false);
    expect(saved.activeStageId).toBe("matrix-strategy");
  });

  it("records a failed action on its stage instead of leaving it looking busy", async () => {
    const user = userEvent.setup();
    const run = pilotReadyRun(20);
    ledger.put(run);
    installed().literatureLoad.mockRejectedValue(new Error("literature store unavailable"));

    render(<Workflows />);
    await user.click(await screen.findByRole("button", { name: "打开" }));
    await user.click(await screen.findByRole("button", { name: /分析 20 篇试检结果/ }));

    await waitFor(() => {
      const stage = ledger.get(run.id).stages.find((item) => item.id === "query-quality-loop")!;
      expect(stage.summary).toContain("上一次操作失败");
    });
    // The failure is durable, so reopening the run still explains itself rather
    // than showing a stage that looks underway with no reason given.
    const saved = ledger.get(run.id);
    expect(saved.events.at(-1)?.action).toBe("stage_action_failed");
  });
});
