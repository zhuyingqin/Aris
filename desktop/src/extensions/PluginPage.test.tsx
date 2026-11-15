// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/plugins";
import PluginPage from "./PluginPage";

vi.mock("../api/plugins", async (original) => ({
  ...(await original<typeof import("../api/plugins")>()), pluginsUiStateGet: vi.fn(), pluginsUiStateUpdate: vi.fn(),
}));
vi.mock("../api/tauri", () => ({ openExternalUrl: vi.fn() }));
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
});
