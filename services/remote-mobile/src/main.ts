import "./styles.css";

import {
  Check,
  ChevronDown,
  createIcons,
  Folder,
  MessageSquareText,
  PanelLeft,
  RefreshCw,
  SendHorizontal,
  Settings2,
  SlidersHorizontal,
  Wifi,
  X,
} from "lucide";
import { mobileBasePathUrl, normalizeMobileBasePath } from "./basePath";
import { BrowserTicketedSocketFactory } from "./browserSocket";
import {
  encodeControlRequest,
  MOBILE_P1_REQUESTABLE_SCOPES,
  newChatModelOptionsRequest,
  newChatTranscriptRequest,
  newChatMessageRequest,
  newListChatSessionsRequest,
  newSetActiveProjectRequest,
  newSetChatSessionModelRequest,
  newWorkspaceOverviewRequest,
  parseControlResponse,
  type ControlRequest,
  type ControlResponse,
} from "./control";
import { WebCryptoMobileIdentity, IndexedDbIdentityStore } from "./crypto";
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
import type { PairedMobileSession } from "./types";
import { newestChatSessionId, type ChatSessionCandidate } from "./chatSessionNavigation";
import {
  chatModelStateFromResponse,
  type RemoteChatModelState,
} from "./chatModelNavigation";
import { renderRemoteMarkdown } from "./remoteMarkdown";
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
       <button id="discard-mismatched-pairing" class="text-button" type="button" hidden>清除这个应用的旧配对</button>
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
      <div class="action-row">
        <button id="connect" class="primary-button" type="button">安全连接</button>
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

        <div class="workspace-connection">
          <span class="status-dot online" aria-hidden="true"></span>
          <div>
            <strong id="workspace-desktop-name">桌面 SomniQ</strong>
            <span id="connection-detail">正在建立安全连接…</span>
          </div>
        </div>

        <section class="workspace-project-section" aria-labelledby="workspace-project-heading">
          <div class="workspace-section-heading">
            <p id="workspace-project-heading" class="workspace-section-label">项目</p>
            <button id="refresh-workspace" class="drawer-refresh-button" type="button" aria-label="刷新项目" title="刷新项目">
              <i data-lucide="refresh-cw" aria-hidden="true"></i>
            </button>
          </div>
          <div id="workspace-projects" class="workspace-projects"></div>
        </section>

        <section class="workspace-sessions-section" aria-labelledby="workspace-sessions-heading">
          <div class="workspace-section-heading">
            <p id="workspace-sessions-heading" class="workspace-section-label">对话</p>
            <div class="workspace-session-tools">
              <span id="workspace-session-count" class="workspace-session-count"></span>
              <button id="refresh-chat-sessions" class="drawer-refresh-button" type="button" aria-label="刷新对话" title="刷新对话">
                <i data-lucide="refresh-cw" aria-hidden="true"></i>
              </button>
            </div>
          </div>
          <p id="chat-session-status" class="chat-session-status" aria-live="polite"></p>
          <div id="workspace-session-list" class="workspace-session-list"></div>
        </section>

        <details class="drawer-device-settings">
          <summary><i data-lucide="settings-2" aria-hidden="true"></i>连接设置</summary>
          <div class="drawer-device-actions">
            <button id="reconnect" class="drawer-action-button" type="button"><i data-lucide="wifi" aria-hidden="true"></i>重新连接</button>
            <button id="revoke-pairing" class="drawer-action-button danger" type="button">撤销并忘记此手机</button>
          </div>
        </details>
      </aside>

      <header class="chat-workspace-header">
        <button id="open-workspace" class="icon-button workspace-toggle" type="button" aria-label="打开项目与对话列表" aria-controls="workspace-drawer" aria-expanded="false" title="项目与对话">
          <i data-lucide="panel-left" aria-hidden="true"></i>
        </button>
        <div class="chat-mobile-brand" aria-hidden="true"><span>SomniQ</span> <strong>Chat</strong></div>
        <div class="chat-header-context">
          <button id="open-project-workspace" class="header-project-trigger" type="button" aria-label="打开当前项目和对话列表" aria-controls="workspace-drawer" title="当前项目">
            <i data-lucide="folder" aria-hidden="true"></i>
            <span id="current-project-label">正在读取项目</span>
            <i data-lucide="chevron-down" aria-hidden="true"></i>
          </button>
          <p id="current-session-label" class="current-session-label">选择一个对话</p>
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
              <div id="chat-model-control" class="chat-model-control" hidden>
                <button id="open-model-menu" class="chat-model-trigger" type="button" aria-label="切换模型" aria-haspopup="listbox" aria-expanded="false" title="切换模型">
                  <i data-lucide="sliders-horizontal" aria-hidden="true"></i>
                  <span id="current-model-label">模型</span>
                  <i data-lucide="chevron-down" aria-hidden="true"></i>
                </button>
                <div id="chat-model-menu" class="chat-model-menu" role="listbox" aria-label="可用模型" hidden></div>
              </div>
            </div>
            <button id="send-chat" class="chat-send-button" type="submit" aria-label="发送消息" title="发送消息">
              <i data-lucide="send-horizontal" aria-hidden="true"></i>
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
  RefreshCw,
  SendHorizontal,
  Settings2,
  SlidersHorizontal,
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

