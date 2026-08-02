// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useProjectBrief } from "../ProjectBriefCard";

const apiMocks = vi.hoisted(() => ({
  configGet: vi.fn(() => Promise.resolve({ reviewEnabled: true })),
  configSet: vi.fn(),
  projectBriefGet: vi.fn(() => Promise.resolve({ mission: "Test mission", activity: null, goal: null })),
  projectBriefReview: vi.fn(() => Promise.resolve({ mission: "Test mission", activity: null, goal: null })),
}));

vi.mock("../../api/tauri", () => ({
  ...apiMocks,
  isTauri: () => true,
}));

function Harness() {
  const brief = useProjectBrief("default");
  return <div>{brief.brief?.mission ?? "loading"}</div>;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("useProjectBrief token-driven activity review", () => {
  it("does not run project activity reviews from wall-clock timers", async () => {
    vi.useFakeTimers();
    render(<Harness />);
    await act(async () => Promise.resolve());
    expect(apiMocks.projectBriefGet).toHaveBeenCalledWith("default");
    expect(apiMocks.projectBriefReview).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(60 * 60 * 1_000);
      await Promise.resolve();
    });
    expect(apiMocks.projectBriefReview).not.toHaveBeenCalled();
  });
});
