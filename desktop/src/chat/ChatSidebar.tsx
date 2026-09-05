import {
  useCallback,
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
import { fileReveal } from "../api/tauri";
import type {
  ComputePeer,
  DesktopProject,
  RemoteAgentSessions,
  RemoteAgentWorkspace,
} from "../types";
import { useStore } from "../store";
import { SvgIcon } from "../SvgIcon";
import { CHAT_COPY } from "./i18n";
import { groupSessionsByProject } from "./model";
import type { ChatSession, RemoteAgentBinding } from "./types";

interface Props {
  sessions: ChatSession[];
  projects: DesktopProject[];
  currentId: string;
  open: boolean;
  busy: boolean;
  sessionsHydrated?: boolean;
  onClose: () => void;
  onNew: (projectId?: string) => void | Promise<void>;
  onOpen: (id: string) => void | Promise<void>;
  onRename: (id: string, title: string) => void;
  onTogglePinned: (id: string) => void;
  onDelete: (id: string) => void;
  onDeleteProject?: (id: string) => void | Promise<void>;
  onReorderProjects: (ids: string[]) => Promise<void>;
  remotePeers?: ComputePeer[];
  remoteWorkspaces?: Record<string, RemoteAgentWorkspace>;
  remoteSessionLists?: Record<string, RemoteAgentSessions>;
  selectedWorkspaceNodeId?: string | null;
  currentRemoteAgent?: RemoteAgentBinding | null;
  remoteBusy?: boolean;
  onLoadRemoteTargets?: () => void;
  onWorkspaceSelect?: (nodeId: string | null) => void;
  onRemoteProjectSelect?: (nodeId: string, projectId: string) => void | Promise<void>;
  onNewRemote?: (nodeId: string, projectId: string) => void | Promise<void>;
  onOpenRemote?: (nodeId: string, projectId: string, sessionId: string) => void | Promise<void>;
}

const COLLAPSED_SESSION_COUNT = 5;
const PINNED_SESSION_GROUP_ID = "__pinned__";

function sessionsForCollapsedGroup(
  sessions: ChatSession[],
  currentId: string,
) {
  const recent = sessions.slice(0, COLLAPSED_SESSION_COUNT);
  if (recent.some((session) => session.id === currentId)) return recent;
  const current = sessions.find((session) => session.id === currentId);
  if (!current) return recent;
  return [...recent.slice(0, COLLAPSED_SESSION_COUNT - 1), current];
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

function latestConversationAtByProject(sessions: ChatSession[]) {
  const latest = new Map<string, number>();
  for (const session of sessions) {
    if (session.remoteAgent) continue;
    latest.set(
      session.projectId,
      Math.max(latest.get(session.projectId) ?? 0, session.updatedAt),
    );
  }
  return latest;
}

type MenuAnchor = {
  kind: "session" | "project";
  id: string;
  rect: Pick<DOMRect, "top" | "right" | "bottom" | "left">;
};

type MenuPosition = {
  top: number;
  left: number;
};

function FolderIcon({ open: _open }: { open?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 3.8a1 1 0 0 1 1-1h3.2l1.4 1.6H13a1 1 0 0 1 1 1v6.2a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" fill="currentColor" fillOpacity="0.18" />
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
  sessionsHydrated = true,
  onClose,
  onNew,
  onOpen,
  onRename,
  onTogglePinned,
  onDelete,
  onDeleteProject,
  onReorderProjects,
  remotePeers = [],
  remoteWorkspaces = {},
  remoteSessionLists = {},
  selectedWorkspaceNodeId = null,
  currentRemoteAgent = null,
  remoteBusy = false,
  onLoadRemoteTargets,
  onWorkspaceSelect,
  onRemoteProjectSelect,
  onNewRemote,
  onOpenRemote,
}: Props) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null);
  const [draggedProjectOffsetY, setDraggedProjectOffsetY] = useState(0);
  const [projectOrderPreview, setProjectOrderPreview] = useState<string[] | null>(null);
  const [openMenu, setOpenMenu] = useState<MenuAnchor | null>(null);
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const [unreadIds, setUnreadIds] = useState<Set<string>>(new Set());
  const [expandedSessionGroups, setExpandedSessionGroups] = useState<Set<string>>(new Set());
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [selectedRemoteProjectId, setSelectedRemoteProjectId] = useState<string | null>(null);
  const language = useStore((s) => s.language);
  const setTab = useStore((s) => s.setTab);
  const copy = CHAT_COPY[language];
  const sessionListRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const workspaceMenuRef = useRef<HTMLDivElement | null>(null);
  const groupRefs = useRef(new Map<string, HTMLElement>());
  const selectedWorkspaceRef = useRef<string | null>(null);
  const requestedRemoteHistoryRef = useRef<string | null>(null);
  const projectOrderPreviewRef = useRef<string[] | null>(null);
  const projectActivityRef = useRef<Map<string, number> | null>(null);
  const projectDragRef = useRef<{
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    currentY: number;
    grabOffsetY: number;
    moved: boolean;
  } | null>(null);
  const openMenuId = openMenu?.id ?? null;
  const pinnedSessions = useMemo(
    () => sessions
      .filter((session) => session.pinned && !session.remoteAgent)
      .sort((left, right) => right.updatedAt - left.updatedAt),
    [sessions],
  );
  const groups = useMemo(
    () => groupSessionsByProject(
      sessions.filter((session) => !session.pinned && !session.remoteAgent),
      projects,
    ),
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
  const remoteMode = selectedWorkspaceNodeId !== null;
  const selectedRemotePeer = remoteMode
    ? remotePeers.find((peer) => peer.nodeId === selectedWorkspaceNodeId) ?? null
    : null;
  const selectedRemoteWorkspace = remoteMode
    ? remoteWorkspaces[selectedWorkspaceNodeId] ?? null
    : null;
  const selectedRemoteProject = selectedRemoteWorkspace?.projects.find(
    (project) => project.projectId === selectedRemoteProjectId,
  ) ?? null;
  const selectedRemoteHistory = remoteMode && selectedRemoteProjectId
    ? Object.values(remoteSessionLists).find((history) => (
        history.nodeId === selectedWorkspaceNodeId
        && history.projectId === selectedRemoteProjectId
      )) ?? null
    : null;

  useEffect(() => {
    if (!sessionsHydrated) {
      projectActivityRef.current = null;
      return;
    }
    const nextActivity = latestConversationAtByProject(sessions);
    const previousActivity = projectActivityRef.current;
    projectActivityRef.current = nextActivity;
    if (!previousActivity) return;

    const activatedProjectIds = projects
      .filter((project) => (
        (nextActivity.get(project.id) ?? 0) > (previousActivity.get(project.id) ?? 0)
      ))
      .sort((left, right) => (
        (nextActivity.get(right.id) ?? 0) - (nextActivity.get(left.id) ?? 0)
      ))
      .map((project) => project.id);
    if (activatedProjectIds.length === 0) return;

    const activated = new Set(activatedProjectIds);
    const nextOrder = [
      ...activatedProjectIds,
      ...projects.map((project) => project.id).filter((id) => !activated.has(id)),
    ];
    if (sameProjectOrder(nextOrder, projects.map((project) => project.id))) return;
    void onReorderProjects(nextOrder).catch(() => undefined);
  }, [onReorderProjects, projects, sessions, sessionsHydrated]);

  useEffect(() => {
    if (!workspaceMenuOpen) return;
    const close = (event: MouseEvent) => {
      if (!workspaceMenuRef.current?.contains(event.target as Node)) {
        setWorkspaceMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setWorkspaceMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [workspaceMenuOpen]);

  useEffect(() => {
    if (!selectedWorkspaceNodeId || !selectedRemoteWorkspace) {
      selectedWorkspaceRef.current = selectedWorkspaceNodeId;
      setSelectedRemoteProjectId(null);
      return;
    }
    const workspaceChanged = selectedWorkspaceRef.current !== selectedWorkspaceNodeId;
    selectedWorkspaceRef.current = selectedWorkspaceNodeId;
    const boundProjectId = currentRemoteAgent?.nodeId === selectedWorkspaceNodeId
      ? currentRemoteAgent.projectId
      : null;
    const preferredProjectId = boundProjectId
      ?? selectedRemoteWorkspace.projects.find((project) => project.isActive)?.projectId
      ?? selectedRemoteWorkspace.projects[0]?.projectId
      ?? null;
    setSelectedRemoteProjectId((current) => {
      if (workspaceChanged) return preferredProjectId;
      if (current && selectedRemoteWorkspace.projects.some((project) => project.projectId === current)) {
        return current;
      }
      return preferredProjectId;
    });
  }, [currentRemoteAgent, selectedRemoteWorkspace, selectedWorkspaceNodeId]);

  useEffect(() => {
    if (
      !selectedWorkspaceNodeId
      || !selectedRemoteProjectId
      || selectedRemoteHistory
      || !onRemoteProjectSelect
    ) return;
    const key = `${selectedWorkspaceNodeId}\u0000${selectedRemoteProjectId}`;
    if (requestedRemoteHistoryRef.current === key) return;
    requestedRemoteHistoryRef.current = key;
    void Promise.resolve(
      onRemoteProjectSelect(selectedWorkspaceNodeId, selectedRemoteProjectId),
    ).catch(() => {
      if (requestedRemoteHistoryRef.current === key) requestedRemoteHistoryRef.current = null;
    });
  }, [
    onRemoteProjectSelect,
    selectedRemoteHistory,
    selectedRemoteProjectId,
    selectedWorkspaceNodeId,
  ]);

  const closeMenu = useCallback(() => {
    setOpenMenu(null);
    setMenuPosition(null);
  }, []);

  const beginRename = useCallback((session: ChatSession) => {
    setRenamingId(session.id);
    setRenameValue(session.title);
  }, []);

  const finishRename = useCallback(() => {
    if (renamingId) onRename(renamingId, renameValue);
    setRenamingId(null);
  }, [onRename, renameValue, renamingId]);

  const toggleUnread = useCallback((id: string) => {
    setUnreadIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleOpen = useCallback((id: string) => {
    setUnreadIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    void onOpen(id);
    onClose();
  }, [onClose, onOpen]);

  useEffect(() => {
    if (!openMenu) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".chat-session-menu") && !target.closest(".chat-session-menu-btn")) {
        closeMenu();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [closeMenu, openMenu]);

  useEffect(() => {
    if (!openMenu) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenu();
        return;
      }
      if ((event.target as HTMLElement)?.tagName === "INPUT") return;
      if (openMenu.kind === "session") {
        const session = sessions.find((s) => s.id === openMenu.id);
        if (!session) return;
        const key = event.key.toLowerCase();
        if (key === "p") {
          event.preventDefault();
          onTogglePinned(session.id);
          closeMenu();
        } else if (key === "u") {
          event.preventDefault();
          toggleUnread(session.id);
          closeMenu();
        } else if (key === "r") {
          event.preventDefault();
          beginRename(session);
          closeMenu();
        } else if (key === "d") {
          event.preventDefault();
          onDelete(session.id);
          closeMenu();
        }
      }
    };
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    document.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
      document.removeEventListener("keydown", handleKey);
    };
  }, [beginRename, closeMenu, onDelete, onTogglePinned, openMenu, sessions]);

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
    const isPoint = Math.abs(openMenu.rect.left - openMenu.rect.right) < 1;
    const left = isPoint
      ? Math.min(Math.max(margin, openMenu.rect.left), maxLeft)
      : Math.min(Math.max(margin, openMenu.rect.right - menuRect.width), maxLeft);
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

  const handleSessionContextMenu = (
    event: ReactMouseEvent<HTMLElement>,
    id: string,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setMenuPosition(null);
    setOpenMenu({
      kind: "session",
      id,
      rect: {
        top: event.clientY,
        right: event.clientX,
        bottom: event.clientY,
        left: event.clientX,
      },
    });
  };

  const handleProjectContextMenu = (
    event: ReactMouseEvent<HTMLElement>,
    id: string,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setMenuPosition(null);
    setOpenMenu({
      kind: "project",
      id,
      rect: {
        top: event.clientY,
        right: event.clientX,
        bottom: event.clientY,
        left: event.clientX,
      },
    });
  };

  const toggleSessionMenu = (
    event: ReactMouseEvent<HTMLButtonElement>,
    id: string,
  ) => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setMenuPosition(null);
    setOpenMenu((current) => (
      current?.id === id && current.kind === "session"
        ? null
        : {
          kind: "session",
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

  const toggleSessionGroup = (groupId: string) => {
    setExpandedSessionGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const renderSessionGroupToggle = (
    groupId: string,
    totalCount: number,
    visibleCount: number,
    expanded: boolean,
  ) => {
    if (totalCount <= COLLAPSED_SESSION_COUNT) return null;
    const hiddenCount = Math.max(0, totalCount - visibleCount);
    return (
      <button
        className="chat-session-collapsed-summary"
        type="button"
        aria-expanded={expanded}
        onClick={() => toggleSessionGroup(groupId)}
      >
        {expanded
          ? copy.showFewerChats
          : `${copy.showMoreChats} (${hiddenCount})`}
      </button>
    );
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
      onContextMenu={(event) => handleSessionContextMenu(event, session.id)}
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
        aria-expanded={openMenuId === session.id && openMenu?.kind === "session"}
      >
        ···
      </button>
    </div>
  );

  const renderRemoteSessionItem = (session: RemoteAgentSessions["sessions"][number]) => {
    const active = currentRemoteAgent?.nodeId === session.nodeId
      && currentRemoteAgent.projectId === session.projectId
      && currentRemoteAgent.sessionId === session.sessionId;
    return (
      <button
        key={session.sessionId}
        type="button"
        className={`chat-session-item chat-remote-session-item${active ? " active" : ""}`}
        onClick={() => {
          if (!onOpenRemote) return;
          void onOpenRemote(session.nodeId, session.projectId, session.sessionId);
        }}
      >
        <span className="chat-session-title">{session.title || (language === "cn" ? "未命名对话" : "Untitled chat")}</span>
        {session.model && <small className="chat-remote-session-meta">{session.model}</small>}
      </button>
    );
  };

  return (
    <aside
      id="chat-session-sidebar"
      className={`chat-sidebar${open ? " open" : ""}`}
    >
      <div className="chat-sidebar-container">
        <div className="chat-sidebar-top-group">
          <div className="chat-workspace-picker" ref={workspaceMenuRef}>
            <button
              className={`chat-workspace-trigger${remoteMode ? " is-remote" : ""}`}
              type="button"
              aria-haspopup="menu"
              aria-expanded={workspaceMenuOpen}
              aria-label={language === "cn" ? "切换本机或远程电脑" : "Switch local or remote computer"}
              onClick={() => {
                const opening = !workspaceMenuOpen;
                setWorkspaceMenuOpen(opening);
                if (opening) onLoadRemoteTargets?.();
              }}
            >
              <span className="chat-workspace-icon" aria-hidden="true">
                <SvgIcon name={remoteMode ? "collection" : "desktop"} size={14} />
              </span>
              <span className="chat-workspace-trigger-copy">
                <strong>
                  {remoteMode
                    ? (selectedRemotePeer?.displayName
                      ?? selectedRemoteWorkspace?.nodeName
                      ?? (language === "cn" ? "远程电脑" : "Remote computer"))
                    : (language === "cn" ? "本机" : "This computer")}
                </strong>
                <small>
                  {remoteMode
                    ? (selectedRemoteProject?.title
                      ?? (remoteBusy
                        ? (language === "cn" ? "正在读取远程项目…" : "Loading remote projects…")
                        : (language === "cn" ? "选择远程项目" : "Choose a remote project")))
                    : (currentRemoteAgent
                      ? (language === "cn" ? "本机项目" : "Local projects")
                      : (projects.find((project) => project.id === sessions.find(
                          (session) => session.id === currentId && !session.remoteAgent,
                        )?.projectId)?.name
                        ?? (language === "cn" ? "本机项目" : "Local projects")))}
                </small>
              </span>
              <span className="chat-workspace-trailing">
                {remoteMode && (
                  <span
                    className={`chat-workspace-connection${selectedRemotePeer?.connected ? " is-online" : " is-connecting"}`}
                    title={selectedRemotePeer?.connected
                      ? (language === "cn" ? "在线" : "Online")
                      : (language === "cn" ? "正在自动连接" : "Reconnecting automatically")}
                  />
                )}
                <SvgIcon name={workspaceMenuOpen ? "chevronUp" : "chevronDown"} size={12} />
              </span>
            </button>
            {workspaceMenuOpen && (
              <div className="chat-workspace-menu" role="menu">
                <div className="chat-workspace-menu-label">
                  {language === "cn" ? "运行位置" : "Run on"}
                </div>
                <button
                  className={`chat-workspace-option${!remoteMode ? " active" : ""}`}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onWorkspaceSelect?.(null);
                    setWorkspaceMenuOpen(false);
                  }}
                >
                  <span className="chat-workspace-option-icon"><SvgIcon name="desktop" size={14} /></span>
                  <span><strong>{language === "cn" ? "本机" : "This computer"}</strong><small>{language === "cn" ? "本机项目、模型与工具" : "Local projects, models, and tools"}</small></span>
                  {!remoteMode && <SvgIcon name="check" size={13} />}
                </button>
                {remotePeers.map((peer) => {
                  const unavailable = !peer.agentChatAuthorized;
                  return (
                    <button
                      key={peer.nodeId}
                      className={`chat-workspace-option${selectedWorkspaceNodeId === peer.nodeId ? " active" : ""}${!peer.connected ? " is-connecting" : ""}`}
                      type="button"
                      role="menuitem"
                      disabled={unavailable}
                      onClick={() => {
                        onWorkspaceSelect?.(peer.nodeId);
                        setWorkspaceMenuOpen(false);
                      }}
                    >
                      <span className="chat-workspace-option-icon"><SvgIcon name="collection" size={14} /></span>
                      <span>
                        <strong>{peer.displayName}</strong>
                        <small>
                          {!peer.agentChatAuthorized
                            ? (language === "cn" ? "需重新配对以启用 Agent" : "Re-pair to enable Agent")
                            : peer.connected
                              ? (language === "cn" ? "在线 · 远程项目" : "Online · Remote projects")
                              : (language === "cn" ? "正在自动连接，可先进入等待" : "Reconnecting automatically · Open to wait")}
                        </small>
                      </span>
                      {selectedWorkspaceNodeId === peer.nodeId && <SvgIcon name="check" size={13} />}
                    </button>
                  );
                })}
                {remotePeers.length === 0 && (
                  <div className="chat-workspace-empty">
                    {remoteBusy
                      ? (language === "cn" ? "正在查找已配对电脑…" : "Looking for paired computers…")
                      : (language === "cn" ? "没有可用的远程电脑" : "No remote computers available")}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="chat-sidebar-head">
            <div className="chat-sidebar-top-row">
              <button
                className="chat-new-btn"
                onClick={() => {
                  if (remoteMode && selectedWorkspaceNodeId && selectedRemoteProjectId && onNewRemote) {
                    void onNewRemote(selectedWorkspaceNodeId, selectedRemoteProjectId);
                  } else if (!remoteMode) {
                    void onNew();
                  }
                }}
                disabled={busy || remoteBusy || (remoteMode && !selectedRemoteProjectId)}
              >
                <span className="chat-new-icon"><SvgIcon name="plus" size={14} /></span>
                <span>{copy.newChat}</span>
              </button>
              <button className="chat-sidebar-close" onClick={onClose} aria-label={copy.closeSidebar}><SvgIcon name="close" size={15} /></button>
            </div>
            {!remoteMode && (
              <button
                className="chat-scheduled-btn"
                onClick={() => setTab("scheduled")}
              >
                <span className="chat-scheduled-icon"><SvgIcon name="lightning" size={14} /></span>
                <span>{copy.scheduledTasks}</span>
              </button>
            )}
          </div>
        </div>
        <div className="chat-session-list" ref={sessionListRef}>
          {remoteMode ? (
            <>
              <div className="chat-sidebar-label chat-projects-label">
                {language === "cn" ? "远程项目" : "Remote projects"}
              </div>
              {!selectedRemoteWorkspace && (
                <div className="chat-session-empty">
                  {selectedRemotePeer && !selectedRemotePeer.connected
                    ? (language === "cn" ? "这台电脑当前离线。" : "This computer is offline.")
                    : remoteBusy
                      ? (language === "cn" ? "正在读取远程项目…" : "Loading remote projects…")
                      : (language === "cn" ? "远程项目暂不可用。" : "Remote projects are unavailable.")}
                </div>
              )}
              {selectedRemoteWorkspace?.projects.map((project) => {
                const selected = selectedRemoteProjectId === project.projectId;
                const history = Object.values(remoteSessionLists).find((item) => (
                  item.nodeId === selectedWorkspaceNodeId && item.projectId === project.projectId
                ));
                const currentProjectBound = currentRemoteAgent?.nodeId === selectedWorkspaceNodeId
                  && currentRemoteAgent.projectId === project.projectId;
                return (
                  <section
                    className={`chat-session-group chat-remote-project-group${selected ? " selected" : ""}`}
                    key={project.projectId}
                  >
                    <div className="chat-sidebar-label chat-project-label">
                      <button
                        className="chat-project-toggle"
                        type="button"
                        aria-expanded={selected}
                        onClick={() => {
                          setSelectedRemoteProjectId(project.projectId);
                          requestedRemoteHistoryRef.current = `${selectedWorkspaceNodeId}\u0000${project.projectId}`;
                          if (selectedWorkspaceNodeId && onRemoteProjectSelect) {
                            void onRemoteProjectSelect(selectedWorkspaceNodeId, project.projectId);
                          }
                        }}
                      >
                        <span className="chat-project-caret" aria-hidden="true">
                          <FolderIcon open={selected} />
                        </span>
                        <span className="chat-project-label-text">{project.title}</span>
                        {currentProjectBound && <span className="chat-remote-project-current">{language === "cn" ? "当前" : "Current"}</span>}
                      </button>
                      <button
                        className="chat-project-add"
                        type="button"
                        aria-label={copy.newChatInProject(project.title)}
                        title={copy.newChatInThisProject}
                        disabled={remoteBusy}
                        onClick={() => {
                          if (!selectedWorkspaceNodeId || !onNewRemote) return;
                          setSelectedRemoteProjectId(project.projectId);
                          void onNewRemote(selectedWorkspaceNodeId, project.projectId);
                        }}
                      >
                        <SvgIcon name="plus" size={11} />
                      </button>
                    </div>
                    {selected && (
                      <div className="chat-remote-project-sessions">
                        {!history && (
                          <div className="chat-session-empty chat-remote-loading">
                            <SvgIcon name="spinner" size={13} />
                            {language === "cn" ? "正在读取远程会话…" : "Loading remote conversations…"}
                          </div>
                        )}
                        {history?.sessions.map(renderRemoteSessionItem)}
                        {history && history.sessions.length === 0 && (
                          <div className="chat-session-empty">
                            {language === "cn" ? "这个项目还没有对话。" : "No conversations in this project yet."}
                          </div>
                        )}
                        {history?.hasMore && (
                          <div className="chat-session-empty">
                            {language === "cn" ? "显示最近 50 个会话" : "Showing the latest 50 conversations"}
                          </div>
                        )}
                      </div>
                    )}
                  </section>
                );
              })}
            </>
          ) : (
            <>
              {pinnedSessions.length > 0 && (() => {
                const expanded = expandedSessionGroups.has(PINNED_SESSION_GROUP_ID);
                const visibleSessions = expanded
                  ? pinnedSessions
                  : sessionsForCollapsedGroup(pinnedSessions, currentId);
                return (
                  <section className="chat-session-group chat-pinned-group">
                    <div className="chat-sidebar-label">{copy.pinnedSection}</div>
                    {visibleSessions.map((session) => renderSessionItem(session))}
                    {renderSessionGroupToggle(
                      PINNED_SESSION_GROUP_ID,
                      pinnedSessions.length,
                      visibleSessions.length,
                      expanded,
                    )}
                  </section>
                );
              })()}
              <div className="chat-sidebar-label chat-projects-label">
                {language === "cn" ? "本机项目" : "Local projects"}
              </div>
              {groups.length === 0 && <div className="chat-session-empty">{copy.noMatchingChats}</div>}
              {orderedGroups.map((group) => {
                const expanded = expandedSessionGroups.has(group.id);
                const visibleSessions = expanded
                  ? group.sessions
                  : sessionsForCollapsedGroup(group.sessions, currentId);
                const dragStyle: CSSProperties | undefined = draggedProjectId === group.id
                  ? { transform: `translateY(${draggedProjectOffsetY}px)` }
                  : undefined;
                const activeSession = sessions.find((s) => s.id === currentId && !s.remoteAgent);
                const isActiveProject = activeSession?.projectId === group.id
                  || group.sessions.some((s) => s.id === currentId);
                return (
                  <section
                    className={`chat-session-group${isActiveProject ? " is-active-project" : ""}${draggedProjectId === group.id ? " dragging" : ""}`}
                    key={group.id}
                    data-chat-project-id={group.id}
                    ref={setGroupRef(group.id)}
                    style={dragStyle}
                  >
                    <div
                      className={`chat-sidebar-label chat-project-label${canReorderProjects ? " can-reorder" : ""}`}
                      data-chat-project-label-id={group.id}
                      onPointerDown={(event) => startProjectDrag(event, group.id)}
                      onContextMenu={(event) => handleProjectContextMenu(event, group.id)}
                    >
                      <div
                        className="chat-project-toggle"
                        role="heading"
                        aria-level={2}
                        aria-label={`${group.label}, ${copy.chatsCount(group.sessions.length)}`}
                      >
                        <span className="chat-project-caret" aria-hidden="true">
                          <FolderIcon open />
                        </span>
                        <span className="chat-project-label-text">{group.label}</span>
                        {isActiveProject && (
                          <span className="chat-active-project-pill">
                            {language === "cn" ? "当前" : "Active"}
                          </span>
                        )}
                      </div>
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
                        <SvgIcon name="plus" size={11} />
                      </button>
                    </div>
                    {visibleSessions.map((session) => renderSessionItem(session))}
                    {renderSessionGroupToggle(
                      group.id,
                      group.sessions.length,
                      visibleSessions.length,
                      expanded,
                    )}
                  </section>
                );
              })}
            </>
          )}
        </div>
      </div>
      {openMenu && createPortal(
        <div
          ref={menuRef}
          className="chat-session-menu"
          role="menu"
          style={menuStyle}
          onClick={(event) => event.stopPropagation()}
        >
          {openMenu.kind === "session" && (() => {
            const session = sessions.find((s) => s.id === openMenu.id);
            if (!session) return null;
            return (
              <>
                <button
                  role="menuitem"
                  className={session.pinned ? "active" : ""}
                  onClick={(event) => {
                    event.stopPropagation();
                    onTogglePinned(session.id);
                    closeMenu();
                  }}
                >
                  {session.pinned
                    ? (language === "cn" ? "取消置顶" : "Unpin")
                    : (language === "cn" ? "置顶" : "Pin")}
                  <span className="chat-session-menu-key">P</span>
                </button>
                <button
                  role="menuitem"
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleUnread(session.id);
                    closeMenu();
                  }}
                >
                  {unreadIds.has(session.id)
                    ? (language === "cn" ? "标为已读" : "Mark as read")
                    : (language === "cn" ? "标为未读" : "Mark as unread")}
                  <span className="chat-session-menu-key">U</span>
                </button>
                <button
                  role="menuitem"
                  onClick={(event) => {
                    event.stopPropagation();
                    beginRename(session);
                    closeMenu();
                  }}
                >
                  {language === "cn" ? "重命名" : "Rename"}
                  <span className="chat-session-menu-key">R</span>
                </button>
                <div className="chat-session-menu-divider" role="separator" />
                <button
                  role="menuitem"
                  className="danger"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDelete(session.id);
                    closeMenu();
                  }}
                >
                  {language === "cn" ? "删除" : "Delete"}
                  <span className="chat-session-menu-key">D</span>
                </button>
              </>
            );
          })()}
          {openMenu.kind === "project" && (() => {
            const project = projects.find((p) => p.id === openMenu.id);
            const isRemovable = openMenu.id !== "default" && Boolean(onDeleteProject);
            return (
              <>
                <button
                  role="menuitem"
                  onClick={(event) => {
                    event.stopPropagation();
                    void onNew(openMenu.id);
                    closeMenu();
                  }}
                >
                  {language === "cn" ? "新建对话" : "New chat"}
                </button>
                {project?.path && (
                  <button
                    role="menuitem"
                    onClick={(event) => {
                      event.stopPropagation();
                      void fileReveal(project.path);
                      closeMenu();
                    }}
                  >
                    {language === "cn" ? "在资源管理器中显示" : "Reveal in Explorer"}
                  </button>
                )}
                {isRemovable && (
                  <>
                    <div className="chat-session-menu-divider" role="separator" />
                    <button
                      role="menuitem"
                      className="danger"
                      onClick={(event) => {
                        event.stopPropagation();
                        void onDeleteProject?.(openMenu.id);
                        closeMenu();
                      }}
                    >
                      {language === "cn" ? "从列表中移除项目" : "Remove project"}
                    </button>
                  </>
                )}
              </>
            );
          })()}
        </div>,
        document.body,
      )}
    </aside>
  );
}
