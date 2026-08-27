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
  refreshProjectBrief?: boolean;
  /** Backend session-history token estimate in the same unit as the
   * auto-compaction budget. Null/absent leaves the ring's own transcript
   * estimate in place. */
  contextTokens?: number | null;
}

// ── Settings / Skills / Sessions (P1) ─────────────────────────────────────────

export interface ConfigView {
  appVersion: string;
  configPath: string;
  /** Explicitly trusted Python/Conda environment root or interpreter path. */
  pythonEnvironmentPath?: string | null;
  executorProvider?: string | null;
  executorModel?: string | null;
  executorBaseUrl?: string | null;
  /** Model used to summarize context on compaction; empty/absent = "Auto". */
  summarizerModel?: string | null;
  /** Model used to generate retrieval cards; empty/absent follows the executor. */
  retrievalCardModel?: string | null;
  summarizerProvider?: string | null;
  summarizerBaseUrl?: string | null;
  hasSummarizerKey: boolean;
  summarizerKeyMasked?: string | null;
  hasExecutorKey: boolean;
  executorKeyMasked?: string | null;
  reviewerProvider?: string | null;
  reviewerModel?: string | null;
  reviewerBaseUrl?: string | null;
  reviewEnabled: boolean;
  hasReviewerKey: boolean;
  reviewerKeyMasked?: string | null;
  hasScopusKey: boolean;
  scopusKeyMasked?: string | null;
  hasOpenalexKey: boolean;
  openalexKeyMasked?: string | null;
  hasBraveSearchKey: boolean;
  braveSearchKeyMasked?: string | null;
  hasExaKey: boolean;
  exaKeyMasked?: string | null;
  hasZhihuAccessSecret: boolean;
  zhihuAccessSecretMasked?: string | null;
  /** Optional explicit HTTP(S) proxy for WebSearch and WebFetch; blank means direct. */
  webProxyUrl?: string | null;
  language?: string | null;
  memoryWriteApproval: boolean;
  managedModels?: string[];
  executorTransport?: string | null;
  verifiedExecutors?: {
    provider: string;
    model: string;
    baseUrl: string;
    /** Probed endpoint capability: "responses" | "chat_completions" | "" when unprobed. */
    transport?: string;
  }[];
}

export type ConfigSecretKind =
  | "executorApiKey"
  | "summarizerApiKey"
  | "reviewerApiKey"
  | "scopusApiKey"
  | "openalexApiKey"
  | "braveSearchApiKey"
  | "exaApiKey"
  | "zhihuAccessSecret";

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
  pythonEnvironmentPath?: string;
  executorProvider?: string;
  executorModel?: string;
  executorBaseUrl?: string;
  summarizerProvider?: string;
  summarizerModel?: string;
  retrievalCardModel?: string;
  summarizerBaseUrl?: string;
  summarizerApiKey?: string;
  executorApiKey?: string;
  reviewerProvider?: string;
  reviewerModel?: string;
  reviewerBaseUrl?: string;
  reviewerApiKey?: string;
  reviewEnabled?: boolean;
  scopusApiKey?: string;
  openalexApiKey?: string;
  braveSearchApiKey?: string;
  exaApiKey?: string;
  zhihuAccessSecret?: string;
  webProxyUrl?: string;
  language?: string;
  memoryWriteApproval?: boolean;
}

export interface MemoryStatusView {
  projectId: string;
  componentVersion: string;
  /** `starting` means the Session projection is still rebuilding in the background. */
  status: "starting" | "healthy";
  message?: string | null;
  dataPath: string;
  outboxPending: number;
  deadLetter: number;
  l0Count?: number | null;
  l1Count?: number | null;
  l2Count?: number | null;
  l3Count?: number | null;
  /** Atoms produced by an older extraction rule set; non-zero means a replay would change what this project remembers. */
  staleAtoms?: number | null;
}

export interface MemoryRebuildResult {
  capturesReplayed: number;
  atomsRemoved: number;
  atomsWritten: number;
  atomsPreserved: number;
}

export interface MemoryMigrationPreview {
  sessionFiles: number;
  alreadyMigrated: number;
}

export interface MemoryMigrationResult {
  importedSessions: number;
  importedMessages: number;
  skipped: number;
  cancelled: boolean;
}

