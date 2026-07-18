// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  chatEventsRead: vi.fn(),
  onChatReview: vi.fn(),
}));

vi.mock("../../api/tauri", () => ({
  isTauri: () => true,
  chatEventsRead: mocks.chatEventsRead,
  onChatReview: mocks.onChatReview,
}));

import { useIndependentReview } from "../useIndependentReview";

const result = {
  verdict: "revise" as const,
  summary: "Integration coverage is missing.",
  issues: [],
  evidenceChecked: ["unit tests"],
  missingChecks: ["integration tests"],
  revisionInstructions: ["run integration tests"],
  relevantToGoal: true,
  progressDelta: null,
  criteriaSatisfied: [],
  reviewerProvider: "minimax",
  reviewerModel: "MiniMax-M3",
  executorProvider: "openai",
  executorModel: "gpt-5.6-sol",
  independent: true,
  exhausted: false,
};

beforeEach(() => {
  mocks.chatEventsRead.mockResolvedValue([]);
  mocks.onChatReview.mockReturnValue(Promise.resolve(() => undefined));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useIndependentReview", () => {
  it("keeps independently emitted rounds separate from the Executor transcript", async () => {
    let handler: ((event: Record<string, unknown>) => void) | null = null;
    mocks.onChatReview.mockImplementation((next) => {
      handler = next;
      return Promise.resolve(() => undefined);
    });
    const { result: hook } = renderHook(() => useIndependentReview("session-a"));

    act(() => {
      handler?.({
        sessionId: "session-a",
        phase: "result",
        attempt: 1,
        revision: 0,
        maxRevisions: 2,
        result,
      });
    });

    await waitFor(() => expect(hook.current?.rounds).toHaveLength(1));
    expect(hook.current).toMatchObject({
      sessionId: "session-a",
      phase: "result",
      attempt: 1,
      maxRevisions: 2,
    });
    expect(hook.current?.rounds[0].result.reviewerModel).toBe("MiniMax-M3");

    act(() => {
      handler?.({
        sessionId: "session-a",
        phase: "result",
        attempt: 2,
        revision: 0,
        maxRevisions: 2,
        result: { ...result, summary: "A later finding." },
      });
    });

    await waitFor(() => expect(hook.current?.rounds).toHaveLength(2));
    expect(hook.current?.rounds.map((round) => round.attempt)).toEqual([1, 2]);

    act(() => {
      handler?.({
        sessionId: "session-a",
        phase: "cleared",
        attempt: 0,
        revision: 0,
        maxRevisions: 2,
      });
    });

    await waitFor(() => expect(hook.current).toBeNull());
  });

  it("restores the durable independent review when a chat is reopened", async () => {
    mocks.chatEventsRead.mockResolvedValue([
      {
        kind: "independent_review",
        payload: {
          sessionId: "session-restored",
          phase: "complete",
          attempt: 1,
          maxRevisions: 2,
          result: { ...result, verdict: "pass", summary: "Verified." },
        },
      },
    ]);
    const { result: hook } = renderHook(() => useIndependentReview("session-restored"));

    await waitFor(() => expect(hook.current?.phase).toBe("complete"));
    expect(hook.current?.rounds[0].result).toMatchObject({
      verdict: "pass",
      summary: "Verified.",
      independent: true,
    });
  });

  it("merges restored history with a live round that arrives while the log is loading", async () => {
    let handler: ((event: Record<string, unknown>) => void) | null = null;
    let resolveEvents: ((events: Array<{ kind: string; payload: unknown }>) => void) | null = null;
    mocks.onChatReview.mockImplementation((next) => {
      handler = next;
      return Promise.resolve(() => undefined);
    });
    mocks.chatEventsRead.mockReturnValue(new Promise((resolve) => {
      resolveEvents = resolve;
    }));
    const { result: hook } = renderHook(() => useIndependentReview("session-race"));

    act(() => {
      handler?.({
        sessionId: "session-race",
        phase: "result",
        attempt: 2,
        revision: 0,
        maxRevisions: 2,
        result: { ...result, summary: "Live round." },
      });
    });
    act(() => {
      resolveEvents?.([{
        kind: "independent_review",
        payload: {
          sessionId: "session-race",
          phase: "result",
          attempt: 1,
          revision: 0,
          maxRevisions: 2,
          result: { ...result, summary: "Restored round." },
        },
      }]);
    });

    await waitFor(() => expect(hook.current?.rounds).toHaveLength(2));
    expect(hook.current?.rounds.map((round) => round.attempt)).toEqual([1, 2]);
    expect(hook.current?.attempt).toBe(2);
  });

  it("migrates legacy rounds whose attempt number restarted at one", async () => {
    const reviewEvent = (phase: "reviewing" | "result" | "complete", summary: string) => ({
      kind: "independent_review",
      payload: {
        sessionId: "session-legacy",
        phase,
        attempt: 1,
        maxRevisions: 2,
        result: phase === "reviewing" ? null : { ...result, summary },
      },
    });
    mocks.chatEventsRead.mockResolvedValue([
      reviewEvent("reviewing", ""),
      reviewEvent("result", "First legacy review."),
      reviewEvent("complete", "First legacy review."),
      reviewEvent("reviewing", ""),
      reviewEvent("result", "Second legacy review."),
      reviewEvent("complete", "Second legacy review."),
    ]);

    const { result: hook } = renderHook(() => useIndependentReview("session-legacy"));

    await waitFor(() => expect(hook.current?.rounds).toHaveLength(2));
    expect(hook.current?.rounds.map((round) => round.attempt)).toEqual([1, 2]);
    expect(hook.current?.rounds[1].result.summary).toBe("Second legacy review.");
  });
});
