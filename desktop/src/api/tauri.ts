import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** True only inside the Tauri webview; false in a plain browser (vite preview). */
export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
import type {
  ChatStatus,
  ConfigPatch,
  ConfigView,
  RunEvent,
  SessionSummary,
  SessionTranscript,
  SkillMeta,
  TeamSnapshot,
  WorkflowApproval,
  WorkflowControlAction,
  WorkflowOutput,
} from "../types";

// ── Workflow commands ─────────────────────────────────────────────────────────

export const workflowPlan = (script: string) =>
  invoke<WorkflowOutput>("workflow_plan", { script });

export const workflowList = () => invoke<WorkflowOutput>("workflow_list");

export const workflowInspect = (id: string) =>
  invoke<WorkflowOutput>("workflow_inspect", { id });

export interface StartReq {
  script: string;
  approval: WorkflowApproval;
  name?: string;
  saveAs?: string;
  maxConcurrency?: number;
  maxAgents?: number;
}

export const workflowStart = (req: StartReq) =>
  invoke<WorkflowOutput>("workflow_start", { req });

export const workflowControl = (id: string, action: WorkflowControlAction) =>
  invoke<WorkflowOutput>("workflow_control", { id, action });

export const workflowSave = (name: string, script: string) =>
  invoke<WorkflowOutput>("workflow_save", { name, script });

export const workflowDiscover = () =>
  invoke<WorkflowOutput>("workflow_discover");

// ── Team / agent commands ─────────────────────────────────────────────────────

export const teamList = (
  team: string | null,
  messages: boolean,
  events: boolean,
) => invoke<TeamSnapshot>("team_list", { team, messages, events });

export const agentSupervisor = (action: string, agent?: string) =>
  invoke<unknown>("agent_supervisor", { action, agent: agent ?? null });

export const stateDir = () => invoke<string>("state_dir");

// ── Settings / Skills / Sessions (P1) ─────────────────────────────────────────

export const configGet = () => invoke<ConfigView>("config_get");
export const configSet = (patch: ConfigPatch) =>
  invoke<ConfigView>("config_set", { patch });

export const skillsList = () => invoke<SkillMeta[]>("skills_list");
export const skillView = (name: string) =>
  invoke<string>("skill_view", { name });

export const sessionsList = () => invoke<SessionSummary[]>("sessions_list");
export const sessionGet = (id: string) =>
  invoke<SessionTranscript>("session_get", { id });

// ── File browser ─────────────────────────────────────────────────────────────

export const fileSearch = (pattern: string, root?: string) =>
  invoke<string[]>("file_search", { pattern, root: root ?? null });

export const fileRead = (path: string, limit?: number) =>
  invoke<string>("file_read", { path, limit: limit ?? null });

// ── Chat engine (P2) ──────────────────────────────────────────────────────────

export const chatStatus = () => invoke<ChatStatus>("chat_status");
export const chatSend = (message: string) =>
  invoke<string>("chat_send", { message });
export const chatReset = () => invoke<void>("chat_reset");
export const chatCancel = () => invoke<void>("chat_cancel");

export const onChatDelta = (handler: (text: string) => void) =>
  listen<string>("chat-delta", (e) => handler(e.payload));
export const onChatThinkingDelta = (handler: (thinking: string) => void) =>
  listen<string>("chat-thinking-delta", (e) => handler(e.payload));
export const onChatTool = (
  handler: (t: { id?: string; name: string; input: string }) => void,
) => listen<{ id?: string; name: string; input: string }>("chat-tool", (e) => handler(e.payload));
export const onChatToolResult = (
  handler: (t: { name: string; output: string; isError: boolean }) => void,
) =>
  listen<{ name: string; output: string; isError: boolean }>(
    "chat-tool-result",
    (e) => handler(e.payload),
  );
export const onChatDone = (handler: (text: string) => void) =>
  listen<string>("chat-done", (e) => handler(e.payload));

// ── Live events ───────────────────────────────────────────────────────────────

export const onRunEvent = (
  handler: (event: RunEvent) => void,
): Promise<UnlistenFn> =>
  listen<RunEvent>("run-event", (e) => handler(e.payload));
