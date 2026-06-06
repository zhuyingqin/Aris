import { useRef, useState } from "react";
import { useStore } from "../store";
import { workflowControl } from "../api/tauri";
import { Badge, fmtTs } from "../util";
import type { WorkflowAgentRun, WorkflowControlAction } from "../types";

export default function RunBoard() {
  const [pendingAction, setPendingAction] = useState<WorkflowControlAction | null>(null);
  const pendingActionRef = useRef<WorkflowControlAction | null>(null);
  const runs = useStore((s) => s.runs);
  const selectedRunId = useStore((s) => s.selectedRunId);
  const refreshRuns = useStore((s) => s.refreshRuns);
  const setError = useStore((s) => s.setError);

  const run = runs.find((r) => r.runId === selectedRunId) ?? null;

  if (!run) {
    return (
      <div className="board">
        <div className="empty">
          No workflow run selected. Start one from the Studio, or pick a run on
          the left.
        </div>
      </div>
    );
  }

  const control = async (action: WorkflowControlAction) => {
    if (pendingActionRef.current) return;
    pendingActionRef.current = action;
    setPendingAction(action);
    try {
      await workflowControl(run.runId, action);
      await refreshRuns();
    } catch (err) {
      setError(String(err));
    } finally {
      pendingActionRef.current = null;
      setPendingAction(null);
    }
  };

  const byId = new Map<string, WorkflowAgentRun>(
    run.agents.map((a) => [a.agentId, a]),
  );
  const assigned = new Set<string>();
  const lanes = run.phases.map((phase) => {
    const agents = phase.agentIds
      .map((id) => {
        assigned.add(id);
        return byId.get(id);
      })
      .filter((a): a is WorkflowAgentRun => Boolean(a));
    return { phase, agents };
  });
  const unassigned = run.agents.filter((a) => !assigned.has(a.agentId));

  const s = run.status;
  return (
    <div className="board">
      <div className="board-controls">
        <h3 style={{ margin: 0 }}>{run.name}</h3>
        <Badge status={run.status} />
        <span className="spacer" style={{ flex: 1 }} />
        <button
          disabled={s !== "running" || Boolean(pendingAction)}
          onClick={() => control("pause")}
        >
          {pendingAction === "pause" ? "Pausing..." : "Pause"}
        </button>
        <button
          disabled={s !== "paused" || Boolean(pendingAction)}
          onClick={() => control("resume")}
        >
          {pendingAction === "resume" ? "Resuming..." : "Resume"}
        </button>
        <button
          disabled={s === "stopped" || s === "completed" || Boolean(pendingAction)}
          onClick={() => control("stop")}
        >
          {pendingAction === "stop" ? "Stopping..." : "Stop"}
        </button>
        <button disabled={Boolean(pendingAction)} onClick={() => control("restart")}>
          {pendingAction === "restart" ? "Restarting..." : "Restart"}
        </button>
      </div>

      <div className="run-row sub" style={{ paddingLeft: 0, border: "none" }}>
        run {run.runId} · updated {fmtTs(run.updatedAt)} · concurrency{" "}
        {run.maxConcurrency}/{run.maxAgents}
      </div>

      {lanes.map(({ phase, agents }) => (
        <div className="phase-lane" key={phase.phaseId}>
          <div className="phase-lane-head">
            <strong>{phase.name}</strong>
            <Badge status={phase.status} />
          </div>
          <div className="phase-lane-body">
            {agents.length === 0 && (
              <span className="hint">no agents yet</span>
            )}
            {agents.map((a) => (
              <AgentCard key={a.agentId} agent={a} />
            ))}
          </div>
        </div>
      ))}

      {unassigned.length > 0 && (
        <div className="phase-lane">
          <div className="phase-lane-head">
            <strong>Unassigned</strong>
          </div>
          <div className="phase-lane-body">
            {unassigned.map((a) => (
              <AgentCard key={a.agentId} agent={a} />
            ))}
          </div>
        </div>
      )}

      {run.result && (
        <div className="phase-lane">
          <div className="phase-lane-head">
            <strong>Result</strong>
          </div>
          <div className="phase-lane-body">
            <div style={{ color: "var(--text-dim)", whiteSpace: "pre-wrap" }}>
              {run.result}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AgentCard({ agent }: { agent: WorkflowAgentRun }) {
  return (
    <div className="agent-card">
      <div className="name">{agent.name}</div>
      <div style={{ color: "var(--text-dim)", margin: "3px 0 6px" }}>
        {agent.description}
      </div>
      <Badge status={agent.status} />
    </div>
  );
}
