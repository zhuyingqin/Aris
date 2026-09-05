import { lazy, memo, Suspense, useCallback, useDeferredValue, useEffect, useRef, useState, useTransition, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { appRelaunch, appUpdateCheck, appUpdateDownloadAndInstall, chatRunningTurnCount, fileReveal, isTauri, newapiBootstrap, onChatDone, onChatRunState, openChatCompanion, type NewApiAccount } from "./api/tauri";
import { hasNativeBackend } from "./api/transport";
import { isManagedAuthInvalidError, useStore, type Language, type Tab } from "./store";
import type { AppUpdateInfo, AppUpdateProgress } from "./types";
import { readCachedAccount, writeCachedAccount } from "./accountCache";
import { SETTINGS_TAB_REQUEST_EVENT, SETTINGS_TAB_REQUEST_KEY } from "./settingsTabRequest";
import type { SettingsNavId } from "./settings/settingsNav";
import ErrorBoundary from "./ErrorBoundary";
import { formatUserFacingError } from "./errorMessage";
import Chat from "./chat/Chat";
import { clientRunningConversationCount } from "./chat/chatActivity";
import LiteratureViewTabs, { type LiteraturePageView } from "./literature/LiteratureViewTabs";
import Extensions from "./extensions/Extensions";
import Settings from "./settings/Settings";
import OnboardingTutorial from "./OnboardingTutorial";
import { desktopCloseConfirmationMessage, installBrowserUnsavedChangesGuard, shouldPreventDesktopClose } from "./windowCloseGuard";
import { requestWindowAction } from "./windowControls";
import { WindowControlButtons } from "./WindowControlButtons";
import { SvgIcon } from "./SvgIcon";
import { useProfileAvatar } from "./profileAvatar";

const loadLiterature = () => import("./literature/Literature");
const loadMail = () => import("./mail/Mail");
const loadTypeset = () => import("./typeset/Typeset");
const loadCode = () => import("./code/CodePane");
const loadWorkflows = () => import("./workflows/Workflows");

const Literature = lazy(loadLiterature);
const Mail = lazy(loadMail);
const Typeset = lazy(loadTypeset);
const CodePane = lazy(loadCode);
const Workflows = lazy(loadWorkflows);
const ChatPane = memo(Chat);

type AppShellCopy = {
  nav: Record<Tab, string>;
  loading: (label: string) => string;
  viewErrorTitle: string;
  viewErrorBody: string;
  tryAgain: string;
  userFallback: string;
  accountInfo: string;
  account: string;
  balance: (value: string) => string;
  back: string;
  forward: string;
  toggleSidebar: string;
  findConversations: string;
  productMenuLabel: string;
  switchProduct: (name: string) => string;
  minimizeWindow: string;
  maximizeWindow: string;
  closeWindow: string;
  openChatCompanion: string;
  userMenu: string;
  settings: string;
  remainingUsage: string;
  logout: string;
  user: string;
  currentProject: string;
  noProject: string;
  projects: string;
  dragToReorder: string;
  addProject: string;
  add: string;
  runStateDir: string;
  openWorkspace: string;
  dismiss: string;
  updateReady: (version: string) => string;
  updateDownloading: (version: string, percent?: number | null) => string;
  updateAvailable: (version: string) => string;
};

const APP_COPY: Record<Language, AppShellCopy> = {
  cn: {
    nav: {
      chat: "对话",
      lab: "代码",
      typeset: "LaTeX",
      literature: "文献",
      workflows: "研究流程",
      mail: "邮箱",
      extensions: "插件",
      settings: "设置",
      scheduled: "定时任务",
    },
    loading: (label) => `正在加载${label}...`,
    viewErrorTitle: "当前视图出现界面错误。",
    viewErrorBody: "当前页面无法渲染。",
    tryAgain: "重试",
    userFallback: "用户",
    accountInfo: "账户信息",
    account: "账户",
    balance: (value) => `余额 ${value}`,
    back: "后退",
    forward: "前进",
    toggleSidebar: "显示或隐藏对话侧栏",
    findConversations: "在侧栏中查找对话",
    productMenuLabel: "SomniQ 功能",
    switchProduct: (name) => `当前功能：${name}，点击切换`,
    minimizeWindow: "最小化窗口",
    maximizeWindow: "最大化窗口",
    closeWindow: "关闭窗口",
    openChatCompanion: "打开论文伴写悬浮窗",
    userMenu: "用户菜单",
    settings: "设置",
    remainingUsage: "剩余用量",
    logout: "退出登录",
    user: "用户",
    currentProject: "当前项目",
    noProject: "无项目",
    projects: "项目",
    dragToReorder: "拖动排序",
    addProject: "添加 SomniQ 项目",
    add: "添加",
    runStateDir: "运行状态目录",
    openWorkspace: "在文件管理器中打开工作目录",
    dismiss: "关闭",
    updateReady: (version) => `更新${version}已安装，点击重启 SomniQ Studio。`,
    updateDownloading: (version, percent) => percent != null ? `正在安装更新${version}: ${percent}%` : `正在安装更新${version}`,
    updateAvailable: (version) => `发现更新${version}，点击安装。`,
  },
  en: {
    nav: {
      chat: "Chat",
      lab: "Code",
      typeset: "LaTeX",
      literature: "Literature",
      workflows: "Workflows",
      mail: "Mail",
      extensions: "Plugins",
      settings: "Settings",
      scheduled: "Scheduled",
    },
    loading: (label) => `Loading ${label}...`,
    viewErrorTitle: "This view hit a UI error.",
    viewErrorBody: "The current screen could not render.",
    tryAgain: "Try again",
    userFallback: "User",
    accountInfo: "Account info",
    account: "Account",
    balance: (value) => `Balance ${value}`,
    back: "Back",
    forward: "Forward",
    toggleSidebar: "Show or hide the conversation sidebar",
    findConversations: "Find conversations in the sidebar",
    productMenuLabel: "SomniQ modules",
    switchProduct: (name) => `Current module: ${name}. Switch module`,
    minimizeWindow: "Minimize window",
    maximizeWindow: "Maximize window",
    closeWindow: "Close window",
    openChatCompanion: "Open writing companion",
    userMenu: "User menu",
    settings: "Settings",
    remainingUsage: "Remaining usage",
    logout: "Sign out",
    user: "User",
    currentProject: "Current project",
    noProject: "No project",
    projects: "Projects",
    dragToReorder: "Drag to reorder",
    addProject: "Add SomniQ project",
    add: "Add",
    runStateDir: "run-state directory",
    openWorkspace: "Open workspace folder in file manager",
    dismiss: "Dismiss",
    updateReady: (version) => `Update${version} installed. Restart SomniQ Studio.`,
    updateDownloading: (version, percent) => percent != null ? `Installing update${version}: ${percent}%` : `Installing update${version}`,
    updateAvailable: (version) => `Update${version} available. Click to install.`,
  },
};

/** Below this width Chat's sidebar stops being a docked column and becomes an
 * overlay — see the `max-width: 1120px` block in styles.css. The titlebar
 * toggle has to know which of the two it is driving. */
const SIDEBAR_OVERLAY_QUERY = "(max-width: 1120px)";

function useSidebarIsOverlay(): boolean {
  const [overlay, setOverlay] = useState(
    () => typeof window !== "undefined" && window.matchMedia(SIDEBAR_OVERLAY_QUERY).matches,
  );
  useEffect(() => {
    const query = window.matchMedia(SIDEBAR_OVERLAY_QUERY);
    const sync = () => setOverlay(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return overlay;
}

function preloadTabModule(tabId: string) {
  if (tabId === "literature") void loadLiterature();
  else if (tabId === "workflows") void loadWorkflows();
  else if (tabId === "mail") void loadMail();
  else if (tabId === "typeset") void loadTypeset();
  else if (tabId === "lab") void loadCode();
}

function AppLoadingPane({ copy, label }: { copy: AppShellCopy; label: string }) {
  return (
    <div className="app-loading-pane" role="status" aria-live="polite">
      <span className="app-loading-spinner" aria-hidden="true" />
      <span>{copy.loading(label)}</span>
    </div>
  );
}

function AppViewFallback({ copy, error, reset, language }: { copy: AppShellCopy; error: Error; reset: () => void; language: Language }) {
  return (
    <div className="app-view-error" role="alert">
      <strong>{copy.viewErrorTitle}</strong>
      <span>{error.message ? formatUserFacingError(error, language) : copy.viewErrorBody}</span>
      <button type="button" onClick={reset}>{copy.tryAgain}</button>
    </div>
  );
}

interface NavItem {
  id: Tab;
  label: string;
  icon: ReactNode;
}

type UpdateIndicatorState = "idle" | "available" | "downloading" | "ready";

const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const ACCOUNT_REFRESH_INTERVAL_MS = 60 * 1000;
const ACCOUNT_REFRESH_MIN_INTERVAL_MS = 15 * 1000;

// Deep links into Settings address the sidebar entries directly, so the id set
// is the nav's own — no translation layer to keep in sync.
type RequestedSettingsTab = SettingsNavId;

const IC = (p: { d: string; extra?: string }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
    stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true">
    <path d={p.d} />
    {p.extra && <path d={p.extra} />}
  </svg>
);

// Chevron / control glyphs rendered as crisp SVG so they align on the pixel grid
// instead of relying on font-dependent glyphs like "鈥?, "脳" or "v".
const Chevron = (p: { dir: "left" | "right" | "down"; size?: number }) => {
  const s = p.size ?? 16;
  const d = p.dir === "left" ? "M10 3.5 5.5 8l4.5 4.5"
    : p.dir === "right" ? "M6 3.5 10.5 8 6 12.5"
      : "M3.5 6 8 10.5 12.5 6";
  return (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
};

// Titlebar glyphs. All share an 18px box with 1.5 strokes and round caps so the
// left cluster reads as one row of evenly weighted icons.
const TitlebarGlyph = (p: { children: ReactNode }) => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor"
    strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {p.children}
  </svg>
);

/** Panel with a rail on its leading edge — the standard "toggle sidebar" mark. */
const SidebarIcon = () => (
  <TitlebarGlyph>
    <rect x="2.5" y="3.5" width="13" height="11" rx="2.5" />
    <path d="M7 3.5v11" />
  </TitlebarGlyph>
);

const SearchIcon = () => (
  <TitlebarGlyph>
    <circle cx="8.2" cy="8.2" r="4.7" />
    <path d="M11.7 11.7 15 15" />
  </TitlebarGlyph>
);

const NavArrow = (p: { dir: "left" | "right" }) => (
  <TitlebarGlyph>
    <path d={p.dir === "left" ? "M14.5 9H4M8 4.5 3.5 9 8 13.5" : "M3.5 9H14M10 4.5 14.5 9 10 13.5"} />
  </TitlebarGlyph>
);

const GripIcon = () => (
  <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden="true">
    <circle cx="3" cy="3" r="1.1" /><circle cx="7" cy="3" r="1.1" />
    <circle cx="3" cy="7" r="1.1" /><circle cx="7" cy="7" r="1.1" />
    <circle cx="3" cy="11" r="1.1" /><circle cx="7" cy="11" r="1.1" />
  </svg>
);

const PlusIcon = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor"
    strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
    <path d="M8 3.5v9M3.5 8h9" />
  </svg>
);

const UserCircleIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
    stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true">
    <circle cx="8" cy="8" r="6" />
    <circle cx="8" cy="6.3" r="1.8" />
    <path d="M4.8 12c.8-1.7 5.6-1.7 6.4 0" />
  </svg>
);

const GearIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
    stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true">
    <circle cx="8" cy="8" r="2.3" />
    <path d="M8 1.8v1.5M8 12.7v1.5M14.2 8h-1.5M3.3 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7l-1.1-1.1" />
  </svg>
);

const UsageIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
    stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true">
    <path d="M3.3 11.8a5.8 5.8 0 119.4 0" />
    <path d="M8 8.4l2.6-2.6" />
    <path d="M5 12.8h6" />
  </svg>
);

const LogoutIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
    stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true">
    <path d="M6.5 3H3.8a1 1 0 00-1 1v8a1 1 0 001 1h2.7" />
    <path d="M9.5 5.2L12.3 8l-2.8 2.8M12.1 8H6.2" />
  </svg>
);

const PRIMARY_NAV_ITEMS: NavItem[] = [
  {
    id: "chat", label: "Chat",
    icon: <IC d="M2 3a1 1 0 011-1h10a1 1 0 011 1v6.5a1 1 0 01-1 1H9.5L8 12l-1.5-1.5H3a1 1 0 01-1-1V3z" />,
  },
  {
    id: "lab", label: "Code",
    icon: <IC d="M3.5 2.5h9v11h-9zM5.5 6l2.2 1.6-2.2 1.6M9 9.7h2.5" />,
  },
  {
    id: "typeset", label: "LaTeX",
    icon: <IC d="M3 2.8h7.2L13 5.6v7.6H3zM10.2 2.8v2.8H13M5.2 7.1h5.6M5.2 9.2h5.6M5.2 11.3h3.2" />,
  },
  {
    id: "literature", label: "Literature",
    icon: <IC
      d="M8 13.5V4C7 2.5 4.5 2.5 2 3.5V13c2.5-1 5-1 6 .5z"
      extra="M8 13.5V4c1-1.5 3.5-1.5 6-.5V13c-2.5-1-5-1-6 .5z"
    />,
  },
  {
    id: "workflows", label: "Workflows",
    icon: <IC
      d="M3 3.2h3.2v3.2H3zM9.8 9.6H13v3.2H9.8z"
      extra="M6.2 4.8h2.1a2 2 0 012 2v2.8M4.6 6.4v3.2a2 2 0 002 2h3.2"
    />,
  },
  {
    id: "mail", label: "Mail",
    icon: <IC d="M2 4.5h12v7H2zM2.5 5l5.5 4 5.5-4" />,
  },
];

