import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chatUiSessionsLoad, chatUiSessionsSave, isTauri } from "../api/tauri";
import type { ChatTurn } from "../types";
import { CURRENT_KEY, SESSIONS_KEY, makeSession, migrateSession, titleFromTurns } from "./model";
import type { ChatSession } from "./types";

function loadLocalSessions(): ChatSession[] {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY) ?? localStorage.getItem("aris-chat-sessions");
    if (!raw) return [];
    return (JSON.parse(raw) as ChatSession[]).map(migrateSession);
  } catch {
    return [];
  }
}

export function useChatSessions() {
  const [sessions, setSessions] = useState<ChatSession[]>(() => {
    const stored = loadLocalSessions();
    return stored.length > 0 ? stored : [makeSession()];
  });
  const [currentId, setCurrentId] = useState<string>(() => {
    const stored = loadLocalSessions();
    const saved = localStorage.getItem(CURRENT_KEY);
    return stored.some((session) => session.id === saved)
      ? saved as string
      : stored[stored.length - 1]?.id ?? "";
  });
  const hydrated = useRef(!isTauri());
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  useEffect(() => {
    if (!isTauri()) return;
    chatUiSessionsLoad<ChatSession>()
      .then((stored) => {
        if (stored.length > 0) {
          const migrated = stored.map(migrateSession);
          setSessions(migrated);
          setCurrentId((id) => migrated.some((session) => session.id === id) ? id : migrated[0].id);
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
        localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
      } catch {
        // Browser preview falls back to in-memory state when storage is full.
      }
    }
    if (!hydrated.current || !isTauri()) return;
    const timer = window.setTimeout(() => {
      void chatUiSessionsSave(sessions);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [sessions]);

  useEffect(() => {
    if (currentId) localStorage.setItem(CURRENT_KEY, currentId);
  }, [currentId]);

  useEffect(() => {
    if (sessions.some((session) => session.id === currentId)) return;
    if (sessions.length > 0) setCurrentId(sessions[0].id);
    else {
      const fresh = makeSession();
      setSessions([fresh]);
      setCurrentId(fresh.id);
    }
  }, [currentId, sessions]);

  const currentSession = useMemo(
    () => sessions.find((session) => session.id === currentId) ?? null,
    [currentId, sessions],
  );

  const updateSession = useCallback((id: string, fn: (session: ChatSession) => ChatSession) => {
    setSessions((previous) => previous.map((session) => session.id === id ? fn(session) : session));
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
    const existing = sessions.find((session) => session.id === currentId);
    if (
      existing
      && existing.turns.length === 0
      && !existing.draft.trim()
      && existing.draftAttachments.length === 0
    ) return existing.id;
    const fresh = makeSession();
    setSessions((previous) => [...previous, fresh]);
    setCurrentId(fresh.id);
    return fresh.id;
  }, [currentId, sessions]);

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
    const removed = sessions.find((session) => session.id === id) ?? null;
    setSessions((previous) => {
      const next = previous.filter((session) => session.id !== id);
      return next.length > 0 ? next : [makeSession()];
    });
    return removed;
  }, [sessions]);

  const restoreSession = useCallback((session: ChatSession) => {
    setSessions((previous) => previous.some((item) => item.id === session.id)
      ? previous
      : [...previous, session]);
    setCurrentId(session.id);
  }, []);

  return {
    sessions,
    currentId,
    currentSession,
    setCurrentId,
    setSessions,
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
