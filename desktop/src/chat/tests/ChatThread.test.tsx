// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type { ChatTurn } from "../../types";
import {
  NEAR_BOTTOM_THRESHOLD,
  activeQuestionNumber,
  chatThreadClassName,
  compensateAboveViewportResize,
  composerGrowthAdjustment,
  firstVisibleTurnIndexFromVirtualItems,
  isNearBottom,
  isScrollNavigationKey,
  isUpwardNavigationKey,
  nextOmittedTurnToReveal,
  questionMarkersFromTurns,
  questionPreviewFromTurn,
  rowsNeedingReestimate,
  scrollBottomLabel,
  shouldIgnoreProgrammaticScroll,
  shouldLoadEarlierTurnsAtTop,
} from "../ChatThread";
import {
  clearTurnMeasurements,
  estimateTurnSize,
  readTurnMeasurements,
  setMessageColumns,
  textColumnsForWidth,
  turnVirtualKey,
  writeTurnMeasurements,
} from "../transcriptMetrics";

describe("ChatThread scroll and timeline helpers", () => {
  it("localizes the return-to-bottom control", () => {
    expect(scrollBottomLabel("cn")).toBe("回到底部");
    expect(scrollBottomLabel("en")).toBe("Back to bottom");
  });

  it("marks the transcript's earlier-history and question-timeline states", () => {
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

  it("uses one threshold for 'parked at the bottom'", () => {
    // The virtualizer's `scrollEndThreshold` is configured from this constant, so
    // bottom anchoring and the return-to-bottom control cannot disagree about
    // whether the reader is following.
    const parked = { scrollHeight: 1000, clientHeight: 200 };
    const edge = 1000 - 200 - NEAR_BOTTOM_THRESHOLD;
    expect(isNearBottom({ ...parked, scrollTop: edge })).toBe(true);
    expect(isNearBottom({ ...parked, scrollTop: edge - 1 })).toBe(false);
  });

  it("requests earlier history only after the reader reaches the top edge", () => {
    expect(shouldLoadEarlierTurnsAtTop({ scrollTop: 96 })).toBe(true);
    expect(shouldLoadEarlierTurnsAtTop({ scrollTop: 97 })).toBe(false);
  });

  it("ignores the immediate scroll event from explicit navigation", () => {
    expect(shouldIgnoreProgrammaticScroll(180, 100)).toBe(true);
    expect(shouldIgnoreProgrammaticScroll(180, 220)).toBe(false);
  });

  it("treats only backward keys as a request to move up through history", () => {
    for (const key of ["ArrowUp", "PageUp", "Home"]) {
      expect(isUpwardNavigationKey(key)).toBe(true);
    }
    for (const key of ["ArrowDown", "PageDown", "End", "a", "Enter"]) {
      expect(isUpwardNavigationKey(key)).toBe(false);
    }
  });

  it("ignores typing inside a message when deciding the reader is navigating", () => {
    // A question card or a code block inside a turn takes keystrokes; those are
    // not a request to walk back through history.
    for (const key of ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]) {
      expect(isScrollNavigationKey(key)).toBe(true);
    }
    for (const key of ["a", "Enter", "Backspace", "Tab", "Escape"]) {
      expect(isScrollNavigationKey(key)).toBe(false);
    }
  });

  it("compensates an above-viewport resize regardless of scroll direction", () => {
    const instance = { scrollElement: { scrollTop: 900 }, scrollOffset: 400 };
    // Above the viewport: the reader's content would shift without an adjustment.
    expect(compensateAboveViewportResize({ start: 100 }, instance)).toBe(true);
    // At or below the viewport top: growth lands below the reader, leave it.
    expect(compensateAboveViewportResize({ start: 900 }, instance)).toBe(false);
    expect(compensateAboveViewportResize({ start: 1_400 }, instance)).toBe(false);
    // The live scrollTop wins over the last observed offset, which lags behind
    // adjustments the virtualizer has already written.
    expect(compensateAboveViewportResize({ start: 500 }, instance)).toBe(true);
    expect(
      compensateAboveViewportResize({ start: 500 }, { scrollElement: null, scrollOffset: 400 }),
    ).toBe(false);
  });

  it("follows the composer only when it grows", () => {
    // Growing it hides the newest line behind the composer unless the viewport
    // follows; shrinking is already handled by the browser clamping scrollTop.
    expect(composerGrowthAdjustment(144, 204)).toBe(60);
    expect(composerGrowthAdjustment(204, 144)).toBe(0);
    expect(composerGrowthAdjustment(144, 144)).toBe(0);
  });

  it("reveals one omitted turn per commit, nearest the reader", () => {
    const rows = [
      { index: 4, omittedTurnIndex: 40, loading: false },
      { index: 7, omittedTurnIndex: 70, loading: false },
      { index: 8, omittedTurnIndex: 80, loading: true },
      { index: 9, omittedTurnIndex: null, loading: false },
    ];
    expect(nextOmittedTurnToReveal(rows, 7)).toBe(70);
    expect(nextOmittedTurnToReveal(rows, 3)).toBe(40);
    // An in-flight row is not requested again, and a windowful of them never
    // fires at once — each is a large saved turn.
    expect(nextOmittedTurnToReveal(rows, 8)).toBe(70);
    expect(nextOmittedTurnToReveal([{ index: 1, omittedTurnIndex: null, loading: false }], 1))
      .toBeNull();
    expect(nextOmittedTurnToReveal([], 0)).toBeNull();
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

  it("keeps one measurement key for an omitted slot across hydration", () => {
    // The placeholder's id is synthetic and the loaded turn carries its own, so
    // keying on the id orphaned the measured height at the exact moment the row
    // grew from a one-line notice into the full turn.
    const placeholder: ChatTurn = {
      id: "session-7-large-turn-12",
      role: "assistant",
      blocks: [{ kind: "notice", message: "A large saved turn was omitted." }],
      omittedTurnIndex: 12,
    };
    const hydrated: ChatTurn = {
      id: "turn-real-id",
      role: "assistant",
      blocks: [{ kind: "text", text: "the real content" }],
      omittedTurnIndex: 12,
      omittedHydrated: true,
    };
    expect(turnVirtualKey(placeholder, 3)).toBe("omitted:12");
    expect(turnVirtualKey(hydrated, 3)).toBe(turnVirtualKey(placeholder, 3));
    expect(turnVirtualKey({ id: "plain", role: "user", blocks: [] }, 3)).toBe("plain");
    expect(turnVirtualKey(undefined, 3)).toBe(3);
  });

  it("estimates a row from its content instead of one flat number", () => {
    const short = estimateTurnSize({
      id: "a",
      role: "user",
      blocks: [{ kind: "text", text: "hi" }],
    });
    const long = estimateTurnSize({
      id: "b",
      role: "assistant",
      blocks: [{ kind: "text", text: "word ".repeat(400) }],
    });
    expect(long).toBeGreaterThan(short * 4);

    // A collapsed tool card is one row however large its output is: the card's
    // body is not rendered until the reader expands it.
    const bigOutput = estimateTurnSize({
      id: "c",
      role: "assistant",
      blocks: [{ kind: "tool", name: "bash", input: "{}", output: "x".repeat(50_000) }],
    });
    expect(bigOutput).toBeLessThan(200);

    // CJK glyphs are two columns wide, so the same character count has to
    // estimate taller than Latin text rather than half as tall.
    const latin = estimateTurnSize({
      id: "d",
      role: "user",
      blocks: [{ kind: "text", text: "a".repeat(400) }],
    });
    const chinese = estimateTurnSize({
      id: "e",
      role: "user",
      blocks: [{ kind: "text", text: "中".repeat(400) }],
    });
    expect(chinese).toBeGreaterThan(latin);
  });

  it("estimates against the column width the transcript actually has", () => {
    // A transcript sharing the window with the side panel wraps the same message
    // into far more lines. Estimating it at the full-width column left every
    // unmeasured row short, which is a jump waiting for the reader to scroll.
    const turn: ChatTurn = {
      id: "wide-vs-narrow",
      role: "assistant",
      blocks: [{ kind: "text", text: "word ".repeat(300) }],
    };
    const full = textColumnsForWidth(820);
    const split = textColumnsForWidth(420);
    expect(full).toBeGreaterThan(split);
    expect(estimateTurnSize(turn, split)).toBeGreaterThan(estimateTurnSize(turn, full));

    // A wider pane than the message column cannot make the column wider, and a
    // width that is missing or absurd falls back to the full column.
    expect(textColumnsForWidth(2_000)).toBe(full);
    expect(textColumnsForWidth(0)).toBe(full);
    expect(textColumnsForWidth(Number.NaN)).toBe(full);
    expect(textColumnsForWidth(10)).toBeGreaterThan(0);
  });

  it("only replays a session's measured heights at the width they were taken at", () => {
    // The snapshot exists so reopening a conversation does not start from
    // estimates. Replaying heights measured at another width is worse than an
    // estimate: every one of them is wrong, and none of them can notice.
    const items = [{ index: 0, key: "turn-0", start: 0, end: 120, size: 120, lane: 0 }];
    setMessageColumns(textColumnsForWidth(820));
    writeTurnMeasurements("session-a", items);
    expect(readTurnMeasurements("session-a")).toHaveLength(1);

    setMessageColumns(textColumnsForWidth(420));
    expect(readTurnMeasurements("session-a")).toHaveLength(0);

    setMessageColumns(textColumnsForWidth(820));
    expect(readTurnMeasurements("session-a")).toHaveLength(1);
    clearTurnMeasurements("session-a");
    expect(readTurnMeasurements("session-a")).toHaveLength(0);
  });

  it("re-estimates every row a width change left unmeasurable", () => {
    // The mounted rows are excluded: the browser has already re-measured them
    // through the virtualizer's own ResizeObserver.
    expect(rowsNeedingReestimate(6, [2, 3, 4])).toEqual([0, 1, 5]);
    expect(rowsNeedingReestimate(3, [])).toEqual([0, 1, 2]);
    expect(rowsNeedingReestimate(0, [0])).toEqual([]);
  });
});
