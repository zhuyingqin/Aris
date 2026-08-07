import { describe, expect, it } from "vitest";

import { buildWorkflowChatHandoff } from "../workflowChatHandoff";
import type { ReviewWorkflowRun } from "../workflowTypes";

function workflowRun(): ReviewWorkflowRun {
  return {
    id: "review-1",
    sessionId: "wf-review-1",
    title: "综述：Research agents",
    topic: "Research agents",
    status: "running",
    activeStageId: "scope-and-plan",
    executorModel: "MiniMax-M3",
    reviewerDisabled: false,
    stages: [
      {
        id: "scope-and-plan",
        ordinal: 1,
        title: "范围与计划",
        description: "",
        status: "in_progress",
        reviewerGate: { required: true, status: "reviewing", issues: [] },
      },
      {
        id: "review-landscape-search",
        ordinal: 2,
        title: "综述格局检索",
        description: "",
        status: "not_started",
        reviewerGate: { required: true, status: "pending", issues: [] },
      },
    ],
    activityLog: [],
    events: [],
    artifacts: [],
    reviewEligibility: {
      candidateRecordIds: [],
      eligibleRecordIds: [],
      excludedRecordIds: [],
      missingAbstractRecordIds: [],
      complete: false,
      method: "",
    },
    reviewCountBranch: "unknown",
  } as unknown as ReviewWorkflowRun;
}

describe("workflow Chat handoff", () => {
  it("uses the ledger-owned session without injecting synthetic cards or a snapshot", () => {
    const run = workflowRun();

    const opened = buildWorkflowChatHandoff("project-1", run);

    expect(opened.sessionId).toBe("wf-review-1");
    expect(opened.workflowRunId).toBe("review-1");
    expect(opened.activate).toBe(true);
    expect(opened.draft).toBe("请指出当前阶段的主要风险和最小可执行下一步。");
    expect(opened.draft).not.toContain("Workflow ID");
    expect(opened.input).toBe("");
    expect(opened.projectedTurns).toBeUndefined();
    expect(opened.projectedTurnIds).toBeUndefined();
  });
});
