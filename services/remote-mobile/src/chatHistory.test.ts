import { describe, expect, it } from "vitest";

import type { RemoteTranscriptMessage } from "./chatBlocks";
import { anchoredScrollTop, olderTranscriptPrefix } from "./chatHistory";

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
