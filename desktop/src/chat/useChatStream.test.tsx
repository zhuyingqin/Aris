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
  onChatPermissionRequest: vi.fn(),
  onChatPermissionResolved: vi.fn(),
  onChatDone: vi.fn(),
  onChatError: vi.fn(),
  onChatContextCompacted: vi.fn(),
  onChatContextWarning: vi.fn(),
}));

vi.mock("../api/tauri", () => ({
  isTauri: () => true,
  chatSend: mocks.chatSend,
  chatCancel: mocks.chatCancel,
  onChatDelta: mocks.onChatDelta,
  onChatThinkingDelta: mocks.onChatThinkingDelta,
  onChatTool: mocks.onChatTool,
  onChatToolProgress: mocks.onChatToolProgress,
  onChatToolResult: mocks.onChatToolResult,
  onChatPermissionRequest: mocks.onChatPermissionRequest,
  onChatPermissionResolved: mocks.onChatPermissionResolved,
  onChatDone: mocks.onChatDone,
  onChatError: mocks.onChatError,
  onChatContextCompacted: mocks.onChatContextCompacted,
  onChatContextWarning: mocks.onChatContextWarning,
}));

import { updateToolProgress, useChatStream } from "./useChatStream";

const listenerMocks = [
  mocks.onChatDelta,
  mocks.onChatThinkingDelta,
  mocks.onChatTool,
  mocks.onChatToolProgress,
  mocks.onChatToolResult,
  mocks.onChatPermissionRequest,
  mocks.onChatPermissionResolved,
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

describe("useChatStream concurrent sessions", () => {
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

  it("ignores stale Tauri listeners after a subscription refresh", () => {
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

    expect(deltaHandlers).toHaveLength(2);
    expect(doneHandlers).toHaveLength(2);
    expect(firstPatchAssistant).not.toHaveBeenCalled();
    expect(secondPatchAssistant).toHaveBeenCalledTimes(1);
  });

  it("runs two sessions concurrently and routes deltas by session id", async () => {
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

    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = result.current.run("chat-a", "A");
      second = result.current.run("chat-b", "B");
    });
    expect(mocks.chatSend).toHaveBeenCalledTimes(2);
    expect(result.current.runningSessionIds).toEqual(new Set(["chat-a", "chat-b"]));

    act(() => {
      deltaHandler?.({ sessionId: "chat-b", text: "B delta" });
      doneHandler?.({ sessionId: "chat-b", text: "B delta" });
    });
    expect(routed).toContain("chat-b");
    expect(routed).not.toContain("chat-a");

    await act(async () => {
      resolvers.get("chat-a")?.("A reply");
      resolvers.get("chat-b")?.("B reply");
      await Promise.all([first, second]);
    });
    expect(onComplete).toHaveBeenCalledWith("chat-a", "A reply");
    expect(onComplete).toHaveBeenCalledWith("chat-b", "B reply");
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

  it("prefers providerUsage.promptTokens over contextTokens for real context ring", () => {
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

    // Real API prompt_tokens should be preferred over the local estimate.
    expect(onContextTokens).toHaveBeenCalledWith("chat-ctx", 420_000);
    expect(onContextTokens).not.toHaveBeenCalledWith("chat-ctx", 900);
  });

  it("deduplicates repeated AskUserQuestion tool-call events by id", () => {
    let toolHandler:
      | ((event: { sessionId: string; id?: string; name: string; input: string }) => void)
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
      });
    });

    expect(current.blocks).toHaveLength(1);
    expect(current.blocks[0]).toMatchObject({
      id: "ask-1",
      name: "AskUserQuestion",
      input: "{\"question\":\"New?\",\"options\":[{\"label\":\"B\"}]}",
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
    expect(onError).toHaveBeenCalledWith("chat-fail", "context window exceeded", false);
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
      "OpenAI request failed: connection reset",
      false,
    );
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
    expect(onError).toHaveBeenCalledWith("chat-a", "", true);
    expect(onError).not.toHaveBeenCalledWith("chat-b", expect.anything(), true);
  });
});
