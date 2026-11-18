// @vitest-environment jsdom
// Changing a plugin by conversation: the "change this view" buttons, trying a
// draft's page and reading its files on the upgrade card, and going back to
// an earlier version from the Plugins page.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/plugins";
import { pluginEditPrompt } from "./PluginEditButton";
import PluginPage from "./PluginPage";
import PluginPackages from "./PluginPackages";
import PluginUpgradeReview from "./PluginUpgradeReview";

vi.mock("../api/plugins", async (original) => ({
  ...(await original<typeof import("../api/plugins")>()),
  pluginsUiPage: vi.fn(), pluginsUiStateGet: vi.fn(), pluginsUiStateUpdate: vi.fn(), pluginsDraftPage: vi.fn(), pluginsDraftChanges: vi.fn(),
  pluginsList: vi.fn(), pluginsRollback: vi.fn(), bridgeBackendPluginChanges: vi.fn(),
}));
vi.mock("../api/tauri", () => ({ openExternalUrl: vi.fn(), isTauri: () => false, textDiffLines: vi.fn(), textThreeWayMerge: vi.fn() }));
vi.mock("../chat/MarkdownContent", () => ({ default: ({ text }: { text: string }) => <div>{text}</div> }));

const plugin = "@local/project-tasks";
const tasks: api.ActiveUiPanel = {
  pluginName: plugin, packageDigest: "d1", id: "tasks", slot: "nav.page", order: 0, scope: "project", icon: "check",
  title: { en: "Tasks", cn: "任务" }, page: "./todo/index.html", widgets: [{ id: "tasks", type: "json", title: "Tasks" }],
};
const card: api.PluginApprovalCard = {
  kind: "upgrade", name: plugin, version: "0.1.1", description: "", digest: "b".repeat(64), source: "F:/project/.somniq/plugin-drafts/project-tasks",
  capabilities: { skills: [], uiPanels: [], mcpServers: [] }, currentVersion: "0.1.0", approveOn: "desktop",
  files: [{ path: "todo/todo.css", change: "changed", binary: false, beforeBytes: 20, afterBytes: 20 }],
  pagePanels: [{ id: "tasks", slot: "nav.page", title: { en: "Tasks", cn: "任务" } }],
};
const channel = "edit-edit-edit-edit-edit";

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(crypto, "randomUUID").mockReturnValue(channel);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("change this view", () => {
  it("drafts a prompt naming the panel, and leaves what to change to the user", () => {
    const cn = pluginEditPrompt(tasks, "cn");
    expect(cn).toContain(plugin);
    expect(cn).toContain("面板 tasks");
    expect(cn).toContain("PluginManager checkout");
    expect(cn.endsWith("我想要：")).toBe(true);
    expect(pluginEditPrompt({ ...tasks, slot: "chat.brief" }, "en")).toContain("project-summary glance");
  });

  it("is on a plugin page's header and only drafts, never sends", async () => {
    vi.mocked(api.pluginsUiPage).mockResolvedValue({ html: "<p>x</p>", path: "todo/index.html", assets: {}, packageDigest: "d1" });
    vi.mocked(api.pluginsUiStateGet).mockResolvedValue({ revision: 1, todoLists: {}, notes: {}, data: {} });
    const onAction = vi.fn();
    render(<PluginPage panel={tasks} projectPath="F:/project" language="cn" onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: /改这个界面/ }));
    expect(onAction).toHaveBeenCalledWith({ type: "prompt", text: pluginEditPrompt(tasks, "cn"), send: false });
  });
});

