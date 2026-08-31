// Routed through the transport switch so the same calls can target the packaged
// app or `aris-devserver` from a plain browser. See `transport.ts`.
import { convertFileSrc } from "@tauri-apps/api/core";
import { hasNativeBackend, invoke, listen } from "./transport";
import type { PendingChatHandoff } from "../store";
import type { ChatTodoItem } from "../types";
import {
  isFilePreviewMode,
  previewCreateDir,
  previewDeletePath,
  previewDuplicatePath,
  previewFileTree,
  previewListTypesetDocuments,
  previewRenamePath,
  previewReadBytes,
  previewReadText,
  previewSearchFiles,
  previewWriteText,
} from "./browserPreview";

/** True only inside the Tauri webview; false in a plain browser (vite preview). */
export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Open or focus the single always-on-top writing companion Chat window.
 * A structured handoff is delivered to that window instead of switching the
 * primary workspace away from its current surface. */
export const openChatCompanion = (handoff?: PendingChatHandoff) => invoke<void>("open_chat_companion", {
  handoff: handoff ?? null,
});

/** Consume the handoff saved while a newly-created companion window loads. */
export const takeChatCompanionHandoff = () => invoke<PendingChatHandoff | null>("take_chat_companion_handoff");

/** Receive a new handoff when an already-open companion window is focused. */
export const onChatCompanionHandoff = (handler: (handoff: PendingChatHandoff) => void) =>
  listen<PendingChatHandoff>("chat-companion-handoff", (event) => handler(event.payload));

const PREVIEW_LOCAL_ENVIRONMENT_CHECKS: LocalEnvironmentCheck[] = [
  {
    id: "python",
    label: "Python",
    category: "Runtime",
    status: "ready",
    available: true,
    version: "Python 3.12",
    path: "python",
    message: "Python is available in the browser preview sample.",
  },
  {
    id: "jupyter",
    label: "Jupyter",
    category: "Notebook",
    status: "missing",
    available: false,
    version: null,
    path: null,
    message: "Jupyter is not installed in this preview sample.",
  },
  {
    id: "matlab",
    label: "MATLAB",
    category: "Numerical computing",
    status: "warning",
    available: false,
    version: null,
    path: null,
    message: "MATLAB was not detected in this preview sample.",
  },
  {
    id: "latex",
    label: "LaTeX",
    category: "Typesetting",
    status: "missing",
    available: false,
    version: null,
    path: null,
    message: "A system LaTeX toolchain was not detected in this preview sample.",
  },
];

export const openExternalUrl = (url: string) => {
  if (isTauri()) return invoke<void>("open_external_url", { url });
  window.open(url, "_blank", "noopener,noreferrer");
  return Promise.resolve();
};
import type {
  ChatCommandResult,
  ChatEventLogEntry,
  ChatEventsReplay,
  ChatModelOptions,
  ChatReasoningEffortView,
  CodeActiveEditor,
  CodeBridgeAsk,
  CodeServerStatus,
  ChatToolProgress,
  ChatStatus,
  AppUpdateInfo,
  AppUpdateInstallResult,
  AppUpdateProgress,
  BuiltinToolAvailability,
  ConfigPatch,
  ConfigSecretKind,
  ConfigTestDetail,
  ConfigTestResult,
  ConfigView,
  ComputeJobEvent,
  ComputeJobRecord,
  ComputeLogStream,
  ComputeNodeCapabilities,
  ComputeNodeConfig,
  ComputePairingClaim,
  ComputePeer,
  ComputePeerEvent,
  ComputeSubmitInput,
  RemoteAgentModelSelection,
  RemoteAgentSession,
  RemoteAgentSessions,
  RemoteAgentTranscript,
  RemoteAgentWorkspace,
  DesktopCommandSpec,
  GenericMailAccountInput,
  GenericMailTestResult,
  LocalEnvironmentCheck,
  MailAccount,
  MailAutoconfigResult,
  MailDraft,
  MailFolder,
  MailMessageFull,
  MailMessageList,
  MailNewMessageEvent,
  MailModifyPatch,
  MemoryGovernanceHit,
  MemoryDeadLetterView,
  MemoryExplorerSnapshot,
  MemoryMigrationPreview,
  MemoryMigrationProgress,
  MemoryMigrationResult,
  MemoryStatusView,
  McpConfigView,
  McpStdioServerInput,
  McpTestResult,
  OracleWebAccountModelSetInput,
  OracleWebAccountView,
  OracleWebAccountCreateInput,
  OracleWebLoginLaunchView,
  OracleWebRoleSetInput,
  OracleWebStatusView,
  PermissionModeView,
  ProfileStats,
  ProjectView,
  RemoteInvitationResult,
  RemoteControlStatus,
  RemoteDevice,
  RemotePairingApprovalInput,
  RemotePendingPairing,
  RemoteP2pAnswerInput,
  RemoteP2pDataInput,
  RemoteP2pFailureInput,
  RemoteP2pIceCandidateInput,
  RemoteP2pOfferInput,
  RemoteP2pPendingSnapshot,
  RemoteP2pSessionInput,
  ScheduledTask,
  ScheduledTaskInput,
  SessionSummary,
  SkillMeta,
  SystemPromptView,
  UserPromptView,
} from "../types";

export const stateDir = () => invoke<string>("state_dir");
export const localEnvironmentChecks = (forceRefresh?: boolean) =>
  !isTauri()
    ? Promise.resolve(PREVIEW_LOCAL_ENVIRONMENT_CHECKS.map((item) => ({ ...item })))
    : invoke<LocalEnvironmentCheck[]>("local_environment_checks", { forceRefresh: forceRefresh ?? false });
export const localEnvironmentCheck = (id: string) =>
  !isTauri()
    ? Promise.resolve({ ...(PREVIEW_LOCAL_ENVIRONMENT_CHECKS.find((item) => item.id === id) ?? PREVIEW_LOCAL_ENVIRONMENT_CHECKS[0]) })
    : invoke<LocalEnvironmentCheck>("local_environment_check", { id });
export const chatBuiltinToolAvailability = () =>
  !isTauri()
    ? Promise.resolve([] as BuiltinToolAvailability[])
    : invoke<BuiltinToolAvailability[]>("chat_builtin_tool_availability");
export const chatResearchProviderAvailability = () =>
  !isTauri()
    ? Promise.resolve([] as BuiltinToolAvailability[])
    : invoke<BuiltinToolAvailability[]>("chat_research_provider_availability");
/** A shell process the agent left running: either a `run_in_background`
 * command or a service a shell forked with `&` that the registry adopted. */
export interface BackgroundProcessView {
  pid: number;
  label: string;
  elapsedMs: number;
  /** Capture file for its stdout/stderr; absent for adopted `&` survivors. */
  logPath?: string | null;
}

export const backgroundProcessesList = () =>
  !isTauri()
    ? Promise.resolve([] as BackgroundProcessView[])
    : invoke<BackgroundProcessView[]>("background_processes_list");

/** Stop one background process and everything it started; resolves with the
 * refreshed list. */
export const backgroundProcessStop = (pid: number) =>
  !isTauri()
    ? Promise.resolve([] as BackgroundProcessView[])
    : invoke<BackgroundProcessView[]>("background_process_stop", { pid });

export const projectsGet = () => invoke<ProjectView>("projects_get");
export const projectAdd = (path: string) =>
  invoke<ProjectView>("project_add", { path });
export const projectSetCurrent = (id: string) =>
  invoke<ProjectView>("project_set_current", { id });
export const projectRemove = (id: string) =>
  invoke<ProjectView>("project_remove", { id });

export interface GitFileChange {
  path: string;
  oldPath?: string | null;
  indexStatus?: string | null;
  worktreeStatus?: string | null;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
  additions?: number;
  deletions?: number;
}

export interface GitBranch {
  name: string;
  current: boolean;
}

export interface GitWorkspaceSnapshot {
  gitAvailable: boolean;
  gitVersion?: string | null;
  isRepository: boolean;
  workspacePath: string;
  repositoryRoot?: string | null;
  branch?: string | null;
  detached: boolean;
  upstream?: string | null;
  ahead: number;
  behind: number;
  files: GitFileChange[];
  branches: GitBranch[];
  hasConflicts: boolean;
}

export interface GitDiffView {
  path: string;
  staged: boolean;
  content: string;
  truncated: boolean;
}

export interface LocalReviewFileChange {
  changeId: string;
  path: string;
  operation: "create" | "update" | "append" | "delete" | "rename" | "revert" | string;
  status: "applied" | "reverted" | "conflict" | string;
  toolName: string;
  timestamp: string;
  beforeExists: boolean;
  afterExists: boolean;
  additions: number;
  deletions: number;
  unifiedDiff: string;
  truncated: boolean;
  reversible: boolean;
}

export interface LocalReviewSnapshot {
  workspacePath: string;
  ledgerRoot: string;
  files: LocalReviewFileChange[];
  recordCount: number;
}

export const gitStatus = () => invoke<GitWorkspaceSnapshot>("git_status");
export const gitInitialize = () => invoke<GitWorkspaceSnapshot>("git_initialize");
export const gitStage = (paths: string[]) =>
  invoke<GitWorkspaceSnapshot>("git_stage", { paths });