export interface MemoryMigrationProgress {
  running: boolean;
  phase: string;
  completedItems: number;
  totalItems: number;
  lastError?: string | null;
}

export interface MemoryDeadLetterView {
  id: string;
  sessionId: string;
  sourceEventIds: string[];
  occurredAt: string;
  attempts: number;
  lastError: string;
  updatedAt: string;
}

export interface MemoryGovernanceHit {
  source: "l0" | "l1";
  id: string;
  content: string;
  sessionId?: string | null;
  role?: string | null;
  scoreMillis: number;
}

export interface MemoryExplorerItem {
  layer: "l0" | "l1" | "l2" | "l3";
  id: string;
  /** Human-readable name; only R2 episodes have one. */
  title?: string | null;
  content?: string | null;
  kind?: string | null;
  role?: string | null;
  sessionId?: string | null;
  path?: string | null;
  version?: string | null;
  background?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  timestamp?: string | null;
  status?: string | null;
  confidenceMillis?: number | null;
  sourceEventIds?: string[];
  artifactPaths?: string[];
  supersedesId?: string | null;
}

export type MemoryRecallLayerCode = "R0" | "R1" | "R2" | "R3";

export interface MemoryRecallLayer {
  code: MemoryRecallLayerCode;
  /** Null for R0, which receives whatever the derived layers leave behind. */
  quotaChars: number | null;
  usedChars: number;
  admitted: number;
  skipped: number;
}

export interface MemoryRecallEntry {
  layer: MemoryRecallLayerCode;
  label: string;
  text: string;
  chars: number;
  anchor: boolean;
  sourceSessionId?: string | null;
}

export interface MemoryRecallSkip {
  layer: MemoryRecallLayerCode;
  label: string;
  reason: "duplicate" | "budget" | "not_standing";
  text: string;
}

export interface MemoryRecallReport {
  budgetChars: number;
  usedChars: number;
  layers: MemoryRecallLayer[];
  entries: MemoryRecallEntry[];
  skipped: MemoryRecallSkip[];
}

export interface MemoryRecallPreview {
  projectId: string;
  query: string;
  report: MemoryRecallReport;
  rendered: string;
  empty: boolean;
  candidateAtoms: number;
  candidateCards: number;
  candidateSessions: number;
  latencyMs: number;
}