describe("the upgrade card", () => {
  const pageWindow = { postMessage: vi.fn() };
  const deliver = async (data: Record<string, unknown>) => {
    const event = new MessageEvent("message", { data: { channel, ...data } });
    Object.defineProperty(event, "source", { value: pageWindow });
    await act(async () => { window.dispatchEvent(event); await Promise.resolve(); });
  };

  it("runs the draft's page on the real data and keeps every change in memory", async () => {
    vi.mocked(api.pluginsDraftPage).mockResolvedValue({
      page: { html: "<h1>new look</h1>", path: "todo/index.html", assets: {}, packageDigest: card.digest },
      panel: { id: "tasks", slot: "nav.page", title: "Tasks", order: 0, scope: "project", page: "./todo/index.html", widgets: [{ id: "tasks", type: "json", title: "Tasks" }] },
    });
    vi.mocked(api.pluginsUiStateGet).mockResolvedValue({ revision: 4, todoLists: {}, notes: {}, data: { tasks: [{ id: "a", title: "Real task" }] } });
    render(<PluginUpgradeReview card={card} projectPath="F:/project" language="en" />);
    fireEvent.click(screen.getByRole("button", { name: /Try "Tasks" · page/ }));
    const shell = await screen.findByTitle("Tasks") as HTMLIFrameElement;
    Object.defineProperty(shell, "contentWindow", { value: { 0: pageWindow } });
    expect(api.pluginsDraftPage).toHaveBeenCalledWith("F:/project", card.source, card.digest, "tasks");
    const page = new DOMParser().parseFromString(shell.getAttribute("srcdoc")!, "text/html").querySelector("iframe")!.getAttribute("srcdoc")!;
    expect(page).toContain("<h1>new look</h1>");
    expect(page).toContain("Real task");

    await deliver({ type: "call", id: 1, method: "set", args: { widget: "tasks", value: [] } });
    await waitFor(() => expect(pageWindow.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ id: 1, ok: true, value: { tasks: [] } }), "*"));
    expect(api.pluginsUiStateUpdate).not.toHaveBeenCalled();
    // Reading back gives what was tried, not what is on disk.
    await deliver({ type: "call", id: 2, method: "data" });
    await waitFor(() => expect(pageWindow.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ id: 2, value: { tasks: [] } }), "*"));
    expect(screen.getByText(/nothing is saved/)).toBeTruthy();
  });

  it("starts empty when the installed version has no such panel yet", async () => {
    vi.mocked(api.pluginsDraftPage).mockResolvedValue({
      page: { html: "<p>new</p>", path: "p.html", assets: {}, packageDigest: card.digest },
      panel: { id: "tasks", slot: "nav.page", title: "Tasks", order: 0, page: "./p.html", widgets: [{ id: "tasks", type: "json", title: "T" }] },
    });
    vi.mocked(api.pluginsUiStateGet).mockRejectedValue("UI panel is not declared by this plugin");
    render(<PluginUpgradeReview card={card} projectPath="F:/project" language="en" />);
    fireEvent.click(screen.getByRole("button", { name: /Try "Tasks" · page/ }));
    const shell = await screen.findByTitle("Tasks");
    const page = new DOMParser().parseFromString(shell.getAttribute("srcdoc")!, "text/html").querySelector("iframe")!.getAttribute("srcdoc")!;
    expect(page).toContain(JSON.stringify({ tasks: null }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows every changed file line by line", async () => {
    vi.mocked(api.pluginsDraftChanges).mockResolvedValue([
      { path: "todo/todo.css", change: "changed", binary: false, before: "a\n--radius: 10px;\nb", after: "a\n--radius: 4px;\nb", beforeBytes: 20, afterBytes: 19 },
      { path: "todo/logo.png", change: "added", binary: true, beforeBytes: 0, afterBytes: 2048 },
    ]);
    render(<PluginUpgradeReview card={card} projectPath="F:/project" language="en" />);
    fireEvent.click(screen.getByRole("button", { name: /Show changed files \(1\)/ }));
    const css = await screen.findByRole("button", { name: /todo\/todo.css/ });
    expect(css.textContent).toContain("+1");
    expect(css.textContent).toContain("−1");
    expect(screen.getByText(/Binary file · 0 B → 2.0 KB/)).toBeTruthy();
    fireEvent.click(css);
    expect(screen.getByText(/--radius: 4px;/).className).toContain("is-added");
    expect(screen.getByText(/--radius: 10px;/).className).toContain("is-removed");
    expect(api.pluginsDraftChanges).toHaveBeenCalledWith("F:/project", card.source, card.digest);
  });
});

describe("earlier versions", () => {
  const lifecycle: api.PluginLifecycle = { state: "enabled", activeRuns: 0, staleRuns: 0, mcpServers: [] };
  const item: api.InstalledPlugin = {
    name: plugin, version: "0.1.2", description: "", source: "F:/x", digest: "c".repeat(64), canEnable: true, diagnostics: [],
    capabilities: { skills: [], skillRoots: [], mcpServers: [], uiPanels: [] }, enabled: true, status: "enabled", lifecycle, originalDigest: "a".repeat(64),
    history: [
      { version: "0.1.1", digest: "b".repeat(64), source: "F:/x", replacedAt: 1794300000 },
      { version: "0.1.0", digest: "a".repeat(64), source: "F:/x", replacedAt: 1794200000 },
    ],
  };

  it("lists them with the original marked, and goes back only after a confirmation", async () => {
    vi.mocked(api.pluginsList).mockResolvedValue([item]);
    vi.mocked(api.pluginsRollback).mockResolvedValue({ ...item, version: "0.1.0", digest: "a".repeat(64), history: [] });
    render(<PluginPackages projectPath="F:/project" language="cn" onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /历史版本 2/ }));
    const list = screen.getByRole("list", { name: "历史版本 2" });
    const rows = within(list).getAllByRole("listitem");
    expect(within(rows[1]).getByText("原版")).toBeTruthy();
    expect(within(rows[0]).queryByText("原版")).toBeNull();
    fireEvent.click(within(rows[1]).getByRole("button", { name: /回退到这个版本/ }));
    expect(api.pluginsRollback).not.toHaveBeenCalled();
    expect(screen.getByText(/v0.1.0 会替换当前的 v0.1.2/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认回退" }));
    await waitFor(() => expect(api.pluginsRollback).toHaveBeenCalledWith("F:/project", plugin, "a".repeat(64), "c".repeat(64), true));
  });
});
