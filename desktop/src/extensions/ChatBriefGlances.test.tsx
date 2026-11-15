// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/plugins";
import ChatBriefGlancesView from "./ChatBriefGlances";
import { PLUGIN_OPEN_PAGE_EVENT, uiPanelKey, useChatPluginPanels } from "./useChatPluginPanels";

/** As Chat mounts it: the project's glances, listed by the shared hook. */
function ChatBriefGlances(props: { projectPath: string; language: "en" | "cn"; onPrompt: () => void; onOpenFile: () => void }) {
  const { panels, all } = useChatPluginPanels(props.projectPath, "chat.brief");
  return panels.length ? <ChatBriefGlancesView {...props} panels={panels} all={all} /> : null;
}

vi.mock("../api/plugins", async (original) => ({
  ...(await original<typeof import("../api/plugins")>()),
  pluginsUiList: vi.fn(), pluginsUiPage: vi.fn(), pluginsUiStateGet: vi.fn(), pluginsUiStateUpdate: vi.fn(), bridgeBackendPluginChanges: vi.fn(),
}));
vi.mock("../api/transport", () => ({ hasNativeBackend: () => true }));
vi.mock("../api/tauri", () => ({ openExternalUrl: vi.fn() }));
vi.mock("../chat/MarkdownContent", () => ({ default: ({ text }: { text: string }) => <div>{text}</div> }));

const plugin = "@local/project-tasks";
const page: api.ActiveUiPanel = {
  pluginName: plugin, packageDigest: "d1", id: "tasks", slot: "nav.page", order: 10, scope: "project", icon: "check",
  title: { en: "Tasks", cn: "任务" }, page: "./todo/index.html", widgets: [{ id: "tasks", type: "json", title: "Tasks" }],
};
const glance: api.ActiveUiPanel = {
  pluginName: plugin, packageDigest: "d1", id: "glance", slot: "chat.brief", order: 10, scope: "project",
  title: { en: "Tasks glance", cn: "任务" }, page: "./todo/glance.html", dataPanel: "tasks", widgets: [],
};
const state = (revision: number, tasks: unknown): api.UiPanelState => ({ revision, todoLists: {}, notes: {}, data: { tasks } });
const channel = "glan-glan-glan-glan-glan";

