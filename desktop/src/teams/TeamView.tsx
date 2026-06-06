import { useState } from "react";
import { useStore } from "../store";
import { Badge } from "../util";
import TeamGraph from "./TeamGraph";

export default function TeamView() {
  const team = useStore((s) => s.team);
  const [view, setView] = useState<"graph" | "list">("graph");

  const tabBtn = (key: "graph" | "list", label: string) => (
    <button
      onClick={() => setView(key)}
      style={{
        padding: "4px 12px",
        borderRadius: 6,
        border: "1px solid var(--border, #334155)",
        background: view === key ? "var(--accent, #3b82f6)" : "transparent",
        color: view === key ? "#fff" : "var(--text, inherit)",
        cursor: "pointer",
        fontSize: 12,
      }}
    >
      {label}
    </button>
  );

  const toggle = (
    <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
      {tabBtn("graph", "Graph")}
      {tabBtn("list", "List")}
    </div>
  );

  if (!team) {
    return (
      <div className="board">
        {toggle}
        <div className="empty">
          No team state found in this run-state directory yet.
        </div>
      </div>
    );
  }

  if (view === "graph") {
    return (
      <div
        className="board"
        style={{ display: "flex", flexDirection: "column", height: "100%" }}
      >
        {toggle}
        <div style={{ flex: 1, minHeight: 480 }}>
          <TeamGraph />
        </div>
      </div>
    );
  }

  const { tasks, agents } = team;
  const teamName =
    (team.team?.name as string) ?? (team.team?.teamId as string) ?? "team";

  return (
    <div className="board">
      {toggle}
      <h3 style={{ marginTop: 0 }}>{teamName}</h3>

      <div className="phase-lane">
        <div className="phase-lane-head">
          <strong>Tasks ({tasks.length})</strong>
        </div>
        <div className="phase-lane-body" style={{ flexDirection: "column" }}>
          {tasks.length === 0 && <span className="hint">No tasks.</span>}
          {tasks.map((t, i) => (
            <div
              key={t.taskId ?? i}
              className="agent-card"
              style={{ width: "100%" }}
            >
              <div className="name">{t.title ?? t.taskId ?? `task ${i}`}</div>
              <div
                style={{
                  margin: "4px 0",
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                {t.status && <Badge status={String(t.status)} />}
                {t.claimedBy && <span className="tag">@{String(t.claimedBy)}</span>}
                {t.verification?.status && (
                  <Badge status={`verify_${t.verification.status}`} />
                )}
              </div>
              {t.dependencies && t.dependencies.length > 0 && (
                <div style={{ color: "var(--text-dim)", fontSize: 11 }}>
                  depends on: {t.dependencies.join(", ")}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="phase-lane">
        <div className="phase-lane-head">
          <strong>Agents ({agents.length})</strong>
        </div>
        <div className="phase-lane-body">
          {agents.length === 0 && <span className="hint">No agents.</span>}
          {agents.map((a) => (
            <div key={a.agentId} className="agent-card">
              <div className="name">{a.name}</div>
              <div style={{ color: "var(--text-dim)", margin: "3px 0 6px" }}>
                {a.description}
              </div>
              <Badge status={a.status} />
              {a.model && (
                <span className="tag" style={{ marginLeft: 6 }}>
                  {a.model}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
