import type { Language } from "../store";
import { Fragment, createContext, useContext, type ReactNode } from "react";
import type { AgentTaskCard } from "../api/agentTasks";
import type { ChatBlock } from "../types";
import { SvgIcon } from "../SvgIcon";
import { tr } from "../language";
import { AgentTaskIdentity, agentTaskDisplayName } from "./agentTaskPresentation";
import "./AgentTaskCards.css";

export const AgentTaskNavigation = createContext<{
  rootSessionId: string;
  agents: AgentTaskCard[];
  language: Language;
  onOpenList: () => void;
  onOpenTask: (agent: AgentTaskCard) => void;
} | null>(null);

type ToolBlock = Extract<ChatBlock, { kind: "tool" }>;
export function isAgentSpawn(block: ChatBlock): boolean {
  return block.kind === "tool" && (block.name === "spawn_agent" || block.name === "Agent");
}

/** A durable successful tool result is the only source of a launch link. */
export function AgentSpawnNotice({ blocks, fallbacks }: { blocks: ToolBlock[]; fallbacks: ReactNode[] }) {
  const navigation = useContext(AgentTaskNavigation);
  if (!navigation) return <>{fallbacks}</>;
  const t = (cn: string, en: string, es: string) => tr(navigation.language, cn, en, es);
  const nodes: ReactNode[] = [];
  let linked: AgentTaskCard[] = [];
  const flush = () => {
    if (!linked.length) return;
    const agents = linked;
    linked = [];
    nodes.push(<div key={`notice-${nodes.length}`} className="agent-spawn-notice" role="group" aria-label={t("已委派子任务", "Delegated agents", "Agentes delegados")}>
      <button type="button" className="agent-spawn-group" onClick={navigation.onOpenList} aria-label={t("查看子智能体", "View agents", "Ver agentes")}>
        {agents.map(agent => <AgentTaskIdentity key={agent.sessionId} agent={agent} size={20} />)}
      </button>
      <span className="agent-spawn-names">{agents.map((agent, index) => <Fragment key={agent.sessionId}>
        {index > 0 && <span aria-hidden="true">/</span>}
        <button type="button" onClick={() => navigation.onOpenTask(agent)} title={agent.task.task}>{agentTaskDisplayName(agent, navigation.language)}</button>
      </Fragment>)}</span>
      <span>{t("已委派", "delegated", agents.length === 1 ? "delegado" : "delegados")}</span>
      <button type="button" className="agent-spawn-more" onClick={navigation.onOpenList} aria-label={t("查看全部子任务", "View all agents", "Ver todos los agentes")}><SvgIcon name="chevronRight" size={12} /></button>
    </div>);
  };
  blocks.forEach((block, index) => {
    let agent: AgentTaskCard | undefined;
    if (!block.isError && block.output) {
      try {
        const result: unknown = JSON.parse(block.output);
        const sessionId = result && typeof result === "object" && "sessionId" in result ? result.sessionId : undefined;
        agent = navigation.agents.find(item => item.sessionId === sessionId && item.rootSessionId === navigation.rootSessionId);
      } catch { /* Older, incomplete, or failed outputs keep the ordinary tool view. */ }
    }
    if (agent) {
      if (!linked.some(item => item.sessionId === agent!.sessionId)) linked.push(agent);
    } else {
      flush();
      nodes.push(<Fragment key={`fallback-${index}`}>{fallbacks[index]}</Fragment>);
    }
  });
  flush();
  return <>{nodes}</>;
}