describe("glances in the project summary", () => {
  const pageWindow = { postMessage: vi.fn() };
  const deliver = async (data: Record<string, unknown>) => {
    const event = new MessageEvent("message", { data: { channel, ...data } });
    Object.defineProperty(event, "source", { value: pageWindow });
    await act(async () => { window.dispatchEvent(event); await Promise.resolve(); });
  };
  const mount = async () => {
    render(<ChatBriefGlances projectPath="F:/project" language="en" onPrompt={vi.fn()} onOpenFile={vi.fn()} />);
    const shell = await screen.findByTitle("Tasks glance") as HTMLIFrameElement;
    Object.defineProperty(shell, "contentWindow", { value: { 0: pageWindow } });
    return shell;
  };

  beforeEach(() => {
    vi.resetAllMocks();
    localStorage.clear();
    vi.spyOn(crypto, "randomUUID").mockReturnValue(channel);
    vi.mocked(api.pluginsUiList).mockResolvedValue([page, glance]);
    vi.mocked(api.pluginsUiPage).mockResolvedValue({ html: "<p>glance</p>", path: "todo/glance.html", assets: {}, packageDigest: "d1" });
    vi.mocked(api.pluginsUiStateGet).mockResolvedValue(state(2, [{ id: "a", title: "Draft intro" }]));
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("draws only chat.brief panels, with the page panel's data", async () => {
    const shell = await mount();
    // Only the glance: the full page lives in the rail.
    expect(screen.getAllByRole("region")).toHaveLength(1);
    expect(api.pluginsUiPage).toHaveBeenCalledWith("F:/project", plugin, "glance");
    expect(api.pluginsUiStateGet).toHaveBeenCalledWith("F:/project", plugin, "tasks", "");
    expect(new DOMParser().parseFromString(shell.getAttribute("srcdoc")!, "text/html").querySelector("iframe")!.getAttribute("srcdoc"))
      .toContain(JSON.stringify({ tasks: [{ id: "a", title: "Draft intro" }] }));
  });

  it("saves into the shared store and tells every other view, but not itself", async () => {
    await mount();
    vi.mocked(api.pluginsUiStateUpdate).mockResolvedValue(state(3, []));
    const seen: api.PluginPanelChange[] = [];
    const listen = (event: Event) => seen.push((event as CustomEvent<api.PluginPanelChange>).detail);
    window.addEventListener(api.PLUGIN_PANEL_CHANGED_EVENT, listen);
    await deliver({ type: "call", id: 1, method: "set", args: { widget: "tasks", value: [] } });
    await waitFor(() => expect(seen).toHaveLength(1));
    window.removeEventListener(api.PLUGIN_PANEL_CHANGED_EVENT, listen);
    expect(api.pluginsUiStateUpdate).toHaveBeenCalledWith("F:/project", plugin, "tasks", "", 2, { type: "widgetSet", widgetId: "tasks", value: [] });
    expect(seen[0]).toEqual({ projectPath: "F:/project", pluginName: plugin, panelId: "tasks", origin: channel });
    // Its own change is not read back over what the page already shows.
    expect(api.pluginsUiStateGet).toHaveBeenCalledTimes(1);
    // Someone else's change is.
    await act(async () => { window.dispatchEvent(new CustomEvent(api.PLUGIN_PANEL_CHANGED_EVENT, { detail: { projectPath: "F:/project", pluginName: plugin, panelId: "tasks", origin: "full-page" } })); await Promise.resolve(); });
    await waitFor(() => expect(api.pluginsUiStateGet).toHaveBeenCalledTimes(2));
  });

  it("is as tall as its page asks, within limits", async () => {
    const shell = await mount();
    const box = shell.parentElement!;
    await deliver({ type: "resize", height: 137.4 });
    expect(box.style.height).toBe("137px");
    await deliver({ type: "resize", height: 5000 });
    expect(box.style.height).toBe("320px");
    await deliver({ type: "resize", height: -4 });
    expect(box.style.height).toBe("40px");
    await deliver({ type: "resize", height: "300" });
    expect(box.style.height).toBe("40px");
  });

  it("opens the full page from its header or its page, and nothing else", async () => {
    await mount();
    const opened: string[] = [];
    const listen = (event: Event) => opened.push((event as CustomEvent<string>).detail);
    window.addEventListener(PLUGIN_OPEN_PAGE_EVENT, listen);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await deliver({ type: "open-panel", panel: "tasks" });
    await deliver({ type: "open-panel", panel: "../escape" });
    await deliver({ type: "open-panel", panel: 7 });
    window.removeEventListener(PLUGIN_OPEN_PAGE_EVENT, listen);
    const key = uiPanelKey({ pluginName: plugin, id: "tasks" });
    expect(opened).toEqual([key, key]);
  });

  it("folds, and stays folded for this project", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: /Tasks glance/ }));
    expect(screen.queryByTitle("Tasks glance")).toBeNull();
    expect(JSON.parse(localStorage.getItem("somniq-brief-glances-v1:F:/project")!)).toEqual([uiPanelKey(glance)]);
    cleanup();
    render(<ChatBriefGlances projectPath="F:/project" language="en" onPrompt={vi.fn()} onOpenFile={vi.fn()} />);
    expect(await screen.findByRole("button", { name: /Tasks glance/ })).toBeTruthy();
    expect(screen.queryByTitle("Tasks glance")).toBeNull();
  });

  it("draws host widgets compactly when the glance has no page", async () => {
    vi.mocked(api.pluginsUiList).mockResolvedValue([{ ...glance, page: undefined, dataPanel: undefined, widgets: [{ id: "p", type: "progress", title: "Progress" }] }]);
    vi.mocked(api.pluginsUiStateGet).mockResolvedValue({ revision: 1, todoLists: {}, notes: {}, data: { p: { value: 0.5, label: "Half" } } });
    render(<ChatBriefGlances projectPath="F:/project" language="en" onPrompt={vi.fn()} onOpenFile={vi.fn()} />);
    expect(await screen.findByText("Half")).toBeTruthy();
    expect(screen.queryByText(/Shared by this project/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
  });

  it("is absent when no plugin adds a glance", async () => {
    vi.mocked(api.pluginsUiList).mockResolvedValue([page]);
    const { container } = render(<ChatBriefGlances projectPath="F:/project" language="en" onPrompt={vi.fn()} onOpenFile={vi.fn()} />);
    await waitFor(() => expect(api.pluginsUiList).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });
});
