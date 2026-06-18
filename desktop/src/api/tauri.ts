import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** True only inside the Tauri webview; false in a plain browser (vite preview). */
export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
import type {
  ChatCommandResult,
  ChatModelOptions,
  ChatStatus,
  ConnectorActionResult,
  ConnectorPluginView,
  ConfigPatch,
  ConfigSecretKind,
  ConfigTestDetail,
  ConfigTestResult,
  ConfigView,
  DesktopCommandSpec,
  ImBridgeActionResult,
  ImBridgePatch,
  ImBridgeSecretKind,
  ImBridgeTestResult,
  ImBridgeView,
  GenericMailAccountInput,
  GenericMailTestResult,
  MailAccount,
  MailAutoconfigResult,
  MailDraft,
  MailFolder,
  MailMessageFull,
  MailMessageList,
  MailModifyPatch,
  MailOauthConfigPatch,
  MailOauthConfigView,
  McpConfigView,
  McpStdioServerInput,
  McpTestResult,
  PermissionModeView,
  ProjectView,
  ScheduledTask,
  SessionSummary,
  SessionTranscript,
  SkillMeta,
} from "../types";

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
export const configSecretGet = (kind: ConfigSecretKind) =>
  invoke<string | null>("config_secret_get", { kind });
export const configSet = (patch: ConfigPatch) =>
  invoke<ConfigView>("config_set", { patch });
export const configTest = (patch: ConfigPatch) =>
  invoke<ConfigTestResult>("config_test", { patch });
export const providerTest = (input: { baseUrl: string; model?: string; apiKey?: string }) =>
  invoke<ConfigTestDetail>("provider_test", { input });
export const scheduledTasksList = () =>
  invoke<ScheduledTask[]>("scheduled_tasks_list");
export const imBridgeGet = () => invoke<ImBridgeView>("im_bridge_get");
export const imBridgeSecretGet = (kind: ImBridgeSecretKind) =>
  invoke<string | null>("im_bridge_secret_get", { kind });
export const imBridgeSet = (patch: ImBridgePatch) =>
  invoke<ImBridgeView>("im_bridge_set", { patch });
export const imBridgeTestQq = (patch: ImBridgePatch) =>
  invoke<ImBridgeTestResult>("im_bridge_test_qq", { patch });
export const imBridgeStart = () =>
  invoke<ImBridgeActionResult>("im_bridge_start");
export const imBridgeStop = () =>
  invoke<ImBridgeActionResult>("im_bridge_stop");
export const imBridgeLogs = () =>
  invoke<ImBridgeActionResult>("im_bridge_logs");
export const projectPermissionGet = () =>
  invoke<PermissionModeView>("project_permission_get");
export const projectPermissionSet = (mode: string) =>
  invoke<PermissionModeView>("project_permission_set", { mode });
export const mcpConfigGet = () => invoke<McpConfigView>("mcp_config_get");
export const mcpConfigSet = (servers: McpStdioServerInput[]) =>
  invoke<McpConfigView>("mcp_config_set", { servers });
export const mcpConfigTest = () => invoke<McpTestResult>("mcp_config_test");

// ── Codex-style connectors ───────────────────────────────────────────────────

export const connectorPluginsList = () =>
  invoke<ConnectorPluginView[]>("connector_plugins_list");
export const connectorConnect = (id: string) =>
  invoke<ConnectorActionResult>("connector_connect", { id });

// ── Mail (Gmail API + Microsoft Graph) ────────────────────────────────────────

export const mailAccountsGet = () => invoke<MailAccount[]>("mail_accounts_get");
export const mailOauthConfigGet = () =>
  invoke<MailOauthConfigView>("mail_oauth_config_get");
export const mailOauthConfigSet = (patch: MailOauthConfigPatch) =>
  invoke<MailOauthConfigView>("mail_oauth_config_set", { patch });
export const mailConnect = (provider: "gmail" | "outlook") =>
  invoke<MailAccount>("mail_connect", { provider });
export const mailAutoconfig = (email: string) =>
  invoke<MailAutoconfigResult>("mail_autoconfig", { email });
export const mailGenericTest = (input: GenericMailAccountInput) =>
  invoke<GenericMailTestResult>("mail_generic_test", { input });
export const mailGenericConnect = (input: GenericMailAccountInput) =>
  invoke<MailAccount>("mail_generic_connect", { input });