interface PendingControlRequest {
  resolve: (response: ControlResponse) => void;
  reject: (error: Error) => void;
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

interface RemoteTranscriptMessage {
  role: string;
  text: string;
}

interface PairedSessionRestoreResult {
  restored: boolean;
  failureMessage: string | null;
}

type PairingStorageProtection = "unknown" | "persistent" | "best_effort" | "unavailable";

const api = new GatewayApi();
const identityStore = new IndexedDbIdentityStore();
const sessionStore = new BrowserPairedSessionStore();
const cameraScanner = new BrowserQrCameraScanner();

let identity: WebCryptoMobileIdentity | null = null;
let claimed: ClaimedPairing | null = null;
let pairedSession: PairedMobileSession | null = null;
let transport: P2pFirstTransport | null = null;
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
let chatSessionsLoading = false;
let chatTranscriptLoading = false;
let conversationViewportSyncFrame: number | null = null;
let chatSessions: RemoteChatSession[] = [];
let selectedChatSessionId: string | null = null;
let chatModelState: RemoteChatModelState = { model: null, options: [] };
let chatModelLoading = false;
let chatModelSwitching = false;
let chatModelMenuOpen = false;
let pairingStorageProtection: PairingStorageProtection = "unknown";
let pairingStorageRequest: Promise<PairingStorageProtection> | null = null;
let hasMismatchedStoredPairing = false;
const pendingControlRequests = new Map<string, PendingControlRequest>();
const pairingContext = pairingBrowserContext(navigator.userAgent, isEmbeddedWindow());

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
const claimButton = byId<HTMLButtonElement>("claim-pairing");
const connectButton = byId<HTMLButtonElement>("connect");
const forgetPairingButton = byId<HTMLButtonElement>("forget-pairing");
const reconnectButton = byId<HTMLButtonElement>("reconnect");
const chatForm = byId<HTMLFormElement>("chat-form");
const chatInput = byId<HTMLTextAreaElement>("chat-message");
const sendChatButton = byId<HTMLButtonElement>("send-chat");
const chatHint = byId<HTMLElement>("chat-hint");
const refreshChatSessionsButton = byId<HTMLButtonElement>("refresh-chat-sessions");
const refreshWorkspaceButton = byId<HTMLButtonElement>("refresh-workspace");
const chatSessionStatus = byId<HTMLElement>("chat-session-status");
const chatLog = byId<HTMLElement>("chat-log");
const chatEmpty = byId<HTMLElement>("chat-empty");
const workspaceBackdrop = byId<HTMLButtonElement>("workspace-backdrop");
const workspaceDrawer = byId<HTMLElement>("workspace-drawer");
const openWorkspaceButton = byId<HTMLButtonElement>("open-workspace");
const openProjectWorkspaceButton = byId<HTMLButtonElement>("open-project-workspace");
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

startCameraButton.addEventListener("click", () => void startCameraScan());
stopCameraButton.addEventListener("click", stopCameraScanByUser);
chooseQrImageButton.addEventListener("click", () => {
  stopCameraScan();
  qrImage.click();
});
qrImage.addEventListener("change", () => void scanQrImage());
discardMismatchedPairingButton.addEventListener("click", () => void discardMismatchedPairing());
claimButton.addEventListener("click", () => void claimPairing());
connectButton.addEventListener("click", () => void connect());
forgetPairingButton.addEventListener("click", () => void revokeAndForget());
reconnectButton.addEventListener("click", () => void connect());
chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void sendChatMessage();
});
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
refreshChatSessionsButton.addEventListener("click", () => void refreshChatSessions());
refreshWorkspaceButton.addEventListener("click", () => void requestWorkspaceOverview());
openWorkspaceButton.addEventListener("click", () => setWorkspaceDrawerOpen(true));
openProjectWorkspaceButton.addEventListener("click", () => setWorkspaceDrawerOpen(true));
closeWorkspaceButton.addEventListener("click", () => setWorkspaceDrawerOpen(false));
workspaceBackdrop.addEventListener("click", () => setWorkspaceDrawerOpen(false));
openModelMenuButton.addEventListener("click", () => setChatModelMenuOpen(!chatModelMenuOpen));
revokePairingButton.addEventListener("click", () => void revokeAndForget());

