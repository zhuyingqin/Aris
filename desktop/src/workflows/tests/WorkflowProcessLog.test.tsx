// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { WorkflowProcessLog } from "../Workflows";
import type { ReviewWorkflowRun, ReviewWorkflowStage } from "../workflowTypes";

const stage = {
  id: "gap-analysis",
  ordinal: 5,
  title: "趋势与综述空白",
  description: "",
  status: "passed",
  reviewerGate: { required: true, status: "approved", issues: [] },
} as ReviewWorkflowStage;

const runWith = (activityLog: ReviewWorkflowRun["activityLog"]) => ({
  activityLog,
} as ReviewWorkflowRun);

afterEach(cleanup);

describe("WorkflowProcessLog", () => {
  it("replays a finished stage from the persisted transcript", () => {
    render(
      <WorkflowProcessLog
        stage={stage}
        run={runWith([
          {
            id: "wf-landscape-synthesis-1",
            stageId: "gap-analysis",
            actor: "Executor",
            title: "Executor 综合综述格局与候选方向",
            model: "MiniMax-M3",
            status: "completed",
            detail: JSON.stringify({
              developmentStatus: "已进入方法学深化阶段。",
              topicEvolution: ["从能不能用转向怎么用得更好"],
            }),
            startedAt: "2026-07-31T08:00:00Z",
            completedAt: "2026-07-31T08:01:00Z",
          },
          {
            id: "wf-landscape-review-1",
            stageId: "gap-analysis",
            actor: "Independent Reviewer",
            title: "Reviewer 审查综述方向与证据边界",
            status: "completed",
            detail: JSON.stringify({ approved: true, issues: ["证据标识体系不统一。"] }),
            startedAt: "2026-07-31T08:01:10Z",
            completedAt: "2026-07-31T08:02:00Z",
          },
          {
            id: "other-stage",
            stageId: "scope-and-plan",
            actor: "Executor",
            title: "Executor 生成检索计划",
            status: "completed",
            startedAt: "2026-07-31T07:00:00Z",
            completedAt: "2026-07-31T07:01:00Z",
          },
        ])}
        liveActivities={[]}
      />,
    );

    expect(screen.getByText("趋势与综述空白 · 2 步")).toBeTruthy();
    // Only this stage's calls, oldest first, so it reads as a transcript.
    const steps = document.querySelectorAll(".wf-process-log > ol > li");
    expect(steps).toHaveLength(2);
    expect(within(steps[0] as HTMLElement).getByText("Executor 综合综述格局与候选方向")).toBeTruthy();
    expect(within(steps[1] as HTMLElement).getByText("Reviewer 审查综述方向与证据边界")).toBeTruthy();

    // JSON is rendered as labelled content, with the raw answer still one click away.
    expect(screen.getByText("主题演变")).toBeTruthy();
    expect(screen.getByText("从能不能用转向怎么用得更好")).toBeTruthy();
    expect(screen.getByText("已进入方法学深化阶段。")).toBeTruthy();
    expect(document.querySelectorAll(".wf-activity-raw")).toHaveLength(2);
  });

  it("merges the in-flight call without doubling one already saved", () => {
    render(
      <WorkflowProcessLog
        stage={stage}
        run={runWith([{
          id: "saved-call",
          stageId: "gap-analysis",
          actor: "Executor",
          title: "Executor 分批分析综述格局",
          status: "completed",
          detail: "{}",
          startedAt: "2026-07-31T08:00:00Z",
          completedAt: "2026-07-31T08:01:00Z",
        }])}
        liveActivities={[
          {
            id: "saved-call",
            actor: "Executor",
            title: "Executor 分批分析综述格局",
            status: "completed",
            updatedAt: "2026-07-31T08:01:00Z",
          },
          {
            id: "running-call",
            actor: "Independent Reviewer",
            title: "Reviewer 审查综述方向与证据边界",
            phase: "推演中",
            status: "running",
            reasoning: "先确认命名变体是否齐全，再看排除项会不会误伤。",
            updatedAt: "2026-07-31T08:03:00Z",
          },
        ]}
      />,
    );

    const steps = document.querySelectorAll(".wf-process-log > ol > li");
    expect(steps).toHaveLength(2);
    expect(screen.getByText("推演中")).toBeTruthy();
    // Reasoning streams under a "正在思考" label, in prose rather than monospace,
    // and is never sliced — the box scrolls to the newest line instead.
    expect(screen.getByText("正在思考")).toBeTruthy();
    const tail = document.querySelector(".wf-process-stream-body")!;
    expect(tail.className).not.toContain("mono");
    expect(tail.textContent).toBe("先确认命名变体是否齐全，再看排除项会不会误伤。");
  });

  it("switches the tail from reasoning to the answer once generation starts", () => {
    render(
      <WorkflowProcessLog
        stage={stage}
        run={runWith([])}
        liveActivities={[{
          id: "running-call",
          actor: "Executor",
          title: "Executor 生成检索计划",
          phase: "生成中",
          status: "running",
          reasoning: "先确认命名变体是否齐全。",
          detail: '{"queries":[{"source":"scopus"',
          updatedAt: "2026-07-31T08:03:00Z",
        }]}
      />,
    );

    expect(screen.getByText("正在生成")).toBeTruthy();
    expect(screen.queryByText("正在思考")).toBeNull();
    const tail = document.querySelector(".wf-process-stream-body")!;
    expect(tail.className).toContain("mono");
    expect(tail.textContent).toContain('"queries"');
  });

  it("carries search steps in the same thread as the model calls", () => {
    render(
      <WorkflowProcessLog
        stage={{ ...stage, id: "review-landscape-search" }}
        run={runWith([{
          id: "search:run-1:scopus",
          stageId: "review-landscape-search",
          actor: "Search",
          title: "scopus · 完成",
          status: "completed",
          detail: "查询：TITLE-ABS-KEY((reservoir))\n命中：412",
          startedAt: "2026-07-31T08:10:00Z",
          completedAt: "2026-07-31T08:10:30Z",
        }])}
        liveActivities={[]}
      />,
    );

    const step = document.querySelector(".wf-process-log > ol > li")!;
    expect(step.className).toContain("search");
    // Search output is plain text, so it never goes through the JSON view.
    expect(step.querySelector(".wf-process-text")).toBeTruthy();
    expect(step.querySelector(".wf-activity-raw")).toBeNull();
  });

  it("says a stage has no record instead of rendering an empty box", () => {
    render(<WorkflowProcessLog stage={stage} run={runWith([])} liveActivities={[]} />);
    expect(screen.getByText(/该阶段还没有运行记录/)).toBeTruthy();
  });
});
