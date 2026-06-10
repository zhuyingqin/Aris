import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** True only inside the Tauri webview; false in a plain browser (vite preview). */
export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
import type {
  ChatCommandResult,
  ChatStatus,
  ConfigPatch,
  ConfigTestResult,
  ConfigView,
  DesktopCommandSpec,
  ProjectView,
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
export const projectsGet = () => invoke<ProjectView>("projects_get");
export const projectAdd = (path: string) =>
  invoke<ProjectView>("project_add", { path });
export const projectSetCurrent = (id: string) =>
  invoke<ProjectView>("project_set_current", { id });
export const projectsReorder = (projectIds: string[]) =>
  invoke<ProjectView>("projects_reorder", { projectIds });

// ── Settings / Skills / Sessions (P1) ─────────────────────────────────────────

export const configGet = () => invoke<ConfigView>("config_get");
export const configSet = (patch: ConfigPatch) =>
  invoke<ConfigView>("config_set", { patch });
export const configTest = (patch: ConfigPatch) =>
  invoke<ConfigTestResult>("config_test", { patch });

export const skillsList = () => invoke<SkillMeta[]>("skills_list");
export const skillView = (name: string) =>
  invoke<string>("skill_view", { name });

export const sessionsList = () => invoke<SessionSummary[]>("sessions_list");
export const sessionGet = (id: string) =>
  invoke<SessionTranscript>("session_get", { id });
export const chatUiSessionsLoad = <T>() => invoke<T[]>("chat_ui_sessions_load");
export const chatUiSessionsSave = <T>(sessions: T[]) =>
  invoke<void>("chat_ui_sessions_save", { sessions });

// ── Literature library ────────────────────────────────────────────────────────

export const literatureLoad = <T>() => invoke<T>("literature_load");
export const literatureSave = <T>(library: T) =>
  invoke<void>("literature_save", { library });
export const literatureSearch = <T>(
  query: string,
  sources: string[],
  maxResults?: number,
) => invoke<T>("literature_search", { query, sources, maxResults: maxResults ?? null });
export const literatureDownloadPdf = <T>(url: string, fileName: string) =>
  invoke<T>("literature_download_pdf", { url, fileName });

// ── File browser ─────────────────────────────────────────────────────────────

export const fileSearch = (pattern: string, root?: string) =>
  invoke<string[]>("file_search", { pattern, root: root ?? null });

export const fileRead = (path: string, limit?: number) =>
  invoke<string>("file_read", { path, limit: limit ?? null });
export const projectChatStarters = () => invoke<string[]>("project_chat_starters");

// ── Chat engine (P2) ──────────────────────────────────────────────────────────

export const chatStatus = () => invoke<ChatStatus>("chat_status");
export const chatCommandSpecs = () =>
  invoke<DesktopCommandSpec[]>("chat_command_specs");
export const chatRunCommand = (sessionId: string, input: string) =>
  invoke<ChatCommandResult>("chat_run_command", { sessionId, input });

export interface ChatImageInput {
  name?: string;
  mimeType: string;
  data: string;
}

export interface ChatSendRequest {
  text: string;
  images?: ChatImageInput[];
}

export interface ChatContextMessage {
  role: "user" | "assistant";
  text: string;
  images?: ChatImageInput[];
}

export const chatSend = (sessionId: string, message: string | ChatSendRequest) => {
  const request = typeof message === "string" ? { text: message } : message;
  return invoke<string>("chat_send_rich", { sessionId, request });
};
export const chatReset = (sessionId: string) =>
  invoke<void>("chat_reset", { sessionId });
export const chatSetContext = (
  sessionId: string,
  messages: ChatContextMessage[],
) => invoke<void>("chat_set_context", { sessionId, messages });
export const chatDelete = (sessionId: string, projectId?: string) =>
  invoke<void>("chat_delete", { sessionId, projectId: projectId ?? null });
export const chatCancel = () => invoke<void>("chat_cancel");

export const onChatDelta = (handler: (text: string) => void) =>
  listen<string>("chat-delta", (e) => handler(e.payload));
export const onChatThinkingDelta = (handler: (thinking: string) => void) =>
  listen<string>("chat-thinking-delta", (e) => handler(e.payload));
export const onChatTool = (
  handler: (t: { id?: string; name: string; input: string }) => void,
) => listen<{ id?: string; name: string; input: string }>("chat-tool", (e) => handler(e.payload));
export const onChatToolResult = (
  handler: (t: { id?: string; name: string; output: string; isError: boolean }) => void,
) =>
  listen<{ id?: string; name: string; output: string; isError: boolean }>(
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
