import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  isLabPreviewMode,
  previewExecuteFile,
  previewFileTree,
  previewKernelspecs,
  previewKernelInfo,
  previewNotebookList,
  previewNotebookView,
  previewReadText,
  previewRunAll,
  previewRunsLibrary,
  previewVariables,
  previewWriteText,
} from "./labPreview";

/** True only inside the Tauri webview; false in a plain browser (vite preview). */
export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export const openExternalUrl = (url: string) => {
  if (isTauri()) return invoke<void>("open_external_url", { url });
  window.open(url, "_blank", "noopener,noreferrer");
  return Promise.resolve();
};
import type {
  ChatCommandResult,
  ChatModelOptions,
  ChatStatus,
  ConnectorActionResult,
  ConnectorPluginView,
  AppUpdateInfo,
  AppUpdateInstallResult,
  AppUpdateProgress,
  ConfigPatch,
  ConfigSecretKind,
  ConfigTestDetail,
  ConfigTestResult,
  ConfigView,
  DesktopCommandSpec,
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
  ScheduledTaskInput,
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
export const appUpdateCheck = async (): Promise<AppUpdateInfo> => {
  if (!isTauri()) return { available: false };
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  if (!update) return { available: false };
  return {
    available: true,
    currentVersion: update.currentVersion,
    version: update.version,
    date: update.date,
    body: update.body,
  };
};
export const appUpdateDownloadAndInstall = async (
  onProgress?: (progress: AppUpdateProgress) => void,
): Promise<AppUpdateInstallResult> => {
  if (!isTauri()) return { installed: false };
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  if (!update) return { installed: false };

  let downloadedBytes = 0;
  let contentLength: number | null = null;
  await update.downloadAndInstall((event) => {
    if (event.event === "Started") {
      downloadedBytes = 0;
      contentLength = event.data.contentLength ?? null;
      onProgress?.({
        stage: "started",
        downloadedBytes,
        contentLength,
        percent: null,
      });
    } else if (event.event === "Progress") {
      downloadedBytes += event.data.chunkLength;
      const percent = contentLength
        ? Math.min(100, Math.round((downloadedBytes / contentLength) * 100))
        : null;
      onProgress?.({
        stage: "progress",
        downloadedBytes,
        contentLength,
        percent,
      });
    } else {
      onProgress?.({
        stage: "finished",
        downloadedBytes,
        contentLength,
        percent: 100,
      });
    }
  });
  return { installed: true, version: update.version };
};
export const appRelaunch = async () => {
  if (!isTauri()) return;
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
};
export const scheduledTasksList = () =>
  invoke<ScheduledTask[]>("scheduled_tasks_list");
export const scheduledTaskCreate = (input: ScheduledTaskInput) =>
  invoke<ScheduledTask>("scheduled_task_create", { input });
export const scheduledTaskUpdate = (id: string, input: ScheduledTaskInput) =>
  invoke<ScheduledTask>("scheduled_task_update", { id, input });
export const scheduledTaskSetStatus = (id: string, status: "active" | "paused") =>
  invoke<ScheduledTask>("scheduled_task_set_status", { id, status });
export const scheduledTaskDelete = (id: string) =>
  invoke<void>("scheduled_task_delete", { id });
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

// ── Lab (Jupyter notebooks) ───────────────────────────────────────────────────

const preview = <T>(value: T): Promise<T> => Promise.resolve(value);
const noopUnlisten = () => undefined;

export const labListKernels = <T>() =>
  isLabPreviewMode() ? preview<T>([] as T) : invoke<T>("lab_list_kernels");
export const labListKernelspecs = <T>() =>
  isLabPreviewMode() ? preview<T>(previewKernelspecs() as T) : invoke<T>("lab_list_kernelspecs");
export const labSetKernelspec = <T>(
  notebookPath: string,
  name: string,
  displayName?: string,
  language?: string,
) =>
  isLabPreviewMode()
    ? preview<T>(previewNotebookView(notebookPath) as T)
    :
  invoke<T>("lab_set_kernelspec", {
    notebookPath,
    name,
    displayName: displayName ?? null,
    language: language ?? null,
  });
export const labListNotebooks = <T>() =>
  isLabPreviewMode() ? preview<T>(previewNotebookList() as T) : invoke<T>("lab_list_notebooks");
export const labLoadNotebook = <T>(notebookPath: string) =>
  isLabPreviewMode()
    ? preview<T>(previewNotebookView(notebookPath) as T)
    :
  invoke<T>("lab_load_notebook", { notebookPath });
export const labCreateNotebook = <T>(notebookPath: string) =>
  isLabPreviewMode()
    ? preview<T>(previewNotebookView(notebookPath) as T)
    :
  invoke<T>("lab_create_notebook", { notebookPath });
export const labSaveNotebook = <T>(notebookPath: string, notebook: unknown) =>
  isLabPreviewMode()
    ? preview<T>(previewNotebookView(notebookPath) as T)
    :
  invoke<T>("lab_save_notebook", { notebookPath, notebook });
export const labEditCell = <T>(
  notebookPath: string,
  action: "insert" | "replace" | "delete" | "move",
  opts: { cellIndex?: number; cellType?: string; source?: string; toIndex?: number } = {},
) =>
  isLabPreviewMode()
    ? preview<T>(previewNotebookView(notebookPath) as T)
    :
  invoke<T>("lab_edit_cell", {
    notebookPath,
    action,
    cellIndex: opts.cellIndex ?? null,
    cellType: opts.cellType ?? null,
    source: opts.source ?? null,
    toIndex: opts.toIndex ?? null,
  });
export const labStartKernel = <T>(notebookPath: string, kernel?: string) =>
  isLabPreviewMode()
    ? preview<T>(previewKernelInfo(notebookPath) as T)
    :
  invoke<T>("lab_start_kernel", { notebookPath, kernel: kernel ?? null });
export const labExecuteCell = <T>(
  notebookPath: string,
  opts: { cellIndex?: number; code?: string; timeoutSecs?: number; kernel?: string } = {},
) =>
  isLabPreviewMode()
    ? preview<T>({
      status: "ok",
      executionCount: 3,
      outputs: [{ output_type: "stream", name: "stdout", text: "Preview cell executed\n" }],
      cellIndex: opts.cellIndex ?? null,
      outline: previewNotebookView(notebookPath).outline,
    } as T)
    :
  invoke<T>("lab_execute_cell", {
    notebookPath,
    cellIndex: opts.cellIndex ?? null,
    code: opts.code ?? null,
    timeoutSecs: opts.timeoutSecs ?? null,
    kernel: opts.kernel ?? null,
  });
export const labShutdownKernel = (notebookPath: string) =>
  isLabPreviewMode() ? Promise.resolve() :
  invoke<void>("lab_shutdown_kernel", { notebookPath });
export const labInterruptKernel = (notebookPath: string) =>
  isLabPreviewMode() ? Promise.resolve() :
  invoke<void>("lab_interrupt_kernel", { notebookPath });
export const labStartFileKernel = <T>(filePath: string, kernel?: string) =>
  isLabPreviewMode()
    ? preview<T>(previewKernelInfo(`file:${filePath}`) as T)
    :
  invoke<T>("lab_start_file_kernel", { filePath, kernel: kernel ?? null });
export const labExecuteFile = <T>(
  filePath: string,
  opts: { code?: string; timeoutSecs?: number; kernel?: string } = {},
) =>
  isLabPreviewMode()
    ? preview<T>(previewExecuteFile(filePath, opts.code) as T)
    :
  invoke<T>("lab_execute_file", {
    filePath,
    code: opts.code ?? null,
    timeoutSecs: opts.timeoutSecs ?? null,
    kernel: opts.kernel ?? null,
  });
export const labInterruptFileKernel = (filePath: string) =>
  isLabPreviewMode() ? Promise.resolve() :
  invoke<void>("lab_interrupt_file_kernel", { filePath });
export const labShutdownFileKernel = (filePath: string) =>
  isLabPreviewMode() ? Promise.resolve() :
  invoke<void>("lab_shutdown_file_kernel", { filePath });
export const labInspectFileVars = <T>(filePath: string, kernel?: string) =>
  isLabPreviewMode() ? preview<T>(previewVariables() as T) :
  invoke<T>("lab_inspect_file_vars", { filePath, kernel: kernel ?? null });
export const labInspectVars = <T>(notebookPath: string, kernel?: string) =>
  isLabPreviewMode() ? preview<T>(previewVariables() as T) :
  invoke<T>("lab_inspect_vars", { notebookPath, kernel: kernel ?? null });
export const onLabCellOutput = <T>(handler: (event: T) => void) =>
  isLabPreviewMode() ? Promise.resolve(noopUnlisten) :
  listen<T>("lab-cell-output", (e) => handler(e.payload));
export const onLabFileOutput = <T>(handler: (event: T) => void) =>
  isLabPreviewMode() ? Promise.resolve(noopUnlisten) :
  listen<T>("lab-file-output", (e) => handler(e.payload));
export const labRunAll = <T>(
  notebookPath: string,
  opts: {
    parameters?: Record<string, unknown>;
    stopOnError?: boolean;
    timeoutSecs?: number;
    kernel?: string;
  } = {},
) =>
  isLabPreviewMode()
    ? preview<T>(previewRunAll(notebookPath) as T)
    :
  invoke<T>("lab_run_all", {
    notebookPath,
    parameters: opts.parameters ?? null,
    stopOnError: opts.stopOnError ?? null,
    timeoutSecs: opts.timeoutSecs ?? null,
    kernel: opts.kernel ?? null,
  });

// ── Experiment runs + sweeps ──────────────────────────────────────────────────
export const runsLoad = <T>() =>
  isLabPreviewMode() ? preview<T>(previewRunsLibrary() as T) : invoke<T>("runs_load");
export const runsSave = (runs: unknown) => invoke<void>("runs_save", { runs });
export const labRunSweep = <T>(spec: unknown) =>
  isLabPreviewMode()
    ? preview<T>({ sweepId: "preview-sweep", total: 1, runs: [{ id: "preview-run-1", seed: null, status: "ok" }] } as T)
    : invoke<T>("lab_run_sweep", { spec });
export const labExportSweepManifest = (spec: unknown) =>
  isLabPreviewMode()
    ? Promise.resolve("# preview experiment-queue manifest\njobs: []\n")
    :
  invoke<string>("lab_export_sweep_manifest", { spec });

// ── File browser ─────────────────────────────────────────────────────────────

export interface FileTreeEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export interface FileText {
  path: string;
  content: string;
  bytes: number;
}

export const fileListDir = (path?: string | null) =>
  isLabPreviewMode()
    ? preview<FileTreeEntry[]>(previewFileTree(path ?? null))
    :
  invoke<FileTreeEntry[]>("file_list_dir", { path: path ?? null });

export const fileReadText = (path: string) =>
  isLabPreviewMode()
    ? preview<FileText>(previewReadText(path))
    :
  invoke<FileText>("file_read_text", { path });

export const fileWriteText = (path: string, content: string) =>
  isLabPreviewMode()
    ? preview<FileText>(previewWriteText(path, content))
    :
  invoke<FileText>("file_write_text", { path, content });

export const fileSearch = (pattern: string, root?: string) =>
  isLabPreviewMode() ? preview<string[]>([]) :
  invoke<string[]>("file_search", { pattern, root: root ?? null });

export const fileRead = (path: string, limit?: number) =>
  isLabPreviewMode() ? preview<string>(previewReadText(path).content) :
  invoke<string>("file_read", { path, limit: limit ?? null });
export const fileOpen = (path: string) =>
  isLabPreviewMode() ? Promise.resolve() :
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
export const chatQuestionRespond = (toolUseId: string, answer: string) =>
  invoke<void>("chat_question_respond", { toolUseId, answer });
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
export interface ChatErrorEvent {
  sessionId: string;
  message: string;
}
export const onChatError = (handler: (event: ChatErrorEvent) => void) =>
  listen<ChatErrorEvent>("chat-error", (e) => handler(e.payload));
