import { useMemo } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  type Edge,
  type Node,
} from "reactflow";
import { useStore } from "../store";
import type { TeamTask } from "../types";

// Left-border accent per task status.
const STATUS_COLOR: Record<string, string> = {
  completed: "#2ecc71",
  failed: "#e74c3c",
  in_progress: "#3498db",
  blocked: "#f39c12",
  cancelled: "#7f8c8d",
  pending: "#bdc3c7",
};

const VERIFY_TAG: Record<string, string> = {
  passed: "✓ verified",
  failed: "✗ rejected",
  needs_judgment: "? review",
};

function taskLabel(task: TeamTask): string {
  const who = task.claimedBy ? `\n@${task.claimedBy}` : "";
  const status = (task.status ?? "").replace(/_/g, " ");
  const verify = task.verification?.status
    ? `\n${VERIFY_TAG[task.verification.status] ?? task.verification.status}`
    : "";
  return `${task.title}${who}\n[${status}]${verify}`;
}

/**
 * Live reactflow graph of the active team: a lead node fans out to one node per
 * task (assignment edges), with dashed edges for task dependencies. Colors track
 * status and the label carries the verification verdict. Re-derives from the
 * zustand `team` snapshot, which the store refreshes on every run-event.
 */
export default function TeamGraph() {
  const team = useStore((s) => s.team);

  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    if (!team) return { nodes, edges };

    const tasks = team.tasks ?? [];
    const teamName =
      (team.team?.name as string) ?? (team.team?.teamId as string) ?? "Lead";

    nodes.push({
      id: "__lead__",
      position: { x: 0, y: 0 },
      data: { label: `\u{1f9ed} ${teamName}` },
      type: "input",
      style: {
        background: "#1e293b",
        color: "#fff",
        border: "1px solid #334155",
        borderRadius: 10,
        fontWeight: 600,
        width: 220,
      },
    });

    const ids = new Set(tasks.map((t) => t.taskId));
    const roots = tasks.filter((t) => !(t.dependencies && t.dependencies.length));
    const dependents = tasks.filter(
      (t) => t.dependencies && t.dependencies.length,
    );

    const place = (list: TeamTask[], y: number) => {
      const span = 250;
      const startX = -((list.length - 1) * span) / 2;
      list.forEach((task, i) => {
        const color =
          STATUS_COLOR[(task.status ?? "").toLowerCase()] ?? "#bdc3c7";
        nodes.push({
          id: task.taskId,
          position: { x: startX + i * span, y },
          data: { label: taskLabel(task) },
          style: {
            borderLeft: `5px solid ${color}`,
            borderRadius: 8,
            padding: 8,
            width: 210,
            whiteSpace: "pre-wrap",
            fontSize: 12,
            textAlign: "left",
          },
        });
        edges.push({
          id: `lead-${task.taskId}`,
          source: "__lead__",
          target: task.taskId,
          animated: (task.status ?? "").toLowerCase() === "in_progress",
        });
      });
    };
    place(roots, 170);
    place(dependents, 360);

    for (const task of tasks) {
      for (const dep of task.dependencies ?? []) {
        if (ids.has(dep)) {
          edges.push({
            id: `${dep}->${task.taskId}`,
            source: dep,
            target: task.taskId,
            label: "depends",
            style: { stroke: "#888", strokeDasharray: "4 3" },
          });
        }
      }
    }

    return { nodes, edges };
  }, [team]);

  if (!team) {
    return (
      <div className="board">
        <div className="empty">No team state found yet.</div>
      </div>
    );
  }

  return (
    <div style={{ width: "100%", height: "100%", minHeight: 480 }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        minZoom={0.2}
        nodesConnectable={false}
        nodesDraggable={false}
      >
        <Background gap={18} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable />
      </ReactFlow>
    </div>
  );
}
