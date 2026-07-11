import { useCallback, useEffect, useState } from "react";
import {
  isTauri,
  projectBriefGet,
  type ProjectBriefView,
  type ProjectGoalStatus,
} from "../api/tauri";
import type { Language } from "../store";

export const PROJECT_BRIEF_UPDATED_EVENT = "somniq:project-brief-updated";

export function notifyProjectBriefUpdated() {
  window.dispatchEvent(new CustomEvent(PROJECT_BRIEF_UPDATED_EVENT));
}

interface ProjectBriefPreference {
  collapsed: boolean;
  hidden: boolean;
}

function preferenceKey(projectId: string) {
  return `somniq-project-brief-v1:${projectId}`;
}

function loadPreference(projectId: string): ProjectBriefPreference {
  try {
    const raw = localStorage.getItem(preferenceKey(projectId));
    if (!raw) return { collapsed: false, hidden: false };
    const parsed = JSON.parse(raw) as Partial<ProjectBriefPreference>;
    return { collapsed: Boolean(parsed.collapsed), hidden: Boolean(parsed.hidden) };
  } catch {
    return { collapsed: false, hidden: false };
  }
}

export function useProjectBrief(projectId?: string | null) {
  const id = projectId ?? "default";
  const [brief, setBrief] = useState<ProjectBriefView | null>(null);
  const [preference, setPreference] = useState<ProjectBriefPreference>(() => loadPreference(id));

  const refresh = useCallback(() => {
    if (!isTauri()) return Promise.resolve(null);
    return projectBriefGet(id)
      .then((next) => {
        setBrief(next);
        return next;
      })
      .catch(() => null);
  }, [id]);

  useEffect(() => {
    setPreference(loadPreference(id));
    setBrief(null);
    void refresh();
  }, [id, refresh]);

  useEffect(() => {
    const listener = () => void refresh();
    window.addEventListener(PROJECT_BRIEF_UPDATED_EVENT, listener);
    return () => window.removeEventListener(PROJECT_BRIEF_UPDATED_EVENT, listener);
  }, [refresh]);

  const updatePreference = useCallback((patch: Partial<ProjectBriefPreference>) => {
    setPreference((current) => {
      const next = { ...current, ...patch };
      try {
        localStorage.setItem(preferenceKey(id), JSON.stringify(next));
      } catch {
        // The visible in-memory preference still works when storage is blocked.
      }
      return next;
    });
  }, [id]);

  return {
    brief,
    collapsed: preference.collapsed,
    hidden: preference.hidden,
    refresh,
    setCollapsed: (collapsed: boolean) => updatePreference({ collapsed }),
    setHidden: (hidden: boolean) => updatePreference({ hidden }),
  };
}

const COPY = {
  cn: {
    title: "项目摘要",
    mission: "项目使命",
    goal: "当前目标",
    criteria: "成功标准",
    status: "最近状态",
    noGoal: "发送第一条实质性请求后，SomniQ 会从你的问题中提炼当前目标。",
    hide: "隐藏项目摘要",
    collapse: "折叠项目摘要",
    expand: "展开项目摘要",
    active: "进行中",
    paused: "已暂停",
    complete: "已完成",
  },
  en: {
    title: "Project summary",
    mission: "Mission",
    goal: "Current goal",
    criteria: "Success criteria",
    status: "Recent status",
    noGoal: "After the first substantive request, SomniQ will summarize the current goal from your question.",
    hide: "Hide project summary",
    collapse: "Collapse project summary",
    expand: "Expand project summary",
    active: "Active",
    paused: "Paused",
    complete: "Complete",
  },
} satisfies Record<Language, Record<string, string>>;

function statusLabel(status: ProjectGoalStatus | undefined, language: Language) {
  const copy = COPY[language];
  if (status === "paused") return copy.paused;
  if (status === "complete") return copy.complete;
  return copy.active;
}

function RowIcon({ kind }: { kind: "mission" | "goal" | "criteria" | "status" }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (kind === "mission") return <svg {...common}><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /><path d="M12 2v3M22 12h-3M12 22v-3M2 12h3" /></svg>;
  if (kind === "goal") return <svg {...common}><path d="M5 4h14v16H5z" /><path d="m8 12 2.2 2.2L16 8.5" /></svg>;
  if (kind === "criteria") return <svg {...common}><path d="M8 6h11M8 12h11M8 18h11" /><path d="m3.5 6 .8.8L6 5M3.5 12l.8.8L6 11M3.5 18l.8.8L6 17" /></svg>;
  return <svg {...common}><path d="M4 18V6M4 18h16" /><path d="m7 14 4-4 3 2 5-6" /></svg>;
}

export default function ProjectBriefCard({
  brief,
  language,
  collapsed,
  onCollapsedChange,
  onHide,
}: {
  brief: ProjectBriefView;
  language: Language;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onHide: () => void;
}) {
  const copy = COPY[language];
  const goal = brief.goal ?? null;
  return (
    <section className={`project-brief-card${collapsed ? " collapsed" : ""}`} aria-label={copy.title}>
      <div className="project-brief-head">
        <button
          type="button"
          className="project-brief-toggle"
          onClick={() => onCollapsedChange(!collapsed)}
          aria-expanded={!collapsed}
          title={collapsed ? copy.expand : copy.collapse}
        >
          <span className="project-brief-title">{copy.title}</span>
          {collapsed && <span className="project-brief-preview">{goal?.objective ?? brief.mission}</span>}
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d={collapsed ? "m4 6 4 4 4-4" : "m4 10 4-4 4 4"} />
          </svg>
        </button>
        {goal && <span className={`project-brief-status ${goal.status}`}>{statusLabel(goal.status, language)}</span>}
        <button type="button" className="project-brief-hide" onClick={onHide} title={copy.hide} aria-label={copy.hide}>×</button>
      </div>
      {!collapsed && (
        <div className="project-brief-body">
          <div className="project-brief-row">
            <RowIcon kind="mission" />
            <div><span>{copy.mission}</span><p>{brief.mission}</p></div>
          </div>
          <div className="project-brief-row">
            <RowIcon kind="goal" />
            <div><span>{copy.goal}</span><p>{goal?.objective ?? copy.noGoal}</p></div>
          </div>
          {goal && (
            <>
              <div className="project-brief-row">
                <RowIcon kind="criteria" />
                <div>
                  <span>{copy.criteria}</span>
                  <ul>{goal.successCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul>
                </div>
              </div>
              <div className="project-brief-row">
                <RowIcon kind="status" />
                <div><span>{copy.status}</span><p>{goal.recentStatus}</p></div>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
