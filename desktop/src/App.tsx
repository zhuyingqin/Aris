import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useStore, type Tab } from "./store";
import Chat from "./chat/Chat";
import Studio from "./studio/Studio";
import Monitor from "./monitor/Monitor";
import TeamView from "./teams/TeamView";
import Settings from "./settings/Settings";
import Skills from "./skills/Skills";
import Sessions from "./sessions/Sessions";
import arisIcon from "./assets/aris-icon.svg";

interface NavItem {
  id: Tab;
  label: string;
  icon: string;
}
const NAV_GROUPS: { group: string; items: NavItem[] }[] = [
  {
    group: "Build",
    items: [
      { id: "chat", label: "Chat", icon: "💬" },
      { id: "studio", label: "Workflow Studio", icon: "🧩" },
    ],
  },
  {
    group: "Operate",
    items: [
      { id: "monitor", label: "Run Monitor", icon: "📈" },
      { id: "teams", label: "Team", icon: "👥" },
    ],
  },
  {
    group: "Library",
    items: [
      { id: "skills", label: "Skills", icon: "📚" },
      { id: "sessions", label: "Sessions", icon: "🗂️" },
    ],
  },
  {
    group: "System",
    items: [{ id: "settings", label: "Settings", icon: "⚙️" }],
  },
];

const LABELS: Record<Tab, string> = Object.fromEntries(
  NAV_GROUPS.flatMap((g) => g.items).map((i) => [i.id, i.label]),
) as Record<Tab, string>;

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
  const [theme, setTheme] = useState<"dark" | "light">(
    () => (localStorage.getItem("aris-theme") === "light" ? "light" : "dark"),
  );
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const chooseProject = async () => {
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

  return (
    <div className="app">
      <aside className={`sidebar${mobileNavOpen ? " mobile-open" : ""}`}>
        <div className="brand">
          <img className="brand-mark" src={arisIcon} alt="" />
          <span className="brand-text">
            ARIS
            <small>Team · Workflow · Chat</small>
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
                  setTab(t.id);
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
          <div className="project-switcher">
            <select
              aria-label="Current project"
              value={currentProject?.id ?? ""}
              disabled={projectBusy || projects.length === 0}
              onChange={(event) => void switchProject(event.target.value).catch(() => undefined)}
              title={currentProject?.path}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
            <button onClick={() => void chooseProject()} disabled={projectBusy || projects.length === 0}>
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
        {tab === "studio" && <Studio />}
        {tab === "monitor" && <Monitor />}
        {tab === "teams" && <TeamView />}
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
