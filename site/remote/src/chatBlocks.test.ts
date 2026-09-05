import { describe, expect, it } from "vitest";

import {
  applyChatMessageEvent,
  latestThinkingBlockIndex,
  remoteTranscriptMessageFromWire,
} from "./chatBlocks";

describe("remote rich chat blocks", () => {
  it("keeps thinking, tools, and answer text in desktop event order", () => {
    let blocks = applyChatMessageEvent([], { kind: "thinking_delta", delta: "检查连接" });
    blocks = applyChatMessageEvent(blocks, {
      kind: "tool_call",
      toolUseId: "tool-1",
      name: "shell_command",
      input: "{\"command\":\"ping\"}",
    });
    blocks = applyChatMessageEvent(blocks, {
      kind: "tool_result",
      toolUseId: "tool-1",
      name: "shell_command",
      output: "ok",
      isError: false,
    });
    blocks = applyChatMessageEvent(blocks, { kind: "text_delta", delta: "P2P " });
    blocks = applyChatMessageEvent(blocks, { kind: "text_delta", delta: "通畅" });

    expect(blocks).toEqual([
      { kind: "thinking", thinking: "检查连接" },
      {
        kind: "tool",
        toolUseId: "tool-1",
        name: "shell_command",
        input: "{\"command\":\"ping\"}",
        output: "ok",
        isError: false,
        progress: null,
      },
      { kind: "text", text: "P2P 通畅" },
    ]);
  });

  it("keeps the newest thinking phase addressable after answer text arrives in the same paint", () => {
    let blocks = applyChatMessageEvent([], { kind: "thinking_delta", delta: "第一段思考" });
    blocks = applyChatMessageEvent(blocks, { kind: "text_delta", delta: "正文" });
    expect(latestThinkingBlockIndex(blocks)).toBe(0);

    blocks = applyChatMessageEvent(blocks, { kind: "thinking_delta", delta: "第二段思考" });
    expect(latestThinkingBlockIndex(blocks)).toBe(2);
  });

  it("parses durable rich transcript blocks and rejects tool cards on user turns", () => {
    expect(remoteTranscriptMessageFromWire({
      role: "assistant",
      text: "done",
      blocks: [
        { kind: "thinking", thinking: "checking" },
        {
          kind: "tool",
          tool_use_id: "tool-1",
          name: "shell_command",
          input: "ping",
          output: "ok",
          is_error: false,
          progress: null,
        },
        { kind: "text", text: "done" },
      ],
    })?.blocks).toHaveLength(3);
    expect(remoteTranscriptMessageFromWire({
      role: "user",
      text: "bad",
      blocks: [{ kind: "thinking", thinking: "hidden" }],
    })).toBeNull();
  });

  it("keeps old text-only transcript responses readable", () => {
    expect(remoteTranscriptMessageFromWire({ role: "assistant", text: "legacy" })).toEqual({
      role: "assistant",
      text: "legacy",
      blocks: [{ kind: "text", text: "legacy" }],
    });
  });
});
