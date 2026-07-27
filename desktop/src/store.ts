import { create } from "zustand";
import type { DesktopProject } from "./types";
import {
  configSet,
  isTauri,
  newapiBootstrap,
  newapiLogin,
  newapiLogout,
  newapiRegister,
  onProjectChanged,
  projectAdd,
  projectsGet,
  projectsReorder,
  projectSetCurrent,
  stateDir as fetchStateDir,
  type NewApiLoginResult,
} from "./api/tauri";
import { isLabPreviewMode, isTypesetPreviewMode } from "./api/labPreview";
import { formatUserFacingError } from "./errorMessage";

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
  | "literature"
  | "studio"
  | "mail"
  | "extensions"
  | "settings"
  | "scheduled";

export type Theme = "dark" | "light";
export type Language = "cn" | "en";

const THEME_STORAGE_KEY = "somniq-theme";
const THEME_LEGACY_STORAGE_KEY = "aris-theme";
const LANGUAGE_STORAGE_KEY = "somniq-ui-language";
const LANGUAGE_LEGACY_STORAGE_KEY = "aris-ui-language";

function readStoredTheme(): Theme {
  if (typeof window !== "undefined") {
    const requested = new URLSearchParams(window.location.search).get("theme");
    if (requested === "light" || requested === "dark") return requested;
  }
  try {
    return (localStorage.getItem(THEME_STORAGE_KEY) ?? localStorage.getItem(THEME_LEGACY_STORAGE_KEY)) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function applyTheme(theme: Theme) {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = theme;
  }
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
    localStorage.removeItem(THEME_LEGACY_STORAGE_KEY);
  } catch {
    // Private mode / storage disabled — theme still applies for this session.
  }
}

function normalizeLanguage(value: string | null | undefined): Language {
  return value === "en" ? "en" : "cn";
}

function readStoredLanguage(): Language {
  try {
    return normalizeLanguage(localStorage.getItem(LANGUAGE_STORAGE_KEY) ?? localStorage.getItem(LANGUAGE_LEGACY_STORAGE_KEY));
  } catch {
    return "cn";
  }
}

function applyLanguage(language: Language) {
  if (typeof document !== "undefined") {
    document.documentElement.lang = language === "cn" ? "zh-CN" : "en";
    document.documentElement.dataset.language = language;
  }
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    localStorage.removeItem(LANGUAGE_LEGACY_STORAGE_KEY);
  } catch {
    // Storage may be unavailable; the current render still uses the in-memory value.
  }
}

// Desktop account login is intentionally separate from remote-device pairing.
// The former selects the user's NewAPI executor; the latter uses a QR-issued
// device credential and must never consume this account token.
const AUTH_FLAG_KEY = "somniq-auth-v1";
const AUTH_LEGACY_FLAG_KEY = "aris-auth-v1";
const AUTH_SERVER_KEY = "somniq-auth-server-v1";
const AUTH_LEGACY_SERVER_KEY = "aris-auth-server-v1";
const ACCOUNT_CACHE_KEY = "somniq-account-v1";
const ACCOUNT_LEGACY_CACHE_KEY = "aris-account-v1";
export const DEFAULT_AUTH_SERVER = "http://106.53.28.124:18080";
const DEFAULT_MODEL = "MiniMax-M3";

export function isManagedAuthInvalidError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  return (
    lower.includes("login expired") ||
    lower.includes("sign in again") ||
    lower.includes("invalid access token") ||
    lower.includes("invalid token") ||
    lower.includes("401 unauthorized") ||
    (lower.includes("unauthorized") && lower.includes("token"))
  );
}

function readStoredServer(): string {
  try {
    return localStorage.getItem(AUTH_SERVER_KEY)
      ?? localStorage.getItem(AUTH_LEGACY_SERVER_KEY)
      ?? DEFAULT_AUTH_SERVER;
  } catch {
    return DEFAULT_AUTH_SERVER;
  }
}

