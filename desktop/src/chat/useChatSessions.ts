import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chatUiSessionsLoad, chatUiSessionsSave, isTauri } from "../api/tauri";
import { useStore } from "../store";
import type { ChatTurn } from "../types";
import { SESSIONS_KEY, makeSession, migrateSession, titleFromTurns } from "./model";
import type { ChatSession } from "./types";

const HOME_SESSION_ID = "chat-home";

function isStartedSession(session: ChatSession) {
  return session.turns.length > 0;
}

function loadLocalSessions(): ChatSession[] {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY) ?? localStorage.getItem("aris-chat-sessions");
    if (!raw) return [];
    return (JSON.parse(raw) as ChatSession[])
      .map((session) => migrateSession(session))
      .filter(isStartedSession);
  } catch {
    return [];
  }
}

function makeHomeSession(projectId: string): ChatSession {
  return { ...makeSession(projectId), id: HOME_SESSION_ID };
}

function persistentSessions(sessions: ChatSession[]) {
  return sessions.filter(isStartedSession);
}

export function useChatSessions(projectId = "default") {
  const setError = useStore((state) => state.setError);
  const initial = useRef<ChatSession[] | null>(null);
  if (initial.current === null) {
    initial.current = loadLocalSessions();
  }
  const [allSessions, setAllSessions] = useState<ChatSession[]>(() => initial.current!);
  const [homeSession, setHomeSession] = useState<ChatSession>(() => makeHomeSession(projectId));
  const [currentId, setCurrentId] = useState<string>(HOME_SESSION_ID);
  const hydrated = useRef(!isTauri());
  const sessionsRef = useRef(allSessions);
  sessionsRef.current = allSessions;
  const sessions = useMemo(
    () => allSessions.filter((session) => session.projectId === projectId),
    [allSessions, projectId],
  );
  const visibleAllSessions = useMemo(() => persistentSessions(allSessions), [allSessions]);
  const visibleSessions = useMemo(
    () => visibleAllSessions.filter((session) => session.projectId === projectId),
    [projectId, visibleAllSessions],
  );

  useEffect(() => {
    if (!isTauri()) return;
    chatUiSessionsLoad<ChatSession>()
      .then((stored) => {
        if (stored.length > 0) {
          const migrated = stored.map((session) => migrateSession(session)).filter(isStartedSession);
          setAllSessions(migrated);
          setCurrentId(HOME_SESSION_ID);
          setHomeSession(makeHomeSession(projectId));
        } else {
          void chatUiSessionsSave(persistentSessions(sessionsRef.current))
            .catch((error) => setError(`Failed to save chat sessions: ${String(error)}`));
        }
        hydrated.current = true;
      })
      .catch(() => {
        hydrated.current = true;
      });
  }, [setError]);

  useEffect(() => {
    if (!isTauri()) {
      try {
        localStorage.setItem(SESSIONS_KEY, JSON.stringify(persistentSessions(allSessions)));
      } catch {
        // Browser preview falls back to in-memory state when storage is full.
      }
    }
    if (!hydrated.current || !isTauri()) return;
    const timer = window.setTimeout(() => {
      void chatUiSessionsSave(persistentSessions(allSessions))
        .catch((error) => setError(`Failed to save chat sessions: ${String(error)}`));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [allSessions, setError]);

  useEffect(() => {
    if (currentId === HOME_SESSION_ID) {
      if (homeSession.projectId !== projectId) setHomeSession(makeHomeSession(projectId));
      return;
    }
    if (sessions.some((session) => session.id === currentId)) return;
    setCurrentId(HOME_SESSION_ID);
    setHomeSession(makeHomeSession(projectId));
  }, [currentId, homeSession.projectId, projectId, sessions]);

  const currentSession = useMemo(
    () => currentId === HOME_SESSION_ID
      ? homeSession
      : allSessions.find((session) => session.id === currentId && session.projectId === projectId) ?? null,
    [allSessions, currentId, homeSession, projectId],
  );

  const updateSession = useCallback((id: string, fn: (session: ChatSession) => ChatSession) => {
    if (id === HOME_SESSION_ID) {
      setHomeSession((session) => fn(session));
      return;
    }
    setAllSessions((previous) => previous.map((session) => session.id === id ? fn(session) : session));
  }, []);

  const materializeCurrentSession = useCallback(() => {
    if (currentId !== HOME_SESSION_ID) return currentSession;
    const base = makeSession(projectId);
    const fresh: ChatSession = {
      ...homeSession,
      id: base.id,
      projectId,
      createdAt: base.createdAt,
      updatedAt: base.updatedAt,
    };
    setAllSessions((previous) => [...previous, fresh]);
    setCurrentId(fresh.id);
    setHomeSession(makeHomeSession(projectId));
    return fresh;
  }, [currentId, currentSession, homeSession, projectId]);

  const patchTurns = useCallback((id: string, fn: (turns: ChatTurn[]) => ChatTurn[]) => {
    if (id === HOME_SESSION_ID) {
      const turns = fn(homeSession.turns);
      const base = makeSession(projectId);
      const fresh: ChatSession = {
        ...homeSession,
        id: base.id,
        projectId,
        createdAt: base.createdAt,
        turns,
        title: homeSession.title === "New chat" ? titleFromTurns(turns) : homeSession.title,
        updatedAt: Date.now(),
      };
      setAllSessions((previous) => [...previous, fresh]);
      setCurrentId(fresh.id);
      setHomeSession(makeHomeSession(projectId));
      return;
    }
    updateSession(id, (session) => {
      const turns = fn(session.turns);
      return {
        ...session,
        turns,
        title: session.title === "New chat" ? titleFromTurns(turns) : session.title,
        updatedAt: Date.now(),
      };
    });
  }, [homeSession, projectId, updateSession]);

  const newSession = useCallback(() => {
    if (currentId === HOME_SESSION_ID) return HOME_SESSION_ID;
    setHomeSession(makeHomeSession(projectId));
    setCurrentId(HOME_SESSION_ID);
    return HOME_SESSION_ID;
  }, [currentId, projectId]);

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
    sessions: visibleSessions,
    allSessions: visibleAllSessions,
    currentId,
    currentSession,
    setCurrentId,
    setSessions: setAllSessions,
    materializeCurrentSession,
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
