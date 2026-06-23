import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import type { DesktopProject } from "../types";
import { useStore } from "../store";
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
  onReorderProjects: (ids: string[]) => Promise<void>;
}

function moveProjectId(
  ids: string[],
  draggedId: string,
  targetId: string,
  placeAfter: boolean,
) {
  if (draggedId === targetId) return ids;
  const next = ids.filter((id) => id !== draggedId);
  const targetIndex = next.indexOf(targetId);
  if (targetIndex === -1 || next.length === ids.length) return ids;
  next.splice(placeAfter ? targetIndex + 1 : targetIndex, 0, draggedId);
  return next;
}

function sameProjectOrder(left: string[], right: string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

type SessionMenuAnchor = {
  id: string;
  rect: Pick<DOMRect, "top" | "right" | "bottom" | "left">;
};

type SessionMenuPosition = {
  top: number;
  left: number;
};

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
  onReorderProjects,
}: Props) {
  const [query, setQuery] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null);
  const [projectOrderPreview, setProjectOrderPreview] = useState<string[] | null>(null);
  const [openMenu, setOpenMenu] = useState<SessionMenuAnchor | null>(null);
  const [menuPosition, setMenuPosition] = useState<SessionMenuPosition | null>(null);
  const [unreadIds, setUnreadIds] = useState<Set<string>>(new Set());
  const setTab = useStore((s) => s.setTab);
  const sessionListRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const groupRefs = useRef(new Map<string, HTMLElement>());
  const projectOrderPreviewRef = useRef<string[] | null>(null);
  const projectDragRef = useRef<{
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const openMenuId = openMenu?.id ?? null;
  const groups = useMemo(
    () => groupSessionsByProject(
      sessions.filter((session) => fuzzyMatch(query, session.title)),
      projects,
    ),
    [projects, query, sessions],
  );
  const orderedGroups = useMemo(() => {
    const order = new Map(
      (projectOrderPreview ?? projects.map((project) => project.id))
        .map((id, index) => [id, index]),
    );
    return groups
      .slice()
      .sort((left, right) =>
        (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(right.id) ?? Number.MAX_SAFE_INTEGER),
      );
  }, [groups, projectOrderPreview, projects]);
  const canReorderProjects = !busy && projects.length > 1;

  useEffect(() => {
    if (!openMenuId) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".chat-session-menu") && !target.closest(".chat-session-menu-btn")) {
        setOpenMenu(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [openMenuId]);

  useEffect(() => {
    if (!openMenuId) return;
    const closeMenu = () => setOpenMenu(null);
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    document.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
      document.removeEventListener("keydown", handleKey);
    };
  }, [openMenuId]);

  useLayoutEffect(() => {
    if (!openMenu || !menuRef.current) {
      setMenuPosition(null);
      return;
    }
    const menuRect = menuRef.current.getBoundingClientRect();
    const margin = 8;
    const gap = 4;
    const maxLeft = Math.max(margin, window.innerWidth - menuRect.width - margin);
    const left = Math.min(Math.max(margin, openMenu.rect.right - menuRect.width), maxLeft);
    const belowTop = openMenu.rect.bottom + gap;
    const aboveTop = openMenu.rect.top - menuRect.height - gap;
    const fitsBelow = belowTop + menuRect.height <= window.innerHeight - margin;
    const top = fitsBelow ? belowTop : Math.max(margin, aboveTop);
    setMenuPosition((current) => (
      current && Math.abs(current.top - top) < 0.5 && Math.abs(current.left - left) < 0.5
        ? current
        : { top, left }
    ));
  }, [openMenu]);

  const setGroupRef = (id: string) => (element: HTMLElement | null) => {
    if (element) groupRefs.current.set(id, element);
    else groupRefs.current.delete(id);
  };

  const animateProjectOrderPreview = (ids: string[]) => {
    const previousTop = new Map<string, number>();
    groupRefs.current.forEach((element, id) => {
      previousTop.set(id, element.getBoundingClientRect().top);
    });
    projectOrderPreviewRef.current = ids;
    setProjectOrderPreview(ids);
    window.requestAnimationFrame(() => {
      groupRefs.current.forEach((element, id) => {
        const from = previousTop.get(id);
        if (from === undefined) return;
        const delta = from - element.getBoundingClientRect().top;
        if (Math.abs(delta) < 1) return;
        element.animate(
          [
            { transform: `translateY(${delta}px)` },
            { transform: "translateY(0)" },
          ],
          {
            duration: 150,
            easing: "cubic-bezier(0.2, 0, 0, 1)",
          },
        );
      });
    });
  };

  const projectOrderFromPointer = (clientY: number, draggedId: string) => {
    const labels = Array.from(
      sessionListRef.current?.querySelectorAll<HTMLElement>(
        "[data-chat-project-label-id]",
      ) ?? [],
    ).filter((label) => label.dataset.chatProjectLabelId !== draggedId);
    if (labels.length === 0) return null;
    const currentIds = projectOrderPreviewRef.current ?? projects.map((project) => project.id);
    const before = labels.find((label) => {
      const rect = label.getBoundingClientRect();
      return clientY < rect.top + rect.height / 2;
    });
    if (before?.dataset.chatProjectLabelId) {
      return moveProjectId(currentIds, draggedId, before.dataset.chatProjectLabelId, false);
    }
    const last = labels[labels.length - 1]?.dataset.chatProjectLabelId;
    return last ? moveProjectId(currentIds, draggedId, last, true) : currentIds;
  };

  const startProjectDrag = (
    event: ReactPointerEvent<HTMLElement>,
    id: string,
  ) => {
    if (!canReorderProjects || event.button !== 0) return;
    projectDragRef.current = {
      id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveProjectDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = projectDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.moved) {
      const deltaX = Math.abs(event.clientX - drag.startX);
      const deltaY = Math.abs(event.clientY - drag.startY);
      if (deltaX + deltaY < 4) return;
      drag.moved = true;
      const ids = projects.map((project) => project.id);
      projectOrderPreviewRef.current = ids;
      setProjectOrderPreview(ids);
      setDraggedProjectId(drag.id);
    }
    event.preventDefault();
    event.stopPropagation();
    const currentIds = projectOrderPreviewRef.current ?? projects.map((project) => project.id);
    const ids = projectOrderFromPointer(event.clientY, drag.id);
    if (!ids || sameProjectOrder(ids, currentIds)) return;
    animateProjectOrderPreview(ids);
  };

  const finishProjectDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = projectDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.moved) {
      event.preventDefault();
      event.stopPropagation();
    }
    const ids = projectOrderPreviewRef.current;
    projectDragRef.current = null;
    projectOrderPreviewRef.current = null;
    setDraggedProjectId(null);
    setProjectOrderPreview(null);
    if (ids && drag.moved && !sameProjectOrder(ids, projects.map((project) => project.id))) {
      void onReorderProjects(ids).catch(() => undefined);
    }
  };

  const cancelProjectDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = projectDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    projectDragRef.current = null;
    projectOrderPreviewRef.current = null;
    setDraggedProjectId(null);
    setProjectOrderPreview(null);
  };

  const beginRename = (session: ChatSession) => {
    setRenamingId(session.id);
    setRenameValue(session.title);
  };

  const finishRename = () => {
    if (renamingId) onRename(renamingId, renameValue);
    setRenamingId(null);
  };

  const toggleUnread = (id: string) => {
    setUnreadIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleOpen = (id: string) => {
    setUnreadIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    void onOpen(id);
    onClose();
  };

  const toggleSessionMenu = (
    event: ReactMouseEvent<HTMLButtonElement>,
    id: string,
  ) => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setMenuPosition(null);
    setOpenMenu((current) => (
      current?.id === id
        ? null
        : {
          id,
          rect: {
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            left: rect.left,
          },
        }
    ));
  };

  const closeSessionMenu = () => {
    setOpenMenu(null);
    setMenuPosition(null);
  };

  const menuStyle = openMenu
    ? {
      top: menuPosition?.top ?? openMenu.rect.bottom + 4,
      left: menuPosition?.left ?? openMenu.rect.left,
      visibility: menuPosition ? "visible" : "hidden",
    } as const
    : undefined;

  return (
    <aside className={`chat-sidebar${open ? " open" : ""}`} aria-label="Chat sessions">
      <div className="chat-sidebar-container">
        <div className="chat-sidebar-top-group">
        <div className="chat-sidebar-title">Chat</div>
      <div className="chat-sidebar-head">
        <div className="chat-sidebar-top-row">
          <button className="chat-new-btn" onClick={onNew} disabled={busy}>
            <span className="chat-new-icon">+</span>
            <span>新线程</span>
          </button>
          <button className="chat-sidebar-close" onClick={onClose} aria-label="Close chat sidebar">×</button>
        </div>
        <button
          className="chat-scheduled-btn"
          onClick={() => setTab("scheduled")}
        >
          <span className="chat-scheduled-icon">⚡</span>
          <span>定时任务</span>
        </button>
      </div>
        </div>
      <div className="chat-session-search">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索对话"
          aria-label="Search chats"
        />
      </div>
      <div className="chat-session-list" ref={sessionListRef}>
        {groups.length === 0 && <div className="chat-session-empty">无匹配对话</div>}
        {orderedGroups.map((group) => (
          <section
            className={`chat-session-group${draggedProjectId === group.id ? " dragging" : ""}`}
            key={group.id}
            data-chat-project-id={group.id}
            ref={setGroupRef(group.id)}
          >
            <div
              className={`chat-sidebar-label chat-project-label${canReorderProjects ? " can-reorder" : ""}`}
              data-chat-project-label-id={group.id}
              onPointerDown={(event) => startProjectDrag(event, group.id)}
              onPointerMove={moveProjectDrag}
              onPointerUp={finishProjectDrag}
              onPointerCancel={cancelProjectDrag}
              title={canReorderProjects ? "Drag to reorder projects" : undefined}
            >
              <span className="chat-project-drag-handle" aria-hidden="true">::</span>
              <span className="chat-project-label-text">{group.label}</span>
            </div>
            {group.sessions.map((session) => (
              <div
                key={session.id}
                className={`chat-session-item${session.id === currentId ? " active" : ""}${unreadIds.has(session.id) ? " unread" : ""}`}
                onClick={() => handleOpen(session.id)}
                onDoubleClick={() => beginRename(session)}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    handleOpen(session.id);
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
                  <div className="chat-session-title">
                    {unreadIds.has(session.id) && <span className="chat-unread-dot" aria-label="Unread" />}
                    {session.title}
                  </div>
                )}
                <button
                  className="chat-session-menu-btn"
                  onClick={(event) => toggleSessionMenu(event, session.id)}
                  aria-label="Session options"
                  aria-haspopup="true"
                  aria-expanded={openMenuId === session.id}
                >
                  ···
                </button>
                {openMenuId === session.id && createPortal(
                  <div
                    ref={menuRef}
                    className="chat-session-menu"
                    role="menu"
                    style={menuStyle}
                  >
                    <button
                      role="menuitem"
                      className={session.pinned ? "active" : ""}
                      onClick={(event) => {
                        event.stopPropagation();
                        onTogglePinned(session.id);
                        closeSessionMenu();
                      }}
                    >
                      {session.pinned ? "取消置顶" : "置顶"}
                      <span className="chat-session-menu-key">P</span>
                    </button>
                    <button
                      role="menuitem"
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleUnread(session.id);
                        closeSessionMenu();
                      }}
                    >
                      {unreadIds.has(session.id) ? "标为已读" : "标为未读"}
                      <span className="chat-session-menu-key">U</span>
                    </button>
                    <button
                      role="menuitem"
                      onClick={(event) => {
                        event.stopPropagation();
                        beginRename(session);
                        closeSessionMenu();
                      }}
                    >
                      重命名
                      <span className="chat-session-menu-key">R</span>
                    </button>
                    <div className="chat-session-menu-divider" role="separator" />
                    <button
                      role="menuitem"
                      className="danger"
                      onClick={(event) => {
                        event.stopPropagation();
                        onDelete(session.id);
                        closeSessionMenu();
                      }}
                    >
                      删除
                      <span className="chat-session-menu-key">D</span>
                    </button>
                  </div>,
                  document.body,
                )}
              </div>
            ))}
          </section>
        ))}
      </div>
      </div>
    </aside>
  );
}
