import { create } from "zustand";
import { setTheme as setNativeAppTheme } from "@tauri-apps/api/app";
import type { ChatAttachment, ChatTurn, DesktopProject } from "./types";
import {
  configGet,
  configSet,
  isTauri,
  newapiBootstrap,
  newapiLogin,
  newapiLogout,
  newapiRegister,
  onProjectChanged,
  projectAdd,
  projectRemove,
  projectsGet,
  projectsReorder,
  projectSetCurrent,
  stateDir as fetchStateDir,
  type NewApiLoginResult,
} from "./api/tauri";
import { isTypesetPreviewMode } from "./api/browserPreview";
import { AUTH_SESSION_EXPIRED_NEEDLES, AUTH_TOKEN_INVALID_NEEDLES, formatUserFacingError } from "./errorMessage";
import { ACCOUNT_CACHE_KEY, ACCOUNT_LEGACY_CACHE_KEY, clearCachedUsageLogPages } from "./accountCache";
import { isMacOS } from "./platform";
import { MANAGED_NEWAPI_BASE_URL, approvedManagedNewApiBaseUrl } from "./managedNewApi";
import {
  applyUiTypography,
  currentRecommendedUiFontSize,
  normalizeUiFontSize,
  parseUiTypographyPreference,
  readUiTypographyPreference,
  saveUiTypographyPreference,
  type UiFontMode,
} from "./uiTypography";
import { applyUiColor, parseUiColor, readUiColor, saveUiColor, type UiColor } from "./uiColors";

const PREVIEW_PROJECT: DesktopProject = {
  id: "default",
  name: "SomniQ Desktop Workspace",
  path: "browser preview",
  addedAt: 0,
  lastOpenedAt: 0,
};

export type Tab =
  | "chat"
  | "lab"
  | "typeset"
  | "figures"
  | "literature"
  | "workflows"
  | "mail"
  | "tasks"
  | "extensions"
  | "settings"
  | "scheduled";

export type Theme = "dark" | "light";
export type ThemeMode = Theme | "system";
export type Language = "cn" | "en";

type PreferenceOptions = { requirePersistence?: boolean };

/** One-shot request to inspect a cited local-PDF source beside Chat. */
export interface SidePanelEvidenceTarget {
  path: string;
  paperId: string;
  page: number;
  citation: string;
  quotes: string[];
  requestKey: string;
}

/** Reviewable handoff from a structured product surface into Chat.
 * `conversationKey` lets repeated handoffs return to the same durable session
 * instead of leaking workflow context into whichever chat happened to be open. */
export interface PendingChatHandoff {
  projectId: string;
  conversationKey: string;
  /** Stable runtime/UI session owned by the structured workflow. */
  sessionId?: string;
  /** Rust ledger run that owns this conversation. */
  workflowRunId?: string;
  title: string;
  /** @deprecated Legacy factual snapshot; workflow sessions now read the Rust ledger server-side. */
  input: string;
  /** @deprecated Legacy read-only projection; real workflow transcript is replayed instead. */
  projectedTurns?: ChatTurn[];
  /** IDs owned by the projection; user/Agent discussion turns are preserved. */
  projectedTurnIds?: string[];
  /** Optional short prompt offered when the user explicitly opens the session. */
  draft?: string;
  /** Background projections stay in the sidebar without stealing focus. */
  activate?: boolean;
}

/** One-shot request from Review to the embedded Code workbench. */
export interface PendingCodeDiff {
  path: string;
  staged: boolean;
}

/** A bounded Literature-library view opened by another product surface. The
 * canonical papers remain in the shared library; this only scopes the visible
 * table to the records owned by one workflow stage. */
export interface LiteratureLibraryScope {
  projectId: string;
  title: string;
  recordIds: string[];
  workflowRunId?: string;
  searchRunId?: string;
}

const THEME_STORAGE_KEY = "somniq-theme";
const THEME_LEGACY_STORAGE_KEY = "aris-theme";
const LANGUAGE_STORAGE_KEY = "somniq-ui-language";
const LANGUAGE_LEGACY_STORAGE_KEY = "aris-ui-language";

