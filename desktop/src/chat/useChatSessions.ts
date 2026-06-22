import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chatUiSessionsLoad, chatUiSessionsSave, isTauri } from "../api/tauri";
import { useStore } from "../store";
import type { ChatTurn } from "../types";
import { CURRENT_KEY, SESSIONS_KEY, makeSession, migrateSession, titleFromTurns } from "./model";
import type { ChatSession } from "./types";

const HOME_SESSION_ID = "chat-home";

function isStartedSession(session: ChatSession) {
  return session.turns.length > 0;
}

function isBlankSession(session: ChatSession) {
  return (
    session.turns.length === 0
    && !session.draft.trim()
    && session.draftAttachments.length === 0
  );
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

function latestSessionId(sessions: ChatSession[]): string | null {
  return sessions.reduce<ChatSession | null>(
    (latest, session) => !latest || session.updatedAt > latest.updatedAt ? session : latest,
    null,
  )?.id ?? null;
}

function restoredCurrentId(sessions: ChatSession[]): string {
  try {
    const stored = localStorage.getItem(CURRENT_KEY);
    if (stored === HOME_SESSION_ID) return HOME_SESSION_ID;
    if (stored && sessions.some((session) => session.id === stored)) return stored;
  } catch {
    // Fall through to the most recent saved chat.
  }
  return latestSessionId(sessions) ?? HOME_SESSION_ID;
}

function mergeSessions(...lists: ChatSession[][]): ChatSession[] {
  const byId = new Map<string, ChatSession>();
  for (const list of lists) {
    for (const session of list) {
      const existing = byId.get(session.id);
      if (!existing || session.updatedAt >= existing.updatedAt) {
        byId.set(session.id, session);
      }
    }
  }
  return [...byId.values()];
}

function persistLocalSessions(sessions: ChatSession[]) {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(persistentSessions(sessions)));
  } catch {
    // Browser preview falls back to in-memory state when storage is full.
  }
}

function persistCurrentId(id: string) {
  try {
    localStorage.setItem(CURRENT_KEY, id);
  } catch {
    // Ignore storage failures; the in-memory session still works.
  }
}

function makeHomeSession(projectId: string): ChatSession {
  return { ...makeSession(projectId), id: HOME_SESSION_ID };
}

function persistentSessions(sessions: ChatSession[]) {
  return sessions.filter(isStartedSession);
}

export function useChatSessions(projectId?: string | null) {
  const setError = useStore((state) => state.setError);
  const initial = useRef<ChatSession[] | null>(null);
  if (initial.current === null) {
    initial.current = loadLocalSessions();
  }
  const activeProjectId = projectId ?? "default";
  const projectKnown = projectId != null;
  const [allSessions, setAllSessions] = useState<ChatSession[]>(() => initial.current!);
  const [homeSession, setHomeSession] = useState<ChatSession>(() => makeHomeSession(activeProjectId));
  const [currentId, setCurrentId] = useState<string>(() => restoredCurrentId(initial.current!));
  const hydrated = useRef(!isTauri());
  const sessionsRef = useRef(allSessions);
  sessionsRef.current = allSessions;
  const visibleAllSessions = useMemo(() => persistentSessions(allSessions), [allSessions]);
  const visibleSessions = useMemo(
    () => visibleAllSessions.filter((session) => session.projectId === activeProjectId),
    [activeProjectId, visibleAllSessions],
  );

  useEffect(() => {
    if (!isTauri()) return;
    chatUiSessionsLoad<ChatSession>()
      .then((stored) => {
        const backendSessions = stored.map((session) => migrateSession(session)).filter(isStartedSession);
        const merged = mergeSessions(backendSessions, loadLocalSessions(), sessionsRef.current);
        if (merged.length > 0) setAllSessions(merged);
        setCurrentId(restoredCurrentId(merged));
        setHomeSession(makeHomeSession(activeProjectId));
        hydrated.current = true;
        if (backendSessions.length === 0 && merged.length > 0) {
          void chatUiSessionsSave(persistentSessions(merged))
            .catch((error) => setError(`Failed to save chat sessions: ${String(error)}`));
        }
      })
      .catch(() => {
        hydrated.current = true;
      });
  }, [setError]);

  useEffect(() => {
    persistLocalSessions(allSessions);
    if (!hydrated.current || !isTauri()) return;
    const timer = window.setTimeout(() => {
      void chatUiSessionsSave(persistentSessions(allSessions))
        .catch((error) => setError(`Failed to save chat sessions: ${String(error)}`));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [allSessions, setError]);

  useEffect(() => {
    persistCurrentId(currentId);
  }, [currentId]);

  useEffect(() => {
    if (currentId === HOME_SESSION_ID) {
      if (homeSession.projectId !== activeProjectId) setHomeSession(makeHomeSession(activeProjectId));
      return;
    }
    const current = allSessions.find((session) => session.id === currentId);
    if (current && (!projectKnown || current.projectId === activeProjectId)) return;
    setCurrentId(HOME_SESSION_ID);
    setHomeSession(makeHomeSession(activeProjectId));
  }, [activeProjectId, allSessions, currentId, homeSession.projectId, projectKnown]);

  const currentSession = useMemo(
    () => {
      if (currentId === HOME_SESSION_ID) return homeSession;
      const current = allSessions.find((session) => session.id === currentId) ?? null;
      if (!current || (projectKnown && current.projectId !== activeProjectId)) return null;
      return current;
    },
    [activeProjectId, allSessions, currentId, homeSession, projectKnown],
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
    const base = makeSession(activeProjectId);
    const fresh: ChatSession = {
      ...homeSession,
      id: base.id,
      projectId: activeProjectId,
      createdAt: base.createdAt,
      updatedAt: base.updatedAt,
    };
    setAllSessions((previous) => [...previous, fresh]);
    setCurrentId(fresh.id);
    setHomeSession(makeHomeSession(activeProjectId));
    return fresh;
  }, [activeProjectId, currentId, currentSession, homeSession]);

  const patchTurns = useCallback((id: string, fn: (turns: ChatTurn[]) => ChatTurn[]) => {
    if (id === HOME_SESSION_ID) {
      const turns = fn(homeSession.turns);
      const base = makeSession(activeProjectId);
      const fresh: ChatSession = {
        ...homeSession,
        id: base.id,
        projectId: activeProjectId,
        createdAt: base.createdAt,
        turns,
        title: homeSession.title === "New chat" ? titleFromTurns(turns) : homeSession.title,
        updatedAt: Date.now(),
      };
      setAllSessions((previous) => [...previous, fresh]);
      setCurrentId(fresh.id);
      setHomeSession(makeHomeSession(activeProjectId));
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
  }, [activeProjectId, homeSession, updateSession]);

  const newSession = useCallback(() => {
    if (currentId === HOME_SESSION_ID) {
      if (!isBlankSession(homeSession)) setHomeSession(makeHomeSession(activeProjectId));
      return HOME_SESSION_ID;
    }
    setHomeSession(makeHomeSession(activeProjectId));
    setCurrentId(HOME_SESSION_ID);
    return HOME_SESSION_ID;
  }, [activeProjectId, currentId, homeSession]);

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
    if (!projectKnown || session.projectId === activeProjectId) setCurrentId(session.id);
  }, [activeProjectId, projectKnown]);

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
