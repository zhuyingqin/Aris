// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IndependentReviewResult } from "../../api/tauri";
import IndependentReviewPanel from "../IndependentReviewPanel";
import type { IndependentReviewState } from "../useIndependentReview";

afterEach(cleanup);

function reviewResult(overrides: Partial<IndependentReviewResult> = {}): IndependentReviewResult {
  return {
    verdict: "pass",
    summary: "Checked.",
    issues: [],
    evidenceChecked: [],
    missingChecks: [],
    revisionInstructions: [],
    relevantToGoal: true,
    progressDelta: null,
    criteriaSatisfied: [],
    reviewerProvider: "openai",
    reviewerModel: "gpt-reviewer",
    executorProvider: "minimax",
    executorModel: "MiniMax-M3",
    independent: true,
    exhausted: false,
    ...overrides,
  };
}

function reviewState(...results: IndependentReviewResult[]): IndependentReviewState {
  return {
    sessionId: "chat-review",
    phase: "complete",
    attempt: results.length,
    revision: 0,
    maxRevisions: 2,
    updatedAt: 1,
    rounds: results.map((result, index) => ({ attempt: index + 1, result })),
  };
}

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

  describe("tool checks", () => {
    it("lists what the Reviewer opened with its own tools, between the evidence it claims and the checks it missed", () => {
      render(<IndependentReviewPanel language="cn" state={reviewState(reviewResult({
        evidenceChecked: ["desktop diff"],
        toolChecks: ["read_file src/a.rs", 'grep_search "todo"'],
        missingChecks: ["cargo check"],
      }))} />);

      const heading = screen.getByRole("heading", { name: "Reviewer 工具调用" });
      const calls = within(heading.parentElement!).getAllByRole("listitem").map((item) => item.textContent);
      expect(calls).toEqual(["read_file src/a.rs", 'grep_search "todo"']);
      const claimed = screen.getByRole("heading", { name: "已核查证据" });
      const missed = screen.getByRole("heading", { name: "缺失检查" });
      expect(claimed.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(heading.compareDocumentPosition(missed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it.each([
      ["a one-shot review, which has no tools and no record of them", undefined],
      ["a thread round that made no calls", []],
    ])("has no section for %s", (_case, toolChecks) => {
      render(<IndependentReviewPanel language="cn" state={reviewState(reviewResult({
        evidenceChecked: ["desktop diff"],
        toolChecks,
      }))} />);

      expect(screen.getByRole("heading", { name: "已核查证据" })).toBeTruthy();
      expect(screen.queryByText("Reviewer 工具调用")).toBeNull();
    });

    it("keeps each round's own record, in English, and nothing for a round without one", () => {
      const { container } = render(<IndependentReviewPanel language="en" state={reviewState(
        reviewResult({ verdict: "revise", toolChecks: ["read_file first.rs"] }),
        reviewResult({ verdict: "revise" }),
        reviewResult({ toolChecks: ["glob_search **/*.rs"] }),
      )} />);

      const rounds = [...container.querySelectorAll("details")];
      expect(rounds).toHaveLength(3);
      expect(rounds.map((round) => within(round).queryAllByText("Reviewer tool calls").length)).toEqual([1, 0, 1]);
      expect(within(rounds[0]).getByText("read_file first.rs")).toBeTruthy();
      expect(within(rounds[2]).getByText("glob_search **/*.rs")).toBeTruthy();
      expect(within(rounds[2]).queryByText("read_file first.rs")).toBeNull();
    });

    it("keeps every repeat of the same call without a duplicate-key warning", () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        render(<IndependentReviewPanel language="cn" state={reviewState(reviewResult({
          toolChecks: ["read_file src/a.rs", 'grep_search "x"', "read_file src/a.rs"],
        }))} />);

        expect(screen.getAllByText("read_file src/a.rs")).toHaveLength(2);
        expect(errors.mock.calls.flat().join(" ")).not.toMatch(/same key/i);
      } finally {
        errors.mockRestore();
      }
    });
  });
});