function requestedTheme(): Theme | null {
  if (typeof window !== "undefined") {
    const requested = new URLSearchParams(window.location.search).get("theme");
    if (requested === "light" || requested === "dark") return requested;
  }
  return null;
}

function readStoredThemePreference(): ThemeMode | null {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY) ?? localStorage.getItem(THEME_LEGACY_STORAGE_KEY);
    return stored === "light" || stored === "dark" || stored === "system" ? stored : null;
  } catch {
    return null;
  }
}

function persistPreference(key: string, value: string, required = false) {
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    if (required) throw error;
  }
}

function applyTheme(theme: Theme, persist = true, required = false, nativeTheme: Theme | null = theme) {
  if (persist) persistPreference(THEME_STORAGE_KEY, theme, required);
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = theme;
  }
  // Keep the native macOS title bar in the same theme as the web UI. Tauri's
  // app-level theme also covers the companion window; the browser preview has
  // no native chrome, so it remains unaffected by this guarded call.
  if (isTauri() && isMacOS()) {
    void setNativeAppTheme(nativeTheme).catch(() => undefined);
  }
  if (!persist) return;
  try {
    localStorage.removeItem(THEME_LEGACY_STORAGE_KEY);
  } catch {
    // Private mode / storage disabled — theme still applies for this session.
  }
}

function normalizeLanguage(value: string | null | undefined): Language {
  return value === "cn" ? "cn" : "en";
}

function readStoredLanguage(): Language | null {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY) ?? localStorage.getItem(LANGUAGE_LEGACY_STORAGE_KEY);
    return stored === "cn" || stored === "en" ? stored : null;
  } catch {
    return null;
  }
}

function reflectLanguage(language: Language) {
  if (typeof document !== "undefined") {
    document.documentElement.lang = language === "cn" ? "zh-CN" : "en";
    document.documentElement.dataset.language = language;
  }
}

function reflectPlatform() {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.platform = isMacOS() ? "macos" : "other";
  }
}

function applyLanguage(language: Language, required = false) {
  persistPreference(LANGUAGE_STORAGE_KEY, language, required);
  reflectLanguage(language);
  try {
    localStorage.removeItem(LANGUAGE_LEGACY_STORAGE_KEY);
  } catch {
    // Storage may be unavailable; the current render still uses the in-memory value.
  }
}

const HIDE_MAIL_STORAGE_KEY = "somniq-hide-mail";
const HIDE_WORKFLOWS_STORAGE_KEY = "somniq-hide-workflows";

function readStoredHideMail(): boolean {
  try {
    const stored = localStorage.getItem(HIDE_MAIL_STORAGE_KEY);
    // New profiles keep optional modules out of the primary navigation until
    // the user explicitly enables them. Preserve an explicit "false" choice.
    return stored == null ? true : stored === "true";
  } catch {
    return true;
  }
}

function applyHideMail(hide: boolean) {
  try {
    // Store both choices so selecting Visible remains persistent even though
    // the default for a brand-new profile is Hidden.
    localStorage.setItem(HIDE_MAIL_STORAGE_KEY, String(hide));
  } catch {
    // Storage may be unavailable
  }
}

function readStoredHideWorkflows(): boolean {
  try {
    const stored = localStorage.getItem(HIDE_WORKFLOWS_STORAGE_KEY);
    return stored == null ? true : stored === "true";
  } catch {
    return true;
  }
}

function applyHideWorkflows(hide: boolean) {
  try {
    localStorage.setItem(HIDE_WORKFLOWS_STORAGE_KEY, String(hide));
  } catch {
    // Storage may be unavailable
  }
}

// Desktop account login is intentionally separate from remote-device pairing.
// The former selects the user's NewAPI executor; the latter uses a QR-issued
// device credential and must never consume this account token.
const AUTH_FLAG_KEY = "somniq-auth-v1";
const AUTH_LEGACY_FLAG_KEY = "aris-auth-v1";
const AUTH_SERVER_KEY = "somniq-auth-server-v1";
const AUTH_LEGACY_SERVER_KEY = "aris-auth-server-v1";
export const DEFAULT_AUTH_SERVER = MANAGED_NEWAPI_BASE_URL;
const DEFAULT_MODEL = "MiniMax-M3";

