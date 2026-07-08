// Session controller of the Chat controller stack. Sits on top of
// `useChatSessions` (which owns the session data) and adds the session-lifecycle
// UI concerns the Chat view needs: optimistic delete with a 6s undo window,
// backend deletion of the persisted transcript, and the sidebar open/width
// state. Pure session-list CRUD stays in `useChatSessions`.

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { chatDelete, chatUiSessionDelete, isTauri } from "../api/tauri";
import { useStore } from "../store";
import type { ChatSession } from "./types";

const CHAT_SIDEBAR_WIDTH_KEY = "somniq-chat-sidebar-w";
const CHAT_SIDEBAR_WIDTH_LEGACY_KEY = "aris-chat-sidebar-w";

interface UseChatSessionControllerArgs {
  removeSession: (id: string) => ChatSession | null;
  restoreSession: (session: ChatSession) => void;
}

export function useChatSessionController({
  removeSession,
  restoreSession,
}: UseChatSessionControllerArgs) {
  const setError = useStore((state) => state.setError);
  const [deleted, setDeleted] = useState<ChatSession | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [chatSidebarWidth, setChatSidebarWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem(CHAT_SIDEBAR_WIDTH_KEY) ?? localStorage.getItem(CHAT_SIDEBAR_WIDTH_LEGACY_KEY));
    return v >= 150 && v <= 400 ? v : 218;
  });
  const chatSidebarResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const deleteTimers = useRef(new Map<string, { timer: number; projectId: string }>());

  const deletePersistedSession = useCallback((sessionId: string, projectId: string) => {
    if (!isTauri()) return;
    void Promise.all([
      chatDelete(sessionId, projectId),
      chatUiSessionDelete(sessionId),
    ]).catch((error) => setError(String(error)));
  }, [setError]);

  // Flush any pending (undo-window) deletions to the backend on unmount so a
  // navigation away still lands the delete.
  useEffect(() => () => {
    deleteTimers.current.forEach(({ timer, projectId }, sessionId) => {
      window.clearTimeout(timer);
      deletePersistedSession(sessionId, projectId);
    });
    deleteTimers.current.clear();
  }, [deletePersistedSession]);

  const deleteSession = useCallback((id: string) => {
    const removed = removeSession(id);
    if (!removed) return;
    setDeleted(removed);
    const timer = window.setTimeout(() => {
      deletePersistedSession(removed.id, removed.projectId);
      deleteTimers.current.delete(removed.id);
      setDeleted((current) => current?.id === removed.id ? null : current);
    }, 6000);
    deleteTimers.current.set(removed.id, { timer, projectId: removed.projectId });
  }, [deletePersistedSession, removeSession]);

  const undoDelete = useCallback(() => {
    if (!deleted) return;
    const pending = deleteTimers.current.get(deleted.id);
    if (pending) window.clearTimeout(pending.timer);
    deleteTimers.current.delete(deleted.id);
    restoreSession(deleted);
    setDeleted(null);
  }, [deleted, restoreSession]);

  const onChatSidebarResizeStart = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    chatSidebarResizeRef.current = { startX: e.clientX, startWidth: chatSidebarWidth };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [chatSidebarWidth]);
  const onChatSidebarResizeMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!chatSidebarResizeRef.current) return;
    const w = Math.max(150, Math.min(400, chatSidebarResizeRef.current.startWidth + (e.clientX - chatSidebarResizeRef.current.startX)));
    setChatSidebarWidth(w);
  }, []);
  const onChatSidebarResizeEnd = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!chatSidebarResizeRef.current) return;
    const w = Math.max(150, Math.min(400, chatSidebarResizeRef.current.startWidth + (e.clientX - chatSidebarResizeRef.current.startX)));
    chatSidebarResizeRef.current = null;
    setChatSidebarWidth(w);
    localStorage.setItem(CHAT_SIDEBAR_WIDTH_KEY, String(w));
    localStorage.removeItem(CHAT_SIDEBAR_WIDTH_LEGACY_KEY);
  }, []);

  useEffect(() => {
    document.body.style.setProperty("--chat-sidebar-w", `${chatSidebarWidth}px`);
    return () => { document.body.style.removeProperty("--chat-sidebar-w"); };
  }, [chatSidebarWidth]);

  return {
    deleted,
    deleteSession,
    undoDelete,
    sidebarOpen,
    setSidebarOpen,
    chatSidebarWidth,
    onChatSidebarResizeStart,
    onChatSidebarResizeMove,
    onChatSidebarResizeEnd,
  };
}
