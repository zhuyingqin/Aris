import { create } from "zustand";
import type { DesktopProject } from "./types";
import {
  isTauri,
  onProjectChanged,
  projectAdd,
  projectsGet,
  projectsReorder,
  projectSetCurrent,
  stateDir as fetchStateDir,
} from "./api/tauri";
import { isLabPreviewMode, isTypesetPreviewMode } from "./api/labPreview";

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

interface AppState {
  tab: Tab;
  setTab: (tab: Tab) => void;

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

  stateDir: string;
  error: string | null;
  projects: DesktopProject[];
  currentProject: DesktopProject | null;
  projectBusy: boolean;

  setError: (message: string | null) => void;
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
  tab: isTypesetPreviewMode() ? "typeset" : isLabPreviewMode() ? "lab" : "chat",
  setTab: (tab) => set({ tab }),

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

  stateDir: "",
  error: null,
  projects: [],
  currentProject: null,
  projectBusy: false,

  setError: (message) => set({ error: message }),
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
      set({ error: String(error) });
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
      set({ error: String(error) });
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
        error: String(error),
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
      .catch((error) => set({ error: String(error) }));

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
          if (!disposed) set({ error: String(error) });
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
