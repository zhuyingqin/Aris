// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatTurn } from "../../types";

const apiMocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
  chatEventsReplay: vi.fn(),
  chatUiSessionsList: vi.fn(),
  chatUiSessionLoad: vi.fn(),
  chatUiSessionSave: vi.fn(() => Promise.resolve()),
  chatUiSessionDelete: vi.fn(() => Promise.resolve()),
  chatUiSessionsLoad: vi.fn(),
  chatUiSessionsSave: vi.fn(() => Promise.resolve()),
  onRemoteChatSessionUpdated: vi.fn(() => Promise.resolve(() => undefined)),
}));

vi.mock("../../api/tauri", () => apiMocks);

import { CURRENT_KEY, SESSIONS_KEY, makeId, makeSession } from "../model";
import { useChatSessions } from "../useChatSessions";

function startedSession(id: string, text: string) {
  const session = makeSession("default");
  session.id = id;
  session.title = text;
  session.turns = [{ id: `${id}-turn`, role: "user", blocks: [{ kind: "text", text }] }];
  return session;
}


beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  apiMocks.isTauri.mockReturnValue(false);
  apiMocks.chatEventsReplay.mockResolvedValue({ sessionId: "chat", eventCount: 0, lastSeq: 0, turns: [] });
  apiMocks.chatUiSessionsList.mockResolvedValue([]);
  apiMocks.chatUiSessionLoad.mockResolvedValue(null);
  apiMocks.chatUiSessionSave.mockResolvedValue(undefined);
  apiMocks.chatUiSessionDelete.mockResolvedValue(undefined);
  apiMocks.chatUiSessionsLoad.mockResolvedValue([]);
  apiMocks.chatUiSessionsSave.mockResolvedValue(undefined);
  apiMocks.onRemoteChatSessionUpdated.mockResolvedValue(() => undefined);
});

afterEach(() => cleanup());

