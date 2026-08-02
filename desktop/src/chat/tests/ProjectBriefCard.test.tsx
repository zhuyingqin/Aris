// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProjectBriefCard from "../ProjectBriefCard";

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
});