export interface MemoryExplorerSnapshot {
  projectId: string;
  loadedAt: string;
  l0: MemoryExplorerItem[];
  l1: MemoryExplorerItem[];
  l2: MemoryExplorerItem[];
  l3?: MemoryExplorerItem | null;
  l0Total: number;
  l1Total: number;
  l2Total: number;
  l3Total: number;
  partialErrors: string[];
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

// ── Remote control (P0/P1) ────────────────────────────────────────────────

export type RemoteScope =
  | "read_project_state"
  | "read_task_timeline"
  | "send_chat_messages"
  | "stop_runs"
  | "read_review_conclusions"
  | "compute_jobs";

export interface RemoteDevice {
  id: string;
  /** Endpoint class projected from the signed v1 transport descriptor. */
  kind: "desktop" | "mobile" | "compute_node";
  label: string;
  fingerprint: string;
  scopes: RemoteScope[];
  pairedAt: number;
  lastSeenAt?: number | null;
  revokedAt?: number | null;
}

export interface RemoteControlStatus {
  enabled: boolean;
  gatewayUrl?: string | null;
  deviceId?: string | null;
  deviceName?: string | null;
  /** Explicit public STUN endpoints used for direct P2P candidate gathering. */
  iceServers: string[];
  pairedDeviceCount: number;
  activeDeviceCount: number;
}

export interface RemotePairingInvitation {
  pairingId: string;
  expiresAt: number;
  qrCodeDataUrl: string;
  pairingLink?: string;
}

/** One managed endpoint invitation. A phone scans the QR while another
 * computer may paste the equivalent pairing link. */
export interface RemoteInvitationResult {
  status: RemoteControlStatus;
  pairing: RemotePairingInvitation;
}

export interface RemotePendingPairing {
  pairingId: string;
  claimId: string;
  deviceId: string;
  kind: "desktop" | "mobile" | "compute_node";
  label: string;
  fingerprint: string;
  requestedScopes: RemoteScope[];
  requestedAt: number;
}

export interface RemotePairingApprovalInput {
  pairingId: string;
}

export interface RemoteAuditEntry {
  timestamp: number;
  deviceId: string;
  requestId: string;
  action: string;
  transport: string;
  projectId?: string | null;
  outcome: string;
  errorCode?: string | null;
}

// ── Durable local / remote compute jobs ─────────────────────────────────────

export type ComputeJobStatus =
  | "queued"
  | "preparing"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "lost";

export type ComputeLogStream = "stdout" | "stderr" | "system";

export type ComputeWorkload =
  | { kind: "command"; executable: string; args?: string[] }
  | { kind: "python"; entrypoint: string; args?: string[]; interpreter?: string | null }
  | {
      kind: "notebook";
      notebook_path: string;
      kernel?: string | null;
      parameters?: Record<string, unknown>;
      stop_on_error?: boolean;
    };

export interface ComputeResourceLimits {
  timeoutSecs: number;
  maxOutputBytes?: number | null;
  maxArtifactBytes?: number | null;
}

export interface ComputeJobRequest {
  protocolVersion: number;
  jobId: string;
  projectId: string;
  displayName: string;
  workload: ComputeWorkload;
  workingDirectory: string;
  environment: Record<string, string>;
  artifactGlobs: string[];
  limits: ComputeResourceLimits;
  sourceDigest?: string | null;
  inputBundleDigest?: string | null;
}

export type ComputeTarget =
  | { kind: "local" }
  | { kind: "remote"; node_id: string; node_name: string };

export interface ComputeArtifact {
  path: string;
  sizeBytes: number;
  sha256: string;
  mediaType?: string | null;
}

export interface ComputeResultManifest {
  jobId: string;
  status: ComputeJobStatus;
  exitCode?: number | null;
  startedAtUnixMs?: number | null;
  finishedAtUnixMs: number;
  durationMs?: number | null;
  stdoutBytes: number;
  stderrBytes: number;
  artifacts: ComputeArtifact[];
  metrics: Record<string, unknown>;
  error?: string | null;
  workerDeviceId?: string | null;
  workerName?: string | null;
  environmentFingerprint?: string | null;
}

export interface ComputeJobRecord {
  protocolVersion: number;
  request: ComputeJobRequest;
  target: ComputeTarget;
  status: ComputeJobStatus;
  createdAtUnixMs: number;
  updatedAtUnixMs: number;
  startedAtUnixMs?: number | null;
  finishedAtUnixMs?: number | null;
  lastSequence: number;
  result?: ComputeResultManifest | null;
}

export type ComputeJobEventPayload =
  | { kind: "status"; status: ComputeJobStatus; message?: string | null }
  | { kind: "log"; stream: ComputeLogStream; text: string; offset: number }
  | { kind: "metric"; name: string; value: unknown }
  | { kind: "artifact"; artifact: ComputeArtifact }
  | { kind: "completed"; result: ComputeResultManifest };

export interface ComputeJobEvent {
  protocolVersion: number;
  jobId: string;
  sequence: number;
  emittedAtUnixMs: number;
  payload: ComputeJobEventPayload;
}

export interface ComputeNodeCapabilities {
  nodeId: string;
  displayName: string;
  platform: string;
  architecture: string;
  logicalCpus: number;
  supportsCommand: boolean;
  supportsPython: boolean;
  supportsNotebook: boolean;
  maxParallelJobs: number;
  workerVersion: string;
}

export interface ComputeNodeConfig {
  acceptRemoteJobs: boolean;
  acceptRemoteAgentChats: boolean;
  maxParallelJobs: number;
  /** Whether this computer generates images for users it has never paired
   * with. Separate from the two switches above: those admit machines the same
   * person owns, while this one admits strangers and spends the local user's
   * own ChatGPT quota. */
  acceptImageHelp: boolean;
  /** Brokered images this computer will generate per local day. There is no
   * matching parallelism setting: Oracle serializes browser jobs, so brokered
   * concurrency is one. */
  imageHelpDailyLimit: number;
  /** Ask another user to generate images even though this computer has a
   * ChatGPT account of its own. Off by default; the local account wins unless
   * the user explicitly chooses otherwise. */
  preferImageHelp: boolean;
}

export interface ComputePeer {
  endpointId: string;
  nodeId: string;
  displayName: string;
  gatewayUrl: string;
  connected: boolean;
  transport?: string | null;
  platform?: string | null;
  architecture?: string | null;
  logicalCpus?: number | null;
  pairedAtUnixMs: number;
  lastSeenAtUnixMs?: number | null;
  direction: "claimed" | "invited";
  agentChatAuthorized: boolean;
}

export interface ComputePeerEvent {
  nodeId: string;
  connected: boolean;
  transport?: string | null;
}

export interface ComputePairingClaim {
  pairingId: string;
  desktopName: string;
  status: "awaiting_approval" | "completed";
  completionExpiresAtUnixMs: number;
}

export interface RemoteAgentProject {
  projectId: string;
  title: string;
  phase: string;
  isActive: boolean;
}

export interface RemoteAgentWorkspace {
  nodeId: string;
  nodeName: string;
  projects: RemoteAgentProject[];
}

export interface RemoteAgentSession {
  nodeId: string;
  nodeName: string;
  projectId: string;
  projectName: string;
  sessionId: string;
  title: string;
  model?: string | null;
  updatedAtUnixMs: number;
}

export interface RemoteAgentSessions {
  nodeId: string;
  nodeName: string;
  projectId: string;
  projectName: string;
  sessions: RemoteAgentSession[];
  hasMore: boolean;
}

export interface RemoteAgentModelSelection {
  nodeId: string;
  projectId: string;
  sessionId: string;
  model?: string | null;
  options: ChatModelOption[];
}

export type RemoteAgentTranscriptBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; thinking: string }
  | {
      kind: "tool";
      id?: string | null;
      name: string;
      input: string;
      output?: string | null;
      isError?: boolean | null;
      progress?: ChatToolProgress | null;
    };