export const gitUnstage = (paths: string[]) =>
  invoke<GitWorkspaceSnapshot>("git_unstage", { paths });
export const gitCommit = (message: string) =>
  invoke<GitWorkspaceSnapshot>("git_commit", { message });
export const gitBranchCreate = (name: string) =>
  invoke<GitWorkspaceSnapshot>("git_branch_create", { name });
export const gitBranchSwitch = (name: string) =>
  invoke<GitWorkspaceSnapshot>("git_branch_switch", { name });
export const gitDiff = (path: string, staged: boolean) =>
  invoke<GitDiffView>("git_diff", { path, staged });
export const localReviewStatus = () =>
  invoke<LocalReviewSnapshot>("local_review_status");
export const projectsReorder = (projectIds: string[]) =>
  invoke<ProjectView>("projects_reorder", { projectIds });

// Durable compute jobs. Chat, Code, and automation callers all use this same
// API; transport selection is a job target, not a separate execution model.
export const computeNodeConfigGet = () =>
  invoke<ComputeNodeConfig>("compute_node_config_get");
export const computeNodeConfigSet = (
  acceptRemoteJobs: boolean,
  acceptRemoteAgentChats: boolean,
  maxParallelJobs: number,
  // Omitted means unchanged rather than off, so a caller that does not manage
  // the brokered-image switches cannot silently disable them.
  acceptImageHelp?: boolean,
  imageHelpDailyLimit?: number,
  preferImageHelp?: boolean,
) => invoke<ComputeNodeConfig>("compute_node_config_set", {
  acceptRemoteJobs,
  acceptRemoteAgentChats,
  maxParallelJobs,
  acceptImageHelp,
  imageHelpDailyLimit,
  preferImageHelp,
});
export const imageAssistPublish = (
  displayName?: string,
  location?: { label: string; latitude: number; longitude: number },
) => invoke<boolean>("image_assist_publish", { displayName, location });
export const imageAssistRoster = () => invoke<void>("image_assist_roster");
export const imageAssistDecide = (matchId: string, accept: boolean) =>
  invoke<void>("image_assist_decide", { matchId, accept });
export const imageAssistConsent = (consentId: string, approve: boolean) =>
  invoke<void>("image_assist_consent", { consentId, approve });
export const computePeersList = () =>
  invoke<ComputePeer[]>("compute_peers_list");
export const computePeerConnect = (nodeId: string) =>
  invoke<void>("compute_peer_connect", { nodeId });
export const computePairingClaim = (pairingLink: string) =>
  invoke<ComputePairingClaim>("compute_pairing_claim", {
    input: { pairingLink },
  });
export const computePairingComplete = (pairingId: string) =>
  invoke<ComputePairingClaim>("compute_pairing_complete", { pairingId });
export const computePeerRevoke = (nodeId: string) =>
  invoke<void>("compute_peer_revoke", { nodeId });
export const computeCapabilities = () =>
  invoke<ComputeNodeCapabilities>("compute_capabilities");
export const computeJobsList = () =>
  invoke<ComputeJobRecord[]>("compute_jobs_list");
export const computeEventsAfter = (jobId: string, afterSequence = 0) =>
  invoke<ComputeJobEvent[]>("compute_events_after", {
    input: { jobId, afterSequence },
  });
export const computeReadLog = (
  jobId: string,
  stream: ComputeLogStream,
  offset = 0,
  maxBytes?: number,
) => invoke<{ text: string; nextOffset: number }>("compute_read_log", {
  input: { jobId, stream, offset, maxBytes: maxBytes ?? null },
});
export const computeSubmit = (input: ComputeSubmitInput) =>
  invoke<ComputeJobRecord>("compute_submit", { input });
export const computeCancel = (jobId: string) =>
  invoke<ComputeJobRecord>("compute_cancel", { jobId });
export const onComputeJobEvent = (handler: (event: ComputeJobEvent) => void) =>
  listen<ComputeJobEvent>("compute-job-event", (event) => handler(event.payload));
export const onComputePeerEvent = (handler: (event: ComputePeerEvent) => void) =>
  listen<ComputePeerEvent>("compute-peer-event", (event) => handler(event.payload));
export const remoteAgentWorkspace = (nodeId: string) =>
  invoke<RemoteAgentWorkspace>("remote_agent_workspace", { nodeId });
export const remoteAgentSessionCreate = (
  nodeId: string,
  projectId: string,
  projectName: string,
) => invoke<RemoteAgentSession>("remote_agent_session_create", {
  input: { nodeId, projectId, projectName },
});
export const remoteAgentSessions = (
  nodeId: string,
  projectId: string,
  projectName: string,
) => invoke<RemoteAgentSessions>("remote_agent_sessions", {
  input: { nodeId, projectId, projectName },
});
export const remoteAgentSessionOpen = (
  nodeId: string,
  projectId: string,
  projectName: string,
  sessionId: string,
) => invoke<RemoteAgentTranscript>("remote_agent_session_open", {
  input: { nodeId, projectId, projectName, sessionId },
});
export const remoteAgentModelOptions = (
  nodeId: string,
  projectId: string,
  sessionId: string,
) => invoke<RemoteAgentModelSelection>("remote_agent_model_options", {
  input: { nodeId, projectId, projectName: "", sessionId },
});
export const remoteAgentModelSet = (
  nodeId: string,
  projectId: string,
  sessionId: string,
  model: string,
) => invoke<RemoteAgentModelSelection>("remote_agent_model_set", {
  input: { nodeId, projectId, sessionId, model },
});
export const remoteAgentChatSend = (input: {
  nodeId: string;
  localSessionId: string;
  projectId: string;
  remoteSessionId: string;
  message: string;
}) => invoke<string>("remote_agent_chat_send", { input });
export const remoteAgentChatCancel = (localSessionId: string) =>
  invoke<void>("remote_agent_chat_cancel", { localSessionId });

// Remote control (P0/P1). These commands configure the desktop-side agent;
// the network transport itself never becomes a frontend-invokable API.
export const remoteControlStatus = () => invoke<RemoteControlStatus>("remote_control_status");
export const remoteControlCreateInvitation = () =>
  invoke<RemoteInvitationResult>("remote_control_create_invitation");
/** Destructive: discards every existing pairing. Only call after explicit consent. */
export const remoteControlResetIdentity = () =>
  invoke<RemoteInvitationResult>("remote_control_reset_identity");
/** Relabels this computer everywhere it appears, including the account's web list. */
export const remoteControlSetDeviceName = (deviceName: string) =>
  invoke<RemoteControlStatus>("remote_control_set_device_name", { deviceName });
export const remoteControlDisable = () => invoke<RemoteControlStatus>("remote_control_disable");
export const remoteControlDevices = () => invoke<RemoteDevice[]>("remote_control_devices");
export const remoteControlPendingPairing = (pairingId: string) =>
  invoke<RemotePendingPairing | null>("remote_control_pending_pairing", { pairingId });
export const remoteControlApprovePairing = (input: RemotePairingApprovalInput) =>
  invoke<RemoteDevice>("remote_control_approve_pairing", { input });
export const remoteControlDiscardPairing = (pairingId: string) =>
  invoke<void>("remote_control_discard_pairing", { pairingId });
export const remoteControlRevokeDevice = (deviceId: string) =>
  invoke<void>("remote_control_revoke_device", { deviceId });

// P2 WebRTC bridge. These are intentionally narrow renderer-to-Rust calls:
// the renderer handles browser RTC APIs, while Rust retains transport keys,
// pairing authorization, replay windows, and the gateway bearer credential.
export const remoteControlP2pPending = () =>
  invoke<RemoteP2pPendingSnapshot>("remote_control_p2p_pending");
export const remoteControlP2pOffer = (input: RemoteP2pOfferInput) =>
  invoke<void>("remote_control_p2p_offer", { input });
export const remoteControlP2pAnswer = (input: RemoteP2pAnswerInput) =>
  invoke<void>("remote_control_p2p_answer", { input });
export const remoteControlP2pIceCandidate = (input: RemoteP2pIceCandidateInput) =>
  invoke<void>("remote_control_p2p_ice_candidate", { input });
export const remoteControlP2pIceComplete = (input: RemoteP2pSessionInput) =>
  invoke<void>("remote_control_p2p_ice_complete", { input });
export const remoteControlP2pOpened = (input: RemoteP2pSessionInput) =>
  invoke<void>("remote_control_p2p_opened", { input });
export const remoteControlP2pFailed = (input: RemoteP2pFailureInput) =>
  invoke<void>("remote_control_p2p_failed", { input });
export const remoteControlP2pFrame = (input: RemoteP2pDataInput) =>
  invoke<void>("remote_control_p2p_frame", { input });
export const remoteControlP2pClosed = (input: RemoteP2pSessionInput) =>
  invoke<void>("remote_control_p2p_closed", { input });

// ── Settings / Skills / Sessions (P1) ─────────────────────────────────────────

export const configGet = () => invoke<ConfigView>("config_get");
export const configSecretGet = (kind: ConfigSecretKind) =>
  invoke<string | null>("config_secret_get", { kind });
