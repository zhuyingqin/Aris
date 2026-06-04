// TypeScript mirrors of the JSON shapes emitted by crates/tools.
// Source of truth: crates/tools/src/workflow_state.rs + team_state.rs.

export type WorkflowRunStatus =
  | "approval_required"
  | "running"
  | "paused"
  | "stopped"
  | "completed"
  | "failed";

export type WorkflowPhaseStatus =
  | "pending"
  | "running"
  | "waiting"
  | "completed"
  | "failed";

export type WorkflowApproval = "allow_once" | "always" | "deny";

export type WorkflowControlAction = "pause" | "resume" | "stop" | "restart";

export interface WorkflowPhase {
  phaseId: string;
  name: string;
  status: WorkflowPhaseStatus;
  agentIds: string[];
}

export interface WorkflowAgentRun {
  agentId: string;
  name: string;
  description: string;
  status: string;
}

export interface WorkflowCacheEntry {
  key: string;
  value: string;
  createdAt: number;
}

export interface WorkflowRun {
  version: number;
  runId: string;
  name: string;
  leadSession: string;
  status: WorkflowRunStatus;
  scriptPath: string;
  savedScriptPath?: string | null;
  maxConcurrency: number;
  maxAgents: number;
  phases: WorkflowPhase[];
  agents: WorkflowAgentRun[];
  result?: string | null;
  completedCache: WorkflowCacheEntry[];
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowAgentSpec {
  description: string;
  prompt: string;
  subagentType?: string | null;
  name?: string | null;
  model?: string | null;
}

export interface WorkflowPlan {
  phases: string[];
  agents: WorkflowAgentSpec[];
  waits: number;
  finalResult?: string | null;
  rawScript: string;
}

export interface SavedWorkflow {
  name: string;
  path: string;
  scope: string;
}

export interface WorkflowOutput {
  stateDir: string;
  action: string;
  run?: WorkflowRun | null;
  runs: WorkflowRun[];
  plan?: WorkflowPlan | null;
  savedWorkflows: SavedWorkflow[];
  message?: string | null;
}

// ── Team / Agents ────────────────────────────────────────────────────────────

export interface RunEvent {
  version: number;
  eventId: string;
  ts: number;
  kind: string;
  teamId?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
  taskId?: string | null;
  messageId?: string | null;
  workflowRunId?: string | null;
  payload: unknown;
}

export interface MailboxMessage {
  messageId: string;
  teamId?: string;
  from: string;
  to: string;
  subject?: string | null;
  body: string;
  taskId?: string | null;
  status?: string;
  createdAt?: number;
}

export interface TeamTask {
  taskId: string;
  teamId?: string;
  title: string;
  body?: string;
  status?: string;
  claimedBy?: string | null;
  dependencies?: string[];
  result?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

export interface AgentManifestView {
  agentId: string;
  name: string;
  description: string;
  subagentType?: string | null;
  model?: string | null;
  status: string;
  outputFile: string;
  manifestFile: string;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  error?: string | null;
  usage?: unknown;
}

export interface TeamState {
  teamId?: string;
  name?: string;
  members?: unknown[];
  [key: string]: unknown;
}

export interface TeamSnapshot {
  stateDir: string;
  team: TeamState;
  tasks: TeamTask[];
  mailbox: MailboxMessage[];
  agents: AgentManifestView[];
  events: RunEvent[];
}

// ── Settings / Skills / Sessions (P1) ─────────────────────────────────────────

export interface ConfigView {
  configPath: string;
  executorProvider?: string | null;
  executorModel?: string | null;
  executorBaseUrl?: string | null;
  hasExecutorKey: boolean;
  executorKeyMasked?: string | null;
  reviewerProvider?: string | null;
  reviewerModel?: string | null;
  reviewerBaseUrl?: string | null;
  hasReviewerKey: boolean;
  reviewerKeyMasked?: string | null;
  language?: string | null;
}

export interface ConfigPatch {
  executorProvider?: string;
  executorModel?: string;
  executorBaseUrl?: string;
  executorApiKey?: string;
  reviewerProvider?: string;
  reviewerModel?: string;
  reviewerBaseUrl?: string;
  reviewerApiKey?: string;
  language?: string;
}

// tools::SkillMeta serializes with snake_case field names.
export interface SkillMeta {
  name: string;
  description?: string | null;
  argument_hint?: string | null;
  allowed_tools?: string | null;
  path: string;
}

export interface SessionSummary {
  id: string;
  messageCount: number;
  modifiedEpochSecs: number;
}

export type SessionBlock =
  | { kind: "text"; text: string }
  | { kind: "toolUse"; name: string; input: string }
  | { kind: "toolResult"; toolName: string; output: string; isError: boolean }
  | { kind: "thinking"; thinking: string };

export interface SessionMessage {
  role: "system" | "user" | "assistant" | "tool";
  blocks: SessionBlock[];
}

export interface SessionTranscript {
  id: string;
  messages: SessionMessage[];
}

// ── Chat engine (P2) ──────────────────────────────────────────────────────────

export interface ChatStatus {
  ready: boolean;
  model?: string | null;
  provider?: string | null;
  message?: string | null;
}

export interface ChatToolCall {
  id?: string;
  name: string;
  input: string;
  output?: string;
  isError?: boolean;
}

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
  tools: ChatToolCall[];
  streaming?: boolean;
}
