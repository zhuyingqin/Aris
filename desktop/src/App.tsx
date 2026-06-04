import { useEffect } from "react";
import { useStore, type Tab } from "./store";
import Chat from "./chat/Chat";
import Studio from "./studio/Studio";
import Monitor from "./monitor/Monitor";
import TeamView from "./teams/TeamView";
import Settings from "./settings/Settings";
import Skills from "./skills/Skills";
import Sessions from "./sessions/Sessions";

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

  useEffect(() => init(), [init]);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          🌙 ARIS Studio
          <small>Team · Workflow · Chat</small>
        </div>
        {NAV_GROUPS.map((g) => (
          <div className="nav-group" key={g.group}>
            <div className="nav-group-label">{g.group}</div>
            {g.items.map((t) => (
              <button
                key={t.id}
                className={`nav-item${tab === t.id ? " active" : ""}`}
                onClick={() => setTab(t.id)}
              >
                <span className="nav-icon">{t.icon}</span>
                {t.label}
              </button>
            ))}
          </div>
        ))}
      </aside>

      <header className="app-head">
        <div className="app-title">{LABELS[tab]}</div>
        <div className="dir" title="run-state directory">
          {stateDir || "…"}
        </div>
      </header>

      <main className="app-main">
        {tab === "chat" && <Chat />}
        {tab === "studio" && <Studio />}
        {tab === "monitor" && <Monitor />}
        {tab === "teams" && <TeamView />}
        {tab === "skills" && <Skills />}
        {tab === "sessions" && <Sessions />}
        {tab === "settings" && <Settings />}

        {error && (
          <div className="toast">
            {error}
            <button onClick={() => setError(null)}>dismiss</button>
          </div>
        )}
      </main>
    </div>
  );
}
