import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { appRelaunch, appUpdateCheck, appUpdateDownloadAndInstall, isTauri } from "./api/tauri";
import { useStore, type Tab } from "./store";
import type { AppUpdateInfo, AppUpdateProgress } from "./types";
import Chat from "./chat/Chat";
import Lab from "./lab/Lab";
import Literature, { LiteratureViewTabs, type LiteraturePageView } from "./literature/Literature";
import Studio from "./studio/Studio";
import Mail from "./mail/Mail";
import Extensions from "./extensions/Extensions";
import Settings from "./settings/Settings";
import Sessions from "./sessions/Sessions";
import ScheduledTasks from "./scheduled/ScheduledTasks";
import OnboardingTutorial from "./OnboardingTutorial";

interface NavItem {
  id: string;
  label: string;
  icon: ReactNode;
}

type UpdateIndicatorState = "idle" | "available" | "downloading" | "ready";

const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

const WINDOW_MENUS = ["文件", "编辑", "视图", "帮助"];

const IC = (p: { d: string; extra?: string }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
    stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true">
    <path d={p.d} />
    {p.extra && <path d={p.extra} />}
  </svg>
);

// Chevron / control glyphs rendered as crisp SVG so they align on the pixel grid
// instead of relying on font-dependent glyphs like "‹", "×" or "v".
const Chevron = (p: { dir: "left" | "right" | "down"; size?: number }) => {
  const s = p.size ?? 16;
  const d = p.dir === "left" ? "M10 3.5 5.5 8l4.5 4.5"
    : p.dir === "right" ? "M6 3.5 10.5 8 6 12.5"
      : "M3.5 6 8 10.5 12.5 6";
  return (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
};

// Windows-style window controls, 10×10 viewBox centered in a 46×36 hit area.
const WinCtl = {
  minimize: (
    <svg className="win-ctl-glyph" width="10" height="10" viewBox="0 0 10 10"
      fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true">
      <path d="M1.5 5h7" />
    </svg>
  ),
  maximize: (
    <svg className="win-ctl-glyph" width="10" height="10" viewBox="0 0 10 10"
      fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true">
      <rect x="1.5" y="1.5" width="7" height="7" rx="0.75" />
    </svg>
  ),
  close: (
    <svg className="win-ctl-glyph" width="10" height="10" viewBox="0 0 10 10"
      fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" aria-hidden="true">
      <path d="M1.6 1.6 8.4 8.4M8.4 1.6 1.6 8.4" />
    </svg>
  ),
};

// Sidebar panel-toggle icon (rounded frame with a left rail), and a six-dot grip.
const PanelIcon = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor"
    strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2.25" y="3" width="11.5" height="10" rx="2" />
    <path d="M6.25 3v10" />
  </svg>
);

const GripIcon = () => (
  <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden="true">
    <circle cx="3" cy="3" r="1.1" /><circle cx="7" cy="3" r="1.1" />
    <circle cx="3" cy="7" r="1.1" /><circle cx="7" cy="7" r="1.1" />
    <circle cx="3" cy="11" r="1.1" /><circle cx="7" cy="11" r="1.1" />
  </svg>
);

const PlusIcon = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor"
    strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
    <path d="M8 3.5v9M3.5 8h9" />
  </svg>
);

const NAV_GROUPS: { group: string; items: NavItem[] }[] = [
  {
    group: "Build",
    items: [{
      id: "chat", label: "Chat",
      icon: <IC d="M2 3a1 1 0 011-1h10a1 1 0 011 1v6.5a1 1 0 01-1 1H9.5L8 12l-1.5-1.5H3a1 1 0 01-1-1V3z" />,
    }, {
      id: "lab", label: "Lab",
      icon: <IC d="M3.5 2.5h9v11h-9zM5.5 6l2.2 1.6-2.2 1.6M9 9.7h2.5" />,
    }],
  },
  {
    group: "Library",
    items: [
      {
        id: "literature", label: "Literature",
        icon: <IC
          d="M8 13.5V4C7 2.5 4.5 2.5 2 3.5V13c2.5-1 5-1 6 .5z"
          extra="M8 13.5V4c1-1.5 3.5-1.5 6-.5V13c-2.5-1-5-1-6 .5z"
        />,
      },
      {
        id: "studio", label: "Studio",
        icon: <IC d="M2.5 3.5h11v7h-11zM5 13h6M8 10.5V13" />,
      },
      {
        id: "mail", label: "Mail",
        icon: <IC d="M2 4.5h12v7H2zM2.5 5l5.5 4 5.5-4" />,
      },
      {
        id: "sessions", label: "Sessions",
        icon: <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round"
          aria-hidden="true">
          <circle cx="8" cy="8" r="5.5" />
          <path d="M8 5.5V8l2 1.5" />
        </svg>,
      },
    ],
  },
  {
    group: "System",
    items: [
      {
        id: "extensions", label: "Extensions",
        icon: <IC d="M6 2.5H3.5a1 1 0 00-1 1V6M10 2.5h2.5a1 1 0 011 1V6M6 13.5H3.5a1 1 0 01-1-1V10M10 13.5h2.5a1 1 0 001-1V10M6.2 6.2h3.6v3.6H6.2z" />,
      },
      {
        id: "settings", label: "Settings",
        icon: <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round"
          aria-hidden="true">
          <circle cx="8" cy="8" r="2.3" />
          <path d="M8 1.5V3M8 13v1.5M14.5 8H13M3 8H1.5M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7l-1.1-1.1" />
        </svg>,
      },
    ],
  },
];

