import { create } from "zustand";
import type { DesktopProject, RunEvent, TeamSnapshot, WorkflowRun } from "./types";
import {
  isTauri,
  onRunEvent,
  projectAdd,
  projectsGet,
  projectsReorder,
  projectSetCurrent,
  stateDir as fetchStateDir,
  teamList,
  workflowList,
} from "./api/tauri";

const MAX_EVENTS = 500;
const PREVIEW_PROJECT: DesktopProject = {
  id: "default",
  name: "ARIS Desktop Workspace",
  path: "browser preview",
  addedAt: 0,
  lastOpenedAt: 0,
};

export type Tab =
  | "chat"
  | "studio"
  | "monitor"
  | "teams"
  | "settings"
  | "skills"
  | "sessions";

interface AppState {
  tab: Tab;
  setTab: (tab: Tab) => void;

  stateDir: string;
  runs: WorkflowRun[];
  selectedRunId: string | null;
  team: TeamSnapshot | null;
  events: RunEvent[];
  error: string | null;
  projects: DesktopProject[];
  currentProject: DesktopProject | null;
  projectBusy: boolean;

  selectRun: (id: string | null) => void;
  refreshRuns: () => Promise<void>;
  refreshTeam: () => Promise<void>;
  setError: (message: string | null) => void;
  addProject: (path: string) => Promise<void>;
  switchProject: (id: string) => Promise<void>;
  reorderProjects: (ids: string[]) => Promise<void>;

  /** Wire up live events + periodic polling. Returns a teardown fn. */
  init: () => () => void;
}

export const useStore = create<AppState>((set, get) => ({
  tab: "chat",
  setTab: (tab) => set({ tab }),

  stateDir: "",
  runs: [],
  selectedRunId: null,
  team: null,
  events: [],
  error: null,
  projects: [],
  currentProject: null,
  projectBusy: false,

  selectRun: (id) => set({ selectedRunId: id }),
  setError: (message) => set({ error: message }),
  addProject: async (path) => {
    set({ projectBusy: true, error: null });
    try {
      const view = await projectAdd(path);
      set({
        projects: view.projects,
        currentProject: view.currentProject,
        runs: [],
        selectedRunId: null,
        team: null,
        events: [],
      });
      set({ stateDir: await fetchStateDir() });
      await Promise.all([get().refreshRuns(), get().refreshTeam()]);
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
        runs: [],
        selectedRunId: null,
        team: null,
        events: [],
      });
      set({ stateDir: await fetchStateDir() });
      await Promise.all([get().refreshRuns(), get().refreshTeam()]);
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

  refreshRuns: async () => {
    try {
      const out = await workflowList();
      set((s) => {
        const runs = out.runs ?? [];
        const stillExists = runs.some((r) => r.runId === s.selectedRunId);
        return {
          runs,
          selectedRunId: stillExists
            ? s.selectedRunId
            : (runs[0]?.runId ?? null),
        };
      });
    } catch (err) {
      set({ error: String(err) });
    }
  },

  refreshTeam: async () => {
    try {
      const snapshot = await teamList(null, true, true);
      set({ team: snapshot });
    } catch (err) {
      // A missing team is not an error worth surfacing loudly.
      set({ team: null });
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

    let disposed = false;
    let unlisten: (() => void) | null = null;
    let refreshTimer: number | null = null;
    let refreshInFlight = false;
    let refreshQueued = false;
    const runRefresh = async () => {
      if (disposed) return;
      if (refreshInFlight) {
        refreshQueued = true;
        return;
      }
      refreshInFlight = true;
      await Promise.all([get().refreshRuns(), get().refreshTeam()]);
      refreshInFlight = false;
      if (refreshQueued) {
        refreshQueued = false;
        scheduleRefresh();
      }
    };
    const scheduleRefresh = () => {
      if (disposed) return;
      refreshQueued = true;
      if (refreshTimer !== null || refreshInFlight) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        refreshQueued = false;
        void runRefresh();
      }, 120);
    };

    fetchStateDir()
      .then((dir) => set({ stateDir: dir }))
      .catch(() => undefined);
    projectsGet()
      .then((view) => set({ projects: view.projects, currentProject: view.currentProject }))
      .catch((error) => set({ error: String(error) }));

    onRunEvent((event) => {
      set((s) => ({
        events: [...s.events, event].slice(-MAX_EVENTS),
      }));
      // Coalesce bursts while keeping the event timeline live.
      scheduleRefresh();
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    void runRefresh();
    const poll = window.setInterval(() => {
      scheduleRefresh();
    }, 3000);

    return () => {
      disposed = true;
      if (unlisten) unlisten();
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      window.clearInterval(poll);
    };
  },
}));