if (pairingContext) {
  startCameraButton.disabled = true;
  chooseQrImageButton.disabled = true;
}

window.addEventListener("beforeunload", () => {
  stopCompletionPolling();
  stopCameraScan();
  rejectPendingControlRequests(new Error("The remote page was closed."));
  transport?.close();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopCameraScan();
  }
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
    updateDesktopLabels(pairedSession.invitation.desktop.display_name);
    setPhase("paired");
    setStatus(hasChatScope()
      ? "已恢复安全配对，正在连接电脑…"
      : "此手机使用的是旧权限集。请在桌面端撤销后重新扫码配对，以启用项目、模型和对话控制。");
    await connect();
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
    pairingDesktop.textContent = invitation.desktop.display_name;
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
  try {
    const mobileIdentity = await ensureIdentity();
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
    waitingDesktop.textContent = pending.invitation.desktop.display_name;
    setPhase("waiting");
    setStatus("配对请求已发送，正在等待电脑批准。");
    startCompletionPolling();
  } catch (error) {
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
    await sessionStore.save(session);
    pairingStorageProtection = await (pairingStorageRequest ?? requestPersistentPairingStorage());
    pairingStorageRequest = null;
    pairedSession = session;
    claimed = null;
    stopCompletionPolling();
    updateDesktopLabels(session.invitation.desktop.display_name);
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
  try {
    const session = await sessionStore.load();
    if (!session) {
      return { restored: false, failureMessage: null };
    }
    const loadedIdentity = await ensureIdentity();
    if (loadedIdentity.descriptor.device_id !== session.mobile.device_id) {
      hasMismatchedStoredPairing = true;
      return {
        restored: false,
        failureMessage: pairingIdentityMismatchMessage(),
      };
    }
    identity = loadedIdentity;
    pairedSession = await refreshStoredPairingScopes(session);
    return { restored: true, failureMessage: null };
  } catch (error) {
    return { restored: false, failureMessage: errorMessage(error) };
  }
}

async function discardMismatchedPairing(): Promise<void> {
  if (!hasMismatchedStoredPairing) {
    return;
  }
  setBusy(discardMismatchedPairingButton, true);
  try {
    await sessionStore.clear();
    pairedSession = null;
    claimed = null;
    scannedPairingPayload = null;
    hasMismatchedStoredPairing = false;
    setPhase("scan");
    setStatus("已清除此主屏应用中不匹配的旧会话。请在此应用内打开相机扫码并完成一次配对；以后始终从这个主屏图标进入。");
  } catch (error) {
    setStatus(errorMessage(error));
  } finally {
    setBusy(discardMismatchedPairingButton, false);
  }
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
      await sessionStore.clear();
      throw new Error("此手机的远程授权与已保存配对不一致。请在电脑上撤销后重新扫描二维码配对。");
    }

    // A gateway response can only reduce a local cache. It must never add a
    // capability the desktop has not re-approved through a fresh QR ceremony.
    const grantedScopes = session.granted_scopes.filter((scope) => device.granted_scopes.includes(scope));
    if (sameRemoteScopes(session.granted_scopes, grantedScopes)) {
      return session;
    }
    const refreshed = { ...session, granted_scopes: grantedScopes };
    await sessionStore.save(refreshed);
    return refreshed;
  } catch (error) {
    // A rejected bearer is final. A transient failure, an older gateway that
    // lacks `/v1/me`, or a malformed response must not erase a usable local
    // pairing, so the normal transport connection can still make progress.
    if (error instanceof GatewayApiError && (error.status === 401 || error.status === 403)) {
      await sessionStore.clear();
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

async function connect(): Promise<void> {
  if (!pairedSession) {
    return;
  }
  const session = pairedSession;
  rejectPendingControlRequests(new Error("The remote connection was replaced."));
  transport?.close();
  transport = null;
  activeProjectId = null;
  workspaceProjects = [];
  resetWorkspaceCapabilities();
  setWorkspaceDrawerOpen(false);
  resetRemoteChatState();
  updateChatComposer();
  setBusy(connectButton, true);
  setBusy(reconnectButton, true);
  try {
    const mobileIdentity = await ensureIdentity();
    const configuration = makeRtcConfiguration(session.ice_servers);
    let candidate!: P2pFirstTransport;
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
        if (transport === candidate) {
          showTransportState(state);
        }
      },
      onPlaintextFrame: (frame) => {
        if (transport === candidate) {
          showControlResponse(frame);
        }
      },
      onTransportError: (error) => {
        if (transport === candidate) {
          rejectPendingControlRequests(error);
          setStatus(error.message);
        }
      },
    });
    transport = candidate;
    await candidate.connect();
    if (transport !== candidate) {
      return;
    }
    setPhase("connected");
    updateChatComposer();
    if (!hasChatScope()) {
      setStatus("此手机使用的是旧权限集。请在桌面端撤销后重新扫码配对，以启用项目、模型和对话控制。");
      return;
    }
    await requestWorkspaceOverview();
  } catch (error) {
    if (transport) {
      transport.close();
      transport = null;
    }
    rejectPendingControlRequests(error instanceof Error ? error : new Error(errorMessage(error)));
    setPhase("paired");
    setStatus(errorMessage(error));
  } finally {
    setBusy(connectButton, false);
    setBusy(reconnectButton, false);
  }
}

