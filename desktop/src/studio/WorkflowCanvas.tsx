import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  type Edge,
  type Node,
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

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      onNodeClick={(_, node) => onSelect(node.data.statementIndex)}
      nodesConnectable={false}
      fitView
      minZoom={0.2}
    >
      <Background gap={18} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable />
    </ReactFlow>
  );
}
