import { create } from "zustand";
import type { RunEvent, TeamSnapshot, WorkflowRun } from "./types";
import {
  isTauri,
  onRunEvent,
  stateDir as fetchStateDir,
  teamList,
  workflowList,
} from "./api/tauri";

const MAX_EVENTS = 500;

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

  selectRun: (id: string | null) => void;
  refreshRuns: () => Promise<void>;
  refreshTeam: () => Promise<void>;
  setError: (message: string | null) => void;

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

  selectRun: (id) => set({ selectedRunId: id }),
  setError: (message) => set({ error: message }),

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
      set({ stateDir: "browser preview — run `npm run tauri dev` for live data" });
      return () => {};
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;

    fetchStateDir()
      .then((dir) => set({ stateDir: dir }))
      .catch(() => undefined);

    onRunEvent((event) => {
      set((s) => ({
        events: [...s.events, event].slice(-MAX_EVENTS),
      }));
      // An incoming event almost always means run/team state moved.
      void get().refreshRuns();
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    void get().refreshRuns();
    void get().refreshTeam();
    const poll = window.setInterval(() => {
      void get().refreshRuns();
      void get().refreshTeam();
    }, 3000);

    return () => {
      disposed = true;
      if (unlisten) unlisten();
      window.clearInterval(poll);
    };
  },
}));
