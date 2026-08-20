// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProjectBriefCard from "../ProjectBriefCard";

vi.mock("../ChatImagePreview", () => ({
  default: ({ title }: { title?: string }) => <button type="button">{title}</button>,
}));

const brief = {
  mission: "Build durable research continuity.",
  activity: {
    coreFocus: "Review every project conversation and keep the summary current.",
    relatedWork: ["Refresh only after dialogue changes"],
    conversationCount: 4,
    messageCount: 26,
    questionCount: 13,
    reviewer: "openai / gpt-reviewer",
    sourceFingerprint: "sha256:test",
    reviewedAt: "2026-07-11T00:02:00Z",
  },
  intent: {
    objective: "Build a local-first research workspace with durable continuity.",
    confidence: 78,
    status: "emerging" as const,
    evidenceCount: 2,
    createdAt: "2026-07-11T00:00:00Z",
    updatedAt: "2026-07-11T00:01:00Z",
  },
  goal: {
    objective: "Persist project goals across conversations",
    successCriteria: ["A new chat loads the goal", "Focused tests pass"],
    verifiedCriteria: [{
      criterionIndex: 0,
      evidence: ["Focused continuity test passed"],
      reviewer: "openai / gpt-reviewer",
      verifiedAt: "2026-07-11T00:00:30Z",
    }],
    recentStatus: "Goal persistence is implemented.",
    status: "active" as const,
    createdAt: "2026-07-11T00:00:00Z",
    updatedAt: "2026-07-11T00:01:00Z",
  },
};

afterEach(cleanup);

describe("ProjectBriefCard", () => {
  it("shows the repository branch and compact working-tree status", () => {
    render(
      <ProjectBriefCard
        brief={brief}
        repository={{
          gitAvailable: true,
          isRepository: true,
          workspacePath: "C:\\workspace",
          repositoryRoot: "C:\\workspace",
          branch: "feature/summary",
          detached: false,
          upstream: "origin/feature/summary",
          ahead: 2,
          behind: 1,
          files: [
            { path: "src/App.tsx", indexStatus: " ", worktreeStatus: "M", staged: false, unstaged: true, untracked: false, conflicted: false },
          ],
          branches: [],
          hasConflicts: false,
        }}
        language="cn"
        onHide={vi.fn()}
        reviewEnabled
        onReviewEnabledChange={vi.fn()}
      />,
    );

    expect(screen.getByText("版本状态")).toBeTruthy();
    expect(screen.getByText("feature/summary")).toBeTruthy();
    expect(screen.getByText("origin/feature/summary")).toBeTruthy();
    expect(screen.getByText("↑2 ↓1")).toBeTruthy();
    expect(screen.getByText("1 项变更")).toBeTruthy();
  });

  it("shows mission, long-term intent, milestone, and recent progress", () => {
    render(
      <ProjectBriefCard
        brief={brief}
        language="cn"
        onHide={vi.fn()}
        reviewEnabled
        onReviewEnabledChange={vi.fn()}
      />,
    );

    expect(screen.getByText("Build durable research continuity.")).toBeTruthy();
    expect(screen.getByText("Review every project conversation and keep the summary current.")).toBeTruthy();
    expect(screen.getByText("Refresh only after dialogue changes")).toBeTruthy();
    expect(screen.getByText("Reviewer 按上下文 Token 增量复核 · 已覆盖 4 个对话、13 次提问，共 26 条可见消息")).toBeTruthy();
    expect(screen.getByText("Build a local-first research workspace with durable continuity.")).toBeTruthy();
    expect(screen.getByText("Persist project goals across conversations")).toBeTruthy();
    expect(screen.getByText("A new chat loads the goal")).toBeTruthy();
    expect(screen.getByText("Focused tests pass")).toBeTruthy();
    expect(screen.getByText("Goal persistence is implemented.")).toBeTruthy();
  });

  it("supports retracting the floating summary from its right-side control", () => {
    const onHide = vi.fn();
    render(
      <ProjectBriefCard
        brief={brief}
        language="cn"
        onHide={onHide}
        reviewEnabled
        onReviewEnabledChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByLabelText("收回项目摘要"));
    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it("lets the user disable automatic review from the project summary", () => {
    const onReviewEnabledChange = vi.fn();
    render(
      <ProjectBriefCard
        brief={brief}
        language="cn"
        onHide={vi.fn()}
        reviewEnabled
        onReviewEnabledChange={onReviewEnabledChange}
      />,
    );

    const toggle = screen.getByRole("switch", { name: "切换自动审核" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(onReviewEnabledChange).toHaveBeenCalledWith(false);
  });

  it("keeps image-assist progress and returned images inside the project summary", () => {
    const onDismissImageAssistActivity = vi.fn();
    render(
      <ProjectBriefCard
        brief={brief}
        language="cn"
        onHide={vi.fn()}
        reviewEnabled
        onReviewEnabledChange={vi.fn()}
        imageAssistActivity={{
          matchId: "6f0f9b52-4a4d-4e77-9f1f-2c9a8b7d6e5f",
          stage: "completed",
          detail: "已接收 1 张图片",
          prompt: "a wind turbine at dusk",
          aspectRatio: "16:9",
          images: ["C:/project/.somniq/artifacts/image-assist/test.png"],
        }}
        onDismissImageAssistActivity={onDismissImageAssistActivity}
      />,
    );

    expect(screen.getByLabelText("图片互助")).toBeTruthy();
    expect(screen.getByText("图片已传回")).toBeTruthy();
    expect(screen.getByText("a wind turbine at dusk")).toBeTruthy();
    expect(screen.getByText("比例 16:9")).toBeTruthy();
    expect(screen.getByText("打开 test.png")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("关闭图片互助记录"));
    expect(onDismissImageAssistActivity).toHaveBeenCalledTimes(1);
  });
});
