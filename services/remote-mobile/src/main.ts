import "./styles.css";

import {
  Check,
  ChevronDown,
  createIcons,
  Folder,
  MessageSquareText,
  PanelLeft,
  Plus,
  RefreshCw,
  SendHorizontal,
  Settings2,
  Square,
  SquarePen,
  Wifi,
  X,
} from "lucide";
import { mobileBasePathUrl, normalizeMobileBasePath } from "./basePath";
import { BrowserTicketedSocketFactory } from "./browserSocket";
import {
  chatMessageProgress,
  chatMessageStopRequested,
  chatMessageTerminal,
  chatQuestionAnswered,
  chatSessionEventsFromResponse,
  chatSessionCreatedFromResponse,
  encodeControlRequest,
  MOBILE_P1_REQUESTABLE_SCOPES,
  newAnswerChatQuestionRequest,
  newChatModelOptionsRequest,
  newCreateChatSessionRequest,
  newChatTranscriptRequest,
  newChatEventsRequest,
  newChatMessageRequest,
  newListChatSessionsRequest,
  newSetActiveProjectRequest,
  newSetChatSessionModelRequest,
  newStopChatMessageRequest,
  newWorkspaceOverviewRequest,
  parseControlResponse,
  type ControlRequest,
  type ControlResponse,
  type ChatMessageActivity,
  type ChatSessionEvent,
} from "./control";
import {
  applyChatMessageEvent,
  latestThinkingBlockIndex,
  remoteTranscriptMessageFromWire,
  type RemoteChatBlock,
  type RemoteTranscriptMessage,
} from "./chatBlocks";
import {
  anchoredScrollTop,
  olderTranscriptPrefix,
  shouldFollowChatLogBottom,
} from "./chatHistory";
import { WebCryptoMobileIdentity, IndexedDbIdentityStore } from "./crypto";
import { desktopDisplayLabel, desktopShortCode } from "./deviceLabels";
import { SecureEnvelopeCodec } from "./envelope";
import { GatewayApi, GatewayApiError, type ClaimedPairing } from "./gateway";
import { parsePairingInvitation } from "./protocol";
import {
  BrowserQrCameraScanner,
  pairingPayloadFromDeepLinkFragment,
  pairingPayloadFromQrContent,
  readPairingQrImage,
} from "./qr";
import { BrowserPairedSessionStore } from "./sessionStore";
import { P2pFirstTransport, type TransportState } from "./transport";
import type { DeviceDescriptor, PairedMobileSession } from "./types";
import { newestChatSessionId, type ChatSessionCandidate } from "./chatSessionNavigation";
import {
  chatModelStateFromResponse,
  type RemoteChatModelState,
} from "./chatModelNavigation";
import { renderRemoteMarkdown } from "./remoteMarkdown";
import { isSoftwareKeyboardOpen } from "./mobileViewport";
import { ForegroundResumeCoordinator } from "./foregroundResume";
import { ChatEventCursorStore } from "./chatEventCursor";
import { ReconnectBackoff } from "./reconnectBackoff";
import {
  ASK_USER_QUESTION_TOOL,
  composeQuestionAnswer,
  parseRemoteQuestionSpec,
} from "./questionPrompt";
import {
  isStandalonePairingContainer,
  pairingBrowserContext,
  pairingBrowserContextLabel,
} from "./pairingContext";
import {
  workspaceOverviewFromResponse,
  type RemoteWorkspaceCapability,
  type RemoteWorkspaceProject,
} from "./workspaceNavigation";

const MOBILE_BASE_PATH = normalizeMobileBasePath(import.meta.env.BASE_URL);

const app = document.querySelector<HTMLElement>("#app");
if (!app) {
  throw new Error("SomniQ Remote could not find its application root.");
}

app.innerHTML = `
  <main class="remote-app" aria-labelledby="title">
    <header class="brand-header">
      <img class="brand-mark" src="${mobileBasePathUrl("icon.png", MOBILE_BASE_PATH)}" alt="" width="44" height="44" />
      <div>
        <p class="eyebrow">SomniQ Studio</p>
        <h1 id="title">SomniQ Remote</h1>
      </div>
    </header>
    <p class="lede">在手机上安全查看这台电脑的研究工作区，并继续桌面对话。</p>

    <ol class="flow-steps" aria-label="远程连接步骤">
      <li data-flow-step="scan">1 扫码配对</li>
      <li data-flow-step="approval">2 电脑批准</li>
      <li data-flow-step="connect">3 安全连接</li>
    </ol>

    <section id="scan-panel" class="card" hidden aria-labelledby="scan-title">
      <div class="card-heading">
        <div>
          <h2 id="scan-title">扫描电脑二维码</h2>
          <p>在电脑 SomniQ 的「远程控制」中显示二维码，然后使用手机系统相机扫描。</p>
        </div>
      </div>
      <div id="camera-preview" class="camera-preview" hidden>
        <video id="qr-camera" autoplay muted playsinline aria-label="二维码相机预览"></video>
        <span class="camera-scan-frame" aria-hidden="true"></span>
      </div>
      <div class="scan-actions">
        <button id="start-camera" class="primary-button" type="button">打开相机扫码</button>
        <button id="stop-camera" class="text-button" type="button" hidden>关闭相机</button>
      </div>
      <p class="scan-or">或</p>
       <button id="choose-qr-image" class="secondary-button file-button" type="button">从相册选择二维码</button>
       <input id="qr-image" type="file" accept="image/*" hidden />
       <button id="discard-mismatched-pairing" class="text-button" type="button" hidden>重置此应用并重新配对</button>
       <button id="cancel-add-device" class="text-button" type="button" hidden>取消添加设备</button>
       <p class="hint">二维码仅用于一次性配对，不会显示或保存其内容。</p>
    </section>

    <section id="pairing-panel" class="card" hidden aria-labelledby="pairing-title">
      <div class="card-heading">
        <div>
          <h2 id="pairing-title">确认配对</h2>
          <p>将向这台电脑请求查看研究状态与继续桌面对话的权限。</p>
        </div>
      </div>
      <div class="device-summary">
        <span class="device-summary-label">电脑</span>
        <strong id="pairing-desktop"></strong>
      </div>
      <p id="pairing-expiry" class="hint"></p>
      <button id="claim-pairing" class="primary-button" type="button">请求配对</button>
      <button id="cancel-add-device-confirm" class="text-button" type="button" hidden>取消添加设备</button>
    </section>

    <section id="waiting-panel" class="card waiting-card" hidden aria-labelledby="waiting-title">
      <span class="waiting-spinner" aria-hidden="true"></span>
      <div>
        <h2 id="waiting-title">等待电脑批准</h2>
        <p>请在电脑 SomniQ 中确认本手机。批准后会自动建立加密连接。</p>
        <p id="waiting-desktop" class="hint"></p>
      </div>
    </section>

    <section id="paired-panel" class="card" hidden aria-labelledby="paired-title">
      <div class="card-heading">
        <div>
          <h2 id="paired-title">已完成配对</h2>
          <p id="paired-desktop"></p>
        </div>
      </div>
      <div id="paired-panel-device-list" class="paired-device-list paired-panel-device-list" aria-label="已配对设备"></div>
      <div class="action-row">
        <button id="connect" class="primary-button" type="button">安全连接</button>
        <button id="add-paired-device-paired" class="secondary-button" type="button">添加设备</button>
        <button id="forget-pairing" class="text-button" type="button">忘记此设备</button>
      </div>
    </section>

    <section id="connected-panel" class="conversation-page" hidden aria-labelledby="connected-title">
      <button id="workspace-backdrop" class="workspace-backdrop" type="button" aria-label="关闭项目与对话列表" hidden></button>
      <aside id="workspace-drawer" class="workspace-drawer" aria-label="项目与对话列表" aria-hidden="true">
        <header class="workspace-drawer-header">
          <div class="workspace-drawer-brand">
            <img src="${mobileBasePathUrl("icon.png", MOBILE_BASE_PATH)}" alt="" width="26" height="26" />
            <span>SomniQ</span>
          </div>
          <button id="close-workspace" class="icon-button" type="button" aria-label="关闭项目与对话列表" title="关闭">
            <i data-lucide="x" aria-hidden="true"></i>
          </button>
        </header>

        <div id="workspace-drawer-content" class="workspace-drawer-content">
          <details id="drawer-projects-section" class="workspace-project-section">
            <summary class="workspace-project-toggle">
              <span class="workspace-project-toggle-copy">
                <span id="workspace-project-heading" class="workspace-section-label">工作区</span>
                <strong id="workspace-project-current" class="workspace-project-current">正在读取项目…</strong>
              </span>
              <i data-lucide="chevron-down" aria-hidden="true"></i>
            </summary>
            <div class="workspace-project-picker">
              <div class="workspace-project-picker-heading">
                <span>选择项目</span>
              <button id="refresh-workspace" class="drawer-refresh-button" type="button" aria-label="刷新项目" title="刷新项目">
                <i data-lucide="refresh-cw" aria-hidden="true"></i>
              </button>
              </div>
              <div id="workspace-projects" class="workspace-projects"></div>
            </div>
          </details>

          <section id="drawer-sessions-section" class="workspace-sessions-section" aria-labelledby="workspace-sessions-heading">
            <div class="workspace-section-heading">
              <p id="workspace-sessions-heading" class="workspace-section-label">最近对话</p>
              <div class="workspace-session-tools">
                <span id="workspace-session-count" class="workspace-session-count"></span>
                <button id="create-chat-session" class="drawer-create-button" type="button" aria-label="新建对话" title="新建对话">
                  <i data-lucide="plus" aria-hidden="true"></i><span>新建</span>
                </button>
                <button id="refresh-chat-sessions" class="drawer-refresh-button" type="button" aria-label="刷新对话" title="刷新对话">
                  <i data-lucide="refresh-cw" aria-hidden="true"></i>
                </button>
              </div>
            </div>
            <p id="chat-session-status" class="chat-session-status" aria-live="polite"></p>
            <div id="workspace-session-list" class="workspace-session-list"></div>
          </section>
        </div>

        <section id="drawer-device-card" class="drawer-device-card" aria-label="桌面连接">
          <div class="workspace-connection">
            <span class="status-dot online" aria-hidden="true"></span>
            <div>
              <strong id="workspace-desktop-name">SomniQ Desktop</strong>
              <span id="connection-detail">正在建立安全连接…</span>
            </div>
          </div>
          <details id="drawer-device-settings" class="drawer-device-settings">
            <summary>设备<i data-lucide="chevron-down" aria-hidden="true"></i></summary>
            <div id="paired-device-list" class="paired-device-list" aria-label="已配对设备"></div>
            <div class="drawer-device-actions">
              <button id="add-paired-device" class="drawer-action-button" type="button"><i data-lucide="plus" aria-hidden="true"></i>添加设备</button>
              <button id="reconnect" class="drawer-action-button" type="button"><i data-lucide="wifi" aria-hidden="true"></i>重新连接</button>
              <button id="revoke-pairing" class="drawer-action-button danger" type="button">撤销当前设备</button>
            </div>
          </details>
        </section>
      </aside>

      <header class="chat-workspace-header">
        <button id="open-workspace" class="icon-button workspace-toggle" type="button" aria-label="打开项目与对话列表" aria-controls="workspace-drawer" aria-expanded="false" title="项目与对话">
          <i data-lucide="panel-left" aria-hidden="true"></i>
        </button>
        <div class="chat-header-context">
          <div id="chat-model-control" class="chat-model-control">
            <button id="open-model-menu" class="chat-model-trigger" type="button" aria-label="切换模型" aria-haspopup="listbox" aria-expanded="false" title="切换模型">
              <span id="current-model-label">模型</span>
              <i data-lucide="chevron-down" aria-hidden="true"></i>
            </button>
            <div id="chat-model-menu" class="chat-model-menu" role="listbox" aria-label="可用模型" hidden></div>
          </div>
          <p class="chat-header-subtitle">
            <span id="current-session-label" class="current-session-label">选择一个对话</span>
            <span id="current-project-label" class="current-project-label">正在读取项目</span>
          </p>
        </div>
        <div class="chat-header-actions">
          <button id="header-create-chat" class="header-action-button" type="button" aria-label="新建对话" title="新建对话">
            <i data-lucide="square-pen" aria-hidden="true"></i>
          </button>
        </div>
        <h2 id="connected-title" class="sr-only">选择一个对话</h2>
      </header>

      <main id="remote-chat" class="remote-chat" aria-label="桌面对话">
        <div id="chat-log" class="chat-log" role="log" aria-live="polite" aria-relevant="additions text">
          <div id="chat-empty" class="chat-empty">
            <i data-lucide="message-square-text" aria-hidden="true"></i>
            <p>选择一个桌面对话后显示历史。</p>
          </div>
        </div>
      </main>

      <form id="chat-form" class="chat-composer">
        <label class="sr-only" for="chat-message">继续此对话</label>
        <div class="chat-composer-shell">
          <textarea id="chat-message" rows="1" maxlength="4096" required placeholder="选择对话后即可继续发送消息…"></textarea>
          <div class="chat-composer-footer">
            <div class="chat-composer-meta">
              <p id="chat-hint" class="chat-hint"></p>
            </div>
            <button id="send-chat" class="chat-send-button" type="submit" aria-label="发送消息" title="发送消息">
              <i data-lucide="send-horizontal" aria-hidden="true"></i>
            </button>
            <button id="stop-chat" class="chat-stop-button" type="button" aria-label="停止生成" title="停止生成" hidden>
              <i data-lucide="square" aria-hidden="true"></i>
            </button>
          </div>
        </div>
      </form>
    </section>

    <section class="status-card" aria-live="polite" aria-label="连接状态">
      <span class="status-label">状态</span>
      <p id="status">正在恢复安全连接…</p>
    </section>
  </main>
`;

const remoteAppElement = app.querySelector<HTMLElement>(".remote-app");
if (!remoteAppElement) {
  throw new Error("SomniQ Remote could not find its main view.");
}
const remoteApp: HTMLElement = remoteAppElement;

const REMOTE_ICONS = {
  Check,
  ChevronDown,
  Folder,
  MessageSquareText,
  PanelLeft,
  Plus,
  RefreshCw,
  SendHorizontal,
  Settings2,
  Square,
  SquarePen,
  Wifi,
  X,
};

function renderRemoteIcons(): void {
  createIcons({
    icons: REMOTE_ICONS,
    attrs: { "stroke-width": "1.75" },
  });
}

renderRemoteIcons();

type FlowPhase = "loading" | "scan" | "confirm" | "waiting" | "paired" | "connected";

const PAIRING_COMPLETION_POLL_MS = 2_000;
// Tool-enabled desktop turns can legitimately run for several minutes. The
// secure transport stays alive while they execute, so do not present a false
// delivery failure merely because a normal chat turn outlives two minutes.
const CONTROL_RESPONSE_TIMEOUT_MS = 10 * 60_000;
// Stop is an acknowledgement-only control request. Keep its deadline short
// so a lost acknowledgement does not trap the original long-running chat.
const STOP_CHAT_RESPONSE_TIMEOUT_MS = 12_000;
// Answering only unblocks a waiting tool call; the resumed turn streams back
// through the ordinary event path, so this request needs no long deadline.
const QUESTION_ANSWER_RESPONSE_TIMEOUT_MS = 12_000;
// iOS can suspend an otherwise open WebRTC/DataChannel while the PWA is in
// the background. Foreground recovery uses a short probe so the stale route
// is replaced promptly instead of leaving the conversation frozen.
const FOREGROUND_SYNC_RESPONSE_TIMEOUT_MS = 10_000;
// A liveness probe only has to prove the route still carries a round trip.
// Keep it well under the sync deadline so a route the OS really did tear down
// is replaced promptly instead of stalling the whole foreground recovery.
const FOREGROUND_PROBE_TIMEOUT_MS = 6_000;
const FOREGROUND_SYNC_DELAY_MS = 250;
const FOREGROUND_CHAT_RECOVERY_RETRY_MS = 2_000;
const FOREGROUND_CHAT_RECOVERY_MAX_ATTEMPTS = 150;
const CHAT_EVENT_WAIT_MS = 20_000;
const CHAT_EVENT_RESPONSE_TIMEOUT_MS = 30_000;
const CHAT_EVENT_RETRY_MS = 250;
const INITIAL_CHAT_TRANSCRIPT_LIMIT = 24;
const CHAT_TRANSCRIPT_BACKFILL_LIMITS = [60, 100] as const;

