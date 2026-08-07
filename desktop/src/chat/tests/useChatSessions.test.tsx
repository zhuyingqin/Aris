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
  chatUiSessionsSave: vi.fn(() => Promise.resolve()),
  onRemoteChatSessionUpdated: vi.fn(() => Promise.resolve(() => undefined)),
  onChatUiSessionUpdated: vi.fn(() => Promise.resolve(() => undefined)),
  // Session bootstrap materialises workflow-owned sessions alongside stored
  // ones. Leaving these undefined made the whole hydrate effect throw, which
  // failed every test in this file for a reason unrelated to what they assert.
  reviewWorkflowsList: vi.fn(() => Promise.resolve([])),
  reviewWorkflowTranscript: vi.fn(),
  listenReviewWorkflowSessionUpdated: vi.fn(
    (_handler: (event: { projectId: string; runId: string; sessionId: string }) => void) =>
      Promise.resolve(() => undefined),
  ),
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
  apiMocks.chatUiSessionsSave.mockResolvedValue(undefined);
  apiMocks.onRemoteChatSessionUpdated.mockResolvedValue(() => undefined);
});

afterEach(() => cleanup());

describe("useChatSessions local persistence", () => {
  it("keeps the visible workflow transcript while a workflow update replays newer audit events", async () => {
    apiMocks.isTauri.mockReturnValue(true);
    let workflowUpdated: ((event: { projectId: string; runId: string; sessionId: string }) => void) | undefined;
    apiMocks.listenReviewWorkflowSessionUpdated.mockImplementation((handler) => {
      workflowUpdated = handler;
      return Promise.resolve(() => undefined);
    });
    let resolveReplay: ((value: { sessionId: string; eventCount: number; lastSeq: number; turns: ChatTurn[] }) => void) | undefined;
    apiMocks.reviewWorkflowTranscript.mockReturnValue(new Promise((resolve) => {
      resolveReplay = resolve;
    }));
    const workflow = {
      ...startedSession("workflow-chat", "existing workflow turn"),
      workflowRunId: "workflow-run",
      workflowContextKey: "review-workflow:workflow-run",
      ownerKind: "review_workflow" as const,
      turnsLoaded: true,
      turnCount: 1,
    };
    apiMocks.chatUiSessionsList.mockResolvedValue([workflow]);
    localStorage.setItem(CURRENT_KEY, workflow.id);

    const { result } = renderHook(() => useChatSessions("default"));
    // Tauri starts with no in-memory summaries, so the restored current id is
    // selected after native hydration (the same way the sidebar does it).
    await waitFor(() => expect(result.current.allSessions.some((session) => session.id === workflow.id)).toBe(true));
    act(() => result.current.setCurrentId(workflow.id));
    await waitFor(() => expect(result.current.currentSession?.turns[0]?.id).toBe("workflow-chat-turn"));
    await waitFor(() => expect(workflowUpdated).toBeTruthy());

    act(() => workflowUpdated?.({
      projectId: "default",
      runId: "workflow-run",
      sessionId: "workflow-chat",
    }));

    // The old implementation flipped turnsLoaded to false here, which made
    // currentSession null and hid the entire active workflow Chat.
    expect(result.current.currentSession?.turns[0]?.id).toBe("workflow-chat-turn");
    expect(result.current.currentSession?.turnsLoaded).toBe(true);

    await act(async () => {
      resolveReplay?.({
        sessionId: "workflow-chat",
        eventCount: 2,
        lastSeq: 2,
        turns: [
          ...workflow.turns,
          { id: "workflow-new-turn", role: "assistant", blocks: [{ kind: "text", text: "new workflow result" }] },
        ],
      });
    });
    await waitFor(() => expect(result.current.currentSession?.turns.at(-1)?.id).toBe("workflow-new-turn"));
  });

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
    apiMocks.chatUiSessionsSave.mockResolvedValue(undefined);
    apiMocks.onRemoteChatSessionUpdated.mockResolvedValue(() => undefined);
    apiMocks.onChatUiSessionUpdated.mockResolvedValue(() => undefined);
  });

  it("restores a newer local crash snapshot alongside persisted Tauri summaries", async () => {
    const crashed = { ...startedSession("crashed-chat", "recover this chat"), updatedAt: 200 };
    localStorage.setItem(SESSIONS_KEY, JSON.stringify([crashed]));
    const summary = {
      ...startedSession("backend-chat", "backend"),
      turns: [],
      turnsLoaded: false,
      turnCount: 1,
      updatedAt: 100,
    };
    apiMocks.chatUiSessionsList.mockResolvedValue([summary]);
    apiMocks.chatUiSessionLoad.mockResolvedValue(startedSession("backend-chat", "backend"));

    const { result } = renderHook(() => useChatSessions("default"));

    expect(result.current.allSessions).toEqual([]);

    await waitFor(() => expect(result.current.allSessions.map((session) => session.id)).toEqual([
      "backend-chat",
      "crashed-chat",
    ]));
    expect(result.current.currentId).toBe("chat-home");
    await waitFor(() => expect(apiMocks.chatUiSessionSave).toHaveBeenCalledWith(expect.objectContaining({
      id: crashed.id,
      title: crashed.title,
      updatedAt: crashed.updatedAt,
      turns: expect.arrayContaining([
        expect.objectContaining({ id: "crashed-chat-turn", role: "user" }),
      ]),
    })));
    expect(localStorage.getItem(SESSIONS_KEY)).toBeNull();
    expect(apiMocks.chatUiSessionLoad).not.toHaveBeenCalled();
  });

  it("prepends saved preview batches until the full conversation is loaded", async () => {
    const allTurns = Array.from({ length: 30 }, (_, index): ChatTurn => ({
      id: `turn-${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      blocks: [{ kind: "text", text: `message ${index}` }],
    }));
    const summary = {
      ...makeSession("default"),
      id: "partial-chat",
      title: "Partial chat",
      turns: [],
      turnsLoaded: false,
      turnsPartial: true,
      turnCount: allTurns.length,
      loadedTurnStartIndex: 18,
      questionCountBeforeLoadedTurns: 9,
    };
    const preview = {
      ...summary,
      turns: allTurns.slice(18),
      turnsLoaded: true,
      partialBaseTurnIds: allTurns.slice(18).map((turn) => turn.id),
    };
    apiMocks.chatUiSessionsList.mockResolvedValue([summary]);
    apiMocks.chatUiSessionLoad.mockResolvedValue(preview);

    const { result } = renderHook(() => useChatSessions("default"));
    await waitFor(() => expect(result.current.allSessions).toHaveLength(1));
    act(() => result.current.setCurrentId("partial-chat"));
    await waitFor(() => expect(result.current.currentSession?.turns).toHaveLength(12));

    act(() => result.current.prependEarlierTurns("partial-chat", 6, allTurns.slice(6, 18)));
    expect(result.current.currentSession).toMatchObject({
      turnsPartial: true,
      turnCount: 30,
      loadedTurnStartIndex: 6,
      questionCountBeforeLoadedTurns: 3,
    });
    expect(result.current.currentSession?.turns.map((turn) => turn.id)).toEqual(
      allTurns.slice(6).map((turn) => turn.id),
    );
    expect(result.current.currentSession?.partialBaseTurnIds).toHaveLength(24);

    act(() => result.current.prependEarlierTurns("partial-chat", 0, allTurns.slice(0, 6)));
    expect(result.current.currentSession?.turns.map((turn) => turn.id)).toEqual(
      allTurns.map((turn) => turn.id),
    );
    expect(result.current.currentSession).toMatchObject({
      turnsPartial: false,
      turnCount: 30,
      loadedTurnStartIndex: 0,
      questionCountBeforeLoadedTurns: 0,
    });
    expect(result.current.currentSession?.partialBaseTurnIds).toBeUndefined();
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

  it("keeps the live composer draft when a save's own broadcast echo reloads the session", async () => {
    // A per-session save emits `chat-ui-session-updated` to every webview,
    // including the one that saved. That echo must not reload the disk copy
    // over the draft the user is still typing — doing so snapped the controlled
    // textarea value back mid-keystroke and aborted IME composition.
    let sessionUpdatedHandler: ((event: { sessionId: string; operation?: string }) => void) | undefined;
    (apiMocks.onChatUiSessionUpdated as unknown as {
      mockImplementation: (implementation: (handler: NonNullable<typeof sessionUpdatedHandler>) => Promise<() => void>) => void;
    }).mockImplementation((handler) => {
      sessionUpdatedHandler = handler;
      return Promise.resolve(() => undefined);
    });
    const stored = { ...startedSession("echo-chat", "hello"), turnsLoaded: true, turnCount: 1, updatedAt: 100 };
    apiMocks.chatUiSessionsList.mockResolvedValue([stored]);
    // The persisted copy the echo reloads still holds the pre-keystroke draft.
    apiMocks.chatUiSessionLoad.mockResolvedValue({ ...stored, draft: "" });

    const { result } = renderHook(() => useChatSessions("default"));
    await waitFor(() => expect(result.current.allSessions.some((session) => session.id === "echo-chat")).toBe(true));
    act(() => result.current.setCurrentId("echo-chat"));
    await waitFor(() => expect(result.current.currentSession?.id).toBe("echo-chat"));

    act(() => result.current.setDraft("echo-chat", "半成品的中文草稿"));
    expect(result.current.currentSession?.draft).toBe("半成品的中文草稿");

    await act(async () => {
      sessionUpdatedHandler?.({ sessionId: "echo-chat", operation: "saved" });
      await Promise.resolve();
    });

    expect(result.current.currentSession?.draft).toBe("半成品的中文草稿");
  });

  it("preserves the live draft while adopting newer turns from a cross-window reload", async () => {
    // When a companion window (or paired phone) genuinely appends a turn, the
    // reload must show it — but still keep the local composer draft intact.
    let sessionUpdatedHandler: ((event: { sessionId: string; operation?: string }) => void) | undefined;
    (apiMocks.onChatUiSessionUpdated as unknown as {
      mockImplementation: (implementation: (handler: NonNullable<typeof sessionUpdatedHandler>) => Promise<() => void>) => void;
    }).mockImplementation((handler) => {
      sessionUpdatedHandler = handler;
      return Promise.resolve(() => undefined);
    });
    const stored = { ...startedSession("sync-chat", "hello"), turnsLoaded: true, turnCount: 1, updatedAt: 100 };
    apiMocks.chatUiSessionsList.mockResolvedValue([stored]);
    apiMocks.chatUiSessionLoad.mockResolvedValue({
      ...stored,
      draft: "",
      updatedAt: 200,
      turnCount: 2,
      turns: [
        { id: "sync-chat-turn", role: "user", blocks: [{ kind: "text", text: "hello" }] },
        { id: "sync-chat-reply", role: "assistant", blocks: [{ kind: "text", text: "from the companion" }] },
      ],
    });

    const { result } = renderHook(() => useChatSessions("default"));
    await waitFor(() => expect(result.current.allSessions.some((session) => session.id === "sync-chat")).toBe(true));
    act(() => result.current.setCurrentId("sync-chat"));
    await waitFor(() => expect(result.current.currentSession?.id).toBe("sync-chat"));

    act(() => result.current.setDraft("sync-chat", "still editing this"));

    await act(async () => {
      sessionUpdatedHandler?.({ sessionId: "sync-chat", operation: "saved" });
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.currentSession?.turns).toHaveLength(2));
    expect(result.current.currentSession?.draft).toBe("still editing this");
    expect(result.current.currentSession?.turns[1]).toMatchObject({
      id: "sync-chat-reply",
      blocks: [{ kind: "text", text: "from the companion" }],
    });
  });

  it("keeps an unselected remote session lazy and applies its live buffer after selection", async () => {
    let remoteUpdateHandler: ((event: {
      sessionId: string;
      messageId?: string;
      phase?: "started";
      message?: string;
      desktopMirrored?: boolean;
    }) => void) | undefined;
    (apiMocks.onRemoteChatSessionUpdated as unknown as {
      mockImplementation: (implementation: (handler: NonNullable<typeof remoteUpdateHandler>) => Promise<() => void>) => void;
    }).mockImplementation((handler) => {
      remoteUpdateHandler = handler;
      return Promise.resolve(() => undefined);
    });
    const summary = {
      ...startedSession("remote-lazy", "lazy"),
      turns: [],
      turnsLoaded: false,
      turnCount: 1,
    };
    const stored = startedSession("remote-lazy", "existing");
    apiMocks.chatUiSessionsList.mockResolvedValue([summary]);
    apiMocks.chatUiSessionLoad.mockResolvedValue(stored);

    const { result } = renderHook(() => useChatSessions("default"));
    await waitFor(() => expect(remoteUpdateHandler).toBeDefined());
    await waitFor(() => expect(result.current.allSessions).toHaveLength(1));

    act(() => remoteUpdateHandler?.({
      sessionId: "remote-lazy",
      messageId: "message-lazy",
      phase: "started",
      message: "from phone",
      desktopMirrored: true,
    }));
    expect(apiMocks.chatUiSessionLoad).not.toHaveBeenCalled();
    expect(result.current.allSessions[0]?.turnsLoaded).toBe(false);
    const lazyPatch = vi.fn((turns: ChatTurn[]) => turns);
    act(() => result.current.patchTurns("remote-lazy", lazyPatch));
    expect(lazyPatch).not.toHaveBeenCalled();
    expect(result.current.allSessions[0]?.turnsLoaded).toBe(false);

    act(() => result.current.setCurrentId("remote-lazy"));
    await waitFor(() => expect(result.current.currentSession?.turns.slice(-2)).toMatchObject([
      { id: "remote-message-lazy-user", blocks: [{ kind: "text", text: "from phone" }] },
      { id: "remote-message-lazy-assistant", streaming: true },
    ]));
    expect(apiMocks.chatUiSessionLoad).toHaveBeenCalledTimes(1);
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

  it("keeps the desktop rich stream when a paired phone receives its text mirror", async () => {
    let remoteUpdateHandler: ((event: {
      sessionId: string;
      messageId?: string;
      phase?: "started" | "delta" | "completed";
      message?: string;
      delta?: string;
      text?: string;
      persisted?: boolean;
      desktopMirrored?: boolean;
    }) => void) | undefined;
    (apiMocks.onRemoteChatSessionUpdated as unknown as {
      mockImplementation: (implementation: (handler: (event: {
        sessionId: string;
        messageId?: string;
        phase?: "started" | "delta" | "completed";
        message?: string;
        delta?: string;
        text?: string;
        persisted?: boolean;
        desktopMirrored?: boolean;
      }) => void) => Promise<() => void>) => void;
    }).mockImplementation((handler) => {
      remoteUpdateHandler = handler;
      return Promise.resolve(() => undefined);
    });
    const stored = startedSession("remote-mirror", "existing");
    apiMocks.chatUiSessionsList.mockResolvedValue([stored]);
    apiMocks.chatUiSessionLoad.mockResolvedValue(stored);

    const { result } = renderHook(() => useChatSessions("default"));
    await waitFor(() => expect(remoteUpdateHandler).toBeDefined());
    await waitFor(() => expect(result.current.allSessions).toHaveLength(1));
    act(() => remoteUpdateHandler?.({
      sessionId: "remote-mirror",
      messageId: "message-mirror",
      phase: "started",
      message: "from phone",
      desktopMirrored: true,
    }));
    act(() => {
      result.current.patchTurns("remote-mirror", (turns) => turns.map((turn) => (
        turn.id === "remote-message-mirror-assistant"
          ? {
              ...turn,
              blocks: [
                { kind: "thinking", thinking: "desktop reasoning" },
                { kind: "tool", id: "tool-1", name: "read_file", input: "{}" },
                { kind: "text", text: "desktop answer" },
              ],
            }
          : turn
      )));
    });
    act(() => remoteUpdateHandler?.({
      sessionId: "remote-mirror",
      messageId: "message-mirror",
      phase: "delta",
      delta: "mobile text mirror",
      desktopMirrored: true,
    }));
    act(() => remoteUpdateHandler?.({
      sessionId: "remote-mirror",
      messageId: "message-mirror",
      phase: "completed",
      text: "mobile text mirror",
      persisted: true,
      desktopMirrored: true,
    }));

    const turns = result.current.allSessions[0]?.turns ?? [];
    expect(turns[turns.length - 1]).toMatchObject({
      id: "remote-message-mirror-assistant",
      streaming: false,
      blocks: [
        { kind: "thinking", thinking: "desktop reasoning" },
        { kind: "tool", id: "tool-1", name: "read_file" },
        { kind: "text", text: "desktop answer" },
      ],
    });
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

  it("checkpoints a continuously streaming desktop chat before it completes", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useChatSessions("default"));
    try {
      await act(async () => {
        await Promise.resolve();
      });
      expect(apiMocks.chatUiSessionsList).toHaveBeenCalled();
      let id = "";
      act(() => {
        id = result.current.materializeCurrentSession()?.id ?? "";
      });
      expect(result.current.currentId).toBe(id);
      act(() => {
        result.current.patchTurns(id, () => [
          { id: "stream-user", role: "user", blocks: [{ kind: "text", text: "keep this chat" }] },
          {
            id: "stream-assistant",
            role: "assistant",
            blocks: [{ kind: "text", text: "first checkpoint" }],
            streaming: true,
          },
        ]);
      });

      // Each delta arrives before the trailing debounce can fire. The bounded
      // checkpoint must still save the partial UI projection after one second.
      for (let index = 0; index < 5; index += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(200);
        });
        act(() => {
          result.current.patchTurns(id, (turns) => turns.map((turn) => (
            turn.id === "stream-assistant"
              ? {
                  ...turn,
                  blocks: [{ kind: "text", text: `checkpoint ${index}` }],
                  streaming: true,
                }
              : turn
          )));
        });
      }

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(apiMocks.chatUiSessionSave).toHaveBeenCalledWith(expect.objectContaining({
        id,
        turns: expect.arrayContaining([
          expect.objectContaining({ id: "stream-assistant", streaming: true }),
        ]),
      }));
    } finally {
      vi.useRealTimers();
    }
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
