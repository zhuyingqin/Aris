import { describe, expect, it } from "vitest";

import { ChatEventCursorStore, MAX_RETAINED_CHAT_EVENT_CURSORS } from "./chatEventCursor";

describe("ChatEventCursorStore", () => {
  it("resumes a conversation from the last sequence it consumed", () => {
    const cursors = new ChatEventCursorStore();
    expect(cursors.resume("project", "session")).toBeNull();

    cursors.remember("project", "session", 42);

    expect(cursors.resume("project", "session")).toBe(42);
  });

  it("never rewinds a cursor when a superseded transport reports a stale batch", () => {
    const cursors = new ChatEventCursorStore();
    cursors.remember("project", "session", 90);

    cursors.remember("project", "session", 12);

    expect(cursors.resume("project", "session")).toBe(90);
  });

  it("keeps conversations with equal ids in different projects apart", () => {
    const cursors = new ChatEventCursorStore();
    cursors.remember("alpha", "shared", 7);
    cursors.remember("beta", "shared", 19);

    expect(cursors.resume("alpha", "shared")).toBe(7);
    expect(cursors.resume("beta", "shared")).toBe(19);
  });

  it("cannot be confused by ids that would collide under naive concatenation", () => {
    const cursors = new ChatEventCursorStore();
    cursors.remember("ab", "c", 3);
    cursors.remember("a", "bc", 8);

    expect(cursors.resume("ab", "c")).toBe(3);
    expect(cursors.resume("a", "bc")).toBe(8);
  });

  it("forgets one conversation when its transcript is reloaded", () => {
    const cursors = new ChatEventCursorStore();
    cursors.remember("project", "kept", 5);
    cursors.remember("project", "reloaded", 6);

    cursors.forget("project", "reloaded");

    expect(cursors.resume("project", "reloaded")).toBeNull();
    expect(cursors.resume("project", "kept")).toBe(5);
  });

  it("forgets every conversation when the paired desktop changes", () => {
    const cursors = new ChatEventCursorStore();
    cursors.remember("project", "one", 5);
    cursors.remember("project", "two", 6);

    cursors.clear();

    expect(cursors.size).toBe(0);
  });

  it("ignores sequences that are not usable cursors", () => {
    const cursors = new ChatEventCursorStore();

    cursors.remember("project", "session", Number.NaN);
    cursors.remember("project", "session", -1);
    cursors.remember("project", "session", 1.5);
    cursors.remember("project", "session", Number.MAX_SAFE_INTEGER + 2);

    expect(cursors.resume("project", "session")).toBeNull();
  });

  it("evicts the oldest cursor once the retention bound is exceeded", () => {
    const cursors = new ChatEventCursorStore();
    for (let index = 0; index < MAX_RETAINED_CHAT_EVENT_CURSORS; index += 1) {
      cursors.remember("project", `session-${index}`, index + 1);
    }
    // Keep the oldest conversation in use; only an untouched one may be lost.
    cursors.remember("project", "session-0", 100);

    cursors.remember("project", "overflow", 1);

    expect(cursors.size).toBe(MAX_RETAINED_CHAT_EVENT_CURSORS);
    expect(cursors.resume("project", "session-0")).toBe(100);
    expect(cursors.resume("project", "session-1")).toBeNull();
    expect(cursors.resume("project", "overflow")).toBe(1);
  });
});
