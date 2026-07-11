import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import type { DesktopProject } from "../types";
import { useStore } from "../store";
import { CHAT_COPY } from "./i18n";
import { groupSessionsByProject } from "./model";
import type { ChatSession } from "./types";

interface Props {
  sessions: ChatSession[];
  projects: DesktopProject[];
  currentId: string;
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onNew: (projectId?: string) => void | Promise<void>;
  onOpen: (id: string) => void | Promise<void>;
  onRename: (id: string, title: string) => void;
  onTogglePinned: (id: string) => void;
  onDelete: (id: string) => void;
  onReorderProjects: (ids: string[]) => Promise<void>;
}

const AUTO_COLLAPSE_SESSION_COUNT = 5;
const PINNED_GROUP_ID = "__pinned__";

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

function FolderIcon({ open }: { open: boolean }) {
  return open ? (
    <svg viewBox="0 0 20 20" width="13" height="13" fill="currentColor" aria-hidden="true">
      <path d="M2.879 4.879A2.25 2.25 0 014.5 4.5H8a2.25 2.25 0 011.591.659l1.09 1.09H16a2.25 2.25 0 012.187 1.706 3 3 0 00-1.187-.256H4.75a3 3 0 00-2.871 3.858L2 10.75V6.75a2.25 2.25 0 01.879-1.871zM3.879 12.879a1.5 1.5 0 011.06-.379h11.122a1.5 1.5 0 011.442 1.902l-1.2 4.5A1.5 1.5 0 0114.86 20H4.5a1.5 1.5 0 01-1.44-1.902l1.2-4.5c.078-.293.223-.55.42-.719z" />
    </svg>
  ) : (
    <svg viewBox="0 0 20 20" width="13" height="13" fill="currentColor" aria-hidden="true">
      <path d="M2 6a2 2 0 012-2h5.379a2 2 0 011.415.586l1.414 1.414a1 1 0 00.707.293H16a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
    </svg>
  );
}