export const mailDisconnect = (accountId: string) =>
  invoke<MailAccount[]>("mail_disconnect", { accountId });
export const mailFolders = (accountId: string) =>
  invoke<MailFolder[]>("mail_folders", { accountId });
export const mailList = (
  accountId: string,
  folder: string,
  query: string,
  pageToken?: string | null,
) =>
  invoke<MailMessageList>("mail_list", {
    accountId,
    folder,
    query,
    pageToken: pageToken ?? null,
  });
export const mailRead = (accountId: string, messageId: string) =>
  invoke<MailMessageFull>("mail_read", { accountId, messageId });
export const mailModify = (
  accountId: string,
  messageId: string,
  patch: MailModifyPatch,
) => invoke<void>("mail_modify", { accountId, messageId, patch });
export const mailSend = (accountId: string, draft: MailDraft) =>
  invoke<void>("mail_send", { accountId, draft });

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
export const literatureLibraryUpsert = <T>(
  papers: unknown[],
  query: string,
  sources: string[],
) => invoke<T>("literature_library_upsert", { papers, query, sources });
export const literatureDownloadPdf = <T>(url: string, fileName: string) =>
  invoke<T>("literature_download_pdf", { url, fileName });
export const literatureImportPdf = <T>(sourcePath: string, fileName: string) =>
  invoke<T>("literature_import_pdf", { sourcePath, fileName });
export const literatureLlm = (system: string, prompt: string) =>
  invoke<string>("literature_llm", { system, prompt });
export const literatureReviewLlm = (system: string, prompt: string) =>
  invoke<string>("literature_review_llm", { system, prompt });
export interface LiteratureVisionImage {
  page: number;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  data: string;
  fingerprint: string;
}
export const literatureLlmVision = (
  system: string,
  prompt: string,
  images: LiteratureVisionImage[],
) => invoke<string>("literature_llm_vision", { system, prompt, images });
export const literaturePdfText = (relativePath: string) =>
  invoke<{
    text: string;
    pages: Array<{ page: number; text: string; source: "embedded" | "ocr" | "empty" }>;
    totalCharacters: number;
    extractedCharacters: number;
    truncated: boolean;
    ocrUsed: boolean;
    missingPages: number[];
    warnings: string[];
  }>(
    "literature_pdf_text",
    { relativePath },
  );
export const literaturePdfBytes = (relativePath: string) =>
  invoke<number[]>("literature_pdf_bytes", { relativePath });
export const literatureImageOcr = (image: number[]) =>
  invoke<string>("literature_image_ocr", { image });
export const literaturePdfOpen = (relativePath: string) =>
  invoke<void>("literature_pdf_open", { relativePath });

// ── Studio artifacts ──────────────────────────────────────────────────────────

export const studioLoad = <T>() => invoke<T>("studio_load");
export const studioSave = <T>(library: T) =>
  invoke<void>("studio_save", { library });
export const studioHtml = (relativePath: string) =>
  invoke<string>("studio_html", { relativePath });

// ── Knowledge base ────────────────────────────────────────────────────────────

export const knowledgeLoad = <T>() => invoke<T>("knowledge_load");
export const knowledgeSearch = <T>(query: string, limit?: number) =>
  invoke<T>("knowledge_search", { query, limit: limit ?? null });
export const knowledgeUpsert = <T>(points: unknown[]) =>
  invoke<T>("knowledge_upsert", { points });
export const knowledgeConfirm = (kpId: string) =>
  invoke<void>("knowledge_confirm", { kpId });
export const knowledgeReject = (kpId: string) =>
  invoke<boolean>("knowledge_reject", { kpId });
export const knowledgeGenerate = <T>(paperId: string) =>
  invoke<T>("knowledge_generate", { paperId });

// ── File browser ─────────────────────────────────────────────────────────────

export const fileSearch = (pattern: string, root?: string) =>
  invoke<string[]>("file_search", { pattern, root: root ?? null });

export const fileRead = (path: string, limit?: number) =>
  invoke<string>("file_read", { path, limit: limit ?? null });
export const fileOpen = (path: string) =>
  invoke<void>("file_open", { path });
export const projectChatStarters = () => invoke<string[]>("project_chat_starters");

// ── Chat engine (P2) ──────────────────────────────────────────────────────────

