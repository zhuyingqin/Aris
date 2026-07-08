// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatTurn } from "../types";

const apiMocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  chatUiSessionsList: vi.fn(),
  chatUiSessionLoad: vi.fn(),
  chatUiSessionSave: vi.fn(() => Promise.resolve()),
  chatUiSessionDelete: vi.fn(() => Promise.resolve()),
  chatUiSessionsLoad: vi.fn(),
  chatUiSessionsSave: vi.fn(() => Promise.resolve()),
}));

vi.mock("../api/tauri", () => apiMocks);

import { CURRENT_KEY, SESSIONS_KEY, makeSession } from "./model";
import { useChatSessions } from "./useChatSessions";

function startedSession(id: string, text: string) {
  const session = makeSession("default");
  session.id = id;
  session.title = text;
  session.turns = [{ id: `${id}-turn`, role: "user", blocks: [{ kind: "text", text }] }];
  return session;
}

describe("useChatSessions Tauri persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    apiMocks.isTauri.mockReturnValue(true);
    apiMocks.chatUiSessionsList.mockResolvedValue([]);
    apiMocks.chatUiSessionLoad.mockRejectedValue(new Error("not mocked"));
    apiMocks.chatUiSessionSave.mockResolvedValue(undefined);
    apiMocks.chatUiSessionDelete.mockResolvedValue(undefined);
    apiMocks.chatUiSessionsLoad.mockResolvedValue([]);
    apiMocks.chatUiSessionsSave.mockResolvedValue(undefined);
  });

  afterEach(() => cleanup());

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
});