interface PendingControlRequest {
  resolve: (response: ControlResponse) => void;
  reject: (error: Error) => void;
  onProgress?: (response: ControlResponse) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface RemoteChatSession extends ChatSessionCandidate {
  title: string;
  model: string | null;
}

interface WorkspaceCapabilityState {
  capabilities: Set<RemoteWorkspaceCapability>;
  advertised: boolean;
}

interface ActiveRemoteChatRequest {
  projectId: string;
  sessionId: string;
  message: string;
  idempotencyKey: string;
  messageId: string | null;
  activity: ChatMessageActivity;
  startedAt: number;
  streamedText: string;
  blocks: RemoteChatBlock[];
  richStream: boolean;
  stopRequested: boolean;
  stopRequestInFlight: boolean;
}

interface DesktopSyncedChatTurn {
  userSeq: number;
  reply: HTMLElement;
  blocks: RemoteChatBlock[];
}

interface PairedSessionRestoreResult {
  restored: boolean;
  failureMessage: string | null;
}

interface ConnectOptions {
  workspaceTimeoutMs?: number;
  replaceInFlight?: boolean;
  /**
   * Rebuild only the transport and keep the project, conversation list,
   * rendered transcript and durable event cursors. The desktop event log is
   * sequence-addressed, so a preserved reconnect resumes exactly where the
   * dropped one stopped instead of reloading the conversation from scratch.
   * Clear it only when the identity behind the session changes.
   */
  preserveContext?: boolean;
}

interface WorkspaceOverviewOptions {
  timeoutMs?: number;
}

interface ChatSessionRefreshOptions {
  openNewest?: boolean;
  timeoutMs?: number;
}

interface ChatTranscriptLoadOptions {
  timeoutMs?: number;
}

interface ForegroundConversationSelection {
  projectId: string | null;
  sessionId: string | null;
}

interface ForegroundChatRecovery {
  projectId: string;
  sessionId: string;
  message: string;
  idempotencyKey: string;
}

type PairingStorageProtection = "unknown" | "persistent" | "best_effort" | "unavailable";

const api = new GatewayApi();
const identityStore = new IndexedDbIdentityStore();
const sessionStore = new BrowserPairedSessionStore();
const cameraScanner = new BrowserQrCameraScanner();

let identity: WebCryptoMobileIdentity | null = null;
let claimed: ClaimedPairing | null = null;
let pairedSession: PairedMobileSession | null = null;
let pairedSessions: PairedMobileSession[] = [];
let mismatchedStoredSession: PairedMobileSession | null = null;
let addingDevice = false;
let deviceSwitching = false;
let transport: P2pFirstTransport | null = null;
let connectionTask: Promise<boolean> | null = null;
let connectionGeneration = 0;
let completionPollTimer: ReturnType<typeof setTimeout> | null = null;
let completingPairing = false;
let phase: FlowPhase = "loading";
let scannedPairingPayload: string | null = null;
let initialPairingError: string | null = null;
let activeProjectId: string | null = null;
let workspaceProjects: RemoteWorkspaceProject[] = [];
let workspaceCapabilityState: WorkspaceCapabilityState = {
  capabilities: new Set<RemoteWorkspaceCapability>(),
  advertised: false,
};
let workspaceDrawerOpen = false;
let projectSwitching = false;
let chatSending = false;
let activeRemoteChatRequest: ActiveRemoteChatRequest | null = null;
let chatActivityTimer: ReturnType<typeof setInterval> | null = null;
let chatSessionsLoading = false;
let chatSessionCreating = false;
let chatTranscriptLoading = false;
let chatTranscriptLoadGeneration = 0;
let loadedTranscriptMessages: RemoteTranscriptMessage[] = [];
let conversationViewportSyncFrame: number | null = null;
let conversationViewportBaselineHeight = 0;
let chatSessions: RemoteChatSession[] = [];
let selectedChatSessionId: string | null = null;
let chatEventSyncGeneration = 0;
let desktopSyncedChatTurn: DesktopSyncedChatTurn | null = null;
/** The bubble owning the phone's own in-flight turn, for question re-renders. */
let activeRemoteChatReply: HTMLElement | null = null;
/**
 * Unsent question selections, keyed by tool-use id. Rendering a turn rebuilds
 * its DOM on every streamed event, so a multi-select answer in progress has to
 * live outside the card that displays it.
 */
const questionDrafts = new Map<string, { selected: Set<number>; custom: string }>();
let chatModelState: RemoteChatModelState = { model: null, options: [] };
let chatModelLoading = false;
let chatModelSwitching = false;
let chatModelMenuOpen = false;
let pairingStorageProtection: PairingStorageProtection = "unknown";
let pairingStorageRequest: Promise<PairingStorageProtection> | null = null;
let hasMismatchedStoredPairing = false;
let foregroundResumeTimer: ReturnType<typeof setTimeout> | null = null;
let foregroundResumeTask: Promise<boolean> | null = null;
let foregroundResumeGeneration = 0;
let foregroundTranscriptSyncPending: ForegroundConversationSelection | null = null;
let foregroundChatRecoveryTask: Promise<void> | null = null;
let foregroundChatRecoveryGeneration = 0;
let pendingForegroundChatRecovery: ForegroundChatRecovery | null = null;
const pendingControlRequests = new Map<string, PendingControlRequest>();
const pairingContext = pairingBrowserContext(navigator.userAgent, isEmbeddedWindow());
const foregroundResume = new ForegroundResumeCoordinator();
const chatEventCursors = new ChatEventCursorStore();
const reconnectBackoff = new ReconnectBackoff();

try {
  scannedPairingPayload = consumePairingPayloadFromLocation();
} catch (error) {
  initialPairingError = errorMessage(error);
}

const scanPanel = byId<HTMLElement>("scan-panel");
const pairingPanel = byId<HTMLElement>("pairing-panel");
const waitingPanel = byId<HTMLElement>("waiting-panel");
const pairedPanel = byId<HTMLElement>("paired-panel");
const connectedPanel = byId<HTMLElement>("connected-panel");
const qrImage = byId<HTMLInputElement>("qr-image");
const qrCamera = byId<HTMLVideoElement>("qr-camera");
const cameraPreview = byId<HTMLElement>("camera-preview");
const startCameraButton = byId<HTMLButtonElement>("start-camera");
const stopCameraButton = byId<HTMLButtonElement>("stop-camera");
const chooseQrImageButton = byId<HTMLButtonElement>("choose-qr-image");
const discardMismatchedPairingButton = byId<HTMLButtonElement>("discard-mismatched-pairing");
const cancelAddDeviceButton = byId<HTMLButtonElement>("cancel-add-device");
const cancelAddDeviceConfirmButton = byId<HTMLButtonElement>("cancel-add-device-confirm");
const claimButton = byId<HTMLButtonElement>("claim-pairing");
const connectButton = byId<HTMLButtonElement>("connect");
const forgetPairingButton = byId<HTMLButtonElement>("forget-pairing");
const addPairedDevicePairedButton = byId<HTMLButtonElement>("add-paired-device-paired");
const reconnectButton = byId<HTMLButtonElement>("reconnect");
const addPairedDeviceButton = byId<HTMLButtonElement>("add-paired-device");
const pairedDeviceList = byId<HTMLElement>("paired-device-list");
const pairedPanelDeviceList = byId<HTMLElement>("paired-panel-device-list");
const chatForm = byId<HTMLFormElement>("chat-form");
const chatInput = byId<HTMLTextAreaElement>("chat-message");
const sendChatButton = byId<HTMLButtonElement>("send-chat");
const stopChatButton = byId<HTMLButtonElement>("stop-chat");
const chatHint = byId<HTMLElement>("chat-hint");
const createChatSessionButton = byId<HTMLButtonElement>("create-chat-session");
const headerCreateChatButton = byId<HTMLButtonElement>("header-create-chat");
const refreshChatSessionsButton = byId<HTMLButtonElement>("refresh-chat-sessions");
const refreshWorkspaceButton = byId<HTMLButtonElement>("refresh-workspace");
const workspaceProjectsDetails = byId<HTMLDetailsElement>("drawer-projects-section");
const workspaceProjectCurrent = byId<HTMLElement>("workspace-project-current");
const chatSessionStatus = byId<HTMLElement>("chat-session-status");
const chatLog = byId<HTMLElement>("chat-log");
const chatEmpty = byId<HTMLElement>("chat-empty");
const workspaceBackdrop = byId<HTMLButtonElement>("workspace-backdrop");
const workspaceDrawer = byId<HTMLElement>("workspace-drawer");
const openWorkspaceButton = byId<HTMLButtonElement>("open-workspace");
const closeWorkspaceButton = byId<HTMLButtonElement>("close-workspace");
const workspaceDesktopName = byId<HTMLElement>("workspace-desktop-name");
const workspaceProjectsElement = byId<HTMLElement>("workspace-projects");
const workspaceSessionList = byId<HTMLElement>("workspace-session-list");
const workspaceSessionCount = byId<HTMLElement>("workspace-session-count");
const currentProjectLabel = byId<HTMLElement>("current-project-label");
const currentSessionLabel = byId<HTMLElement>("current-session-label");
const chatModelControl = byId<HTMLElement>("chat-model-control");
const openModelMenuButton = byId<HTMLButtonElement>("open-model-menu");
const currentModelLabel = byId<HTMLElement>("current-model-label");
const chatModelMenu = byId<HTMLElement>("chat-model-menu");
const connectedTitle = byId<HTMLElement>("connected-title");
const revokePairingButton = byId<HTMLButtonElement>("revoke-pairing");
const pairingDesktop = byId<HTMLElement>("pairing-desktop");
const pairingExpiry = byId<HTMLElement>("pairing-expiry");
const waitingDesktop = byId<HTMLElement>("waiting-desktop");
const pairedDesktop = byId<HTMLElement>("paired-desktop");
const connectionDetail = byId<HTMLElement>("connection-detail");
const status = byId<HTMLElement>("status");
const persistentWorkspaceLayout = window.matchMedia("(min-width: 900px)");

startCameraButton.addEventListener("click", () => void startCameraScan());
stopCameraButton.addEventListener("click", stopCameraScanByUser);
chooseQrImageButton.addEventListener("click", () => {
  stopCameraScan();
  qrImage.click();
});
qrImage.addEventListener("change", () => void scanQrImage());
discardMismatchedPairingButton.addEventListener("click", () => void discardMismatchedPairing());
cancelAddDeviceButton.addEventListener("click", () => void cancelAddingDevice());
cancelAddDeviceConfirmButton.addEventListener("click", () => void cancelAddingDevice());
claimButton.addEventListener("click", () => void claimPairing());
connectButton.addEventListener("click", () => void connect());
forgetPairingButton.addEventListener("click", () => void revokeAndForget());
addPairedDevicePairedButton.addEventListener("click", beginAddingDevice);
// Reconnecting is a continuation, not a restart: keep the open conversation
// and resume it from its cursor. A user who wants a clean slate still has the
// device and pairing controls in the drawer.
reconnectButton.addEventListener("click", () => void connect({ preserveContext: true }));
addPairedDeviceButton.addEventListener("click", beginAddingDevice);
chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void sendChatMessage();
});
stopChatButton.addEventListener("click", () => void stopChatMessage());
chatInput.addEventListener("input", () => {
  resizeChatComposer();
  updateChatComposer();
});
chatInput.addEventListener("focus", () => {
  // Safari can update its visual viewport a frame or two after a textarea
  // receives focus. Keep the grid and composer within that visible viewport.
  setWorkspaceDrawerOpen(false);
  scheduleConversationViewportSync();
});
chatInput.addEventListener("blur", scheduleConversationViewportSync);
createChatSessionButton.addEventListener("click", () => void createChatSession());
headerCreateChatButton.addEventListener("click", () => void createChatSession());
refreshChatSessionsButton.addEventListener("click", () => void refreshChatSessions());
refreshWorkspaceButton.addEventListener("click", () => void requestWorkspaceOverview());
openWorkspaceButton.addEventListener("click", () => setWorkspaceDrawerOpen(true));
closeWorkspaceButton.addEventListener("click", () => setWorkspaceDrawerOpen(false));
workspaceBackdrop.addEventListener("click", () => setWorkspaceDrawerOpen(false));
persistentWorkspaceLayout.addEventListener("change", syncWorkspaceDrawerPresentation);
openModelMenuButton.addEventListener("click", () => setChatModelMenuOpen(!chatModelMenuOpen));
revokePairingButton.addEventListener("click", () => void revokeAndForget());

window.addEventListener("beforeunload", () => {
  stopCompletionPolling();
  stopCameraScan();
  stopChatActivityTimer();
  pauseForegroundResume();
  rejectPendingControlRequests(new Error("The remote page was closed."));
  transport?.close();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    // A backgrounded page runs no timers, so leaving the signal lease armed
    // only guarantees that its deadline expires the moment the page wakes up
    // and tears down a route that may never have failed.
    transport?.suspendSignalHeartbeat();
    pauseForegroundResume();
    stopCameraScan();
    return;
  }
  transport?.resumeSignalHeartbeat();
  scheduleConversationViewportSync();
  scheduleForegroundResume();
});
window.addEventListener("pagehide", () => {
  transport?.suspendSignalHeartbeat();
  pauseForegroundResume();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    foregroundResume.markBackgrounded();
  }
  transport?.resumeSignalHeartbeat();
  scheduleConversationViewportSync();
  scheduleForegroundResume();
});
window.addEventListener("focus", () => {
  scheduleForegroundResume();
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && workspaceDrawerOpen) {
    event.preventDefault();
    setWorkspaceDrawerOpen(false);
  }
  if (event.key === "Escape" && chatModelMenuOpen) {
    event.preventDefault();
    setChatModelMenuOpen(false);
  }
});
document.addEventListener("click", (event) => {
  if (!chatModelMenuOpen || chatModelControl.contains(event.target as Node)) {
    return;
  }
  setChatModelMenuOpen(false);
});
window.addEventListener("resize", scheduleConversationViewportSync);
window.visualViewport?.addEventListener("resize", scheduleConversationViewportSync);
window.visualViewport?.addEventListener("scroll", scheduleConversationViewportSync);
scheduleConversationViewportSync();

if ("serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register(mobileBasePathUrl("sw.js", MOBILE_BASE_PATH), {
      scope: MOBILE_BASE_PATH,
      updateViaCache: "none",
    }).then((registration) => {
      registration.update().catch(() => {
        // A later navigation still performs a network-first shell request.
      });
    }).catch(() => {
      // Offline support is additive. A failed registration must not prevent a
      // paired session from being opened in the current tab.
    });
  });
}

void initialize();

async function initialize(): Promise<void> {
  setPhase("loading");
  if (initialPairingError) {
    setStatus(initialPairingError);
  }

  // The paired-device credential is encrypted in browser storage and is
  // sufficient for the data plane. A new device is authorized only by the
  // signed QR ceremony and an explicit approval on the desktop.
  const restoration = await restorePairedSession();
  if (restoration.restored && pairedSession) {
    pairingStorageProtection = await inspectPairingStorageProtection();
    updateDesktopLabels(pairedSession);
    renderPairedDevices();
    if (scannedPairingPayload) {
      addingDevice = true;
      showPairingConfirmation();
      return;
    }
    setPhase("paired");
    setStatus(hasChatScope()
      ? "已恢复安全配对，正在连接电脑…"
      : "此手机使用的是旧权限集。请在桌面端撤销后重新扫码配对，以启用项目、模型和对话控制。");
    await connect();
    return;
  }

  if (hasMismatchedStoredPairing) {
    scannedPairingPayload = null;
    setPhase("scan");
    setStatus(restoration.failureMessage ?? pairingIdentityMismatchMessage());
    return;
  }

  if (blockPairingInEphemeralContext()) {
    return;
  }

  if (scannedPairingPayload) {
    showPairingConfirmation();
  } else {
    setPhase("scan");
    setStatus(
      initialPairingError ??
      restoration.failureMessage ??
      "请在电脑 SomniQ 中显示二维码后，用手机系统相机扫描。",
    );
  }
}

async function scanQrImage(): Promise<void> {
  if (blockPairingInEphemeralContext()) {
    return;
  }
  const image = qrImage.files?.item(0);
  if (!image) {
    return;
  }
  stopCameraScan();
  setBusy(chooseQrImageButton, true);
  try {
    scannedPairingPayload = await readPairingQrImage(image);
    showPairingConfirmation();
  } catch (error) {
    setStatus(errorMessage(error));
  } finally {
    setBusy(chooseQrImageButton, false);
    qrImage.value = "";
  }
}

async function startCameraScan(): Promise<void> {
  if (blockPairingInEphemeralContext()) {
    return;
  }
  if (phase !== "scan") {
    return;
  }
  setBusy(startCameraButton, true);
  setCameraPreviewVisible(true);
  try {
    await cameraScanner.start(qrCamera, {
      onResult: (rawValue) => {
        setCameraPreviewVisible(false);
        try {
          scannedPairingPayload = pairingPayloadFromQrContent(rawValue);
          showPairingConfirmation();
        } catch (error) {
          scannedPairingPayload = null;
          setPhase("scan");
          setStatus(errorMessage(error));
        }
      },
      onError: (error) => {
        setCameraPreviewVisible(false);
        setStatus(errorMessage(error));
      },
    });
    if (phase === "scan") {
      setStatus("请将电脑上的二维码放入取景框中。");
    }
  } catch (error) {
    stopCameraScan();
    setStatus(errorMessage(error));
  } finally {
    setBusy(startCameraButton, false);
  }
}

function stopCameraScanByUser(): void {
  stopCameraScan();
  setStatus("相机已关闭。可重新打开相机，或从相册选择二维码。");
}

function stopCameraScan(): void {
  cameraScanner.stop();
  setCameraPreviewVisible(false);
}

function setCameraPreviewVisible(visible: boolean): void {
  cameraPreview.hidden = !visible;
  startCameraButton.hidden = visible;
  stopCameraButton.hidden = !visible;
}

function showPairingConfirmation(): void {
  if (blockPairingInEphemeralContext()) {
    return;
  }
  if (!scannedPairingPayload) {
    setPhase("scan");
    return;
  }
  try {
    const invitation = parsePairingInvitation(scannedPairingPayload);
    pairingDesktop.textContent = displayLabelForDesktop(invitation.desktop);
    pairingExpiry.textContent = `该二维码将在 ${formatExpiry(invitation.expires_at_unix_ms)} 前失效。`;
    setPhase("confirm");
    setStatus("已识别电脑。确认后请在电脑上批准这台手机。");
  } catch (error) {
    scannedPairingPayload = null;
    setPhase("scan");
    setStatus(errorMessage(error));
  }
}

async function claimPairing(): Promise<void> {
  if (blockPairingInEphemeralContext() || !scannedPairingPayload) {
    return;
  }
  // Start this while the user gesture is still active. Mobile browsers are
  // more likely to grant durable storage when the request comes from a tap.
  pairingStorageRequest = requestPersistentPairingStorage();
  setBusy(claimButton, true);
  let pairingDesktopDeviceId: string | null = null;
  try {
    const invitation = parsePairingInvitation(scannedPairingPayload);
    pairingDesktopDeviceId = invitation.desktop.device_id;
    if (pairedSessions.some((session) =>
      session.invitation.desktop.device_id === invitation.desktop.device_id
    )) {
      throw new Error("这台电脑已经保存在设备列表中。需要重新授权时，请先撤销原配对。");
    }
    const mobileIdentity = await WebCryptoMobileIdentity.loadOrCreate(
      identityStoreForDesktop(invitation.desktop.device_id),
      defaultPhoneName(),
    );
    const pending = await api.claimInvitation(
      scannedPairingPayload,
      mobileIdentity,
      MOBILE_P1_REQUESTABLE_SCOPES,
    );
    identity = mobileIdentity;
    claimed = pending;
    // The raw QR content is no longer needed. `claimed` holds only the
    // short-lived material required to finish this current ceremony.
    scannedPairingPayload = null;
    waitingDesktop.textContent = displayLabelForDesktop(pending.invitation.desktop);
    setPhase("waiting");
    setStatus("配对请求已发送，正在等待电脑批准。");
    startCompletionPolling();
  } catch (error) {
    if (pairingDesktopDeviceId && error instanceof GatewayApiError && error.status === 409) {
      await identityStoreForDesktop(pairingDesktopDeviceId).clear().catch(() => undefined);
      identity = null;
    }
    claimed = null;
    setStatus(errorMessage(error));
  } finally {
    if (!claimed) {
      pairingStorageRequest = null;
    }
    setBusy(claimButton, false);
  }
}

function startCompletionPolling(): void {
  stopCompletionPolling();
  void completePairingWhenApproved();
}

function stopCompletionPolling(): void {
  if (completionPollTimer !== null) {
    clearTimeout(completionPollTimer);
    completionPollTimer = null;
  }
}