export const configSecretClear = (kind: ConfigSecretKind) =>
  invoke<ConfigView>("config_secret_clear", { kind });
export const configSet = (patch: ConfigPatch) =>
  invoke<ConfigView>("config_set", { patch });
export const configTest = (patch: ConfigPatch) =>
  invoke<ConfigTestResult>("config_test", { patch });
export const webSearchProviderTest = (
  provider: "brave" | "exa" | "zhihu" | "bocha",
  apiKey?: string,
) =>
  invoke<ConfigTestDetail>("web_search_provider_test", {
    provider,
    apiKey: apiKey?.trim() || null,
  });

export const memoryStatus = () => invoke<MemoryStatusView>("memory_status");
export const memoryExplorerSnapshot = (limit = 50) =>
  invoke<MemoryExplorerSnapshot>("memory_explorer_snapshot", { limit });
export const memoryRecallPreview = (query: string) =>
  invoke<import("../types").MemoryRecallPreview>("memory_recall_preview", { query });
export const memoryGovernanceSearch = (query: string, limit = 10) =>
  invoke<MemoryGovernanceHit[]>("memory_governance_search", { query, limit });
export const memoryGovernanceReadScenario = (path: string) =>
  invoke<string | null>("memory_governance_read_scenario", { path });
export const memoryGovernanceUpdate = (source: "l0" | "l1", id: string, content: string) =>
  invoke<void>("memory_governance_update", { source, id, content });
export const memoryGovernanceDelete = (source: "l0" | "l1", id: string) =>
  invoke<void>("memory_governance_delete", { source, id });
export const memoryExport = () => invoke<string>("memory_export");
export const memoryMigrationPreview = () =>
  invoke<MemoryMigrationPreview>("memory_migration_preview");
export const memoryMigrationProgress = () =>
  invoke<MemoryMigrationProgress>("memory_migration_progress");
export const memoryMigrationExecute = () =>
  invoke<MemoryMigrationResult>("memory_migration_execute");
export const memoryMigrationCancel = () => invoke<void>("memory_migration_cancel");
export const memoryDeadLetters = () =>
  invoke<MemoryDeadLetterView[]>("memory_dead_letters");
export const memoryDeadLetterRetry = () => invoke<number>("memory_dead_letter_retry");
export const memoryRebuildDerived = () =>
  invoke<import("../types").MemoryRebuildResult>("memory_rebuild_derived");

// Managed desktop login (NewAPI) is distinct from the passwordless remote
// pairing gateway. These calls are used only by the desktop login shell.
export interface NewApiLoginResult {
  /** OpenAI-compatible base URL for the executor (`<base>/v1`). */
  baseUrl: string;
  model: string;
  /** Usable downstream key (`sk-...`) for the executor. */
  token: string;
}

export interface NewApiAuthStatus {
  registerEnabled: boolean;
  passwordRegisterEnabled: boolean;
  passwordLoginEnabled: boolean;
  emailVerification: boolean;
  turnstileCheck: boolean;
  turnstileSiteKey: string;
  userAgreementEnabled: boolean;
  privacyPolicyEnabled: boolean;
}

export interface NewApiUsageLogEntry {
  id: string;
  createdAt: number;
  model: string;
  tokenName: string;
  channel: string;
  requestId: string;
  upstreamRequestId: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  quota: number;
  status: string;
  typeLabel: string;
}

export interface NewApiUsageLogPage {
  items: NewApiUsageLogEntry[];
  total: number;
  page: number;
  pageSize: number;
}

export interface NewApiGroupOption {
  name: string;
  desc: string;
  ratio: string;
}

export interface NewApiAccount {
  username: string;
  displayName: string;
  role?: number;
  isAdmin?: boolean;
  subscriptionName?: string;
  subscriptionDesc?: string;
  subscriptionQuota?: number;
  subscriptionUsedQuota?: number;
  group: string;
  groupDesc: string;
  groupRatio: string;
  quota: number;
  usedQuota: number;
  models: string[];
  model: string;
}

export const newapiAuthStatus = (baseUrl: string) =>
  invoke<NewApiAuthStatus>("newapi_auth_status", { baseUrl });
export const newapiLogout = () => invoke<void>("newapi_logout");
export const newapiLogin = (
  baseUrl: string,
  model: string,
  username: string,
  password: string,
) => invoke<NewApiLoginResult>("newapi_login", { baseUrl, model, username, password });
export const newapiRegister = (input: {
  baseUrl: string;
  username: string;
  password: string;
  email?: string;
  verificationCode?: string;
  affCode?: string;
  turnstile?: string;
}) => invoke<void>("newapi_register", { input });
export const newapiSendVerification = (input: {
  baseUrl: string;
  email: string;
  turnstile?: string;
}) => invoke<void>("newapi_send_verification", { input });
export const newapiModels = () => invoke<string[]>("newapi_models");
export const newapiBootstrap = () => invoke<NewApiAccount>("newapi_bootstrap");
export const newapiGroups = () => invoke<NewApiGroupOption[]>("newapi_groups");
export const newapiUpdateGroup = (group: string) =>
  invoke<NewApiAccount>("newapi_update_group", { group });
export const newapiUsageLogs = (page: number, pageSize: number) =>
  invoke<NewApiUsageLogPage>("newapi_usage_logs", { page, pageSize });

export const profileStats = () => invoke<ProfileStats>("profile_stats");

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
export const mcpConfigGet = () => invoke<McpConfigView>("mcp_config_get");
export const mcpConfigSet = (servers: McpStdioServerInput[]) =>
  invoke<McpConfigView>("mcp_config_set", { servers });
export const mcpConfigTest = () => invoke<McpTestResult>("mcp_config_test");

const PREVIEW_ORACLE_WEB_STATUS: OracleWebStatusView = {
  runtime: {
    status: "missing",
    source: "none",
    version: null,
    commandPath: null,
    nodePath: null,
    installSupported: false,
    message: "Oracle is an optional runtime and is not installed in browser preview mode.",
  },
  browsers: [
    {
      id: "edge-preview",
      name: "Microsoft Edge",
      kind: "edge",
      path: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      recommended: true,
    },
  ],
  accounts: [],
  consultAccountId: null,
  reviewerAccountId: null,
  imageAccountId: null,
  dataDir: "~/.config/SomniQ/oracle-web",
};

export const oracleWebStatus = () =>
  !hasNativeBackend()
    ? Promise.resolve(structuredClone(PREVIEW_ORACLE_WEB_STATUS))
    : invoke<OracleWebStatusView>("oracle_web_status");
export const oracleWebRuntimeInstall = () =>
  invoke<OracleWebStatusView>("oracle_web_runtime_install");
export const oracleWebAccountCreate = (input: OracleWebAccountCreateInput) =>
  invoke<OracleWebStatusView>("oracle_web_account_create", { input });
export const oracleWebAccountLogin = (accountId: string) =>
  invoke<OracleWebLoginLaunchView>("oracle_web_account_login", { accountId });
export const oracleWebAccountModelSet = (input: OracleWebAccountModelSetInput) =>
  invoke<OracleWebAccountView>("oracle_web_account_model_set", { input });
export const oracleWebAccountRemove = (accountId: string) =>
  invoke<OracleWebStatusView>("oracle_web_account_remove", { accountId });
export const oracleWebRoleSet = (input: OracleWebRoleSetInput) =>
  invoke<OracleWebStatusView>("oracle_web_role_set", { input });

// ── Mail (Gmail API + Microsoft Graph) ────────────────────────────────────────

export const mailAccountsGet = () => invoke<MailAccount[]>("mail_accounts_get");
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
export const onMailNewMessage = (handler: (event: MailNewMessageEvent) => void) =>
  listen<MailNewMessageEvent>("mail-new-message", (e) => handler(e.payload));

export interface RemoteChatSessionUpdatedEvent {
  sessionId: string;
  messageId?: string;
  phase?: "created" | "started" | "activity" | "delta" | "completed" | "cancelled" | "error";
  message?: string;
  activity?: "preparing" | "compacting" | "thinking" | "tool";
  delta?: string;
  text?: string;
  error?: string;
  persisted?: boolean;
  /** The backend also emitted ordinary `chat-*` events for this turn. */
  desktopMirrored?: boolean;
}

export interface ChatUiSessionUpdatedEvent {
  sessionId: string;
  operation: "saved" | "deleted";
  latestUserTurnId?: string | null;
  assistantComplete?: boolean;
  contextTokens?: number | null;
  contextTokensUserTurnId?: string | null;
}

/** Keeps multiple desktop windows on the same persisted Chat projection. */
export const onChatUiSessionUpdated = (
  handler: (event: ChatUiSessionUpdatedEvent) => void,
) => listen<ChatUiSessionUpdatedEvent>("chat-ui-session-updated", (event) => handler(event.payload));

export const onRemoteChatSessionUpdated = (
  handler: (event: RemoteChatSessionUpdatedEvent) => void,
) => listen<RemoteChatSessionUpdatedEvent>("remote-chat-session-updated", (e) => handler(e.payload));

