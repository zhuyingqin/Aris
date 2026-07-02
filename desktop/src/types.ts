// Shared JSON shapes used by the desktop frontend.

export interface DesktopCommandSpec {
  name: string;
  description: string;
  argumentHint?: string | null;
}

export interface ChatCommandSelectionItem {
  value: string;
  label: string;
  description?: string | null;
  isCurrent: boolean;
}

export interface ChatCommandSelection {
  command: string;
  title: string;
  subtitle?: string | null;
  current?: string | null;
  items: ChatCommandSelectionItem[];
}

export interface ChatCommandResult {
  handled: boolean;
  message?: string | null;
  prompt?: string | null;
  selection?: ChatCommandSelection | null;
  replaceTurns: boolean;
  openSettings: boolean;
  refreshStatus: boolean;
  /** Backend session-history token estimate in the same unit as the
   * auto-compaction budget. Null/absent leaves the ring's own transcript
   * estimate in place. */
  contextTokens?: number | null;
}

// ── Settings / Skills / Sessions (P1) ─────────────────────────────────────────

export interface ConfigView {
  appVersion: string;
  configPath: string;
  executorProvider?: string | null;
  executorModel?: string | null;
  executorBaseUrl?: string | null;
  /** Model used to summarize context on compaction; empty/absent = "Auto". */
  summarizerModel?: string | null;
  summarizerProvider?: string | null;
  summarizerBaseUrl?: string | null;
  hasSummarizerKey: boolean;
  summarizerKeyMasked?: string | null;
  hasExecutorKey: boolean;
  executorKeyMasked?: string | null;
  reviewerProvider?: string | null;
  reviewerModel?: string | null;
  reviewerBaseUrl?: string | null;
  hasReviewerKey: boolean;
  reviewerKeyMasked?: string | null;
  hasScopusKey: boolean;
  scopusKeyMasked?: string | null;
  language?: string | null;
  memoryWriteApproval: boolean;
  managedModels?: string[];
  verifiedExecutors?: { provider: string; model: string; baseUrl: string }[];
}

export type ConfigSecretKind = "executorApiKey" | "summarizerApiKey" | "reviewerApiKey" | "scopusApiKey";

export interface ScheduledTask {
  id: string;
  title: string;
  scheduleLabel?: string;
  status?: string; // "active" | "paused"
  sessionId?: string | null;
  model?: string | null;
  prompt?: string;
  rrule?: string;
  intervalValue?: number;
  intervalUnit?: "minutes" | "hours" | "days" | string;
  createdAt?: string | null;
  updatedAt?: string | null;
  lastRunAt?: string | null;
  lastError?: string | null;
  nextRun?: string | null;
  triggerKind?: "interval" | "mail" | string;
  mailAccountId?: string;
  mailKeywords?: string[];
}

export interface ScheduledTaskInput {
  title: string;
  prompt: string;
  sessionId: string;
  model?: string;
  intervalValue: number;
  intervalUnit: "minutes" | "hours" | "days";
  status?: "active" | "paused";
  triggerKind?: "interval" | "mail";
  mailAccountId?: string;
  mailKeywords?: string[];
}

export interface ConfigPatch {
  executorProvider?: string;
  executorModel?: string;
  executorBaseUrl?: string;
  summarizerProvider?: string;
  summarizerModel?: string;
  summarizerBaseUrl?: string;
  summarizerApiKey?: string;
  executorApiKey?: string;
  reviewerProvider?: string;
  reviewerModel?: string;
  reviewerBaseUrl?: string;
  reviewerApiKey?: string;
  scopusApiKey?: string;
  language?: string;
  memoryWriteApproval?: boolean;
}

export interface ConfigTestDetail {
  ok: boolean;
  label: string;
  provider?: string | null;
  model?: string | null;
  baseUrl?: string | null;
  message: string;
}

export interface ConfigTestResult {
  ok: boolean;
  message: string;
  executor: ConfigTestDetail;
  reviewer?: ConfigTestDetail | null;
}

export interface LocalEnvironmentCheck {
  id: string;
  label: string;
  category: string;
  status: "ready" | "warning" | "missing" | string;
  available: boolean;
  version?: string | null;
  path?: string | null;
  message: string;
  detail?: string | null;
}

export interface AppUpdateInfo {
  available: boolean;
  currentVersion?: string;
  version?: string;
  date?: string;
  body?: string;
}

export interface AppUpdateProgress {
  stage: "started" | "progress" | "finished";
  downloadedBytes: number;
  contentLength?: number | null;
  percent?: number | null;
}

export interface AppUpdateInstallResult {
  installed: boolean;
  version?: string;
}