describe("useChatSessions local persistence", () => {
  it("restores the last active chat and keeps saved sessions in history", async () => {
    const old = makeSession("default");
    old.id = "old-chat";
    old.title = "Old chat";
    old.createdAt = 1;
    old.updatedAt = 1;
    old.turns = [{ id: "old-turn", role: "user", blocks: [{ kind: "text", text: "old" }] }];
    const recent = makeSession("default");
    recent.id = "recent-chat";
    recent.title = "Recent chat";
    recent.createdAt = 2;
    recent.updatedAt = 2;
    recent.turns = [{ id: "recent-turn", role: "user", blocks: [{ kind: "text", text: "recent" }] }];
    localStorage.setItem(SESSIONS_KEY, JSON.stringify([old, recent]));
    localStorage.setItem(CURRENT_KEY, old.id);

    const { result } = renderHook(() => useChatSessions());

    await waitFor(() => expect(result.current.currentId).toBe(old.id));
    expect(result.current.currentSession?.title).toBe("Old chat");
    expect(result.current.currentSession?.turns).toHaveLength(1);
    expect(result.current.sessions).toHaveLength(2);
    expect(result.current.sessions.some((session) => session.id === old.id)).toBe(true);
    expect(result.current.sessions.some((session) => session.id === recent.id)).toBe(true);
  });

  it("falls back to the most recently updated chat when no current id is saved", async () => {
    const old = makeSession("default");
    old.id = "old-chat";
    old.updatedAt = 1;
    old.turns = [{ id: "old-turn", role: "user", blocks: [{ kind: "text", text: "old" }] }];
    const recent = makeSession("default");
    recent.id = "recent-chat";
    recent.updatedAt = 2;
    recent.turns = [{ id: "recent-turn", role: "user", blocks: [{ kind: "text", text: "recent" }] }];
    localStorage.setItem(SESSIONS_KEY, JSON.stringify([old, recent]));

    const { result } = renderHook(() => useChatSessions());

    await waitFor(() => expect(result.current.currentId).toBe(recent.id));
    expect(result.current.currentSession?.turns[0]).toMatchObject({
      role: "user",
      blocks: [{ kind: "text", text: "recent" }],
    });
  });

  it("retains a draft per session", async () => {
    const { result } = renderHook(() => useChatSessions());
    await waitFor(() => expect(result.current.currentSession).not.toBeNull());
    let first = "";
    const turn: ChatTurn = { id: makeId("turn"), role: "user", blocks: [{ kind: "text", text: "hello" }] };

    act(() => {
      first = result.current.materializeCurrentSession()?.id ?? "";
    });
    await waitFor(() => expect(result.current.currentId).toBe(first));
    act(() => {
      result.current.setDraft(first, "first draft");
      result.current.patchTurns(first, () => [turn]);
    });
    let second = "";
    act(() => {
      second = result.current.newSession();
      result.current.setCurrentId(second);
    });
    act(() => result.current.setDraft(second, "second draft"));
    act(() => result.current.setCurrentId(first));

    expect(result.current.currentSession?.draft).toBe("first draft");
    act(() => result.current.setCurrentId(second));
    expect(result.current.currentSession?.draft).toBe("second draft");
  });

  it("does not create duplicate blank sessions", async () => {
    const { result } = renderHook(() => useChatSessions());
    await waitFor(() => expect(result.current.currentSession).not.toBeNull());
    const count = result.current.sessions.length;
    const existing = result.current.currentId;
    let created = "";

    act(() => {
      created = result.current.newSession();
    });

    expect(created).toBe(existing);
    expect(result.current.sessions).toHaveLength(count);
  });

  it("clears the transient home draft when New chat is pressed again", async () => {
    const { result } = renderHook(() => useChatSessions());
    await waitFor(() => expect(result.current.currentSession).not.toBeNull());

    act(() => result.current.setDraft(result.current.currentId, "discard this draft"));
    expect(result.current.currentSession?.draft).toBe("discard this draft");
    act(() => {
      result.current.newSession();
    });

    expect(result.current.currentSession?.draft).toBe("");
    expect(result.current.sessions).toHaveLength(0);
  });

  it("restores a removed session for delete undo", async () => {
    const { result } = renderHook(() => useChatSessions());
    await waitFor(() => expect(result.current.currentSession).not.toBeNull());
    let id = "";
    const turn: ChatTurn = { id: makeId("turn"), role: "user", blocks: [{ kind: "text", text: "hello" }] };
    act(() => {
      id = result.current.materializeCurrentSession()?.id ?? "";
    });
    act(() => {
      result.current.patchTurns(id, () => [turn]);
    });
    await waitFor(() => expect(result.current.sessions.some((session) => session.id === id)).toBe(true));
    let removed = result.current.currentSession;

    act(() => {
      removed = result.current.removeSession(id);
    });
    expect(result.current.sessions.some((session) => session.id === id)).toBe(false);
    act(() => {
      if (removed) result.current.restoreSession(removed);
    });
    expect(result.current.sessions.some((session) => session.id === id)).toBe(true);
  });

  it("keeps chats isolated when switching projects", async () => {
    const { result, rerender } = renderHook(
      ({ projectId }) => useChatSessions(projectId),
      { initialProps: { projectId: "project-a" } },
    );
    await waitFor(() => expect(result.current.currentSession?.projectId).toBe("project-a"));
    let first = "";
    const turn: ChatTurn = { id: makeId("turn"), role: "user", blocks: [{ kind: "text", text: "project a" }] };
    act(() => {
      first = result.current.materializeCurrentSession()?.id ?? "";
    });
    act(() => {
      result.current.patchTurns(first, () => [turn]);
    });

    rerender({ projectId: "project-b" });
    await waitFor(() => expect(result.current.currentSession?.projectId).toBe("project-b"));

    expect(result.current.currentId).not.toBe(first);
    expect(result.current.allSessions.some((session) => session.projectId === "project-a")).toBe(true);
  });
});

