import { useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent, type MutableRefObject } from "react";
import type { DesktopProject } from "./types";
import { SvgIcon } from "./SvgIcon";

export type AppProjectSwitcherCopy = {
  currentProject: string;
  noProject: string;
  projects: string;
  dragToReorder: string;
  addProject: string;
  openWorkspace: string;
  openProjectFolder: string;
  projectEmptyHint: string;
};

type Props = {
  copy: AppProjectSwitcherCopy;
  projects: DesktopProject[];
  currentProject: DesktopProject | null;
  busy: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onReveal: () => void;
  drag?: {
    id: string | null;
    suppressClick: MutableRefObject<boolean>;
    onStart: (event: PointerEvent<HTMLElement>, id: string) => void;
    onMove: (event: PointerEvent<HTMLElement>) => void;
    onEnd: (event: PointerEvent<HTMLElement>) => void;
    onCancel: (event: PointerEvent<HTMLElement>) => void;
  };
};

export default function AppProjectSwitcher({ copy, projects, currentProject, busy, open, onOpenChange, onSelect, onAdd, onReveal, drag }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [placement, setPlacement] = useState<{ maxHeight?: number; left: number }>({ left: 0 });

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const root = rootRef.current;
      const menu = menuRef.current;
      if (!root || !menu) return;
      const rect = root.getBoundingClientRect();
      const gap = (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16) * 0.375;
      const origin = rect.left + root.clientLeft;
      const left = Math.max(8, Math.min(origin, innerWidth - menu.offsetWidth - 8)) - origin;
      const maxHeight = Math.max(0, Math.min(400, innerHeight - rect.bottom - gap - 8));
      setPlacement(previous => previous.left === left && previous.maxHeight === maxHeight ? previous : { left, maxHeight });
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    if (rootRef.current) observer?.observe(rootRef.current);
    if (menuRef.current) observer?.observe(menuRef.current);
    window.addEventListener("resize", update);
    return () => { observer?.disconnect(); window.removeEventListener("resize", update); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    const target = busy ? menu : menu?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')
      ?? menu?.querySelector<HTMLElement>('[role="option"], button:not(:disabled)') ?? menu;
    target?.focus({ preventScroll: true });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onOpenChange(false);
      triggerRef.current?.focus({ preventScroll: true });
    };
    const closeOnPointerDown = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) onOpenChange(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeOnPointerDown);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeOnPointerDown);
    };
  }, [open, busy, onOpenChange]);

  const activate = (action: () => void) => {
    onOpenChange(false);
    triggerRef.current?.focus({ preventScroll: true });
    action();
  };

  return (
    <div className="project-switcher" ref={rootRef} data-onboarding-target="project-switcher"
      onBlur={event => {
        if (open && event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) onOpenChange(false);
      }}>
      <button className="project-switcher-trigger" type="button" ref={triggerRef}
        aria-label={copy.currentProject} aria-haspopup="dialog" aria-expanded={open}
        aria-controls={open ? menuId : undefined} disabled={busy}
        title={currentProject ? `${currentProject.name}\n${currentProject.path}` : copy.addProject}
        onClick={() => onOpenChange(!open)}
        onKeyDown={event => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); onOpenChange(true); }
        }}>
        <SvgIcon name="folder" className="project-switcher-icon" />
        <span className="project-switcher-current">{currentProject?.name ?? copy.noProject}</span>
        <span className="project-switcher-caret" aria-hidden="true"><SvgIcon name="chevronDown" size={12} /></span>
      </button>
      {open && (
        <div className="project-menu" id={menuId} role="dialog" aria-label={copy.projects} tabIndex={-1}
          ref={menuRef} style={placement}>
          <div className="project-menu-heading" aria-hidden="true">{copy.projects}</div>
          {projects.length ? (
            <div className="project-menu-list" role="listbox" aria-label={copy.projects} aria-busy={busy}>
              {projects.map(project => (
                <div key={project.id} className={`project-menu-item${currentProject?.id === project.id ? " active" : ""}${drag?.id === project.id ? " dragging" : ""}`}
                  role="option" aria-selected={currentProject?.id === project.id} aria-disabled={busy}
                  tabIndex={busy ? -1 : 0} data-project-id={project.id} title={`${project.name}\n${project.path}`}
                  onClick={event => {
                    if (drag?.suppressClick.current) { event.preventDefault(); event.stopPropagation(); return; }
                    if (!busy) activate(() => onSelect(project.id));
                  }}
                  onKeyDown={event => {
                    if (busy) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault(); activate(() => onSelect(project.id));
                    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                      event.preventDefault();
                      const options = [...event.currentTarget.parentElement!.querySelectorAll<HTMLElement>('[role="option"]')];
                      const index = options.indexOf(event.currentTarget);
                      const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
                        : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
                      options[next]?.focus();
                    }
                  }}
                  onPointerDown={event => drag?.onStart(event, project.id)}
                  onPointerMove={drag?.onMove} onPointerUp={drag?.onEnd} onPointerCancel={drag?.onCancel}>
                  <span className="project-drag-handle" aria-hidden="true" title={copy.dragToReorder}
                    onClick={event => { event.preventDefault(); event.stopPropagation(); }}>
                    <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden="true">
                      <circle cx="3" cy="3" r="1.1" /><circle cx="7" cy="3" r="1.1" />
                      <circle cx="3" cy="7" r="1.1" /><circle cx="7" cy="7" r="1.1" />
                      <circle cx="3" cy="11" r="1.1" /><circle cx="7" cy="11" r="1.1" />
                    </svg>
                  </span>
                  <span className="project-menu-copy">
                    <span className="project-menu-name">{project.name}</span>
                    <span className="project-menu-path">{project.path}</span>
                  </span>
                  <span className="project-current-dot" aria-hidden="true" />
                </div>
              ))}
            </div>
          ) : <p className="project-menu-empty">{copy.projectEmptyHint}</p>}
          <div className="project-menu-actions">
            <button type="button" className="project-menu-action" disabled={busy} onClick={() => activate(onAdd)}>
              <SvgIcon name="plus" /><span>{copy.addProject}</span>
            </button>
            <button type="button" className="project-menu-action" disabled={busy || !currentProject?.path}
              title={currentProject?.path ? `${copy.openWorkspace} (${currentProject.path})` : copy.openWorkspace}
              onClick={() => activate(onReveal)}>
              <SvgIcon name="externalLink" /><span>{copy.openProjectFolder}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
