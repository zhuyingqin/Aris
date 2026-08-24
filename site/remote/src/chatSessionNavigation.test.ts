import { describe, expect, it } from "vitest";

import { newestChatSessionId } from "./chatSessionNavigation";

describe("newestChatSessionId", () => {
  it("opens the most recently updated desktop conversation even when the response is unsorted", () => {
    expect(newestChatSessionId([
      { sessionId: "older", updatedAtUnixMs: 1_000 },
      { sessionId: "latest", updatedAtUnixMs: 3_000 },
      { sessionId: "middle", updatedAtUnixMs: 2_000 },
    ])).toBe("latest");
  });

  it("keeps the gateway order as the deterministic tie breaker", () => {
    expect(newestChatSessionId([
      { sessionId: "first", updatedAtUnixMs: 3_000 },
      { sessionId: "second", updatedAtUnixMs: 3_000 },
    ])).toBe("first");
  });

  it("does not select a conversation when the desktop has none", () => {
    expect(newestChatSessionId([])).toBeNull();
  });
});