async function completePairingWhenApproved(): Promise<void> {
  const pending = claimed;
  if (!pending || !identity || completingPairing) {
    return;
  }
  completingPairing = true;
  try {
    const completion = await api.completePairing(pending);
    if (claimed !== pending || !identity) {
      return;
    }
    const session: PairedMobileSession = {
      invitation: {
        gateway_url: pending.invitation.gateway_url,
        desktop: pending.invitation.desktop,
      },
      mobile: identity.descriptor,
      credential: pending.claim.activation_token,
      granted_scopes: completion.device.granted_scopes,
      ice_servers: [...pending.claim.ice_servers],
    };
    const collection = await sessionStore.saveSession(session);
    pairingStorageProtection = await (pairingStorageRequest ?? requestPersistentPairingStorage());
    pairingStorageRequest = null;
    disconnectForDeviceChange();
    pairedSessions = collection.sessions;
    pairedSession = session;
    addingDevice = false;
    claimed = null;
    stopCompletionPolling();
    updateDesktopLabels(session);
    renderPairedDevices();
    setPhase("paired");
    setStatus(pairingCompletedStatus());
    await connect();
  } catch (error) {
    if (error instanceof GatewayApiError && error.isAwaitingDesktopApproval) {
      setStatus("等待电脑批准。批准后会自动继续。");
      scheduleCompletionPoll();
      return;
    }
    claimed = null;
    setPhase("scan");
    setStatus(`配对未完成：${errorMessage(error)}`);
  } finally {
    if (!claimed) {
      pairingStorageRequest = null;
    }
    completingPairing = false;
  }
}

function scheduleCompletionPoll(): void {
  stopCompletionPolling();
  if (claimed && phase === "waiting") {
    completionPollTimer = setTimeout(() => void completePairingWhenApproved(), PAIRING_COMPLETION_POLL_MS);
  }
}

async function restorePairedSession(): Promise<PairedSessionRestoreResult> {
  hasMismatchedStoredPairing = false;
  mismatchedStoredSession = null;
  try {
    const collection = await sessionStore.loadCollection();
    if (!collection || !collection.activeDesktopDeviceId) {
      identity = null;
      pairedSessions = [];
      return { restored: false, failureMessage: null };
    }
    const session = collection.sessions.find(
      (entry) => entry.invitation.desktop.device_id === collection.activeDesktopDeviceId,
    );
    if (!session) {
      throw new Error("已保存的活动设备不存在，请重置本地配对。");
    }
    pairedSessions = collection.sessions;
    mismatchedStoredSession = session;
    hasMismatchedStoredPairing = false;
    let remainingCollection = collection;
    let lastAuthorizationError: unknown = null;
    while (remainingCollection.activeDesktopDeviceId) {
      const activeSession = remainingCollection.sessions.find(
        (entry) => entry.invitation.desktop.device_id === remainingCollection.activeDesktopDeviceId,
      );
      if (!activeSession) {
        throw new Error("已保存的活动设备不存在，请重置本地配对。");
      }
      pairedSessions = remainingCollection.sessions;
      mismatchedStoredSession = activeSession;
      const activeIdentity = await loadIdentityForSession(activeSession);
      if (!activeIdentity) {
        await Promise.all([
          sessionStore.remove(activeSession.invitation.desktop.device_id),
          identityStoreForDesktop(activeSession.invitation.desktop.device_id).clear(),
        ]);
        lastAuthorizationError = new Error(
          `「${displayLabelForSession(activeSession)}」的手机安全身份已经缺失，请重新配对。`,
        );
        const updatedCollection = await sessionStore.loadCollection();
        if (!updatedCollection || !updatedCollection.activeDesktopDeviceId) {
          break;
        }
        remainingCollection = updatedCollection;
        continue;
      }
      identity = activeIdentity;
      try {
        const refreshedSession = await refreshStoredPairingScopes(activeSession);
        pairedSession = refreshedSession;
        pairedSessions = pairedSessions.map((entry) =>
          entry.invitation.desktop.device_id === refreshedSession.invitation.desktop.device_id
            ? refreshedSession
            : entry,
        );
        mismatchedStoredSession = null;
        return { restored: true, failureMessage: null };
      } catch (error) {
        const updatedCollection = await sessionStore.loadCollection();
        if (!updatedCollection || updatedCollection.sessions.length >= remainingCollection.sessions.length) {
          throw error;
        }
        lastAuthorizationError = error;
        remainingCollection = updatedCollection;
      }
    }
    pairedSession = null;
    pairedSessions = [];
    identity = null;
    mismatchedStoredSession = null;
    return {
      restored: false,
      failureMessage: lastAuthorizationError ? errorMessage(lastAuthorizationError) : null,
    };
  } catch (error) {
    hasMismatchedStoredPairing = true;
    return { restored: false, failureMessage: errorMessage(error) };
  }
}

async function discardMismatchedPairing(): Promise<void> {
  if (!hasMismatchedStoredPairing) {
    return;
  }
  setBusy(discardMismatchedPairingButton, true);
  try {
    if (mismatchedStoredSession) {
      try {
        await api.revokeThisDevice(
          mismatchedStoredSession.invitation.gateway_url,
          mismatchedStoredSession.credential,
        );
      } catch (error) {
        if (!(error instanceof GatewayApiError && (error.status === 401 || error.status === 403))) {
          throw error;
        }
      }
    }
    await Promise.all([sessionStore.clear(), identityStore.clearAll()]);
    identity = null;
    pairedSession = null;
    pairedSessions = [];
    mismatchedStoredSession = null;
    claimed = null;
    addingDevice = false;
    scannedPairingPayload = null;
    hasMismatchedStoredPairing = false;
    setPhase("scan");
    setStatus("已重置此主屏应用的旧身份和会话。请在此应用内打开相机扫码并完成最后一次配对；以后退出再打开会自动恢复。");
  } catch (error) {
    setStatus(errorMessage(error));
  } finally {
    setBusy(discardMismatchedPairingButton, false);
  }
}

function sameMobileIdentity(
  left: PairedMobileSession["mobile"],
  right: PairedMobileSession["mobile"],
): boolean {
  return left.device_id === right.device_id &&
    left.kind === "mobile" &&
    right.kind === "mobile" &&
    left.signing_public_key === right.signing_public_key &&
    left.key_agreement_public_key === right.key_agreement_public_key;
}

/**
 * The phone's encrypted local copy is only a cache of the scopes bound to its
 * bearer credential. Refreshing it can recover a P0/P1 browser that persisted
 * an incomplete projection, but it never asks the gateway to add authority:
 * the gateway record was created by a signed desktop approval.
 */
async function refreshStoredPairingScopes(session: PairedMobileSession): Promise<PairedMobileSession> {
  try {
    const current = await api.currentDevice(
      session.invitation.gateway_url,
      session.credential,
    );
    const device = current.device;
    if (
      !device ||
      device.id !== session.mobile.device_id ||
      device.role !== "mobile" ||
      device.active !== true ||
      !Array.isArray(device.granted_scopes) ||
      !device.granted_scopes.every(isKnownRemoteScope)
    ) {
      await Promise.all([
        sessionStore.remove(session.invitation.desktop.device_id),
        clearIdentityForSession(session),
      ]);
      throw new Error("此手机的远程授权与已保存配对不一致。请在电脑上撤销后重新扫描二维码配对。");
    }

    // A gateway response can only reduce a local cache. It must never add a
    // capability the desktop has not re-approved through a fresh QR ceremony.
    const grantedScopes = session.granted_scopes.filter((scope) => device.granted_scopes.includes(scope));
    if (sameRemoteScopes(session.granted_scopes, grantedScopes)) {
      return session;
    }
    const refreshed = { ...session, granted_scopes: grantedScopes };
    await sessionStore.saveSession(refreshed, false);
    return refreshed;
  } catch (error) {
    // A rejected bearer is final. A transient failure, an older gateway that
    // lacks `/v1/me`, or a malformed response must not erase a usable local
    // pairing, so the normal transport connection can still make progress.
    if (error instanceof GatewayApiError && (error.status === 401 || error.status === 403)) {
      await Promise.all([
        sessionStore.remove(session.invitation.desktop.device_id),
        clearIdentityForSession(session),
      ]);
      throw new Error("此手机的远程授权已失效。请在电脑上撤销后重新扫描二维码配对。");
    }
    if (error instanceof Error && error.message.includes("远程授权与已保存配对不一致")) {
      throw error;
    }
    return session;
  }
}

function isKnownRemoteScope(value: unknown): value is PairedMobileSession["granted_scopes"][number] {
  return value === "read_project_state" ||
    value === "read_task_timeline" ||
    value === "send_chat_messages" ||
    value === "stop_runs" ||
    value === "read_review_conclusions";
}

function sameRemoteScopes(
  left: readonly PairedMobileSession["granted_scopes"][number][],
  right: readonly PairedMobileSession["granted_scopes"][number][],
): boolean {
  return left.length === right.length && left.every((scope) => right.includes(scope));
}

function connect(options: ConnectOptions = {}): Promise<boolean> {
  if (!pairedSession) {
    return Promise.resolve(false);
  }
  if (connectionTask && !options.replaceInFlight) {
    return connectionTask;
  }

  const generation = ++connectionGeneration;
  const task = connectInternal(options, generation);
  connectionTask = task;
  void task.then(
    () => {
      if (connectionTask === task) {
        connectionTask = null;
      }
    },
    () => {
      if (connectionTask === task) {
        connectionTask = null;
      }
    },
  );
  return task;
}

function isCurrentConnection(generation: number): boolean {
  return generation === connectionGeneration;
}

function disconnectForDeviceChange(): void {
  connectionGeneration += 1;
  connectionTask = null;
  foregroundResumeGeneration += 1;
  foregroundChatRecoveryGeneration += 1;
  rejectPendingControlRequests(new Error("The active remote device changed."));
  const previousTransport = transport;
  transport = null;
  previousTransport?.close();
  activeProjectId = null;
  workspaceProjects = [];
  resetWorkspaceCapabilities();
  resetRemoteChatState();
  // Event sequences are only meaningful within one desktop's log.
  chatEventCursors.clear();
  reconnectBackoff.recordSuccess();
}

async function connectInternal(options: ConnectOptions, generation: number): Promise<boolean> {
  if (!pairedSession || !isCurrentConnection(generation)) {
    return false;
  }
  const session = pairedSession;
  const preserveContext = options.preserveContext === true && activeProjectId !== null;
  rejectPendingControlRequests(new Error("The remote connection was replaced."));
  const previousTransport = transport;
  transport = null;
  previousTransport?.close();
  if (preserveContext) {
    // Keep the project, session list, transcript and event cursors. Only the
    // long-running request state belongs to the transport being discarded,
    // and `desktopSyncedChatTurn` must survive so a resumed stream continues
    // the same reply bubble instead of starting a second one.
    releaseTransportBoundChatState();
  } else {
    activeProjectId = null;
    workspaceProjects = [];
    resetWorkspaceCapabilities();
    setWorkspaceDrawerOpen(false);
    resetRemoteChatState();
  }
  updateChatComposer();
  setBusy(connectButton, true);
  setBusy(reconnectButton, true);
  let candidate: P2pFirstTransport | null = null;
  try {
    const mobileIdentity = await ensureIdentity(session);
    if (!isCurrentConnection(generation)) {
      return false;
    }
    const configuration = makeRtcConfiguration(session.ice_servers);
    candidate = new P2pFirstTransport({
      session,
      socketFactory: new BrowserTicketedSocketFactory(),
      rtcConfiguration: configuration,
      createFrameCodec: async (sessionId) => {
        const key = await mobileIdentity.deriveSessionKeyMaterial(
          session.invitation.desktop.key_agreement_public_key,
          sessionId,
          session.invitation.desktop.device_id,
        );
        return new SecureEnvelopeCodec({
          sessionKey: key,
          sessionId,
          localDeviceId: session.mobile.device_id,
          peerDeviceId: session.invitation.desktop.device_id,
        });
      },
      onStateChange: (state) => {
        // `connectInternal` detaches and closes the previous transport before
        // constructing its replacement. During that short handoff both
        // `transport` and `candidate` are null; without this guard, the old
        // transport's synchronous `closed` callback is mistaken for the new
        // connection and resets the mobile UI on every foreground resume.
        if (candidate !== null && isCurrentConnection(generation) && transport === candidate) {
          showTransportState(state);
        }
      },
      onPlaintextFrame: (frame) => {
        if (candidate !== null && isCurrentConnection(generation) && transport === candidate) {
          showControlResponse(frame);
        }
      },
      onTransportError: (error) => {
        if (candidate !== null && isCurrentConnection(generation) && transport === candidate) {
          rejectPendingControlRequests(error);
          setStatus(error.message);
        }
      },
    });
    if (!isCurrentConnection(generation)) {
      candidate.close();
      return false;
    }
    transport = candidate;
    await candidate.connect();
    if (!isCurrentConnection(generation) || transport !== candidate) {
      candidate.close();
      return false;
    }
    setPhase("connected");
    reconnectBackoff.recordSuccess();
    updateChatComposer();
    if (!hasChatScope()) {
      setStatus("此手机使用的是旧权限集。请在桌面端撤销后重新扫码配对，以启用项目、模型和对话控制。");
      return true;
    }
    if (preserveContext) {
      return resumePreservedConversation(options.workspaceTimeoutMs);
    }
    return requestWorkspaceOverview({ timeoutMs: options.workspaceTimeoutMs });
  } catch (error) {
    if (!isCurrentConnection(generation)) {
      return false;
    }
    reconnectBackoff.recordFailure();
    if (transport === candidate) {
      candidate?.close();
      transport = null;
    }
    rejectPendingControlRequests(error instanceof Error ? error : new Error(errorMessage(error)));
    setPhase("paired");
    setStatus(errorMessage(error));
    return false;
  } finally {
    if (isCurrentConnection(generation)) {
      setBusy(connectButton, false);
      setBusy(reconnectButton, false);
    }
  }
}

/**
 * Restarts the desktop event stream on a freshly rebuilt transport without
 * reloading the conversation. The retained cursor is the resume point, so the
 * desktop replays exactly the events the phone missed while the route was
 * down. The conversation list is refreshed in the background because it only
 * affects titles and newly created sessions, never the open transcript.
 */
async function resumePreservedConversation(timeoutMs?: number): Promise<boolean> {
  const projectId = activeProjectId;
  if (!projectId) {
    return requestWorkspaceOverview({ timeoutMs });
  }
  if (selectedChatSessionId) {
    startChatEventSync(projectId, selectedChatSessionId, { preserveTurn: true });
  }
  setStatus("已恢复安全连接，正在续传离开期间的桌面进度…");
  void refreshChatSessions({ timeoutMs });
  return true;
}

async function requestWorkspaceOverview(options: WorkspaceOverviewOptions = {}): Promise<boolean> {
  try {
    const response = await sendControlRequest(
      newWorkspaceOverviewRequest(),
      undefined,
      options.timeoutMs,
    );
    const overview = workspaceOverviewFromResponse(response);
    if (!overview || overview.projects.length === 0) {
      throw controlResponseError(response, "电脑没有返回研究项目。");
    }
    const { projects } = overview;
    const project = projects.find((entry) => entry.isActive)
      ?? projects.find((entry) => entry.projectId === activeProjectId)
      ?? projects[0];
    const projectChanged = activeProjectId !== project.projectId;
    if (projectChanged) {
      resetRemoteChatState();
    }
    workspaceProjects = projects;
    setWorkspaceCapabilities(overview);
    activeProjectId = project.projectId;
    renderWorkspaceProjects();
    renderChatSessionNavigation();
    renderChatWorkspaceHeader();
    updateChatComposer();
    setStatus("已刷新电脑上的研究工作区。");
    let chatSessionsRefreshed = true;
    if (canAccessRemoteChat()) {
      chatSessionsRefreshed = await refreshChatSessions({
        openNewest: projectChanged,
        timeoutMs: options.timeoutMs,
      });
    }
    return chatSessionsRefreshed;
  } catch (error) {
    setStatus(errorMessage(error));
    return false;
  }
}

function pauseForegroundResume(): void {
  foregroundResume.markBackgrounded();
  foregroundResumeGeneration += 1;
  foregroundChatRecoveryGeneration += 1;
  if (foregroundResumeTimer !== null) {
    clearTimeout(foregroundResumeTimer);
    foregroundResumeTimer = null;
  }
  // A suspended Promise cannot be forcibly cancelled, but its generation is
  // now stale and it must not clear the requirement for the next foreground.
  foregroundResumeTask = null;
  foregroundResume.cancelQueuedResume();
}

function scheduleForegroundResume(): void {
  if (foregroundResumeTimer !== null || foregroundResumeTask !== null) {
    return;
  }
  if (!foregroundResume.requestResume({
    documentHidden: document.hidden,
    paired: pairedSession !== null,
    connectable: phase === "paired" || phase === "connected",
  })) {
    return;
  }

  const generation = foregroundResumeGeneration;
  foregroundResumeTimer = setTimeout(() => {
    foregroundResumeTimer = null;
    startForegroundResume(generation);
  }, FOREGROUND_SYNC_DELAY_MS);
}

function startForegroundResume(generation: number): void {
  if (!isCurrentForegroundResume(generation) || foregroundResumeTask !== null) {
    return;
  }

  const task = synchronizeAfterForeground(generation);
  foregroundResumeTask = task;
  void task.then(
    (synchronized) => finishForegroundResume(task, generation, synchronized),
    (error) => {
      if (isCurrentForegroundResume(generation)) {
        setStatus(errorMessage(error));
      }
      finishForegroundResume(task, generation, false);
    },
  );
}

function isCurrentForegroundResume(generation: number): boolean {
  return generation === foregroundResumeGeneration && !document.hidden && pairedSession !== null;
}

function finishForegroundResume(
  task: Promise<boolean>,
  generation: number,
  synchronized: boolean,
): void {
  if (foregroundResumeTask === task) {
    foregroundResumeTask = null;
  }
  if (generation !== foregroundResumeGeneration) {
    return;
  }
  foregroundResume.completeResume({
    documentHidden: document.hidden,
    connected: phase === "connected" && transport !== null,
    synchronized,
  });
}

async function waitForConnectionTask(timeoutMs: number): Promise<boolean | null> {
  const task = connectionTask;
  if (!task) {
    return true;
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), timeoutMs);
    void task.then(
      (connected) => {
        clearTimeout(timeout);
        resolve(connected);
      },
      () => {
        clearTimeout(timeout);
        resolve(false);
      },
    );
  });
}

