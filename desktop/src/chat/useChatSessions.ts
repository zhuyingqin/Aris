import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  chatUiSessionLoad,
  chatUiSessionSave,
  chatUiSessionsList,
  chatUiSessionsSave,
  isTauri,
} from "../api/tauri";
import { useStore } from "../store";
import type { ChatTurn } from "../types";
import { CURRENT_KEY, LEGACY_CURRENT_KEY, LEGACY_SESSIONS_KEY, LEGACY_SESSIONS_KEY_V1, SESSIONS_KEY, makeSession, migrateSession, titleFromTurns } from "./model";
import type { ChatSession } from "./types";

const HOME_SESSION_ID = "chat-home";
const SESSION_PERSIST_DELAY_MS = 250;
const MAX_LEGACY_TAURI_LOCAL_SESSIONS_CHARS = 2_000_000;

function isStartedSession(session: ChatSession) {
  return session.turnsLoaded === false || session.turns.length > 0;
}

function isBlankSession(session: ChatSession) {
  return (
    session.turns.length === 0
    && !session.draft.trim()
    && session.draftAttachments.length === 0
  );
}

function loadLocalSessions(maxRawChars = Number.POSITIVE_INFINITY): ChatSession[] {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY) ?? localStorage.getItem(LEGACY_SESSIONS_KEY) ?? localStorage.getItem(LEGACY_SESSIONS_KEY_V1);
    if (!raw) return [];
    if (raw.length > maxRawChars) return [];
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
    const stored = localStorage.getItem(CURRENT_KEY) ?? localStorage.getItem(LEGACY_CURRENT_KEY);
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

function mergeLoadedSession(current: ChatSession, loaded: ChatSession): ChatSession {
  if (current.updatedAt <= loaded.updatedAt) return loaded;
  return {
    ...loaded,
    title: current.title,
    model: current.model ?? loaded.model,
    draft: current.draft,
    draftAttachments: current.draftAttachments,
    pinned: current.pinned,
    updatedAt: current.updatedAt,
  };
}

function persistLocalSessions(sessions: ChatSession[]) {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(persistentSessions(sessions)));
    localStorage.removeItem(LEGACY_SESSIONS_KEY);
    localStorage.removeItem(LEGACY_SESSIONS_KEY_V1);
  } catch {
    // Browser preview falls back to in-memory state when storage is full.
  }
}

function clearLocalSessionSnapshots() {
  try {
    localStorage.removeItem(SESSIONS_KEY);
    localStorage.removeItem(LEGACY_SESSIONS_KEY);
    localStorage.removeItem(LEGACY_SESSIONS_KEY_V1);
  } catch {
    // Ignore storage failures; Tauri keeps the canonical copy on disk.
  }
}

