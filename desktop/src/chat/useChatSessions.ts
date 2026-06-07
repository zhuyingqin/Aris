import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chatUiSessionsLoad, chatUiSessionsSave, isTauri } from "../api/tauri";
import type { ChatTurn } from "../types";
import { CURRENT_KEY, SESSIONS_KEY, makeSession, migrateSession, titleFromTurns } from "./model";
import type { ChatSession } from "./types";

function loadLocalSessions(): ChatSession[] {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY) ?? localStorage.getItem("aris-chat-sessions");
    if (!raw) return [];
    return (JSON.parse(raw) as ChatSession[]).map((session) => migrateSession(session));
  } catch {
    return [];
  }
}

export function useChatSessions(projectId = "default") {
  const [allSessions, setAllSessions] = useState<ChatSession[]>(() => {
    const stored = loadLocalSessions();
    return stored.length > 0 ? stored : [makeSession(projectId)];
  });
  const [currentId, setCurrentId] = useState<string>(() => {
    const stored = loadLocalSessions();
    const saved = localStorage.getItem(CURRENT_KEY);
    return stored.some((session) => session.id === saved)
      ? saved as string
      : stored.find((session) => session.projectId === projectId)?.id ?? "";
  });
  const hydrated = useRef(!isTauri());
  const sessionsRef = useRef(allSessions);
  sessionsRef.current = allSessions;
  const sessions = useMemo(
    () => allSessions.filter((session) => session.projectId === projectId),
    [allSessions, projectId],
  );

  useEffect(() => {
    if (!isTauri()) return;
    chatUiSessionsLoad<ChatSession>()
      .then((stored) => {
        if (stored.length > 0) {
          const migrated = stored.map((session) => migrateSession(session));
          setAllSessions(migrated);
          setCurrentId((id) => migrated.some((session) => session.id === id) ? id : "");
        } else {
          void chatUiSessionsSave(sessionsRef.current);
        }
        hydrated.current = true;
      })
      .catch(() => {
        hydrated.current = true;
      });
  }, []);

  useEffect(() => {
    if (!isTauri()) {
      try {
        localStorage.setItem(SESSIONS_KEY, JSON.stringify(allSessions));
      } catch {
        // Browser preview falls back to in-memory state when storage is full.
      }
    }
    if (!hydrated.current || !isTauri()) return;
    const timer = window.setTimeout(() => {
      void chatUiSessionsSave(allSessions);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [allSessions]);

  useEffect(() => {
    if (currentId) localStorage.setItem(CURRENT_KEY, currentId);
  }, [currentId]);

  useEffect(() => {
    if (sessions.some((session) => session.id === currentId)) return;
    if (sessions.length > 0) setCurrentId(sessions[0].id);
    else {
      const fresh = makeSession(projectId);
      setAllSessions((previous) => [...previous, fresh]);
      setCurrentId(fresh.id);
    }
  }, [currentId, projectId, sessions]);

  const currentSession = useMemo(
    () => allSessions.find((session) => session.id === currentId && session.projectId === projectId) ?? null,
    [allSessions, currentId, projectId],
  );

  const updateSession = useCallback((id: string, fn: (session: ChatSession) => ChatSession) => {
    setAllSessions((previous) => previous.map((session) => session.id === id ? fn(session) : session));
  }, []);

  const patchTurns = useCallback((id: string, fn: (turns: ChatTurn[]) => ChatTurn[]) => {
    updateSession(id, (session) => {
      const turns = fn(session.turns);
      return {
        ...session,
        turns,
        title: session.title === "New chat" ? titleFromTurns(turns) : session.title,
        updatedAt: Date.now(),
      };
    });
  }, [updateSession]);

  const newSession = useCallback(() => {
    const existing = allSessions.find((session) => session.id === currentId && session.projectId === projectId);
    if (
      existing
      && existing.turns.length === 0
      && !existing.draft.trim()
      && existing.draftAttachments.length === 0
    ) return existing.id;
    const fresh = makeSession(projectId);
    setAllSessions((previous) => [...previous, fresh]);
    setCurrentId(fresh.id);
    return fresh.id;
  }, [allSessions, currentId, projectId]);

  const setDraft = useCallback((id: string, draft: string) => {
    updateSession(id, (session) => ({ ...session, draft }));
  }, [updateSession]);

  const renameSession = useCallback((id: string, title: string) => {
    updateSession(id, (session) => ({ ...session, title: title.trim() || session.title }));
  }, [updateSession]);

  const togglePinned = useCallback((id: string) => {
    updateSession(id, (session) => ({ ...session, pinned: !session.pinned, updatedAt: Date.now() }));
  }, [updateSession]);

  const removeSession = useCallback((id: string) => {
    const removed = allSessions.find((session) => session.id === id) ?? null;
    setAllSessions((previous) => {
      const next = previous.filter((session) => session.id !== id);
      return next;
    });
    return removed;
  }, [allSessions]);

  const restoreSession = useCallback((session: ChatSession) => {
    setAllSessions((previous) => previous.some((item) => item.id === session.id)
      ? previous
      : [...previous, session]);
    if (session.projectId === projectId) setCurrentId(session.id);
  }, [projectId]);

  return {
    sessions,
    allSessions,
    currentId,
    currentSession,
    setCurrentId,
    setSessions: setAllSessions,
    updateSession,
    patchTurns,
    newSession,
    setDraft,
    renameSession,
    togglePinned,
    removeSession,
    restoreSession,
  };
}
