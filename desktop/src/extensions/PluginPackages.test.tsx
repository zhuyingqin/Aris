// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/plugins";
import PluginPackages from "./PluginPackages";

vi.mock("../api/plugins", () => ({
  pluginsList: vi.fn(), pluginsPreview: vi.fn(), pluginsInstall: vi.fn(),
  pluginsSetEnabled: vi.fn(), pluginsRemove: vi.fn(),
}));

const preview: api.PluginPreview = {
  name: "@lab/evidence", version: "1.2.3", description: "Evidence checks", source: "F:/packages/evidence",
  digest: "a".repeat(64), canEnable: true, diagnostics: [],
  capabilities: { skills: ["verify-evidence"], skillRoots: ["skills"], mcpServers: [{ name: "papers", command: "python", args: ["server.py"] }], uiPanels: [] },
};
const installed: api.InstalledPlugin = { ...preview, enabled: false, status: "disabled" };
const projectPath = "F:/project";
const onChanged = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.pluginsList).mockResolvedValue([]);
  vi.mocked(api.pluginsPreview).mockResolvedValue(preview);
  vi.mocked(api.pluginsInstall).mockResolvedValue(installed);
  vi.mocked(api.pluginsSetEnabled).mockResolvedValue({ ...installed, enabled: true, status: "enabled" });
  vi.mocked(api.pluginsRemove).mockResolvedValue();
});
afterEach(cleanup);

describe("Plugin packages", () => {
  it("previews the source and installs exactly the reviewed snapshot before enabling", async () => {
    render(<PluginPackages projectPath={projectPath} language="cn" onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByText("导入本地插件包").closest("button")?.disabled).toBe(false));
    fireEvent.click(screen.getByText("导入本地插件包"));
    fireEvent.change(screen.getByLabelText("插件包目录"), { target: { value: preview.source } });
    fireEvent.click(screen.getByText("预览"));
    await screen.findByText("@lab/evidence");
    expect(screen.getByText("verify-evidence")).toBeTruthy();
    expect(screen.getByText("papers · python server.py")).toBeTruthy();
    fireEvent.click(screen.getByText("安装并保持停用"));
    await screen.findByText("已停用");
    expect(api.pluginsInstall).toHaveBeenCalledWith(projectPath, preview.source, preview.digest);
    expect(api.pluginsSetEnabled).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "启用 @lab/evidence" }));
    await screen.findByText("已启用");
    expect(api.pluginsSetEnabled).toHaveBeenCalledWith(projectPath, preview.name, true);
    fireEvent.click(screen.getByRole("button", { name: "移除 @lab/evidence" }));
    await waitFor(() => expect(screen.queryByText("@lab/evidence")).toBeNull());
    expect(api.pluginsRemove).toHaveBeenCalledWith(projectPath, preview.name);
    expect(onChanged).toHaveBeenCalledTimes(3);
  });

  it("shows host diagnostics and allows a blocked enabled package to be disabled", async () => {
    vi.mocked(api.pluginsList).mockResolvedValue([{ ...installed, enabled: true, status: "blocked", canEnable: false, diagnostics: [{ code: "capability", message: "dsh-goal requires DeepSeek host", severity: "error" }] }]);
    vi.mocked(api.pluginsSetEnabled).mockResolvedValue({ ...installed, canEnable: false, status: "blocked" });
    render(<PluginPackages projectPath={projectPath} language="en" onChanged={onChanged} />);
    await screen.findByText("dsh-goal requires DeepSeek host");
    fireEvent.click(screen.getByRole("button", { name: "Disable @lab/evidence" }));
    await waitFor(() => expect(api.pluginsSetEnabled).toHaveBeenCalledWith(projectPath, preview.name, false));
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Enable @lab/evidence" }).disabled).toBe(true));
  });

  it("discards an outstanding preview when the project changes", async () => {
    let resolvePreview!: (value: api.PluginPreview) => void;
    vi.mocked(api.pluginsPreview).mockReturnValue(new Promise((resolve) => { resolvePreview = resolve; }));
    const view = render(<PluginPackages projectPath={projectPath} language="en" onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Import local package" }).disabled).toBe(false));
    fireEvent.click(screen.getByText("Import local package"));
    fireEvent.change(screen.getByLabelText("Package directory"), { target: { value: preview.source } });
    fireEvent.click(screen.getByText("Preview"));
    view.rerender(<PluginPackages projectPath="F:/other" language="en" onChanged={onChanged} />);
    resolvePreview(preview);
    await waitFor(() => expect(api.pluginsList).toHaveBeenCalledWith("F:/other"));
    expect(screen.queryByText("@lab/evidence")).toBeNull();
    expect(api.pluginsInstall).not.toHaveBeenCalled();
  });

  it("retains the preview when installation fails and shows a retryable error", async () => {
    vi.mocked(api.pluginsInstall).mockRejectedValue(new Error("Package changed after preview"));
    render(<PluginPackages projectPath={projectPath} language="en" onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Import local package" }).disabled).toBe(false));
    fireEvent.click(screen.getByText("Import local package"));
    fireEvent.change(screen.getByLabelText("Package directory"), { target: { value: preview.source } });
    fireEvent.click(screen.getByText("Preview"));
    fireEvent.click(await screen.findByText("Install disabled"));
    await screen.findByRole("alert");
    expect(screen.getByText("@lab/evidence")).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
  });
});
