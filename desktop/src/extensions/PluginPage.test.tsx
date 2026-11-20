// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/plugins";
import { openExternalUrl } from "../api/tauri";
import PluginPage from "./PluginPage";

vi.mock("../api/plugins", async (original) => ({
  ...(await original<typeof import("../api/plugins")>()), pluginsUiStateGet: vi.fn(), pluginsUiStateUpdate: vi.fn(),
}));
vi.mock("../api/tauri", () => ({ openExternalUrl: vi.fn().mockResolvedValue(undefined) }));
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
});
