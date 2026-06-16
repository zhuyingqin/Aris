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
  hasScopusKey: boolean;
  scopusKeyMasked?: string | null;
  language?: string | null;
  memoryWriteApproval: boolean;
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

export interface ImBridgeView {
  configPath: string;
  skillDir?: string | null;
  daemonPath?: string | null;
  configured: boolean;
  running: boolean;
  pid?: number | null;
  channels: string[];
  runtime: string;
  enabled: boolean;
  defaultWorkdir: string;
  arisPath: string;
  qqAppId: string;
  hasQqAppSecret: boolean;
  qqAppSecretMasked?: string | null;
  qqAllowedUsers: string;
  qqImageEnabled: boolean;
  qqMaxImageSize: number;
  autoApprove: boolean;
  statusMessage: string;
  recentLog?: string | null;
}

export interface ImBridgePatch {
  enabled?: boolean;
  runtime?: string;
  defaultWorkdir?: string;
  arisPath?: string;
  qqAppId?: string;
  qqAppSecret?: string;
  qqAllowedUsers?: string;
  qqImageEnabled?: boolean;
  qqMaxImageSize?: number;
  autoApprove?: boolean;
}

export interface ImBridgeTestResult {
  ok: boolean;
  tokenOk: boolean;
  gatewayOk: boolean;
  message: string;
}

export interface ImBridgeActionResult {
  ok: boolean;
  message: string;
  output: string;
  view: ImBridgeView;
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
  memoryFiles?: number | null;
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
