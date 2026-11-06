// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    await screen.findByRole("article", { name: "@lab/evidence" });
    expect(screen.getByText("verify-evidence")).toBeTruthy();
    expect(screen.getByText("papers")).toBeTruthy();
    expect(screen.getByText("python server.py")).toBeTruthy();
    fireEvent.click(screen.getByText("安装并保持停用"));
    await screen.findByText("已停用");
    expect(api.pluginsInstall).toHaveBeenCalledWith(projectPath, preview.source, preview.digest);
    expect(api.pluginsSetEnabled).not.toHaveBeenCalled();
    // A package with MCP servers shows the exact commands before it can start them.
    fireEvent.click(screen.getByRole("switch", { name: "启用 @lab/evidence" }));
    const enableConfirm = screen.getByRole("group", { name: "启用 @lab/evidence" });
    expect(within(enableConfirm).getByText("python server.py")).toBeTruthy();
    expect(api.pluginsSetEnabled).not.toHaveBeenCalled();
    fireEvent.click(within(enableConfirm).getByRole("button", { name: "确认启用" }));
    await screen.findByText("已启用");
    expect(api.pluginsSetEnabled).toHaveBeenCalledWith(projectPath, preview.name, true);
    // Removal asks first.
    fireEvent.click(screen.getByRole("button", { name: "移除 @lab/evidence" }));
    expect(api.pluginsRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认移除" }));
    await waitFor(() => expect(screen.queryByRole("article", { name: "@lab/evidence" })).toBeNull());
    expect(api.pluginsRemove).toHaveBeenCalledWith(projectPath, preview.name);
    expect(onChanged).toHaveBeenCalledTimes(3);
  });

  it("shows host diagnostics and allows a blocked enabled package to be disabled", async () => {
    vi.mocked(api.pluginsList).mockResolvedValue([{ ...installed, enabled: true, status: "blocked", canEnable: false, diagnostics: [{ code: "capability", message: "dsh-goal requires DeepSeek host", severity: "error" }] }]);
    vi.mocked(api.pluginsSetEnabled).mockResolvedValue({ ...installed, canEnable: false, status: "blocked" });
    render(<PluginPackages projectPath={projectPath} language="en" onChanged={onChanged} />);
    await screen.findByText("dsh-goal requires DeepSeek host");
    fireEvent.click(screen.getByRole("switch", { name: "Disable @lab/evidence" }));
    await waitFor(() => expect(api.pluginsSetEnabled).toHaveBeenCalledWith(projectPath, preview.name, false));
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("switch", { name: "Enable @lab/evidence" }).disabled).toBe(true));
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
    expect(screen.queryByRole("article", { name: "@lab/evidence" })).toBeNull();
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
    expect(screen.getByRole("article", { name: "@lab/evidence" })).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("enables a package without MCP servers in one step and shows its capabilities", async () => {
    vi.mocked(api.pluginsList).mockResolvedValue([{ ...installed, name: "@somniq/panels", capabilities: { ...installed.capabilities, mcpServers: [] } }]);
    vi.mocked(api.pluginsSetEnabled).mockResolvedValue({ ...installed, name: "@somniq/panels", capabilities: { ...installed.capabilities, mcpServers: [] }, enabled: true, status: "enabled" });
    render(<PluginPackages projectPath={projectPath} language="en" onChanged={onChanged} />);
    const card = await screen.findByRole("article", { name: "@somniq/panels" });
    expect(within(card).getByText("1 Skills")).toBeTruthy();
    expect(within(card).queryByText(/MCP/)).toBeNull();
    fireEvent.click(within(card).getByRole("switch", { name: "Enable @somniq/panels" }));
    await waitFor(() => expect(api.pluginsSetEnabled).toHaveBeenCalledWith(projectPath, "@somniq/panels", true));
    expect(screen.queryByRole("group", { name: "Enable @somniq/panels" })).toBeNull();
  });

  it("explains a package the project asks for but this computer has not approved", async () => {
    vi.mocked(api.pluginsList).mockResolvedValue([{
      ...installed,
      diagnostics: [{ code: "approval-required", message: "This project asks to run this package", severity: "warning" }],
    }]);
    render(<PluginPackages projectPath={projectPath} language="cn" onChanged={onChanged} />);
    const card = await screen.findByRole("article", { name: "@lab/evidence" });
    expect(within(card).getByText(/本机还没有批准这个版本/)).toBeTruthy();
    expect(within(card).queryByText("需要 DeepSeek 宿主能力")).toBeNull();
    // Approving goes through the same reviewed confirmation as enabling.
    fireEvent.click(within(card).getByRole("switch", { name: "启用 @lab/evidence" }));
    expect(screen.getByRole("group", { name: "启用 @lab/evidence" })).toBeTruthy();
    expect(api.pluginsSetEnabled).not.toHaveBeenCalled();
  });

  it("does not call SomniQ's own blockers a missing DeepSeek host capability", async () => {
    vi.mocked(api.pluginsList).mockResolvedValue([{
      ...installed, canEnable: false, status: "blocked",
      diagnostics: [{ code: "skill-builtin", message: "Built-in SomniQ skills cannot be replaced by a plugin: research-review", severity: "error" }],
    }]);
    render(<PluginPackages projectPath={projectPath} language="en" onChanged={onChanged} />);
    const card = await screen.findByRole("article", { name: "@lab/evidence" });
    expect(within(card).getByText("Can't enable yet")).toBeTruthy();
    expect(within(card).queryByText("Needs DeepSeek host capabilities")).toBeNull();
    expect(within(card).getByText(/cannot be replaced by a plugin/)).toBeTruthy();
  });
});