export function isManagedAuthInvalidError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  return (
    AUTH_SESSION_EXPIRED_NEEDLES.some((needle) => lower.includes(needle)) ||
    AUTH_TOKEN_INVALID_NEEDLES.some((needle) => lower.includes(needle)) ||
    lower.includes("401 unauthorized") ||
    (lower.includes("unauthorized") && lower.includes("token"))
  );
}

function readStoredServer(): string {
  try {
    const stored = localStorage.getItem(AUTH_SERVER_KEY)
      ?? localStorage.getItem(AUTH_LEGACY_SERVER_KEY);
    // Previous releases saved a public HTTP address. Keep its credentials
    // dormant until the user signs in again through a verified HTTPS host.
    return stored ? approvedManagedNewApiBaseUrl(stored) || DEFAULT_AUTH_SERVER : DEFAULT_AUTH_SERVER;
  } catch {
    return DEFAULT_AUTH_SERVER;
  }
}

function initialAuthed(): boolean {
  if (!isTauri()) return true;
  try {
    const stored = localStorage.getItem(AUTH_SERVER_KEY)
      ?? localStorage.getItem(AUTH_LEGACY_SERVER_KEY);
    return !!stored && !!approvedManagedNewApiBaseUrl(stored)
      && (localStorage.getItem(AUTH_FLAG_KEY) ?? localStorage.getItem(AUTH_LEGACY_FLAG_KEY)) === "1";
  } catch {
    return false;
  }
}

async function persistManagedAuthResult(result: NewApiLoginResult, language: Language) {
  await configSet({
    executorProvider: "openai",
    executorModel: result.model,
    executorBaseUrl: result.baseUrl,
    executorApiKey: result.token,
    language,
  });
}

function markAuthed(server: string) {
  try {
    localStorage.setItem(AUTH_FLAG_KEY, "1");
    localStorage.setItem(AUTH_SERVER_KEY, server);
    localStorage.removeItem(AUTH_LEGACY_FLAG_KEY);
    localStorage.removeItem(AUTH_LEGACY_SERVER_KEY);
  } catch {
    // Storage disabled: the in-memory session remains authenticated.
  }
}

function rememberAuthServer(server: string) {
  try {
    localStorage.setItem(AUTH_SERVER_KEY, server);
    localStorage.removeItem(AUTH_LEGACY_SERVER_KEY);
  } catch {
    // Ignore unavailable browser storage.
  }
}

function clearStoredAuth() {
  // In-memory caches first: they outlive the signed-out session otherwise.
  clearCachedUsageLogPages();
  try {
    localStorage.removeItem(AUTH_FLAG_KEY);
    localStorage.removeItem(AUTH_LEGACY_FLAG_KEY);
    localStorage.removeItem(ACCOUNT_CACHE_KEY);
    localStorage.removeItem(ACCOUNT_LEGACY_CACHE_KEY);
  } catch {
    // Ignore unavailable browser storage.
  }
}

interface AppState {
  /** True once the desktop user has signed in, or in browser preview. */
  authed: boolean;
  /** Last-used NewAPI endpoint shown by the desktop login form. */
  authServer: string;
  login: (server: string, username: string, password: string, twoFactorCode?: string) => Promise<void>;
  validateAuth: () => Promise<boolean>;
  register: (
    server: string,
    username: string,
    password: string,
    options?: { email?: string; verificationCode?: string; affCode?: string; turnstile?: string },
  ) => Promise<void>;
  logout: () => void;

  tab: Tab;
  setTab: (tab: Tab) => void;

  pendingCodeDiff: PendingCodeDiff | null;
  setPendingCodeDiff: (value: PendingCodeDiff | null) => void;
  /** File requested before the embedded editor is connected and ready. */
  pendingCodeFilePath: string | null;
  setPendingCodeFilePath: (path: string | null) => void;

  /** True while the LaTeX editor contains changes not persisted to disk. */
  typesetDirty: boolean;
  setTypesetDirty: (dirty: boolean) => void;
  figureDirty: boolean;
  setFigureDirty: (dirty: boolean) => void;

  theme: Theme;
  /** False only on a fresh profile that still needs the first-run choice. */
  themePreferenceSet: boolean;
  themeMode: ThemeMode;
  setTheme: (theme: ThemeMode, options?: PreferenceOptions) => void;
  syncTheme: (stored: string | null) => void;

