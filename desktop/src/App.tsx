import { lazy, memo, Suspense, useCallback, useDeferredValue, useEffect, useRef, useState, useTransition, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { appRelaunch, appUpdateCheck, appUpdateDownloadAndInstall, chatRunningTurnCount, fileReveal, isTauri, newapiBootstrap, onChatDone, onChatRunState, openChatCompanion, type NewApiAccount } from "./api/tauri";
import { hasNativeBackend } from "./api/transport";
import { figuresRunningCount, onFigureUpdated } from "./figures/figureApi";
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
import AppNavigationRail from "./AppNavigationRail";
import AppProductSwitcher from "./AppProductSwitcher";
import AppProjectSwitcher, { type AppProjectSwitcherCopy } from "./AppProjectSwitcher";
import AppAccountMenu from "./AppAccountMenu";
import { useCodeShell } from "./code/useCodeShell";
import { formatQuota } from "./settings/settingsFormatters";
import { accountMenuPlan } from "./accountMenuPlan";
import { desktopCloseConfirmationMessage, installBrowserUnsavedChangesGuard, shouldPreventDesktopClose } from "./windowCloseGuard";
import { requestWindowAction } from "./windowControls";
import { WindowControlButtons } from "./WindowControlButtons";
import { SvgIcon } from "./SvgIcon";
import { useProfileAvatar } from "./profileAvatar";
import { usePendingScreenshot } from "./screenshot/usePendingScreenshot";
// The work-task board is lazily loaded from inside Chat, but its stylesheet is
// not: imported from the lazy module it becomes a separate CSS chunk fetched
// when the tab opens, and a single failed fetch renders the board as bare
// HTML. Loading it from this shell module puts it in the main bundle, where it
// cannot arrive late or not at all.
import "./tasks/Tasks.css";

const loadLiterature = () => import("./literature/Literature");
const loadMail = () => import("./mail/Mail");
const loadTypeset = () => import("./typeset/Typeset");
const loadFigures = () => import("./figures/FigureStudio");
const loadCode = () => import("./code/CodePane");
const loadWorkflows = () => import("./workflows/Workflows");

const Literature = lazy(loadLiterature);
const Mail = lazy(loadMail);
const Typeset = lazy(loadTypeset);
const FigureStudio = lazy(loadFigures);
const CodePane = lazy(loadCode);
const Workflows = lazy(loadWorkflows);
const ChatPane = memo(Chat);

type AppShellCopy = AppProjectSwitcherCopy & {
  nav: Record<Tab, string>;
  loading: (label: string) => string;
  viewErrorTitle: string;
  viewErrorBody: string;
  tryAgain: string;
  userFallback: string;
  accountInfo: string;
  back: string;
  forward: string;
  toggleSidebar: string;
  findConversations: string;
  productMenuLabel: string;
  switchProduct: (name: string) => string;
  moreModules: string;
  minimizeWindow: string;
  maximizeWindow: string;
  closeWindow: string;
  openChatCompanion: string;
  runStateDir: string;
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
      figures: "科研绘图",
      literature: "文献",
      workflows: "研究流程",
      mail: "邮箱",
      tasks: "待办任务",
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
    back: "后退",
    forward: "前进",
    toggleSidebar: "显示或隐藏对话侧栏",
    findConversations: "在侧栏中查找对话",
    productMenuLabel: "SomniQ 功能",
    switchProduct: (name) => `当前功能：${name}，点击切换`,
    moreModules: "更多功能",
    minimizeWindow: "最小化窗口",
    maximizeWindow: "最大化窗口",
    closeWindow: "关闭窗口",
    openChatCompanion: "打开论文伴写悬浮窗",
    currentProject: "当前项目",
    noProject: "无项目",
    projects: "本地项目",
    dragToReorder: "拖动排序",
    addProject: "添加本地项目…",
    openProjectFolder: "打开项目文件夹",
    projectEmptyHint: "选择文件夹以添加项目",
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
      figures: "Figures",
      literature: "Literature",
      workflows: "Workflows",
      mail: "Mail",
      tasks: "Work tasks",
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
    back: "Back",
    forward: "Forward",
    toggleSidebar: "Show or hide the conversation sidebar",
    findConversations: "Find conversations in the sidebar",
    productMenuLabel: "SomniQ modules",
    switchProduct: (name) => `Current module: ${name}. Switch module`,
    moreModules: "More modules",
    minimizeWindow: "Minimize window",
    maximizeWindow: "Maximize window",
    closeWindow: "Close window",
    openChatCompanion: "Open writing companion",
    currentProject: "Current project",
    noProject: "No project",
    projects: "Local projects",
    dragToReorder: "Drag to reorder",
    addProject: "Add local project…",
    openProjectFolder: "Open project folder",
    projectEmptyHint: "Choose a folder to add a project",
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
  else if (tabId === "figures") void loadFigures();
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

// Settings also resolves legacy category links to their current sidebar page.
type RequestedSettingsTab = SettingsNavId;

const ModuleIcon = ({ children }: { children: ReactNode }) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true">
    {children}
  </svg>
);

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

const GearIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
    stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true">
    <circle cx="8" cy="8" r="2.3" />
    <path d="M8 1.8v1.5M8 12.7v1.5M14.2 8h-1.5M3.3 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7l-1.1-1.1" />
  </svg>
);

