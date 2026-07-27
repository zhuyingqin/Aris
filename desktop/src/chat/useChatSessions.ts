import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  chatEventsReplay,
  chatUiSessionLoad,
  chatUiSessionSave,
  chatUiSessionsList,
  chatUiSessionsSave,
  isTauri,
  onChatUiSessionUpdated,
  onRemoteChatSessionUpdated,
  type RemoteChatSessionUpdatedEvent,
} from "../api/tauri";
import { useStore } from "../store";
import type { ChatTurn } from "../types";
import { CURRENT_KEY, LEGACY_CURRENT_KEY, LEGACY_SESSIONS_KEY, LEGACY_SESSIONS_KEY_V1, SESSIONS_KEY, makeSession, migrateSession, titleFromTurns } from "./model";
import type { ChatSession } from "./types";

const HOME_SESSION_ID = "chat-home";
const SESSION_PERSIST_DELAY_MS = 250;
// Streaming deltas can arrive more frequently than the normal debounce. Keep
// that debounce for ordinary edits, but do not let a busy response defer its
// first durable checkpoint until the model finishes (or forever, after a
// crash). This bounds the unsaved UI projection to one second.
const SESSION_PERSIST_MAX_DELAY_MS = 1_000;
const MAX_LEGACY_TAURI_LOCAL_SESSIONS_CHARS = 2_000_000;

// Persistence ownership is deliberately split by concern:
// - runtime Session is the model's compactable execution context;
// - chat-ui-sessions is the canonical UI projection (drafts, pins, full and
//   lazily loaded turns); and
// - the event log is immutable audit/recovery data.
//
// In particular, event replay must not silently replace a saved UI projection:
// it cannot represent all UI-only fields or omitted-turn placeholders.

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

function isSessionStreaming(session: ChatSession) {
  for (let index = session.turns.length - 1; index >= 0; index -= 1) {
    const turn = session.turns[index];
    if (turn.role === "assistant") return turn.streaming === true;
  }
  return false;
}

function mergeRemoteLoadedSession(current: ChatSession | undefined, loaded: ChatSession): ChatSession {
  if (!current) return loaded;
  // A lazy list entry is intentionally summary-only. Its timestamp cannot be
  // allowed to discard the freshly persisted, full remote turn projection.
  if (current.turnsLoaded === false) return mergeLoadedSession(current, loaded);
  if (loaded.updatedAt < current.updatedAt) return current;
  const loadedTurnCount = loaded.turnCount ?? loaded.turns.length;
  const currentTurnCount = current.turnCount ?? current.turns.length;
  // Equal timestamp + no extra turns means the disk copy carries no new
  // transcript (every turn mutation bumps `updatedAt`), so keep the in-memory
  // session untouched. This makes a save's own broadcast echo a no-op instead
  // of a full re-render on every keystroke's debounced persist.
  if (loaded.updatedAt === current.updatedAt && loadedTurnCount <= currentTurnCount) return current;
  // `loaded` owns the transcript, but the composer draft and its attachments are
  // window-local editing state — never sourced from disk while the user has the
  // session open. A background reload (our own save's broadcast echo, a paired
  // phone sync, or a companion-window save) that overwrote the live draft would
  // snap the controlled <textarea> value back mid-keystroke and abort IME
  // composition, leaking the pending candidate keys (Space/PageDown/Shift/Delete).
  return { ...loaded, draft: current.draft, draftAttachments: current.draftAttachments };
}

interface RemoteTurnBuffer {
  messageId: string;
  userText: string;
  text: string;
  completed: boolean;
  /** Preserve the desktop renderer's canonical rich blocks while the phone
   * receives its separately bounded rich mirror. */
  desktopMirrored: boolean;
  activity?: "preparing" | "compacting" | "thinking" | "tool";
  stopped?: boolean;
  error?: string;
}