describe("useChatSessions Tauri persistence", () => {
  beforeEach(() => {
    apiMocks.isTauri.mockReturnValue(true);
    apiMocks.chatEventsReplay.mockResolvedValue({ sessionId: "chat", eventCount: 0, lastSeq: 0, turns: [] });
    apiMocks.chatUiSessionsList.mockResolvedValue([]);
    apiMocks.chatUiSessionLoad.mockRejectedValue(new Error("not mocked"));
    apiMocks.chatUiSessionSave.mockResolvedValue(undefined);
    apiMocks.chatUiSessionDelete.mockResolvedValue(undefined);
    apiMocks.chatUiSessionsLoad.mockResolvedValue([]);
    apiMocks.chatUiSessionsSave.mockResolvedValue(undefined);
    apiMocks.onRemoteChatSessionUpdated.mockResolvedValue(() => undefined);
  });

  it("hydrates Tauri summaries without parsing localStorage or loading turns", async () => {
    const parseSpy = vi.spyOn(JSON, "parse");
    localStorage.setItem(SESSIONS_KEY, JSON.stringify([startedSession("large-local", "large local")]));
    localStorage.setItem(CURRENT_KEY, "large-local");
    apiMocks.chatUiSessionsList.mockResolvedValue([{
      ...startedSession("backend-chat", "backend"),
      turns: [],
      turnsLoaded: false,
      turnCount: 1,
    }]);
    apiMocks.chatUiSessionLoad.mockResolvedValue(startedSession("backend-chat", "backend"));

    const { result } = renderHook(() => useChatSessions("default"));

    expect(result.current.allSessions).toEqual([]);
    expect(parseSpy).not.toHaveBeenCalled();

    await waitFor(() => expect(result.current.allSessions.map((session) => session.id)).toEqual(["backend-chat"]));
    expect(result.current.currentId).toBe("chat-home");
    expect(localStorage.getItem(SESSIONS_KEY)).toBeNull();
    expect(apiMocks.chatUiSessionLoad).not.toHaveBeenCalled();
  });

  it("reloads a persisted remote turn instead of retaining its stale session summary", async () => {
    let remoteUpdateHandler: ((event: { sessionId: string }) => void) | undefined;
    (apiMocks.onRemoteChatSessionUpdated as unknown as {
      mockImplementation: (implementation: (handler: (event: { sessionId: string }) => void) => Promise<() => void>) => void;
    }).mockImplementation((handler) => {
      remoteUpdateHandler = handler;
      return Promise.resolve(() => undefined);
    });
    const summary = {
      ...startedSession("remote-chat", "stale summary"),
      turns: [],
      turnsLoaded: false,
      turnCount: 1,
      updatedAt: 100,
    };
    const saved = {
      ...startedSession("remote-chat", "Remote turn"),
      turns: [
        { id: "remote-user", role: "user", blocks: [{ kind: "text", text: "from phone" }] },
        { id: "remote-assistant", role: "assistant", blocks: [{ kind: "text", text: "from desktop" }] },
      ],
      turnsLoaded: true,
      turnCount: 2,
      updatedAt: 200,
    };
    apiMocks.chatUiSessionsList.mockResolvedValue([summary]);
    apiMocks.chatUiSessionLoad.mockResolvedValue(saved);

    const { result } = renderHook(() => useChatSessions("default"));

    await waitFor(() => expect(apiMocks.onRemoteChatSessionUpdated).toHaveBeenCalled());
    await waitFor(() => expect(result.current.allSessions).toHaveLength(1));
    act(() => remoteUpdateHandler?.({ sessionId: "remote-chat" }));

    await waitFor(() => expect(result.current.allSessions[0]).toMatchObject({
      id: "remote-chat",
      turnsLoaded: true,
      turnCount: 2,
      turns: [
        { id: "remote-user", blocks: [{ kind: "text", text: "from phone" }] },
        { id: "remote-assistant", blocks: [{ kind: "text", text: "from desktop" }] },
      ],
    }));
    expect(apiMocks.chatUiSessionLoad).toHaveBeenCalledWith("remote-chat");
  });

  it("renders remote chat deltas live without persisting a partial projection", async () => {
    let remoteUpdateHandler: ((event: {
      sessionId: string;
      messageId?: string;
      phase?: "started" | "delta" | "completed" | "error";
      message?: string;
      delta?: string;
      text?: string;
      persisted?: boolean;
    }) => void) | undefined;
    (apiMocks.onRemoteChatSessionUpdated as unknown as {
      mockImplementation: (implementation: (handler: (event: {
        sessionId: string;
        messageId?: string;
        phase?: "started" | "delta" | "completed" | "error";
        message?: string;
        delta?: string;
        text?: string;
        persisted?: boolean;
      }) => void) => Promise<() => void>) => void;
    }).mockImplementation((handler) => {
      remoteUpdateHandler = handler;
      return Promise.resolve(() => undefined);
    });
    const stored = startedSession("remote-live", "existing");
    apiMocks.chatUiSessionsList.mockResolvedValue([stored]);
    apiMocks.chatUiSessionLoad.mockResolvedValue(stored);

    const { result } = renderHook(() => useChatSessions("default"));

    await waitFor(() => expect(remoteUpdateHandler).toBeDefined());
    await waitFor(() => expect(result.current.allSessions).toHaveLength(1));
    act(() => remoteUpdateHandler?.({
      sessionId: "remote-live",
      messageId: "message-live",
      phase: "started",
      message: "from phone",
    }));
    act(() => remoteUpdateHandler?.({
      sessionId: "remote-live",
      messageId: "message-live",
      phase: "delta",
      delta: "live ",
    }));
    act(() => remoteUpdateHandler?.({
      sessionId: "remote-live",
      messageId: "message-live",
      phase: "delta",
      delta: "reply",
    }));

    await waitFor(() => expect(result.current.allSessions[0]?.turns.slice(-2)).toMatchObject([
      { id: "remote-message-live-user", role: "user", blocks: [{ kind: "text", text: "from phone" }] },
      {
        id: "remote-message-live-assistant",
        role: "assistant",
        blocks: [{ kind: "text", text: "live reply" }],
        streaming: true,
      },
    ]));

    act(() => remoteUpdateHandler?.({
      sessionId: "remote-live",
      messageId: "message-live",
      phase: "completed",
      text: "live reply",
      persisted: false,
    }));
    const turns = result.current.allSessions[0]?.turns ?? [];
    expect(turns[turns.length - 1]).toMatchObject({
      id: "remote-message-live-assistant",
      streaming: false,
      blocks: [{ kind: "text", text: "live reply" }],
    });
    expect(apiMocks.chatUiSessionSave).not.toHaveBeenCalled();
  });

  it("saves Tauri sessions through the backend store without writing localStorage snapshots", async () => {
    const { result } = renderHook(() => useChatSessions("default"));
    await waitFor(() => expect(apiMocks.chatUiSessionsList).toHaveBeenCalled());

    let id = "";
    const turn: ChatTurn = { id: "turn-1", role: "user", blocks: [{ kind: "text", text: "hello" }] };
    act(() => {
      id = result.current.materializeCurrentSession()?.id ?? "";
    });
    act(() => {
      result.current.patchTurns(id, () => [turn]);
    });

    await waitFor(() => expect(apiMocks.chatUiSessionSave).toHaveBeenCalled());
    expect(localStorage.getItem(SESSIONS_KEY)).toBeNull();
    expect(apiMocks.chatUiSessionSave).toHaveBeenLastCalledWith(
      expect.objectContaining({ id, turns: [turn] }),
    );
  });

  it("loads the saved Tauri turn projection before consulting event-log recovery", async () => {
    apiMocks.chatUiSessionsList.mockResolvedValue([{
      ...startedSession("event-chat", "event"),
      turns: [],
      turnsLoaded: false,
      turnCount: 1,
    }]);
    apiMocks.chatEventsReplay.mockResolvedValue({
      sessionId: "event-chat",
      eventCount: 2,
      lastSeq: 2,
      turns: [{ id: "event-turn", role: "user", blocks: [{ kind: "text", text: "event sourced" }] }],
    });
    apiMocks.chatUiSessionLoad.mockResolvedValue({
      ...startedSession("event-chat", "event"),
      turns: [{ id: "saved-turn", role: "user", blocks: [{ kind: "text", text: "saved projection" }] }],
    });

    const { result } = renderHook(() => useChatSessions("default"));

    await waitFor(() => expect(result.current.allSessions.map((session) => session.id)).toEqual(["event-chat"]));
    act(() => result.current.setCurrentId("event-chat"));

    await waitFor(() => expect(result.current.currentSession?.turns[0]).toMatchObject({
      id: "saved-turn",
      blocks: [{ kind: "text", text: "saved projection" }],
    }));
    expect(apiMocks.chatUiSessionLoad).toHaveBeenCalledWith("event-chat");
    expect(apiMocks.chatEventsReplay).not.toHaveBeenCalled();
  });

  it("falls back to event-log recovery when the saved Tauri projection is unavailable", async () => {
    apiMocks.chatUiSessionsList.mockResolvedValue([{
      ...startedSession("event-recovery-chat", "event recovery"),
      turns: [],
      turnsLoaded: false,
      turnCount: 1,
    }]);
    apiMocks.chatUiSessionLoad.mockResolvedValue(null);
    apiMocks.chatEventsReplay.mockResolvedValue({
      sessionId: "event-recovery-chat",
      eventCount: 2,
      lastSeq: 2,
      turns: [{ id: "event-turn", role: "user", blocks: [{ kind: "text", text: "event sourced" }] }],
    });

    const { result } = renderHook(() => useChatSessions("default"));

    await waitFor(() => expect(result.current.allSessions.map((session) => session.id)).toEqual(["event-recovery-chat"]));
    act(() => result.current.setCurrentId("event-recovery-chat"));

    await waitFor(() => expect(result.current.currentSession?.turns[0]).toMatchObject({
      id: "event-turn",
      blocks: [{ kind: "text", text: "event sourced" }],
    }));
    expect(apiMocks.chatUiSessionLoad).toHaveBeenCalledWith("event-recovery-chat");
    expect(apiMocks.chatEventsReplay).toHaveBeenCalledWith("event-recovery-chat");
  });
});