export interface TokenUsageBucket {
  server: string;
  model: string;
  provider: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  promptTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export interface TokenUsageServerBucket {
  server: string;
  provider: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  promptTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  byModel: TokenUsageBucket[];
}

export interface TokenUsageLogEntry {
  createdAt: number;
  sessionId: string;
  server: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  promptTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export interface TokenUsageSummary {
  logPath: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  promptTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  unpricedRequests: number;
  byServer: TokenUsageServerBucket[];
  byModel: TokenUsageBucket[];
  recent: TokenUsageLogEntry[];
}

// ── Mail (Gmail API + Microsoft Graph) ───────────────────────────────────────

export type MailProvider = "gmail" | "outlook" | "imap";

export interface MailAccount {
  id: string;
  provider: MailProvider;
  email: string;
  displayName: string;
  connected: boolean;
}

export interface MailFolder {
  id: string;
  name: string;
  /** inbox | sent | drafts | trash | spam | archive | starred | important |
   *  promotions | social | updates | forums | custom */
  kind: string;
  unreadCount: number;
}

export interface MailMessageSummary {
  id: string;
  threadId: string;
  from: string;
  fromName: string;
  to: string;
  subject: string;
  snippet: string;
  date: string;
  unread: boolean;
  starred: boolean;
  hasAttachments: boolean;
  labels: string[];
}

export interface MailMessageList {
  messages: MailMessageSummary[];
  nextPageToken?: string | null;
}

export interface MailNewMessageEvent {
  accountId: string;
  provider: MailProvider;
  folder: string;
  message: MailMessageSummary;
  detectedAt: number;
}

export interface MailAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface MailMessageFull {
  id: string;
  threadId: string;
  from: string;
  fromName: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  unread: boolean;
  starred: boolean;
  labels: string[];
  bodyHtml?: string | null;
  bodyText: string;
  attachments: MailAttachment[];
}

export interface MailModifyPatch {
  unread?: boolean;
  starred?: boolean;
  archive?: boolean;
  trash?: boolean;
  moveTo?: string;
}

export interface MailDraft {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  attachments?: MailDraftAttachment[];
}

export interface MailDraftAttachment {
  path: string;
  filename?: string;
  mimeType?: string;
}

export interface MailOauthConfigView {
  gmailClientId: string;
  gmailHasSecret: boolean;
  outlookConfigured: boolean;
  outlookUsesBundledClient: boolean;
  outlookClientId: string;
}

export interface MailOauthConfigPatch {
  gmailClientId?: string;
  gmailClientSecret?: string;
  outlookClientId?: string;
}

export type MailSocketSecurity = "tls" | "starttls" | "none";

export interface GenericMailAccountInput {
  email: string;
  displayName?: string;
  imapHost: string;
  imapPort: number;
  imapSecurity: MailSocketSecurity;
  imapUsername: string;
  imapPassword: string;
  smtpEnabled: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecurity?: MailSocketSecurity;
  smtpUsername?: string;
  smtpPassword?: string;
}

export interface GenericMailTestResult {
  ok: boolean;
  imapOk: boolean;
  smtpOk: boolean;
  message: string;
}

export interface MailAutoconfigResult {
  source: string;
  displayName: string;
  imapHost: string;
  imapPort: number;
  imapSecurity: MailSocketSecurity;
  imapUsername: string;
  smtpEnabled: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: MailSocketSecurity;
  smtpUsername: string;
  notes: string[];
}

export interface ConnectorPluginView {
  id: string;
  connectorId: string;
  provider: MailProvider | string;
  version: string;
  displayName: string;
  shortDescription: string;
  longDescription: string;
  developerName: string;
  category: string;
  capabilities: string[];
  websiteUrl?: string | null;
  privacyPolicyUrl?: string | null;
  termsOfServiceUrl?: string | null;
  brandColor?: string | null;
  required: boolean;
  installed: boolean;
  connected: boolean;
  connectedAccounts: string[];
  transport: string;
  statusMessage: string;
}

export interface ConnectorActionResult {
  ok: boolean;
  message: string;
  plugin: ConnectorPluginView;
}

export interface PermissionModeView {
  mode: "read-only" | "workspace-write" | "danger-full-access" | string;
  label: string;
  description: string;
}

export interface McpStdioServerInput {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  requestTimeoutSecs?: number | null;
}

export interface McpServerSummary {
  name: string;
  source: string;
  transport: string;
  command?: string | null;
}

export interface McpConfigView {
  projectPath: string;
  servers: McpStdioServerInput[];
  mergedServers: McpServerSummary[];
}

export interface McpServerTestResult {
  name: string;
  ok: boolean;
  transport: string;
  tools: string[];
  message: string;
}

export interface McpTestResult {
  ok: boolean;
  servers: McpServerTestResult[];
}

export interface DesktopProject {
  id: string;
  name: string;
  path: string;
  addedAt: number;
  lastOpenedAt: number;
}

export interface ProjectView {
  projects: DesktopProject[];
  currentProject: DesktopProject;
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
  contextWindow?: number | null;
  compactionBudget?: number | null;
  memoryFiles?: number | null;
}

export interface SystemPromptView {
  model: string;
  fullToolRegistry: boolean;
  sections: number;
  characters: number;
  prompt: string;
}

export interface UserPromptView {
  sessionId: string;
  surface: string;
  capturedAt: number;
  blocks: number;
  images: number;
  characters: number;
  prompt: string;
}

export interface ChatModelOption {
  value: string;
  label: string;
  description?: string | null;
}

export interface ChatModelOptions {
  provider: string;
  current: string;
  options: ChatModelOption[];
}

// Ordered blocks within an assistant turn – rendered in arrival order so
// "text → tool → text → tool → final text" displays correctly.
export type ChatBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; thinking: string }
  | { kind: "notice"; message: string }
  | {
      kind: "permission";
      id: string;
      toolName: string;
      input: string;
      currentMode: string;
      requiredMode: string;
      status?: "pending" | "allowed" | "skipped";
    }
  | {
      kind: "tool";
      id?: string;
      name: string;
      input: string;
      output?: string;
      isError?: boolean;
    };

// A single step of a TodoWrite plan, surfaced as the floating workflow box.
export type ChatTodoStatus = "pending" | "in_progress" | "completed";

export interface ChatTodoItem {
  content: string;
  activeForm: string;
  status: ChatTodoStatus;
}

export type ChatFileChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface ChatFileChange {
  path: string;
  status: ChatFileChangeStatus;
  sourceTool?: string;
}

export interface ChatAttachment {
  id: string;
  kind: "file" | "image";
  name: string;
  path?: string;
  mimeType?: string;
  content?: string;
  preview?: string;
}

export interface ChatTurn {
  id: string;
  role: "user" | "assistant";
  blocks: ChatBlock[];
  streaming?: boolean;
  error?: string;
  stopped?: boolean;
  attachments?: ChatAttachment[];
}
