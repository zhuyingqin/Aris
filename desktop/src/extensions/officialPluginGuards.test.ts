// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { useStore } from "../store";
import type { FigureView } from "../figures/types";

const figureEvents = vi.hoisted(() => ({ handler: null as ((view: FigureView) => void) | null }));
vi.mock("../figures/figureApi", () => ({
  figuresRunningCount: async () => 2,
  onFigureUpdated: async (handler: (view: FigureView) => void) => { figureEvents.handler = handler; return () => undefined; },
}));

import {
  BILLED_REQUEST_FINISHED_EVENT, officialPluginCloseHazards, officialPluginsHaveUnsavedWork,
  projectSwitchBlocker, startOfficialPluginWatchers,
} from "./officialPluginGuards";

afterEach(() => useStore.setState({ figureDirty: false }));

describe("official plugin guards", () => {
  it("block a project switch and a close while a figure draft is unsaved", () => {
    expect(projectSwitchBlocker("en")).toBeNull();
    useStore.setState({ figureDirty: true });
    expect(projectSwitchBlocker("cn")).toContain("科研绘图");
    expect(officialPluginsHaveUnsavedWork()).toBe(true);
    expect(officialPluginCloseHazards().hasUnsavedFigureChanges).toBe(true);
  });

  it("track running figure jobs and announce a billed run", async () => {
    const billed = vi.fn();
    window.addEventListener(BILLED_REQUEST_FINISHED_EVENT, billed);
    const stop = startOfficialPluginWatchers();
    await Promise.resolve();
    await Promise.resolve();
    expect(officialPluginCloseHazards().runningFigureCount).toBe(2);
    figureEvents.handler?.({ active: true, activeCount: 1, run: { requests: [] } } as unknown as FigureView);
    expect(officialPluginCloseHazards().runningFigureCount).toBe(1);
    expect(billed).not.toHaveBeenCalled();
    figureEvents.handler?.({ active: false, activeCount: 0, run: { requests: [{ finishedAt: "2026-11-13T00:00:00Z" }] } } as unknown as FigureView);
    expect(billed).toHaveBeenCalledTimes(1);
    stop();
    window.removeEventListener(BILLED_REQUEST_FINISHED_EVENT, billed);
  });
});