/** Emitted after a project is switched locally or by a paired phone. */
export const onProjectChanged = (handler: () => void) =>
  listen("project-changed", () => handler());

export const skillsList = () => invoke<SkillMeta[]>("skills_list");
export const skillView = (name: string) =>
  invoke<string>("skill_view", { name });

export const sessionsList = () => invoke<SessionSummary[]>("sessions_list");
export const chatUiSessionsList = <T>() => invoke<T[]>("chat_ui_sessions_list");
export const chatUiSessionLoad = <T>(id: string) =>
  invoke<T>("chat_ui_session_load", { id });
export const chatUiTurnLoad = <T>(id: string, turnIndex: number) =>
  invoke<T>("chat_ui_turn_load", { id, turnIndex });
export const chatUiSessionSave = <T>(session: T) =>
  invoke<void>("chat_ui_session_save", { session });
export const chatUiSessionDelete = (id: string) =>
  invoke<void>("chat_ui_session_delete", { id });
export const chatUiSessionsSave = <T>(sessions: T[]) =>
  invoke<void>("chat_ui_sessions_save", { sessions });
export const chatTasksGet = (sessionId: string) =>
  invoke<ChatTodoItem[]>("chat_tasks_get", { sessionId });

// Durable, project-local research workflows.
export const reviewWorkflowsList = <T>() =>
  invoke<T>("review_workflows_list");
export const reviewWorkflowLoad = <T>(id: string) =>
  invoke<T>("review_workflow_load", { id });
export const reviewWorkflowCreate = <T>(input: unknown) =>
  invoke<T>("review_workflow_create", { input });
export const reviewWorkflowSave = <T>(input: unknown) =>
  invoke<T>("review_workflow_save", { input });
export const reviewWorkflowDriveOnce = <T>(input: unknown) =>
  invoke<T>("review_workflow_drive_once", { input });
export const reviewWorkflowSubmitScopePlan = <T>(input: unknown) =>
  invoke<T>("review_workflow_submit_scope_plan", { input });
export const reviewWorkflowConfirmScopePlan = <T>(input: unknown) =>
  invoke<T>("review_workflow_confirm_scope_plan", { input });
export const reviewWorkflowResetScopePlan = <T>(input: unknown) =>
  invoke<T>("review_workflow_reset_scope_plan", { input });
export const reviewWorkflowTranscript = (runId: string) =>
  invoke<ChatEventsReplay>("review_workflow_transcript", { runId });
export interface ReviewWorkflowTurnResponse {
  text: string;
  model: string;
  sessionId: string;
}
export interface ReviewWorkflowTurnProgressEvent {
  runId: string;
  sessionId: string;
  actionId: string;
  stageId: string;
  actor: string;
  phase: "started" | "text" | "thinking" | "tool" | "completed" | "failed";
  text?: string | null;
  model?: string | null;
}
export interface ReviewWorkflowSessionUpdatedEvent {
  runId: string;
  sessionId: string;
  projectId: string;
}
export const reviewWorkflowExecutorTurn = (input: unknown) =>
  invoke<ReviewWorkflowTurnResponse>("review_workflow_executor_turn", { input });
export const reviewWorkflowDiscuss = (input: unknown) =>
  invoke<ReviewWorkflowTurnResponse>("review_workflow_discuss", { input });
export const reviewWorkflowReviewerTurn = (input: unknown) =>
  invoke<string>("review_workflow_reviewer_turn", { input });
export const listenReviewWorkflowTurnProgress = (
  handler: (event: ReviewWorkflowTurnProgressEvent) => void,
) => listen<ReviewWorkflowTurnProgressEvent>(
  "workflow-turn-progress",
  (event) => handler(event.payload),
);
export const listenReviewWorkflowSessionUpdated = (
  handler: (event: ReviewWorkflowSessionUpdatedEvent) => void,
) => listen<ReviewWorkflowSessionUpdatedEvent>(
  "workflow-session-updated",
  (event) => handler(event.payload),
);
export const reviewWorkflowLeaseAcquire = <T>(id: string, ownerTurnId: string) =>
  invoke<T>("review_workflow_lease_acquire", { id, ownerTurnId });
export const reviewWorkflowLeaseRelease = <T>(id: string, ownerTurnId: string) =>
  invoke<T>("review_workflow_lease_release", { id, ownerTurnId });
export const reviewWorkflowRename = <T>(id: string, title: string) =>
  invoke<T>("review_workflow_rename", { id, title });
export const reviewWorkflowDelete = (id: string) =>
  invoke<void>("review_workflow_delete", { id });

// ── Literature library ────────────────────────────────────────────────────────

export const literatureLoad = <T>() => invoke<T>("literature_load");
export const literatureLibraryRelations = <T>() =>
  invoke<T>("literature_library_relations");
export const literatureLibraryModel = <T>() =>
  invoke<T>("literature_library_model");
export const literatureUpdateCollections = <T>(collections: unknown) =>
  invoke<T>("literature_update_collections", { collections });
export const literaturePreferences = <T>() => invoke<T>("literature_preferences");
export const literatureSetPreferences = <T>(preferences: unknown) =>
  invoke<T>("literature_set_preferences", { preferences });
export const literatureRenameAttachments = <T>(recordIds: string[], dryRun: boolean) =>
  invoke<T>("literature_rename_attachments", { recordIds, dryRun });
export const literatureUpdateRelations = <T>(
  recordId: string,
  relations: unknown,
) => invoke<T>("literature_update_relations", { recordId, relations });
export const literatureUpdateItem = <T>(itemId: string, patch: unknown) =>
  invoke<T>("literature_update_item", { itemId, patch });
export const literatureCreateItem = <T>(item: unknown) =>
  invoke<T>("literature_create_item", { item });
export const literatureTrashItems = <T>(itemIds: string[]) =>
  invoke<T>("literature_trash_items", { itemIds });
export const literatureRestoreItems = <T>(itemIds: string[]) =>
  invoke<T>("literature_restore_items", { itemIds });
export const literaturePermanentlyDeleteItems = <T>(itemIds: string[]) =>
  invoke<T>("literature_permanently_delete_items", { itemIds });
export const literatureUpdateSavedSearches = <T>(searches: unknown) =>
  invoke<T>("literature_update_saved_searches", { searches });
/** `includeHealth` runs a SQLite integrity check that reads the whole database
 *  — seconds on a large library — so it stays opt-in. */
export const literatureStorageStatus = <T>(includeHealth = false) =>
  invoke<T>("literature_storage_status", { includeHealth });
export const literatureStorageBackup = <T>() => invoke<T>("literature_storage_backup");
export const literatureFullTextSearch = <T>(query: string, limit?: number, offset?: number) =>
  invoke<T>("literature_full_text_search", {
    query,
    limit: limit ?? null,
    offset: offset ?? null,
  });
export const literatureSearchProtocolCreate = <T>(protocol: unknown) =>
  invoke<T>("literature_search_protocol_create", { protocol });
export const literatureSearchProtocolPreview = <T>(protocolId: string) =>
  invoke<T>("literature_search_protocol_preview", { protocolId });
export const literatureSearchProtocolExecute = <T>(
  protocolId: string,
  confirmation: "execute",
  continueRunId?: string,
  /** Remaining corpus quota per query-variant kind for this pass. The protocol
   * ceiling still applies; `0` retires a variant that already filled its quota
   * without spending another provider page on it. */
  variantBudgets?: Record<string, number>,
  /** Caller-minted id that `literatureSearchCancel` can stop this run by. A run
   * started without one cannot be interrupted. */
  requestId?: string,
) => invoke<T>("literature_search_protocol_execute", {
  protocolId,
  confirmation,
  continueRunId: continueRunId ?? null,
  variantBudgets: variantBudgets ?? null,
  requestId: requestId ?? null,
});

/** Stops an in-flight search run at the next source, query variant, or provider
 * page boundary. Returns `false` when the id is unknown (already finished, or
 * not started yet). The run is finished as `partial`, so everything already
 * retrieved keeps its records and cursors and the protocol can be continued. */
export const literatureSearchCancel = (requestId: string) =>
  invoke<boolean>("literature_search_cancel", { requestId });
export interface LiteratureSearchProgressEvent {
  searchRunId: string;
  source: string;
  phase: string;
  message?: string;
  query?: string;
  returnedCount?: number;
  hitCount?: number;
}
export const listenLiteratureSearchProgress = (
  handler: (event: LiteratureSearchProgressEvent) => void,
) => listen<LiteratureSearchProgressEvent>(
  "literature-search-progress",
  (event) => handler(event.payload),
);
export const literatureDuplicateCandidates = <T>() => invoke<T>("literature_duplicate_candidates");
export const literatureMergeDuplicates = <T>(primaryRecordId: string, duplicateRecordId: string) =>
  invoke<T>("literature_merge_duplicates", { primaryRecordId, duplicateRecordId });
export const literatureApplyDelta = <T>(delta: unknown) =>
  invoke<T>("literature_apply_delta", { delta });
