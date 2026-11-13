// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/plugins";
import PluginPackages from "./PluginPackages";
import { useStore } from "../store";

vi.mock("../api/plugins", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/plugins")>()),
  pluginsList: vi.fn(), pluginsPreview: vi.fn(), pluginsInstall: vi.fn(),
  pluginsSetEnabled: vi.fn(), pluginsRemove: vi.fn(), pluginsUpgrade: vi.fn(), pluginsCheckMcp: vi.fn(),
  bridgeBackendPluginChanges: vi.fn(),
}));

const pkg: api.PluginPreview = {
  name: "@lab/evidence", version: "1.2.3", description: "Evidence checks", source: "F:/packages/evidence",
  digest: "a".repeat(64), canEnable: true, diagnostics: [],
  capabilities: { skills: ["verify-evidence"], skillRoots: ["skills"], mcpServers: [{ name: "papers", command: "python", args: ["server.py"] }], uiPanels: [] },
};
const preview: api.PluginImportPreview = { ...pkg, upgrade: null };
const lifecycle = (state: api.PluginState, extra: Partial<api.PluginLifecycle> = {}): api.PluginLifecycle =>
  ({ state, activeRuns: 0, staleRuns: 0, mcpServers: [], ...extra });
const mcp = (health: api.PluginMcpStatus["health"], extra: Partial<api.PluginMcpStatus> = {}): api.PluginMcpStatus =>
  ({ name: "papers", runtimeName: "p1234abcd_papers", health, toolCount: 0, message: null, checkedAtMs: null, ...extra });
const installed: api.InstalledPlugin = { ...pkg, enabled: false, status: "disabled", lifecycle: lifecycle("installed") };
const enabled: api.InstalledPlugin = { ...installed, enabled: true, status: "enabled", lifecycle: lifecycle("enabled") };
const projectPath = "F:/project";
const onChanged = vi.fn();

const noChange = { added: [], removed: [] };
const upgradePlan = (extra: Partial<api.PluginUpgradePlan> = {}): api.PluginUpgradePlan => ({
  currentVersion: "1.2.3", currentDigest: "a".repeat(64), currentEnabled: true, change: "upgrade",
  diff: {
    skills: { added: ["audit-claims"], removed: [] }, uiPanels: noChange,
    mcpServers: [{ name: "papers", change: "changed", before: "python ./server.py", after: "python ./server.py --strict", envAdded: ["PAPERS_TOKEN"], envRemoved: [], envChanged: [] }],
    commands: { added: ["python ./server.py --strict"], removed: ["python ./server.py"] },
    envKeys: { added: ["PAPERS_TOKEN"], removed: [] }, changed: true,
  },
  ...extra,
});
const upgradePreview = (plan: api.PluginUpgradePlan): api.PluginImportPreview =>
  ({ ...pkg, version: "1.3.0", digest: "b".repeat(64), upgrade: plan });