function untransformedTop(element: HTMLElement) {
  const previousTransform = element.style.transform;
  if (previousTransform) element.style.transform = "none";
  const top = element.getBoundingClientRect().top;
  if (previousTransform) element.style.transform = previousTransform;
  return top;
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
  onReorderProjects,
}: Props) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null);
  const [draggedProjectOffsetY, setDraggedProjectOffsetY] = useState(0);
  const [projectOrderPreview, setProjectOrderPreview] = useState<string[] | null>(null);
  const [openMenu, setOpenMenu] = useState<SessionMenuAnchor | null>(null);
  const [menuPosition, setMenuPosition] = useState<SessionMenuPosition | null>(null);
  const [unreadIds, setUnreadIds] = useState<Set<string>>(new Set());
  const [manualGroupState, setManualGroupState] = useState<Record<string, "expanded" | "collapsed">>({});
  const language = useStore((s) => s.language);
  const setTab = useStore((s) => s.setTab);
  const copy = CHAT_COPY[language];
  const sessionListRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const groupRefs = useRef(new Map<string, HTMLElement>());
  const projectOrderPreviewRef = useRef<string[] | null>(null);
  const projectDragRef = useRef<{
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    currentY: number;
    grabOffsetY: number;
    moved: boolean;
  } | null>(null);
  const suppressProjectToggleClickRef = useRef<string | null>(null);
  const openMenuId = openMenu?.id ?? null;
  const pinnedSessions = useMemo(
    () => sessions
      .filter((session) => session.pinned)
      .sort((left, right) => right.updatedAt - left.updatedAt),
    [sessions],
  );
  const groups = useMemo(
    () => groupSessionsByProject(sessions.filter((session) => !session.pinned), projects),
    [projects, sessions],
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

  useEffect(() => {
    return () => {
      document.removeEventListener("pointermove", handleDocumentProjectMove, true);
      document.removeEventListener("pointerup", handleDocumentProjectUp, true);
      document.removeEventListener("pointercancel", handleDocumentProjectCancel, true);
    };
  }, []);

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

  const removeProjectDragListeners = () => {
    document.removeEventListener("pointermove", handleDocumentProjectMove, true);
    document.removeEventListener("pointerup", handleDocumentProjectUp, true);
    document.removeEventListener("pointercancel", handleDocumentProjectCancel, true);
  };

  const resetProjectDrag = () => {
    projectDragRef.current = null;
    projectOrderPreviewRef.current = null;
    setDraggedProjectId(null);
    setDraggedProjectOffsetY(0);
    setProjectOrderPreview(null);
  };

  const updateProjectDragOffset = (clientY: number) => {
    const drag = projectDragRef.current;
    if (!drag) return;
    drag.currentY = clientY;
    const element = groupRefs.current.get(drag.id);
    if (!element) return;
    const baseTop = untransformedTop(element);
    const nextOffset = clientY - drag.grabOffsetY - baseTop;
    if (!Number.isFinite(nextOffset)) return;
    setDraggedProjectOffsetY((current) => (
      Math.abs(nextOffset - current) < 0.5 ? current : nextOffset
    ));
  };

  const animateProjectOrderPreview = (ids: string[]) => {
    const draggedId = projectDragRef.current?.id ?? null;
    const previousTop = new Map<string, number>();
    groupRefs.current.forEach((element, id) => {
      if (id === draggedId) return;
      previousTop.set(id, element.getBoundingClientRect().top);
    });
    projectOrderPreviewRef.current = ids;
    setProjectOrderPreview(ids);
    window.requestAnimationFrame(() => {
      const drag = projectDragRef.current;
      if (drag) updateProjectDragOffset(drag.currentY);
      groupRefs.current.forEach((element, id) => {
        if (id === draggedId) return;
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
            duration: 190,
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
    if (projectDragRef.current) return;
    const rect = groupRefs.current.get(id)?.getBoundingClientRect();
    projectDragRef.current = {
      id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      currentY: event.clientY,
      grabOffsetY: rect ? event.clientY - rect.top : 0,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.addEventListener("pointermove", handleDocumentProjectMove, true);
    document.addEventListener("pointerup", handleDocumentProjectUp, true);
    document.addEventListener("pointercancel", handleDocumentProjectCancel, true);
  };

  const handleDocumentProjectMove = (event: PointerEvent) =>
    documentProjectHandlersRef.current.move(event);
  const handleDocumentProjectUp = (event: PointerEvent) =>
    documentProjectHandlersRef.current.up(event);
  const handleDocumentProjectCancel = (event: PointerEvent) =>
    documentProjectHandlersRef.current.cancel(event);

  const documentProjectHandlersRef = useRef<{
    move: (event: PointerEvent) => void;
    up: (event: PointerEvent) => void;
    cancel: (event: PointerEvent) => void;
  }>({
    move: () => undefined,
    up: () => undefined,
    cancel: () => undefined,
  });
  documentProjectHandlersRef.current.move = (event) => {
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
    updateProjectDragOffset(event.clientY);
    const currentIds = projectOrderPreviewRef.current ?? projects.map((project) => project.id);
    const ids = projectOrderFromPointer(event.clientY, drag.id);
    if (!ids || sameProjectOrder(ids, currentIds)) return;
    animateProjectOrderPreview(ids);
  };
  documentProjectHandlersRef.current.up = (event) => {
    const drag = projectDragRef.current;
    if (!drag) return;
    if (drag.pointerId !== event.pointerId) return;
    removeProjectDragListeners();
    if (drag.moved) {
      event.preventDefault();
      event.stopPropagation();
      suppressProjectToggleClickRef.current = drag.id;
    }
    const ids = projectOrderPreviewRef.current;
    resetProjectDrag();
    if (ids && drag.moved && !sameProjectOrder(ids, projects.map((project) => project.id))) {
      void onReorderProjects(ids).catch(() => undefined);
    }
  };
  documentProjectHandlersRef.current.cancel = (event) => {
    const drag = projectDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    removeProjectDragListeners();
    resetProjectDrag();
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

  const groupHasOverflow = (sessionCount: number) =>
    sessionCount > AUTO_COLLAPSE_SESSION_COUNT;

  const groupCollapsed = (groupId: string, sessionCount: number) => {
    if (sessionCount <= AUTO_COLLAPSE_SESSION_COUNT) return false;
    const manual = manualGroupState[groupId];
    return manual !== "expanded";
  };

  const toggleGroupCollapsed = (groupId: string, sessionCount: number) => {
    if (!groupHasOverflow(sessionCount)) return;
    const collapsed = groupCollapsed(groupId, sessionCount);
    setManualGroupState((current) => ({
      ...current,
      [groupId]: collapsed ? "expanded" : "collapsed",
    }));
  };

  const menuStyle = openMenu
    ? {
      top: menuPosition?.top ?? openMenu.rect.bottom + 4,
      left: menuPosition?.left ?? openMenu.rect.left,
      visibility: menuPosition ? "visible" : "hidden",
    } as const
    : undefined;

  const renderSessionItem = (session: ChatSession) => (
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
          {unreadIds.has(session.id) && <span className="chat-unread-dot" aria-label={copy.unread} />}
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
  );

  const pinnedCollapsed = groupCollapsed(PINNED_GROUP_ID, pinnedSessions.length);
  const pinnedHasOverflow = groupHasOverflow(pinnedSessions.length);
  const visiblePinned = pinnedCollapsed
    ? pinnedSessions.slice(0, AUTO_COLLAPSE_SESSION_COUNT)
    : pinnedSessions;

  return (
    <aside
      id="chat-session-sidebar"
      className={`chat-sidebar${open ? " open" : ""}`}
    >
      <div className="chat-sidebar-container">
        <div className="chat-sidebar-top-group">
      <div className="chat-sidebar-head">
        <div className="chat-sidebar-top-row">
          <button className="chat-new-btn" onClick={() => void onNew()} disabled={busy}>
            <span className="chat-new-icon">+</span>
            <span>{copy.newChat}</span>
          </button>
          <button className="chat-sidebar-close" onClick={onClose} aria-label={copy.closeSidebar}>×</button>
        </div>
        <button
          className="chat-scheduled-btn"
          onClick={() => setTab("scheduled")}
        >
          <span className="chat-scheduled-icon">⚡</span>
          <span>{copy.scheduledTasks}</span>
        </button>
      </div>
        </div>
      <div className="chat-session-list" ref={sessionListRef}>
        {pinnedSessions.length > 0 && (
          <section className="chat-session-group chat-pinned-group">
            <div className="chat-sidebar-label">{copy.pinnedSection}</div>
            {visiblePinned.map((session) => renderSessionItem(session))}
            {pinnedHasOverflow && (
              <button
                className="chat-session-collapsed-summary"
                type="button"
                onClick={() => toggleGroupCollapsed(PINNED_GROUP_ID, pinnedSessions.length)}
              >
                {pinnedCollapsed ? copy.showMoreChats : copy.showFewerChats}
              </button>
            )}
          </section>
        )}
        <div className="chat-sidebar-label chat-projects-label">{copy.projectsSection}</div>
        {groups.length === 0 && <div className="chat-session-empty">{copy.noMatchingChats}</div>}
        {orderedGroups.map((group) => {
          const collapsed = groupCollapsed(group.id, group.sessions.length);
          const hasOverflow = groupHasOverflow(group.sessions.length);
          const visibleSessions = collapsed
            ? group.sessions.slice(0, AUTO_COLLAPSE_SESSION_COUNT)
            : group.sessions;
          const dragStyle: CSSProperties | undefined = draggedProjectId === group.id
            ? { transform: `translateY(${draggedProjectOffsetY}px)` }
            : undefined;
          return (
          <section
            className={`chat-session-group${draggedProjectId === group.id ? " dragging" : ""}${collapsed ? " collapsed" : ""}`}
            key={group.id}
            data-chat-project-id={group.id}
            ref={setGroupRef(group.id)}
            style={dragStyle}
          >
            <div
              className={`chat-sidebar-label chat-project-label${canReorderProjects ? " can-reorder" : ""}`}
              data-chat-project-label-id={group.id}
              onPointerDown={(event) => startProjectDrag(event, group.id)}
            >
              <button
                className="chat-project-toggle"
                type="button"
                aria-expanded={!collapsed}
                aria-label={`${group.label}, ${copy.chatsCount(group.sessions.length)}, ${collapsed ? copy.collapsed : copy.expanded}`}
                onClick={(event) => {
                  event.stopPropagation();
                  if (suppressProjectToggleClickRef.current === group.id) {
                    suppressProjectToggleClickRef.current = null;
                    event.preventDefault();
                    return;
                  }
                  toggleGroupCollapsed(group.id, group.sessions.length);
                }}
              >
                <span className="chat-project-caret" aria-hidden="true">
                  <FolderIcon open={!collapsed} />
                </span>
                <span className="chat-project-label-text">{group.label}</span>
              </button>
              <button
                className="chat-project-add"
                type="button"
                aria-label={copy.newChatInProject(group.label)}
                title={copy.newChatInThisProject}
                disabled={busy}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void onNew(group.id);
                }}
              >
                +
              </button>
            </div>
            {visibleSessions.map((session) => renderSessionItem(session))}
            {hasOverflow && (
              <button
                className="chat-session-collapsed-summary"
                type="button"
                onClick={() => toggleGroupCollapsed(group.id, group.sessions.length)}
              >
                {collapsed ? copy.showMoreChats : copy.showFewerChats}
              </button>
            )}
          </section>
          );
        })}
      </div>
      </div>
    </aside>
  );
}