async function requestWorkspaceOverview(): Promise<void> {
  try {
    const response = await sendControlRequest(newWorkspaceOverviewRequest());
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
    if (canAccessRemoteChat()) {
      await refreshChatSessions({ openNewest: projectChanged });
    }
  } catch (error) {
    setStatus(errorMessage(error));
  }
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
    setWorkspaceDrawerOpen(false);
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

  chatSending = true;
  updateChatComposer();
  appendChatMessage("user", message);
  const reply = appendChatMessage("assistant", "正在等待电脑回复…", true);
  chatInput.value = "";
  resizeChatComposer();

  try {
    const projectId = activeProjectId;
    const sessionId = selectedChatSessionId;
    if (!projectId || !sessionId) {
      throw new Error("请先选择电脑中的一个对话。");
    }
    const response = await sendControlRequest(newChatMessageRequest(projectId, sessionId, message));
    const completion = chatMessageCompletion(response);
    if (!completion || completion.projectId !== projectId || completion.sessionId !== sessionId) {
      throw controlResponseError(response, "电脑没有返回对话回复。");
    }
    setChatMessageContent(reply, "assistant", completion.text);
    reply.classList.remove("pending");
    setStatus("已收到电脑上的 SomniQ 回复。");
    void refreshChatSessions();
  } catch (error) {
    setChatMessageContent(reply, "assistant", `发送失败：${errorMessage(error)}`);
    reply.classList.remove("pending");
    reply.classList.add("error");
    setStatus(errorMessage(error));
  } finally {
    chatSending = false;
    updateChatComposer();
  }
}