const LABELS: Record<Tab, string> = Object.fromEntries(
  NAV_GROUPS.flatMap((g) => g.items).map((i) => [i.id, i.label]),
) as Record<Tab, string>;

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

function windowAction(action: "minimize" | "maximize" | "close") {
  if (!isTauri()) return;
  const currentWindow = getCurrentWindow();
  if (action === "minimize") void currentWindow.minimize();
  else if (action === "maximize") void currentWindow.toggleMaximize();
  else void currentWindow.close();
}

export default function App() {
  const tab = useStore((s) => s.tab);
  const setTab = useStore((s) => s.setTab);
  const stateDir = useStore((s) => s.stateDir);
  const error = useStore((s) => s.error);
  const setError = useStore((s) => s.setError);
  const init = useStore((s) => s.init);
  const projects = useStore((s) => s.projects);
  const currentProject = useStore((s) => s.currentProject);
  const projectBusy = useStore((s) => s.projectBusy);
  const addProject = useStore((s) => s.addProject);
  const switchProject = useStore((s) => s.switchProject);
  const reorderProjects = useStore((s) => s.reorderProjects);
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem("aris-sidebar-w"));
    return v >= 140 && v <= 400 ? v : 192;
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(
    () => localStorage.getItem("aris-sidebar-collapsed") === "true",
  );
  const sidebarResizeDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null);
  const [projectOrderPreview, setProjectOrderPreview] = useState<string[] | null>(null);
  const [updateState, setUpdateState] = useState<UpdateIndicatorState>("idle");
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [updateProgress, setUpdateProgress] = useState<AppUpdateProgress | null>(null);
  const [literaturePageView, setLiteraturePageView] = useState<LiteraturePageView>("library");
  const projectSwitcherRef = useRef<HTMLDivElement | null>(null);
  const projectOrderPreviewRef = useRef<string[] | null>(null);
  const suppressProjectClickRef = useRef(false);
  const updateCheckInFlightRef = useRef(false);
  const updateStateRef = useRef<UpdateIndicatorState>("idle");
  const projectDragRef = useRef<{
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);

  const chooseProject = async () => {
    setProjectMenuOpen(false);
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Add SomniQ project",
    });
    if (typeof selected === "string") {
      try {
        await addProject(selected);
      } catch {
        // The store surfaces project errors in the global toast.
      }
    }
  };

  const selectProject = (id: string) => {
    setProjectMenuOpen(false);
    void switchProject(id).catch(() => undefined);
  };

  const startProjectDrag = (
    event: ReactPointerEvent<HTMLElement>,
    id: string,
  ) => {
    if (projectBusy || projects.length <= 1 || event.button !== 0) return;
    projectDragRef.current = {
      id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveProjectDrag = (
    event: ReactPointerEvent<HTMLElement>,
  ) => {
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
    const hovered = document.elementFromPoint(event.clientX, event.clientY);
    const target = hovered instanceof Element
      ? hovered.closest<HTMLElement>("[data-project-id]")
      : null;
    const targetId = target?.dataset.projectId;
    if (!targetId || targetId === drag.id) return;
    const rect = target.getBoundingClientRect();
    const placeAfter = event.clientY > rect.top + rect.height / 2;
    const currentIds = projectOrderPreviewRef.current ?? projects.map((project) => project.id);
    const ids = moveProjectId(
      currentIds,
      drag.id,
      targetId,
      placeAfter,
    );
    if (sameProjectOrder(ids, currentIds)) return;
    projectOrderPreviewRef.current = ids;
    setProjectOrderPreview(ids);
  };

  const finishProjectDrag = (
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    const drag = projectDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.moved) {
      event.preventDefault();
      event.stopPropagation();
      suppressProjectClickRef.current = true;
      window.setTimeout(() => {
        suppressProjectClickRef.current = false;
      }, 0);
    }
    const ids = projectOrderPreviewRef.current;
    projectDragRef.current = null;
    projectOrderPreviewRef.current = null;
    setDraggedProjectId(null);
    setProjectOrderPreview(null);
    if (ids && drag.moved && !sameProjectOrder(ids, projects.map((project) => project.id))) {
      void reorderProjects(ids).catch(() => undefined);
    }
  };

  const cancelProjectDrag = (
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    const drag = projectDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    projectDragRef.current = null;
    projectOrderPreviewRef.current = null;
    setDraggedProjectId(null);
    setProjectOrderPreview(null);
  };

  const onSidebarResizeStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    sidebarResizeDragRef.current = { startX: e.clientX, startWidth: sidebarWidth };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onSidebarResizeMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!sidebarResizeDragRef.current) return;
    const w = Math.max(140, Math.min(400, sidebarResizeDragRef.current.startWidth + (e.clientX - sidebarResizeDragRef.current.startX)));
    setSidebarWidth(w);
  };
  const onSidebarResizeEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!sidebarResizeDragRef.current) return;
    const w = Math.max(140, Math.min(400, sidebarResizeDragRef.current.startWidth + (e.clientX - sidebarResizeDragRef.current.startX)));
    sidebarResizeDragRef.current = null;
    setSidebarWidth(w);
    localStorage.setItem("aris-sidebar-w", String(w));
  };
  const toggleSidebar = () => {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    localStorage.setItem("aris-sidebar-collapsed", String(next));
  };

  useEffect(() => init(), [init]);
  useEffect(() => {
    updateStateRef.current = updateState;
  }, [updateState]);
  const checkForAppUpdate = useCallback(async () => {
    if (updateCheckInFlightRef.current) return;
    if (updateStateRef.current === "downloading" || updateStateRef.current === "ready") return;
    updateCheckInFlightRef.current = true;
    try {
      const result = await appUpdateCheck();
      if (result.available) {
        setUpdateInfo(result);
        setUpdateProgress(null);
        setUpdateState("available");
      } else {
        setUpdateInfo(result);
        setUpdateProgress(null);
        setUpdateState("idle");
      }
    } catch {
      if (updateStateRef.current !== "available") {
        setUpdateState("idle");
      }
    } finally {
      updateCheckInFlightRef.current = false;
    }
  }, []);
  useEffect(() => {
    void checkForAppUpdate();
    const timer = window.setInterval(() => {
      void checkForAppUpdate();
    }, UPDATE_CHECK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [checkForAppUpdate]);
  useEffect(() => {
    if (!mobileNavOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileNavOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileNavOpen]);
  useEffect(() => {
    if (!projectMenuOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setProjectMenuOpen(false);
    };
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        !projectSwitcherRef.current?.contains(target)
      ) {
        setProjectMenuOpen(false);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeOnPointerDown);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeOnPointerDown);
    };
  }, [projectMenuOpen]);
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const orderedProjects = (projectOrderPreview ?? projects.map((project) => project.id))
    .map((id) => projectById.get(id))
    .filter((project): project is NonNullable<typeof project> => Boolean(project));
  const labWorkbench = tab === "lab";
  const chatShell = tab === "chat";
  const showUpdateIndicator = updateState === "available" || updateState === "downloading" || updateState === "ready";
  const updateVersionLabel = updateInfo?.version ? ` v${updateInfo.version}` : "";
  const updateTitle = updateState === "ready"
    ? `Update${updateVersionLabel} installed. Restart SomniQ Studio.`
    : updateState === "downloading"
      ? updateProgress?.percent != null
        ? `Installing update${updateVersionLabel}: ${updateProgress.percent}%`
        : `Installing update${updateVersionLabel}`
      : `Update${updateVersionLabel} available. Click to install.`;
  const handleUpdateIndicatorClick = async () => {
    if (updateState === "ready") {
      try {
        await appRelaunch();
      } catch (err) {
        setError(`Failed to restart after update: ${String(err)}`);
      }
      return;
    }
    if (updateState !== "available") return;
    setUpdateState("downloading");
    setUpdateProgress(null);
    try {
      const result = await appUpdateDownloadAndInstall((progress) => {
        setUpdateProgress(progress);
      });
      if (result.installed) {
        setUpdateInfo((current) => ({
          available: true,
          currentVersion: current?.currentVersion,
          version: result.version ?? current?.version,
          date: current?.date,
          body: current?.body,
        }));
        setUpdateState("ready");
      } else {
        setUpdateState("idle");
        setUpdateInfo(null);
      }
    } catch (err) {
      setUpdateState("available");
      setError(`Failed to install update: ${String(err)}`);
    }
  };
  const renderUpdateIndicator = () => showUpdateIndicator ? (
    <button
      className={`app-update-indicator ${updateState}`}
      type="button"
      onClick={() => void handleUpdateIndicatorClick()}
      disabled={updateState === "downloading"}
      title={updateTitle}
      aria-label={updateTitle}
    >
      <span className="app-update-icon" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round">
          {updateState === "ready" ? (
            <path d="M3 8.2 6.4 11.5 13 4.5" />
          ) : (
            <path d="M8 2.5v7M4.7 6.4 8 9.7l3.3-3.3M3 13.2h10" />
          )}
        </svg>
      </span>
      <span className="app-update-badge" aria-hidden="true" />
    </button>
  ) : null;

  return (
    <div
      className={`app${sidebarCollapsed ? " sidebar-collapsed" : ""}${labWorkbench ? " app-lab-workbench" : ""}${chatShell ? " app-chat-shell" : ""}`}
      style={{ "--app-sidebar-w": sidebarCollapsed ? "0px" : `${sidebarWidth}px` } as CSSProperties}
    >
      <div className="window-titlebar">
        <div className="window-titlebar-left">
          <button
            className="window-titlebar-sidebar"
            type="button"
            onClick={toggleSidebar}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={sidebarCollapsed ? "Expand navigation sidebar" : "Collapse navigation sidebar"}
          >
            <PanelIcon />
          </button>
          <button className="window-nav-btn" type="button" disabled aria-label="Back">
            <Chevron dir="left" />
          </button>
          <button className="window-nav-btn" type="button" disabled aria-label="Forward">
            <Chevron dir="right" />
          </button>
          <nav className="window-menu" aria-label="Application menu">
            {WINDOW_MENUS.map((item) => (
              <button key={item} type="button">
                {item}
              </button>
            ))}
          </nav>
        </div>
        <div
          className="window-titlebar-drag"
          data-tauri-drag-region
          onDoubleClick={() => windowAction("maximize")}
        >
          <span data-tauri-drag-region>SomniQ Studio</span>
        </div>
        <div className="window-titlebar-controls">
          {renderUpdateIndicator()}
          <button type="button" aria-label="Minimize window" onClick={() => windowAction("minimize")}>
            {WinCtl.minimize}
          </button>
          <button type="button" aria-label="Maximize window" onClick={() => windowAction("maximize")}>
            {WinCtl.maximize}
          </button>
          <button type="button" className="close" aria-label="Close window" onClick={() => windowAction("close")}>
            {WinCtl.close}
          </button>
        </div>
      </div>
      <aside
        className={`sidebar${mobileNavOpen ? " mobile-open" : ""}${sidebarCollapsed ? " sidebar-collapsed" : ""}`}
        data-onboarding-target="sidebar"
      >
        {NAV_GROUPS.map((g) => (
          <div className="nav-group" key={g.group}>
            <div className="nav-group-label">{g.group}</div>
            {g.items.map((t) => (
              <button
                key={t.id}
                className={`nav-item${tab === t.id ? " active" : ""}`}
                data-onboarding-target={`nav-${t.id}`}
                onClick={() => {
                  setTab(t.id as Tab);
                  setMobileNavOpen(false);
                }}
              >
                <span className="nav-icon">{t.icon}</span>
                {t.label}
              </button>
            ))}
          </div>
        ))}
        <div
          className="sidebar-resize-handle"
          onPointerDown={onSidebarResizeStart}
          onPointerMove={onSidebarResizeMove}
          onPointerUp={onSidebarResizeEnd}
          onPointerCancel={onSidebarResizeEnd}
        />
      </aside>
      {mobileNavOpen && (
        <button
          className="app-nav-backdrop"
          onClick={() => setMobileNavOpen(false)}
          aria-label="Close navigation"
        />
      )}

      <header className="app-head">
        <div className="app-head-title">
          <button
            className="app-nav-toggle"
            data-onboarding-target="mobile-menu"
            onClick={() => setMobileNavOpen((open) => !open)}
            aria-label="Toggle navigation"
            aria-expanded={mobileNavOpen}
          >
            Menu
          </button>
          {sidebarCollapsed && (
            <button
              className="sidebar-expand-btn"
              onClick={toggleSidebar}
              title="Expand sidebar"
              aria-label="Expand navigation sidebar"
            >
              ›
            </button>
          )}
          <div className="app-title">{LABELS[tab]}</div>
          {tab === "literature" && (
            <LiteratureViewTabs
              pageView={literaturePageView}
              onPageViewChange={setLiteraturePageView}
              className="app-head-literature-tabs"
            />
          )}
        </div>
        <div className="app-head-actions">
          <div
            className="project-switcher"
            ref={projectSwitcherRef}
            data-onboarding-target="project-switcher"
          >
            <button
              className="project-switcher-trigger"
              type="button"
              aria-label="Current project"
              aria-haspopup="listbox"
              aria-expanded={projectMenuOpen}
              disabled={projectBusy || projects.length === 0}
              onClick={() => setProjectMenuOpen((open) => !open)}
              title={currentProject?.path}
            >
              <span className="project-switcher-current">
                {currentProject?.name ?? "No project"}
              </span>
              <span className="project-switcher-caret" aria-hidden="true">
                <Chevron dir="down" size={13} />
              </span>
            </button>
            {projectMenuOpen && (
              <div className="project-menu" role="listbox" aria-label="Projects">
                {orderedProjects.map((project) => (
                  <div
                    key={project.id}
                    className={`project-menu-item${currentProject?.id === project.id ? " active" : ""}${draggedProjectId === project.id ? " dragging" : ""}`}
                    role="option"
                    aria-selected={currentProject?.id === project.id}
                    aria-disabled={projectBusy}
                    tabIndex={projectBusy ? -1 : 0}
                    data-project-id={project.id}
                    title={project.path}
                    onClick={(event) => {
                      if (suppressProjectClickRef.current) {
                        event.preventDefault();
                        event.stopPropagation();
                        return;
                      }
                      if (!projectBusy) selectProject(project.id);
                    }}
                    onKeyDown={(event) => {
                      if (!projectBusy && (event.key === "Enter" || event.key === " ")) {
                        event.preventDefault();
                        selectProject(project.id);
                      }
                    }}
                    onPointerDown={(event) => startProjectDrag(event, project.id)}
                    onPointerMove={moveProjectDrag}
                    onPointerUp={finishProjectDrag}
                    onPointerCancel={cancelProjectDrag}
                  >
                    <span
                      className="project-drag-handle"
                      aria-hidden="true"
                      title="Drag to reorder"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                    >
                      <GripIcon />
                    </span>
                    <span className="project-menu-copy">
                      <span className="project-menu-name">{project.name}</span>
                      <span className="project-menu-path">{project.path}</span>
                    </span>
                    <span className="project-current-dot" aria-hidden="true" />
                  </div>
                ))}
              </div>
            )}
            <button
              className="project-add-btn"
              onClick={() => void chooseProject()}
              disabled={projectBusy}
              title="Add SomniQ project"
              aria-label="Add project"
            >
              <PlusIcon />
              <span>Add</span>
            </button>
          </div>
          <div className="dir" title={stateDir || "run-state directory"}>
            {currentProject?.path ?? stateDir}
          </div>
        </div>
      </header>

      <main className="app-main" data-onboarding-target="workspace">
        <div hidden={tab !== "chat"}>
          <Chat />
        </div>
        {tab === "lab" && <Lab />}
        {tab === "literature" && (
          <Literature pageView={literaturePageView} onPageViewChange={setLiteraturePageView} />
        )}
        {tab === "studio" && <Studio />}
        {tab === "mail" && <Mail />}
        {tab === "extensions" && <Extensions />}
        {tab === "sessions" && <Sessions />}
        {tab === "scheduled" && <ScheduledTasks />}
        {tab === "settings" && <Settings />}

        {error && (
          <div className="toast" role="alert" aria-live="assertive">
            {error}
            <button onClick={() => setError(null)}>dismiss</button>
          </div>
        )}
      </main>
      <OnboardingTutorial />
    </div>
  );
}
