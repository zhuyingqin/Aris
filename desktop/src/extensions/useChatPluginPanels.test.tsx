// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLUGINS_CHANGED_EVENT, pluginsUiList, samePluginProject, type ActiveUiPanel } from "../api/plugins";
import { pluginPageIcon, uiPanelIcon, useChatPluginPanels } from "./useChatPluginPanels";
import { UiListSlot } from "./uiSlots";

vi.mock("../api/plugins", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/plugins")>()),
  pluginsUiList: vi.fn(),
  bridgeBackendPluginChanges: vi.fn(),
}));
vi.mock("../api/transport", () => ({ hasNativeBackend: () => true }));
const panel = (pluginName: string, order = 0): ActiveUiPanel => ({ pluginName, packageDigest: "a", slot: "chat.sidebar", id: "same-panel-id", title: pluginName, order, widgets: [] });
beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

describe("Chat UI slot lifecycle", () => {
  it("names each panel's icon after its first interactive widget", () => {
    expect(uiPanelIcon({ widgets: [{ id: "intro", type: "text", text: "Hi" }, { id: "notes", type: "notes", title: "Notes" }] })).toBe("notebook");
    expect(uiPanelIcon({ widgets: [{ id: "todos", type: "todo-list", title: "Todos" }] })).toBe("list");
    expect(uiPanelIcon({ widgets: [{ id: "plan", type: "agent-plan", title: "Plan" }] })).toBe("target");
    expect(uiPanelIcon({ widgets: [] })).toBe("grid");
  });

  it("retains DSH list ordering, duplicate rejection and idempotent disposal", () => {
    const slot = new UiListSlot<string>("chat.sidebar");
    const dispose = slot.register("chat.sidebar", "first", 5, "a");
    slot.register("chat.sidebar", "second", 0, "b");
    slot.register("chat.sidebar", "third", 5, "c");
    expect(slot.values()).toEqual(["b", "a", "c"]);
    expect(() => slot.register("chat.sidebar", "first", 2, "duplicate")).toThrow();
    expect(() => slot.register("chat.replace", "x", 1, "x")).toThrow();
    dispose(); dispose();
    expect(slot.values()).toEqual(["b", "c"]);
  });

  it("namespaces contributions, unloads after disable and reloads on focus", async () => {
    vi.mocked(pluginsUiList).mockResolvedValue([panel("first", 5), panel("second", 1)]);
    const { result } = renderHook(() => useChatPluginPanels("F:/project"));
    await waitFor(() => expect(result.current.panels.map((p) => p.pluginName)).toEqual(["second", "first"]));
    vi.mocked(pluginsUiList).mockResolvedValue([panel("second")]);
    act(() => window.dispatchEvent(new CustomEvent(PLUGINS_CHANGED_EVENT, { detail: "F:/project" })));
    await waitFor(() => expect(result.current.panels).toHaveLength(1));
    vi.mocked(pluginsUiList).mockResolvedValue([]);
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(result.current.panels).toHaveLength(0));
  });

  it("does not expose old project results or accept an out-of-order refresh", async () => {
    let resolveOld!: (panels: ActiveUiPanel[]) => void;
    vi.mocked(pluginsUiList).mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; })).mockResolvedValue([]);
    const { result, rerender } = renderHook(({ path }) => useChatPluginPanels(path), { initialProps: { path: "F:/project" } });
    rerender({ path: "F:/other" });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(async () => resolveOld([panel("old")]));
    expect(result.current.panels).toEqual([]);
    expect(result.current.error).toBe("");
  });

  it("refreshes when the backend names the same project in its canonical spelling", async () => {
    vi.mocked(pluginsUiList).mockResolvedValue([]);
    const { result } = renderHook(() => useChatPluginPanels("F:/project"));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    vi.mocked(pluginsUiList).mockResolvedValue([panel("approved")]);
    act(() => window.dispatchEvent(new CustomEvent(PLUGINS_CHANGED_EVENT, { detail: "F:/other" })));
    act(() => window.dispatchEvent(new CustomEvent(PLUGINS_CHANGED_EVENT, { detail: String.raw`\\?\F:\Project` })));
    await waitFor(() => expect(result.current.panels.map((p) => p.pluginName)).toEqual(["approved"]));
    expect(pluginsUiList).toHaveBeenCalledTimes(2);
  });

  it("compares project paths across spellings but not across projects", () => {
    expect(samePluginProject(String.raw`\\?\F:\Agent\proj`, "F:/agent/proj/")).toBe(true);
    expect(samePluginProject("/home/me/proj", "/home/me/Proj")).toBe(false);
    expect(samePluginProject("F:/proj", "F:/proj2")).toBe(false);
    expect(samePluginProject(undefined, "F:/proj")).toBe(false);
  });

  it("keeps sidebar tabs and navigation pages apart, and only draws icons the host owns", async () => {
    const page: ActiveUiPanel = { ...panel("board"), slot: "nav.page", id: "page", scope: "project", icon: "barChart" };
    vi.mocked(pluginsUiList).mockResolvedValue([panel("side"), page]);
    const side = renderHook(() => useChatPluginPanels("F:/project"));
    const pages = renderHook(() => useChatPluginPanels("F:/project", "nav.page"));
    await waitFor(() => expect(side.result.current.panels.map((p) => p.pluginName)).toEqual(["side"]));
    await waitFor(() => expect(pages.result.current.panels.map((p) => p.pluginName)).toEqual(["board"]));
    expect(side.result.current.error).toBe("");
    expect(pluginPageIcon(page)).toBe("barChart");
    // A name outside the list falls back to the widget's own icon.
    expect(pluginPageIcon({ icon: "../../logo.svg", widgets: [{ id: "n", type: "notes", title: "N" }] })).toBe("notebook");
    expect(pluginPageIcon({ icon: "openai", widgets: [] })).toBe("grid");
  });
});