  uiColor: UiColor;
  setUiColor: (color: UiColor, options?: PreferenceOptions) => void;
  syncUiColor: (storedValue: string | null) => void;

  uiFontMode: UiFontMode;
  /** Remember the user's custom size when switching back to automatic mode. */
  uiFontSize: number;
  uiRecommendedFontSize: number;
  setUiFontMode: (mode: UiFontMode, options?: PreferenceOptions) => void;
  setUiFontSize: (fontSize: number, options?: PreferenceOptions) => void;
  refreshUiTypography: () => void;
  syncUiTypography: (storedValue: string | null) => void;

  language: Language;
  /** False only on a fresh profile that still needs the first-run choice. */
  languagePreferenceSet: boolean;
  setLanguage: (language: Language, options?: PreferenceOptions & { syncRuntime?: boolean }) => void;

  /** When true, Mail is hidden from the primary navigation and switcher. */
  hideMail: boolean;
  setHideMail: (hide: boolean, options?: PreferenceOptions) => void;

  /** When true, Workflows is hidden from the primary navigation and switcher. */
  hideWorkflows: boolean;
  setHideWorkflows: (hide: boolean, options?: PreferenceOptions) => void;

  /** One-shot composer prefill consumed by Chat (e.g. Literature → /arxiv). */
  pendingChatInput: string | null;
  setPendingChatInput: (value: string | null) => void;

  /** Attachments queued for the composer from outside Chat — currently the
   * global-hotkey region screenshot, which can land while any tab is open. */
  pendingChatAttachments: ChatAttachment[];
  addPendingChatAttachment: (attachment: ChatAttachment) => void;
  clearPendingChatAttachments: () => void;

  /** Context-rich handoff that opens or reuses a purpose-bound Chat session. */
  pendingChatHandoff: PendingChatHandoff | null;
  setPendingChatHandoff: (value: PendingChatHandoff | null) => void;

  /** One-shot command handoff consumed and executed by Chat. */
  pendingChatRunInput: string | null;
  setPendingChatRunInput: (value: string | null) => void;

  literatureLibraryScope: LiteratureLibraryScope | null;
  setLiteratureLibraryScope: (value: LiteratureLibraryScope | null) => void;

  /** One-shot file-open request consumed by the LaTeX page after it mounts. */
  pendingTypesetFilePath: string | null;
  setPendingTypesetFilePath: (value: string | null) => void;

  /**
   * One-shot request to read a file in Chat's side panel, consumed by Chat.
   * PDFs and other read-only material stay beside the conversation instead of
   * taking over a workspace tab.
   */
  pendingSidePanelFilePath: string | null;
  setPendingSidePanelFilePath: (value: string | null) => void;

  /** One-shot citation navigation request consumed by Chat's PDF side panel. */
  pendingSidePanelEvidence: SidePanelEvidenceTarget | null;
  setPendingSidePanelEvidence: (value: SidePanelEvidenceTarget | null) => void;

  /**
   * Chat's session sidebar has two layouts, so it takes two flags. Both live
   * here rather than inside Chat because the window titlebar owns the toggle,
   * and the titlebar is a sibling of Chat, not an ancestor.
   *
   * `chatSidebarOpen` drives the narrow-window overlay (hidden by default);
   * `chatSidebarCollapsed` hides the wide-window docked column (shown by
   * default). The titlebar picks whichever one the current width uses.
   */
  chatSidebarOpen: boolean;
  setChatSidebarOpen: (open: boolean) => void;
  chatSidebarCollapsed: boolean;
  setChatSidebarCollapsed: (collapsed: boolean) => void;

  stateDir: string;
  error: string | null;
  projects: DesktopProject[];
  currentProject: DesktopProject | null;
  projectBusy: boolean;

  setError: (message: unknown | null) => void;
  addProject: (path: string) => Promise<void>;
  removeProject: (id: string) => Promise<void>;
  switchProject: (id: string) => Promise<void>;
  reorderProjects: (ids: string[]) => Promise<void>;

  /** Wire up live events + periodic polling. Returns a teardown fn. */
  init: () => () => void;
}