export const literatureImportBibliography = <T>(input: {
  sourcePath: string;
  format?: string;
}) => invoke<T>("literature_import_bibliography", { input });
export const literatureExportBibliography = <T>(input: {
  format: "bibtex" | "biblatex" | "ris" | "csl-json" | "zotero-json";
  recordIds?: string[];
}) => invoke<T>("literature_export_bibliography", { input });
export const literatureWriteBibliographyExport = (destinationPath: string, content: string) =>
  invoke<void>("literature_write_bibliography_export", { destinationPath, content });
export const literatureImportPdfAsRecord = <T>(sourcePath: string, title?: string) =>
  invoke<T>("literature_import_pdf_as_record", { sourcePath, title: title ?? null });
export const literatureAddIdentifier = <T>(identifier: string) =>
  invoke<T>("literature_add_identifier", { identifier });
export const literatureDownloadPdf = <T>(url: string, fileName: string) =>
  invoke<T>("literature_download_pdf", { url, fileName });
export const literatureImportPdf = <T>(sourcePath: string, fileName: string) =>
  invoke<T>("literature_import_pdf", { sourcePath, fileName });
export const literatureImportAttachment = <T>(sourcePath: string) =>
  invoke<T>("literature_import_attachment", { sourcePath });
export const literatureLlm = (
  system: string,
  prompt: string,
  model?: string | null,
  requestId?: string | null,
) => invoke<string>("literature_llm", {
  system,
  prompt,
  model: model ?? null,
  requestId: requestId ?? null,
});
export interface LiteratureLlmResponse {
  text: string;
  model: string;
}
export const literatureReviewLlm = (
  system: string,
  prompt: string,
  requestId?: string | null,
) => invoke<string>("literature_review_llm", {
  system,
  prompt,
  requestId: requestId ?? null,
});
/** Interrupts an in-flight literature/workflow model call. Resolves `false`
 *  when the request already finished or has not reached the backend yet. */
export const literatureLlmCancel = (requestId: string) =>
  invoke<boolean>("literature_llm_cancel", { requestId });
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
export interface LiteratureRagIndexResult {
  paperId: string;
  relativePath?: string;
  pageCount: number;
  ocrUsed: boolean;
  indexedForSearch: boolean;
  documentContentHash?: string;
  indexedChunks?: number;
  skippedAsCurrent?: boolean;
  parserEngine?: string;
  parserWarning?: string;
  assetCount?: number;
  stats?: {
    indexedChunks: number;
    skippedAsCurrent: boolean;
    documentContentHash: string;
  };
}
export interface LiteratureRagSearchHit {
  chunk: {
    chunkId: string;
    paperId: string;
    relativePath: string;
    pageStart: number;
    pageEnd: number;
    pageSource: "embedded" | "ocr" | "empty" | "liteparse";
    ordinalOnPage: number;
    text: string;
    contentHash: string;
    chunkerVersion: string;
  };
  retrievalScore: number;
  sourceRank?: number;
  cardRank?: number;
  assetRank?: number;
  citationRank?: number;
  metadataRank?: number;
  matchedQueries: string[];
}
export interface LiteratureRagIndexLibraryResult {
  forceRebuild: boolean;
  total: number;
  indexed: number;
  skipped: number;
  failed: number;
  results: LiteratureRagIndexResult[];
  failures: Array<{ paperId: string; relativePath: string; error: string }>;
}
export interface RetrievalCardPreview {
  chunkId: string;
  paperId: string;
  relativePath: string;
  pageStart: number;
  pageEnd: number;
  updatedAt: string;
  sourcePreview: string;
  card: {
    chunkId: string;
    sourceContentHash: string;
    questions: string[];
    concepts: string[];
    sectionHeadings: string[];
    aliases: string[];
    methods: string[];
    datasets: string[];
    metrics: string[];
    limitations: string[];
    languageTerms: string[];
    generatedBy: string;
    promptVersion: number;
  };
}
export interface LiteratureRagDatabaseStatus {
  exists: boolean;
  indexPath: string;
  relativeIndexPath: string;
  databaseBytes: number;
  documentCount: number;
  chunkCount: number;
  currentCardCount: number;
  staleCardCount: number;
  pendingCardCount: number;
  assetCount: number;
  citationMentionCount: number;
  metadataDocumentCount: number;
  cardPreviews: RetrievalCardPreview[];
}
export const literatureRagIndexPdf = (
  relativePath: string,
  paperId?: string,
) =>
  invoke<LiteratureRagIndexResult>("literature_rag_index_pdf", {
    relativePath,
    paperId: paperId ?? null,
    pages: null,
  });
export const literatureRagIndexLibrary = (forceRebuild = false) =>
  invoke<LiteratureRagIndexLibraryResult>("literature_rag_index_library", {
    forceRebuild,
  });
export const literatureRagStatus = (previewLimit = 12) =>
  invoke<LiteratureRagDatabaseStatus>("literature_rag_status", {
    previewLimit,
  });
export interface LiteratureRetrievalCardPage {
  total: number;
  offset: number;
  limit: number;
  query: string;
  cards: RetrievalCardPreview[];
}
export const literatureRagCards = (
  params: {
    query?: string;
    paperId?: string;
    offset?: number;
    limit?: number;
  } = {},
) =>
  invoke<LiteratureRetrievalCardPage>("literature_rag_cards", {
    query: params.query ?? "",
    paperId: params.paperId && params.paperId.trim() ? params.paperId : null,
    offset: params.offset ?? 0,
    limit: params.limit ?? 20,
  });
export const literatureRagSearch = (
  query: string,
  limit?: number,
) =>
  invoke<{
    query: string;
    queryPlan: RetrievalQueryPlan;
    retrieval: string;
    results: LiteratureRagSearchHit[];
  }>("literature_rag_search", {
    query,
    limit: limit ?? null,
  });
export const literaturePdfBytes = (relativePath: string) =>
  invoke<number[]>("literature_pdf_bytes", { relativePath });
export const literatureImageOcr = (image: number[]) =>
  invoke<string>("literature_image_ocr", { image });
export const literaturePdfOpen = (relativePath: string) =>
  invoke<void>("literature_pdf_open", { relativePath });
export const literatureAttachmentOpen = (relativePath: string) =>
  invoke<void>("literature_attachment_open", { relativePath });
export interface LiteratureAttachmentStatus {
  exists: boolean;
  bytes?: number;
  mtime?: number;
}
export const literatureAttachmentStatus = (sourcePath: string) =>
  invoke<LiteratureAttachmentStatus>("literature_attachment_status", { sourcePath });
export const literatureAttachmentOpenExternal = (sourcePath: string) =>
  invoke<void>("literature_attachment_open_external", { sourcePath });
export interface LiteratureAttachmentText {
  path: string;
  sourceName: string;
  mimeType: string;
  content: string;
}
export const literatureAttachmentReadText = (relativePath: string) =>
  invoke<LiteratureAttachmentText>("literature_attachment_read_text", { relativePath });
export const literatureAttachmentReadExternalText = (sourcePath: string) =>
  invoke<LiteratureAttachmentText>("literature_attachment_read_external_text", { sourcePath });
export const literatureIndexAttachmentText = (
  recordId: string,
  attachmentId: string,
  text: string,
) => invoke<void>("literature_index_attachment_text", { recordId, attachmentId, text });
export const literatureReadAnnotationExport = <T>(sourcePath: string) =>
  invoke<T>("literature_read_annotation_export", { sourcePath });
export const literatureWriteAnnotationExport = (destinationPath: string, payload: unknown) =>
  invoke<void>("literature_write_annotation_export", { destinationPath, payload });

// ── Knowledge base ────────────────────────────────────────────────────────────

export const knowledgeLoad = <T>() => invoke<T>("knowledge_load");
export const knowledgeSearch = <T>(query: string, limit?: number) =>
  invoke<T>("knowledge_search", { query, limit: limit ?? null });
export interface RetrievalQueryPlan {
  originalQuery: string;
  exactTerms: string[];
  aliases: string[];
  subqueries: string[];
  entities: string[];
  answerType?: string;
}
export interface ProjectRagKnowledgeHit {
  rank: number;
  retrievalScore: number;
  matchedQueries: string[];
  knowledge: {
    id: string;
    question: string;
    answer: string;
    statement: string;
    kind?: string;
    sourcePaperId?: string;
    snippet: string;
    evidence: Array<{
      paperId: string;
      page?: number;
      quote: string;
      role?: string;
      annotationId?: string;
      evidenceId?: string;
    }>;
  };
}
export interface ProjectRagSearchResult {
  query: string;
  queryPlan: RetrievalQueryPlan;
  knowledge: {
    query: string;
    retrieval: string;
    results: ProjectRagKnowledgeHit[];
    note: string;
  };
  literature: {
    query: string;
    queryPlan: RetrievalQueryPlan;
    retrieval: string;
    results: LiteratureRagSearchHit[];
  };
  plannerWarning?: string;
  rerank: Array<{ id: string; relevance: number; reason: string }>;
}
export interface ProjectRagAnswerResult extends ProjectRagSearchResult {
  answer: string;
  review: {
    verdict: "pass" | "insufficient" | "fail" | "unavailable";
    findings: string[];
    gapQueries: string[];
  };
}
export interface RetrievalCardBuildResult {
  attempted: number;
  generated: number;
  hasMore: boolean;
  warnings: string[];
  stats: { written: number; unchanged: number; indexPath: string };
}
export const knowledgeRetrievalCardsBuild = (paperId?: string, limit?: number) =>
  invoke<RetrievalCardBuildResult>("knowledge_retrieval_cards_build", {
    paperId: paperId ?? null,
    limit: limit ?? null,
  });
