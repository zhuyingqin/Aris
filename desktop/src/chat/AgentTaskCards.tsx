import type { AgentTaskCard } from "../api/agentTasks";
import { SvgIcon } from "../SvgIcon";
import { AgentTaskElapsed, AgentTaskIdentity, agentTaskActivity, agentTaskDisplayName } from "./agentTaskPresentation";
import "./AgentTaskCards.css";

export { agentTaskName } from "./agentTaskPresentation";

export const agentTaskLabels = {
  cn: { pending_init: "排队", running: "运行中", waiting: "等待中", completed: "已完成", errored: "失败", interrupted: "已停止", shutdown: "已停止" },
  en: { pending_init: "Queued", running: "Running", waiting: "Waiting", completed: "Completed", errored: "Failed", interrupted: "Stopped", shutdown: "Stopped" },
};

export function isAgentTaskActive(agent: AgentTaskCard): boolean {
  return ["pending_init", "running", "waiting"].includes(agent.status.state);
}

export function AgentTaskStatusIcon({ state }: { state: AgentTaskCard["status"]["state"] }) {
  return <span className={`agent-task-state is-${state}`} aria-hidden="true">
    <SvgIcon name={state === "completed" ? "check" : state === "errored" ? "warning"
      : state === "interrupted" || state === "shutdown" ? "stop"
        : state === "running" ? "spinner" : "clock"} size={14} />
  </span>;
}

type TaskProps = {
  agents: AgentTaskCard[];
  language: "cn" | "en";
  error?: string;
};

/** The summary stays small; the list and original conversations share the side pane. */
export default function AgentTaskCards({ agents, language, error, onOpenList }: TaskProps & { onOpenList: () => void }) {
  if (!agents.length && !error) return null;
  const cn = language === "cn";
  const active = agents.filter(isAgentTaskActive).length;
  const failed = agents.filter(agent => agent.status.state === "errored").length;
  const visibleError = error || agents.find(agent => agent.persistenceError)?.persistenceError;
  return <section className="agent-task-cards" aria-label={cn ? "子智能体" : "Agents"}>
    <div className="agent-task-list-heading"><h3>{cn ? "子智能体" : "Agents"}</h3></div>
    {agents.length > 0 && <button type="button" className="agent-task-launcher" onClick={onOpenList}
      aria-label={cn ? "查看子智能体" : "View agents"} aria-controls="side-task-panel">
      <span className="agent-identity-group">{agents.slice(0, 4).map(agent => <AgentTaskIdentity key={agent.sessionId} agent={agent} />)}</span>
      <span className="agent-task-launcher-copy">
        {cn ? (active ? `${active} 个进行中` : `${agents.length} 个子任务`) : (active ? `${active} active` : `${agents.length} agents`)}
        {failed > 0 && <small>{cn ? `${failed} 个失败` : `${failed} failed`}</small>}
      </span>
      <SvgIcon name="chevronRight" size={13} />
    </button>}
    {visibleError && <p className="agent-task-error" role="alert">{visibleError}</p>}
  </section>;
}

export function AgentTaskList({ agents, language, error, onOpenTask }: TaskProps & { onOpenTask: (agent: AgentTaskCard) => void }) {
  const cn = language === "cn";
  const active = agents.filter(isAgentTaskActive).length;
  return <div className="agent-task-directory">
    <header><h2>{cn ? "子智能体" : "Agents"}</h2><span>{cn ? `${agents.length} 个任务 · ${active} 个进行中` : `${agents.length} agents · ${active} active`}</span></header>
    {error && <p className="agent-task-error" role="alert">{error}</p>}
    <ul className="agent-task-list">
      {agents.map(agent => <li key={agent.sessionId}>
        <button type="button" className="agent-task-row" data-state={agent.status.state}
          aria-label={cn ? `打开子任务 ${agentTaskDisplayName(agent, language)}` : `Open agent ${agentTaskDisplayName(agent, language)}`}
          title={`${agent.path}\n${agent.task.task}`} onClick={() => onOpenTask(agent)}>
          <AgentTaskIdentity agent={agent} size={28} showStatus />
          <span className="agent-task-row-body">
            <strong>{agentTaskDisplayName(agent, language)}</strong>
            <span className="agent-task-row-activity" title={agentTaskActivity(agent, language)}>{agentTaskActivity(agent, language)}</span>
          </span>
          <span className="agent-task-row-meta"><AgentTaskElapsed agent={agent} language={language} /><span>{agentTaskLabels[language][agent.status.state]}</span></span>
          <SvgIcon name="chevronRight" size={13} />
        </button>
        {agent.persistenceError && <p className="agent-task-error" role="alert">{agent.persistenceError}</p>}
      </li>)}
    </ul>
    {!agents.length && !error && <p className="agent-task-panel-empty">{cn ? "当前对话还没有子任务" : "No agents in this conversation yet"}</p>}
  </div>;
}
