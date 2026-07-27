// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import IndependentReviewPanel from "../IndependentReviewPanel";
import type { IndependentReviewState } from "../useIndependentReview";

afterEach(cleanup);

describe("IndependentReviewPanel", () => {
  it("shows distinct identities, verdict, findings, and missing checks", () => {
    const state: IndependentReviewState = {
      sessionId: "chat-review",
      phase: "complete",
      attempt: 1,
      revision: 0,
      maxRevisions: 2,
      updatedAt: 1,
      rounds: [{
        attempt: 1,
        result: {
          verdict: "revise",
          summary: "The agent path was not checked.",
          issues: [{
            severity: "high",
            title: "Missing agent path",
            detail: "Only the desktop path changed.",
            evidence: "Git diff",
            recommendation: "Inspect the shared agent path.",
          }],
          evidenceChecked: ["desktop diff"],
          missingChecks: ["cargo check"],
          revisionInstructions: ["inspect the agent path"],
          relevantToGoal: true,
          progressDelta: null,
          criteriaSatisfied: [],
          reviewerProvider: "openai",
          reviewerModel: "gpt-reviewer",
          executorProvider: "minimax",
          executorModel: "MiniMax-M3",
          independent: true,
          exhausted: false,
        },
      }],
    };

    const onClear = vi.fn();
    render(<IndependentReviewPanel state={state} language="cn" onClear={onClear} />);

    expect(screen.getByText("minimax / MiniMax-M3")).toBeTruthy();
    expect(screen.getByText("openai / gpt-reviewer")).toBeTruthy();
    expect(screen.getAllByText("需要修订").length).toBeGreaterThan(0);
    expect(screen.getByText("Missing agent path")).toBeTruthy();
    expect(screen.getByText("cargo check")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "清除审查记录" }));
    expect(onClear).toHaveBeenCalledOnce();
  });
});