export interface RemoteAgentTranscriptMessage {
  role: "user" | "assistant";
  blocks: RemoteAgentTranscriptBlock[];
}

export interface RemoteAgentTranscript {
  nodeId: string;
  nodeName: string;
  projectId: string;
  projectName: string;
  sessionId: string;
  title: string;
  updatedAtUnixMs: number;
  messages: RemoteAgentTranscriptMessage[];
  hasMore: boolean;
  model?: string | null;
  modelOptions: ChatModelOption[];
}

export interface ComputeSubmitInput {
  displayName: string;
  workload: ComputeWorkload;
  workingDirectory?: string;
  environment?: Record<string, string>;
  artifactGlobs?: string[];
  timeoutSecs?: number | null;
  maxOutputBytes?: number | null;
  maxArtifactBytes?: number | null;
  targetNodeId?: string | null;
}

/** Gateway-to-renderer WebRTC offer. It contains negotiation metadata only;
 * encrypted control payloads remain opaque `SecureEnvelope` binary frames. */
export interface RemoteP2pOffer {
  deviceId: string;
  sessionId: string;
  sdp: string;
  iceServers: string[];
  /** True when this session was brokered between two users who never paired.
   * The bridge then suppresses host and mDNS candidates so a stranger never
   * learns this machine's internal network. Paired sessions keep every
   * candidate: both machines belong to one person, and dropping host
   * candidates there would push same-LAN peers onto STUN or the relay for no
   * privacy gain. */
  brokered?: boolean;
}

export interface RemoteP2pStart {
  deviceId: string;
  sessionId: string;
  iceServers: string[];
  /** See {@link RemoteP2pOffer.brokered}. */
  brokered?: boolean;
}

