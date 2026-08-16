// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  chatSend: vi.fn(),
  chatCancel: vi.fn(),
  onChatDelta: vi.fn(),
  onChatThinkingDelta: vi.fn(),
  onChatTool: vi.fn(),
  onChatToolProgress: vi.fn(),
  onChatToolResult: vi.fn(),
  onChatModelRetry: vi.fn(),
  onChatPermissionRequest: vi.fn(),
  onChatPermissionResolved: vi.fn(),
  onChatReview: vi.fn(),
  onChatDone: vi.fn(),
  onChatError: vi.fn(),
  onChatContextCompacted: vi.fn(),
  onChatContextWarning: vi.fn(),
}));

vi.mock("../../api/tauri", () => ({
  isTauri: () => true,
  chatSend: mocks.chatSend,
  chatCancel: mocks.chatCancel,
  onChatDelta: mocks.onChatDelta,
  onChatThinkingDelta: mocks.onChatThinkingDelta,
  onChatTool: mocks.onChatTool,
  onChatToolProgress: mocks.onChatToolProgress,
  onChatToolResult: mocks.onChatToolResult,
  onChatModelRetry: mocks.onChatModelRetry,
  onChatPermissionRequest: mocks.onChatPermissionRequest,
  onChatPermissionResolved: mocks.onChatPermissionResolved,
  onChatReview: mocks.onChatReview,
  onChatDone: mocks.onChatDone,
  onChatError: mocks.onChatError,
  onChatContextCompacted: mocks.onChatContextCompacted,
  onChatContextWarning: mocks.onChatContextWarning,
}));

import { appendToolOutput, updateToolProgress, upsertToolCall, useChatStream } from "../useChatStream";

const listenerMocks = [
  mocks.onChatDelta,
  mocks.onChatThinkingDelta,
  mocks.onChatTool,
  mocks.onChatToolProgress,
  mocks.onChatToolResult,
  mocks.onChatModelRetry,
  mocks.onChatPermissionRequest,
  mocks.onChatPermissionResolved,
  mocks.onChatReview,
  mocks.onChatDone,
  mocks.onChatError,
  mocks.onChatContextCompacted,
  mocks.onChatContextWarning,
];

beforeEach(() => {
  // Every listener must return a thenable: the hook's cleanup calls
  // `.then()` on each subscription handle. Individual tests override with
  // mockImplementation where they need to capture handlers.
  for (const listener of listenerMocks) {
    listener.mockReturnValue(Promise.resolve(() => undefined));
  }
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useChatStream tool block helpers", () => {
  it("matches tool results by call id before tool name", () => {
    const blocks = [
      { kind: "tool" as const, id: "first", name: "read_file", input: "{}" },
      { kind: "tool" as const, id: "second", name: "read_file", input: "{}" },
    ];

    const next = appendToolOutput(blocks, "first", "read_file", "first output", false);

    expect(next[0]).toMatchObject({ id: "first", output: "first output" });
    expect(next[1]).not.toHaveProperty("output");
  });

  it("falls back to the latest matching tool name when a result id is stale", () => {
    const blocks = [
      { kind: "tool" as const, id: "first", name: "read_file", input: "{}" },
      { kind: "tool" as const, id: "second", name: "read_file", input: "{}" },
    ];

    const next = appendToolOutput(blocks, "missing", "read_file", "latest output", false);

    expect(next[0]).not.toHaveProperty("output");
    expect(next[1]).toMatchObject({ id: "second", output: "latest output" });
  });

  it("creates a fallback tool card when a result arrives without its call event", () => {
    const next = appendToolOutput([], "tool-1", "read_file", "late output", true);

    expect(next).toEqual([{
      kind: "tool",
      id: "tool-1",
      name: "read_file",
      input: "{}",
      output: "late output",
      isError: true,
    }]);
  });

  it("does not duplicate repeated tool results after output is attached", () => {
    const blocks = [
      { kind: "tool" as const, id: "tool-1", name: "read_file", input: "{}", output: "first output" },
    ];

    const next = appendToolOutput(blocks, "tool-1", "read_file", "first output", false);

    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ id: "tool-1", output: "first output" });
  });

  it("updates an existing tool card when the same tool call is emitted again", () => {
    const blocks = [
      { kind: "tool" as const, id: "ask-1", name: "AskUserQuestion", input: "{\"question\":\"Old?\"}" },
    ];

    const next = upsertToolCall(blocks, {
      id: "ask-1",
      name: "AskUserQuestion",
      input: "{\"question\":\"New?\",\"options\":[{\"label\":\"Yes\"}]}",
    });

    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      id: "ask-1",
      name: "AskUserQuestion",
      input: "{\"question\":\"New?\",\"options\":[{\"label\":\"Yes\"}]}",
    });
  });
});