async function synchronizeAfterForeground(generation: number): Promise<boolean> {
  if (!isCurrentForegroundResume(generation)) {
    return false;
  }

  const selection = captureForegroundConversationSelection();
  const activeChatRecovery = chatSending && activeRemoteChatRequest && !activeRemoteChatRequest.stopRequested
    ? foregroundChatRecoveryFrom(activeRemoteChatRequest)
    : null;
  const interruptedChat = activeChatRecovery ?? pendingForegroundChatRecovery;

  const pendingConnection = await waitForConnectionTask(FOREGROUND_SYNC_RESPONSE_TIMEOUT_MS);
  if (!isCurrentForegroundResume(generation)) {
    return false;
  }

  // An app switch does not necessarily break anything. A route that survived
  // still holds the conversation, its stream and its cursor, so spend one
  // cheap probe on finding out before paying for a renegotiation that would
  // restart the conversation from scratch.
  if (pendingConnection !== null && phase === "connected" && transport) {
    setStatus("正在检查与电脑的连接…");
    const alive = await probeLiveTransport();
    if (!isCurrentForegroundResume(generation)) {
      return false;
    }
    if (alive) {
      reconnectBackoff.recordSuccess();
      resumeLiveConversation();
      setStatus("连接仍然有效，正在续传离开期间的桌面进度…");
      void refreshChatSessions({ timeoutMs: FOREGROUND_SYNC_RESPONSE_TIMEOUT_MS });
      // The route carried a round trip, so a turn that is merely still running
      // needs nothing. Only a turn whose transport actually dropped left a
      // recovery behind, and re-sending that one is idempotent on the desktop.
      if (pendingForegroundChatRecovery) {
        startForegroundChatRecovery(pendingForegroundChatRecovery, generation);
      }
      return true;
    }
  }

  await waitForReconnectBackoff(generation);
  if (!isCurrentForegroundResume(generation)) {
    return false;
  }
  setStatus("正在恢复与电脑的安全连接…");
  const reconnected = await connect({
    workspaceTimeoutMs: FOREGROUND_SYNC_RESPONSE_TIMEOUT_MS,
    replaceInFlight: true,
    preserveContext: true,
  });
  if (!reconnected || !isCurrentForegroundResume(generation)) {
    return false;
  }
  // A preserved reconnect has already resumed the open conversation from its
  // cursor. Reloading the transcript here would undo exactly the continuity
  // this path exists to provide, so only a rebuilt context needs it.
  const transcriptSynced = keptForegroundConversation(selection)
    ? true
    : await refreshForegroundConversationSelection(selection);
  if (interruptedChat && isCurrentForegroundResume(generation)) {
    startForegroundChatRecovery(interruptedChat, generation);
  }
  return transcriptSynced;
}

/**
 * Asks the existing transport one cheap question with a short deadline.
 *
 * This deliberately reads nothing the event-sync loop owns: consuming events
 * here would race that loop for the same cursor. All the probe has to decide
 * is whether the encrypted route still carries a round trip.
 */
async function probeLiveTransport(): Promise<boolean> {
  if (!transport) {
    return false;
  }
  try {
    await sendControlRequest(
      newWorkspaceOverviewRequest(),
      undefined,
      FOREGROUND_PROBE_TIMEOUT_MS,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Re-arms the desktop event stream on a route that outlived the background.
 * Restarting the loop is idempotent and resumes from the retained cursor, so
 * it costs one request and never re-renders the conversation.
 */
function resumeLiveConversation(): void {
  const projectId = activeProjectId;
  if (!projectId || !selectedChatSessionId || !canAccessRemoteChat()) {
    return;
  }
  startChatEventSync(projectId, selectedChatSessionId, { preserveTurn: true });
}

function keptForegroundConversation(selection: ForegroundConversationSelection): boolean {
  return selection.projectId !== null
    && selection.projectId === activeProjectId
    && selection.sessionId !== null
    && selection.sessionId === selectedChatSessionId;
}

/**
 * Paces repeated rebuilds. Mobile browsers emit focus and visibility events
 * far more often than a user actually switches apps, and the resume
 * coordinator keeps asking until one succeeds, so an unreachable desktop would
 * otherwise turn every event into another full renegotiation.
 */
function waitForReconnectBackoff(generation: number): Promise<void> {
  const delayMs = reconnectBackoff.delayMs();
  if (delayMs <= 0 || !isCurrentForegroundResume(generation)) {
    return Promise.resolve();
  }
  setStatus("电脑暂时无法连接，稍后自动重试…");
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function captureForegroundConversationSelection(): ForegroundConversationSelection {
  return {
    projectId: activeProjectId,
    sessionId: selectedChatSessionId,
  };
}

async function refreshForegroundConversationSelection(
  selection: ForegroundConversationSelection,
): Promise<boolean> {
  if (
    !selection.projectId ||
    !selection.sessionId ||
    selection.projectId !== activeProjectId ||
    !chatSessions.some((session) => session.sessionId === selection.sessionId)
  ) {
    return true;
  }
  if (chatSending) {
    // Keep the in-page streaming placeholder intact. Once the old request is
    // terminal (or a stale route is rejected by reconnection), fetch the
    // authoritative transcript from the desktop.
    foregroundTranscriptSyncPending = selection;
    return false;
  }
  return selectChatSession(selection.sessionId, {
    timeoutMs: FOREGROUND_SYNC_RESPONSE_TIMEOUT_MS,
  });
}

function refreshPendingForegroundTranscript(): void {
  const selection = foregroundTranscriptSyncPending;
  if (!selection || chatSending || document.hidden) {
    return;
  }
  if (phase !== "connected" || !transport) {
    return;
  }
  foregroundTranscriptSyncPending = null;
  void refreshForegroundConversationSelection(selection);
}

function foregroundChatRecoveryFrom(active: ActiveRemoteChatRequest): ForegroundChatRecovery {
  return {
    projectId: active.projectId,
    sessionId: active.sessionId,
    message: active.message,
    idempotencyKey: active.idempotencyKey,
  };
}

function startForegroundChatRecovery(
  recovery: ForegroundChatRecovery,
  resumeGeneration: number,
): void {
  pendingForegroundChatRecovery = recovery;
  const recoveryGeneration = ++foregroundChatRecoveryGeneration;
  const task = recoverForegroundChat(recovery, resumeGeneration, recoveryGeneration);
  foregroundChatRecoveryTask = task;
  void task.then(
    () => {
      if (foregroundChatRecoveryTask === task) {
        foregroundChatRecoveryTask = null;
      }
    },
    () => {
      if (foregroundChatRecoveryTask === task) {
        foregroundChatRecoveryTask = null;
      }
    },
  );
}

function clearPendingForegroundChatRecovery(recovery: ForegroundChatRecovery): void {
  if (
    pendingForegroundChatRecovery?.projectId === recovery.projectId &&
    pendingForegroundChatRecovery.sessionId === recovery.sessionId &&
    pendingForegroundChatRecovery.idempotencyKey === recovery.idempotencyKey
  ) {
    pendingForegroundChatRecovery = null;
  }
}

function canRecoverForegroundChat(resumeGeneration: number, recoveryGeneration: number): boolean {
  return recoveryGeneration === foregroundChatRecoveryGeneration &&
    isCurrentForegroundResume(resumeGeneration) &&
    phase === "connected" &&
    transport !== null;
}

async function recoverForegroundChat(
  recovery: ForegroundChatRecovery,
  resumeGeneration: number,
  recoveryGeneration: number,
): Promise<void> {
  for (let attempt = 0; attempt < FOREGROUND_CHAT_RECOVERY_MAX_ATTEMPTS; attempt += 1) {
    if (!canRecoverForegroundChat(resumeGeneration, recoveryGeneration)) {
      return;
    }
    let accepted = false;
    try {
      const response = await sendControlRequest(
        newChatMessageRequest(
          recovery.projectId,
          recovery.sessionId,
          recovery.message,
          recovery.idempotencyKey,
        ),
        (progressResponse) => {
          if (!canRecoverForegroundChat(resumeGeneration, recoveryGeneration)) {
            return;
          }
          const progress = chatMessageProgress(progressResponse);
          if (progress?.kind === "activity") {
            setStatus(progress.activity === "tool"
              ? "SomniQ 仍在电脑上执行工具…"
              : progress.activity === "compacting"
                ? "SomniQ 正在电脑上压缩会话上下文…"
                : progress.activity === "preparing"
                  ? "SomniQ 正在电脑上准备上一个任务…"
                  : "SomniQ 仍在电脑上思考…");
          } else if (progress?.kind === "accepted") {
            accepted = true;
            setStatus("正在恢复发送给电脑的上一条消息…");
          }
        },
        FOREGROUND_SYNC_RESPONSE_TIMEOUT_MS,
      );
      if (!canRecoverForegroundChat(resumeGeneration, recoveryGeneration)) {
        return;
      }
      const terminal = chatMessageTerminal(response);
      if (
        terminal &&
        terminal.projectId === recovery.projectId &&
        terminal.sessionId === recovery.sessionId
      ) {
        clearPendingForegroundChatRecovery(recovery);
        await refreshRecoveredChatTranscript(recovery, resumeGeneration, recoveryGeneration);
        return;
      }
      if (!isRemoteChatRecoveryPending(response)) {
        clearPendingForegroundChatRecovery(recovery);
        return;
      }
    } catch {
      if (!canRecoverForegroundChat(resumeGeneration, recoveryGeneration)) {
        return;
      }
      if (!accepted) {
        await connect({
          workspaceTimeoutMs: FOREGROUND_SYNC_RESPONSE_TIMEOUT_MS,
          replaceInFlight: true,
          preserveContext: true,
        });
      }
    }
    await waitForForegroundChatRecoveryRetry(resumeGeneration, recoveryGeneration);
  }
}

function isRemoteChatRecoveryPending(response: ControlResponse): boolean {
  return response.outcome.status === "error" &&
    isRecord(response.outcome.error) &&
    response.outcome.error.code === "temporarily_unavailable";
}

async function refreshRecoveredChatTranscript(
  recovery: ForegroundChatRecovery,
  resumeGeneration: number,
  recoveryGeneration: number,
): Promise<void> {
  if (!canRecoverForegroundChat(resumeGeneration, recoveryGeneration)) {
    return;
  }
  const sessionsRefreshed = await refreshChatSessions({
    timeoutMs: FOREGROUND_SYNC_RESPONSE_TIMEOUT_MS,
  });
  if (
    !sessionsRefreshed ||
    !canRecoverForegroundChat(resumeGeneration, recoveryGeneration) ||
    activeProjectId !== recovery.projectId ||
    !chatSessions.some((session) => session.sessionId === recovery.sessionId) ||
    (selectedChatSessionId !== null && selectedChatSessionId !== recovery.sessionId)
  ) {
    return;
  }
  await selectChatSession(recovery.sessionId, {
    timeoutMs: FOREGROUND_SYNC_RESPONSE_TIMEOUT_MS,
  });
}

function waitForForegroundChatRecoveryRetry(
  resumeGeneration: number,
  recoveryGeneration: number,
): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, FOREGROUND_CHAT_RECOVERY_RETRY_MS);
    if (!canRecoverForegroundChat(resumeGeneration, recoveryGeneration)) {
      clearTimeout(timer);
      resolve();
    }
  });
}

async function selectWorkspaceProject(projectId: string): Promise<void> {
  if (
    !canAccessRemoteChat() ||
    !supportsRemoteCapability("set_active_project") ||
    projectSwitching ||
    projectId === activeProjectId
  ) {
    return;
  }
  if (!workspaceProjects.some((project) => project.projectId === projectId)) {
    return;
  }

  projectSwitching = true;
  renderWorkspaceProjects();
  updateChatComposer();
  try {
    const response = await sendControlRequest(newSetActiveProjectRequest(projectId));
    const overview = workspaceOverviewFromResponse(response);
    if (!overview || overview.projects.length === 0) {
      if (isUnsupportedRemoteCommand(response, "set_active_project")) {
        disableRemoteCapability("set_active_project");
        throw new Error("这台电脑尚不支持从手机切换项目。请更新桌面端后重试。");
      }
      throw controlResponseError(response, "电脑没有确认项目切换。");
    }
    const { projects } = overview;
    const project = projects.find((entry) => entry.isActive)
      ?? projects.find((entry) => entry.projectId === projectId);
    if (!project) {
      throw new Error("电脑没有切换到所选项目。");
    }
    workspaceProjects = projects;
    setWorkspaceCapabilities(overview);
    activeProjectId = project.projectId;
    resetRemoteChatState();
    workspaceProjectsDetails.open = false;
    renderWorkspaceProjects();
    renderChatWorkspaceHeader();
    updateChatComposer();
    setStatus(`已切换到「${project.title}」。`);
    await refreshChatSessions({ openNewest: true });
  } catch (error) {
    setStatus(errorMessage(error));
  } finally {
    projectSwitching = false;
    renderWorkspaceProjects();
    updateChatComposer();
  }
}

async function sendChatMessage(): Promise<void> {
  const message = chatInput.value.trim();
  if (!message || chatSending) {
    return;
  }
  if (!canSendChat()) {
    updateChatComposer();
    return;
  }

  const projectId = activeProjectId;
  const sessionId = selectedChatSessionId;
  if (!projectId || !sessionId) {
    updateChatComposer();
    return;
  }

  stopChatEventSync();
  const idempotencyKey = crypto.randomUUID();
  // A fresh user turn supersedes any background recovery probe for an older
  // turn, so it cannot unexpectedly replace the conversation later.
  foregroundChatRecoveryGeneration += 1;
  pendingForegroundChatRecovery = null;
  const richStream = workspaceCapabilityState.advertised
    && workspaceCapabilityState.capabilities.has("rich_chat_progress");
  const activeRequest: ActiveRemoteChatRequest = {
    projectId,
    sessionId,
    message,
    idempotencyKey,
    messageId: null,
    activity: "preparing",
    startedAt: Date.now(),
    streamedText: "",
    blocks: [],
    richStream,
    stopRequested: false,
    stopRequestInFlight: false,
  };
  activeRemoteChatRequest = activeRequest;

  chatSending = true;
  updateChatComposer();
  // The user just tapped send, so bring their own turn into view wherever they
  // were reading; from here on the follow rule keeps them in control.
  appendChatMessage("user", message, false, { force: true });
  const reply = appendChatMessage("assistant", activeRemoteChatStatus(activeRequest), true, {
    force: true,
  });
  activeRemoteChatReply = reply;
  let streamRenderFrame: number | null = null;
  startChatActivityTimer(activeRequest, reply);
  chatInput.value = "";
  resizeChatComposer();

  try {
    const response = await sendControlRequest(
      newChatMessageRequest(projectId, sessionId, message, idempotencyKey, Date.now(), richStream),
      (progressResponse) => {
        const progress = chatMessageProgress(progressResponse);
        if (!progress || activeRemoteChatRequest !== activeRequest) {
          return;
        }
        if (progress.kind === "accepted") {
          if (progress.projectId !== projectId || activeRequest.messageId) return;
          activeRequest.messageId = progress.messageId;
          renderPendingRemoteReply(reply, activeRequest);
          updateChatComposer();
          if (activeRequest.stopRequested) void dispatchChatStop(activeRequest);
          return;
        }
        if (
          progress.projectId !== projectId
          || progress.sessionId !== sessionId
          || progress.messageId !== activeRequest.messageId
        ) return;
        if (progress.kind === "activity") {
          activeRequest.activity = progress.activity;
          renderPendingRemoteReply(reply, activeRequest);
          updateChatComposer();
          return;
        }
        if (progress.kind === "event") {
          activeRequest.blocks = applyChatMessageEvent(activeRequest.blocks, progress.event);
          if (progress.event.kind === "text_delta") {
            activeRequest.streamedText += progress.event.delta;
          } else if (progress.event.kind === "thinking_delta") {
            activeRequest.activity = "thinking";
          } else {
            activeRequest.activity = "tool";
          }
        } else {
          activeRequest.streamedText += progress.delta;
        }
        if (streamRenderFrame === null) {
          streamRenderFrame = window.requestAnimationFrame(() => {
            streamRenderFrame = null;
            if (activeRemoteChatRequest === activeRequest) {
              renderPendingRemoteReply(reply, activeRequest);
            }
          });
        }
      },
    );
    if (activeRemoteChatRequest !== activeRequest) {
      return;
    }
    const terminal = chatMessageTerminal(response);
    if (
      !terminal
      || terminal.projectId !== projectId
      || terminal.sessionId !== sessionId
      || (activeRequest.messageId !== null && terminal.messageId !== activeRequest.messageId)
    ) {
      throw controlResponseError(response, "电脑没有返回对话回复。");
    }
    activeRequest.messageId ??= terminal.messageId;
    if (streamRenderFrame !== null) {
      window.cancelAnimationFrame(streamRenderFrame);
      streamRenderFrame = null;
    }
    if (terminal.kind === "completed") {
      // The terminal frame remains bounded for the encrypted relay, while the
      // ordered live stream may contain a longer complete answer. Never throw
      // away that already verified mobile stream in favour of the replay-safe
      // terminal preview.
      const visibleText = activeRequest.streamedText.length > terminal.text.length
        ? activeRequest.streamedText
        : terminal.text;
      if (activeRequest.blocks.length > 0) {
        completeRemoteChatBlocks(activeRequest, visibleText);
        renderRemoteChatBlocks(reply, activeRequest.blocks, false);
      } else {
        setChatMessageContent(reply, "assistant", visibleText);
      }
      setStatus("已收到电脑上的 SomniQ 回复。");
    } else {
      if (activeRequest.blocks.length > 0) {
        renderRemoteChatBlocks(reply, activeRequest.blocks, false, "已停止。");
      } else {
        setChatMessageContent(reply, "assistant", activeRequest.streamedText || "已停止。");
      }
      setStatus("已停止电脑上的当前回复。");
    }
    reply.classList.remove("pending");
    void refreshChatSessions();
  } catch (error) {
    if (streamRenderFrame !== null) {
      window.cancelAnimationFrame(streamRenderFrame);
      streamRenderFrame = null;
    }
    if (activeRemoteChatRequest === activeRequest) {
      setChatMessageContent(reply, "assistant", `发送失败：${errorMessage(error)}`);
      reply.classList.remove("pending");
      reply.classList.add("error");
      setStatus(errorMessage(error));
    }
  } finally {
    if (activeRemoteChatRequest !== activeRequest) {
      return;
    }
    clearActiveRemoteChatRequest(activeRequest);
    chatSending = false;
    if (activeProjectId === projectId && selectedChatSessionId === sessionId) {
      startChatEventSync(projectId, sessionId);
    }
    updateChatComposer();
    refreshPendingForegroundTranscript();
  }
}

async function stopChatMessage(): Promise<void> {
  const active = activeRemoteChatRequest;
  if (
    !active
    || !chatSending
    || !canAccessRemoteChat()
    || !supportsRemoteCapability("stop_chat_message")
    || active.stopRequested
  ) {
    updateChatComposer();
    return;
  }
  active.stopRequested = true;
  renderPendingRemoteReplyForActiveTurn(active);
  updateChatComposer();
  await dispatchChatStop(active);
}

async function dispatchChatStop(active: ActiveRemoteChatRequest): Promise<void> {
  if (
    activeRemoteChatRequest !== active
    || !active.stopRequested
    || !active.messageId
    || active.stopRequestInFlight
  ) return;
  active.stopRequestInFlight = true;
  updateChatComposer();
  try {
    const response = await sendControlRequest(
      newStopChatMessageRequest(active.projectId, active.sessionId, active.messageId),
      undefined,
      STOP_CHAT_RESPONSE_TIMEOUT_MS,
    );
    if (!chatMessageStopRequested(response, active.projectId, active.sessionId, active.messageId)) {
      if (isUnsupportedRemoteCommand(response, "stop_chat_message")) {
        disableRemoteCapability("stop_chat_message");
        throw new Error("当前电脑版本尚不支持从手机停止回复，请更新并重启 SomniQ Studio。");
      }
      throw controlResponseError(response, "电脑没有确认停止当前回复。");
    }
    if (activeRemoteChatRequest === active) {
      setStatus("正在停止电脑上的当前回复…");
    }
  } catch (error) {
    if (activeRemoteChatRequest === active) {
      active.stopRequested = false;
      setStatus(errorMessage(error));
      updateChatComposer();
    }
  } finally {
    if (activeRemoteChatRequest === active) {
      active.stopRequestInFlight = false;
      updateChatComposer();
    }
  }
}