/** Multi-query FTS retrieval keeps confirmed knowledge and PDF citations as separate sources. */
export const projectRagSearch = <T>(query: string, limit?: number) =>
  invoke<T>("project_rag_search", { query, limit: limit ?? null });
/** Retrieve locally, then synthesize an evidence-cited answer with SomniQ's configured executor. */
export const projectRagAnswer = (
  query: string,
  limit?: number,
) => invoke<ProjectRagAnswerResult>("project_rag_answer", {
  query,
  limit: limit ?? null,
});
export const knowledgeUpsert = <T>(points: unknown[]) =>
  invoke<T>("knowledge_upsert", { points });
export const knowledgeConfirm = (kpId: string) =>
  invoke<void>("knowledge_confirm", { kpId });
export const knowledgeReject = (kpId: string) =>
  invoke<boolean>("knowledge_reject", { kpId });
export const knowledgeGenerate = <T>(paperId: string) =>
  invoke<T>("knowledge_generate", { paperId });

const preview = <T>(value: T): Promise<T> => Promise.resolve(value);
const noopUnlisten = () => undefined;

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
  /** Content fingerprint returned by the backend for optimistic save checks. */
  version?: string;
}

export type TypesetDocumentKind = "article" | "beamer" | "poster" | "report";
export type TypesetCompileState = "fresh" | "stale" | "missing";

/** A compilable LaTeX root document, rather than an included chapter file. */
export interface TypesetDocument {
  path: string;
  /** First-level folder owning this document; empty for a loose root source. */
  projectPath: string;
  title: string;
  kind: TypesetDocumentKind;
  modifiedEpochMs: number;
  compileState: TypesetCompileState;
}

/** A first-level workspace folder that holds at least one `.tex` file. */
export interface TypesetProject {
  path: string;
  name: string;
  /** Every `.tex` file below the project, chapter and include files included. */
  texFileCount: number;
  modifiedEpochMs: number;
}

export interface TypesetLibrary {
  projects: TypesetProject[];
  documents: TypesetDocument[];
}

export const fileListDir = (path?: string | null) =>
  isFilePreviewMode()
    ? preview<FileTreeEntry[]>(previewFileTree(path ?? null))
    :
  invoke<FileTreeEntry[]>("file_list_dir", { path: path ?? null });

export const typesetListDocuments = () =>
  isFilePreviewMode()
    ? preview<TypesetLibrary>(previewListTypesetDocuments() as TypesetLibrary)
    : invoke<TypesetLibrary>("typeset_list_documents");

export const fileReadText = (path: string) =>
  isFilePreviewMode()
    ? preview<FileText>(previewReadText(path))
    :
  invoke<FileText>("file_read_text", { path });

export const fileWriteText = (path: string, content: string, expectedVersion?: string | null) =>
  isFilePreviewMode()
    ? preview<FileText>(previewWriteText(path, content, expectedVersion))
    :
  invoke<FileText>("file_write_text", { path, content, expectedVersion: expectedVersion ?? null });

export const fileCreateText = (path: string, content: string) =>
  isFilePreviewMode()
    ? preview<FileText>(previewWriteText(path, content))
    :
  invoke<FileText>("file_create_text", { path, content });

export const fileCreateDir = (path: string) =>
  isFilePreviewMode()
    ? preview<FileTreeEntry>(previewCreateDir(path))
    :
  invoke<FileTreeEntry>("file_create_dir", { path });

export const fileRename = (path: string, newPath: string) =>
  isFilePreviewMode()
    ? preview<FileTreeEntry>(previewRenamePath(path, newPath))
    :
  invoke<FileTreeEntry>("file_rename", { path, newPath });

export const fileDuplicate = (path: string) =>
  isFilePreviewMode()
    ? preview<FileTreeEntry>(previewDuplicatePath(path))
    : invoke<FileTreeEntry>("file_duplicate", { path });

export const fileDelete = (path: string) =>
  isFilePreviewMode() ? previewDeletePath(path) :
  invoke<void>("file_delete", { path });

export const fileReadBytes = (path: string): Promise<ArrayBuffer> =>
  isFilePreviewMode()
    ? previewReadBytes(path).then((bytes) => Uint8Array.from(bytes).buffer)
    : invoke<ArrayBuffer>("file_read_bytes", { path });

export interface FileBinaryInfo {
  bytes: number;
}

export const fileReadBytesInfo = (path: string): Promise<FileBinaryInfo> =>
  isFilePreviewMode()
    ? fileReadBytes(path).then((bytes) => ({ bytes: bytes.byteLength }))
    : invoke<FileBinaryInfo>("file_read_bytes_info", { path });

/** Read an exclusive byte range without materialising the whole file. */
export const fileReadBytesRange = (path: string, begin: number, end: number): Promise<ArrayBuffer> =>
  isFilePreviewMode()
    ? fileReadBytes(path).then((bytes) => bytes.slice(begin, end))
    : invoke<ArrayBuffer>("file_read_bytes_range", { path, begin, end });

/**
 * Return a scoped native asset URL for binary previews. In browser preview
 * mode the fallback is an object URL, since the Tauri asset protocol is not
 * available there.
 */
export const fileAssetUrl = (path: string, mimeType = "application/octet-stream"): Promise<string> =>
  isFilePreviewMode()
    ? fileReadBytes(path).then((bytes) => URL.createObjectURL(new Blob([bytes], { type: mimeType })))
    : invoke<string>("file_asset_path", { path }).then((absolutePath) => convertFileSrc(absolutePath));

export const fileSearch = (pattern: string, root?: string) =>
  isFilePreviewMode() ? preview<string[]>(previewSearchFiles(pattern, root ?? null)) :
  invoke<string[]>("file_search", { pattern, root: root ?? null });

export const fileRead = (path: string, limit?: number) =>
  isFilePreviewMode() ? preview<string>(previewReadText(path).content) :
  invoke<string>("file_read", { path, limit: limit ?? null });

export interface ImportedChatAttachment {
  path: string;
  name: string;
  bytes: number;
}

/** Copy a user-selected file into the active project's durable chat uploads. */
export const chatImportAttachment = (sourcePath: string) =>
  invoke<ImportedChatAttachment>("chat_import_attachment", { sourcePath });

export const fileOpen = (path: string) =>
  isFilePreviewMode() ? Promise.resolve() :
  invoke<void>("file_open", { path });
export const fileReveal = (path: string) =>
  isFilePreviewMode() ? Promise.resolve() :
  invoke<void>("file_reveal", { path });

export interface LatexCompileResult {
  success: boolean;
  inputPath: string;
  outputPath: string;
  engine: string;
  stdout: string;
  stderr: string;
  exitCode?: number | null;
  interrupted: boolean;
  timedOut: boolean;
  durationMs: number;
  returnCodeInterpretation?: string | null;
  partialOutput: boolean;
  pdfState: "fresh" | "partial" | "stale" | "missing";
  rootSourceHash: string;
  pdfHash?: string | null;
  compiledAtUnixMs: number;
  diagnostics: LatexDiagnostic[];
}

export interface LatexDiagnostic {
  severity: "error" | "warning" | string;
  code: string;
  message: string;
  filePath?: string | null;
  line?: number | null;
}