function applyRemoteTurnBuffer(session: ChatSession, buffer: RemoteTurnBuffer): ChatSession {
  const userId = `remote-${buffer.messageId}-user`;
  const assistantId = `remote-${buffer.messageId}-assistant`;
  const turns = session.turns.slice();
  let added = 0;
  if (!turns.some((turn) => turn.id === userId)) {
    turns.push({
      id: userId,
      role: "user",
      blocks: [{ kind: "text", text: buffer.userText }],
    });
    added += 1;
  }
  const assistantIndex = turns.findIndex((turn) => turn.id === assistantId);
  const existingAssistant = assistantIndex >= 0 ? turns[assistantIndex] : undefined;
  const preserveDesktopBlocks = buffer.desktopMirrored
    && existingAssistant?.role === "assistant"
    && existingAssistant.blocks.length > 0;
  const assistant = {
    ...(existingAssistant?.role === "assistant" ? existingAssistant : {}),
    id: assistantId,
    role: "assistant" as const,
    blocks: preserveDesktopBlocks
      ? existingAssistant?.blocks ?? []
      : buffer.text
      ? [{ kind: "text" as const, text: buffer.text }]
      : buffer.activity
        ? [{
            kind: "notice" as const,
            message: buffer.activity === "tool"
              ? "SomniQ is running a tool…"
              : buffer.activity === "compacting"
                ? "SomniQ is compacting this conversation…"
                : buffer.activity === "preparing"
                  ? "SomniQ is preparing this turn…"
                  : "SomniQ is thinking…",
          }]
        : [],
    streaming: !buffer.completed && !buffer.error,
    error: buffer.error,
    stopped: Boolean(buffer.stopped),
  };
  if (assistantIndex >= 0) turns[assistantIndex] = assistant;
  else {
    turns.push(assistant);
    added += 1;
  }
  const priorTurnCount = session.turnCount ?? session.turns.length;
  return {
    ...session,
    turns,
    turnsLoaded: true,
    turnCount: session.turnsPartial ? priorTurnCount + added : turns.length,
    title: session.title === "New chat" ? titleFromTurns(turns) : session.title,
    updatedAt: Date.now(),
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
  const persistMaxTimer = useRef<number | null>(null);
  // Native saves are asynchronous. Keep one immediate, renderer-local
  // emergency snapshot for each newly dirty session until its first atomic
  // native checkpoint has succeeded.
  const crashRecoverySessionIds = useRef(new Set<string>());
  const dirtySessionIds = useRef(new Set<string>());
  const sessionSaveQueues = useRef(new Map<string, Promise<void>>());
  const loadingSessionIds = useRef(new Set<string>());
  const remoteSessionUpdateVersions = useRef(new Map<string, number>());
  const remoteTurnBuffers = useRef(new Map<string, RemoteTurnBuffer>());
  const visibleAllSessions = useMemo(() => persistentSessions(allSessions), [allSessions]);
  const visibleSessions = useMemo(
    () => visibleAllSessions.filter((session) => session.projectId === activeProjectId),
    [activeProjectId, visibleAllSessions],
  );
  const markSessionDirty = useCallback((id: string) => {
    if (id !== HOME_SESSION_ID) dirtySessionIds.current.add(id);
  }, []);
  const enqueueSessionSave = useCallback((session: ChatSession) => {
    const previous = sessionSaveQueues.current.get(session.id) ?? Promise.resolve();
    // A newer debounced snapshot must wait for the prior IPC write. Otherwise
    // two native file replacements can race and an older renderer snapshot can
    // finish last, especially on Windows where replacement may be retried.
    const save = previous
      .catch(() => undefined)
      .then(() => chatUiSessionSave(session));
    sessionSaveQueues.current.set(session.id, save);
    void save.then(
      () => {
        if (sessionSaveQueues.current.get(session.id) === save) {
          sessionSaveQueues.current.delete(session.id);
        }
      },
      () => {
        if (sessionSaveQueues.current.get(session.id) === save) {
          sessionSaveQueues.current.delete(session.id);
        }
      },
    );
    return save;
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    chatUiSessionsList<ChatSession>()
      .then((stored) => {
        const backendSessions = stored.map((session) => migrateSession(session)).filter(isStartedSession);
        // This is normally empty. When the renderer or app was killed before
        // its first native checkpoint, it contains only the started chats that
        // need to be restored into the per-session native store. It must be
        // considered even when older native chats already exist.
        const localRecoverySessions = loadLocalSessions(MAX_LEGACY_TAURI_LOCAL_SESSIONS_CHARS);
        const merged = mergeSessions(backendSessions, localRecoverySessions, sessionsRef.current);
        if (merged.length > 0) setAllSessions(merged);
        setHomeSession(makeHomeSession(activeProjectId));
        hydrated.current = true;
        if (backendSessions.length === 0 && merged.length > 0) {
          void chatUiSessionsSave(persistentSessions(merged))
            .then(clearLocalSessionSnapshots)
            .catch((error) => setError(`Failed to save chat sessions: ${String(error)}`));
          return;
        }
        const backendUpdatedAt = new Map(backendSessions.map((session) => [session.id, session.updatedAt]));
        const sessionsNeedingRecovery = localRecoverySessions.filter((session) => {
          const storedUpdatedAt = backendUpdatedAt.get(session.id);
          return storedUpdatedAt == null || session.updatedAt > storedUpdatedAt;
        });
        if (sessionsNeedingRecovery.length > 0) {
          void Promise.all(sessionsNeedingRecovery.map(enqueueSessionSave))
            .then(clearLocalSessionSnapshots)
            .catch((error) => setError(`Failed to recover chat sessions: ${String(error)}`));
        } else if (localRecoverySessions.length > 0) {
          // All snapshots were already reflected in the native store.
          clearLocalSessionSnapshots();
        }
      })
      .catch(() => {
        hydrated.current = true;
      });
  }, [enqueueSessionSave, setError]);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void onChatUiSessionUpdated((event) => {
      const id = typeof event.sessionId === "string" ? event.sessionId.trim() : "";
      if (!id || disposed) return;
      if (event.operation === "deleted") {
        setAllSessions((previous) => previous.some((session) => session.id === id)
          ? previous.filter((session) => session.id !== id)
          : previous);
        return;
      }

      const known = sessionsRef.current.find((session) => session.id === id);
      void chatUiSessionLoad<ChatSession>(id)
        .then((stored) => {
          if (!stored || disposed) return;
          const loaded = { ...migrateSession(stored, known?.projectId), turnsLoaded: true };
          if (loaded.id !== id) return;
          setAllSessions((previous) => {
            const current = previous.find((session) => session.id === id);
            if (current && isSessionStreaming(current)) return previous;
            const merged = mergeRemoteLoadedSession(current, loaded);
            if (current === merged) return previous;
            return current
              ? previous.map((session) => session.id === id ? merged : session)
              : [...previous, merged];
          });
        })
        .catch(() => undefined);
    }).then((nextUnlisten) => {
      if (disposed) nextUnlisten();
      else unlisten = nextUnlisten;
    }).catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const remoteRenderFrames = new Map<string, number>();

    const loadPersistedRemoteSession = (sessionId: string) => {
      const id = typeof sessionId === "string" ? sessionId.trim() : "";
      if (!id) return;
      const version = (remoteSessionUpdateVersions.current.get(id) ?? 0) + 1;
      remoteSessionUpdateVersions.current.set(id, version);
      const known = sessionsRef.current.find((session) => session.id === id);
      void chatUiSessionLoad<ChatSession>(id)
        .then((stored) => {
          if (!stored || disposed || remoteSessionUpdateVersions.current.get(id) !== version) return;
          const loaded = { ...migrateSession(stored, known?.projectId), turnsLoaded: true };
          if (loaded.id !== id) return;
          setAllSessions((previous) => {
            const current = previous.find((session) => session.id === id);
            const merged = mergeRemoteLoadedSession(current, loaded);
            if (current === merged) return previous;
            return current
              ? previous.map((session) => session.id === id ? merged : session)
              : [...previous, merged];
          });
        })
        // The session may have been deleted locally between the desktop save
        // and this notification; ignore that benign race.
        .catch(() => undefined);
    };

    const updateBufferedSession = (id: string, buffer: RemoteTurnBuffer) => {
      setAllSessions((previous) => previous.map((session) => (
        session.id === id && session.turnsLoaded !== false
          ? applyRemoteTurnBuffer(session, buffer)
          : session
      )));
    };

    const cancelBufferedSessionUpdate = (id: string) => {
      const frame = remoteRenderFrames.get(id);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      remoteRenderFrames.delete(id);
    };

    const scheduleBufferedSessionUpdate = (id: string) => {
      if (remoteRenderFrames.has(id)) return;
      remoteRenderFrames.set(id, window.requestAnimationFrame(() => {
        remoteRenderFrames.delete(id);
        const current = remoteTurnBuffers.current.get(id);
        if (current) updateBufferedSession(id, { ...current });
      }));
    };

    const refreshRemoteSession = (event: RemoteChatSessionUpdatedEvent) => {
      const id = typeof event.sessionId === "string" ? event.sessionId.trim() : "";
      if (!id) return;
      if (event.phase === "created") {
        loadPersistedRemoteSession(id);
        return;
      }
      const messageId = typeof event.messageId === "string" ? event.messageId.trim() : "";
      if (event.phase === "started" && messageId && typeof event.message === "string") {
        const buffer: RemoteTurnBuffer = {
          messageId,
          userText: event.message,
          text: "",
          completed: false,
          desktopMirrored: event.desktopMirrored === true,
          activity: "preparing",
        };
        remoteTurnBuffers.current.set(id, buffer);
        updateBufferedSession(id, buffer);
        // Keep lazy, unselected sessions summary-only. The selected-session
        // loader below coalesces the single disk read and applies this buffer
        // after it finishes, so a phone message cannot force a megabyte-scale
        // React render in an unrelated desktop conversation.
        return;
      }
      const buffer = remoteTurnBuffers.current.get(id);
      if (event.phase === "delta" && buffer && buffer.messageId === messageId && typeof event.delta === "string") {
        buffer.text += event.delta;
        buffer.activity = undefined;
        // The same turn is already updating the desktop Chat through its
        // ordinary `chat-delta` stream. Keep this text only as a recovery
        // fallback; do not replace thinking/tool/rich blocks with the mobile
        // text projection.
        if (!buffer.desktopMirrored) scheduleBufferedSessionUpdate(id);
        return;
      }
      if (
        event.phase === "activity"
        && buffer
        && buffer.messageId === messageId
        && (
          event.activity === "preparing"
          || event.activity === "compacting"
          || event.activity === "thinking"
          || event.activity === "tool"
        )
      ) {
        buffer.activity = event.activity;
        if (!buffer.desktopMirrored) scheduleBufferedSessionUpdate(id);
        return;
      }
      if (event.phase === "completed" && buffer && buffer.messageId === messageId) {
        cancelBufferedSessionUpdate(id);
        if (typeof event.text === "string") buffer.text = event.text;
        buffer.completed = true;
        updateBufferedSession(id, { ...buffer });
        remoteTurnBuffers.current.delete(id);
        // In mirror mode the normal desktop renderer has just produced the
        // canonical rich turn. Loading the backend's durable fallback
        // here would overwrite it before the normal session save lands.
        if (event.persisted !== false && !buffer.desktopMirrored) loadPersistedRemoteSession(id);
        return;
      }
      if (event.phase === "error" && buffer && buffer.messageId === messageId) {
        cancelBufferedSessionUpdate(id);
        buffer.completed = true;
        buffer.error = event.error || "Remote chat failed.";
        updateBufferedSession(id, { ...buffer });
        remoteTurnBuffers.current.delete(id);
        return;
      }
      if (event.phase === "cancelled" && buffer && buffer.messageId === messageId) {
        cancelBufferedSessionUpdate(id);
        buffer.completed = true;
        buffer.stopped = true;
        buffer.activity = undefined;
        updateBufferedSession(id, { ...buffer });
        remoteTurnBuffers.current.delete(id);
        return;
      }
      // Backward compatibility with completed-turn notifications emitted by
      // older desktop backends.
      loadPersistedRemoteSession(id);
    };

    void onRemoteChatSessionUpdated(refreshRemoteSession)
      .then((nextUnlisten) => {
        if (disposed) {
          nextUnlisten();
        } else {
          unlisten = nextUnlisten;
        }
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      for (const frame of remoteRenderFrames.values()) window.cancelAnimationFrame(frame);
      remoteRenderFrames.clear();
      unlisten?.();
    };
  }, []);

  const flushPendingSessions = useCallback(() => {
    const pending = pendingPersistSessions.current;
    if (!pending) return;
    pendingPersistSessions.current = null;
    if (persistTimer.current != null) {
      window.clearTimeout(persistTimer.current);
      persistTimer.current = null;
    }
    if (persistMaxTimer.current != null) {
      window.clearTimeout(persistMaxTimer.current);
      persistMaxTimer.current = null;
    }

    if (!isTauri()) {
      persistLocalSessions(pending);
      return;
    }
    if (!hydrated.current) return;
    const dirtyIds = new Set(dirtySessionIds.current);
    if (dirtyIds.size === 0) return;
    for (const id of dirtyIds) dirtySessionIds.current.delete(id);
    const dirtySessions = persistentSessions(pending)
      .filter((session) => dirtyIds.has(session.id));
    // A desktop stream is already a complete, self-contained UI projection:
    // it is safe to checkpoint atomically while `streaming` is true. Previously
    // these sessions were held exclusively in renderer memory until the final
    // completion event, so an abnormal close could make every active chat
    // disappear from the sidebar. Remote buffers are intentionally excluded;
    // they are a bounded phone mirror and the backend owns their durable turn.
    const sessionsToSave = dirtySessions.filter((session) => (
      !remoteTurnBuffers.current.has(session.id)
    ));
    const savingIds = new Set(sessionsToSave.map((session) => session.id));
    for (const session of dirtySessions) {
      if (!savingIds.has(session.id)) dirtySessionIds.current.add(session.id);
    }
    if (sessionsToSave.length === 0) return;
    void Promise.all(sessionsToSave.map(enqueueSessionSave))
      .then(() => {
        for (const id of savingIds) crashRecoverySessionIds.current.delete(id);
        if (crashRecoverySessionIds.current.size === 0) clearLocalSessionSnapshots();
      })
      .catch((error) => {
        for (const id of savingIds) dirtySessionIds.current.add(id);
        setError(`Failed to save chat sessions: ${String(error)}`);
      });
  }, [enqueueSessionSave, setError]);

  useEffect(() => {
    pendingPersistSessions.current = allSessions;
    if (isTauri() && hydrated.current) {
      const startedDirtySessions = persistentSessions(allSessions)
        .filter((session) => dirtySessionIds.current.has(session.id));
      const newSnapshotIds = startedDirtySessions
        .map((session) => session.id)
        .filter((id) => !crashRecoverySessionIds.current.has(id));
      if (newSnapshotIds.length > 0) {
        for (const id of newSnapshotIds) crashRecoverySessionIds.current.add(id);
        const snapshots = persistentSessions(allSessions).filter((session) => (
          crashRecoverySessionIds.current.has(session.id)
        ));
        // `localStorage.setItem` is synchronous, so this closes the small
        // window before the first IPC save can complete. The snapshot contains
        // only uncheckpointed sessions, not the entire chat history.
        persistLocalSessions(snapshots);
      }
    }
    if (persistTimer.current != null) window.clearTimeout(persistTimer.current);
    persistTimer.current = window.setTimeout(flushPendingSessions, SESSION_PERSIST_DELAY_MS);
    // Reset only the trailing debounce. The maximum timer starts with the
    // first change and remains armed through subsequent stream deltas, which
    // guarantees that continuous output reaches disk before completion.
    if (persistMaxTimer.current == null) {
      persistMaxTimer.current = window.setTimeout(
        flushPendingSessions,
        SESSION_PERSIST_MAX_DELAY_MS,
      );
    }
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

  const recoverSessionFromEventLog = useCallback(async (session: ChatSession): Promise<ChatSession | null> => {
    try {
      const replay = await chatEventsReplay(session.id);
      if (replay.eventCount === 0 && replay.turns.length === 0) return null;
      if (replay.turns.length === 0 && (session.turnCount ?? 0) > 0) return null;
      return {
        ...session,
        turns: replay.turns,
        turnsLoaded: true,
        turnsPartial: false,
        turnCount: replay.turns.length,
        loadedTurnStartIndex: 0,
        questionCountBeforeLoadedTurns: 0,
        partialBaseTurnIds: undefined,
        title: session.title === "New chat" ? titleFromTurns(replay.turns) : session.title,
      };
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (!isTauri() || currentId === HOME_SESSION_ID) return;
    const session = sessionsRef.current.find((item) => item.id === currentId);
    if (!session || session.turnsLoaded !== false || loadingSessionIds.current.has(currentId)) return;
    loadingSessionIds.current.add(currentId);
    chatUiSessionLoad<ChatSession>(currentId)
      .catch(() => null)
      .then((stored) => stored ?? recoverSessionFromEventLog(session))
      .then((stored) => {
        if (!stored) throw new Error("chat session not found");
        const loaded = { ...migrateSession(stored, session.projectId), turnsLoaded: true };
        setAllSessions((previous) => previous.map((item) => {
          if (item.id !== currentId) return item;
          const merged = mergeRemoteLoadedSession(item, loaded);
          const remoteBuffer = remoteTurnBuffers.current.get(currentId);
          return remoteBuffer ? applyRemoteTurnBuffer(merged, { ...remoteBuffer }) : merged;
        }));
      })
      .catch((error) => setError(`Failed to load chat session: ${String(error)}`))
      .finally(() => {
        loadingSessionIds.current.delete(currentId);
      });
  }, [currentId, recoverSessionFromEventLog, setError]);

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
    // Stream listeners are process-wide and also receive paired-phone events
    // for unselected sessions. Do not materialize a summary-only session with
    // an empty transcript merely because a delta arrived; the selected-session
    // loader will merge the remote buffer when the user actually opens it.
    if (sessionsRef.current.find((session) => session.id === id)?.turnsLoaded === false) return;
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

  const hydrateOmittedTurn = useCallback((id: string, turnIndex: number, turn: ChatTurn) => {
    if (id === HOME_SESSION_ID) return;
    setAllSessions((previous) => previous.map((session) => {
      if (session.id !== id) return session;
      let replaced = false;
      const turns = session.turns.map((item) => {
        if (item.omittedTurnIndex !== turnIndex) return item;
        replaced = true;
        return turn;
      });
      return replaced ? { ...session, turns, turnsLoaded: true } : session;
    }));
  }, []);

  const prependEarlierTurns = useCallback((id: string, startIndex: number, earlierTurns: ChatTurn[]) => {
    if (id === HOME_SESSION_ID) return;
    setAllSessions((previous) => previous.map((session) => {
      if (session.id !== id) return session;
      const existingIds = new Set(session.turns.map((turn) => turn.id));
      const loadedIds = new Set<string>();
      const prefix = earlierTurns.filter((turn) => {
        if (existingIds.has(turn.id) || loadedIds.has(turn.id)) return false;
        loadedIds.add(turn.id);
        return true;
      });
      const turns = [...prefix, ...session.turns];
      const turnsPartial = startIndex > 0
        || turns.some((turn) => turn.omittedTurnIndex != null);
      const turnCount = Math.max(session.turnCount ?? session.turns.length, turns.length);
      const loadedQuestionCount = prefix.filter((turn) => turn.role === "user").length;
      const loadedTurnStartIndex = turnsPartial ? startIndex : 0;
      const questionCountBeforeLoadedTurns = turnsPartial
        ? Math.max(0, (session.questionCountBeforeLoadedTurns ?? 0) - loadedQuestionCount)
        : 0;
      const partialBaseTurnIds = turnsPartial
        ? [...new Set([...(session.partialBaseTurnIds ?? []), ...prefix.map((turn) => turn.id)])]
        : undefined;
      return {
        ...session,
        turns,
        turnsLoaded: true,
        turnsPartial,
        turnCount,
        loadedTurnStartIndex,
        questionCountBeforeLoadedTurns,
        partialBaseTurnIds,
      };
    }));
  }, []);

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
    hydrateOmittedTurn,
    prependEarlierTurns,
    newSession,
    setDraft,
    renameSession,
    togglePinned,
    removeSession,
    restoreSession,
  };
}