export interface RemoteP2pIceCandidate {
  deviceId: string;
  sessionId: string;
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

/** Recovery snapshot used when an offer arrived before the desktop WebView
 * finished registering its Tauri event listeners. */
export interface RemoteP2pPendingSnapshot {
  starts: RemoteP2pStart[];
  offers: RemoteP2pOffer[];
  answers: RemoteP2pAnswerInput[];
  candidates: RemoteP2pIceCandidate[];
  iceCompletes: RemoteP2pSessionInput[];
}

export interface RemoteP2pSessionInput {
  deviceId: string;
  sessionId: string;
}

export interface RemoteP2pAnswerInput extends RemoteP2pSessionInput {
  sdp: string;
}

export interface RemoteP2pOfferInput extends RemoteP2pSessionInput {
  sdp: string;
}

export interface RemoteP2pIceCandidateInput extends RemoteP2pSessionInput {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export type RemoteP2pFailureReason =
  | "ice_timeout"
  | "ice_failed"
  | "negotiation_failed"
  | "data_channel_failed"
  | "cancelled";

export interface RemoteP2pFailureInput extends RemoteP2pSessionInput {
  reason: RemoteP2pFailureReason;
}

export interface RemoteP2pDataInput extends RemoteP2pSessionInput {
  dataBase64: string;
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
  configPath: string;
  servers: McpStdioServerInput[];
  mergedServers: McpServerSummary[];
  managedServers: ManagedMcpServerSummary[];
  presets: McpPresetSummary[];
  verification?: McpVerificationView | null;
}

export interface McpVerificationView {
  testedAt: number;
  result: McpTestResult;
}

export interface McpPresetSummary {
  id: string;
  available: boolean;
  message: string;
  /** Actual bundled launcher path, or the path the installation should contain when missing. */
  installPath?: string | null;
  server?: McpStdioServerInput | null;
}

export interface ManagedMcpServerSummary {
  name: string;
  source: "managed" | string;
  transport: string;
  command?: string | null;
  status: "ready" | "missing" | "incompatible" | string;
  message: string;
  installSupported: boolean;
  capabilities: string[];
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

export interface OracleBrowserView {
  id: string;
  name: string;
  kind: string;
  path: string;
  recommended: boolean;
}

export interface OracleRuntimeView {
  status: "ready" | "missing" | "incompatible" | string;
  source: "managed" | "system" | "environment" | "none" | string;
  version?: string | null;
  commandPath?: string | null;
  nodePath?: string | null;
  installSupported: boolean;
  message: string;
}

export interface OracleWebAccountView {
  id: string;
  displayName: string;
  browserName: string;
  browserKind: string;
  browserPath: string;
  profilePath: string;
  createdAt: number;
  lastLoginLaunchedAt?: number | null;
  loginConfirmedAt?: number | null;
  /** The account-level ChatGPT browser model, or the model currently selected in ChatGPT. */
  model?: string | null;
}

export interface OracleWebStatusView {
  runtime: OracleRuntimeView;
  browsers: OracleBrowserView[];
  accounts: OracleWebAccountView[];
  consultAccountId?: string | null;
  reviewerAccountId?: string | null;
  imageAccountId?: string | null;
  dataDir: string;
}

export interface OracleWebAccountCreateInput {
  displayName: string;
  browserPath: string;
}

export interface OracleWebRoleSetInput {
  role: "consult" | "reviewer" | "image";
  accountId?: string | null;
}

export interface OracleWebAccountModelSetInput {
  accountId: string;
  model?: string | null;
}

export interface OracleWebLoginLaunchView {
  account: OracleWebAccountView;
  pid: number;
  message: string;
}

export interface OracleWebImageArtifactView {
  path: string;
  mimeType: string;
  sizeBytes: number;
  width?: number | null;
  height?: number | null;
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

/** Live state of the one notice that stands in for a burst of automatic model
 * retries. A flaky connection fires one event per attempt and per request in
 * the turn, so the notice is updated in place and counts itself instead of
 * stacking one banner per attempt. */
export interface NoticeRetryState {
  /** Attempt now being made, when the provider reports a bounded count. */
  attempt?: number;
  maxAttempts?: number;
  /** Automatic retries left, for providers reporting a remaining count. */
  remaining?: number;
  /** Epoch ms when the backoff ends; drives the rendered countdown. */
  resumeAt?: number;
  /** Retries this notice has absorbed since it appeared. */
  count: number;
}

// Ordered blocks within an assistant turn – rendered in arrival order so
// "text → tool → text → tool → final text" displays correctly.
export type ChatBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; thinking: string }
  | { kind: "notice"; message: string; retry?: NoticeRetryState }
  | {
      kind: "review";
      phase: "reviewing" | "result" | "revising" | "complete";
      attempt: number;
      revision?: number;
      maxRevisions: number;
      reviewerProvider?: string;
      reviewerModel?: string;
      verdict?: "pass" | "revise" | "needs_user" | "unavailable";
    }
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
      progress?: ChatToolProgress;
      /** AskUserQuestion only: backend answer channel is registered. */
      ready?: boolean;
    };

export interface ChatToolProgress {
  elapsedMs: number;
  timeoutMs?: number | null;
  pid?: number | null;
  stdoutTail?: string | null;
  stderrTail?: string | null;
  nearTimeout?: boolean;
  message?: string;
}

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
  /** Product-owned transcript entries are visible but cannot be edited/retried. */
  readOnly?: boolean;
  omittedTurnIndex?: number;
  omittedBytes?: number;
  streaming?: boolean;
  error?: string;
  stopped?: boolean;
  attachments?: ChatAttachment[];
}

export interface ChatReasoningEffortView {
  supported: boolean;
  applied: boolean;
  effort: string;
  transport: string;
  message?: string | null;
}

export interface ChatEventLogEntry {
  version: number;
  seq: number;
  ts: number;
  sessionId: string;
  kind: string;
  payload: unknown;
}

export interface ChatEventsReplay {
  sessionId: string;
  eventCount: number;
  lastSeq: number;
  turns: ChatTurn[];
}

/** One day's aggregated activity, for the Profile Token-activity heatmap. */
export interface ProfileDailyBucket {
  /** Local calendar date, `YYYY-MM-DD`. */
  date: string;
  tokens: number;
  turns: number;
}

export interface ProfileModelUsage {
  model: string;
  provider: string;
  tokens: number;
  turns: number;
}

export interface ProfileSkillCount {
  name: string;
  runs: number;
}

/**
 * Aggregated local telemetry for the Settings → Profile page. Derived from
 * `usage-log.jsonl` (tokens/heatmap/streaks/models) plus best-effort session
 * event logs (skills/tools). Fields that the app does not yet track are
 * `null`, so the UI can fall back gracefully instead of showing fake data.
 */
export interface ProfileStats {
  cumulativeTokens: number;
  peakDailyTokens: number;
  totalTurns: number;
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
  /** Longest single task in seconds; `null` until turn-duration telemetry accrues. */
  longestTaskSeconds: number | null;
  /** Chronological daily buckets (up to ~53 weeks) for the heatmap. */
  daily: ProfileDailyBucket[];
  byModel: ProfileModelUsage[];
  topSkills: ProfileSkillCount[];
  skillsExplored: number;
  toolCalls: number;
  /** `null` until reasoning-effort telemetry accrues. */
  topReasoningEffort: string | null;
  /** Whether the runtime meta event log is populated (drives skill/tool stats). */
  metaLoggingEnabled: boolean;
  /** Epoch seconds of the earliest recorded activity, or `null` when empty. */
  since: number | null;
}

/** Lifecycle of the embedded VS Code runtime (`code_server_status`). */
export type CodeServerPhase =
  | "idle"
  | "downloading"
  | "extracting"
  | "extensions"
  | "starting"
  | "ready"
  | "failed";

export interface CodeServerStatus {
  phase: CodeServerPhase;
  version: string;
  /** Whether the runtime is on disk. Independent of `phase`. */
  installed: boolean;
  port: number | null;
  /**
   * Workbench URL for the iframe, including the connection token. Only set at
   * `ready`. Always addresses `code.tauri.localhost` rather than `127.0.0.1`
   * so the server's `SameSite=Lax` token cookie is same-site with the app.
   */
  url: string | null;
  message: string | null;
  downloadedBytes: number;
  totalBytes: number;
}

/** Payload of the `code-bridge-ask` event (see `codebridge.rs`). */
export interface CodeBridgeAsk {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  languageId: string;
  /** The selection was cut to fit; say so rather than passing off a fragment. */
  truncated: boolean;
}

/** Payload of the `code-bridge-active-editor` event. */
export interface CodeActiveEditor {
  /** `null` when nothing file-backed is focused in the workbench. */
  path: string | null;
  isNotebook: boolean;
}
