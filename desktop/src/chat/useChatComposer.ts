// Composer-state layer of the Chat controller. Owns everything about the input
// surface: the draft text + attachments (persisted on the session), the
// edit-in-place target, focus requests, composer height, the file-path context
// menu, and drag-and-drop file attaching. Nothing here talks to the run/stream
// backend — it only reads the current session and mutates its draft.

import { useCallback, useEffect, useState } from "react";
import { attachmentFromFile } from "./ChatComposer";
import { isTauri } from "../api/tauri";
import { useStore } from "../store";
import { makeId } from "./model";
import type { ChatSession } from "./types";
import type { ChatAttachment } from "../types";

// Matches relative file paths like `desktop/src/chat/Chat.tsx` or `./src/lib.rs:42`
const FILE_PATH_RE = /^(\.\.?\/)?([a-zA-Z0-9_\-.]+\/)+[a-zA-Z0-9_\-.]+(:\d+)?$/;

function basename(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() || path;
}

function detectFilePath(element: HTMLElement): string | null {
  // Local markdown link — use the href (already decoded by MarkdownLink)
  if (element.tagName === "A") {
    const href = element.getAttribute("href");
    if (href && !/^(https?:|#|mailto:)/i.test(href)) {
      const decoded = (() => { try { return decodeURIComponent(href); } catch { return href; } })();
      if (FILE_PATH_RE.test(decoded)) return decoded;
    }
  }
  // Inline code or any element whose entire text looks like a path
  const text = element.textContent?.trim() ?? "";
  if (text && text.length < 260 && !text.includes("\n") && FILE_PATH_RE.test(text)) return text;
  return null;
}

interface UseChatComposerArgs {
  currentSession: ChatSession | null;
  currentSessionRef: React.MutableRefObject<ChatSession | null>;
  updateSession: (id: string, fn: (session: ChatSession) => ChatSession) => void;
  setDraft: (id: string, draft: string) => void;
}

export function useChatComposer({
  currentSession,
  currentSessionRef,
  updateSession,
  setDraft,
}: UseChatComposerArgs) {
  const [composerHeight, setComposerHeight] = useState(120);
  const [editingTurnId, setEditingTurnId] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const [chatDragging, setChatDragging] = useState(false);
  const [fileMenu, setFileMenu] = useState<{ x: number; y: number; path: string } | null>(null);

  const input = currentSession?.draft ?? "";
  const attachments = currentSession?.draftAttachments ?? [];

  const focusComposer = useCallback(() => setFocusRequest((value) => value + 1), []);

  // One-shot composer prefill from other views (e.g. Literature → /arxiv).
  const pendingChatInput = useStore((state) => state.pendingChatInput);
  const setPendingChatInput = useStore((state) => state.setPendingChatInput);
  useEffect(() => {
    const session = currentSessionRef.current;
    if (!pendingChatInput || !session) return;
    setDraft(session.id, pendingChatInput);
    setPendingChatInput(null);
    focusComposer();
  }, [pendingChatInput, setDraft, setPendingChatInput, focusComposer, currentSessionRef]);

  const setAttachments = useCallback((next: ChatAttachment[]) => {
    const session = currentSessionRef.current;
    if (!session) return;
    updateSession(session.id, (item) => ({ ...item, draftAttachments: next }));
  }, [currentSessionRef, updateSession]);

  const addFilesToChat = useCallback(async (files: File[]) => {
    if (!currentSession || files.length === 0) return;
    const sessionId = currentSession.id;
    const next = await Promise.all(
      files.slice(0, 20).map(async (file) => {
        try { return await attachmentFromFile(file); }
        catch { return { id: makeId("att"), kind: "file" as const, name: file.name, mimeType: file.type || "application/octet-stream", content: "(File content could not be read.)" }; }
      }),
    );
    updateSession(sessionId, (s) => ({ ...s, draftAttachments: [...(s.draftAttachments ?? []), ...next] }));
    focusComposer();
  }, [currentSession, focusComposer, updateSession]);

  const addPathsToChat = useCallback((paths: string[]) => {
    if (!currentSession || paths.length === 0) return;
    const next = paths
      .map((path) => path.trim())
      .filter(Boolean)
      .slice(0, 20)
      .map((path): ChatAttachment => ({
        id: makeId("att"),
        kind: "file",
        name: basename(path),
        path,
      }));
    if (next.length === 0) return;
    updateSession(currentSession.id, (session) => ({
      ...session,
      draftAttachments: [...(session.draftAttachments ?? []), ...next],
    }));
    focusComposer();
  }, [currentSession, focusComposer, updateSession]);

  const attachFileFromMenu = useCallback(async (path: string, content: string) => {
    const session = currentSessionRef.current;
    if (!session) return;
    const attachment: ChatAttachment = {
      id: makeId("att"),
      kind: "file",
      name: path.split(/[\\/]/).pop() ?? path,
      path,
      content: content || undefined,
    };
    updateSession(session.id, (s) => ({
      ...s,
      draftAttachments: [...(s.draftAttachments ?? []), attachment],
    }));
    focusComposer();
  }, [focusComposer, updateSession, currentSessionRef]);

  const handleChatContextMenu = useCallback((e: React.MouseEvent<HTMLElement>) => {
    let node = e.target as HTMLElement | null;
    for (let depth = 0; depth < 5 && node; depth++) {
      const found = detectFilePath(node);
      if (found) {
        e.preventDefault();
        setFileMenu({ x: e.clientX, y: e.clientY, path: found });
        return;
      }
      if (node.classList.contains("chat-turn") || node.classList.contains("chat-head")) break;
      node = node.parentElement;
    }
  }, []);

  // OS-level drag/drop (Tauri webview) — attach dropped file paths.
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) => getCurrentWebview().onDragDropEvent((event) => {
        if (disposed) return;
        if (event.payload.type === "enter" || event.payload.type === "over") {
          setChatDragging(true);
          return;
        }
        setChatDragging(false);
        if (event.payload.type === "drop") {
          addPathsToChat(event.payload.paths);
        }
      }))
      .then((cleanup) => {
        if (disposed) cleanup();
        else unlisten = cleanup;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [addPathsToChat]);

  return {
    input,
    attachments,
    composerHeight,
    setComposerHeight,
    editingTurnId,
    setEditingTurnId,
    focusRequest,
    focusComposer,
    chatDragging,
    setChatDragging,
    fileMenu,
    setFileMenu,
    setAttachments,
    addFilesToChat,
    addPathsToChat,
    attachFileFromMenu,
    handleChatContextMenu,
  };
}