const UTILITY_NAV_ITEMS: NavItem[] = [
  {
    id: "settings",
    label: "Settings",
    icon: <GearIcon />,
  },
];

const PRODUCT_NAMES: Record<Tab, string> = Object.fromEntries(
  [...PRIMARY_NAV_ITEMS, ...UTILITY_NAV_ITEMS].map((item) => [item.id, item.label]),
) as Record<Tab, string>;

/** Roving focus for a `role="menu"` popup. Items come from the event's own
 * container, so every module menu can share one handler. */
const menuKeyDownHandler = (close: () => void) => (event: ReactKeyboardEvent<HTMLDivElement>) => {
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
  if (items.length === 0) return;
  const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
  let nextIndex: number | null = null;
  if (event.key === "ArrowDown") nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
  else if (event.key === "ArrowUp") nextIndex = currentIndex < 0 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length;
  else if (event.key === "Home") nextIndex = 0;
  else if (event.key === "End") nextIndex = items.length - 1;
  else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    close();
    return;
  }
  if (nextIndex == null) return;
  event.preventDefault();
  items[nextIndex]?.focus();
};

/** The product switcher's module list. */
function NavMenuItems({ copy, tab, onSelect }: {
  copy: AppShellCopy;
  tab: Tab;
  onSelect: (id: Tab) => void;
}) {
  const hideMail = useStore((s) => s.hideMail);
  const hideWorkflows = useStore((s) => s.hideWorkflows);
  const visiblePrimaryItems = PRIMARY_NAV_ITEMS.filter((item) => {
    if (item.id === "mail" && hideMail) return false;
    if (item.id === "workflows" && hideWorkflows) return false;
    return true;
  });

  const renderItem = (item: NavItem, secondary: boolean) => (
    <button
      key={item.id}
      className={`product-menu-item${secondary ? " secondary" : ""}${tab === item.id ? " active" : ""}`}
      type="button"
      role="menuitemradio"
      aria-checked={tab === item.id}
      {...(secondary ? {} : { "data-onboarding-target": `nav-${item.id}` })}
      onPointerEnter={() => preloadTabModule(item.id)}
      onFocus={() => preloadTabModule(item.id)}
      onClick={() => onSelect(item.id)}
    >
      <span className="product-menu-icon">{item.icon}</span>
      <span>{copy.nav[item.id]}</span>
      <span className="product-menu-check" aria-hidden="true">
        {tab === item.id && <SvgIcon name="check" size={14} />}
      </span>
    </button>
  );
  return (
    <>
      <div className="product-menu-label">SomniQ</div>
      {visiblePrimaryItems.map((item) => renderItem(item, false))}
      <div className="product-menu-divider" role="separator" />
      {UTILITY_NAV_ITEMS.map((item) => renderItem(item, true))}
    </>
  );
}

function moveProjectId(
  ids: string[],
  draggedId: string,
  targetId: string,
  placeAfter: boolean,
) {
  if (draggedId === targetId) return ids;
  const next = ids.filter((id) => id !== draggedId);
  const targetIndex = next.indexOf(targetId);
  if (targetIndex === -1 || next.length === ids.length) return ids;
  next.splice(placeAfter ? targetIndex + 1 : targetIndex, 0, draggedId);
  return next;
}

