import { useMemo, useState } from "react";
import type { DesktopProject } from "../types";
import { fuzzyMatch, groupSessionsByProject } from "./model";
import type { ChatSession } from "./types";

interface Props {
  sessions: ChatSession[];
  projects: DesktopProject[];
  currentId: string;
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onNew: () => void;
  onOpen: (id: string) => void | Promise<void>;
  onRename: (id: string, title: string) => void;
  onTogglePinned: (id: string) => void;
  onDelete: (id: string) => void;
}

export default function ChatSidebar({
  sessions,
  projects,
  currentId,
  open,
  busy,
  onClose,
  onNew,
  onOpen,
  onRename,
  onTogglePinned,
  onDelete,
}: Props) {
  const [query, setQuery] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const groups = useMemo(
    () => groupSessionsByProject(
      sessions.filter((session) => fuzzyMatch(query, session.title)),
      projects,
    ),
    [projects, query, sessions],
  );

  const beginRename = (session: ChatSession) => {
    setRenamingId(session.id);
    setRenameValue(session.title);
  };

  const finishRename = () => {
    if (renamingId) onRename(renamingId, renameValue);
    setRenamingId(null);
  };

  return (
    <aside className={`chat-sidebar${open ? " open" : ""}`} aria-label="Chat sessions">
      <div className="chat-sidebar-head">
        <button className="chat-new-btn" onClick={onNew} disabled={busy}>
          <span className="chat-new-icon">+</span>
          <span>New chat</span>
        </button>
        <button className="chat-sidebar-close" onClick={onClose} aria-label="Close chat sidebar">×</button>
      </div>
      <div className="chat-session-search">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search chats"
          aria-label="Search chats"
        />
      </div>
      <div className="chat-session-list">
        {groups.length === 0 && <div className="chat-session-empty">No matching chats</div>}
        {groups.map((group) => (
          <section className="chat-session-group" key={group.id}>
            <div className="chat-sidebar-label">{group.label}</div>
            {group.sessions.map((session) => (
              <div
                key={session.id}
                className={`chat-session-item${session.id === currentId ? " active" : ""}`}
                onClick={() => {
                  void onOpen(session.id);
                  onClose();
                }}
                onDoubleClick={() => beginRename(session)}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    void onOpen(session.id);
                    onClose();
                  }
                }}
              >
                {renamingId === session.id ? (
                  <input
                    className="chat-session-rename"
                    value={renameValue}
                    autoFocus
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => setRenameValue(event.target.value)}
                    onBlur={finishRename}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === "Enter") finishRename();
                      if (event.key === "Escape") setRenamingId(null);
                    }}
                  />
                ) : (
                  <div className="chat-session-title">{session.title}</div>
                )}
                <div className="chat-session-actions">
                  <button
                    className={session.pinned ? "active" : ""}
                    onClick={(event) => {
                      event.stopPropagation();
                      onTogglePinned(session.id);
                    }}
                    title={session.pinned ? "Unpin" : "Pin"}
                    aria-label={session.pinned ? "Unpin chat" : "Pin chat"}
                  >
                    {session.pinned ? "●" : "○"}
                  </button>
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      beginRename(session);
                    }}
                    title="Rename"
                    aria-label="Rename chat"
                  >
                    ✎
                  </button>
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      onDelete(session.id);
                    }}
                    title="Delete"
                    aria-label="Delete chat"
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
          </section>
        ))}
      </div>
    </aside>
  );
}
