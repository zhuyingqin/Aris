import { useEffect, useState } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  type Edge,
  type Node,
  type ReactFlowInstance,
} from "reactflow";
import { nodeTypes } from "./nodes";
import type { FlowEdge, FlowNode, FlowNodeData } from "./dsl";

interface Props {
  nodes: FlowNode[];
  edges: FlowEdge[];
  selectedIndex: number | null;
  onSelect: (statementIndex: number) => void;
}

export default function WorkflowCanvas({
  nodes,
  edges,
  selectedIndex,
  onSelect,
}: Props) {
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance | null>(null);
  const rfNodes: Node<FlowNodeData>[] = nodes.map((n) => ({
    ...n,
    selected:
      selectedIndex != null &&
      n.data.statementIndex >= 0 &&
      n.data.statementIndex === selectedIndex,
  }));
  const rfEdges: Edge[] = edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
  }));
  const graphSignature = `${nodes.map((node) => node.id).join("|")}:${edges.map((edge) => edge.id).join("|")}`;

  useEffect(() => {
    if (!flowInstance) return;
    const frame = window.requestAnimationFrame(() => {
      void flowInstance.fitView({ padding: 0.2, duration: 180 });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [flowInstance, graphSignature]);

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      onInit={setFlowInstance}
      onNodeClick={(_, node) => onSelect(node.data.statementIndex)}
      nodesConnectable={false}
      nodesDraggable={false}
      fitView
      minZoom={0.2}
    >
      <Background gap={18} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable />
    </ReactFlow>
  );
}