export interface LatexCompileProgressEvent {
  runId: string;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

export const onLatexCompileProgress = (handler: (event: LatexCompileProgressEvent) => void) =>
  isFilePreviewMode() ? Promise.resolve(noopUnlisten) :
  listen<LatexCompileProgressEvent>("latex-compile-progress", (e) => handler(e.payload));

export const latexCompileCancel = (runId: string) =>
  isFilePreviewMode() ? Promise.resolve() : invoke<void>("latex_compile_cancel", { runId });

export interface LatexDocumentContext {
  sourcePath: string;
  rootPath: string;
  outputPath: string;
}

export const latexDocumentContext = (sourcePath: string) =>
  isFilePreviewMode()
    ? Promise.resolve<LatexDocumentContext>({
        sourcePath,
        rootPath: sourcePath,
        outputPath: sourcePath.replace(/\.tex$/i, ".pdf"),
      })
    : invoke<LatexDocumentContext>("latex_document_context", { sourcePath });

export const latexCompile = (
  inputPath: string,
  outputPath?: string | null,
  cleanCache = false,
  runId?: string | null,
  continueOnError = false,
  /** Overrides the engine detected from the source: pdflatex | xelatex | lualatex. */
  engine?: string | null,
) =>
  isFilePreviewMode()
    ? preview<LatexCompileResult>({
        success: true,
        inputPath,
        outputPath: outputPath ?? inputPath.replace(/\.tex$/i, ".pdf"),
        engine: "xelatex",
        stdout: cleanCache
          ? "LaTeX cache cleared before recompiling. Browser preview is showing the bundled compiled PDF."
          : "Browser preview is showing the bundled compiled PDF.",
        stderr: "",
        exitCode: 0,
        interrupted: false,
        timedOut: false,
        durationMs: 0,
        returnCodeInterpretation: null,
        partialOutput: false,
        pdfState: "fresh",
        rootSourceHash: "browser-preview",
        pdfHash: "browser-preview",
        compiledAtUnixMs: Date.now(),
        diagnostics: [],
      })
    : invoke<LatexCompileResult>("latex_compile", {
        inputPath,
        outputPath: outputPath ?? null,
        cleanCache,
        runId: runId ?? null,
        continueOnError,
        engine: engine ?? null,
      });

/** Copy a file from anywhere on disk into the workspace, at a project-relative path. */
export const typesetImportFile = (sourcePath: string, destinationPath: string) =>
  isFilePreviewMode()
    ? Promise.resolve(destinationPath)
    : invoke<string>("typeset_import_file", { sourcePath, destinationPath });

/** Copy a compiled artifact out of the workspace to a path the user picked. */
export const typesetExportFile = (sourcePath: string, destinationPath: string) =>
  isFilePreviewMode()
    ? Promise.resolve(destinationPath)
    : invoke<string>("typeset_export_file", { sourcePath, destinationPath });

/** A SyncTeX match: `pointX/pointY` is the exact synchronized point (for
 * centering the viewport), `box*` is the enclosing typeset box (for drawing a
 * highlight rectangle). Both are in PDF points, origin at the page's top-left
 * corner — the same convention pdfjs-dist viewports use at zoom 1. */
export interface SyncTexLocation {
  page: number;
  pointX: number;
  pointY: number;
  boxLeft: number;
  boxTop: number;
  boxWidth: number;
  boxHeight: number;
}

export interface ForwardSearchResult {
  found: boolean;
  locations: SyncTexLocation[];
  stderr: string;
}

export const latexForwardSearch = (sourcePath: string, pdfPath: string, line: number, column?: number) =>
  isFilePreviewMode()
    ? Promise.resolve<ForwardSearchResult>({ found: false, locations: [], stderr: "" })
    : invoke<ForwardSearchResult>("latex_forward_search", {
        sourcePath,
        pdfPath,
        line,
        column: column ?? null,
      });

export interface SyncTexSourceLocation {
  sourcePath: string;
  line: number;
  column: number | null;
}

export interface InverseSearchResult {
  found: boolean;
  locations: SyncTexSourceLocation[];
  stderr: string;
}

export const latexInverseSearch = (pdfPath: string, page: number, x: number, y: number) =>
  isFilePreviewMode()
    ? Promise.resolve<InverseSearchResult>({ found: false, locations: [], stderr: "" })
    : invoke<InverseSearchResult>("latex_inverse_search", { pdfPath, page, x, y });

// ── Chat engine (P2) ──────────────────────────────────────────────────────────

export const chatStatus = () => invoke<ChatStatus>("chat_status");
export const systemPromptView = () => invoke<SystemPromptView>("system_prompt_view");
export const userPromptView = () => invoke<UserPromptView | null>("user_prompt_view");
export const chatModelOptions = () =>
  invoke<ChatModelOptions>("chat_model_options");
export const chatModelSet = (model: string, persist = true) =>
  invoke<ChatStatus>("chat_model_set", { model, persist });
// Both calls carry the model the session actually runs on: the composer can
// switch models without persisting them, so the backend must not answer from
// the configured executor.
export const chatReasoningEffortGet = (model?: string | null) =>
  invoke<ChatReasoningEffortView>("chat_reasoning_effort_get", { model: model ?? null });
export const chatReasoningEffortSet = (effort: string, model?: string | null) =>
  invoke<ChatReasoningEffortView>("chat_reasoning_effort_set", { effort, model: model ?? null });
export const chatPermissionGet = (sessionId: string) =>
  invoke<PermissionModeView>("chat_permission_get", { sessionId });
export const chatPermissionSet = (sessionId: string, mode: string) =>
  invoke<PermissionModeView>("chat_permission_set", { sessionId, mode });
export const chatPermissionRespond = (promptId: string, allow: boolean) =>
  invoke<void>("chat_permission_respond", { promptId, allow });
export const chatQuestionRespond = (toolUseId: string, answer: string) =>
  invoke<void>("chat_question_respond", { toolUseId, answer });

export interface ChatChangeRevertOutput {
  changeId: string;
  filePath: string;
  reverted: boolean;
  revertChangeId?: string | null;
  conflict?: string | null;
  reason?: string | null;
}

export const chatChangeRevert = (changeId: string, sessionId?: string | null) =>
  invoke<ChatChangeRevertOutput>("chat_change_revert", { changeId, sessionId: sessionId ?? null });

export const chatCommandSpecs = () =>
  invoke<DesktopCommandSpec[]>("chat_command_specs");
export const chatRunCommand = (sessionId: string, input: string) =>
  invoke<ChatCommandResult>("chat_run_command", { sessionId, input });
export interface ChatTitleRequest {
  user: string;
  assistant: string;
  attachments: string[];
  /** Later user questions, oldest to newest, used to re-title a drifted chat. */
  followUps: string[];
}

export const chatSuggestTitle = (request: ChatTitleRequest) =>
  invoke<string>("chat_suggest_title", { request });

export type ProjectGoalStatus = "active" | "paused" | "complete";

export interface ProjectGoalView {
  objective: string;
  successCriteria: string[];
  verifiedCriteria: Array<{
    criterionIndex: number;
    evidence: string[];
    reviewer: string;
    verifiedAt: string;
  }>;
  recentStatus: string;
  status: ProjectGoalStatus;
  sourceSessionId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ProjectIntentStatus = "emerging" | "established";

export interface ProjectIntentView {
  objective: string;
  confidence: number;
  status: ProjectIntentStatus;
  evidenceCount: number;
  supportingEvidence?: Array<{
    id: string;
    sessionId: string;
    text: string;
    observedAt: string;
    role: "user" | "assistant";
  }>;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectIntentObservation {
  id: string;
  text: string;
}

export interface ProjectActivityView {
  coreFocus: string;
  relatedWork: string[];
  conversationCount: number;
  messageCount: number;
  questionCount: number;
  sessionCursors?: Record<string, string>;
  contextCheckpoints?: Record<string, {
    contextTokens: number;
    compactionBudget: number;
  }>;
  reviewer: string;
  sourceFingerprint: string;
  reviewedAt: string;
  drift?: ProjectActivityDriftView | null;
}

export interface ProjectActivityDriftView {
  evidence: string;
  suggestion: string;
  detectedAt: string;
}

export interface ProjectBriefView {
  mission: string;
  activity?: ProjectActivityView | null;
  intent?: ProjectIntentView | null;
  goal?: ProjectGoalView | null;
}

export const projectBriefGet = (projectId: string) =>
  invoke<ProjectBriefView>("project_brief_get", { projectId });
export interface ProjectActivityReviewTrigger {
  sessionId: string;
  contextTokens: number;
  compactionBudget: number;
  compacted: boolean;
}
export const projectBriefReview = (
  projectId: string,
  trigger: ProjectActivityReviewTrigger,
) => invoke<ProjectBriefView>("project_brief_review", { projectId, trigger });
export const projectIntentObserve = (
  projectId: string,
  sessionId: string,
  observations: ProjectIntentObservation[],
) => invoke<ProjectBriefView>("project_intent_observe", { projectId, sessionId, observations });

export type IndependentReviewVerdict = "pass" | "revise" | "needs_user" | "unavailable";

export interface IndependentReviewIssue {
  severity: string;
  title: string;
  detail: string;
  evidence: string;
  recommendation: string;
}

export interface IndependentReviewResult {
  verdict: IndependentReviewVerdict;
  summary: string;
  issues: IndependentReviewIssue[];
  evidenceChecked: string[];
  missingChecks: string[];
  revisionInstructions: string[];
  relevantToGoal: boolean;
  progressDelta?: string | null;
  criteriaSatisfied: number[];
  reviewerProvider: string;
  reviewerModel: string;
  executorProvider: string;
  executorModel: string;
  independent: boolean;
  exhausted: boolean;
}

export interface IndependentReviewEvent {
  sessionId: string;
  phase: "reviewing" | "result" | "revising" | "complete" | "cleared";
  attempt: number;
  /** Local automatic-revision index for the current reviewed turn. */
  revision?: number;
  maxRevisions: number;
  reviewerProvider?: string | null;
  reviewerModel?: string | null;
  result?: IndependentReviewResult | null;
}

export interface ChatImageInput {
  name?: string;
  mimeType: string;
  data: string;
}

export interface ChatSendRequest {
  text: string;
  images?: ChatImageInput[];
  model?: string | null;
  projectId?: string | null;
  /** Keep runtime/session traces outside project storage and discard them after each turn. */
  ephemeral?: boolean;
  /** Set only for the first local message after the user pressed Stop. */
  previousTurnCancelled?: boolean;
}

export interface ChatContextToolCall {
  id: string;
  name: string;
  input: string;
}

export interface ChatContextToolResult {
  toolUseId: string;
  toolName: string;
  output: string;
  isError?: boolean;
}

export type ChatContextMessage =
  | { role: "user"; text: string; images?: ChatImageInput[] }
  | { role: "assistant"; text?: string; toolCalls?: ChatContextToolCall[] }
  | { role: "tool"; toolResults: ChatContextToolResult[] };

export interface ChatContextUserMessage {
  text: string;
  images?: ChatImageInput[];
}

export type ChatContextSyncMode = "replace" | "append";

export const chatSend = (sessionId: string, message: string | ChatSendRequest) => {
  const request = typeof message === "string" ? { text: message } : message;
  return invoke<string>("chat_send_rich", { sessionId, request });
};

export const chatSetContext = (
  sessionId: string,
  messages: ChatContextMessage[],
  mode: ChatContextSyncMode = "replace",
) => invoke<number>("chat_set_context", { sessionId, messages, mode });
/** Current backend session-history estimate. `null` means this chat has no
 * backend session yet, so callers should retain their local fallback. */
export const chatContextTokens = (sessionId: string) =>
  invoke<number | null>("chat_context_tokens", { sessionId });
/** Rewind to the server's full context before this one unambiguous user
 * message. `null` means an older/ambiguous session must use the UI fallback. */
export const chatRewindToUserMessage = (sessionId: string, message: ChatContextUserMessage) =>
  invoke<number | null>("chat_rewind_to_user_message", { sessionId, message });
export const chatDelete = (sessionId: string, projectId?: string) =>
  invoke<void>("chat_delete", { sessionId, projectId: projectId ?? null });
export const chatCancel = (sessionId: string) => invoke<void>("chat_cancel", { sessionId });
export const chatReviewClear = (sessionId: string) =>
  invoke<void>("chat_review_clear", { sessionId });
export const chatEventsRead = (sessionId: string) =>
  invoke<ChatEventLogEntry[]>("chat_events_read", { sessionId });
export const chatEventsReplay = (sessionId: string) =>
  invoke<ChatEventsReplay>("chat_events_replay", { sessionId });
export const chatDebugZipExport = (sessionId: string, path?: string | null) =>
  invoke<string>("chat_debug_zip_export", { sessionId, path: path ?? null });

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
  handler: (t: { sessionId: string; id?: string; name: string; input: string; ready?: boolean }) => void,
) => listen<{ sessionId: string; id?: string; name: string; input: string; ready?: boolean }>("chat-tool", (e) => handler(e.payload));
export const onChatToolProgress = (
  handler: (t: { sessionId: string; id?: string; name: string } & ChatToolProgress) => void,
) =>
  listen<{ sessionId: string; id?: string; name: string } & ChatToolProgress>(
    "chat-tool-progress",
    (e) => handler(e.payload),
  );
export const onChatToolResult = (
  handler: (t: { sessionId: string; id?: string; name: string; output: string; isError: boolean }) => void,
) =>
  listen<{ sessionId: string; id?: string; name: string; output: string; isError: boolean }>(
    "chat-tool-result",
    (e) => handler(e.payload),
  );
/** A bounded automatic model retry. Error/provider payload stays in the
 * diagnostics trace; chat receives only safe lifecycle metadata. */
export interface ChatModelRetryEvent {
  sessionId: string;
  action: "retrying" | "adjusting";
  phase: "send" | "stream" | "stream_restart" | "request";
  attempt?: number | null;
  maxAttempts?: number | null;
  retriesRemaining?: number | null;
  backoffMs?: number | null;
}
export const onChatModelRetry = (handler: (event: ChatModelRetryEvent) => void) =>
  listen<ChatModelRetryEvent>("chat-model-retry", (e) => handler(e.payload));
export const onChatPermissionRequest = (handler: (event: ChatPermissionRequestEvent) => void) =>
  listen<ChatPermissionRequestEvent>("chat-permission-request", (e) => handler(e.payload));
export const onChatPermissionResolved = (handler: (event: ChatPermissionResolvedEvent) => void) =>
  listen<ChatPermissionResolvedEvent>("chat-permission-resolved", (e) => handler(e.payload));
export const onChatReview = (handler: (event: IndependentReviewEvent) => void) =>
  listen<IndependentReviewEvent>("chat-review", (e) => handler(e.payload));
export interface ChatDoneEvent {
  sessionId: string;
  text: string;
  /** Backend session-history estimate in the same unit used by the
   * auto-compaction budget. This intentionally excludes fixed prompt/tool
   * overhead and generated output. */
  contextTokens?: number | null;
  providerUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    promptTokens: number;
    totalTokens: number;
  } | null;
}
export const onChatDone = (handler: (event: ChatDoneEvent) => void) =>
  listen<ChatDoneEvent>("chat-done", (e) => handler(e.payload));
export interface ChatErrorEvent {
  sessionId: string;
  message: string;
  /** False when the backend could not durably retain the current user turn. */
  sessionPreserved?: boolean;
}
export const onChatError = (handler: (event: ChatErrorEvent) => void) =>
  listen<ChatErrorEvent>("chat-error", (e) => handler(e.payload));

export interface ChatContextCompactedEvent {
  sessionId: string;
  removedMessageCount: number;
  tokensBefore?: number | null;
  /** Post-compaction session-history estimate in the same unit used by the
   * auto-compaction budget. Absent/null leaves the transcript estimate. */
  tokensAfter?: number | null;
  /** `provider_summary_usage` when the compaction model reported output tokens,
   * otherwise `heuristic`. */
  tokensAfterSource?: string | null;
  contextWindow?: number | null;
  compactionBudget?: number | null;
}
export const onChatContextCompacted = (handler: (event: ChatContextCompactedEvent) => void) =>
  listen<ChatContextCompactedEvent>("chat-context-compacted", (e) => handler(e.payload));

export interface ChatContextWarningEvent {
  sessionId: string;
  usedTokens: number;
  contextWindow: number;
  compactionBudget?: number | null;
  usage?: number | null;
}
export const onChatContextWarning = (handler: (event: ChatContextWarningEvent) => void) =>
  listen<ChatContextWarningEvent>("chat-context-warning", (e) => handler(e.payload));

// ── Embedded VS Code runtime (Code page) ────────────────────────────────────
export const codeServerStatus = () =>
  isTauri() ? invoke<CodeServerStatus>("code_server_status") : Promise.resolve(null);
export const codeServerEnsure = (folder: string | null, language: string | null = null) =>
  // The workbench host has to be same-site with whatever origin the app is
  // actually running on: `tauri.localhost` when packaged, `127.0.0.1` under
  // `tauri dev`. Only the frontend knows which.
  //
  // `language` is SomniQ's own setting rather than the operating system's: the
  // workbench would otherwise take its display language from the host's
  // `Accept-Language`, which is a different answer for anyone whose OS and app
  // languages disagree.
  invoke<CodeServerStatus>("code_server_ensure", {
    folder,
    appHost: typeof window === "undefined" ? null : window.location.hostname,
    language,
  });
export const codeServerStop = () => invoke<CodeServerStatus>("code_server_stop");
export const onCodeServerStatus = (handler: (status: CodeServerStatus) => void) =>
  isTauri()
    ? listen<CodeServerStatus>("code-server-status", (e) => handler(e.payload))
    : Promise.resolve(noopUnlisten);

// ── VS Code bridge (aris-code-bridge extension) ─────────────────────────────
export const codeBridgeConnected = () =>
  isTauri() ? invoke<boolean>("code_bridge_connected") : Promise.resolve(false);
export const codeBridgeSetTheme = (dark: boolean, colors: Record<string, string>) =>
  isTauri() ? invoke<void>("code_bridge_set_theme", { dark, colors }) : Promise.resolve();
export const codeBridgeSaveAll = () =>
  isTauri() ? invoke<void>("code_bridge_save_all") : Promise.resolve();
export const codeBridgeReload = (paths: string[]) =>
  isTauri() ? invoke<void>("code_bridge_reload", { paths }) : Promise.resolve();
export const onCodeBridgeAsk = (handler: (ask: CodeBridgeAsk) => void) =>
  isTauri()
    ? listen<CodeBridgeAsk>("code-bridge-ask", (e) => handler(e.payload))
    : Promise.resolve(noopUnlisten);
export const onCodeBridgeConnection = (handler: (connected: boolean) => void) =>
  isTauri()
    ? listen<{ connected: boolean }>("code-bridge-connection", (e) => handler(e.payload.connected))
    : Promise.resolve(noopUnlisten);
export const onCodeBridgeActiveEditor = (handler: (editor: CodeActiveEditor) => void) =>
  isTauri()
    ? listen<CodeActiveEditor>("code-bridge-active-editor", (e) => handler(e.payload))
    : Promise.resolve(noopUnlisten);
export const codeBridgeOpenFile = (path: string) =>
  isTauri() ? invoke<void>("code_bridge_open_file", { path }) : Promise.resolve();
export const codeBridgeOpenDiff = (path: string, staged: boolean) =>
  isTauri() ? invoke<boolean>("code_bridge_open_diff", { path, staged }) : Promise.resolve(false);