function activeRemoteChatStatus(active: ActiveRemoteChatRequest): string {
  const elapsedSeconds = Math.max(1, Math.floor((Date.now() - active.startedAt) / 1_000));
  if (active.stopRequested) return `正在停止当前回复… · ${elapsedSeconds}s`;
  const label = active.activity === "tool"
    ? "正在执行工具"
    : active.activity === "compacting"
      ? "正在压缩会话上下文"
      : active.activity === "preparing"
        ? "正在准备任务"
        : "正在思考";
  return `SomniQ ${label}… · ${elapsedSeconds}s`;
}

function renderPendingRemoteReply(reply: HTMLElement, active: ActiveRemoteChatRequest): void {
  const following = followingChatLogBottom();
  if (active.blocks.length > 0) {
    renderRemoteChatBlocks(
      reply,
      active.blocks,
      true,
      active.stopRequested ? activeRemoteChatStatus(active) : undefined,
    );
  } else {
    setChatMessageContent(reply, "assistant", active.streamedText || activeRemoteChatStatus(active));
  }
  // The phone's own reply grows below the fold as it streams. Without this the
  // reader is left behind by their own turn and has to chase it by hand.
  if (following) {
    scrollChatLogToBottom();
  }
}

function renderPendingRemoteReplyForActiveTurn(active: ActiveRemoteChatRequest): void {
  if (activeRemoteChatRequest !== active) return;
  const pendingReplies = [...chatLog.querySelectorAll<HTMLElement>(".chat-turn.pending")];
  const pendingReply = pendingReplies[pendingReplies.length - 1];
  if (pendingReply) renderPendingRemoteReply(pendingReply, active);
}

function startChatActivityTimer(active: ActiveRemoteChatRequest, reply: HTMLElement): void {
  stopChatActivityTimer();
  chatActivityTimer = setInterval(() => {
    if (activeRemoteChatRequest !== active || !chatSending) {
      stopChatActivityTimer();
      return;
    }
    if (!active.streamedText && active.blocks.length === 0) renderPendingRemoteReply(reply, active);
    updateChatComposer();
  }, 1_000);
}

function stopChatActivityTimer(): void {
  if (chatActivityTimer !== null) {
    clearInterval(chatActivityTimer);
    chatActivityTimer = null;
  }
}

function clearActiveRemoteChatRequest(expected?: ActiveRemoteChatRequest): void {
  if (expected && activeRemoteChatRequest !== expected) return;
  activeRemoteChatRequest = null;
  activeRemoteChatReply = null;
  stopChatActivityTimer();
}

async function refreshChatSessions(options: ChatSessionRefreshOptions = {}): Promise<boolean> {
  if (!canAccessRemoteChat()) {
    updateChatComposer();
    return false;
  }
  const projectId = activeProjectId;
  if (!projectId) {
    return requestWorkspaceOverview();
  }

  let sessionToOpen: string | null = null;
  let refreshed = false;
  chatSessionsLoading = true;
  renderChatSessionNavigation();
  updateChatComposer();
  try {
    const response = await sendControlRequest(
      newListChatSessionsRequest(projectId),
      undefined,
      options.timeoutMs,
    );
    const sessionResult = chatSessionsFromResponse(response, projectId);
    if (!sessionResult) {
      throw controlResponseError(response, "电脑没有返回可用的对话列表。");
    }
    if (activeProjectId !== projectId) {
      return false;
    }
    chatSessions = sessionResult.sessions;
    const selectedSessionStillExists = selectedChatSessionId !== null &&
      chatSessions.some((session) => session.sessionId === selectedChatSessionId);
    if (options.openNewest) {
      const newestSession = newestChatSessionId(chatSessions);
      if (newestSession && newestSession !== selectedChatSessionId) {
        sessionToOpen = newestSession;
      }
      if (!newestSession) {
        selectedChatSessionId = null;
        clearChatLog("请先在桌面创建一段对话，再从手机继续。");
      }
    } else if (!selectedSessionStillExists) {
      selectedChatSessionId = null;
      clearChatLog("选择一个桌面对话后显示历史。");
    }
    renderChatSessionNavigation();
    chatSessionStatus.textContent = chatSessions.length === 0
      ? "这台电脑上还没有可继续的对话。"
      : `已加载 ${chatSessions.length} 个桌面对话。${sessionResult.hasMore ? "仅显示最近的 200 个。" : ""}`;
    setStatus("已加载电脑中的对话列表。");
    refreshed = true;
  } catch (error) {
    chatSessionStatus.textContent = errorMessage(error);
    setStatus(errorMessage(error));
  } finally {
    chatSessionsLoading = false;
    renderChatSessionNavigation();
    updateChatComposer();
  }

  if (sessionToOpen && activeProjectId === projectId && canAccessRemoteChat()) {
    return selectChatSession(sessionToOpen, { timeoutMs: options.timeoutMs });
  }
  return refreshed;
}

async function createChatSession(): Promise<void> {
  const projectId = activeProjectId;
  if (
    !projectId
    || !canAccessRemoteChat()
    || !supportsRemoteCapability("create_chat_session")
    || chatSessionCreating
  ) {
    updateChatComposer();
    return;
  }

  chatSessionCreating = true;
  renderChatSessionNavigation();
  updateChatComposer();
  chatSessionStatus.textContent = "正在电脑上新建对话…";
  try {
    const response = await sendControlRequest(newCreateChatSessionRequest(projectId));
    const created = chatSessionCreatedFromResponse(response, projectId);
    if (!created) {
      if (isUnsupportedRemoteCommand(response, "create_chat_session")) {
        disableRemoteCapability("create_chat_session");
        throw new Error("当前电脑端版本尚不支持手机新建对话，请更新并重启 SomniQ Studio。");
      }
      throw controlResponseError(response, "电脑没有返回新建的对话。");
    }
    if (activeProjectId !== projectId) {
      return;
    }

    const session: RemoteChatSession = {
      sessionId: created.sessionId,
      title: created.title || "新对话",
      updatedAtUnixMs: created.updatedAtUnixMs,
      model: created.model,
    };
    chatSessions = [session, ...chatSessions.filter((entry) => entry.sessionId !== session.sessionId)];
    chatSessionStatus.textContent = "新对话已创建。";
    setStatus("已在电脑上创建新对话。");
    renderChatSessionNavigation();
    await selectChatSession(session.sessionId);
  } catch (error) {
    chatSessionStatus.textContent = errorMessage(error);
    setStatus(errorMessage(error));
  } finally {
    chatSessionCreating = false;
    renderChatSessionNavigation();
    updateChatComposer();
  }
}

async function selectChatSession(
  sessionId: string,
  options: ChatTranscriptLoadOptions = {},
): Promise<boolean> {
  stopChatEventSync();
  const loadGeneration = ++chatTranscriptLoadGeneration;
  loadedTranscriptMessages = [];
  if (!sessionId) {
    selectedChatSessionId = null;
    clearChatLog("选择一个桌面对话后显示历史。");
    renderChatSessionNavigation();
    updateChatComposer();
    return false;
  }
  if (!chatSessions.some((session) => session.sessionId === sessionId)) {
    selectedChatSessionId = null;
    renderChatSessionNavigation();
    updateChatComposer();
    return false;
  }
  const projectId = activeProjectId;
  if (!projectId || !canAccessRemoteChat()) {
    return false;
  }

  // The retained cursor tracks the rendered transcript, and this reload
  // replaces it wholesale. Drop it so the next batch reconciles against the
  // freshly rendered messages instead of resuming past them.
  chatEventCursors.forget(projectId, sessionId);
  selectedChatSessionId = sessionId;
  chatTranscriptLoading = true;
  resetChatModelState();
  setWorkspaceDrawerOpen(false);
  clearChatLog("正在加载此对话的历史…");
  renderChatSessionNavigation();
  updateChatComposer();
  try {
    const response = await sendControlRequest(
      newChatTranscriptRequest(projectId, sessionId, INITIAL_CHAT_TRANSCRIPT_LIMIT),
      undefined,
      options.timeoutMs,
    );
    const transcript = chatTranscriptFromResponse(response);
    if (!transcript || transcript.projectId !== projectId || transcript.sessionId !== sessionId) {
      throw controlResponseError(response, "电脑没有返回对话历史。");
    }
    if (!isCurrentChatTranscriptLoad(projectId, sessionId, loadGeneration)) {
      return false;
    }
    loadedTranscriptMessages = [...transcript.messages];
    renderChatTranscript(transcript.messages);
    const session = chatSessions.find((entry) => entry.sessionId === sessionId);
    chatSessionStatus.textContent = session
      ? `正在继续「${session.title}」。${transcript.hasMore ? `已先显示最新 ${transcript.messages.length} 条，正在补充较早历史…` : ""}`
      : "已加载对话历史。";
    setStatus(transcript.hasMore ? "已显示最新消息，正在后台补充历史。" : "已加载所选桌面对话的历史。");
    void refreshChatModelState(projectId, sessionId);
    startChatEventSync(projectId, sessionId);
    if (transcript.hasMore) {
      void backfillChatTranscript(
        projectId,
        sessionId,
        loadGeneration,
        options.timeoutMs,
      );
    }
    return true;
  } catch (error) {
    if (isCurrentChatTranscriptLoad(projectId, sessionId, loadGeneration)) {
      clearChatLog(`无法加载历史：${errorMessage(error)}`);
      chatSessionStatus.textContent = errorMessage(error);
      selectedChatSessionId = null;
    }
    if (activeProjectId === projectId && chatTranscriptLoadGeneration === loadGeneration) {
      setStatus(errorMessage(error));
    }
    return false;
  } finally {
    if (activeProjectId === projectId && chatTranscriptLoadGeneration === loadGeneration) {
      chatTranscriptLoading = false;
    }
    renderChatSessionNavigation();
    updateChatComposer();
  }
}

function isCurrentChatTranscriptLoad(
  projectId: string,
  sessionId: string,
  generation: number,
): boolean {
  return activeProjectId === projectId
    && selectedChatSessionId === sessionId
    && chatTranscriptLoadGeneration === generation;
}

async function backfillChatTranscript(
  projectId: string,
  sessionId: string,
  generation: number,
  timeoutMs?: number,
): Promise<void> {
  let hasMore = true;
  for (const limit of CHAT_TRANSCRIPT_BACKFILL_LIMITS) {
    if (!hasMore || !isCurrentChatTranscriptLoad(projectId, sessionId, generation)) return;
    try {
      const response = await sendControlRequest(
        newChatTranscriptRequest(projectId, sessionId, limit),
        undefined,
        timeoutMs,
      );
      const transcript = chatTranscriptFromResponse(response);
      if (
        !transcript
        || transcript.projectId !== projectId
        || transcript.sessionId !== sessionId
        || !isCurrentChatTranscriptLoad(projectId, sessionId, generation)
      ) return;

      const olderMessages = olderTranscriptPrefix(transcript.messages, loadedTranscriptMessages);
      if (olderMessages === null) return;
      if (olderMessages.length > 0) {
        prependChatTranscriptMessages(olderMessages);
        loadedTranscriptMessages = [...olderMessages, ...loadedTranscriptMessages];
      }
      hasMore = transcript.hasMore;
      const session = chatSessions.find((entry) => entry.sessionId === sessionId);
      chatSessionStatus.textContent = session
        ? `正在继续「${session.title}」。已加载最近 ${loadedTranscriptMessages.length} 条${hasMore ? "，仍有更早内容。" : "。"}`
        : `已加载最近 ${loadedTranscriptMessages.length} 条消息。`;
    } catch {
      if (isCurrentChatTranscriptLoad(projectId, sessionId, generation)) {
        chatSessionStatus.textContent = "最新消息已显示；较早历史将在下次打开对话时重试。";
      }
      return;
    }
  }
  if (
    isCurrentChatTranscriptLoad(projectId, sessionId, generation)
    && !chatSending
    && activeRemoteChatRequest === null
  ) {
    setStatus(hasMore ? "已加载最近 100 条消息。" : "对话历史已更新。");
  }
}

async function sendControlRequest(
  request: ControlRequest,
  onProgress?: (response: ControlResponse) => void,
  timeoutMs = CONTROL_RESPONSE_TIMEOUT_MS,
): Promise<ControlResponse> {
  const activeTransport = transport;
  if (!activeTransport) {
    throw new Error("请先安全连接电脑。");
  }

  const response = new Promise<ControlResponse>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingControlRequests.delete(request.request_id);
      reject(new Error("等待电脑响应超时，请重试。"));
    }, timeoutMs);
    pendingControlRequests.set(request.request_id, { resolve, reject, onProgress, timeout });
  });

  try {
    await activeTransport.send(encodeControlRequest(request));
  } catch (error) {
    rejectPendingControlRequest(request.request_id, error instanceof Error ? error : new Error(errorMessage(error)));
  }
  return response;
}

async function revokeAndForget(): Promise<void> {
  if (!pairedSession) {
    return;
  }
  const sessionToRemove = pairedSession;
  const desktopName = displayLabelForSession(sessionToRemove);
  if (!window.confirm(`确定撤销「${desktopName}」吗？其他已配对设备会保留。`)) {
    return;
  }
  setBusy(revokePairingButton, true);
  setBusy(forgetPairingButton, true);
  try {
    await api.revokeThisDevice(
      sessionToRemove.invitation.gateway_url,
      sessionToRemove.credential,
    );
    rejectPendingControlRequests(new Error("The paired device was revoked."));
    disconnectForDeviceChange();
    await clearIdentityForSession(sessionToRemove);
    const collection = await sessionStore.remove(sessionToRemove.invitation.desktop.device_id);
    pairedSessions = collection.sessions;
    pairedSession = collection.activeDesktopDeviceId
      ? collection.sessions.find(
        (entry) => entry.invitation.desktop.device_id === collection.activeDesktopDeviceId,
      ) ?? null
      : null;
    addingDevice = false;
    renderPairedDevices();
    if (pairedSession) {
      updateDesktopLabels(pairedSession);
      setPhase("paired");
      setStatus(`已撤销「${desktopName}」，正在连接下一台设备…`);
      await connect({ replaceInFlight: true });
    } else {
      setPhase("scan");
      setStatus(`已撤销「${desktopName}」。可扫描二维码添加另一台设备。`);
    }
  } catch (error) {
    setStatus(`撤销失败：${errorMessage(error)}`);
  } finally {
    setBusy(revokePairingButton, false);
    setBusy(forgetPairingButton, false);
  }
}

function showControlResponse(frame: Uint8Array): void {
  try {
    const response = parseControlResponse(frame);
    const pending = pendingControlRequests.get(response.request_id);
    if (pending) {
      if (chatMessageProgress(response)) {
        pending.onProgress?.(response);
        return;
      }
      pendingControlRequests.delete(response.request_id);
      clearTimeout(pending.timeout);
      pending.resolve(response);
      return;
    }
    setStatus("已收到电脑的加密响应。");
  } catch (error) {
    setStatus(errorMessage(error));
  }
}

function chatSessionsFromResponse(
  response: ControlResponse,
  projectId: string,
): { sessions: RemoteChatSession[]; hasMore: boolean } | null {
  if (response.outcome.status !== "success" || !isRecord(response.outcome.result)) {
    return null;
  }
  const resultValue = response.outcome.result;
  if (
    resultValue.type !== "chat_sessions" ||
    resultValue.project_id !== projectId ||
    !Array.isArray(resultValue.sessions) ||
    typeof resultValue.has_more !== "boolean"
  ) {
    return null;
  }

  const sessions: RemoteChatSession[] = [];
  for (const entry of resultValue.sessions) {
    if (
      !isRecord(entry) ||
      typeof entry.session_id !== "string" ||
      entry.session_id.length === 0 ||
      typeof entry.title !== "string" ||
      typeof entry.updated_at_unix_ms !== "number" ||
      !Number.isSafeInteger(entry.updated_at_unix_ms) ||
      (entry.model !== undefined && entry.model !== null && typeof entry.model !== "string")
    ) {
      return null;
    }
    sessions.push({
      sessionId: entry.session_id,
      title: entry.title || "未命名对话",
      updatedAtUnixMs: entry.updated_at_unix_ms,
      model: typeof entry.model === "string" && entry.model.trim() ? entry.model.trim() : null,
    });
  }
  return { sessions, hasMore: resultValue.has_more };
}

function chatTranscriptFromResponse(response: ControlResponse): {
  projectId: string;
  sessionId: string;
  messages: RemoteTranscriptMessage[];
  hasMore: boolean;
} | null {
  if (response.outcome.status !== "success" || !isRecord(response.outcome.result)) {
    return null;
  }
  const resultValue = response.outcome.result;
  if (
    resultValue.type !== "chat_transcript" ||
    typeof resultValue.project_id !== "string" ||
    typeof resultValue.session_id !== "string" ||
    typeof resultValue.title !== "string" ||
    typeof resultValue.updated_at_unix_ms !== "number" ||
    !Number.isSafeInteger(resultValue.updated_at_unix_ms) ||
    !Array.isArray(resultValue.messages) ||
    typeof resultValue.has_more !== "boolean"
  ) {
    return null;
  }

  const messages: RemoteTranscriptMessage[] = [];
  for (const entry of resultValue.messages) {
    const message = remoteTranscriptMessageFromWire(entry);
    if (!message) return null;
    messages.push(message);
  }
  return {
    projectId: resultValue.project_id,
    sessionId: resultValue.session_id,
    messages,
    hasMore: resultValue.has_more,
  };
}

function startChatEventSync(
  projectId: string,
  sessionId: string,
  options: { preserveTurn?: boolean } = {},
): void {
  // Resuming the same conversation keeps the in-progress reply bubble so the
  // replayed remainder of a desktop turn continues it. Opening a different
  // conversation clears the log, so its turn binding must go with it.
  stopChatEventSync(options);
  if (
    !workspaceCapabilityState.advertised
    || !workspaceCapabilityState.capabilities.has("chat_event_sync")
    || phase !== "connected"
    || !transport
  ) return;
  const generation = chatEventSyncGeneration;
  void runChatEventSync(projectId, sessionId, generation);
}

function stopChatEventSync(options: { preserveTurn?: boolean } = {}): void {
  chatEventSyncGeneration += 1;
  if (!options.preserveTurn) {
    desktopSyncedChatTurn = null;
  }
}

function isCurrentChatEventSync(projectId: string, sessionId: string, generation: number): boolean {
  return generation === chatEventSyncGeneration
    && phase === "connected"
    && transport !== null
    && activeProjectId === projectId
    && selectedChatSessionId === sessionId;
}

