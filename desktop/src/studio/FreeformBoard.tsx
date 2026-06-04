import { useCallback, useMemo, useState } from "react";
import ReactFlow, {
  addEdge,
  Background,
  Controls,
  MiniMap,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
} from "reactflow";
import { nodeTypes } from "./nodes";
import {
  generateScript,
  graphToStatements,
  toFlow,
  type FlowNodeData,
  type Statement,
} from "./dsl";

let idCounter = 1;
const newId = () => `f${idCounter++}`;

interface Props {
  seed: Statement[];
  onApply: (script: string) => void;
}

// Free-form canvas: drag nodes, draw wires (phase→agent = membership,
// stage→stage = sequence), add/delete nodes, then compile to the linear DSL.
export default function FreeformBoard({ seed, onApply }: Props) {
  const initial = useMemo(() => toFlow(seed), [seed]);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNodeData>(
    initial.nodes as Node<FlowNodeData>[],
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState(
    initial.edges as Edge[],
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const onConnect = useCallback(
    (c: Connection) => setEdges((eds) => addEdge(c, eds)),
    [setEdges],
  );

  const addNode = (type: string, data: Partial<FlowNodeData>) => {
    const id = newId();
    setNodes((ns) => [
      ...ns,
      {
        id,
        type,
        position: { x: 60 + (ns.length % 6) * 30, y: 40 + ns.length * 26 },
        data: { label: "", statementIndex: -1, ...data },
      } as Node<FlowNodeData>,
    ]);
    setSelected(id);
    setMsg(null);
  };

  const updateSelected = (patch: Partial<FlowNodeData>) =>
    setNodes((ns) =>
      ns.map((n) =>
        n.id === selected ? { ...n, data: { ...n.data, ...patch } } : n,
      ),
    );

  const removeSelected = () => {
    if (!selected) return;
    setNodes((ns) => ns.filter((n) => n.id !== selected));
    setEdges((es) => es.filter((e) => e.source !== selected && e.target !== selected));
    setSelected(null);
  };

  const apply = () => {
    const { statements, error, orphanAgents } = graphToStatements(nodes, edges);
    if (error) {
      setMsg(`⚠ ${error}`);
      return;
    }
    onApply(generateScript(statements));
    setMsg(
      `Applied → DSL: ${statements.length} statement(s)` +
        (orphanAgents ? `, ${orphanAgents} unwired agent(s) skipped` : ""),
    );
  };

  const selectedNode = nodes.find((n) => n.id === selected) ?? null;
  const rfNodes = nodes.map((n) => ({ ...n, selected: n.id === selected }));

  return (
    <div className="studio">
      <div className="studio-toolbar">
        <span className="hint" style={{ marginRight: 4 }}>add:</span>
        <button onClick={() => addNode("phase", { label: "New phase" })}>Phase</button>
        <button
          onClick={() =>
            addNode("agent", {
              label: "New agent",
              spec: {
                description: "New agent",
                prompt: "Describe the task.",
                subagentType: null,
                name: null,
                model: null,
              },
            })
          }
        >
          Agent
        </button>
        <button onClick={() => addNode("barrier", { label: "waitAll" })}>waitAll</button>
        <button onClick={() => addNode("result", { resultKey: "result" })}>Result</button>
        <span className="spacer" style={{ flex: 1 }} />
        {msg && <span className="hint">{msg}</span>}
        <button className="primary" onClick={apply}>Apply → DSL</button>
      </div>

      <div className="canvas-wrap">
        <ReactFlow
          nodes={rfNodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={(_, n) => setSelected(n.id)}
          onPaneClick={() => setSelected(null)}
          deleteKeyCode={["Delete", "Backspace"]}
          nodesDraggable
          nodesConnectable
          elementsSelectable
          fitView
          minZoom={0.2}
        >
          <Background gap={18} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>

      <div className="studio-side">
        <div className="panel-title">Inspector</div>
        {!selectedNode ? (
          <div className="hint">
            Drag nodes to arrange. Wire <b>phase → agent</b> to assign an agent
            to a phase, and <b>stage → stage</b> to set the run order. Select a
            node to edit it; press Delete to remove. Then <b>Apply → DSL</b>.
          </div>
        ) : (
          <div className="inspector">
            <NodeEditor node={selectedNode} onChange={updateSelected} />
            <button onClick={removeSelected}>Remove node</button>
          </div>
        )}
      </div>
    </div>
  );
}

function NodeEditor({
  node,
  onChange,
}: {
  node: Node<FlowNodeData>;
  onChange: (patch: Partial<FlowNodeData>) => void;
}) {
  const spec = node.data.spec;
  if (node.type === "phase") {
    return (
      <div className="field">
        <label>phase name</label>
        <input
          value={node.data.label}
          onChange={(e) => onChange({ label: e.target.value })}
        />
      </div>
    );
  }
  if (node.type === "result") {
    return (
      <div className="field">
        <label>result key</label>
        <input
          value={node.data.resultKey ?? node.data.label}
          onChange={(e) => onChange({ resultKey: e.target.value, label: e.target.value })}
        />
      </div>
    );
  }
  if (node.type === "agent" && spec) {
    const set = (patch: Partial<typeof spec>) =>
      onChange({ spec: { ...spec, ...patch }, label: patch.description ?? node.data.label });
    return (
      <>
        <div className="field">
          <label>description</label>
          <input
            value={spec.description}
            onChange={(e) => set({ description: e.target.value })}
          />
        </div>
        <div className="field">
          <label>prompt</label>
          <textarea
            rows={4}
            value={spec.prompt}
            onChange={(e) => onChange({ spec: { ...spec, prompt: e.target.value } })}
          />
        </div>
        <div className="field">
          <label>subagent type</label>
          <input
            value={spec.subagentType ?? ""}
            onChange={(e) =>
              onChange({ spec: { ...spec, subagentType: e.target.value || null } })
            }
          />
        </div>
        <div className="field">
          <label>model</label>
          <input
            value={spec.model ?? ""}
            onChange={(e) => onChange({ spec: { ...spec, model: e.target.value || null } })}
          />
        </div>
      </>
    );
  }
  return <div className="hint">waitAll barrier — no properties.</div>;
}
