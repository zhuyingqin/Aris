import { describe, expect, it } from "vitest";
import type { ChatTurn } from "../../types";
import {
  completedAssistantBlocks,
  contextForRetry,
  continueStoppedPrompt,
  needsBackendContextReset,
  visibleTurnError,
} from "../chatRunHelpers";

describe("chatRunHelpers", () => {
  it("rebuilds stopped assistant turns into backend context with tool activity", async () => {
    const messages = await contextForRetry([
      { id: "user-1", role: "user", blocks: [{ kind: "text", text: "Read README" }] },
      {
        id: "assistant-1",
        role: "assistant",
        stopped: true,
        blocks: [
          { kind: "text", text: "I checked the file." },
          { kind: "tool", id: "tool-1", name: "read_file", input: "{\"path\":\"README.md\"}", output: "README body" },
        ],
      },
    ]);

    expect(messages).toEqual([
      { role: "user", text: "Read README", images: [] },
      {
        role: "assistant",
        text: "I checked the file.",
        toolCalls: [{ id: "tool-1", name: "read_file", input: "{\"path\":\"README.md\"}" }],
      },
      {
        role: "tool",
        toolResults: [{ toolUseId: "tool-1", toolName: "read_file", output: "README body", isError: false }],
      },
    ]);
  });

  it("rebuilds completed assistant turns with their tool activity, not text alone", async () => {
    const messages = await contextForRetry([
      { id: "user-1", role: "user", blocks: [{ kind: "text", text: "Read README" }] },
      {
        id: "assistant-1",
        role: "assistant",
        blocks: [
          { kind: "text", text: "I checked the file." },
          { kind: "tool", id: "tool-1", name: "read_file", input: "{\"path\":\"README.md\"}", output: "README body" },
        ],
      },
    ]);

    expect(messages).toEqual([
      { role: "user", text: "Read README", images: [] },
      {
        role: "assistant",
        text: "I checked the file.",
        toolCalls: [{ id: "tool-1", name: "read_file", input: "{\"path\":\"README.md\"}" }],
      },
      {
        role: "tool",
        toolResults: [{ toolUseId: "tool-1", toolName: "read_file", output: "README body", isError: false }],
      },
    ]);
    expect(JSON.stringify(messages)).not.toContain("[Tool call:");
  });

  it("still drops in-flight and failed turns from backend context", async () => {
    const messages = await contextForRetry([
      { id: "user-1", role: "user", blocks: [{ kind: "text", text: "Do it" }] },
      { id: "a-streaming", role: "assistant", streaming: true, blocks: [{ kind: "text", text: "partial" }] },
      {
        id: "a-error",
        role: "assistant",
        error: "boom",
        blocks: [
          { kind: "text", text: "failed partial answer" },
          {
            kind: "tool",
            id: "tool-failed",
            name: "read_file",
            input: "{\"path\":\"missing.md\"}",
            output: "read_file failed with stale context",
            isError: true,
          },
        ],
      },
    ]);

    expect(messages).toEqual([{ role: "user", text: "Do it", images: [] }]);
    expect(JSON.stringify(messages)).not.toContain("failed partial answer");
    expect(JSON.stringify(messages)).not.toContain("tool-failed");
    expect(JSON.stringify(messages)).not.toContain("stale context");
  });

  it("continue prompt points at the rebuilt context without embedding the partial", () => {
    const prompt = continueStoppedPrompt();

    expect(prompt).toContain("Continue from where you stopped.");
    expect(prompt).toContain("already in the conversation above");
    expect(prompt).toContain("Do not repeat");
    // No partial text is embedded (and therefore never truncated at 12k).
    expect(prompt).not.toContain("Partial stopped response:");
  });

  it("requires backend context reset when rerunning from an earlier turn", () => {
    const current: ChatTurn[] = [
      { id: "u1", role: "user", blocks: [{ kind: "text", text: "first" }] },
      { id: "a1", role: "assistant", blocks: [{ kind: "text", text: "answer one" }] },
      { id: "u2", role: "user", blocks: [{ kind: "text", text: "second" }] },
      { id: "a2", role: "assistant", blocks: [{ kind: "text", text: "answer two" }] },
    ];

    expect(needsBackendContextReset(current, current)).toBe(false);
    expect(needsBackendContextReset(current, current.slice(0, 2))).toBe(true);
    expect(needsBackendContextReset(current, [
      current[0],
      { id: "different", role: "assistant", blocks: [{ kind: "text", text: "rewritten" }] },
      current[2],
      current[3],
    ])).toBe(true);
    expect(needsBackendContextReset(current, current, true)).toBe(true);
    expect(needsBackendContextReset(
      [
        current[0],
        { ...current[1], stopped: true },
      ],
      [
        current[0],
        { ...current[1], stopped: true },
      ],
    )).toBe(true);
    expect(needsBackendContextReset(
      [
        current[0],
        { ...current[1], error: "provider failed" },
      ],
      [
        current[0],
        { ...current[1], error: "provider failed" },
      ],
    )).toBe(true);
  });

  it("hides expected cancel errors but preserves real failures after stop", () => {
    expect(visibleTurnError("interrupted by user", true)).toBeUndefined();
    expect(visibleTurnError("MCP request interrupted by user", true)).toBeUndefined();
    expect(visibleTurnError("provider stream error after partial output", true))
      .toBe("provider stream error after partial output");
    expect(visibleTurnError("provider stream error", false)).toBe("provider stream error");
  });

  it("promotes thinking-only completed output to visible text", () => {
    const blocks = completedAssistantBlocks({
      id: "assistant-thinking-only",
      role: "assistant",
      streaming: true,
      blocks: [{ kind: "thinking", thinking: "Final answer was streamed as reasoning_content." }],
    }, "");

    expect(blocks).toEqual([
      { kind: "text", text: "Final answer was streamed as reasoning_content." },
    ]);
  });

  it("keeps a real final reply visible after streamed thinking", () => {
    const blocks = completedAssistantBlocks({
      id: "assistant-thinking-reply",
      role: "assistant",
      streaming: true,
      blocks: [{ kind: "thinking", thinking: "private reasoning" }],
    }, "Visible final answer.");

    expect(blocks).toEqual([
      { kind: "thinking", thinking: "private reasoning" },
      { kind: "text", text: "Visible final answer." },
    ]);
  });
});