function persistCurrentId(id: string) {
  try {
    localStorage.setItem(CURRENT_KEY, id);
    localStorage.removeItem(LEGACY_CURRENT_KEY);
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
    initial.current = isTauri() ? [] : loadLocalSessions();
  }
  const activeProjectId = projectId ?? "default";
  const projectKnown = projectId != null;
  const [allSessions, setAllSessions] = useState<ChatSession[]>(() => initial.current!);
  const [homeSession, setHomeSession] = useState<ChatSession>(() => makeHomeSession(activeProjectId));
  const [currentId, setCurrentId] = useState<string>(() => restoredCurrentId(initial.current!));
  const hydrated = useRef(!isTauri());
  const sessionsRef = useRef(allSessions);
  sessionsRef.current = allSessions;
  const pendingPersistSessions = useRef<ChatSession[] | null>(null);
  const persistTimer = useRef<number | null>(null);
  const dirtySessionIds = useRef(new Set<string>());
  const loadingSessionIds = useRef(new Set<string>());
  const visibleAllSessions = useMemo(() => persistentSessions(allSessions), [allSessions]);
  const visibleSessions = useMemo(
    () => visibleAllSessions.filter((session) => session.projectId === activeProjectId),
    [activeProjectId, visibleAllSessions],
  );
  const markSessionDirty = useCallback((id: string) => {
    if (id !== HOME_SESSION_ID) dirtySessionIds.current.add(id);
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    chatUiSessionsList<ChatSession>()
      .then((stored) => {
        const backendSessions = stored.map((session) => migrateSession(session)).filter(isStartedSession);
        const legacyLocalSessions = backendSessions.length === 0
          ? loadLocalSessions(MAX_LEGACY_TAURI_LOCAL_SESSIONS_CHARS)
          : [];
        const merged = mergeSessions(backendSessions, legacyLocalSessions, sessionsRef.current);
        if (merged.length > 0) setAllSessions(merged);
        setHomeSession(makeHomeSession(activeProjectId));
        hydrated.current = true;
        if (backendSessions.length > 0) clearLocalSessionSnapshots();
        if (backendSessions.length === 0 && merged.length > 0) {
          void chatUiSessionsSave(persistentSessions(merged))
            .then(clearLocalSessionSnapshots)
            .catch((error) => setError(`Failed to save chat sessions: ${String(error)}`));
        }
      })
      .catch(() => {
        hydrated.current = true;
      });
  }, [setError]);

  const flushPendingSessions = useCallback(() => {
    const pending = pendingPersistSessions.current;
    if (!pending) return;
    pendingPersistSessions.current = null;
    if (persistTimer.current != null) {
      window.clearTimeout(persistTimer.current);
      persistTimer.current = null;
    }

    if (!isTauri()) {
      persistLocalSessions(pending);
      return;
    }
    if (!hydrated.current) return;
    const dirtyIds = new Set(dirtySessionIds.current);
    if (dirtyIds.size === 0) return;
    for (const id of dirtyIds) dirtySessionIds.current.delete(id);
    const sessionsToSave = persistentSessions(pending)
      .filter((session) => dirtyIds.has(session.id));
    if (sessionsToSave.length === 0) return;
    void Promise.all(sessionsToSave.map((session) => chatUiSessionSave(session)))
      .then(clearLocalSessionSnapshots)
      .catch((error) => {
        for (const id of dirtyIds) dirtySessionIds.current.add(id);
        setError(`Failed to save chat sessions: ${String(error)}`);
      });
  }, [setError]);

  useEffect(() => {
    pendingPersistSessions.current = allSessions;
    if (persistTimer.current != null) window.clearTimeout(persistTimer.current);
    persistTimer.current = window.setTimeout(flushPendingSessions, SESSION_PERSIST_DELAY_MS);
    return () => {
      if (persistTimer.current != null) {
        window.clearTimeout(persistTimer.current);
        persistTimer.current = null;
      }
    };
  }, [allSessions, flushPendingSessions]);

  useEffect(() => {
    const flush = () => flushPendingSessions();
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      flushPendingSessions();
    };
  }, [flushPendingSessions]);

  useEffect(() => {
    if (isTauri() && !hydrated.current) return;
    persistCurrentId(currentId);
  }, [currentId]);

  useEffect(() => {
    if (currentId === HOME_SESSION_ID) {
      if (homeSession.projectId !== activeProjectId) setHomeSession(makeHomeSession(activeProjectId));
      return;
    }
    const current = allSessions.find((session) => session.id === currentId);
    if (current && (!projectKnown || current.projectId === activeProjectId)) return;
    const fallback = latestSessionId(
      projectKnown
        ? allSessions.filter((session) => session.projectId === activeProjectId)
        : allSessions,
    ) ?? HOME_SESSION_ID;
    setCurrentId(fallback);
    setHomeSession(makeHomeSession(activeProjectId));
  }, [activeProjectId, allSessions, currentId, homeSession.projectId, projectKnown]);

  useEffect(() => {
    if (!isTauri() || currentId === HOME_SESSION_ID) return;
    const session = sessionsRef.current.find((item) => item.id === currentId);
    if (!session || session.turnsLoaded !== false || loadingSessionIds.current.has(currentId)) return;
    loadingSessionIds.current.add(currentId);
    chatUiSessionLoad<ChatSession>(currentId)
      .then((stored) => {
        const loaded = { ...migrateSession(stored, session.projectId), turnsLoaded: true };
        setAllSessions((previous) => previous.map((item) =>
          item.id === currentId ? mergeLoadedSession(item, loaded) : item));
      })
      .catch((error) => setError(`Failed to load chat session: ${String(error)}`))
      .finally(() => {
        loadingSessionIds.current.delete(currentId);
      });
  }, [currentId, setError]);

  const currentSession = useMemo(
    () => {
      if (currentId === HOME_SESSION_ID) return homeSession;
      const current = allSessions.find((session) => session.id === currentId) ?? null;
      if (!current || (projectKnown && current.projectId !== activeProjectId)) return null;
      if (current.turnsLoaded === false) return null;
      return current;
    },
    [activeProjectId, allSessions, currentId, homeSession, projectKnown],
  );

  // True while a real session exists but its turns are still being fetched from
  // disk. Lets the UI show a quiet loading state instead of flashing the empty
  // "new chat" welcome screen during the lazy-load roundtrip.
  const currentSessionLoading = useMemo(
    () => {
      if (currentId === HOME_SESSION_ID) return false;
      const current = allSessions.find((session) => session.id === currentId);
      if (!current || (projectKnown && current.projectId !== activeProjectId)) return false;
      return current.turnsLoaded === false;
    },
    [activeProjectId, allSessions, currentId, projectKnown],
  );

  const updateSession = useCallback((id: string, fn: (session: ChatSession) => ChatSession) => {
    if (id === HOME_SESSION_ID) {
      setHomeSession((session) => fn(session));
      return;
    }
    markSessionDirty(id);
    setAllSessions((previous) => previous.map((session) => session.id === id ? fn(session) : session));
  }, [markSessionDirty]);

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

  const createSession = useCallback(() => {
    const fresh = makeSession(activeProjectId);
    setAllSessions((previous) => [...previous, fresh]);
    setCurrentId(fresh.id);
    setHomeSession(makeHomeSession(activeProjectId));
    return fresh;
  }, [activeProjectId]);

  const createSessionInProject = useCallback((targetProjectId: string) => {
    const fresh = makeSession(targetProjectId);
    setAllSessions((previous) => [...previous, fresh]);
    setCurrentId(fresh.id);
    setHomeSession(makeHomeSession(targetProjectId));
    return fresh;
  }, []);

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
        turnsLoaded: true,
        turnCount: turns.length,
        title: homeSession.title === "New chat" ? titleFromTurns(turns) : homeSession.title,
        updatedAt: Date.now(),
      };
      setAllSessions((previous) => [...previous, fresh]);
      markSessionDirty(fresh.id);
      setCurrentId(fresh.id);
      setHomeSession(makeHomeSession(activeProjectId));
      return;
    }
    updateSession(id, (session) => {
      const turns = fn(session.turns);
      const previousTurnCount = session.turnCount ?? session.turns.length;
      const nextTurnCount = session.turnsPartial
        ? previousTurnCount + Math.max(0, turns.length - session.turns.length)
        : turns.length;
      return {
        ...session,
        turns,
        turnsLoaded: true,
        turnCount: nextTurnCount,
        title: session.title === "New chat" ? titleFromTurns(turns) : session.title,
        updatedAt: Date.now(),
      };
    });
  }, [activeProjectId, homeSession, markSessionDirty, updateSession]);

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
    currentSessionLoading,
    setCurrentId,
    setSessions: setAllSessions,
    materializeCurrentSession,
    createSession,
    createSessionInProject,
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