async function refreshChatSessions(options: { openNewest?: boolean } = {}): Promise<void> {
  if (!canAccessRemoteChat()) {
    updateChatComposer();
    return;
  }
  const projectId = activeProjectId;
  if (!projectId) {
    await requestWorkspaceOverview();
    return;
  }

  let sessionToOpen: string | null = null;
  chatSessionsLoading = true;
  renderChatSessionNavigation();
  updateChatComposer();
  try {
    const response = await sendControlRequest(newListChatSessionsRequest(projectId));
    const sessionResult = chatSessionsFromResponse(response, projectId);
    if (!sessionResult) {
      throw controlResponseError(response, "电脑没有返回可用的对话列表。");
    }
    if (activeProjectId !== projectId) {
      return;
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
  } catch (error) {
    chatSessionStatus.textContent = errorMessage(error);
    setStatus(errorMessage(error));
  } finally {
    chatSessionsLoading = false;
    renderChatSessionNavigation();
    updateChatComposer();
  }

  if (sessionToOpen && activeProjectId === projectId && canAccessRemoteChat()) {
    await selectChatSession(sessionToOpen);
  }
}

async function selectChatSession(sessionId: string): Promise<void> {
  if (!sessionId) {
    selectedChatSessionId = null;
    clearChatLog("选择一个桌面对话后显示历史。");
    renderChatSessionNavigation();
    updateChatComposer();
    return;
  }
  if (!chatSessions.some((session) => session.sessionId === sessionId)) {
    selectedChatSessionId = null;
    renderChatSessionNavigation();
    updateChatComposer();
    return;
  }
  const projectId = activeProjectId;
  if (!projectId || !canAccessRemoteChat()) {
    return;
  }

  selectedChatSessionId = sessionId;
  chatTranscriptLoading = true;
  resetChatModelState();
  setWorkspaceDrawerOpen(false);
  clearChatLog("正在加载此对话的历史…");
  renderChatSessionNavigation();
  updateChatComposer();
  try {
    const response = await sendControlRequest(newChatTranscriptRequest(projectId, sessionId));
    const transcript = chatTranscriptFromResponse(response);
    if (!transcript || transcript.projectId !== projectId || transcript.sessionId !== sessionId) {
      throw controlResponseError(response, "电脑没有返回对话历史。");
    }
    if (activeProjectId !== projectId || selectedChatSessionId !== sessionId) {
      return;
    }
    renderChatTranscript(transcript.messages);
    const session = chatSessions.find((entry) => entry.sessionId === sessionId);
    chatSessionStatus.textContent = session
      ? `正在继续「${session.title}」。${transcript.hasMore ? "已显示最近的 100 条消息。" : ""}`
      : "已加载对话历史。";
    setStatus("已加载所选桌面对话的历史。");
    await refreshChatModelState(projectId, sessionId);
  } catch (error) {
    if (selectedChatSessionId === sessionId) {
      clearChatLog(`无法加载历史：${errorMessage(error)}`);
      chatSessionStatus.textContent = errorMessage(error);
      selectedChatSessionId = null;
    }
    if (activeProjectId === projectId) {
      setStatus(errorMessage(error));
    }
  } finally {
    if (activeProjectId === projectId) {
      chatTranscriptLoading = false;
    }
    renderChatSessionNavigation();
    updateChatComposer();
  }
}

async function sendControlRequest(request: ControlRequest): Promise<ControlResponse> {
  const activeTransport = transport;
  if (!activeTransport) {
    throw new Error("请先安全连接电脑。");
  }

  const response = new Promise<ControlResponse>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingControlRequests.delete(request.request_id);
      reject(new Error("等待电脑响应超时，请重试。"));
    }, CONTROL_RESPONSE_TIMEOUT_MS);
    pendingControlRequests.set(request.request_id, { resolve, reject, timeout });
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
  if (!window.confirm("撤销后，此手机需要重新扫描电脑二维码才能连接。确定继续吗？")) {
    return;
  }
  setBusy(revokePairingButton, true);
  setBusy(forgetPairingButton, true);
  try {
    await api.revokeThisDevice(
      pairedSession.invitation.gateway_url,
      pairedSession.credential,
    );
    rejectPendingControlRequests(new Error("The paired device was revoked."));
    transport?.close();
    transport = null;
    await Promise.all([sessionStore.clear(), identityStore.clear()]);
    identity = null;
    pairedSession = null;
    activeProjectId = null;
    workspaceProjects = [];
    resetWorkspaceCapabilities();
    resetRemoteChatState();
    setPhase("scan");
    setStatus("已撤销此手机的远程访问，并移除本地配对信息。");
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

function chatMessageCompletion(response: ControlResponse): { projectId: string; sessionId: string; messageId: string; text: string } | null {
  if (response.outcome.status !== "success" || !isRecord(response.outcome.result)) {
    return null;
  }
  const resultValue = response.outcome.result;
  if (
    resultValue.type !== "chat_message_completed" ||
    typeof resultValue.project_id !== "string" ||
    typeof resultValue.session_id !== "string" ||
    typeof resultValue.message_id !== "string" ||
    typeof resultValue.text !== "string"
  ) {
    return null;
  }
  return {
    projectId: resultValue.project_id,
    sessionId: resultValue.session_id,
    messageId: resultValue.message_id,
    text: resultValue.text,
  };
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
    if (
      !isRecord(entry) ||
      (entry.role !== "user" && entry.role !== "assistant") ||
      typeof entry.text !== "string"
    ) {
      return null;
    }
    messages.push({ role: entry.role, text: entry.text });
  }
  return {
    projectId: resultValue.project_id,
    sessionId: resultValue.session_id,
    messages,
    hasMore: resultValue.has_more,
  };
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
  chatSending = false;
  chatSessionsLoading = false;
  chatTranscriptLoading = false;
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
  workspaceSessionList.replaceChildren();
  workspaceSessionCount.textContent = chatSessions.length > 0 ? String(chatSessions.length) : "";

  const emptyMessage = !available
    ? "请先连接电脑"
    : chatSessionsLoading
      ? "正在加载对话…"
      : chatSessions.length === 0
        ? "没有可继续的对话"
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
  for (const message of messages) {
    appendChatMessage(message.role === "user" ? "user" : "assistant", message.text);
  }
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
  return canWriteChat() && !chatTranscriptLoading;
}

