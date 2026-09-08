// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type { ChatTurn } from "../../types";
import {
  activeQuestionNumber,
  chatThreadClassName,
  firstVisibleTurnIndexFromVirtualItems,
  isNearBottom,
  questionMarkersFromTurns,
  questionPreviewFromTurn,
  scrollBottomLabel,
  shouldIgnoreProgrammaticScroll,
  shouldLoadEarlierTurnsAtTop,
} from "../ChatThread";

describe("ChatThread scroll and timeline helpers", () => {
  it("localizes the return-to-bottom control", () => {
    expect(scrollBottomLabel("cn")).toBe("回到底部");
    expect(scrollBottomLabel("en")).toBe("Back to bottom");
  });

  it("reserves a transcript gutter only when the question timeline is visible", () => {
    expect(chatThreadClassName(false, 1)).toBe("chat-thread");
    expect(chatThreadClassName(true, 1)).toBe("chat-thread has-earlier-turns");
    expect(chatThreadClassName(false, 2)).toBe("chat-thread has-question-timeline");
    expect(chatThreadClassName(true, 21)).toBe(
      "chat-thread has-earlier-turns has-question-timeline",
    );
  });

  it("detects whether the return-to-bottom control is needed", () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 760, clientHeight: 200 })).toBe(true);
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 300, clientHeight: 200 })).toBe(false);
  });

  it("requests earlier history only after the reader reaches the top edge", () => {
    expect(shouldLoadEarlierTurnsAtTop({ scrollTop: 96 })).toBe(true);
    expect(shouldLoadEarlierTurnsAtTop({ scrollTop: 97 })).toBe(false);
  });

  it("ignores the immediate scroll event from explicit navigation", () => {
    expect(shouldIgnoreProgrammaticScroll(180, 100)).toBe(true);
    expect(shouldIgnoreProgrammaticScroll(180, 220)).toBe(false);
  });

  it("builds a compact timeline from user questions only", () => {
    const turns: ChatTurn[] = [
      { id: "u1", role: "user", blocks: [{ kind: "text", text: "First question" }] },
      { id: "a1", role: "assistant", blocks: [{ kind: "text", text: "Answer" }] },
      { id: "u2", role: "user", blocks: [{ kind: "text", text: "Second question\nwith details" }] },
    ];

    expect(questionMarkersFromTurns(turns)).toEqual([
      { id: "u1", turnIndex: 0, number: 1, preview: "First question" },
      { id: "u2", turnIndex: 2, number: 2, preview: "Second question with details" },
    ]);
  });

  it("summarizes long or attachment-only questions for the hover list", () => {
    expect(questionPreviewFromTurn({
      id: "long",
      role: "user",
      blocks: [{ kind: "text", text: "a".repeat(52) }],
    })).toBe(`${"a".repeat(48)}...`);
    expect(questionPreviewFromTurn({
      id: "attachment",
      role: "user",
      blocks: [],
      attachments: [{ id: "att-1", kind: "file", name: "notes.md" }],
    })).toBe("附件：notes.md");
    expect(questionPreviewFromTurn({
      id: "attached-context",
      role: "user",
      blocks: [{ kind: "text", text: "Attached context" }],
      attachments: [{ id: "att-2", kind: "file", name: "brief.md" }],
    })).toBe("附件：brief.md");
  });

  it("keeps the active question aligned to the first visible turn", () => {
    const markers = questionMarkersFromTurns([
      { id: "u1", role: "user", blocks: [{ kind: "text", text: "First" }] },
      { id: "a1", role: "assistant", blocks: [{ kind: "text", text: "Answer" }] },
      { id: "u2", role: "user", blocks: [{ kind: "text", text: "Second" }] },
      { id: "a2", role: "assistant", blocks: [{ kind: "text", text: "Answer" }] },
      { id: "u3", role: "user", blocks: [{ kind: "text", text: "Third" }] },
    ]);

    expect(activeQuestionNumber(markers, 0)).toBe(1);
    expect(activeQuestionNumber(markers, 1)).toBe(1);
    expect(activeQuestionNumber(markers, 2)).toBe(2);
    expect(activeQuestionNumber(markers, 99)).toBe(3);
    expect(activeQuestionNumber([], 0)).toBeNull();
  });

  it("derives the visible turn from real scroll position instead of overscan", () => {
    const items = [
      { index: 0, start: 0, size: 120 },
      { index: 1, start: 120, size: 180 },
      { index: 2, start: 300, size: 160 },
      { index: 3, start: 460, size: 220 },
    ];

    expect(firstVisibleTurnIndexFromVirtualItems(items, 0)).toBe(0);
    expect(firstVisibleTurnIndexFromVirtualItems(items, 126)).toBe(1);
    expect(firstVisibleTurnIndexFromVirtualItems(items, 300)).toBe(2);
    expect(firstVisibleTurnIndexFromVirtualItems(items, 900)).toBe(3);
    expect(firstVisibleTurnIndexFromVirtualItems([], 300)).toBe(0);
  });
});
