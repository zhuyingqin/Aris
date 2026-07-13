// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProjectBriefCard from "../ProjectBriefCard";

const brief = {
  mission: "Build durable research continuity.",
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
      />,
    );

    expect(screen.getByText("Build durable research continuity.")).toBeTruthy();
    expect(screen.getByText("Build a local-first research workspace with durable continuity.")).toBeTruthy();
    expect(screen.getByText("Persist project goals across conversations")).toBeTruthy();
    expect(screen.getByText("Goal persistence is implemented.")).toBeTruthy();
  });

  it("supports retracting the floating summary from its right-side control", () => {
    const onHide = vi.fn();
    render(
      <ProjectBriefCard
        brief={brief}
        language="cn"
        onHide={onHide}
      />,
    );

    fireEvent.click(screen.getByLabelText("收回项目摘要"));
    expect(onHide).toHaveBeenCalledTimes(1);
  });
});