function sameProjectOrder(left: string[], right: string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function accountName(account: NewApiAccount | null, fallback: string) {
  const displayName = account?.displayName?.trim();
  if (displayName) return displayName;
  const username = account?.username?.trim();
  if (!username) return fallback;
  const at = username.indexOf("@");
  return at > 0 ? username.slice(0, at) : username;
}

function accountEmail(account: NewApiAccount | null, fallback: string) {
  return account?.username?.trim() || account?.displayName?.trim() || fallback;
}

function accountPlan(account: NewApiAccount | null, copy: AppShellCopy) {
  const subscription = account?.subscriptionName?.trim();
  if (subscription) return subscription;
  if (account && Number.isFinite(account.quota)) return copy.balance(formatAccountQuota(account.quota));
  return copy.account;
}

function formatAccountQuota(credits: number): string {
  return `$${(credits / 500000).toFixed(2)}`;
}

function formatOptionalAccountQuota(credits?: number | null): string {
  return typeof credits === "number" && Number.isFinite(credits)
    ? formatAccountQuota(credits)
    : "-";
}

function accountInitials(name: string, email: string, userFallback: string) {
  const source = (name && name !== userFallback ? name : email).trim();
  const local = source.includes("@") ? source.slice(0, source.indexOf("@")) : source;
  const parts = local.split(/[\s._-]+/).filter(Boolean);
  const chars = parts.length > 1
    ? [parts[0][0], parts[1][0]]
    : Array.from(parts[0] ?? local).slice(0, 2);
  return chars.join("").toUpperCase() || "U";
}

function requestSettingsTab(tab: RequestedSettingsTab) {
  try {
    sessionStorage.setItem(SETTINGS_TAB_REQUEST_KEY, tab);
  } catch {
    // A live event below still handles the already-mounted settings page.
  }
  window.dispatchEvent(new CustomEvent<RequestedSettingsTab>(SETTINGS_TAB_REQUEST_EVENT, { detail: tab }));
}

export default function App() {
  const language = useStore((s) => s.language);
  const tab = useStore((s) => s.tab);
  const setTab = useStore((s) => s.setTab);
  const typesetDirty = useStore((s) => s.typesetDirty);
  const chatSidebarOpen = useStore((s) => s.chatSidebarOpen);
  const setChatSidebarOpen = useStore((s) => s.setChatSidebarOpen);
  const chatSidebarCollapsed = useStore((s) => s.chatSidebarCollapsed);
  const setChatSidebarCollapsed = useStore((s) => s.setChatSidebarCollapsed);
  const sidebarIsOverlay = useSidebarIsOverlay();
  const logout = useStore((s) => s.logout);
  const deferredTab = useDeferredValue(tab);
  const [, startTabTransition] = useTransition();
  const error = useStore((s) => s.error);
  const setError = useStore((s) => s.setError);
  const init = useStore((s) => s.init);
  const projects = useStore((s) => s.projects);
  const currentProject = useStore((s) => s.currentProject);
  const projectBusy = useStore((s) => s.projectBusy);
  const addProject = useStore((s) => s.addProject);
  const switchProject = useStore((s) => s.switchProject);
  const reorderProjects = useStore((s) => s.reorderProjects);
  const [productMenuOpen, setProductMenuOpen] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [usageDetailsOpen, setUsageDetailsOpen] = useState(false);
  const [account, setAccount] = useState<NewApiAccount | null>(() => readCachedAccount());
  const profileAvatar = useProfileAvatar();
  const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null);
  const [projectOrderPreview, setProjectOrderPreview] = useState<string[] | null>(null);
  const [updateState, setUpdateState] = useState<UpdateIndicatorState>("idle");
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [updateProgress, setUpdateProgress] = useState<AppUpdateProgress | null>(null);
  const [literaturePageView, setLiteraturePageView] = useState<LiteraturePageView>("library");
  // Mount Code once on first visit, then keep it alive (hidden) like Chat
  // instead of conditionally mounting per tab: remounting would tear down the
  // workbench iframe and restart its extension host on every tab switch.
  const [codeMounted, setCodeMounted] = useState(false);
  const [typesetMounted, setTypesetMounted] = useState(false);
  const [workflowsMounted, setWorkflowsMounted] = useState(false);
  const productSwitcherRef = useRef<HTMLDivElement | null>(null);
  const productSwitcherTriggerRef = useRef<HTMLButtonElement | null>(null);
  const productMenuRef = useRef<HTMLDivElement | null>(null);
  const projectSwitcherRef = useRef<HTMLDivElement | null>(null);
  const projectOrderPreviewRef = useRef<string[] | null>(null);
  const suppressProjectClickRef = useRef(false);
  const updateCheckInFlightRef = useRef(false);
  const updateStateRef = useRef<UpdateIndicatorState>("idle");
  const accountRefreshInFlightRef = useRef(false);
  const lastAccountRefreshAtRef = useRef(0);
  const projectDragRef = useRef<{
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const userMenuRef = useRef<HTMLDivElement | null>(null);
  // Close requests are synchronous, whereas chat events are asynchronous. A
  // ref keeps the latest backend-wide count available in the close callback,
  // including turns started from the Writing Companion window.
  const runningConversationCountRef = useRef(0);

  const selectTab = useCallback((nextTab: Tab) => {
    preloadTabModule(nextTab);
    startTabTransition(() => setTab(nextTab));
    setProductMenuOpen(false);
    setProjectMenuOpen(false);
    setUserMenuOpen(false);
    setUsageDetailsOpen(false);
  }, [setTab, startTabTransition]);

  const chooseProject = async () => {
    setProjectMenuOpen(false);
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Add SomniQ project",
    });
    if (typeof selected === "string") {
      if (typesetDirty && !window.confirm("Discard the unsaved LaTeX changes and open the added project?")) {
        return;
      }
      try {
        await addProject(selected);
      } catch {
        // The store surfaces project errors in the global toast.
      }
    }
  };

  const selectProject = (id: string) => {
    setProjectMenuOpen(false);
    if (
      id !== currentProject?.id
      && typesetDirty
      && !window.confirm("Discard the unsaved LaTeX changes and switch projects?")
    ) {
      return;
    }
    void switchProject(id).catch(() => undefined);
  };

  const startProjectDrag = (
    event: ReactPointerEvent<HTMLElement>,
    id: string,
  ) => {
    if (projectBusy || projects.length <= 1 || event.button !== 0) return;
    projectDragRef.current = {
      id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveProjectDrag = (
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    const drag = projectDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.moved) {
      const deltaX = Math.abs(event.clientX - drag.startX);
      const deltaY = Math.abs(event.clientY - drag.startY);
      if (deltaX + deltaY < 4) return;
      drag.moved = true;
      const ids = projects.map((project) => project.id);
      projectOrderPreviewRef.current = ids;
      setProjectOrderPreview(ids);
      setDraggedProjectId(drag.id);
    }
    event.preventDefault();
    event.stopPropagation();
    const hovered = document.elementFromPoint(event.clientX, event.clientY);
    const target = hovered instanceof Element
      ? hovered.closest<HTMLElement>("[data-project-id]")
      : null;
    const targetId = target?.dataset.projectId;
    if (!targetId || targetId === drag.id) return;
    const rect = target.getBoundingClientRect();
    const placeAfter = event.clientY > rect.top + rect.height / 2;
    const currentIds = projectOrderPreviewRef.current ?? projects.map((project) => project.id);
    const ids = moveProjectId(
      currentIds,
      drag.id,
      targetId,
      placeAfter,
    );
    if (sameProjectOrder(ids, currentIds)) return;
    projectOrderPreviewRef.current = ids;
    setProjectOrderPreview(ids);
  };

  const finishProjectDrag = (
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    const drag = projectDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.moved) {
      event.preventDefault();
      event.stopPropagation();
      suppressProjectClickRef.current = true;
      window.setTimeout(() => {
        suppressProjectClickRef.current = false;
      }, 0);
    }
    const ids = projectOrderPreviewRef.current;
    projectDragRef.current = null;
    projectOrderPreviewRef.current = null;
    setDraggedProjectId(null);
    setProjectOrderPreview(null);
    if (ids && drag.moved && !sameProjectOrder(ids, projects.map((project) => project.id))) {
      void reorderProjects(ids).catch(() => undefined);
    }
  };

  const cancelProjectDrag = (
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    const drag = projectDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    projectDragRef.current = null;
    projectOrderPreviewRef.current = null;
    setDraggedProjectId(null);
    setProjectOrderPreview(null);
  };

  const openSettingsTab = useCallback((settingsTab: RequestedSettingsTab = "general") => {
    requestSettingsTab(settingsTab);
    selectTab("settings");
  }, [selectTab]);

  const handleLogout = useCallback(() => {
    setUserMenuOpen(false);
    setUsageDetailsOpen(false);
    setAccount(null);
    writeCachedAccount(null);
    logout();
  }, [logout]);

  const refreshAccount = useCallback(async (options: { force?: boolean } = {}) => {
    if (!hasNativeBackend()) return;
    const now = Date.now();
    if (accountRefreshInFlightRef.current) return;
    if (!options.force && now - lastAccountRefreshAtRef.current < ACCOUNT_REFRESH_MIN_INTERVAL_MS) return;
    accountRefreshInFlightRef.current = true;
    lastAccountRefreshAtRef.current = now;
    try {
      const next = await newapiBootstrap();
      setAccount(next);
      writeCachedAccount(next);
    } catch (err) {
      if (isManagedAuthInvalidError(err)) {
        setAccount(null);
        writeCachedAccount(null);
        logout();
      }
    } finally {
      accountRefreshInFlightRef.current = false;
    }
  }, [logout]);

  useEffect(() => init(), [init]);
  useEffect(() => {
    if (!hasNativeBackend()) return;
    void refreshAccount({ force: true });
    const timer = window.setInterval(() => {
      void refreshAccount();
    }, ACCOUNT_REFRESH_INTERVAL_MS);
    const refreshOnFocus = () => {
      void refreshAccount();
    };
    window.addEventListener("focus", refreshOnFocus);
    let disposed = false;
    let unlistenChatDone: (() => void) | null = null;
    void onChatDone(() => {
      void refreshAccount({ force: true });
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlistenChatDone = unlisten;
    }).catch(() => {});
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshOnFocus);
      unlistenChatDone?.();
    };
  }, [refreshAccount]);
  useEffect(() => {
    if (userMenuOpen) void refreshAccount();
  }, [refreshAccount, userMenuOpen]);
  useEffect(() => {
    if (tab === "lab") setCodeMounted(true);
    if (tab === "typeset") setTypesetMounted(true);
    if (tab === "workflows") setWorkflowsMounted(true);
  }, [tab]);
  useEffect(() => installBrowserUnsavedChangesGuard(
    isTauri(),
    () => useStore.getState().typesetDirty,
  ), []);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void chatRunningTurnCount()
      .then((count) => {
        if (!disposed) runningConversationCountRef.current = count;
      })
      .catch(() => undefined);
    void onChatRunState(({ runningTurnCount }) => {
      runningConversationCountRef.current = runningTurnCount;
    }).then((nextUnlisten) => {
      if (disposed) nextUnlisten();
      else unlisten = nextUnlisten;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void getCurrentWindow().onCloseRequested((event) => {
      const hazards = {
        hasUnsavedChanges: useStore.getState().typesetDirty,
        runningConversationCount: Math.max(
          runningConversationCountRef.current,
          clientRunningConversationCount(),
        ),
      };
      if (shouldPreventDesktopClose(hazards, () => window.confirm(
        desktopCloseConfirmationMessage(language, hazards),
      ))) {
        event.preventDefault();
      }
    }).then((nextUnlisten) => {
      if (disposed) nextUnlisten();
      else unlisten = nextUnlisten;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [language]);
  useEffect(() => {
    let disposed = false;
    const heavyTabs = ["literature", "mail"];
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    let idleId: number | null = null;
    let timerId: number | null = null;

    const scheduleNext = () => {
      if (disposed || heavyTabs.length === 0) return;
      const warm = () => {
        if (disposed) return;
        const next = heavyTabs.shift();
        if (next) preloadTabModule(next);
        timerId = window.setTimeout(scheduleNext, 500);
      };
      if (idleWindow.requestIdleCallback) {
        idleId = idleWindow.requestIdleCallback(warm, { timeout: 4000 });
      } else {
        timerId = window.setTimeout(warm, 1200);
      }
    };

    timerId = window.setTimeout(scheduleNext, 2500);
    return () => {
      disposed = true;
      if (timerId !== null) window.clearTimeout(timerId);
      if (idleId !== null && idleWindow.cancelIdleCallback) idleWindow.cancelIdleCallback(idleId);
    };
  }, []);
  useEffect(() => {
    updateStateRef.current = updateState;
  }, [updateState]);
  const checkForAppUpdate = useCallback(async () => {
    if (updateCheckInFlightRef.current) return;
    if (updateStateRef.current === "downloading" || updateStateRef.current === "ready") return;
    updateCheckInFlightRef.current = true;
    try {
      const result = await appUpdateCheck();
      if (result.available) {
        setUpdateInfo(result);
        setUpdateProgress(null);
        setUpdateState("available");
      } else {
        setUpdateInfo(result);
        setUpdateProgress(null);
        setUpdateState("idle");
      }
    } catch {
      if (updateStateRef.current !== "available") {
        setUpdateState("idle");
      }
    } finally {
      updateCheckInFlightRef.current = false;
    }
  }, []);
  useEffect(() => {
    void checkForAppUpdate();
    const timer = window.setInterval(() => {
      void checkForAppUpdate();
    }, UPDATE_CHECK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [checkForAppUpdate]);
  // Collapsing the docked sidebar has to reach the app-head's matching left
  // cell as well, so the state rides on the body rather than on `.chat-root`.
  useEffect(() => {
    document.body.classList.toggle("somniq-chat-sidebar-collapsed", chatSidebarCollapsed);
    return () => document.body.classList.remove("somniq-chat-sidebar-collapsed");
  }, [chatSidebarCollapsed]);
  useEffect(() => {
    if (!productMenuOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setProductMenuOpen(false);
        productSwitcherTriggerRef.current?.focus();
      }
    };
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !productSwitcherRef.current?.contains(target)) {
        setProductMenuOpen(false);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeOnPointerDown);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeOnPointerDown);
    };
  }, [productMenuOpen]);
  useEffect(() => {
    if (!productMenuOpen) return;
    const frame = window.requestAnimationFrame(() => {
      productMenuRef.current
        ?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
        ?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [productMenuOpen]);
  useEffect(() => {
    const openSettingsShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === ",") {
        event.preventDefault();
        openSettingsTab("general");
      }
    };
    window.addEventListener("keydown", openSettingsShortcut);
    return () => window.removeEventListener("keydown", openSettingsShortcut);
  }, [openSettingsTab]);
  useEffect(() => {
    if (!projectMenuOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setProjectMenuOpen(false);
    };
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        !projectSwitcherRef.current?.contains(target)
      ) {
        setProjectMenuOpen(false);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeOnPointerDown);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeOnPointerDown);
    };
  }, [projectMenuOpen]);
  useEffect(() => {
    if (!userMenuOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setUserMenuOpen(false);
        setUsageDetailsOpen(false);
      }
    };
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        !userMenuRef.current?.contains(target)
      ) {
        setUserMenuOpen(false);
        setUsageDetailsOpen(false);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeOnPointerDown);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeOnPointerDown);
    };
  }, [userMenuOpen]);
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const orderedProjects = (projectOrderPreview ?? projects.map((project) => project.id))
    .map((id) => projectById.get(id))
    .filter((project): project is NonNullable<typeof project> => Boolean(project));
  const renderedTab = deferredTab;
  const chatShell = renderedTab === "chat" || renderedTab === "scheduled";
  const chatSidebarShown = sidebarIsOverlay ? chatSidebarOpen : !chatSidebarCollapsed;
  const showChatSidebar = (shown: boolean) => {
    if (sidebarIsOverlay) setChatSidebarOpen(shown);
    else setChatSidebarCollapsed(!shown);
  };
  const productTab: Tab = renderedTab === "scheduled" ? "chat" : renderedTab;
  const showUpdateIndicator = updateState === "available" || updateState === "downloading" || updateState === "ready";
  const copy = APP_COPY[language];
  const updateVersionLabel = updateInfo?.version ? ` v${updateInfo.version}` : "";
  const updateTitle = updateState === "ready"
    ? copy.updateReady(updateVersionLabel)
    : updateState === "downloading"
      ? copy.updateDownloading(updateVersionLabel, updateProgress?.percent)
      : copy.updateAvailable(updateVersionLabel);
  const handleUpdateIndicatorClick = async () => {
    if (updateState === "ready") {
      try {
        await appRelaunch();
      } catch (err) {
        setError(`Failed to restart after update: ${String(err)}`);
      }
      return;
    }
    if (updateState !== "available") return;
    setUpdateState("downloading");
    setUpdateProgress(null);
    try {
      const result = await appUpdateDownloadAndInstall((progress) => {
        setUpdateProgress(progress);
      });
      if (result.installed) {
        setUpdateInfo((current) => ({
          available: true,
          currentVersion: current?.currentVersion,
          version: result.version ?? current?.version,
          date: current?.date,
          body: current?.body,
        }));
        setUpdateState("ready");
      } else {
        setUpdateState("idle");
        setUpdateInfo(null);
      }
    } catch (err) {
      setUpdateState("available");
      setError(`Failed to install update: ${String(err)}`);
    }
  };
  const renderUpdateIndicator = () => showUpdateIndicator ? (
    <button
      className={`app-update-indicator ${updateState}`}
      type="button"
      onClick={() => void handleUpdateIndicatorClick()}
      disabled={updateState === "downloading"}
      title={updateTitle}
      aria-label={updateTitle}
    >
      <span className="app-update-icon" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round">
          {updateState === "ready" ? (
            <path d="M3 8.2 6.4 11.5 13 4.5" />
          ) : (
            <path d="M8 2.5v7M4.7 6.4 8 9.7l3.3-3.3M3 13.2h10" />
          )}
        </svg>
      </span>
      <span className="app-update-badge" aria-hidden="true" />
    </button>
  ) : null;
  const userName = accountName(account, copy.userFallback);
  const userEmail = accountEmail(account, copy.accountInfo);
  const userPlan = accountPlan(account, copy);
  const userInitials = accountInitials(userName, userEmail, copy.userFallback);
  const usageMenuLabels = language === "cn"
    ? { balance: "余额", used: "已用", plan: "套餐", subscriptionBalance: "套餐余额" }
    : { balance: "Balance", used: "Used", plan: "Plan", subscriptionBalance: "Plan balance" };
  const usageDetailsLabel = language === "cn" ? "\u4f7f\u7528\u7edf\u8ba1" : "Usage statistics";
  const showSubscriptionQuota = typeof account?.subscriptionQuota === "number"
    && Number.isFinite(account.subscriptionQuota)
    && account.subscriptionQuota !== account.quota;
  const usagePrimary = [usageMenuLabels.balance, formatOptionalAccountQuota(account?.quota)] as const;
  const usageMetrics = [
    [usageMenuLabels.used, formatOptionalAccountQuota(account?.usedQuota)] as const,
    ...(showSubscriptionQuota
      ? [[usageMenuLabels.subscriptionBalance, formatOptionalAccountQuota(account?.subscriptionQuota)] as const]
      : []),
  ];
  const handleProductMenuKeyDown = menuKeyDownHandler(() => {
    setProductMenuOpen(false);
    productSwitcherTriggerRef.current?.focus();
  });

  return (
    <div className={`app${chatShell ? " app-chat-shell" : ""}`}>
      <div className="window-titlebar">
        <div className="window-titlebar-left">
          {/* The sidebar belongs to Chat, so these two go quiet on other tabs
              rather than switching modules out from under the pointer. */}
          <button
            className="window-titlebar-icon"
            type="button"
            aria-label={copy.toggleSidebar}
            aria-pressed={chatSidebarShown}
            title={copy.toggleSidebar}
            disabled={!chatShell}
            onClick={() => showChatSidebar(!chatSidebarShown)}
          >
            <SidebarIcon />
          </button>
          <button
            className="window-titlebar-icon"
            type="button"
            aria-label={copy.findConversations}
            title={copy.findConversations}
            disabled={!chatShell}
            onClick={() => showChatSidebar(true)}
          >
            <SearchIcon />
          </button>
          <button className="window-titlebar-icon" type="button" disabled aria-label={copy.back}>
            <NavArrow dir="left" />
          </button>
          <button className="window-titlebar-icon" type="button" disabled aria-label={copy.forward}>
            <NavArrow dir="right" />
          </button>
        </div>
        <div
          className="window-titlebar-drag"
          data-tauri-drag-region
          onDoubleClick={() => requestWindowAction("maximize")}
        />
        <div className="window-titlebar-controls">
          {isTauri() && (
            <button
              className="chat-companion-launch"
              type="button"
              title={copy.openChatCompanion}
              aria-label={copy.openChatCompanion}
              onClick={() => void openChatCompanion().catch((error) => setError(String(error)))}
            >
              <svg width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 3.5h12v8H9.8L7 14v-2.5H3z" />
                <path d="M11.5 2.5h4v4M15.5 2.5l-4.2 4.2" />
              </svg>
            </button>
          )}
          {renderUpdateIndicator()}
          <WindowControlButtons
            labels={{
              minimize: copy.minimizeWindow,
              maximize: copy.maximizeWindow,
              close: copy.closeWindow,
            }}
          />
        </div>
      </div>
      <header className="app-head">
        <div className="app-head-title">
          <div className="product-switcher" ref={productSwitcherRef}>
            <button
              ref={productSwitcherTriggerRef}
              className="product-switcher-trigger"
              type="button"
              aria-haspopup="menu"
              aria-expanded={productMenuOpen}
              aria-label={copy.switchProduct(PRODUCT_NAMES[productTab])}
              data-onboarding-target="product-switcher"
              onKeyDown={(event) => {
                if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                event.preventDefault();
                setProductMenuOpen(true);
              }}
              onClick={() => {
                setProjectMenuOpen(false);
                setUserMenuOpen(false);
                setUsageDetailsOpen(false);
                setProductMenuOpen((open) => !open);
              }}
            >
              <span className="product-switcher-name">SomniQ</span>
              <span className="product-switcher-module">{PRODUCT_NAMES[productTab]}</span>
              <span className="product-switcher-caret" aria-hidden="true">
                <Chevron dir="down" size={13} />
              </span>
            </button>
            {productMenuOpen && (
              <div
                ref={productMenuRef}
                className="product-menu"
                role="menu"
                aria-label={copy.productMenuLabel}
                onKeyDown={handleProductMenuKeyDown}
              >
                <NavMenuItems copy={copy} tab={tab} onSelect={selectTab} />
              </div>
            )}
          </div>
          {tab === "literature" && (
            <LiteratureViewTabs
              pageView={literaturePageView}
              onPageViewChange={setLiteraturePageView}
              className="app-head-literature-tabs"
            />
          )}
        </div>
        <div className="app-head-actions">
          <div
            className="project-switcher"
            ref={projectSwitcherRef}
            data-onboarding-target="project-switcher"
          >
            <button
              className="project-switcher-trigger"
              type="button"
              aria-label={copy.currentProject}
              aria-haspopup="listbox"
              aria-expanded={projectMenuOpen}
              disabled={projectBusy || projects.length === 0}
              onClick={() => {
                setProductMenuOpen(false);
                setUserMenuOpen(false);
                setUsageDetailsOpen(false);
                setProjectMenuOpen((open) => !open);
              }}
              title={currentProject?.path}
            >
              <span className="project-switcher-current">
                {currentProject?.name ?? copy.noProject}
              </span>
              <span className="project-switcher-caret" aria-hidden="true">
                <Chevron dir="down" size={13} />
              </span>
            </button>
            {projectMenuOpen && (
              <div className="project-menu" role="listbox" aria-label={copy.projects}>
                {orderedProjects.map((project) => (
                  <div
                    key={project.id}
                    className={`project-menu-item${currentProject?.id === project.id ? " active" : ""}${draggedProjectId === project.id ? " dragging" : ""}`}
                    role="option"
                    aria-selected={currentProject?.id === project.id}
                    aria-disabled={projectBusy}
                    tabIndex={projectBusy ? -1 : 0}
                    data-project-id={project.id}
                    title={project.path}
                    onClick={(event) => {
                      if (suppressProjectClickRef.current) {
                        event.preventDefault();
                        event.stopPropagation();
                        return;
                      }
                      if (!projectBusy) selectProject(project.id);
                    }}
                    onKeyDown={(event) => {
                      if (!projectBusy && (event.key === "Enter" || event.key === " ")) {
                        event.preventDefault();
                        selectProject(project.id);
                      }
                    }}
                    onPointerDown={(event) => startProjectDrag(event, project.id)}
                    onPointerMove={moveProjectDrag}
                    onPointerUp={finishProjectDrag}
                    onPointerCancel={cancelProjectDrag}
                  >
                    <span
                      className="project-drag-handle"
                      aria-hidden="true"
                      title={copy.dragToReorder}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                    >
                      <GripIcon />
                    </span>
                    <span className="project-menu-copy">
                      <span className="project-menu-name">{project.name}</span>
                      <span className="project-menu-path">{project.path}</span>
                    </span>
                    <span className="project-current-dot" aria-hidden="true" />
                  </div>
                ))}
              </div>
            )}
            <button
              className="project-add-btn"
              onClick={() => void chooseProject()}
              disabled={projectBusy}
              title={copy.addProject}
              aria-label={copy.addProject}
            >
              <PlusIcon />
              <span>{copy.add}</span>
            </button>
            <button
              className="project-open-btn"
              type="button"
              title={currentProject?.path ? `${copy.openWorkspace} (${currentProject.path})` : copy.openWorkspace}
              aria-label={copy.openWorkspace}
              disabled={!currentProject?.path}
              onClick={() => {
                if (!currentProject?.path) return;
                void fileReveal(currentProject.path).catch((error) => setError(String(error)));
              }}
            >
              <SvgIcon name="folder" size={15} />
            </button>
          </div>
          <div id="app-chat-actions-portal" style={{ display: "contents" }} />
          <div className="app-account" ref={userMenuRef}>
            {userMenuOpen && (
              <div className="sidebar-user-menu" role="menu" aria-label={copy.userMenu}>
                <div className="sidebar-user-menu-row muted" role="presentation">
                  <span className="sidebar-user-menu-icon"><UserCircleIcon /></span>
                  <span className="sidebar-user-menu-email">{userEmail}</span>
                </div>
                <button
                  className="sidebar-user-menu-row"
                  type="button"
                  role="menuitem"
                  data-onboarding-target="user-settings"
                  onClick={() => openSettingsTab("general")}
                >
                  <span className="sidebar-user-menu-icon"><GearIcon /></span>
                  <span>{copy.settings}</span>
                  <span className="sidebar-user-shortcut">Ctrl+,</span>
                </button>
                <div className="sidebar-user-menu-divider" role="separator" />
                <button
                  className={`sidebar-user-menu-row${usageDetailsOpen ? " active" : ""}`}
                  type="button"
                  role="menuitem"
                  aria-expanded={usageDetailsOpen}
                  aria-controls="sidebar-user-usage-details"
                  onClick={() => setUsageDetailsOpen((open) => !open)}
                >
                  <span className="sidebar-user-menu-icon"><UsageIcon /></span>
                  <span>{copy.remainingUsage}</span>
                  <span className="sidebar-user-chevron"><Chevron dir={usageDetailsOpen ? "down" : "right"} size={13} /></span>
                </button>
                {usageDetailsOpen && (
                  <div className="sidebar-user-usage-panel" id="sidebar-user-usage-details" role="group" aria-label={copy.remainingUsage}>
                    <div className="sidebar-user-usage-primary">
                      <span>{usagePrimary[0]}</span>
                      <strong>{usagePrimary[1]}</strong>
                    </div>
                    <div className="sidebar-user-usage-grid">
                      {usageMetrics.map(([label, value]) => (
                        <div className="sidebar-user-usage-tile" key={label}>
                          <span>{label}</span>
                          <strong>{value}</strong>
                        </div>
                      ))}
                    </div>
                    <button className="sidebar-user-usage-link" type="button" onClick={() => openSettingsTab("account")}>
                      {usageDetailsLabel}
                    </button>
                  </div>
                )}
                <button className="sidebar-user-menu-row" type="button" role="menuitem" onClick={handleLogout}>
                  <span className="sidebar-user-menu-icon"><LogoutIcon /></span>
                  <span>{copy.logout}</span>
                </button>
              </div>
            )}
            <button
              className="app-account-button"
              type="button"
              aria-haspopup="menu"
              aria-expanded={userMenuOpen}
              aria-label={copy.user}
              title={`${userName} · ${userPlan}`}
              data-onboarding-target="user-menu"
              onClick={() => {
                setProductMenuOpen(false);
                setProjectMenuOpen(false);
                setUsageDetailsOpen(false);
                setUserMenuOpen((open) => !open);
              }}
            >
              <span className="sidebar-user-avatar">
                {profileAvatar ? <img src={profileAvatar} alt="" /> : userInitials}
              </span>
              <span className="app-account-summary" aria-hidden="true">
                <span className="app-account-name">{userName}</span>
                <span className="app-account-plan">{userPlan}</span>
              </span>
              <span className="app-account-chevron" aria-hidden="true">
                <Chevron dir={userMenuOpen ? "down" : "right"} size={13} />
              </span>
            </button>
          </div>
        </div>
      </header>

      <main className="app-main" data-onboarding-target="workspace">
        <ErrorBoundary
          resetKey={renderedTab}
          fallback={(viewError, reset) => <AppViewFallback copy={copy} error={viewError} reset={reset} language={language} />}
        >
          <div hidden={renderedTab !== "chat" && renderedTab !== "scheduled"}>
            <ErrorBoundary
              resetKey="chat"
              fallback={(viewError, reset) => <AppViewFallback copy={copy} error={viewError} reset={reset} language={language} />}
            >
              <ChatPane />
            </ErrorBoundary>
          </div>
          {codeMounted && (
            <div className="app-code-pane" hidden={renderedTab !== "lab"}>
              <ErrorBoundary
                resetKey="code"
                fallback={(viewError, reset) => <AppViewFallback copy={copy} error={viewError} reset={reset} language={language} />}
              >
                <Suspense fallback={<AppLoadingPane copy={copy} label={copy.nav.lab} />}>
                  <CodePane />
                </Suspense>
              </ErrorBoundary>
            </div>
          )}
          {typesetMounted && (
            <div className="app-typeset-pane" hidden={renderedTab !== "typeset"}>
              <Suspense fallback={<AppLoadingPane copy={copy} label={copy.nav.typeset} />}>
                <Typeset />
              </Suspense>
            </div>
          )}
          {renderedTab === "literature" && (
            <Suspense fallback={<AppLoadingPane copy={copy} label={copy.nav.literature} />}>
              <Literature pageView={literaturePageView} onPageViewChange={setLiteraturePageView} />
            </Suspense>
          )}
          {workflowsMounted && (
            <div className="app-workflows-pane" hidden={renderedTab !== "workflows"}>
              <Suspense fallback={<AppLoadingPane copy={copy} label={copy.nav.workflows} />}>
                <Workflows />
              </Suspense>
            </div>
          )}
          {renderedTab === "mail" && (
            <Suspense fallback={<AppLoadingPane copy={copy} label={copy.nav.mail} />}>
              <Mail />
            </Suspense>
          )}
          {renderedTab === "extensions" && <Extensions />}
          {renderedTab === "settings" && <Settings />}
        </ErrorBoundary>

        {error && (
          <div className="toast" role="alert" aria-live="assertive">
            {error}
            <button onClick={() => setError(null)}>{copy.dismiss}</button>
          </div>
        )}
      </main>
      <OnboardingTutorial />
    </div>
  );
}
