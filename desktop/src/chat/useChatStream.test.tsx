// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  chatSend: vi.fn(),
  chatCancel: vi.fn(),
  onChatDelta: vi.fn(),
  onChatThinkingDelta: vi.fn(),
  onChatTool: vi.fn(),
  onChatToolResult: vi.fn(),
  onChatDone: vi.fn(),
}));

vi.mock("../api/tauri", () => ({
  isTauri: () => true,
  chatSend: mocks.chatSend,
  chatCancel: mocks.chatCancel,
  onChatDelta: mocks.onChatDelta,
  onChatThinkingDelta: mocks.onChatThinkingDelta,
  onChatTool: mocks.onChatTool,
  onChatToolResult: mocks.onChatToolResult,
  onChatDone: mocks.onChatDone,
}));

import { useChatStream } from "./useChatStream";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useChatStream concurrent sessions", () => {
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
});