describe("useChatStream concurrent sessions", () => {
  it("shows a bounded model retry while the response remains streaming", () => {
    let retryHandler: ((event: {
      sessionId: string;
      action: "retrying" | "adjusting";
      phase: "send" | "stream" | "stream_restart" | "request";
      attempt?: number | null;
      maxAttempts?: number | null;
      retriesRemaining?: number | null;
      backoffMs?: number | null;
    }) => void) | null = null;
    mocks.onChatModelRetry.mockImplementation((handler) => {
      retryHandler = handler;
      return Promise.resolve(() => undefined);
    });

    let turn = { id: "assistant", role: "assistant" as const, blocks: [], streaming: true };
    const patchAssistant = vi.fn((_sessionId: string, patch) => {
      turn = patch(turn);
    });
    renderHook(() => useChatStream({ patchAssistant, onComplete: vi.fn(), onError: vi.fn() }));

    act(() => {
      retryHandler?.({
        sessionId: "chat-retry",
        action: "retrying",
        phase: "send",
        attempt: 1,
        maxAttempts: 4,
        backoffMs: 1_000,
      });
    });

    expect(turn.streaming).toBe(true);
    expect(turn.blocks).toContainEqual({
      kind: "notice",
      message: "The model connection is temporarily unstable; retrying (2/4, continuing in about 1s).",
    });
  });

  it("keeps the Executor draft stable while a revision streams, then swaps it atomically", () => {
    let reviewHandler:
      | ((event: {
        sessionId: string;
        phase: "reviewing" | "result" | "revising" | "complete" | "cleared";
        attempt: number;
        revision?: number;
        maxRevisions: number;
        reviewerProvider?: string;
        reviewerModel?: string;
        result?: null;
      }) => void)
      | null = null;
    let deltaHandler: ((event: { sessionId: string; text: string }) => void) | null = null;
    mocks.onChatReview.mockImplementation((handler) => {
      reviewHandler = handler;
      return Promise.resolve(() => undefined);
    });
    mocks.onChatDelta.mockImplementation((handler) => {
      deltaHandler = handler;
      return Promise.resolve(() => undefined);
    });

    let turn = {
      id: "assistant",
      role: "assistant" as const,
      streaming: true,
      blocks: [
        { kind: "thinking" as const, text: "self-confirming assumption" },
        { kind: "text" as const, text: "Everything is fixed." },
        { kind: "tool" as const, id: "tool-1", name: "bash", input: "{}", output: "unit tests passed" },
      ],
    };
    const patchAssistant = vi.fn((_sessionId: string, patch) => {
      turn = patch(turn);
    });
    renderHook(() => useChatStream({
      patchAssistant,
      onComplete: vi.fn(),
      onError: vi.fn(),
    }));

    act(() => {
      reviewHandler?.({
        sessionId: "chat-review",
        phase: "reviewing",
        attempt: 1,
        maxRevisions: 2,
        reviewerProvider: "openai",
        reviewerModel: "gpt-5-reviewer",
        result: null,
      });
    });

    expect(turn.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "review",
        phase: "reviewing",
        reviewerProvider: "openai",
        reviewerModel: "gpt-5-reviewer",
      }),
    ]));

    act(() => {
      reviewHandler?.({
        sessionId: "chat-review",
        phase: "revising",
        attempt: 1,
        revision: 1,
        maxRevisions: 2,
        result: null,
      });
    });

    expect(turn.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "text", text: "Everything is fixed." }),
    ]));
    expect(turn.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "tool", id: "tool-1" }),
      expect.objectContaining({
        kind: "review",
        phase: "revising",
        attempt: 1,
      }),
    ]));
    expect((turn.blocks as Array<{ kind: string }>).filter((block) => block.kind === "review")).toHaveLength(1);

    act(() => {
      deltaHandler?.({ sessionId: "chat-review", text: "The verified fix includes integration tests." });
    });

    // The replacement is buffered: the visible answer never disappears and
    // does not replay token-by-token underneath the Reviewer badge.
    expect(turn.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "text", text: "Everything is fixed." }),
    ]));
    expect(turn.blocks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "text", text: "The verified fix includes integration tests." }),
    ]));

    act(() => {
      reviewHandler?.({
        sessionId: "chat-review",
        phase: "reviewing",
        attempt: 2,
        maxRevisions: 2,
        reviewerProvider: "openai",
        reviewerModel: "gpt-5-reviewer",
        result: null,
      });
    });

    expect(turn.blocks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "text", text: "Everything is fixed." }),
    ]));
    expect(turn.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "text", text: "The verified fix includes integration tests." }),
      expect.objectContaining({ kind: "review", phase: "reviewing", attempt: 2 }),
    ]));
    expect((turn.blocks as Array<{ kind: string }>).filter((block) => block.kind === "review")).toHaveLength(1);

    act(() => {
      reviewHandler?.({
        sessionId: "chat-review",
        phase: "cleared",
        attempt: 0,
        revision: 0,
        maxRevisions: 2,
        result: null,
      });
    });

    expect((turn.blocks as Array<{ kind: string }>).filter((block) => block.kind === "review")).toHaveLength(0);
  });

  it("updates progress on the matching running tool block", () => {
    const blocks = updateToolProgress([
      { kind: "tool", id: "older", name: "bash", input: "{}", output: "done" },
      { kind: "tool", id: "run-1", name: "bash", input: "{}" },
    ], {
      id: "run-1",
      name: "bash",
      elapsedMs: 1_500,
      timeoutMs: 10_000,
      pid: 42,
      stdoutTail: "halfway",
      nearTimeout: false,
      message: "Still running",
    });

    expect(blocks[0]).not.toHaveProperty("progress");
    expect(blocks[1]).toMatchObject({
      progress: {
        elapsedMs: 1_500,
        timeoutMs: 10_000,
        pid: 42,
        stdoutTail: "halfway",
        nearTimeout: false,
      },
    });
  });

  it("keeps one Tauri subscription and uses latest callbacks after rerender", () => {
    const deltaHandlers: Array<(event: { sessionId: string; text: string }) => void> = [];
    const doneHandlers: Array<(event: { sessionId: string; text: string }) => void> = [];
    mocks.onChatDelta.mockImplementation((handler) => {
      deltaHandlers.push(handler);
      return new Promise<() => void>(() => undefined);
    });
    mocks.onChatDone.mockImplementation((handler) => {
      doneHandlers.push(handler);
      return new Promise<() => void>(() => undefined);
    });
    for (const listener of [
      mocks.onChatThinkingDelta,
      mocks.onChatTool,
      mocks.onChatToolResult,
      mocks.onChatPermissionRequest,
      mocks.onChatPermissionResolved,
    ]) {
      listener.mockReturnValue(new Promise<() => void>(() => undefined));
    }

    const firstPatchAssistant = vi.fn((_sessionId: string, patch) => {
      patch({ id: "assistant", role: "assistant", blocks: [], streaming: true });
    });
    const secondPatchAssistant = vi.fn((_sessionId: string, patch) => {
      patch({ id: "assistant", role: "assistant", blocks: [], streaming: true });
    });

    const { rerender } = renderHook(
      ({ patchAssistant }) => useChatStream({
        patchAssistant,
        onComplete: vi.fn(),
        onError: vi.fn(),
      }),
      { initialProps: { patchAssistant: firstPatchAssistant } },
    );
    rerender({ patchAssistant: secondPatchAssistant });

    act(() => {
      for (const handler of deltaHandlers) {
        handler({ sessionId: "chat-a", text: "duplicated delta" });
      }
      for (const handler of doneHandlers) {
        handler({ sessionId: "chat-a", text: "" });
      }
    });

    expect(deltaHandlers).toHaveLength(1);
    expect(doneHandlers).toHaveLength(1);
    expect(firstPatchAssistant).not.toHaveBeenCalled();
    expect(secondPatchAssistant).toHaveBeenCalledTimes(1);
  });

  it("runs five sessions concurrently and routes deltas by session id", async () => {
    let deltaHandler: ((event: { sessionId: string; text: string }) => void) | null = null;
    let doneHandler: ((event: { sessionId: string; text: string }) => void) | null = null;
    mocks.onChatDelta.mockImplementation((handler) => {
      deltaHandler = handler;
      return Promise.resolve(() => undefined);
    });
    mocks.onChatDone.mockImplementation((handler) => {
      doneHandler = handler;
      return Promise.resolve(() => undefined);
    });
    for (const listener of [
      mocks.onChatThinkingDelta,
      mocks.onChatTool,
      mocks.onChatToolResult,
      mocks.onChatPermissionRequest,
      mocks.onChatPermissionResolved,
    ]) {
      listener.mockReturnValue(Promise.resolve(() => undefined));
    }

    const resolvers = new Map<string, (reply: string) => void>();
    mocks.chatSend.mockImplementation(
      (sessionId: string) => new Promise<string>((resolve) => resolvers.set(sessionId, resolve)),
    );
    const routed: string[] = [];
    const patchAssistant = vi.fn((sessionId: string, patch) => {
      routed.push(sessionId);
      patch({ id: "assistant", role: "assistant", blocks: [], streaming: true });
    });
    const onComplete = vi.fn();
    const onError = vi.fn();
    const { result } = renderHook(() => useChatStream({ patchAssistant, onComplete, onError }));

    let runs!: Promise<boolean>[];
    const sessionIds = ["chat-a", "chat-b", "chat-c", "chat-d", "chat-e"];
    act(() => {
      runs = sessionIds.map((sessionId) => result.current.run(sessionId, sessionId));
    });
    expect(mocks.chatSend).toHaveBeenCalledTimes(5);
    expect(result.current.runningSessionIds).toEqual(new Set(sessionIds));

    let sixth!: Promise<boolean>;
    act(() => {
      sixth = result.current.run("chat-f", "F");
    });
    await expect(sixth).resolves.toBe(false);
    expect(mocks.chatSend).toHaveBeenCalledTimes(5);
    expect(onError).toHaveBeenCalledWith(
      "chat-f",
      "at most 5 chat turns can run at once",
      false,
    );

    act(() => {
      deltaHandler?.({ sessionId: "chat-b", text: "B delta" });
      doneHandler?.({ sessionId: "chat-b", text: "B delta" });
    });
    expect(routed).toContain("chat-b");
    expect(routed).not.toContain("chat-a");

    await act(async () => {
      for (const sessionId of sessionIds) {
        resolvers.get(sessionId)?.(`${sessionId} reply`);
      }
      await Promise.all(runs);
    });
    for (const sessionId of sessionIds) {
      expect(onComplete).toHaveBeenCalledWith(sessionId, `${sessionId} reply`);
    }
  });

  it("coalesces a large burst of deltas before patching React state", async () => {
    let deltaHandler: ((event: { sessionId: string; text: string }) => void) | null = null;
    let doneHandler: ((event: { sessionId: string; text: string }) => void) | null = null;
    mocks.onChatDelta.mockImplementation((handler) => {
      deltaHandler = handler;
      return Promise.resolve(() => undefined);
    });
    mocks.onChatDone.mockImplementation((handler) => {
      doneHandler = handler;
      return Promise.resolve(() => undefined);
    });
    for (const listener of [
      mocks.onChatThinkingDelta,
      mocks.onChatTool,
      mocks.onChatToolResult,
      mocks.onChatPermissionRequest,
      mocks.onChatPermissionResolved,
    ]) {
      listener.mockReturnValue(Promise.resolve(() => undefined));
    }
    mocks.chatSend.mockResolvedValue("done");

    let patchedText = "";
    const patchAssistant = vi.fn((_sessionId: string, patch) => {
      const turn = patch({ id: "assistant", role: "assistant", blocks: [], streaming: true });
      patchedText = turn.blocks[0]?.kind === "text" ? turn.blocks[0].text : "";
    });
    const { result } = renderHook(() => useChatStream({
      patchAssistant,
      onComplete: vi.fn(),
      onError: vi.fn(),
    }));

    act(() => {
      for (let index = 0; index < 20_000; index += 1) {
        deltaHandler?.({ sessionId: "chat-large", text: "x" });
      }
      doneHandler?.({ sessionId: "chat-large", text: "" });
    });

    expect(patchAssistant).toHaveBeenCalledTimes(1);
    expect(patchedText).toHaveLength(20_000);
    await act(async () => {
      await result.current.run("chat-large", "go");
    });
  });

  it("prefers the post-turn session token estimate for the context ring", () => {
    let doneHandler:
      | ((event: {
        sessionId: string;
        text: string;
        contextTokens?: number | null;
        providerUsage?: { totalTokens: number; promptTokens: number } | null;
      }) => void)
      | null = null;
    mocks.onChatDone.mockImplementation((handler) => {
      doneHandler = handler;
      return Promise.resolve(() => undefined);
    });

    const onContextTokens = vi.fn();
    renderHook(() => useChatStream({
      patchAssistant: vi.fn(),
      onComplete: vi.fn(),
      onError: vi.fn(),
      onContextTokens,
    }));

    act(() => {
      doneHandler?.({
        sessionId: "chat-ctx",
        text: "done",
        contextTokens: 900,
        providerUsage: { promptTokens: 420_000, totalTokens: 500_000 },
      });
    });

    // The backend estimate is in the same unit as the compaction budget.
    // Provider prompt usage may be measured before automatic compaction.
    expect(onContextTokens).toHaveBeenCalledWith("chat-ctx", 900);
    expect(onContextTokens).not.toHaveBeenCalledWith("chat-ctx", 420_000);
  });

  it("deduplicates repeated AskUserQuestion events and applies the ready handshake", () => {
    let toolHandler:
      | ((event: { sessionId: string; id?: string; name: string; input: string; ready?: boolean }) => void)
      | null = null;
    mocks.onChatTool.mockImplementation((handler) => {
      toolHandler = handler;
      return Promise.resolve(() => undefined);
    });

    let current = { id: "assistant", role: "assistant" as const, blocks: [], streaming: true };
    const patchAssistant = vi.fn((_sessionId: string, patch) => {
      current = patch(current);
    });
    renderHook(() => useChatStream({
      patchAssistant,
      onComplete: vi.fn(),
      onError: vi.fn(),
    }));

    act(() => {
      toolHandler?.({
        sessionId: "chat-q",
        id: "ask-1",
        name: "AskUserQuestion",
        input: "{\"question\":\"Old?\",\"options\":[{\"label\":\"A\"}]}",
      });
      toolHandler?.({
        sessionId: "chat-q",
        id: "ask-1",
        name: "AskUserQuestion",
        input: "{\"question\":\"New?\",\"options\":[{\"label\":\"B\"}]}",
        ready: true,
      });
    });

    expect(current.blocks).toHaveLength(1);
    expect(current.blocks[0]).toMatchObject({
      id: "ask-1",
      name: "AskUserQuestion",
      input: "{\"question\":\"New?\",\"options\":[{\"label\":\"B\"}]}",
      ready: true,
    });
  });

  it("reports provider errors through onError instead of completing silently", async () => {
    for (const listener of [
      mocks.onChatDelta,
      mocks.onChatThinkingDelta,
      mocks.onChatTool,
      mocks.onChatToolResult,
      mocks.onChatPermissionRequest,
      mocks.onChatPermissionResolved,
      mocks.onChatDone,
    ]) {
      listener.mockReturnValue(Promise.resolve(() => undefined));
    }
    mocks.chatSend.mockRejectedValue(new Error("provider stream failed"));

    const onComplete = vi.fn();
    const onError = vi.fn();
    const { result } = renderHook(() => useChatStream({
      patchAssistant: vi.fn(),
      onComplete,
      onError,
    }));

    let completed!: boolean;
    await act(async () => {
      completed = await result.current.run("chat-error", "go");
    });

    expect(completed).toBe(false);
    expect(onComplete).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      "chat-error",
      "Error: provider stream failed",
      false,
    );
  });

  it("flushes queued deltas before surfacing a backend failure", () => {
    let deltaHandler: ((event: { sessionId: string; text: string }) => void) | undefined;
    let errorHandler: ((event: { sessionId: string; message: string }) => void) | undefined;
    mocks.onChatDelta.mockImplementation((handler) => {
      deltaHandler = handler;
      return Promise.resolve(() => undefined);
    });
    mocks.onChatError.mockImplementation((handler) => {
      errorHandler = handler;
      return Promise.resolve(() => undefined);
    });

    const events: string[] = [];
    let current = { id: "assistant", role: "assistant" as const, blocks: [], streaming: true };
    const patchAssistant = vi.fn((_sessionId: string, patch) => {
      events.push("patch");
      current = patch(current);
    });
    const onError = vi.fn(() => events.push("error"));

    renderHook(() => useChatStream({
      patchAssistant,
      onComplete: vi.fn(),
      onError,
    }));

    act(() => {
      deltaHandler?.({ sessionId: "chat-fail", text: "partial before failure" });
      errorHandler?.({ sessionId: "chat-fail", message: "context window exceeded" });
    });

    expect(events).toEqual(["patch", "error"]);
    expect(current.blocks).toEqual([{ kind: "text", text: "partial before failure" }]);
    expect(onError).toHaveBeenCalledWith(
      "chat-fail",
      "This chat is too long for the selected model. Start a new chat or compact the context, then try again.",
      false,
      undefined,
    );
  });

  it("clears failed session state so the same chat can run again", async () => {
    let attempt = 0;
    mocks.chatSend.mockImplementation(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("unexpected provider failure");
      return "recovered reply";
    });

    const onComplete = vi.fn();
    const onError = vi.fn();
    const { result } = renderHook(() => useChatStream({
      patchAssistant: vi.fn(),
      onComplete,
      onError,
    }));

    let first!: boolean;
    await act(async () => {
      first = await result.current.run("chat-retry", "first");
    });

    expect(first).toBe(false);
    expect(result.current.isRunning("chat-retry")).toBe(false);
    expect(result.current.runningSessionIds).toEqual(new Set());

    let second!: boolean;
    await act(async () => {
      second = await result.current.run("chat-retry", "second");
    });

    expect(second).toBe(true);
    expect(mocks.chatSend).toHaveBeenNthCalledWith(2, "chat-retry", "second");
    expect(onComplete).toHaveBeenCalledWith("chat-retry", "recovered reply");
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("surfaces a backend chat-error event through onError", async () => {
    let errorHandler: ((event: { sessionId: string; message: string }) => void) | undefined;
    mocks.onChatError.mockImplementation((handler) => {
      errorHandler = handler;
      return Promise.resolve(() => undefined);
    });

    const onError = vi.fn();
    renderHook(() => useChatStream({
      patchAssistant: vi.fn(),
      onComplete: vi.fn(),
      onError,
    }));

    act(() => {
      errorHandler?.({ sessionId: "chat-net", message: "OpenAI request failed: connection reset" });
    });

    expect(onError).toHaveBeenCalledWith(
      "chat-net",
      "Unable to reach the service. Check your network connection and try again.",
      false,
      undefined,
    );
  });

  it("forwards an unpreserved-session marker from a backend error", async () => {
    let errorHandler:
      | ((event: { sessionId: string; message: string; sessionPreserved?: boolean }) => void)
      | undefined;
    mocks.onChatError.mockImplementation((handler) => {
      errorHandler = handler;
      return Promise.resolve(() => undefined);
    });

    const onError = vi.fn();
    renderHook(() => useChatStream({
      patchAssistant: vi.fn(),
      onComplete: vi.fn(),
      onError,
    }));

    act(() => {
      errorHandler?.({
        sessionId: "chat-build-failure",
        message: "invalid API key",
        sessionPreserved: false,
      });
    });

    expect(onError).toHaveBeenCalledWith(
      "chat-build-failure",
      "Authentication failed. Sign in again or check the API key.",
      false,
      false,
    );
  });

  it("does not hide a backend error when it races with a user stop", async () => {
    let errorHandler: ((event: { sessionId: string; message: string }) => void) | undefined;
    mocks.onChatError.mockImplementation((handler) => {
      errorHandler = handler;
      return Promise.resolve(() => undefined);
    });
    mocks.chatSend.mockReturnValue(new Promise(() => undefined));

    const onError = vi.fn();
    const { result } = renderHook(() => useChatStream({
      patchAssistant: vi.fn(),
      onComplete: vi.fn(),
      onError,
    }));

    await act(async () => {
      void result.current.run("chat-race", "go");
      await result.current.stop("chat-race");
    });
    act(() => {
      errorHandler?.({ sessionId: "chat-race", message: "provider stream closed unexpectedly" });
    });

    expect(onError).toHaveBeenLastCalledWith(
      "chat-race",
      "provider stream closed unexpectedly",
      false,
      undefined,
    );
  });

  it("drops a previous turn's cancellation that lands on the next running turn", async () => {
    let errorHandler: ((event: { sessionId: string; message: string }) => void) | undefined;
    mocks.onChatError.mockImplementation((handler) => {
      errorHandler = handler;
      return Promise.resolve(() => undefined);
    });
    mocks.chatCancel.mockResolvedValue(undefined);
    mocks.chatSend
      .mockImplementationOnce(() => new Promise<string>(() => undefined))
      .mockImplementationOnce(() => new Promise<string>(() => undefined));

    const onError = vi.fn();
    const { result } = renderHook(() => useChatStream({
      patchAssistant: vi.fn(),
      onComplete: vi.fn(),
      onError,
    }));

    act(() => {
      void result.current.run("chat-late-cancel", "first");
    });
    await act(async () => {
      await result.current.stop("chat-late-cancel");
    });
    onError.mockClear();

    // The user retypes and sends before the cancelled worker has unwound.
    act(() => {
      void result.current.run("chat-late-cancel", "second");
    });
    expect(result.current.isRunning("chat-late-cancel")).toBe(true);

    act(() => {
      errorHandler?.({ sessionId: "chat-late-cancel", message: "interrupted by user" });
    });

    expect(onError).not.toHaveBeenCalled();
    expect(result.current.isRunning("chat-late-cancel")).toBe(true);
  });

  it("still surfaces a cancellation that belongs to the turn the user just stopped", async () => {
    let errorHandler: ((event: { sessionId: string; message: string }) => void) | undefined;
    mocks.onChatError.mockImplementation((handler) => {
      errorHandler = handler;
      return Promise.resolve(() => undefined);
    });
    mocks.chatCancel.mockResolvedValue(undefined);
    mocks.chatSend.mockImplementation(() => new Promise<string>(() => undefined));

    const onError = vi.fn();
    const { result } = renderHook(() => useChatStream({
      patchAssistant: vi.fn(),
      onComplete: vi.fn(),
      onError,
    }));

    act(() => {
      void result.current.run("chat-stopped", "first");
    });
    await act(async () => {
      await result.current.stop("chat-stopped");
    });
    onError.mockClear();

    act(() => {
      errorHandler?.({ sessionId: "chat-stopped", message: "interrupted by user" });
    });

    expect(onError).toHaveBeenCalledWith("chat-stopped", "interrupted by user", true, undefined);
  });

  it("appends a compacted context notice when the backend compacts", async () => {
    let compactedHandler:
      | ((event: { sessionId: string; removedMessageCount: number }) => void)
      | undefined;
    mocks.onChatContextCompacted.mockImplementation((handler) => {
      compactedHandler = handler;
      return Promise.resolve(() => undefined);
    });

    const patchAssistant = vi.fn((sessionId, fn) => {
      const next = fn({
        id: "assistant-1",
        role: "assistant",
        blocks: [],
        streaming: true,
      });
      expect(sessionId).toBe("chat-ctx");
      expect(next.blocks).toEqual([
        {
          kind: "notice",
          message: "Context compacted automatically; 12 earlier messages were summarized.",
        },
      ]);
    });

    renderHook(() => useChatStream({
      patchAssistant,
      onComplete: vi.fn(),
      onError: vi.fn(),
    }));

    act(() => {
      compactedHandler?.({ sessionId: "chat-ctx", removedMessageCount: 12 });
    });

    expect(patchAssistant).toHaveBeenCalled();
  });

  it("annotates the compaction notice with how much context was freed", async () => {
    let compactedHandler:
      | ((event: { sessionId: string; removedMessageCount: number; tokensAfter?: number | null }) => void)
      | undefined;
    mocks.onChatContextCompacted.mockImplementation((handler) => {
      compactedHandler = handler;
      return Promise.resolve(() => undefined);
    });

    let noticeMessage: string | undefined;
    const patchAssistant = vi.fn((_sessionId, fn) => {
      const next = fn({ id: "assistant-1", role: "assistant", blocks: [], streaming: true });
      const notice = next.blocks.find((block: { kind: string }) => block.kind === "notice");
      noticeMessage = (notice as { message?: string } | undefined)?.message;
    });

    renderHook(() => useChatStream({
      patchAssistant,
      onComplete: vi.fn(),
      onError: vi.fn(),
      getContextTokens: () => 45_000,
    }));

    act(() => {
      compactedHandler?.({ sessionId: "chat-ctx", removedMessageCount: 8, tokensAfter: 12_000 });
    });

    expect(noticeMessage).toContain("45.0k -> 12.0k tokens (-73%)");
  });

  it("keeps the final reply after a compaction event arrives before chat-done", async () => {
    let compactedHandler:
      | ((event: { sessionId: string; removedMessageCount: number; tokensAfter?: number | null }) => void)
      | undefined;
    let doneHandler:
      | ((event: { sessionId: string; text: string; contextTokens?: number | null }) => void)
      | undefined;
    mocks.onChatContextCompacted.mockImplementation((handler) => {
      compactedHandler = handler;
      return Promise.resolve(() => undefined);
    });
    mocks.onChatDone.mockImplementation((handler) => {
      doneHandler = handler;
      return Promise.resolve(() => undefined);
    });

    let current = { id: "assistant-1", role: "assistant" as const, blocks: [], streaming: true };
    const patchAssistant = vi.fn((_sessionId: string, patch) => {
      current = patch(current);
    });
    const onComplete = vi.fn();
    mocks.chatSend.mockImplementation(async () => {
      compactedHandler?.({ sessionId: "chat-after-compact", removedMessageCount: 10, tokensAfter: 1_200 });
      doneHandler?.({ sessionId: "chat-after-compact", text: "reply after compaction", contextTokens: 1_200 });
      return "reply after compaction";
    });

    const { result } = renderHook(() => useChatStream({
      patchAssistant,
      onComplete,
      onError: vi.fn(),
    }));

    await act(async () => {
      await result.current.run("chat-after-compact", "continue");
    });

    expect(current.blocks).toEqual([
      {
        kind: "notice",
        message: "Context compacted automatically; 10 earlier messages were summarized.",
      },
    ]);
    expect(onComplete).toHaveBeenCalledWith("chat-after-compact", "reply after compaction");
  });

  it("surfaces context warning events to the host", async () => {
    let warningHandler:
      | ((event: {
        sessionId: string;
        usedTokens: number;
        contextWindow: number;
        compactionBudget?: number | null;
      }) => void)
      | undefined;
    mocks.onChatContextWarning.mockImplementation((handler) => {
      warningHandler = handler;
      return Promise.resolve(() => undefined);
    });

    const onContextWarning = vi.fn();
    renderHook(() => useChatStream({
      patchAssistant: vi.fn(),
      onComplete: vi.fn(),
      onError: vi.fn(),
      onContextWarning,
    }));

    act(() => {
      warningHandler?.({
        sessionId: "chat-ctx",
        usedTokens: 120_000,
        contextWindow: 160_000,
        compactionBudget: 160_000,
      });
    });

    expect(onContextWarning).toHaveBeenCalledWith({
      sessionId: "chat-ctx",
      usedTokens: 120_000,
      contextWindow: 160_000,
      compactionBudget: 160_000,
    });
  });

  it("stops only the selected session and updates local state immediately", async () => {
    for (const listener of [
      mocks.onChatDelta,
      mocks.onChatThinkingDelta,
      mocks.onChatTool,
      mocks.onChatToolResult,
      mocks.onChatPermissionRequest,
      mocks.onChatPermissionResolved,
      mocks.onChatDone,
    ]) {
      listener.mockReturnValue(Promise.resolve(() => undefined));
    }
    mocks.chatSend.mockImplementation(() => new Promise<string>(() => undefined));
    mocks.chatCancel.mockResolvedValue(undefined);

    const onError = vi.fn();
    const { result } = renderHook(() => useChatStream({
      patchAssistant: vi.fn(),
      onComplete: vi.fn(),
      onError,
    }));

    act(() => {
      void result.current.run("chat-a", "A");
      void result.current.run("chat-b", "B");
    });
    expect(result.current.runningSessionIds).toEqual(new Set(["chat-a", "chat-b"]));

    await act(async () => {
      await result.current.stop("chat-a");
    });

    expect(mocks.chatCancel).toHaveBeenCalledWith("chat-a");
    expect(result.current.runningSessionIds).toEqual(new Set(["chat-b"]));
    expect(onError).toHaveBeenCalledWith("chat-a", "", true, false);
    expect(onError).not.toHaveBeenCalledWith("chat-b", expect.anything(), true);
  });

  it("allows an immediate retry after Stop without letting the old send settle it", async () => {
    let resolveFirst: ((reply: string) => void) | undefined;
    mocks.chatSend
      .mockImplementationOnce(() => new Promise<string>((resolve) => {
        resolveFirst = resolve;
      }))
      .mockResolvedValueOnce("fresh reply");
    mocks.chatCancel.mockResolvedValue(undefined);

    const onComplete = vi.fn();
    const onError = vi.fn();
    const { result } = renderHook(() => useChatStream({
      patchAssistant: vi.fn(),
      onComplete,
      onError,
    }));

    act(() => {
      void result.current.run("chat-retry-after-stop", "first");
    });
    await act(async () => {
      await result.current.stop("chat-retry-after-stop");
    });

    let retried = false;
    await act(async () => {
      retried = await result.current.run("chat-retry-after-stop", "second");
    });
    expect(retried).toBe(true);
    expect(mocks.chatSend).toHaveBeenNthCalledWith(2, "chat-retry-after-stop", {
      text: "second",
      previousTurnCancelled: true,
    });
    expect(onComplete).toHaveBeenCalledWith("chat-retry-after-stop", "fresh reply");

    await act(async () => {
      resolveFirst?.("stale reply");
      await Promise.resolve();
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(result.current.isRunning("chat-retry-after-stop")).toBe(false);
  });

  it("uses a per-session remote Agent transport for send and cancel", async () => {
    const send = vi.fn(() => new Promise<string>(() => undefined));
    const cancel = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useChatStream({
      patchAssistant: vi.fn(),
      onComplete: vi.fn(),
      onError: vi.fn(),
    }));

    act(() => {
      void result.current.run("remote-chat", "Run on the other computer", { send, cancel });
    });
    expect(send).toHaveBeenCalledWith("remote-chat", "Run on the other computer");
    expect(mocks.chatSend).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.stop("remote-chat");
    });

    expect(cancel).toHaveBeenCalledWith("remote-chat");
    expect(mocks.chatCancel).not.toHaveBeenCalled();
  });
});