const storedThemePreference = readStoredThemePreference();
function resolvedTheme(mode: ThemeMode): Theme {
  return mode === "system" ? (typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light") : mode;
}
const initialThemeMode = requestedTheme() ?? storedThemePreference ?? "dark";
const initialTheme = resolvedTheme(initialThemeMode);
const storedLanguage = readStoredLanguage();
const initialLanguage = storedLanguage ?? "en";
const initialTypography = readUiTypographyPreference();
const initialUiColor = readUiColor();
const initialRecommendedFontSize = currentRecommendedUiFontSize();
// A default preview must not count as a first-run choice. The preference is
// written only after the user explicitly selects a theme.
reflectPlatform();
applyTheme(initialTheme, false, false, initialThemeMode === "system" ? null : initialTheme);
applyUiTypography(initialTypography, initialRecommendedFontSize);
applyUiColor(initialUiColor);
if (storedLanguage) {
  // Migrate the legacy key while preserving an explicit prior choice.
  applyLanguage(storedLanguage);
} else {
  // English is the non-persistent first-run default. Only a user choice should
  // suppress the language screen on the next launch.
  reflectLanguage(initialLanguage);
}

export const useStore = create<AppState>((set, get) => ({
  authed: initialAuthed(),
  authServer: readStoredServer(),
  login: async (server, username, password, twoFactorCode) => {
    const trimmedServer = approvedManagedNewApiBaseUrl(server.trim() || DEFAULT_AUTH_SERVER);
    if (!trimmedServer) throw new Error("请配置有效的 HTTPS 账号服务器地址");
    const config = await configGet();
    const model = config.executorModel?.trim() || DEFAULT_MODEL;
    const result = await newapiLogin(trimmedServer, model, username, password, twoFactorCode);
    await persistManagedAuthResult(result, get().language);
    markAuthed(trimmedServer);
    set({ authed: true, authServer: trimmedServer });
  },
  validateAuth: async () => {
    if (!isTauri() || !get().authed) return true;
    try {
      await newapiBootstrap();
      return true;
    } catch (error) {
      if (isManagedAuthInvalidError(error)) {
        get().logout();
        return false;
      }
      return true;
    }
  },
  register: async (server, username, password, options = {}) => {
    const trimmedServer = approvedManagedNewApiBaseUrl(server.trim() || DEFAULT_AUTH_SERVER);
    if (!trimmedServer) throw new Error("请配置有效的 HTTPS 账号服务器地址");
    await newapiRegister({
      baseUrl: trimmedServer,
      username,
      password,
      email: options.email,
      verificationCode: options.verificationCode,
      affCode: options.affCode,
      turnstile: options.turnstile,
    });
    rememberAuthServer(trimmedServer);
    set({ authServer: trimmedServer });
  },
  logout: () => {
    clearStoredAuth();
    if (isTauri()) {
      void newapiLogout().catch(() => undefined);
    }
    set({ authed: false, pendingCodeFilePath: null });
  },

  tab: (() => {
    if (typeof window !== "undefined") {
      try {
        const params = new URLSearchParams(window.location.search);
        const tab = params.get("tab");
        if (tab && ["chat", "lab", "typeset", "literature", "workflows", "mail", "tasks", "extensions", "settings", "scheduled"].includes(tab)) {
          return tab as Tab;
        }
      } catch {}
    }
    return isTypesetPreviewMode() ? "typeset" : "chat";
  })(),
  setTab: (tab) => set({ tab }),
  pendingCodeDiff: null,
  setPendingCodeDiff: (value) => set({ pendingCodeDiff: value }),
  pendingCodeFilePath: null,
  setPendingCodeFilePath: (pendingCodeFilePath) => set({ pendingCodeFilePath }),
  typesetDirty: false,
  setTypesetDirty: (typesetDirty) => set({ typesetDirty }),
  figureDirty: false,
  setFigureDirty: (figureDirty) => set({ figureDirty }),

  theme: initialTheme,
  themeMode: initialThemeMode,
  themePreferenceSet: storedThemePreference !== null,
  setTheme: (themeMode, options) => {
    persistPreference(THEME_STORAGE_KEY, themeMode, options?.requirePersistence);
    const theme = resolvedTheme(themeMode);
    applyTheme(theme, false, false, themeMode === "system" ? null : theme);
    set({ theme, themeMode, themePreferenceSet: true });
  },
  syncTheme: (stored) => {
    const themeMode = stored === "light" || stored === "system" ? stored : "dark";
    const theme = resolvedTheme(themeMode);
    applyTheme(theme, false, false, themeMode === "system" ? null : theme); set({ theme, themeMode });
  },

  uiColor: initialUiColor,
  setUiColor: (color, options) => {
    const next = parseUiColor(color);
    saveUiColor(next, options?.requirePersistence);
    applyUiColor(next);
    set({ uiColor: next });
  },
  syncUiColor: (storedValue) => {
    const next = parseUiColor(storedValue);
    applyUiColor(next);
    set({ uiColor: next });
  },

  uiFontMode: initialTypography.mode,
  uiFontSize: initialTypography.fontSize,
  uiRecommendedFontSize: initialRecommendedFontSize,
  setUiFontMode: (mode, options) => {
    const preference = { mode, fontSize: get().uiFontSize };
    const recommended = currentRecommendedUiFontSize();
    saveUiTypographyPreference(preference, options?.requirePersistence);
    applyUiTypography(preference, recommended);
    set({ uiFontMode: mode, uiRecommendedFontSize: recommended });
  },
  setUiFontSize: (fontSize, options) => {
    const preference = { mode: "manual" as const, fontSize: normalizeUiFontSize(fontSize) };
    const recommended = currentRecommendedUiFontSize();
    saveUiTypographyPreference(preference, options?.requirePersistence);
    applyUiTypography(preference, recommended);
    set({ uiFontMode: "manual", uiFontSize: preference.fontSize, uiRecommendedFontSize: recommended });
  },
  refreshUiTypography: () => {
    const state = get();
    const recommended = currentRecommendedUiFontSize();
    applyUiTypography({ mode: state.uiFontMode, fontSize: state.uiFontSize }, recommended);
    if (recommended !== state.uiRecommendedFontSize) set({ uiRecommendedFontSize: recommended });
  },
  syncUiTypography: (storedValue) => {
    const preference = parseUiTypographyPreference(storedValue);
    const recommended = currentRecommendedUiFontSize();
    applyUiTypography(preference, recommended);
    set({ uiFontMode: preference.mode, uiFontSize: preference.fontSize, uiRecommendedFontSize: recommended });
  },

  language: initialLanguage,
  languagePreferenceSet: storedLanguage !== null,
  setLanguage: (language, options) => {
    const next = normalizeLanguage(language);
    applyLanguage(next, options?.requirePersistence);
    set({ language: next, languagePreferenceSet: true });
    if (isTauri() && options?.syncRuntime !== false) {
      // Keep the model/runtime language aligned with the visible UI choice.
      void configSet({ language: next }).catch(() => undefined);
    }
  },

  hideMail: readStoredHideMail(),
  setHideMail: (hide, options) => {
    if (options?.requirePersistence) persistPreference(HIDE_MAIL_STORAGE_KEY, String(hide), true);
    else applyHideMail(hide);
    set((state) => ({
      hideMail: hide,
      tab: hide && state.tab === "mail" ? "chat" : state.tab,
    }));
  },

  hideWorkflows: readStoredHideWorkflows(),
  setHideWorkflows: (hide, options) => {
    if (options?.requirePersistence) persistPreference(HIDE_WORKFLOWS_STORAGE_KEY, String(hide), true);
    else applyHideWorkflows(hide);
    set((state) => ({
      hideWorkflows: hide,
      tab: hide && state.tab === "workflows" ? "chat" : state.tab,
    }));
  },

  pendingChatInput: null,
  setPendingChatInput: (value) => set({ pendingChatInput: value }),

  pendingChatAttachments: [],
  addPendingChatAttachment: (attachment) =>
    set((state) => ({ pendingChatAttachments: [...state.pendingChatAttachments, attachment] })),
  clearPendingChatAttachments: () => set({ pendingChatAttachments: [] }),

  pendingChatHandoff: null,
  setPendingChatHandoff: (value) => set({ pendingChatHandoff: value }),

  pendingChatRunInput: null,
  setPendingChatRunInput: (value) => set({ pendingChatRunInput: value }),

  literatureLibraryScope: null,
  setLiteratureLibraryScope: (value) => set({ literatureLibraryScope: value }),


  pendingTypesetFilePath: null,
  setPendingTypesetFilePath: (value) => set({ pendingTypesetFilePath: value }),

  pendingSidePanelFilePath: null,
  setPendingSidePanelFilePath: (value) => set({ pendingSidePanelFilePath: value }),

  pendingSidePanelEvidence: null,
  setPendingSidePanelEvidence: (value) => set({ pendingSidePanelEvidence: value }),

  chatSidebarOpen: false,
  setChatSidebarOpen: (open) => set({ chatSidebarOpen: open }),

  chatSidebarCollapsed: false,
  setChatSidebarCollapsed: (collapsed) => set({ chatSidebarCollapsed: collapsed }),

  stateDir: "",
  error: null,
  projects: [],
  currentProject: null,
  projectBusy: false,

  setError: (message) => set({
    error: message == null ? null : formatUserFacingError(message, get().language),
  }),
  addProject: async (path) => {
    set({ projectBusy: true, error: null });
    try {
      const view = await projectAdd(path);
      set({
        projects: view.projects,
        currentProject: view.currentProject,
      });
      set({ stateDir: await fetchStateDir() });
    } catch (error) {
      get().setError(error);
      throw error;
    } finally {
      set({ projectBusy: false });
    }
  },
  removeProject: async (id) => {
    if (id === "default") return;
    set({ projectBusy: true, error: null });
    try {
      const view = await projectRemove(id);
      set({
        projects: view.projects,
        currentProject: view.currentProject,
      });
      set({ stateDir: await fetchStateDir() });
    } catch (error) {
      get().setError(error);
      throw error;
    } finally {
      set({ projectBusy: false });
    }
  },
  switchProject: async (id) => {
    if (id === get().currentProject?.id) return;
    set({ projectBusy: true, error: null });
    try {
      const view = await projectSetCurrent(id);
      set({
        projects: view.projects,
        currentProject: view.currentProject,
      });
      set({ stateDir: await fetchStateDir() });
    } catch (error) {
      get().setError(error);
      throw error;
    } finally {
      set({ projectBusy: false });
    }
  },
  reorderProjects: async (ids) => {
    const previousProjects = get().projects;
    const previousCurrentProject = get().currentProject;
    const uniqueIds = new Set(ids);
    if (
      ids.length !== previousProjects.length ||
      uniqueIds.size !== ids.length ||
      ids.every((id, index) => id === previousProjects[index]?.id)
    ) {
      return;
    }
    const byId = new Map(previousProjects.map((project) => [project.id, project]));
    if (ids.some((id) => !byId.has(id))) return;
    set({
      projects: ids.map((id) => byId.get(id)!),
      projectBusy: true,
      error: null,
    });
    try {
      const view = await projectsReorder(ids);
      set({
        projects: view.projects,
        currentProject: view.currentProject,
      });
    } catch (error) {
      set({
        projects: previousProjects,
        currentProject: previousCurrentProject,
        error: formatUserFacingError(error, get().language),
      });
      throw error;
    } finally {
      set({ projectBusy: false });
    }
  },

  init: () => {
    // Plain-browser preview (no Tauri backend): render the static UI only.
    if (!isTauri()) {
      set({
        stateDir: "browser preview — run `npm run tauri dev` for live data",
        projects: [PREVIEW_PROJECT],
        currentProject: PREVIEW_PROJECT,
      });
      return () => {};
    }

    fetchStateDir()
      .then((dir) => set({ stateDir: dir }))
      .catch(() => undefined);
    projectsGet()
      .then((view) => set({ projects: view.projects, currentProject: view.currentProject }))
      .catch((error) => get().setError(error));

    let disposed = false;
    let unlistenProjectChanged: (() => void) | undefined;
    void onProjectChanged(() => {
      void projectsGet()
        .then((view) => {
          if (!disposed) {
            set({ projects: view.projects, currentProject: view.currentProject });
          }
        })
        .catch((error) => {
          if (!disposed) get().setError(error);
        });
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlistenProjectChanged = unlisten;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlistenProjectChanged?.();
    };
  },
}));
