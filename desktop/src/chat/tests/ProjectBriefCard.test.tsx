// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProjectBriefCard from "../ProjectBriefCard";

const brief = {
  mission: "Build durable research continuity.",
  goal: {
    objective: "Persist project goals across conversations",
    successCriteria: ["A new chat loads the goal", "Focused tests pass"],
    recentStatus: "Goal persistence is implemented.",
    status: "active" as const,
    createdAt: "2026-07-11T00:00:00Z",
    updatedAt: "2026-07-11T00:01:00Z",
  },
};

afterEach(cleanup);

describe("ProjectBriefCard", () => {
  it("shows mission, goal, success criteria, and recent status", () => {
    render(
      <ProjectBriefCard
        brief={brief}
        language="cn"
        collapsed={false}
        onCollapsedChange={vi.fn()}
        onHide={vi.fn()}
      />,
    );

    expect(screen.getByText("Build durable research continuity.")).toBeTruthy();
    expect(screen.getByText("Persist project goals across conversations")).toBeTruthy();
    expect(screen.getByText("A new chat loads the goal")).toBeTruthy();
    expect(screen.getByText("Goal persistence is implemented.")).toBeTruthy();
  });

  it("supports collapse and full hide controls", () => {
    const onCollapsedChange = vi.fn();
    const onHide = vi.fn();
    render(
      <ProjectBriefCard
        brief={brief}
        language="cn"
        collapsed={false}
        onCollapsedChange={onCollapsedChange}
        onHide={onHide}
      />,
    );

    fireEvent.click(screen.getByTitle("折叠项目摘要"));
    expect(onCollapsedChange).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByLabelText("隐藏项目摘要"));
    expect(onHide).toHaveBeenCalledTimes(1);
  });
});
