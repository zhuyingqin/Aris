import { describe, expect, it } from "vitest";

import type { RemoteTranscriptMessage } from "./chatBlocks";
import {
  anchoredScrollTop,
  CHAT_LOG_FOLLOW_THRESHOLD_PX,
  olderTranscriptPrefix,
  shouldFollowChatLogBottom,
} from "./chatHistory";

function message(role: "user" | "assistant", text: string): RemoteTranscriptMessage {
  return { role, text, blocks: [] };
}

describe("chat history backfill", () => {
  it("returns only the older prefix from an expanded latest-message window", () => {
    const recent = [message("user", "three"), message("assistant", "four")];
    const expanded = [message("user", "one"), message("assistant", "two"), ...recent];
    expect(olderTranscriptPrefix(expanded, recent)).toEqual(expanded.slice(0, 2));
  });

  it("still finds the rendered window when a new live message follows it", () => {
    const recent = [message("user", "two"), message("assistant", "three")];
    const expanded = [message("assistant", "one"), ...recent, message("user", "live")];
    expect(olderTranscriptPrefix(expanded, recent)).toEqual(expanded.slice(0, 1));
  });

  it("uses the newest matching range for repeated messages", () => {
    const repeated = message("assistant", "same");
    const expanded = [repeated, message("user", "middle"), repeated];
    expect(olderTranscriptPrefix(expanded, [repeated])).toEqual(expanded.slice(0, 2));
  });

  it("rejects an expanded window that no longer contains the rendered messages", () => {
    expect(olderTranscriptPrefix(
      [message("assistant", "changed")],
      [message("assistant", "original")],
    )).toBeNull();
  });

  it("preserves the visible content offset after prepending older nodes", () => {
    expect(anchoredScrollTop(320, 1_200, 1_760)).toBe(880);
    expect(anchoredScrollTop(0, 800, 700)).toBe(0);
  });
});

describe("streaming scroll follow", () => {
  it("keeps following a reader who is sitting at the end of the transcript", () => {
    // scrollTop 2_421 of a 3_093 tall log showing 672px: exactly at the bottom.
    expect(shouldFollowChatLogBottom(2_421, 3_093, 672)).toBe(true);
  });

  it("leaves a reader alone once they scroll up to re-read something", () => {
    // The measured failure case: parked 2_221px above the bottom mid-stream.
    expect(shouldFollowChatLogBottom(200, 3_093, 672)).toBe(false);
  });

  it("absorbs the rounding drift momentum scrolling leaves behind", () => {
    expect(shouldFollowChatLogBottom(2_421 - CHAT_LOG_FOLLOW_THRESHOLD_PX, 3_093, 672)).toBe(true);
    expect(shouldFollowChatLogBottom(2_421 - CHAT_LOG_FOLLOW_THRESHOLD_PX - 1, 3_093, 672))
      .toBe(false);
  });

  it("follows a transcript that does not fill its viewport yet", () => {
    // Nothing has been scrolled away from, so there is no position to defend.
    expect(shouldFollowChatLogBottom(0, 400, 672)).toBe(true);
  });

  it("treats a scroll position past the end as following", () => {
    // iOS rubber-band scrolling reports a scrollTop beyond the real maximum.
    expect(shouldFollowChatLogBottom(2_600, 3_093, 672)).toBe(true);
  });
});