async function runChatEventSync(
  projectId: string,
  sessionId: string,
  generation: number,
): Promise<void> {
  // Resuming from the retained cursor is what turns a dropped transport into a
  // continuation instead of a reload: the desktop replays only what this phone
  // has not consumed yet. A first visit has no cursor and asks for the usual
  // latest-turn reconcile.
  let afterSeq = chatEventCursors.resume(projectId, sessionId);
  while (isCurrentChatEventSync(projectId, sessionId, generation)) {
    if (chatSending) {
      await waitForChatEventRetry();
      continue;
    }
    try {
      const response = await sendControlRequest(
        newChatEventsRequest(projectId, sessionId, afterSeq, 200, CHAT_EVENT_WAIT_MS),
        undefined,
        CHAT_EVENT_RESPONSE_TIMEOUT_MS,
      );
      if (!isCurrentChatEventSync(projectId, sessionId, generation)) return;
      const batch = chatSessionEventsFromResponse(response);
      if (!batch || batch.projectId !== projectId || batch.sessionId !== sessionId) {
        if (
          response.outcome.status === "error"
          && isRecord(response.outcome.error)
          && response.outcome.error.code === "invalid_request"
        ) {
          disableRemoteCapability("chat_event_sync");
          return;
        }
        throw new Error("电脑返回了无效的对话同步事件。");
      }
      if (afterSeq !== null && batch.nextSeq < afterSeq && batch.events.length === 0) {
        // The desktop's log no longer reaches the sequence this cursor came
        // from, so it is not the log the cursor describes. Restart the
        // reconcile instead of polling a position that will never be reached.
        chatEventCursors.forget(projectId, sessionId);
        afterSeq = null;
        continue;
      }
      const initialSnapshot = afterSeq === null;
      let appliedSeq: number | null = null;
      let appliedAll = true;
      for (const [index, event] of batch.events.entries()) {
        if (!isCurrentChatEventSync(projectId, sessionId, generation)) {
          appliedAll = false;
          break;
        }
        // A research turn can contain many large tool-card updates. Mutate the
        // local blocks for every ordered event, but rebuild the message DOM
        // only once after the encrypted batch has been applied.
        applyDesktopChatSessionEvent(
          event,
          sessionId,
          initialSnapshot,
          index === batch.events.length - 1,
        );
        appliedSeq = event.seq;
      }
      // `next_seq` can run past the last visible event because invisible
      // desktop entries still advance the durable cursor. Trust it only for a
      // fully applied batch; an aborted one must resume at the last event this
      // phone actually rendered so nothing is skipped or replayed twice.
      const consumed = appliedAll ? batch.nextSeq : appliedSeq;
      if (consumed !== null) {
        afterSeq = consumed;
        chatEventCursors.remember(projectId, sessionId, consumed);
      }
      if (!appliedAll) return;
    } catch {
      if (!isCurrentChatEventSync(projectId, sessionId, generation)) return;
      await waitForChatEventRetry();
    }
  }
}

function applyDesktopChatSessionEvent(
  event: ChatSessionEvent,
  sessionId: string,
  initialSnapshot: boolean,
  renderImmediately = true,
): void {
  if (event.kind === "reset") {
    void selectChatSession(sessionId);
    return;
  }
  if (event.kind === "user_message") {
    const turns = [...chatLog.querySelectorAll<HTMLElement>(".chat-turn")];
    const last = turns[turns.length - 1];
    const previous = turns[turns.length - 2];
    const snapshotUser = initialSnapshot
      && (last?.classList.contains("chat-user") && last.textContent === event.text
        ? last
        : last?.classList.contains("chat-assistant")
          && previous?.classList.contains("chat-user")
          && previous.textContent === event.text
          ? previous
          : null);
    if (!snapshotUser) {
      appendChatMessage("user", event.text);
    }
    const existingReply = snapshotUser === previous && last?.classList.contains("chat-assistant")
      ? last
      : null;
    const reply = existingReply ?? appendChatMessage("assistant", "SomniQ 正在思考…", true);
    reply.classList.remove("error");
    reply.classList.add("pending");
    desktopSyncedChatTurn = { userSeq: event.seq, reply, blocks: [] };
    setStatus("桌面端开始了新的对话消息。");
    updateChatComposer();
    return;
  }

  let turn = desktopSyncedChatTurn;
  if (!turn && event.kind === "assistant") {
    const reply = appendChatMessage("assistant", "SomniQ 正在思考…", true);
    turn = { userSeq: event.seq, reply, blocks: [] };
    desktopSyncedChatTurn = turn;
  }
  if (event.kind === "assistant" && turn) {
    turn.blocks = applyChatMessageEvent(turn.blocks, event.event);
    if (renderImmediately) {
      // Sampled before the render: a reader who scrolled up to re-read
      // something must not be dragged back down by every streamed batch.
      const following = followingChatLogBottom();
      renderRemoteChatBlocks(turn.reply, turn.blocks, true);
      if (following) {
        scrollChatLogToBottom();
      }
      updateChatComposer();
    }
    return;
  }
  if (event.kind === "done") {
    if (turn) {
      const following = followingChatLogBottom();
      completeRemoteBlocks(turn.blocks, event.text);
      if (turn.blocks.length > 0) renderRemoteChatBlocks(turn.reply, turn.blocks, false);
      else setChatMessageContent(turn.reply, "assistant", event.text || "桌面回复已完成。");
      turn.reply.classList.remove("pending");
      if (following) {
        scrollChatLogToBottom();
      }
    }
    desktopSyncedChatTurn = null;
    setStatus("已同步桌面端的最新回复。");
    updateChatComposer();
    void refreshChatSessions();
    return;
  }
  if (event.kind === "error") {
    if (turn) {
      const following = followingChatLogBottom();
      if (turn.blocks.length > 0) {
        renderRemoteChatBlocks(turn.reply, turn.blocks, false, `桌面执行失败：${event.message}`);
      } else {
        setChatMessageContent(turn.reply, "assistant", `桌面执行失败：${event.message}`);
      }
      turn.reply.classList.remove("pending");
      turn.reply.classList.add("error");
      if (following) {
        scrollChatLogToBottom();
      }
    }
    desktopSyncedChatTurn = null;
    setStatus(`桌面执行失败：${event.message}`);
    updateChatComposer();
  }
}

function waitForChatEventRetry(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, CHAT_EVENT_RETRY_MS));
}

function controlResponseError(response: ControlResponse, fallback: string): Error {
  if (response.outcome.status !== "error" || !isRecord(response.outcome.error)) {
    return new Error(fallback);
  }
  const code = response.outcome.error.code;
  switch (code) {
    case "unauthorized":
      return new Error("当前配对没有发送消息权限，请在电脑上重新配对并批准聊天权限。");
    case "temporarily_unavailable":
      return new Error("电脑暂时无法处理该请求，请稍后重试。");
    case "conflict":
      return new Error("电脑上的当前研究项目已变化，请刷新工作区后重试。");
    case "invalid_request":
      return new Error(fallback);
    default:
      return new Error(fallback);
  }
}

function rejectPendingControlRequest(requestId: string, error: Error): void {
  const pending = pendingControlRequests.get(requestId);
  if (!pending) {
    return;
  }
  pendingControlRequests.delete(requestId);
  clearTimeout(pending.timeout);
  pending.reject(error);
}

function rejectPendingControlRequests(error: Error): void {
  for (const [requestId, pending] of pendingControlRequests) {
    pendingControlRequests.delete(requestId);
    clearTimeout(pending.timeout);
    pending.reject(error);
  }
}

function resetRemoteChatState(): void {
  stopChatEventSync();
  clearActiveRemoteChatRequest();
  chatSending = false;
  chatSessionsLoading = false;
  chatSessionCreating = false;
  chatTranscriptLoading = false;
  chatTranscriptLoadGeneration += 1;
  loadedTranscriptMessages = [];
  chatSessions = [];
  selectedChatSessionId = null;
  resetChatModelState();
  chatSessionStatus.textContent = "";
  clearChatLog("选择一个桌面对话后显示历史。");
  renderWorkspaceProjects();
  renderChatSessionNavigation();
}

function currentWorkspaceProject(): RemoteWorkspaceProject | null {
  if (!activeProjectId) {
    return null;
  }
  return workspaceProjects.find((project) => project.projectId === activeProjectId) ?? null;
}

function renderWorkspaceProjects(): void {
  workspaceProjectsElement.replaceChildren();
  workspaceProjectCurrent.textContent = currentWorkspaceProject()?.title ?? "正在读取项目…";
  if (workspaceProjects.length === 0) {
    const placeholder = document.createElement("p");
    placeholder.className = "workspace-empty";
    placeholder.textContent = "正在读取电脑上的项目…";
    workspaceProjectsElement.append(placeholder);
    return;
  }

  const canSwitchProjects = canAccessRemoteChat() && supportsRemoteCapability("set_active_project");
  if (!canSwitchProjects) {
    const notice = document.createElement("p");
    notice.className = "workspace-access-notice";
    notice.textContent = !canAccessRemoteChat()
      ? "当前配对没有对话权限，请在电脑上重新配对。"
      : "电脑版本暂不支持从手机切换项目。";
    workspaceProjectsElement.append(notice);
  }

  for (const project of workspaceProjects) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "workspace-project";
    const isActive = project.projectId === activeProjectId;
    item.classList.toggle("active", isActive);
    item.disabled = projectSwitching || !canSwitchProjects || isActive;
    item.title = isActive
      ? "当前项目"
      : canSwitchProjects
        ? `切换到 ${project.title}`
        : "当前连接不能切换项目";
    item.setAttribute("aria-current", isActive ? "page" : "false");
    item.addEventListener("click", () => void selectWorkspaceProject(project.projectId));

    const icon = document.createElement("i");
    icon.setAttribute("data-lucide", "folder");
    icon.setAttribute("aria-hidden", "true");
    const content = document.createElement("span");
    content.className = "workspace-project-content";
    const title = document.createElement("strong");
    title.textContent = project.title;
    const meta = document.createElement("span");
    meta.className = "workspace-project-meta";
    meta.textContent = project.activeRunId
      ? "工作流正在运行"
      : isActive
        ? "当前桌面项目"
        : project.phase;
    content.append(title, meta);
    item.append(icon, content);
    workspaceProjectsElement.append(item);
  }
  renderRemoteIcons();
}

function renderChatSessionNavigation(): void {
  const available = canAccessRemoteChat();
  const canCreate = available && supportsRemoteCapability("create_chat_session");
  workspaceSessionList.replaceChildren();
  workspaceSessionCount.textContent = chatSessions.length > 0 ? String(chatSessions.length) : "";
  createChatSessionButton.disabled = !canCreate || chatSessionsLoading || chatSessionCreating;
  headerCreateChatButton.disabled = !canCreate || chatSessionsLoading || chatSessionCreating;
  createChatSessionButton.title = canCreate
    ? chatSessionCreating ? "正在新建对话" : "新建对话"
    : "请更新并重启电脑端后使用手机新建对话";
  headerCreateChatButton.title = createChatSessionButton.title;

  const emptyMessage = !available
    ? "请先连接电脑"
    : chatSessionsLoading
      ? "正在加载对话…"
      : chatSessions.length === 0
        ? canCreate ? "点击上方＋新建对话" : "没有可继续的对话"
        : "";
  if (emptyMessage) {
    const empty = document.createElement("p");
    empty.className = "workspace-empty";
    empty.textContent = emptyMessage;
    workspaceSessionList.append(empty);
  }

  for (const session of chatSessions) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "workspace-session";
    row.classList.toggle("active", session.sessionId === selectedChatSessionId);
    row.disabled = chatTranscriptLoading;
    row.title = session.title.trim() || "未命名对话";
    row.setAttribute("aria-current", session.sessionId === selectedChatSessionId ? "page" : "false");
    row.addEventListener("click", () => void selectChatSession(session.sessionId));

    const icon = document.createElement("i");
    icon.setAttribute("data-lucide", "message-square-text");
    icon.setAttribute("aria-hidden", "true");
    const content = document.createElement("span");
    content.className = "workspace-session-content";
    const title = document.createElement("span");
    title.className = "workspace-session-title";
    title.textContent = session.title.trim() || "未命名对话";
    const updated = document.createElement("time");
    updated.className = "workspace-session-updated";
    const updatedAt = new Date(session.updatedAtUnixMs);
    if (!Number.isNaN(updatedAt.getTime())) {
      updated.dateTime = updatedAt.toISOString();
    }
    updated.textContent = sessionUpdatedLabel(session);
    content.append(title, updated);
    row.append(icon, content);
    workspaceSessionList.append(row);
  }
  renderChatWorkspaceHeader();
  renderRemoteIcons();
}

function renderChatWorkspaceHeader(): void {
  const project = currentWorkspaceProject();
  const session = selectedChatSessionId
    ? chatSessions.find((entry) => entry.sessionId === selectedChatSessionId) ?? null
    : null;
  currentProjectLabel.textContent = project?.title ?? "正在读取项目";
  const sessionTitle = session?.title.trim() || "选择一个对话";
  currentSessionLabel.textContent = sessionTitle;
  connectedTitle.textContent = sessionTitle;
}

function resetChatModelState(): void {
  chatModelState = { model: null, options: [] };
  chatModelLoading = false;
  chatModelSwitching = false;
  setChatModelMenuOpen(false);
  renderChatModelControl();
}

async function refreshChatModelState(projectId: string, sessionId: string): Promise<void> {
  if (
    !canAccessRemoteChat() ||
    !supportsRemoteCapability("get_chat_model_options") ||
    projectId !== activeProjectId ||
    sessionId !== selectedChatSessionId
  ) {
    return;
  }
  chatModelLoading = true;
  renderChatModelControl();
  try {
    const response = await sendControlRequest(newChatModelOptionsRequest(projectId, sessionId));
    const modelState = chatModelStateFromResponse(response, projectId, sessionId);
    if (!modelState) {
      if (isUnsupportedRemoteCommand(response, "get_chat_model_options")) {
        disableRemoteCapability("get_chat_model_options");
        setStatus("这台电脑尚不支持从手机切换模型。请更新桌面端后重试。");
        return;
      }
      throw controlResponseError(response, "电脑没有返回可用模型。");
    }
    if (projectId !== activeProjectId || sessionId !== selectedChatSessionId) {
      return;
    }
    chatModelState = modelState;
    const session = chatSessions.find((entry) => entry.sessionId === sessionId);
    if (session) {
      session.model = modelState.model;
    }
  } catch (error) {
    if (projectId === activeProjectId && sessionId === selectedChatSessionId) {
      setStatus(errorMessage(error));
    }
  } finally {
    if (projectId === activeProjectId && sessionId === selectedChatSessionId) {
      chatModelLoading = false;
      renderChatModelControl();
    }
  }
}

async function selectChatModel(model: string): Promise<void> {
  const projectId = activeProjectId;
  const sessionId = selectedChatSessionId;
  if (
    !model ||
    !projectId ||
    !sessionId ||
    chatModelLoading ||
    chatModelSwitching ||
    model === chatModelState.model ||
    !supportsRemoteCapability("set_chat_session_model") ||
    !canSendChat()
  ) {
    return;
  }

  chatModelSwitching = true;
  setChatModelMenuOpen(false);
  renderChatModelControl();
  try {
    const response = await sendControlRequest(newSetChatSessionModelRequest(projectId, sessionId, model));
    const modelState = chatModelStateFromResponse(response, projectId, sessionId);
    if (!modelState) {
      if (isUnsupportedRemoteCommand(response, "set_chat_session_model")) {
        disableRemoteCapability("set_chat_session_model");
        setStatus("这台电脑尚不支持从手机切换模型。请更新桌面端后重试。");
        return;
      }
      throw controlResponseError(response, "电脑没有确认模型切换。");
    }
    if (projectId !== activeProjectId || sessionId !== selectedChatSessionId) {
      return;
    }
    chatModelState = modelState;
    const session = chatSessions.find((entry) => entry.sessionId === sessionId);
    if (session) {
      session.model = modelState.model;
    }
    setStatus(`此对话将使用 ${modelState.model ?? model}。`);
  } catch (error) {
    setStatus(errorMessage(error));
  } finally {
    if (projectId === activeProjectId && sessionId === selectedChatSessionId) {
      chatModelSwitching = false;
      renderChatModelControl();
    }
  }
}

function renderChatModelControl(): void {
  const sessionSelected = selectedChatSessionId !== null;
  const modelOptionsSupported = supportsRemoteCapability("get_chat_model_options");
  const modelSelectionSupported = supportsRemoteCapability("set_chat_session_model");
  const model = chatModelState.model
    ?? chatSessions.find((entry) => entry.sessionId === selectedChatSessionId)?.model
    ?? null;
  const hasOptions = chatModelState.options.length > 0;
  const canSwitch = canSendChat() && modelSelectionSupported && hasOptions && !chatModelLoading && !chatModelSwitching;
  // Keep the picker visible even while a conversation has not been selected
  // or an older desktop does not advertise model support. Hiding it made the
  // model capability look absent instead of explaining what is needed.
  chatModelControl.hidden = false;
  currentModelLabel.textContent = chatModelLoading
    ? "读取模型…"
    : chatModelSwitching
      ? "切换模型…"
      : !sessionSelected
        ? "先选择对话"
        : !modelOptionsSupported || !modelSelectionSupported
          ? "桌面需更新"
          : hasOptions
            ? model ?? "选择模型"
            : "未配置模型";
  openModelMenuButton.disabled = !canSwitch;
  openModelMenuButton.title = canSwitch
    ? "切换模型"
    : !sessionSelected
      ? "先从左上角选择一个对话"
      : !modelOptionsSupported || !modelSelectionSupported
        ? "此桌面版本尚不支持从手机切换模型"
        : hasOptions
          ? "正在读取模型"
          : "桌面没有可用模型";
  openModelMenuButton.setAttribute("aria-label", openModelMenuButton.title);
  openModelMenuButton.setAttribute("aria-expanded", String(chatModelMenuOpen && canSwitch));
  if (!canSwitch && chatModelMenuOpen) {
    setChatModelMenuOpen(false);
  }
  renderChatModelMenu();
  renderRemoteIcons();
}

function setChatModelMenuOpen(open: boolean): void {
  chatModelMenuOpen = open &&
    supportsRemoteCapability("set_chat_session_model") &&
    selectedChatSessionId !== null &&
    chatModelState.options.length > 0;
  chatModelMenu.hidden = !chatModelMenuOpen;
  openModelMenuButton.setAttribute("aria-expanded", String(chatModelMenuOpen));
  if (chatModelMenuOpen) {
    renderChatModelMenu();
  }
}

