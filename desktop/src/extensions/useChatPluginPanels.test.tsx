// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLUGINS_CHANGED_EVENT, pluginsUiList, type ActiveUiPanel } from "../api/plugins";
import { useChatPluginPanels } from "./useChatPluginPanels";
import { UiListSlot } from "./uiSlots";

vi.mock("../api/plugins", () => ({ PLUGINS_CHANGED_EVENT: "somniq:plugins-changed", pluginsUiList: vi.fn() }));
vi.mock("../api/transport", () => ({ hasNativeBackend: () => true }));
const panel = (pluginName: string, order = 0): ActiveUiPanel => ({ pluginName, packageDigest: "a", slot: "chat.sidebar", id: "same-panel-id", title: pluginName, order, widgets: [] });
beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

describe("Chat UI slot lifecycle", () => {
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
});
