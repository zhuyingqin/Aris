// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/plugins";
import { onWorkTaskChanged, openExternalUrl, workTaskList } from "../api/tauri";
import PluginPage from "./PluginPage";

vi.mock("../api/plugins", async (original) => ({
  ...(await original<typeof import("../api/plugins")>()), pluginsUiPage: vi.fn(), pluginsUiStateGet: vi.fn(), pluginsUiStateUpdate: vi.fn(),
}));
vi.mock("../api/tauri", () => ({ openExternalUrl: vi.fn().mockResolvedValue(undefined), workTaskList: vi.fn().mockResolvedValue([]), onWorkTaskChanged: vi.fn().mockResolvedValue(() => undefined) }));
vi.mock("../api/transport", async (original) => ({ ...(await original<typeof import("../api/transport")>()), hasNativeBackend: () => true }));
vi.mock("../chat/MarkdownContent", () => ({ default: ({ text }: { text: string }) => <div>{text}</div> }));

const page: api.ActiveUiPanel = {
  pluginName: "@local/board", packageDigest: "d1", id: "board", slot: "nav.page", order: 0, scope: "project", icon: "barChart", title: { en: "Experiment board", cn: "实验看板" },
  widgets: [
    { id: "summary", type: "metrics", title: "Summary" },
    { id: "refresh", type: "button", label: "Refresh board", action: { type: "prompt", text: "Refresh the board", send: true } },
    { id: "open", type: "button", label: "Open log", action: { type: "open-file", path: "results/log.md" } },
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  vi.mocked(api.pluginsUiStateGet).mockResolvedValue({ revision: 1, todoLists: {}, notes: {}, data: { summary: [{ label: "Accuracy", value: "81.2%" }] } });
});
afterEach(cleanup);