function initialAuthed(): boolean {
  if (!isTauri()) return true;
  try {
    return (localStorage.getItem(AUTH_FLAG_KEY) ?? localStorage.getItem(AUTH_LEGACY_FLAG_KEY)) === "1";
  } catch {
    return false;
  }
}

async function persistManagedAuthResult(result: NewApiLoginResult) {
  await configSet({
    executorProvider: "openai",
    executorModel: result.model,
    executorBaseUrl: result.baseUrl,
    executorApiKey: result.token,
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
  login: (server: string, username: string, password: string) => Promise<void>;
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

  /** True while the LaTeX editor contains changes not persisted to disk. */
  typesetDirty: boolean;
  setTypesetDirty: (dirty: boolean) => void;

  theme: Theme;
  setTheme: (theme: Theme) => void;

  language: Language;
  setLanguage: (language: Language) => void;

  /** One-shot composer prefill consumed by Chat (e.g. Literature → /arxiv). */
  pendingChatInput: string | null;
  setPendingChatInput: (value: string | null) => void;

  /** One-shot command handoff consumed and executed by Chat. */
  pendingChatRunInput: string | null;
  setPendingChatRunInput: (value: string | null) => void;

  /** One-shot deep link consumed by Studio after switching tabs. */
  pendingStudioArtifactId: string | null;
  setPendingStudioArtifactId: (value: string | null) => void;

  /** One-shot file-open request consumed by the Code page after it mounts. */
  pendingLabFilePath: string | null;
  setPendingLabFilePath: (value: string | null) => void;

  /** One-shot file-open request consumed by the LaTeX page after it mounts. */
  pendingTypesetFilePath: string | null;
  setPendingTypesetFilePath: (value: string | null) => void;

  stateDir: string;
  error: string | null;
  projects: DesktopProject[];
  currentProject: DesktopProject | null;
  projectBusy: boolean;

  setError: (message: unknown | null) => void;
  addProject: (path: string) => Promise<void>;
  switchProject: (id: string) => Promise<void>;
  reorderProjects: (ids: string[]) => Promise<void>;

  /** Wire up live events + periodic polling. Returns a teardown fn. */
  init: () => () => void;
}

const initialTheme = readStoredTheme();
const initialLanguage = readStoredLanguage();
applyTheme(initialTheme);
applyLanguage(initialLanguage);

export const useStore = create<AppState>((set, get) => ({
  authed: initialAuthed(),
  authServer: readStoredServer(),
  login: async (server, username, password) => {
    const trimmedServer = (server.trim() || DEFAULT_AUTH_SERVER).replace(/\/+$/, "");
    if (!trimmedServer) throw new Error("请输入服务器地址");
    const result = await newapiLogin(trimmedServer, DEFAULT_MODEL, username, password);
    await persistManagedAuthResult(result);
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
    const trimmedServer = (server.trim() || DEFAULT_AUTH_SERVER).replace(/\/+$/, "");
    if (!trimmedServer) throw new Error("请输入服务器地址");
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
    set({ authed: false });
  },

  tab: isTypesetPreviewMode() ? "typeset" : isLabPreviewMode() ? "lab" : "chat",
  setTab: (tab) => set({ tab }),
  typesetDirty: false,
  setTypesetDirty: (typesetDirty) => set({ typesetDirty }),

  theme: initialTheme,
  setTheme: (theme) => {
    applyTheme(theme);
    set({ theme });
  },

  language: initialLanguage,
  setLanguage: (language) => {
    const next = normalizeLanguage(language);
    applyLanguage(next);
    set({ language: next });
  },

  pendingChatInput: null,
  setPendingChatInput: (value) => set({ pendingChatInput: value }),

  pendingChatRunInput: null,
  setPendingChatRunInput: (value) => set({ pendingChatRunInput: value }),

  pendingStudioArtifactId: null,
  setPendingStudioArtifactId: (value) => set({ pendingStudioArtifactId: value }),

  pendingLabFilePath: null,
  setPendingLabFilePath: (value) => set({ pendingLabFilePath: value }),

  pendingTypesetFilePath: null,
  setPendingTypesetFilePath: (value) => set({ pendingTypesetFilePath: value }),

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
