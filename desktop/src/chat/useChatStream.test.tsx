// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  chatSend: vi.fn(),
  chatCancel: vi.fn(),
  onChatDelta: vi.fn(),
  onChatThinkingDelta: vi.fn(),
  onChatTool: vi.fn(),
  onChatToolResult: vi.fn(),
  onChatPermissionRequest: vi.fn(),
  onChatPermissionResolved: vi.fn(),
  onChatDone: vi.fn(),
  onChatError: vi.fn(),
}));

vi.mock("../api/tauri", () => ({
  isTauri: () => true,
  chatSend: mocks.chatSend,
  chatCancel: mocks.chatCancel,
  onChatDelta: mocks.onChatDelta,
  onChatThinkingDelta: mocks.onChatThinkingDelta,
  onChatTool: mocks.onChatTool,
  onChatToolResult: mocks.onChatToolResult,
  onChatPermissionRequest: mocks.onChatPermissionRequest,
  onChatPermissionResolved: mocks.onChatPermissionResolved,
  onChatDone: mocks.onChatDone,
  onChatError: mocks.onChatError,
}));

import { useChatStream } from "./useChatStream";

const listenerMocks = [
  mocks.onChatDelta,
  mocks.onChatThinkingDelta,
  mocks.onChatTool,
  mocks.onChatToolResult,
  mocks.onChatPermissionRequest,
  mocks.onChatPermissionResolved,
  mocks.onChatDone,
  mocks.onChatError,
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
