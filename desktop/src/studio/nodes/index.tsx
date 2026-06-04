import { Handle, Position, type NodeProps, type NodeTypes } from "reactflow";
import type { FlowNodeData } from "../dsl";

const tIn = <Handle type="target" position={Position.Left} />;
const sOut = <Handle type="source" position={Position.Right} />;

function PhaseNode({ data, selected }: NodeProps<FlowNodeData>) {
  return (
    <div className={`rf-node rf-phase${selected ? " selected" : ""}`}>
      {tIn}
      <span className="tag">phase</span>
      {data.label}
      {sOut}
    </div>
  );
}

function AgentNode({ data, selected }: NodeProps<FlowNodeData>) {
  const spec = data.spec;
  return (
    <div className={`rf-node rf-agent${selected ? " selected" : ""}`}>
      {tIn}
      <div className="desc">{data.label || "(agent)"}</div>
      <div className="meta">
        {spec?.subagentType && <span className="tag">{spec.subagentType}</span>}
        {spec?.model && <span className="tag">{spec.model}</span>}
        {spec?.name && <span className="tag">@{spec.name}</span>}
      </div>
      {sOut}
    </div>
  );
}

function BarrierNode({ selected }: NodeProps<FlowNodeData>) {
  return (
    <div className={`rf-node rf-barrier${selected ? " selected" : ""}`}>
      {tIn}
      ⟦ waitAll ⟧
      {sOut}
    </div>
  );
}

function ResultNode({ data, selected }: NodeProps<FlowNodeData>) {
  return (
    <div className={`rf-node rf-result${selected ? " selected" : ""}`}>
      {tIn}
      ◎ saveResult("{data.resultKey ?? data.label}")
      {sOut}
    </div>
  );
}

export const nodeTypes: NodeTypes = {
  phase: PhaseNode,
  agent: AgentNode,
  barrier: BarrierNode,
  result: ResultNode,
};