function renderChatModelMenu(): void {
  chatModelMenu.replaceChildren();
  if (!chatModelMenuOpen) {
    chatModelMenu.hidden = true;
    return;
  }
  for (const option of chatModelState.options) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "chat-model-option";
    item.setAttribute("role", "option");
    const selected = option.value === chatModelState.model;
    item.setAttribute("aria-selected", String(selected));
    item.disabled = chatModelSwitching;
    item.addEventListener("click", () => void selectChatModel(option.value));

    const label = document.createElement("span");
    label.className = "chat-model-option-label";
    label.textContent = option.label;
    const detail = document.createElement("span");
    detail.className = "chat-model-option-detail";
    detail.textContent = option.description ?? "已在桌面配置";
    item.append(label, detail);
    if (selected) {
      const icon = document.createElement("i");
      icon.setAttribute("data-lucide", "check");
      icon.setAttribute("aria-hidden", "true");
      item.append(icon);
    }
    chatModelMenu.append(item);
  }
  chatModelMenu.hidden = false;
  renderRemoteIcons();
}

function sessionUpdatedLabel(session: RemoteChatSession): string {
  if (session.updatedAtUnixMs <= 0) {
    return "桌面对话";
  }
  const updated = new Date(session.updatedAtUnixMs).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return updated;
}

function renderChatTranscript(messages: readonly RemoteTranscriptMessage[]): void {
  if (messages.length === 0) {
    clearChatLog("此对话还没有可显示的消息。");
    return;
  }
  chatLog.replaceChildren();
  const fragment = document.createDocumentFragment();
  for (const message of messages) {
    const element = createChatMessageElement(message.role, message.text);
    if (message.role === "assistant" && message.blocks.length > 0) {
      renderRemoteChatBlocks(element, message.blocks, false);
    }
    fragment.append(element);
  }
  chatLog.append(fragment);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function prependChatTranscriptMessages(messages: readonly RemoteTranscriptMessage[]): void {
  if (messages.length === 0) return;
  const previousScrollHeight = chatLog.scrollHeight;
  const previousScrollTop = chatLog.scrollTop;
  const fragment = document.createDocumentFragment();
  for (const message of messages) {
    const element = createChatMessageElement(message.role, message.text);
    if (message.role === "assistant" && message.blocks.length > 0) {
      renderRemoteChatBlocks(element, message.blocks, false);
    }
    fragment.append(element);
  }
  chatLog.prepend(fragment);
  chatLog.scrollTop = anchoredScrollTop(
    previousScrollTop,
    previousScrollHeight,
    chatLog.scrollHeight,
  );
}

function clearChatLog(message: string): void {
  const icon = document.createElement("i");
  icon.setAttribute("data-lucide", "message-square-text");
  icon.setAttribute("aria-hidden", "true");
  const text = document.createElement("p");
  text.textContent = message;
  chatEmpty.replaceChildren(icon, text);
  chatLog.replaceChildren(chatEmpty);
  renderRemoteIcons();
}

function canAccessRemoteChat(): boolean {
  return phase === "connected" &&
    transport !== null &&
    activeProjectId !== null &&
    hasChatScope();
}

function hasChatScope(): boolean {
  return pairedSession?.granted_scopes.includes("send_chat_messages") === true;
}

function supportsRemoteCapability(capability: RemoteWorkspaceCapability): boolean {
  // During a rolling desktop/PWA update, older desktop versions omit the
  // optional field entirely. Probe those commands once instead of making the
  // mobile controls read-only until the desktop is restarted or rebuilt.
  return !workspaceCapabilityState.advertised || workspaceCapabilityState.capabilities.has(capability);
}

function disableRemoteCapability(capability: RemoteWorkspaceCapability): void {
  workspaceCapabilityState = {
    advertised: true,
    capabilities: new Set(
      [...workspaceCapabilityState.capabilities].filter((entry) => entry !== capability),
    ),
  };
  if (capability === "get_chat_model_options" || capability === "set_chat_session_model") {
    setChatModelMenuOpen(false);
    renderChatModelControl();
  }
  if (capability === "create_chat_session") {
    renderChatSessionNavigation();
  }
  updateChatComposer();
}

function setWorkspaceCapabilities(overview: {
  capabilities: readonly RemoteWorkspaceCapability[];
  capabilitiesAdvertised: boolean;
}): void {
  workspaceCapabilityState = {
    capabilities: new Set(overview.capabilities),
    advertised: overview.capabilitiesAdvertised,
  };
}

function resetWorkspaceCapabilities(): void {
  workspaceCapabilityState = {
    capabilities: new Set<RemoteWorkspaceCapability>(),
    advertised: false,
  };
}

function isUnsupportedRemoteCommand(
  response: ControlResponse,
  command: RemoteWorkspaceCapability,
): boolean {
  if (response.outcome.status !== "error" || !isRecord(response.outcome.error)) {
    return false;
  }
  // `not_found` is a legitimate result for a stale chat session, so do not
  // hide a supported control on that basis. A desktop that does not recognize
  // a newer tagged command reports it as an invalid request.
  if (response.outcome.error.code !== "invalid_request") {
    return false;
  }
  const reason = typeof response.outcome.error.reason === "string"
    ? response.outcome.error.reason.toLowerCase()
    : "";
  return reason.length === 0 || reason.includes(command);
}

function canWriteChat(): boolean {
  return canAccessRemoteChat() &&
    selectedChatSessionId !== null;
}

function canSendChat(): boolean {
  return canWriteChat() && !chatTranscriptLoading && desktopSyncedChatTurn === null;
}

function updateChatComposer(): void {
  const granted = hasChatScope();
  const connected = phase === "connected" && transport !== null;
  const canWrite = canWriteChat();
  const canSend = canSendChat();
  const active = activeRemoteChatRequest;
  const desktopBusy = desktopSyncedChatTurn !== null;
  chatInput.disabled = !canWrite || chatSending || desktopBusy;
  sendChatButton.hidden = chatSending;
  sendChatButton.disabled = !canSend || chatSending || desktopBusy || chatInput.value.trim().length === 0;
  stopChatButton.hidden = !chatSending;
  stopChatButton.disabled = !chatSending
    || !active
    || !canAccessRemoteChat()
    || !supportsRemoteCapability("stop_chat_message")
    || active.stopRequested
    || active.stopRequestInFlight;
  refreshChatSessionsButton.disabled = !granted || !connected || chatSessionsLoading;
  createChatSessionButton.disabled = !canAccessRemoteChat()
    || !supportsRemoteCapability("create_chat_session")
    || chatSessionsLoading
    || chatSessionCreating;
  headerCreateChatButton.disabled = createChatSessionButton.disabled;
  refreshWorkspaceButton.disabled = !connected || projectSwitching;
  openWorkspaceButton.disabled = !connected;
  const hint = !granted
    ? "当前配对未获“发送消息”权限。请从电脑重新配对并批准该权限。"
    : !connected
      ? "连接电脑后即可发送消息。"
      : !activeProjectId
        ? "正在读取电脑上的研究工作区…"
      : chatSending
        ? active
          ? activeRemoteChatStatus(active)
          : "正在连接电脑上的对话…"
        : desktopBusy
          ? "桌面端正在回复，手机已同步显示实时进度。"
        : chatTranscriptLoading
          ? "正在加载所选对话的历史…"
          : !selectedChatSessionId
            ? "请先选择一个桌面对话。"
            : "";
  chatHint.hidden = canWrite && !chatSending && !chatTranscriptLoading && !desktopBusy;
  chatHint.textContent = hint;
  chatInput.placeholder = canWrite
    ? "给 SomniQ 发送消息"
    : !selectedChatSessionId
      ? "请从左上角选择一个对话"
      : "正在连接桌面 SomniQ…";
  renderChatWorkspaceHeader();
  renderChatModelControl();
}

/**
 * Whether the reader is watching the end of the transcript right now. Sample
 * this before rendering: afterwards the distance describes the growth that was
 * just added, not where the reader chose to be.
 */
function followingChatLogBottom(): boolean {
  return shouldFollowChatLogBottom(chatLog.scrollTop, chatLog.scrollHeight, chatLog.clientHeight);
}

function scrollChatLogToBottom(): void {
  chatLog.scrollTop = chatLog.scrollHeight;
}

function appendChatMessage(
  role: "user" | "assistant",
  text: string,
  pending = false,
  // A message the user just sent should always be brought into view. One that
  // the desktop started must not drag them out of the history they are reading.
  options: { force?: boolean } = {},
): HTMLElement {
  if (chatEmpty.isConnected) {
    chatEmpty.remove();
  }
  const following = options.force === true || followingChatLogBottom();
  const message = createChatMessageElement(role, text, pending);
  chatLog.append(message);
  if (following) {
    scrollChatLogToBottom();
  }
  return message;
}

function createChatMessageElement(
  role: "user" | "assistant",
  text: string,
  pending = false,
): HTMLElement {
  const message = document.createElement("article");
  message.className = `chat-turn chat-${role}${pending ? " pending" : ""}`;
  message.dataset.role = role;
  setChatMessageContent(message, role, text);
  return message;
}

function setChatMessageContent(message: HTMLElement, role: "user" | "assistant", text: string): void {
  if (role === "user") {
    message.textContent = text;
    return;
  }
  const content = document.createElement("div");
  content.className = "remote-markdown";
  content.append(renderRemoteMarkdown(text));
  message.replaceChildren(content);
}

function completeRemoteChatBlocks(active: ActiveRemoteChatRequest, terminalText: string): void {
  completeRemoteBlocks(active.blocks, terminalText);
}

function completeRemoteBlocks(blocks: RemoteChatBlock[], terminalText: string): void {
  const streamedBlocksText = blocks
    .filter((block): block is Extract<RemoteChatBlock, { kind: "text" }> => block.kind === "text")
    .map((block) => block.text)
    .join("");
  if (!terminalText || streamedBlocksText.length >= terminalText.length) return;
  const remainder = streamedBlocksText.length === 0
    ? terminalText
    : terminalText.startsWith(streamedBlocksText)
      ? terminalText.slice(streamedBlocksText.length)
      : "";
  if (!remainder) return;
  const last = blocks[blocks.length - 1];
  if (last?.kind === "text") last.text += remainder;
  else blocks.push({ kind: "text", text: remainder });
}

function renderRemoteChatBlocks(
  message: HTMLElement,
  blocks: readonly RemoteChatBlock[],
  pending: boolean,
  trailingStatus?: string,
): void {
  const openKeys = new Set(
    [...message.querySelectorAll<HTMLDetailsElement>(
      'details[data-block-key][open]:not([data-auto-open="true"])',
    )]
      .map((details) => details.dataset.blockKey)
      .filter((key): key is string => Boolean(key)),
  );
  const container = document.createElement("div");
  container.className = "remote-rich-blocks";
  const liveThinkingIndex = pending ? latestThinkingBlockIndex(blocks) : -1;
  blocks.forEach((block, index) => {
    if (block.kind === "text") {
      if (!block.text) return;
      const content = document.createElement("div");
      content.className = "remote-rich-text remote-markdown";
      content.append(renderRemoteMarkdown(block.text));
      container.append(content);
      return;
    }
    // A question is the one tool call the phone can act on, so it is rendered
    // as an interactive prompt rather than collapsed into a tool card.
    if (block.kind === "tool" && block.name === ASK_USER_QUESTION_TOOL) {
      const card = renderRemoteQuestionCard(block, pending);
      if (card) {
        container.append(card);
        return;
      }
    }
    const key = block.kind === "tool"
      ? `tool:${block.toolUseId ?? `${block.name}:${index}`}`
      : `thinking:${index}`;
    const details = document.createElement("details");
    details.dataset.blockKey = key;
    details.className = block.kind === "thinking" ? "remote-thinking-card" : "remote-tool-card";
    const summary = document.createElement("summary");
    const title = document.createElement("span");
    title.className = "remote-rich-title";
    if (block.kind === "thinking") {
      title.textContent = pending && index === blocks.length - 1 ? "思考中" : "思考";
      summary.append(title);
      const content = document.createElement("div");
      content.className = "remote-rich-content remote-markdown";
      content.append(renderRemoteMarkdown(block.thinking));
      details.append(summary, content);
    } else {
      title.textContent = block.name || "工具";
      const status = document.createElement("span");
      status.className = `remote-tool-status${block.isError ? " error" : ""}`;
      status.textContent = block.output === null ? "运行中" : block.isError ? "失败" : "完成";
      summary.append(title, status);
      const content = document.createElement("div");
      content.className = "remote-rich-content remote-tool-content";
      if (block.progress) {
        const progress = document.createElement("p");
        progress.className = "remote-tool-progress";
        const elapsed = `${Math.max(0, block.progress.elapsedMs / 1_000).toFixed(1)}s`;
        progress.textContent = block.progress.message || `已运行 ${elapsed}`;
        content.append(progress);
      }
      appendRemoteToolField(content, "输入", block.input);
      if (block.progress?.stdoutTail) appendRemoteToolField(content, "实时输出", block.progress.stdoutTail);
      if (block.progress?.stderrTail) appendRemoteToolField(content, "错误输出", block.progress.stderrTail, true);
      if (block.output !== null) appendRemoteToolField(content, block.isError ? "错误" : "结果", block.output, block.isError === true);
      details.append(summary, content);
    }
    const liveThinking = block.kind === "thinking" && index === liveThinkingIndex;
    const liveTool = block.kind === "tool" && index === blocks.length - 1 && block.output === null;
    const preserveUserOpen = openKeys.has(key);
    const autoOpen = pending && (liveThinking || liveTool);
    details.open = preserveUserOpen || autoOpen;
    if (autoOpen && !preserveUserOpen) {
      details.dataset.autoOpen = "true";
    }
    summary.addEventListener("click", () => {
      delete details.dataset.autoOpen;
    });
    container.append(details);
  });
  if (trailingStatus) {
    const status = document.createElement("p");
    status.className = "remote-chat-status";
    status.textContent = trailingStatus;
    container.append(status);
  }
  message.replaceChildren(container);
}

/**
 * Renders an `AskUserQuestion` tool call as an answerable prompt.
 *
 * Returns null for a payload that is not a well-formed question, or for a
 * desktop that never advertised the answer command, so the caller falls back
 * to the ordinary tool card instead of offering a control that cannot work.
 */
function renderRemoteQuestionCard(
  block: Extract<RemoteChatBlock, { kind: "tool" }>,
  pending: boolean,
): HTMLElement | null {
  const spec = parseRemoteQuestionSpec(block.input);
  if (!spec) {
    return null;
  }
  const answered = block.output !== null;
  const toolUseId = block.toolUseId;
  // Only a live turn is still blocked on this call. An answer sent after the
  // turn ended has nothing to unblock, and the desktop would reject it.
  const answerable = !answered
    && pending
    && toolUseId !== null
    && supportsRemoteCapability("answer_chat_question")
    && canAccessRemoteChat();
  const draftKey = toolUseId ?? "";
  const draft = questionDrafts.get(draftKey) ?? { selected: new Set<number>(), custom: "" };
  if (answerable) {
    questionDrafts.set(draftKey, draft);
  }

  const card = document.createElement("section");
  card.className = `remote-question-card${answered ? " answered" : answerable ? "" : " stale"}`;
  const header = document.createElement("div");
  header.className = "remote-question-header";
  const status = document.createElement("span");
  status.className = "remote-question-status";
  status.textContent = answered ? "已回答" : answerable ? "等待你的选择" : "未回答";
  header.append(status);
  if (spec.header) {
    const label = document.createElement("span");
    label.className = "remote-question-label";
    label.textContent = spec.header;
    header.append(label);
  }
  const question = document.createElement("p");
  question.className = "remote-question-text";
  question.textContent = spec.question;
  card.append(header, question);

  if (answered) {
    const answer = document.createElement("p");
    answer.className = "remote-question-answer";
    answer.textContent = block.output ?? "";
    card.append(answer);
    questionDrafts.delete(draftKey);
    return card;
  }
  if (!answerable) {
    const hint = document.createElement("p");
    hint.className = "remote-question-hint";
    hint.textContent = supportsRemoteCapability("answer_chat_question")
      ? "这个提问已经不在等待回答，请在电脑上查看该回合。"
      : "这台电脑的版本还不支持从手机回答提问，请在电脑上回答。";
    card.append(hint);
    return card;
  }

  const submit = document.createElement("button");
  const options = document.createElement("div");
  options.className = "remote-question-options";
  const custom = document.createElement("textarea");
  const syncSubmitState = () => {
    submit.disabled = composeQuestionAnswer(spec, draft.selected, draft.custom) === null;
  };
  const send = (answer: string | null) => {
    if (!answer || !toolUseId) return;
    // Latch before the await so a double tap cannot answer the same call twice.
    card.classList.add("submitting");
    for (const control of card.querySelectorAll("button, textarea")) {
      (control as HTMLButtonElement | HTMLTextAreaElement).disabled = true;
    }
    status.textContent = "正在提交回答…";
    void answerRemoteChatQuestion(toolUseId, answer, draftKey);
  };

  spec.options.forEach((option, optionIndex) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "remote-question-option";
    const label = document.createElement("span");
    label.className = "remote-question-option-label";
    label.textContent = option.label;
    button.append(label);
    if (option.description) {
      const description = document.createElement("span");
      description.className = "remote-question-option-description";
      description.textContent = option.description;
      button.append(description);
    }
    if (spec.multiSelect) {
      button.setAttribute("aria-pressed", String(draft.selected.has(optionIndex)));
      button.classList.toggle("selected", draft.selected.has(optionIndex));
      button.addEventListener("click", () => {
        if (draft.selected.has(optionIndex)) draft.selected.delete(optionIndex);
        else draft.selected.add(optionIndex);
        button.classList.toggle("selected", draft.selected.has(optionIndex));
        button.setAttribute("aria-pressed", String(draft.selected.has(optionIndex)));
        syncSubmitState();
      });
    } else {
      // A single-choice question is answered by the tap itself; an extra
      // confirmation step would only add a round of thumb travel.
      button.addEventListener("click", () => send(composeQuestionAnswer(spec, [optionIndex])));
    }
    options.append(button);
  });
  card.append(options);

  if (spec.allowCustom) {
    custom.className = "remote-question-custom";
    custom.rows = 2;
    custom.placeholder = "或输入你自己的回答…";
    custom.value = draft.custom;
    custom.addEventListener("input", () => {
      draft.custom = custom.value;
      syncSubmitState();
    });
    card.append(custom);
  }

  if (spec.multiSelect || spec.allowCustom) {
    submit.type = "button";
    submit.className = "remote-question-submit";
    submit.textContent = "提交回答";
    submit.addEventListener("click", () => {
      send(composeQuestionAnswer(spec, draft.selected, draft.custom));
    });
    syncSubmitState();
    card.append(submit);
  }
  return card;
}

/** Delivers one answer, then lets the desktop's own event stream show it. */
async function answerRemoteChatQuestion(
  toolUseId: string,
  answer: string,
  draftKey: string,
): Promise<void> {
  const projectId = activeProjectId;
  const sessionId = selectedChatSessionId;
  if (!projectId || !sessionId) return;
  try {
    const response = await sendControlRequest(
      newAnswerChatQuestionRequest(projectId, sessionId, toolUseId, answer),
      undefined,
      QUESTION_ANSWER_RESPONSE_TIMEOUT_MS,
    );
    if (!chatQuestionAnswered(response, projectId, sessionId, toolUseId)) {
      throw controlResponseError(response, "电脑没有接受这个回答。");
    }
    questionDrafts.delete(draftKey);
    setStatus("已把你的选择发送给电脑。");
  } catch (error) {
    setStatus(errorMessage(error));
    // The card was latched while submitting. Re-render from the unchanged
    // blocks so the user can retry rather than being left with dead controls.
    rerenderActiveChatBlocks();
  }
}