const PRIMARY_NAV_ITEMS: NavItem[] = [
  {
    id: "chat", label: "Chat",
    icon: <ModuleIcon>
      <path d="M5 3.5h14a2.5 2.5 0 0 1 2.5 2.5v9a2.5 2.5 0 0 1-2.5 2.5h-6.5L7 21v-3.5H5A2.5 2.5 0 0 1 2.5 15V6A2.5 2.5 0 0 1 5 3.5Z" />
      <path d="M7 8.5h10M7 12.5h6" />
    </ModuleIcon>,
  },
  {
    id: "lab", label: "Code",
    icon: <ModuleIcon>
      <rect x="2.5" y="3" width="19" height="18" rx="2.5" />
      <path d="m6.5 8.5 3.5 3.5-3.5 3.5M13 15.5h4.5" />
    </ModuleIcon>,
  },
  {
    id: "typeset", label: "LaTeX",
    icon: <ModuleIcon>
      {/* TeX's lowered E makes the editor recognizable without relying on a font. */}
      <g fill="currentColor" stroke="none">
        <path d="M.8 4.5h8.5v3.2H8V6H5.9v10.2h1.5v1.4H2.8v-1.4h1.5V6H2.1v1.7H.8Z" />
        <path d="M8 7.5h7v2.8h-1.2V9h-3.3v3.9h2.6v-1.2h1.1v3.8h-1.1v-1.2h-2.6v4.3h3.3v-1.4H15V20H8v-1.4h1V9H8Z" />
        <path d="M15 4.5h3.6v1.4h-1l2.2 4.2L22 5.9h-1V4.5h3v1.4h-.6l-2.7 5 2.8 5.3h.5v1.4h-3.6v-1.4h1.1l-2.1-4.1-2.2 4.1h1.1v1.4H15v-1.4h.8l2.8-5.3-2.7-5H15Z" />
      </g>
    </ModuleIcon>,
  },
  {
    id: "figures", label: "Figures",
    icon: <ModuleIcon><rect x="3" y="3" width="18" height="18" rx="3" /><path d="m5 17 5-6 4 3 3-5 3 8" /><circle cx="8" cy="7" r="1" /></ModuleIcon>,
  },
  {
    id: "literature", label: "Literature",
    icon: <ModuleIcon>
      <path d="M12 5.5C9.5 3.5 5.5 3.2 2.5 4.3v15C6 18.1 9.5 18.5 12 20.5c2.5-2 6-2.4 9.5-1.2v-15C18.5 3.2 14.5 3.5 12 5.5Zm0 0v15" />
      <path d="m5.5 8 3.5.7M15 8.7l3.5-.7" />
    </ModuleIcon>,
  },
  {
    id: "workflows", label: "Workflows",
    icon: <ModuleIcon>
      <rect x="3" y="3" width="6" height="6" rx="1.5" />
      <rect x="15" y="15" width="6" height="6" rx="1.5" />
      <path d="M9 6h5a4 4 0 0 1 4 4v5M6 9v5a4 4 0 0 0 4 4h5" />
    </ModuleIcon>,
  },
  {
    id: "mail", label: "Mail",
    icon: <ModuleIcon>
      <rect x="2.5" y="4.5" width="19" height="15" rx="2.5" />
      <path d="m3.5 6 8.5 6.5L20.5 6" />
    </ModuleIcon>,
  },
];

