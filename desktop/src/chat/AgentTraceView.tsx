import type { AgentInteraction, AgentInteractionKind, AgentTrace } from "../api/agentTasks";

const kindLabels: Record<"cn" | "en", Record<AgentInteractionKind, string>> = {
  cn: { spawn_agent: "创建", assign_task: "任务", send_message: "消息", agent_result: "结果", close_agent: "关闭", review_request: "审阅请求", review_verdict: "审阅结论" },
  en: { spawn_agent: "Spawn", assign_task: "Task", send_message: "Message", agent_result: "Result", close_agent: "Close", review_request: "Review request", review_verdict: "Verdict" },
};
const turnStates: Record<"cn" | "en", Record<string, string>> = {
  cn: { completed: "已完成", interrupted: "已停止", errored: "失败" },
  en: { completed: "Completed", interrupted: "Stopped", errored: "Failed" },
};

/** Ids are long and random; the tail tells them apart, the title keeps the whole. */
function Id({ value }: { value?: string | null }) {
  if (!value) return null;
  return <code className="agent-trace-id" title={value}>{value.length > 14 ? `…${value.slice(-12)}` : value}</code>;
}

function Source({ edge, cn }: { edge: AgentInteraction; cn: boolean }) {
  return <span className="agent-trace-source">
    {cn ? "来自" : "from"} <strong>{edge.fromPath ?? "?"}</strong>
    {edge.sourceTurnId && <> · {cn ? "回合" : "turn"} <Id value={edge.sourceTurnId} /></>}
    {edge.sourceToolUseId && <> · {cn ? "工具调用" : "tool call"} <Id value={edge.sourceToolUseId} /></>}
    {edge.sourceActionId && <> · {cn ? "控制器动作" : "controller action"} <Id value={edge.sourceActionId} /></>}
  </span>;
}

function Delivery({ edge, cn }: { edge: AgentInteraction; cn: boolean }) {
  return <span className="agent-trace-source">
    → <strong>{edge.toPath ?? "?"}</strong>
    {edge.deliveredTurnId
      ? <> · {cn ? "已在回合" : "read in turn"} <Id value={edge.deliveredTurnId} />{cn ? " 读取" : ""}</>
      : <> · {cn ? "尚未被读取" : "not read yet"}</>}
  </span>;
}

/**
 * One child's place in the agent graph: what started it, and for each of its
 * turns the mail it read, the tools it called and what it sent back. A result
 * can be followed from the turn that wrote it to the parent's tool call.
 */
export default function AgentTraceView({ trace, childSessionId, language }: {
  trace: AgentTrace;
  childSessionId: string;
  language: "cn" | "en";
}) {
  const cn = language === "cn";
  const node = trace.nodes.find(candidate => candidate.sessionId === childSessionId);
  if (!node) return <p className="agent-task-panel-empty">{cn ? "尚无可追溯的交互" : "No interactions to trace yet"}</p>;
  const edges = new Map(trace.edges.map(edge => [edge.id, edge]));
  const pick = (ids: string[]) => ids.map(id => edges.get(id)).filter((edge): edge is AgentInteraction => Boolean(edge));
  const spawn = trace.edges.find(edge => edge.kind === "spawn_agent" && edge.toSessionId === childSessionId);
  const close = trace.edges.find(edge => edge.kind === "close_agent" && edge.toSessionId === childSessionId);
  const kind = (edge: AgentInteraction) => kindLabels[language][edge.kind];

  return <div className="agent-trace" aria-label={cn ? "交互追溯" : "Interaction trace"}>
    {spawn && <p className="agent-trace-origin"><span className="agent-trace-kind">{kind(spawn)}</span><Source edge={spawn} cn={cn} /></p>}
    {node.turns.length === 0 && <p className="agent-task-panel-empty">{cn ? "子智能体还没有开始执行" : "The agent has not run yet"}</p>}
    <ol className="agent-trace-turns">
      {node.turns.map((turn, index) => {
        const received = pick(turn.received);
        const sent = pick(turn.sent);
        return <li key={turn.turnId} data-status={turn.status ?? "running"}>
          <header>
            <strong>{cn ? `第 ${index + 1} 轮` : `Turn ${index + 1}`}</strong>
            <span>{turn.status ? turnStates[language][turn.status] ?? turn.status : (cn ? "进行中" : "Running")}</span>
            <Id value={turn.turnId} />
          </header>
          {turn.reason && <small className="agent-trace-reason">{turn.reason}</small>}
          {received.length > 0 && <section aria-label={cn ? "读取" : "Read"}>
            <h4>{cn ? "读取" : "Read"}</h4>
            <ul>{received.map(edge => <li key={edge.id}><span className="agent-trace-kind">{kind(edge)}</span><Source edge={edge} cn={cn} /></li>)}</ul>
          </section>}
          <section aria-label={cn ? "工具调用" : "Tool calls"}>
            <h4>{cn ? "工具调用" : "Tool calls"}</h4>
            {turn.tools.length
              ? <ul>{turn.tools.map((call, position) => <li key={`${call.toolUseId ?? call.toolName}-${position}`} data-error={call.isError ? "true" : undefined}>
                <code>{call.toolName}</code>
                {call.isError ? <span className="agent-trace-failed">{cn ? "失败" : "failed"}</span> : !call.finishedTs && <span>{cn ? "进行中" : "running"}</span>}
                <Id value={call.toolUseId} />
              </li>)}</ul>
              : <p className="agent-trace-none">{cn ? "本轮没有调用工具" : "No tools called in this turn"}</p>}
          </section>
          {sent.length > 0 && <section aria-label={cn ? "发出" : "Sent"}>
            <h4>{cn ? "发出" : "Sent"}</h4>
            <ul>{sent.map(edge => <li key={edge.id}>
              <span className="agent-trace-kind">{kind(edge)}</span>
              {edge.status && edge.kind === "agent_result" && <span>{turnStates[language][edge.status] ?? edge.status}</span>}
              <Delivery edge={edge} cn={cn} />
            </li>)}</ul>
          </section>}
        </li>;
      })}
    </ol>
    {close && <p className="agent-trace-origin"><span className="agent-trace-kind">{kind(close)}</span><span className="agent-trace-source">{close.status}</span></p>}
  </div>;
}