/**
 * Repaints the turn that currently owns the rendered blocks. Question cards
 * are the only interactive part of a turn, so this exists purely to restore
 * them after a failed answer.
 */
function rerenderActiveChatBlocks(): void {
  const desktopTurn = desktopSyncedChatTurn;
  if (desktopTurn) {
    renderRemoteChatBlocks(desktopTurn.reply, desktopTurn.blocks, true);
    return;
  }
  const active = activeRemoteChatRequest;
  const reply = activeRemoteChatReply;
  if (active && reply) {
    renderRemoteChatBlocks(reply, active.blocks, true);
  }
}

function appendRemoteToolField(
  parent: HTMLElement,
  labelText: string,
  value: string,
  error = false,
): void {
  if (!value) return;
  const section = document.createElement("section");
  section.className = `remote-tool-field${error ? " error" : ""}`;
  const label = document.createElement("p");
  label.textContent = labelText;
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = value;
  pre.append(code);
  section.append(label, pre);
  parent.append(section);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Releases the state a discarded transport owned: its long-running chat
 * request and its polling loop. The open project, conversation list, rendered
 * transcript and event cursors all survive, because the desktop can still
 * prove them and a reconnect should continue from them.
 */
function releaseTransportBoundChatState(): void {
  stopChatEventSync({ preserveTurn: true });
  const interrupted = activeRemoteChatRequest;
  if (interrupted) {
    // A phone-initiated turn streams over the request route, so this session's
    // event cursor never advanced past its own user message. Replaying the
    // whole latest turn lets the snapshot reconcile reuse the bubbles already
    // on screen instead of appending a duplicate question and answer.
    chatEventCursors.forget(interrupted.projectId, interrupted.sessionId);
    if (!interrupted.stopRequested) {
      pendingForegroundChatRecovery = foregroundChatRecoveryFrom(interrupted);
    }
  }
  clearActiveRemoteChatRequest();
  chatSending = false;
}

/**
 * Reacts to a transport that dropped on its own. Everything the phone can
 * still show stays on screen so the next connection resumes the conversation
 * from its cursor instead of rebuilding it from nothing.
 */
function releaseDroppedTransportState(reason: Error): void {
  rejectPendingControlRequests(reason);
  releaseTransportBoundChatState();
  if (pairedSession) {
    setPhase("paired");
  }
  updateChatComposer();
}

function showTransportState(state: TransportState): void {
  switch (state.kind) {
    case "connecting_signal":
      setStatus("正在建立安全信令连接…");
      break;
    case "negotiating_p2p":
      setStatus("正在尝试端到端 P2P 连接…");
      break;
    case "verifying_p2p":
      setStatus("P2P 通道已打开，正在核验实际直连路径…");
      break;
    case "falling_back":
      setStatus("直连不可用，正在切换至端到端加密中继…");
      break;
    case "connected":
      setPhase("connected");
      connectionDetail.textContent = state.transport === "p2p"
        ? "已验证端到端 P2P 直连；服务器仅用于信令/STUN，数据不经过中继。"
        : "已通过端到端加密中继连接。";
      setStatus(connectionDetail.textContent);
      break;
    case "closed":
      releaseDroppedTransportState(new Error("The remote connection was closed."));
      setStatus("远程连接已断开，重新连接后会从中断处继续。");
      break;
    case "failed":
      releaseDroppedTransportState(new Error("The remote connection failed."));
      setStatus("远程连接失败，重新连接后会从中断处继续。");
      break;
  }
}

function makeRtcConfiguration(urls: readonly string[]): RTCConfiguration {
  if (urls.length > 8 || urls.some((url) => !isStunUrl(url))) {
    throw new Error("配对服务返回了无效的 STUN 网络配置。");
  }
  return urls.length === 0 ? {} : { iceServers: [{ urls: [...urls] }] };
}

function isStunUrl(value: string): boolean {
  return /^stuns?:[^/?#@\s]+$/i.test(value) && value.length <= 256;
}

function identityStoreForDesktop(desktopDeviceId: string): IndexedDbIdentityStore {
  return new IndexedDbIdentityStore(desktopDeviceId);
}

async function loadIdentityForSession(session: PairedMobileSession): Promise<WebCryptoMobileIdentity | null> {
  const scopedIdentity = await WebCryptoMobileIdentity.load(
    identityStoreForDesktop(session.invitation.desktop.device_id),
  );
  if (scopedIdentity) {
    return sameMobileIdentity(scopedIdentity.descriptor, session.mobile) ? scopedIdentity : null;
  }
  const legacyIdentity = await WebCryptoMobileIdentity.load(identityStore);
  return legacyIdentity && sameMobileIdentity(legacyIdentity.descriptor, session.mobile)
    ? legacyIdentity
    : null;
}

async function ensureIdentity(session: PairedMobileSession): Promise<WebCryptoMobileIdentity> {
  if (!identity || !sameMobileIdentity(identity.descriptor, session.mobile)) {
    identity = await loadIdentityForSession(session);
  }
  if (!identity) {
    throw new Error("这台电脑对应的手机安全身份无法恢复，请撤销该设备后重新配对。");
  }
  return identity;
}

async function clearIdentityForSession(session: PairedMobileSession): Promise<void> {
  const scopedStore = identityStoreForDesktop(session.invitation.desktop.device_id);
  const scopedIdentity = await WebCryptoMobileIdentity.load(scopedStore);
  if (scopedIdentity && sameMobileIdentity(scopedIdentity.descriptor, session.mobile)) {
    await scopedStore.clear();
  } else {
    const legacyIdentity = await WebCryptoMobileIdentity.load(identityStore);
    if (legacyIdentity && sameMobileIdentity(legacyIdentity.descriptor, session.mobile)) {
      await identityStore.clear();
    }
  }
  if (identity && sameMobileIdentity(identity.descriptor, session.mobile)) {
    identity = null;
  }
}

function defaultPhoneName(): string {
  const userAgent = navigator.userAgent;
  if (/iPhone/i.test(userAgent)) return "iPhone";
  if (/iPad/i.test(userAgent)) return "iPad";
  if (/Android/i.test(userAgent)) return "Android 手机";
  return "我的手机";
}

function beginAddingDevice(): void {
  if (hasMismatchedStoredPairing || blockPairingInEphemeralContext()) {
    return;
  }
  addingDevice = true;
  claimed = null;
  scannedPairingPayload = null;
  qrImage.value = "";
  stopCompletionPolling();
  stopCameraScan();
  disconnectForDeviceChange();
  renderPairedDevices();
  setPhase("scan");
  setStatus("扫描另一台电脑显示的一次性二维码。现有设备会继续保留。");
}

async function cancelAddingDevice(): Promise<void> {
  addingDevice = false;
  claimed = null;
  scannedPairingPayload = null;
  qrImage.value = "";
  stopCompletionPolling();
  stopCameraScan();
  if (!pairedSession) {
    setPhase("scan");
    return;
  }
  updateDesktopLabels(pairedSession);
  setPhase("paired");
  setStatus(`已取消添加设备，正在重新连接「${displayLabelForSession(pairedSession)}」…`);
  await connect({ replaceInFlight: true });
}

async function selectPairedDevice(desktopDeviceId: string): Promise<void> {
  if (deviceSwitching) {
    return;
  }
  if (pairedSession?.invitation.desktop.device_id === desktopDeviceId) {
    setWorkspaceDrawerOpen(false);
    return;
  }
  const nextSession = pairedSessions.find(
    (session) => session.invitation.desktop.device_id === desktopDeviceId,
  );
  if (!nextSession) {
    setStatus("这台设备的本地配对已经不存在，请刷新后重试。");
    return;
  }
  deviceSwitching = true;
  setBusy(revokePairingButton, true);
  setBusy(forgetPairingButton, true);
  setBusy(addPairedDeviceButton, true);
  setBusy(addPairedDevicePairedButton, true);
  setBusy(connectButton, true);
  setBusy(reconnectButton, true);
  renderPairedDevices();
  try {
    const collection = await sessionStore.select(desktopDeviceId);
    disconnectForDeviceChange();
    pairedSessions = collection.sessions;
    pairedSession = nextSession;
    addingDevice = false;
    updateDesktopLabels(nextSession);
    renderPairedDevices();
    setPhase("paired");
    setStatus(`正在切换到「${displayLabelForSession(nextSession)}」…`);
    await connect({ replaceInFlight: true });
  } catch (error) {
    setStatus(`切换设备失败：${errorMessage(error)}`);
  } finally {
    deviceSwitching = false;
    setBusy(revokePairingButton, false);
    setBusy(forgetPairingButton, false);
    setBusy(addPairedDeviceButton, false);
    setBusy(addPairedDevicePairedButton, false);
    setBusy(connectButton, false);
    setBusy(reconnectButton, false);
    renderPairedDevices();
  }
}

function renderPairedDevices(): void {
  pairedDeviceList.replaceChildren();
  pairedPanelDeviceList.replaceChildren();
  const activeDeviceId = pairedSession?.invitation.desktop.device_id ?? null;
  for (const session of pairedSessions) {
    pairedDeviceList.append(createPairedDeviceOption(session, activeDeviceId));
    pairedPanelDeviceList.append(createPairedDeviceOption(session, activeDeviceId));
  }
}

function createPairedDeviceOption(
  session: PairedMobileSession,
  activeDeviceId: string | null,
): HTMLButtonElement {
  const deviceId = session.invitation.desktop.device_id;
  const active = deviceId === activeDeviceId;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "paired-device-option";
  button.disabled = deviceSwitching;
  button.classList.toggle("active", active);
  button.setAttribute("aria-pressed", active ? "true" : "false");

  const indicator = document.createElement("span");
  indicator.className = "paired-device-indicator";
  indicator.setAttribute("aria-hidden", "true");
  const copy = document.createElement("span");
  copy.className = "paired-device-copy";
  const name = document.createElement("strong");
  name.textContent = displayLabelForSession(session);
  const detail = document.createElement("span");
  const shortCode = desktopShortCode(deviceId);
  detail.textContent = active ? `当前设备 · ${shortCode}` : `设备 ${shortCode}`;
  copy.append(name, detail);
  button.append(indicator, copy);
  button.addEventListener("click", () => void selectPairedDevice(deviceId));
  return button;
}

function pairedDesktopDescriptors(): DeviceDescriptor[] {
  return pairedSessions.map((session) => session.invitation.desktop);
}

function displayLabelForDesktop(desktop: DeviceDescriptor): string {
  return desktopDisplayLabel(desktop, pairedDesktopDescriptors());
}

function displayLabelForSession(session: PairedMobileSession): string {
  return displayLabelForDesktop(session.invitation.desktop);
}

function updateDesktopLabels(session: PairedMobileSession): void {
  const name = displayLabelForSession(session);
  pairedDesktop.textContent = `已与「${name}」配对。`;
  waitingDesktop.textContent = name;
  workspaceDesktopName.textContent = name;
  renderPairedDevices();
}

function consumePairingPayloadFromLocation(): string | null {
  const fragment = window.location.hash;
  if (!fragment || !new URLSearchParams(fragment.slice(1)).has("p")) {
    return null;
  }
  try {
    return pairingPayloadFromDeepLinkFragment(fragment);
  } finally {
    // A fragment does not reach the server, but it can remain in local browser
    // history. Remove the one-time secret as soon as this PWA has consumed it.
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }
}

function setPhase(next: FlowPhase): void {
  if (next !== "scan") {
    stopCameraScan();
  }
  if (next !== "connected") {
    setWorkspaceDrawerOpen(false);
  }
  phase = next;
  remoteApp.classList.toggle("conversation-mode", next === "connected");
  document.body.classList.toggle("remote-conversation-active", next === "connected");
  if (next === "connected") {
    scheduleConversationViewportSync();
  } else {
    document.body.classList.remove("remote-keyboard-open");
    conversationViewportBaselineHeight = 0;
  }
  scanPanel.hidden = next !== "scan";
  const pairingEntryBlocked = pairingContext !== null || hasMismatchedStoredPairing;
  startCameraButton.disabled = pairingEntryBlocked;
  chooseQrImageButton.disabled = pairingEntryBlocked;
  discardMismatchedPairingButton.hidden = next !== "scan" || !hasMismatchedStoredPairing;
  cancelAddDeviceButton.hidden = next !== "scan" || !addingDevice;
  cancelAddDeviceConfirmButton.hidden = next !== "confirm" || !addingDevice;
  pairingPanel.hidden = next !== "confirm";
  waitingPanel.hidden = next !== "waiting";
  pairedPanel.hidden = next !== "paired";
  connectedPanel.hidden = next !== "connected";
  syncWorkspaceDrawerPresentation();
  updateChatComposer();

  const activeStep = next === "loading" || next === "scan" || next === "confirm"
      ? "scan"
      : next === "waiting"
        ? "approval"
        : "connect";
  document.querySelectorAll<HTMLElement>("[data-flow-step]").forEach((step) => {
    const active = step.dataset.flowStep === activeStep;
    step.classList.toggle("active", active);
    step.toggleAttribute("aria-current", active);
  });
}

function setWorkspaceDrawerOpen(open: boolean): void {
  const next = open && phase === "connected";
  workspaceDrawerOpen = next;
  remoteApp.classList.toggle("workspace-drawer-open", next);
  syncWorkspaceDrawerPresentation();
}

function syncWorkspaceDrawerPresentation(): void {
  const persistent = phase === "connected" && persistentWorkspaceLayout.matches;
  const visible = persistent || workspaceDrawerOpen;
  remoteApp.classList.toggle("workspace-sidebar-persistent", persistent);
  workspaceDrawer.setAttribute("aria-hidden", String(!visible));
  // Keep the backdrop mounted while connected so opacity can transition in
  // both directions. The connected panel owns inactive-page visibility.
  workspaceBackdrop.hidden = persistent || phase !== "connected";
  workspaceBackdrop.setAttribute("aria-hidden", String(persistent || !workspaceDrawerOpen));
  openWorkspaceButton.setAttribute("aria-expanded", String(visible));
}

function resizeChatComposer(): void {
  chatInput.style.height = "auto";
  const height = Math.min(Math.max(chatInput.scrollHeight, 42), 144);
  chatInput.style.height = `${height}px`;
}

function syncConversationViewport(): void {
  // Safari pans the visual viewport when a textarea receives focus. Keep the
  // fixed connected surface aligned to both its height and its offset instead
  // of resizing the document beneath the keyboard.
  const viewport = window.visualViewport;
  const height = Math.round(viewport?.height ?? window.innerHeight);
  const offsetTop = Math.max(0, Math.round(viewport?.offsetTop ?? 0));
  const visibleBottom = height + offsetTop;
  const inputFocused = document.activeElement === chatInput;
  if (!inputFocused || conversationViewportBaselineHeight <= 0) {
    conversationViewportBaselineHeight = Math.max(
      visibleBottom,
      Math.round(window.innerHeight),
    );
  }
  document.body.classList.toggle(
    "remote-keyboard-open",
    phase === "connected" && isSoftwareKeyboardOpen({
      inputFocused,
      baselineHeight: conversationViewportBaselineHeight,
      visibleBottom,
    }),
  );
  if (height > 0) {
    document.documentElement.style.setProperty("--remote-viewport-height", `${height}px`);
  }
  document.documentElement.style.setProperty("--remote-viewport-offset-top", `${offsetTop}px`);
}

function scheduleConversationViewportSync(): void {
  if (conversationViewportSyncFrame !== null) {
    return;
  }
  conversationViewportSyncFrame = window.requestAnimationFrame(() => {
    conversationViewportSyncFrame = null;
    syncConversationViewport();
  });
}

function blockPairingInEphemeralContext(): boolean {
  if (!pairingContext) {
    return false;
  }
  scannedPairingPayload = null;
  setPhase("scan");
  setStatus(
    `当前打开的是${pairingBrowserContextLabel(pairingContext)}。该环境会与系统浏览器隔离配对数据，不能用于首次配对。请使用右上角“在浏览器打开”，在 Safari 或 Chrome 中打开 SomniQ Remote 后再扫码。`,
  );
  return true;
}

function isEmbeddedWindow(): boolean {
  try {
    return window.top !== window;
  } catch {
    return true;
  }
}

function pairingIdentityMismatchMessage(): string {
  if (isStandaloneMobileApp()) {
    return "Apple 主屏应用无法恢复旧版本保存的安全私钥，但旧会话仍然存在。请点“重置此应用并重新配对”，然后在这个主屏应用内完成最后一次扫码；新格式会在退出后继续保留身份。";
  }
  return "此浏览器无法恢复旧版本保存的安全身份。请重置此应用并重新配对一次；新格式会在退出后继续保留身份。";
}

function isStandaloneMobileApp(): boolean {
  const displayModeStandalone = window.matchMedia?.("(display-mode: standalone)").matches === true;
  const appleStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return isStandalonePairingContainer(displayModeStandalone, appleStandalone);
}

function pairingCompletedStatus(): string {
  const base = "电脑已批准，正在建立端到端加密连接。";
  if (pairingStorageProtection === "best_effort") {
    return `${base} 当前浏览器未授予持久存储保护，请从同一浏览器或 SomniQ Remote 主屏图标再次打开，且不要清除其网站数据。`;
  }
  if (pairingStorageProtection === "unavailable") {
    return `${base} 当前浏览器无法确认持久存储，请从同一系统浏览器或 SomniQ Remote 主屏图标再次打开。`;
  }
  return base;
}

async function inspectPairingStorageProtection(): Promise<PairingStorageProtection> {
  const storage = navigator.storage;
  if (typeof storage?.persisted !== "function") {
    return typeof storage?.persist === "function" ? "best_effort" : "unavailable";
  }
  try {
    return await storage.persisted() ? "persistent" : "best_effort";
  } catch {
    return "unavailable";
  }
}

async function requestPersistentPairingStorage(): Promise<PairingStorageProtection> {
  const storage = navigator.storage;
  if (typeof storage?.persist !== "function") {
    return "unavailable";
  }
  try {
    return await storage.persist() ? "persistent" : "best_effort";
  } catch {
    // Storage persistence is an optimization. IndexedDB remains the normal
    // credential store when a browser does not expose or declines this API.
    return "best_effort";
  }
}

function setStatus(message: string): void {
  status.textContent = message;
}

function setBusy(button: HTMLButtonElement, busy: boolean): void {
  button.disabled = busy;
  button.dataset.busy = busy ? "true" : "false";
}

function formatExpiry(value: number): string {
  return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing SomniQ Remote element: ${id}`);
  }
  return element as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "发生未知错误，请稍后重试。";
}