export const chatStatus = () => invoke<ChatStatus>("chat_status");
export const chatModelOptions = () =>
  invoke<ChatModelOptions>("chat_model_options");
export const chatModelSet = (model: string, persist = true) =>
  invoke<ChatStatus>("chat_model_set", { model, persist });
export const chatPermissionGet = (sessionId: string) =>
  invoke<PermissionModeView>("chat_permission_get", { sessionId });
export const chatPermissionSet = (sessionId: string, mode: string) =>
  invoke<PermissionModeView>("chat_permission_set", { sessionId, mode });
export const chatPermissionRespond = (promptId: string, allow: boolean) =>
  invoke<void>("chat_permission_respond", { promptId, allow });
export const chatCommandSpecs = () =>
  invoke<DesktopCommandSpec[]>("chat_command_specs");
export const chatRunCommand = (sessionId: string, input: string) =>
  invoke<ChatCommandResult>("chat_run_command", { sessionId, input });
export const chatSuggestTitle = (user: string, assistant: string) =>
  invoke<string>("chat_suggest_title", { user, assistant });

export interface ChatImageInput {
  name?: string;
  mimeType: string;
  data: string;
}

export interface ChatSendRequest {
  text: string;
  images?: ChatImageInput[];
  model?: string | null;
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

/** Like chatSend but with bash allowed — used by Literature agent searches so
 *  /research-lit can run Python paper-fetching helpers (arxiv, openalex, etc.). */
export const literatureAgentSend = (sessionId: string, message: string | ChatSendRequest) => {
  const request = typeof message === "string" ? { text: message } : message;
  return invoke<string>("literature_agent_send_rich", { sessionId, request });
};
export const studioAgentSend = (sessionId: string, message: string | ChatSendRequest) => {
  const request = typeof message === "string" ? { text: message } : message;
  return invoke<string>("studio_agent_send_rich", { sessionId, request });
};
export const chatReset = (sessionId: string) =>
  invoke<void>("chat_reset", { sessionId });
export const chatSetContext = (
  sessionId: string,
  messages: ChatContextMessage[],
) => invoke<void>("chat_set_context", { sessionId, messages });
export const chatDelete = (sessionId: string, projectId?: string) =>
  invoke<void>("chat_delete", { sessionId, projectId: projectId ?? null });
export const chatCancel = (sessionId: string) => invoke<void>("chat_cancel", { sessionId });

export interface ChatTextEvent {
  sessionId: string;
  text: string;
}

export interface ChatThinkingEvent {
  sessionId: string;
  thinking: string;
}

export interface ChatPermissionRequestEvent {
  sessionId: string;
  promptId: string;
  toolName: string;
  input: string;
  currentMode: string;
  requiredMode: string;
}

export interface ChatPermissionResolvedEvent {
  sessionId: string;
  promptId: string;
  decision: "allow" | "deny";
}

export const onChatDelta = (handler: (event: ChatTextEvent) => void) =>
  listen<ChatTextEvent>("chat-delta", (e) => handler(e.payload));
export const onChatThinkingDelta = (handler: (event: ChatThinkingEvent) => void) =>
  listen<ChatThinkingEvent>("chat-thinking-delta", (e) => handler(e.payload));
export const onChatTool = (
  handler: (t: { sessionId: string; id?: string; name: string; input: string }) => void,
) => listen<{ sessionId: string; id?: string; name: string; input: string }>("chat-tool", (e) => handler(e.payload));
export const onChatToolResult = (
  handler: (t: { sessionId: string; id?: string; name: string; output: string; isError: boolean }) => void,
) =>
  listen<{ sessionId: string; id?: string; name: string; output: string; isError: boolean }>(
    "chat-tool-result",
    (e) => handler(e.payload),
  );
export const onChatPermissionRequest = (handler: (event: ChatPermissionRequestEvent) => void) =>
  listen<ChatPermissionRequestEvent>("chat-permission-request", (e) => handler(e.payload));
export const onChatPermissionResolved = (handler: (event: ChatPermissionResolvedEvent) => void) =>
  listen<ChatPermissionResolvedEvent>("chat-permission-resolved", (e) => handler(e.payload));
export const onChatDone = (handler: (event: ChatTextEvent) => void) =>
  listen<ChatTextEvent>("chat-done", (e) => handler(e.payload));