function updateChatComposer(): void {
  const granted = hasChatScope();
  const connected = phase === "connected" && transport !== null;
  const canWrite = canWriteChat();
  const canSend = canSendChat();
  chatInput.disabled = !canWrite || chatSending;
  sendChatButton.disabled = !canSend || chatSending || chatInput.value.trim().length === 0;
  refreshChatSessionsButton.disabled = !granted || !connected || chatSessionsLoading;
  refreshWorkspaceButton.disabled = !connected || projectSwitching;
  openWorkspaceButton.disabled = !connected;
  openProjectWorkspaceButton.disabled = !connected;
  const hint = !granted
    ? "当前配对未获“发送消息”权限。请从电脑重新配对并批准该权限。"
    : !connected
      ? "连接电脑后即可发送消息。"
      : !activeProjectId
        ? "正在读取电脑上的研究工作区…"
      : chatSending
        ? "正在等待电脑回复…"
        : chatTranscriptLoading
          ? "正在加载所选对话的历史…"
          : !selectedChatSessionId
            ? "请先选择一个桌面对话。"
            : "";
  chatHint.hidden = canWrite && !chatSending && !chatTranscriptLoading;
  chatHint.textContent = hint;
  chatInput.placeholder = canWrite
    ? "给 SomniQ 发送消息"
    : !selectedChatSessionId
      ? "请从左上角选择一个对话"
      : "正在连接桌面 SomniQ…";
  renderChatWorkspaceHeader();
  renderChatModelControl();
}

