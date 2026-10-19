import { invoke, listen } from "./transport";
import type { ChatTurn } from "../types";

export interface AgentTaskCard {
  revision?: number;
  resumable?: boolean;
  persistenceError?: string | null;
  /** Unix milliseconds from durable events, for the latest execution only. */
  startedAt?: number | null;
  finishedAt?: number | null;
  sessionId: string;
  rootSessionId: string;
  path: string;
  projectId: string | null;
  status: { state: "pending_init" | "running" | "waiting" | "completed" | "errored" | "interrupted" | "shutdown"; message?: string | null };
  pendingMail: number;
  task: { reason: string; task: string; inputs: string; deliverable: string; stopCondition: string; model: string; connection: string; permission: string; workspace: string; maxIterations: number; maxSeconds: number };
  lastActivity: string | null;
  interruptionReason: string | null;
  sessionPath: string;
  evidencePath: string;
}

export interface AgentTaskEvent {
  seq: number;
  ts: number;
  kind: string;
  turnId?: string | null;
  toolName?: string | null;
  isError?: boolean | null;
  status?: string | null;
  reason?: string | null;
  model?: string | null;
}
export interface AgentTaskDetail {
  info?: AgentTaskCard;
  transcript: string;
  turns?: ChatTurn[];
  timeline?: AgentTaskEvent[];
}

/** `runtime::agent_trace` — who did what to whom, joined across the tree's logs. */
export type AgentInteractionKind = "spawn_agent" | "assign_task" | "send_message" | "agent_result" | "close_agent" | "review_request" | "review_verdict";
export interface AgentInteraction {
  id: string;
  kind: AgentInteractionKind;
  fromSessionId?: string | null;
  fromPath?: string | null;
  toSessionId?: string | null;
  toPath?: string | null;
  mailId?: string | null;
  sourceTurnId?: string | null;
  sourceToolUseId?: string | null;
  sourceActionId?: string | null;
  ts?: number | null;
  deliveredTurnId?: string | null;
  deliveredTs?: number | null;
  status?: string | null;
  toolChecks?: string[];
}
export interface AgentTraceToolCall { toolUseId?: string | null; toolName: string; startedTs?: number | null; finishedTs?: number | null; isError?: boolean | null }
export interface AgentTraceTurn { turnId: string; startedTs?: number | null; finishedTs?: number | null; status?: string | null; reason?: string | null; tools: AgentTraceToolCall[]; received: string[]; sent: string[] }
export interface AgentTraceNode { sessionId: string; path: string; parentSessionId?: string | null; role?: string | null; origin?: string | null; depth: number; closedReason?: string | null; turns: AgentTraceTurn[] }
export interface AgentTrace { rootSessionId: string; nodes: AgentTraceNode[]; edges: AgentInteraction[] }

export const chatAgentTrace = (sessionId: string, projectId?: string) => invoke<AgentTrace>("chat_agent_trace", { sessionId, projectId: projectId ?? null });
export const chatAgentList =(sessionId: string, projectId?: string) => invoke<AgentTaskCard[]>("chat_agent_list", { sessionId, projectId: projectId ?? null });
export const chatAgentDetail = (sessionId: string, projectId: string | undefined, childSessionId: string) => invoke<AgentTaskDetail>("chat_agent_detail", { sessionId, projectId: projectId ?? null, childSessionId });
export const chatAgentInterrupt = (sessionId: string, projectId: string | undefined, target: string) => invoke<void>("chat_agent_interrupt", { sessionId, projectId: projectId ?? null, target });
export const onChatAgents = (handler: (event: { sessionId: string; agents: AgentTaskCard[] }) => void) => listen<{ sessionId: string; agents: AgentTaskCard[] }>("chat-agents", event => handler(event.payload));
export const onChatAgentActivity = (handler: (event: { sessionId: string; childSessionId: string; activity: string; revision?: number }) => void) => listen<{ sessionId: string; childSessionId: string; activity: string; revision?: number }>("chat-agent-activity", event => handler(event.payload));
