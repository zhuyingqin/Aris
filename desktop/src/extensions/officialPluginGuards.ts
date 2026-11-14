// What official plugins contribute to the app shell besides navigation: the
// `guards` contribution (unsaved work and running jobs that must stop a project
// switch or a window close) and their background watchers. The shell asks this
// module; it no longer knows which module has drafts or long runs.
import { figuresRunningCount, onFigureUpdated } from "../figures/figureApi";
import type { FigureView } from "../figures/types";
import { useStore, type Language } from "../store";

/**
 * A request that may have spent the account's credit has finished. Account
 * views refresh on it instead of listening to each module's own events.
 */
export const BILLED_REQUEST_FINISHED_EVENT = "somniq:billed-request-finished";

let runningFigureJobs = 0;

/** A finished figure run that made at least one model request was billed. */
export function figureRunWasBilled(view: Pick<FigureView, "active" | "run">): boolean {
  return !view.active && view.run.requests.some((request) => request.finishedAt);
}

/** Start the official plugins' background watchers; returns the stop function. */
export function startOfficialPluginWatchers(): () => void {
  let disposed = false;
  let unlisten: (() => void) | null = null;
  void figuresRunningCount().then((count) => { if (!disposed) runningFigureJobs = count; }).catch(() => undefined);
  void onFigureUpdated((view) => {
    if (disposed) return;
    runningFigureJobs = view.activeCount ?? 0;
    if (figureRunWasBilled(view)) window.dispatchEvent(new Event(BILLED_REQUEST_FINISHED_EVENT));
  }).then((stop) => { if (disposed) stop(); else unlisten = stop; }).catch(() => undefined);
  return () => {
    disposed = true;
    unlisten?.();
  };
}

/** Why the current project cannot be left right now, or null. */
export function projectSwitchBlocker(language: Language): string | null {
  if (useStore.getState().figureDirty) {
    return language === "cn"
      ? "请等待科研绘图草稿保存完成，或放弃编辑，再切换项目。"
      : "Wait for figure draft autosave or discard edits before switching projects.";
  }
  return null;
}

/** Unsaved work an official plugin holds (the browser's beforeunload guard). */
export function officialPluginsHaveUnsavedWork(): boolean {
  return useStore.getState().figureDirty;
}

/** The official plugins' part of the window-close hazards. */
export function officialPluginCloseHazards() {
  return {
    hasUnsavedFigureChanges: useStore.getState().figureDirty,
    runningFigureCount: runningFigureJobs,
  };
}
