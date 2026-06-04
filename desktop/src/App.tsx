import { useEffect } from "react";
import { useStore, type Tab } from "./store";
import Studio from "./studio/Studio";
import Monitor from "./monitor/Monitor";
import TeamView from "./teams/TeamView";
import Settings from "./settings/Settings";
import Skills from "./skills/Skills";
import Sessions from "./sessions/Sessions";

const TABS: { id: Tab; label: string }[] = [
  { id: "studio", label: "Workflow Studio" },
  { id: "monitor", label: "Run Monitor" },
  { id: "teams", label: "Team" },
  { id: "skills", label: "Skills" },
  { id: "sessions", label: "Sessions" },
  { id: "settings", label: "Settings" },
];

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
          ARIS Studio
          <small>Team & Workflow</small>
        </div>
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`nav-item${tab === t.id ? " active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </aside>

      <header className="app-head">
        <div>{TABS.find((t) => t.id === tab)?.label}</div>
        <div className="dir" title="run-state directory">
          {stateDir || "…"}
        </div>
      </header>

      <main className="app-main">
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