function appendChatMessage(role: "user" | "assistant", text: string, pending = false): HTMLElement {
  if (chatEmpty.isConnected) {
    chatEmpty.remove();
  }
  const message = document.createElement("article");
  message.className = `chat-turn chat-${role}${pending ? " pending" : ""}`;
  setChatMessageContent(message, role, text);
  chatLog.append(message);
  chatLog.scrollTop = chatLog.scrollHeight;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function showTransportState(state: TransportState): void {
  switch (state.kind) {
    case "connecting_signal":
      setStatus("正在建立安全信令连接…");
      break;
    case "negotiating_p2p":
      setStatus("正在尝试端到端 P2P 连接…");
      break;
    case "falling_back":
      setStatus("直连不可用，正在切换至端到端加密中继…");
      break;
    case "connected":
      setPhase("connected");
      connectionDetail.textContent = state.transport === "p2p"
        ? "已通过端到端 P2P 直连。"
        : "已通过端到端加密中继连接。";
      setStatus(connectionDetail.textContent);
      break;
    case "closed":
      rejectPendingControlRequests(new Error("The remote connection was closed."));
      activeProjectId = null;
      workspaceProjects = [];
      resetWorkspaceCapabilities();
      resetRemoteChatState();
      if (pairedSession) {
        setPhase("paired");
      }
      setStatus("远程连接已关闭。");
      break;
    case "failed":
      rejectPendingControlRequests(new Error("The remote connection failed."));
      activeProjectId = null;
      workspaceProjects = [];
      resetWorkspaceCapabilities();
      resetRemoteChatState();
      if (pairedSession) {
        setPhase("paired");
      }
      setStatus("远程连接失败，请重新连接。");
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

async function ensureIdentity(): Promise<WebCryptoMobileIdentity> {
  if (!identity) {
    identity = await WebCryptoMobileIdentity.loadOrCreate(identityStore, defaultPhoneName());
  }
  return identity;
}

function defaultPhoneName(): string {
  const userAgent = navigator.userAgent;
  if (/iPhone/i.test(userAgent)) return "iPhone";
  if (/iPad/i.test(userAgent)) return "iPad";
  if (/Android/i.test(userAgent)) return "Android 手机";
  return "我的手机";
}

function updateDesktopLabels(name: string): void {
  pairedDesktop.textContent = `已与「${name}」配对。`;
  waitingDesktop.textContent = name;
  workspaceDesktopName.textContent = name;
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
  scanPanel.hidden = next !== "scan";
  discardMismatchedPairingButton.hidden = next !== "scan" || !hasMismatchedStoredPairing;
  pairingPanel.hidden = next !== "confirm";
  waitingPanel.hidden = next !== "waiting";
  pairedPanel.hidden = next !== "paired";
  connectedPanel.hidden = next !== "connected";
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
  workspaceDrawer.setAttribute("aria-hidden", String(!next));
  workspaceBackdrop.hidden = !next;
  openWorkspaceButton.setAttribute("aria-expanded", String(next));
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
    return "SomniQ Remote 主屏应用与 Safari 使用独立的安全存储。此主屏应用中保留了旧会话，但当前安全身份来自另一个容器。请清除这个应用的旧配对后，在此主屏应用内重新扫码一次；以后始终从这个主屏图标进入。";
  }
  return "此浏览器的安全身份与已保存配对不一致。请在原来的浏览器或 SomniQ Remote 主屏应用中打开；配对记录已保留，便于诊断。";
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