async function previewSource(language: "cn" | "en" = "cn") {
  const [importLabel, pathLabel, previewLabel] = language === "cn" ? ["导入本地插件包", "插件包目录", "预览"] : ["Import local package", "Package directory", "Preview"];
  await waitFor(() => expect(screen.getByText(importLabel).closest("button")?.disabled).toBe(false));
  fireEvent.click(screen.getByText(importLabel));
  fireEvent.change(screen.getByLabelText(pathLabel), { target: { value: pkg.source } });
  fireEvent.click(screen.getByText(previewLabel));
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.pluginsList).mockResolvedValue([]);
  vi.mocked(api.pluginsPreview).mockResolvedValue(preview);
  vi.mocked(api.pluginsInstall).mockResolvedValue(installed);
  vi.mocked(api.pluginsSetEnabled).mockResolvedValue(enabled);
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
    vi.mocked(api.pluginsList).mockResolvedValue([{ ...installed, enabled: true, status: "blocked", canEnable: false, lifecycle: lifecycle("blocked"), diagnostics: [{ code: "capability", message: "dsh-goal requires DeepSeek host", severity: "error" }] }]);
    vi.mocked(api.pluginsSetEnabled).mockResolvedValue({ ...installed, canEnable: false, status: "blocked", lifecycle: lifecycle("blocked") });
    render(<PluginPackages projectPath={projectPath} language="en" onChanged={onChanged} />);
    await screen.findByText("dsh-goal requires DeepSeek host");
    fireEvent.click(screen.getByRole("switch", { name: "Disable @lab/evidence" }));
    await waitFor(() => expect(api.pluginsSetEnabled).toHaveBeenCalledWith(projectPath, preview.name, false));
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("switch", { name: "Enable @lab/evidence" }).disabled).toBe(true));
  });

  it("discards an outstanding preview when the project changes", async () => {
    let resolvePreview!: (value: api.PluginImportPreview) => void;
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
    vi.mocked(api.pluginsSetEnabled).mockResolvedValue({ ...enabled, name: "@somniq/panels", capabilities: { ...installed.capabilities, mcpServers: [] } });
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
      ...installed, lifecycle: lifecycle("approval-required"),
      diagnostics: [{ code: "approval-required", message: "This project asks to run this package", severity: "warning" }],
    }]);
    render(<PluginPackages projectPath={projectPath} language="cn" onChanged={onChanged} />);
    const card = await screen.findByRole("article", { name: "@lab/evidence" });
    expect(within(card).getByText("待本机批准")).toBeTruthy();
    expect(within(card).getByText(/本机还没有批准这个版本/)).toBeTruthy();
    expect(within(card).queryByText("需要 DeepSeek 宿主能力")).toBeNull();
    // Approving goes through the same reviewed confirmation as enabling.
    fireEvent.click(within(card).getByRole("switch", { name: "启用 @lab/evidence" }));
    expect(screen.getByRole("group", { name: "启用 @lab/evidence" })).toBeTruthy();
    expect(api.pluginsSetEnabled).not.toHaveBeenCalled();
  });

  it("does not call SomniQ's own blockers a missing DeepSeek host capability", async () => {
    vi.mocked(api.pluginsList).mockResolvedValue([{
      ...installed, canEnable: false, status: "blocked", lifecycle: lifecycle("blocked"),
      diagnostics: [{ code: "skill-builtin", message: "Built-in SomniQ skills cannot be replaced by a plugin: research-review", severity: "error" }],
    }]);
    render(<PluginPackages projectPath={projectPath} language="en" onChanged={onChanged} />);
    const card = await screen.findByRole("article", { name: "@lab/evidence" });
    expect(within(card).getByText("Can't enable yet")).toBeTruthy();
    expect(within(card).queryByText("Needs DeepSeek host capabilities")).toBeNull();
    expect(within(card).getByText(/cannot be replaced by a plugin/)).toBeTruthy();
  });
  it("keeps running, failed and restart-needed apart and shows each MCP server's real health", async () => {
    vi.mocked(api.pluginsList).mockResolvedValue([
      { ...enabled, name: "@lab/running", lifecycle: lifecycle("running", { activeRuns: 2, mcpServers: [mcp("connected", { toolCount: 3, checkedAtMs: 1 })] }) },
      { ...enabled, name: "@lab/failed", lifecycle: lifecycle("failed", { mcpServers: [mcp("failed", { message: "spawn python: not found", checkedAtMs: 1 })] }) },
      { ...installed, name: "@lab/stale", lifecycle: lifecycle("needs-restart", { activeRuns: 1, staleRuns: 1, mcpServers: [mcp("unchecked")] }) },
      { ...enabled, name: "@lab/ready", lifecycle: lifecycle("enabled", { mcpServers: [mcp("unchecked")] }) },
    ]);
    vi.mocked(api.pluginsCheckMcp).mockResolvedValue({ ...enabled, name: "@lab/failed", lifecycle: lifecycle("enabled", { mcpServers: [mcp("connected", { toolCount: 5, checkedAtMs: 2 })] }) });
    render(<PluginPackages projectPath={projectPath} language="cn" onChanged={onChanged} />);

    const running = await screen.findByRole("article", { name: "@lab/running" });
    expect(within(running).getByText("运行中")).toBeTruthy();
    expect(within(running).getByText(/2 个正在运行的回合或任务在使用这个版本/)).toBeTruthy();
    expect(within(running).getByText("已连接 · 3 个工具")).toBeTruthy();

    const failed = screen.getByRole("article", { name: "@lab/failed" });
    expect(within(failed).getByText("MCP 连接失败")).toBeTruthy();
    expect(within(failed).getByText("连接失败")).toBeTruthy();
    expect(within(failed).getByText("spawn python: not found")).toBeTruthy();

    // Disabled mid-run: still in use until those runs end, and nothing to check.
    const stale = screen.getByRole("article", { name: "@lab/stale" });
    expect(within(stale).getByText("需重新开始")).toBeTruthy();
    expect(within(stale).getByText(/已停用，但 1 个正在运行的回合或任务会继续使用它/)).toBeTruthy();
    expect(within(stale).queryByRole("group", { name: "MCP 连接 @lab/stale" })).toBeNull();

    // Enabled means configured for the next run, not connected.
    const ready = screen.getByRole("article", { name: "@lab/ready" });
    expect(within(ready).getByText("已启用")).toBeTruthy();
    expect(within(ready).getByText("下一次运行开始生效。")).toBeTruthy();
    expect(within(ready).getByText(/尚未连接/)).toBeTruthy();

    // A connection check runs the real discovery and only holds its own card.
    fireEvent.click(within(failed).getByRole("button", { name: "检查连接" }));
    expect(within(failed).getByText("正在连接…")).toBeTruthy();
    expect(within(ready).getByRole<HTMLButtonElement>("button", { name: "检查连接" }).disabled).toBe(false);
    await within(failed).findByText("已连接 · 5 个工具");
    expect(api.pluginsCheckMcp).toHaveBeenCalledWith(projectPath, "@lab/failed");
    expect(within(failed).getByText("已启用")).toBeTruthy();
  });

  it("previews an upgrade as a diff against the approved version and re-approves it", async () => {
    vi.mocked(api.pluginsList).mockResolvedValue([enabled]);
    vi.mocked(api.pluginsPreview).mockResolvedValue(upgradePreview(upgradePlan()));
    vi.mocked(api.pluginsUpgrade).mockResolvedValue({ ...enabled, version: "1.3.0", digest: "b".repeat(64) });
    render(<PluginPackages projectPath={projectPath} language="cn" onChanged={onChanged} />);
    await screen.findByRole("article", { name: "@lab/evidence" });
    await previewSource();
    await screen.findByText("升级预览");
    expect(screen.getByText(/已安装 v1\.2\.3 → v1\.3\.0 · 升级/)).toBeTruthy();
    const diff = screen.getByRole("group", { name: "与本机已批准的版本相比" });
    expect(within(diff).getByText("+ python ./server.py --strict")).toBeTruthy();
    expect(within(diff).getByText("− python ./server.py")).toBeTruthy();
    expect(within(diff).getByText("+ PAPERS_TOKEN")).toBeTruthy();
    expect(within(diff).getByText("+ audit-claims")).toBeTruthy();
    // Upgrading is its own step; a plain install is not offered.
    expect(screen.queryByText("安装并保持停用")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "升级并重新批准" }));
    await waitFor(() => expect(api.pluginsUpgrade).toHaveBeenCalledWith(projectPath, pkg.source, "b".repeat(64), "a".repeat(64), true));
    await waitFor(() => expect(screen.queryByText("升级预览")).toBeNull());
    expect(within(screen.getByRole("article", { name: "@lab/evidence" })).getByText("v1.3.0")).toBeTruthy();
    expect(api.pluginsInstall).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("upgrades a disabled package without approving it and keeps a failed upgrade's preview", async () => {
    vi.mocked(api.pluginsList).mockResolvedValue([installed]);
    vi.mocked(api.pluginsPreview).mockResolvedValue(upgradePreview(upgradePlan({ currentEnabled: false })));
    vi.mocked(api.pluginsUpgrade).mockRejectedValueOnce(new Error("injected failure at approved"));
    render(<PluginPackages projectPath={projectPath} language="en" onChanged={onChanged} />);
    await screen.findByRole("article", { name: "@lab/evidence" });
    await previewSource("en");
    expect(await screen.findByRole("group", { name: "Compared with the installed version" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Upgrade, keep disabled" }));
    await screen.findByRole("alert");
    expect(api.pluginsUpgrade).toHaveBeenCalledWith(projectPath, pkg.source, "b".repeat(64), "a".repeat(64), false);
    // The installed version is untouched and the upgrade can be retried.
    expect(screen.getByText("Upgrade preview")).toBeTruthy();
    const cards = screen.getAllByRole("article", { name: "@lab/evidence" });
    expect(within(cards[cards.length - 1]).getByText("v1.2.3")).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("offers nothing to do for the installed snapshot and warns when an upgrade would stop a package", async () => {
    vi.mocked(api.pluginsList).mockResolvedValue([enabled]);
    vi.mocked(api.pluginsPreview).mockResolvedValueOnce({ ...pkg, upgrade: upgradePlan({ change: "identical" }) });
    render(<PluginPackages projectPath={projectPath} language="en" onChanged={onChanged} />);
    await screen.findByRole("article", { name: "@lab/evidence" });
    await previewSource("en");
    await screen.findByText("This exact version is already installed; there is nothing to upgrade.");
    expect(screen.queryByRole("button", { name: /^Upgrade/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Install disabled" })).toBeNull();

    vi.mocked(api.pluginsPreview).mockResolvedValueOnce({ ...upgradePreview(upgradePlan()), canEnable: false, diagnostics: [{ code: "capability", message: "dsh-goal requires DeepSeek host", severity: "error" }] });
    fireEvent.click(screen.getByText("Preview"));
    expect(await screen.findByRole("button", { name: "Upgrade and disable" })).toBeTruthy();
    expect(screen.getByText(/the package is disabled by the upgrade/)).toBeTruthy();
  });

  it("shows a change an agent or an approval card made in the Chat", async () => {
    render(<PluginPackages projectPath={projectPath} language="en" onChanged={onChanged} />);
    await waitFor(() => expect(api.pluginsList).toHaveBeenCalledTimes(1));
    expect(api.bridgeBackendPluginChanges).toHaveBeenCalled();
    vi.mocked(api.pluginsList).mockResolvedValue([enabled]);
    window.dispatchEvent(new CustomEvent(api.PLUGINS_CHANGED_EVENT, { detail: "F:/elsewhere" }));
    window.dispatchEvent(new CustomEvent(api.PLUGINS_CHANGED_EVENT, { detail: String.raw`\\?\F:\project` }));
    await screen.findByRole("article", { name: "@lab/evidence" });
    expect(api.pluginsList).toHaveBeenCalledTimes(2);
  });

  it("hands plugin creation and repair to a new chat as drafts, sending nothing", async () => {
    useStore.setState({ tab: "settings", pendingNewChatDraft: null });
    const blocked: api.InstalledPlugin = {
      ...installed, name: "@lab/broken", canEnable: false, status: "blocked",
      diagnostics: [{ code: "capability", message: "transport http is not supported", severity: "error" }],
      lifecycle: lifecycle("blocked"),
    };
    vi.mocked(api.pluginsList).mockResolvedValue([blocked, enabled]);
    render(<PluginPackages projectPath={projectPath} language="en" onChanged={onChanged} />);
    await screen.findByRole("article", { name: "@lab/broken" });

    fireEvent.click(screen.getByRole("button", { name: "Ask AI to create a plugin" }));
    expect(useStore.getState().pendingNewChatDraft).toContain("somniq-plugin-development");
    expect(useStore.getState().tab).toBe("chat");

    // Only the package that cannot run offers a repair.
    expect(screen.getAllByRole("button", { name: "Ask AI to fix" })).toHaveLength(1);
    useStore.setState({ tab: "settings", pendingNewChatDraft: null });
    fireEvent.click(screen.getByRole("button", { name: "Ask AI to fix" }));
    const draft = useStore.getState().pendingNewChatDraft ?? "";
    expect(draft).toContain("@lab/broken");
    expect(draft).toContain("transport http is not supported");
    expect(useStore.getState().tab).toBe("chat");
    expect(api.pluginsSetEnabled).not.toHaveBeenCalled();
  });

  it("offers plugin creation from the empty state too", async () => {
    useStore.setState({ pendingNewChatDraft: null });
    render(<PluginPackages projectPath={projectPath} language="cn" onChanged={onChanged} />);
    await screen.findByText("还没有插件包");
    const buttons = screen.getAllByRole("button", { name: "让 AI 创建插件" });
    expect(buttons.length).toBe(2);
    fireEvent.click(buttons[1]);
    expect(useStore.getState().pendingNewChatDraft).toContain("帮我做一个插件");
  });
});