describe("PluginPage", () => {
  it("shows the project's copy of the panel and hands every click to its host", async () => {
    const onAction = vi.fn();
    render(<PluginPage panel={page} projectPath="F:/project" language="en" onAction={onAction} />);
    expect(screen.getByRole("heading", { level: 1, name: "Experiment board" })).toBeTruthy();
    expect(await screen.findByText("81.2%")).toBeTruthy();
    // A page has no conversation: it reads the project's data.
    expect(api.pluginsUiStateGet).toHaveBeenCalledWith("F:/project", "@local/board", "board", "");
    fireEvent.click(screen.getByRole("button", { name: "Refresh board" }));
    expect(onAction).toHaveBeenLastCalledWith({ type: "prompt", text: "Refresh the board", send: true });
    fireEvent.click(screen.getByRole("button", { name: "Open log" }));
    expect(onAction).toHaveBeenLastCalledWith({ type: "open-file", path: "results/log.md" });
    expect(api.pluginsUiStateUpdate).not.toHaveBeenCalled();
  });

  it("embeds a web panel's address with its own origin, never the app's, and keeps the browser one click away", () => {
    vi.mocked(openExternalUrl).mockResolvedValue(undefined);
    const web: api.ActiveUiPanel = { pluginName: "@local/tool", packageDigest: "d2", id: "tool", slot: "nav.page", order: 0, scope: "project", title: "Local tool", web: "http://localhost:3007/", widgets: [] };
    const { container } = render(<PluginPage panel={web} projectPath="F:/project" language="en" onAction={vi.fn()} />);
    const frame = container.querySelector("iframe")!;
    expect(frame.getAttribute("src")).toBe("http://localhost:3007/");
    const sandbox = frame.getAttribute("sandbox")!.split(" ");
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox.some((token) => token.startsWith("allow-top-navigation"))).toBe(false);
    expect(screen.getByText("localhost:3007")).toBeTruthy();
    // A web panel keeps no data: nothing reads plugin state for it.
    expect(api.pluginsUiStateGet).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Open in browser/ }));
    expect(openExternalUrl).toHaveBeenCalledWith("http://localhost:3007/");
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(container.querySelector("iframe")).not.toBe(frame);
  });
  it("shows a console page and the site it controls on one page, as two frames the user can resize", async () => {
    vi.mocked(api.pluginsUiPage).mockResolvedValue({ html: "<h1>Console</h1>", path: "control.html", assets: {}, packageDigest: "d3" });
    vi.mocked(workTaskList).mockResolvedValue([]);
    vi.mocked(onWorkTaskChanged).mockResolvedValue(() => undefined);
    const panel: api.ActiveUiPanel = {
      pluginName: "@local/farm", packageDigest: "d3", id: "console", slot: "nav.page", order: 0, scope: "project", title: "Farm console",
      page: "./control.html", proposeTasks: true, web: "http://127.0.0.1:3007", widgets: [{ id: "result", type: "markdown", title: "Result" }],
    };
    const { container } = render(<PluginPage panel={panel} projectPath="F:/project" language="en" onAction={vi.fn()} />);
    const root = container.querySelector(".plugin-page-split")!;
    expect(root.getAttribute("data-layout")).toBe("below");
    // One header for both: the package's name and the site's address.
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByText("127.0.0.1:3007")).toBeTruthy();
    const site = container.querySelector(".plugin-page-split-web iframe")!;
    expect(site.getAttribute("src")).toBe("http://127.0.0.1:3007");
    // The package's page gets its own sandboxed frame without an origin; the site never does.
    await waitFor(() => expect(container.querySelector(".plugin-page-split-main iframe")).toBeTruthy());
    const own = container.querySelector(".plugin-page-split-main iframe")!;
    expect(own.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(own.getAttribute("src")).toBeNull();
    expect(api.pluginsUiPage).toHaveBeenCalledWith("F:/project", "@local/farm", "console");

    const divider = screen.getByRole("separator");
    expect(divider.getAttribute("aria-valuenow")).toBe("40");
    fireEvent.keyDown(divider, { key: "ArrowDown" });
    expect(divider.getAttribute("aria-valuenow")).toBe("45");
    expect(window.localStorage.getItem("somniq-plugin-split:@local/farm:console")).toBe("45");
    fireEvent.doubleClick(divider);
    expect(divider.getAttribute("aria-valuenow")).toBe("40");
    // Reload reaches the site only: the package's page keeps its state.
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(container.querySelector(".plugin-page-split-web iframe")).not.toBe(site);
    expect(container.querySelector(".plugin-page-split-main iframe")).toBe(own);
  });

  it("puts declared widgets beside the site, to its left when the panel asks", async () => {
    const panel: api.ActiveUiPanel = { ...page, web: "http://localhost:3007/", webLayout: "right" };
    window.localStorage.setItem("somniq-plugin-split:@local/board:board", "99");
    const onAction = vi.fn();
    const { container } = render(<PluginPage panel={panel} projectPath="F:/project" language="en" onAction={onAction} />);
    expect(container.querySelector(".plugin-page-split")!.getAttribute("data-layout")).toBe("right");
    // A remembered divider is kept inside its bounds.
    expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe("85");
    expect(await screen.findByText("81.2%")).toBeTruthy();
    // The widgets are drawn by the host as usual, not as a second web frame.
    expect(container.querySelectorAll("iframe")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Refresh board" }));
    expect(onAction).toHaveBeenLastCalledWith({ type: "prompt", text: "Refresh the board", send: true });
  });
  it("gives a page with dataPanel the other panel's data to read and write", async () => {
    vi.mocked(api.pluginsUiPage).mockResolvedValue({ html: "<h1>Glance</h1>", path: "glance.html", assets: {}, packageDigest: "d1" });
    vi.mocked(workTaskList).mockResolvedValue([]);
    vi.mocked(onWorkTaskChanged).mockResolvedValue(() => undefined);
    const own: api.ActiveUiPanel = { pluginName: "@local/board", packageDigest: "d1", id: "focus", slot: "nav.page", order: 1, scope: "project", title: "Focus",
      page: "./glance.html", dataPanel: "board", widgets: [] };
    const { container } = render(<PluginPage panel={own} store={page} projectPath="F:/project" language="en" onAction={vi.fn()} />);
    await waitFor(() => expect(container.querySelector("iframe")).toBeTruthy());
    // The page's file comes from its own panel; its data from the store panel.
    expect(api.pluginsUiPage).toHaveBeenCalledWith("F:/project", "@local/board", "focus");
    expect(api.pluginsUiStateGet).toHaveBeenCalledWith("F:/project", "@local/board", "board", "");
  });
});