const UTILITY_NAV_ITEMS: NavItem[] = [
  {
    id: "settings",
    label: "Settings",
    icon: <GearIcon />,
  },
];

const CHAT_DESTINATION_ITEMS: NavItem[] = [
  { id: "scheduled", label: "Scheduled", icon: <SvgIcon name="lightning" size={16} /> },
  { id: "tasks", label: "To-dos", icon: <SvgIcon name="notebook" size={16} /> },
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
  // Region screenshots arrive by event from the overlay windows; the hotkey
  // can fire while any tab is open, so the listener lives at the shell level.
  usePendingScreenshot();
  const language = useStore((s) => s.language);
  const tab = useStore((s) => s.tab);
  const setTab = useStore((s) => s.setTab);
  const typesetDirty = useStore((s) => s.typesetDirty);
  const figureDirty = useStore((s) => s.figureDirty);
  const chatSidebarOpen = useStore((s) => s.chatSidebarOpen);
  const setChatSidebarOpen = useStore((s) => s.setChatSidebarOpen);
  const chatSidebarCollapsed = useStore((s) => s.chatSidebarCollapsed);
  const setChatSidebarCollapsed = useStore((s) => s.setChatSidebarCollapsed);
  const sidebarIsOverlay = useSidebarIsOverlay();
  const hideMail = useStore((s) => s.hideMail);
  const hideWorkflows = useStore((s) => s.hideWorkflows);
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
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
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
  const [codeWorkbenchReady, setCodeWorkbenchReady] = useState(false);
  const [typesetMounted, setTypesetMounted] = useState(false);
  const [figuresMounted, setFiguresMounted] = useState(false);
  const [workflowsMounted, setWorkflowsMounted] = useState(false);
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
  const userMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  // Close requests are synchronous, whereas chat events are asynchronous. A
  // ref keeps the latest backend-wide count available in the close callback,
  // including turns started from the Writing Companion window.
  const runningConversationCountRef = useRef(0);
  const runningFigureCountRef = useRef(0);

  const selectTab = useCallback((nextTab: Tab) => {
    preloadTabModule(nextTab);
    startTabTransition(() => setTab(nextTab));
    setProjectMenuOpen(false);
    setUserMenuOpen(false);
  }, [setTab, startTabTransition]);

  const setProjectSwitcherOpen = useCallback((open: boolean) => {
    if (open) setUserMenuOpen(false);
    setProjectMenuOpen(open);
  }, []);

  const chooseProject = async () => {
    if (figureDirty) { setError(language === "cn" ? "请先保存科研绘图版本或放弃编辑，再切换项目。" : "Save or discard your figure edits before switching projects."); return; }
    setProjectMenuOpen(false);
    const selected = await open({
      directory: true,
      multiple: false,
      title: copy.addProject.replace(/…$/, ""),
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
    if (id !== currentProject?.id && figureDirty) { setError(language === "cn" ? "请先保存科研绘图版本或放弃编辑，再切换项目。" : "Save or discard your figure edits before switching projects."); return; }
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
    if (tab === "figures") setFiguresMounted(true);
    if (tab === "workflows") setWorkflowsMounted(true);
  }, [tab]);
  useEffect(() => installBrowserUnsavedChangesGuard(
    isTauri(),
    () => useStore.getState().typesetDirty || useStore.getState().figureDirty,
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
        hasUnsavedChanges: useStore.getState().typesetDirty || useStore.getState().figureDirty,
        hasUnsavedFigureChanges: useStore.getState().figureDirty,
        runningFigureCount: runningFigureCountRef.current,
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
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void figuresRunningCount().then((count) => { if (!disposed) runningFigureCountRef.current = count; }).catch(() => undefined);
    void onFigureUpdated((next) => { if (!disposed) runningFigureCountRef.current = next.activeCount ?? 0; }).then((fn) => { if (disposed) fn(); else unlisten = fn; }).catch(() => undefined);
    return () => { disposed = true; unlisten?.(); };
  }, []);
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
      const result = await appUpdateCheck(language === "cn");
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
  }, [language]);
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
    if (!userMenuOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setUserMenuOpen(false);
        userMenuTriggerRef.current?.focus();
      }
    };
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        !userMenuRef.current?.contains(target)
      ) {
        setUserMenuOpen(false);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeOnPointerDown);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeOnPointerDown);
    };
  }, [userMenuOpen]);
  useEffect(() => {
    if (!userMenuOpen) return;
    const frame = window.requestAnimationFrame(() => {
      userMenuRef.current?.querySelector<HTMLButtonElement>('.sidebar-user-menu button')?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [userMenuOpen]);
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const orderedProjects = (projectOrderPreview ?? projects.map((project) => project.id))
    .map((id) => projectById.get(id))
    .filter((project): project is NonNullable<typeof project> => Boolean(project));
  const renderedTab = deferredTab;
  const chatShell = renderedTab === "chat" || renderedTab === "scheduled" || renderedTab === "tasks";
  const navigationShell = chatShell || renderedTab === "settings";
  const chatSidebarShown = sidebarIsOverlay ? chatSidebarOpen : !chatSidebarCollapsed;
  const showChatSidebar = (shown: boolean) => {
    if (sidebarIsOverlay) setChatSidebarOpen(shown);
    else setChatSidebarCollapsed(!shown);
  };
  const productTab: Tab = renderedTab === "scheduled" || renderedTab === "tasks" ? "chat" : renderedTab;
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
      const result = await appUpdateDownloadAndInstall(language === "cn", (progress) => {
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
  const userPlan = accountMenuPlan(account, language);
  const userInitials = accountInitials(userName, userEmail, copy.userFallback);
  const handleUserMenuKeyDown = menuKeyDownHandler(() => {
    setUserMenuOpen(false);
    userMenuTriggerRef.current?.focus();
  });
  const navigationItems = PRIMARY_NAV_ITEMS.slice(0, 5).map((item) => ({ ...item, label: copy.nav[item.id] }));
  const moreNavigationItems = [...CHAT_DESTINATION_ITEMS, ...PRIMARY_NAV_ITEMS.slice(5), ...UTILITY_NAV_ITEMS]
    .filter((item) => (item.id !== "mail" || !hideMail) && (item.id !== "workflows" || !hideWorkflows))
    .map((item) => ({ ...item, label: copy.nav[item.id] }));

  const codeShellReady = useCodeShell({
    enabled: codeMounted,
    active: renderedTab === "lab",
    shell: {
      language,
      modules: [...navigationItems, ...moreNavigationItems].map(({ id, label }) => ({ id, label })),
      projects: orderedProjects.map(({ id, name, path }) => ({ id, name, path })),
      currentProjectId: currentProject?.id ?? null,
      projectBusy,
      account: {
        name: userName, plan: userPlan.label,
        allowance: userPlan.remaining === null ? (language === "cn" ? "额度信息暂不可用" : "Allowance unavailable") : formatQuota(userPlan.remaining),
        remainingPercent: userPlan.remainingPercent,
      },
    },
    onSelectModule: (id) => selectTab(id as Tab),
    onSelectProject: selectProject,
    onAddProject: () => void chooseProject().catch((reason) => setError(String(reason))),
    onRevealProject: () => {
      if (currentProject?.path) void fileReveal(currentProject.path).catch((reason) => setError(String(reason)));
    },
    onSettings: () => openSettingsTab("general"),
    onSignOut: handleLogout,
  });
  const codePage = renderedTab === "lab";
  const codeShell = codePage && codeShellReady && codeWorkbenchReady;
  // Keep a desktop-owned exit from Code when the duplicate header is removed.
  // It must work without an extension command or an editor socket round trip.
  const productSwitcher = (
    <AppProductSwitcher
      label={copy.productMenuLabel}
      triggerLabel={copy.switchProduct(PRODUCT_NAMES[productTab] ?? copy.nav[productTab])}
      moduleName={PRODUCT_NAMES[productTab] ?? copy.nav[productTab]}
      activeTab={productTab}
      items={[...navigationItems, ...moreNavigationItems.filter((item) => item.id !== "settings" && item.id !== "scheduled" && item.id !== "tasks")]}
      utilityItems={moreNavigationItems.filter((item) => item.id === "settings")}
      onOpen={() => {
        setProjectMenuOpen(false);
        setUserMenuOpen(false);
      }}
      onSelect={selectTab}
      onPreload={preloadTabModule}
    />
  );

  const accountControl = (
    <AppAccountMenu
      language={language}
      name={userName}
      initials={userInitials}
      avatar={profileAvatar}
      plan={userPlan}
      open={userMenuOpen}
      rootRef={userMenuRef}
      triggerRef={userMenuTriggerRef}
      onMenuKeyDown={handleUserMenuKeyDown}
      onToggle={() => {
        setProjectMenuOpen(false);
        setUserMenuOpen((open) => !open);
      }}
      onSettings={() => openSettingsTab("general")}
      onLogout={handleLogout}
    />
  );

  return (
    <div className={`app${navigationShell ? " app-navigation-shell" : ""}${chatShell ? " app-chat-shell chat-background-surface" : ""}${codeShell ? " app-code-shell" : ""}`}>
      <div className="window-titlebar">
        {codePage && <div className="window-titlebar-code-switcher">{productSwitcher}</div>}
        {!codePage && <div className="window-titlebar-left">
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
        </div>}
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
          {!navigationShell && renderUpdateIndicator()}
          <WindowControlButtons
            labels={{
              minimize: copy.minimizeWindow,
              maximize: copy.maximizeWindow,
              close: copy.closeWindow,
            }}
          />
        </div>
      </div>
      {navigationShell && <AppNavigationRail
        label={copy.productMenuLabel}
        moreLabel={copy.moreModules}
        items={navigationItems}
        moreItems={moreNavigationItems}
        activeTab={renderedTab}
        update={renderUpdateIndicator()}
        account={accountControl}
        onSelect={selectTab}
        onPreload={preloadTabModule}
      />}
      <header className="app-head" hidden={codeShell}>
        <div className="app-head-title">
          {!codePage && productSwitcher}
          <div id="app-chat-workspace-portal" hidden={!chatShell} />
          {tab === "literature" && literaturePageView !== "library" && (
            <LiteratureViewTabs
              pageView={literaturePageView}
              onPageViewChange={setLiteraturePageView}
              className="app-head-literature-tabs"
            />
          )}
        </div>
        {tab === "literature" && literaturePageView === "library" && <div id="literature-toolbar-slot" />}
        <div className="app-head-actions">
          <AppProjectSwitcher
            copy={copy} projects={orderedProjects} currentProject={currentProject}
            busy={projectBusy} open={projectMenuOpen} onOpenChange={setProjectSwitcherOpen}
            onSelect={selectProject} onAdd={() => void chooseProject()}
            onReveal={() => {
              if (!currentProject?.path) return;
              void fileReveal(currentProject.path).catch((error) => setError(String(error)));
            }}
            drag={{ id: draggedProjectId, suppressClick: suppressProjectClickRef,
              onStart: startProjectDrag, onMove: moveProjectDrag,
              onEnd: finishProjectDrag, onCancel: cancelProjectDrag }}
          />
          <div id="app-chat-actions-portal" style={{ display: "contents" }} />
          {!navigationShell && accountControl}
        </div>
      </header>

      <main className="app-main" data-onboarding-target="workspace">
        <ErrorBoundary
          resetKey={renderedTab}
          fallback={(viewError, reset) => <AppViewFallback copy={copy} error={viewError} reset={reset} language={language} />}
        >
          <div hidden={renderedTab !== "chat" && renderedTab !== "scheduled" && renderedTab !== "tasks"}>
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
                  <CodePane onWorkbenchReadyChange={setCodeWorkbenchReady} />
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
          {figuresMounted && (
            <div className="app-figures-pane" hidden={renderedTab !== "figures"}>
              <Suspense fallback={<AppLoadingPane copy={copy} label={copy.nav.figures} />}><FigureStudio visible={renderedTab === "figures"} /></Suspense>
            </div>
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
