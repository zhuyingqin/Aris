import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useStore, type Tab } from "./store";
import Chat from "./chat/Chat";
import Literature from "./literature/Literature";
import Settings from "./settings/Settings";
import Skills from "./skills/Skills";
import Sessions from "./sessions/Sessions";
import arisIcon from "./assets/aris-icon.svg";

interface NavItem {
  id: string;
  label: string;
  icon: string;
}
const NAV_GROUPS: { group: string; items: NavItem[] }[] = [
  {
    group: "Build",
    items: [{ id: "chat", label: "Chat", icon: "C" }],
  },
  {
    group: "Library",
    items: [
      { id: "literature", label: "Literature", icon: "P" },
      { id: "skills", label: "Skills", icon: "K" },
      { id: "sessions", label: "Sessions", icon: "S" },
    ],
  },
  {
    group: "System",
    items: [{ id: "settings", label: "Settings", icon: "*" }],
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
  const [theme, setTheme] = useState<"dark" | "light">(
    () => (localStorage.getItem("aris-theme") === "light" ? "light" : "dark"),
  );
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null);
  const [projectOrderPreview, setProjectOrderPreview] = useState<string[] | null>(null);
  const projectSwitcherRef = useRef<HTMLDivElement | null>(null);
  const projectOrderPreviewRef = useRef<string[] | null>(null);
  const suppressProjectClickRef = useRef(false);
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
      title: "Add ARIS project",
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

  useEffect(() => init(), [init]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("aris-theme", theme);
  }, [theme]);
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

  return (
    <div className="app">
      <aside className={`sidebar${mobileNavOpen ? " mobile-open" : ""}`}>
        <div className="brand">
          <img className="brand-mark" src={arisIcon} alt="" />
          <span className="brand-text">
            ARIS
            <small>Chat</small>
          </span>
        </div>
        {NAV_GROUPS.map((g) => (
          <div className="nav-group" key={g.group}>
            <div className="nav-group-label">{g.group}</div>
            {g.items.map((t) => (
              <button
                key={t.id}
                className={`nav-item${tab === t.id ? " active" : ""}`}
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
            onClick={() => setMobileNavOpen((open) => !open)}
            aria-label="Toggle navigation"
            aria-expanded={mobileNavOpen}
          >
            Menu
          </button>
          <div className="app-title">{LABELS[tab]}</div>
        </div>
        <div className="app-head-actions">
          <div className="project-switcher" ref={projectSwitcherRef}>
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
                v
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
                      ::
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
            <button onClick={() => void chooseProject()} disabled={projectBusy}>
              Add project
            </button>
          </div>
          <div className="dir" title={stateDir || "run-state directory"}>
            {currentProject?.path ?? stateDir}
          </div>
          <button
            className="theme-toggle"
            onClick={() => setTheme((value) => value === "dark" ? "light" : "dark")}
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          >
            {theme === "dark" ? "Light" : "Dark"}
          </button>
        </div>
      </header>

      <main className="app-main">
        <div hidden={tab !== "chat"}>
          <Chat />
        </div>
        {tab === "literature" && <Literature />}
        {tab === "skills" && <Skills />}
        {tab === "sessions" && <Sessions />}
        {tab === "settings" && <Settings />}

        {error && (
          <div className="toast" role="alert" aria-live="assertive">
            {error}
            <button onClick={() => setError(null)}>dismiss</button>
          </div>
        )}
      </main>
    </div>
  );
}
