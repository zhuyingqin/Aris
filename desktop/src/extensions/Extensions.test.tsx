// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  mcpConfigGet,
  mcpConfigSet,
  mcpConfigTest,
  oracleWebStatus,
  oracleWebRuntimeInstall,
  openExternalUrl,
  pptMasterDecksList,
  pptMasterInstall,
  pptMasterStatus,
  pptMasterUninstall,
  skillView,
} from "../api/tauri";
import { useStore } from "../store";
import type { McpConfigView, OracleWebStatusView } from "../types";
import Extensions from "./Extensions";

vi.mock("../api/tauri", () => ({
  isTauri: () => true,
  mcpConfigGet: vi.fn(),
  mcpConfigSet: vi.fn(),
  mcpConfigTest: vi.fn(),
  oracleWebStatus: vi.fn(),
  oracleWebRuntimeInstall: vi.fn(),
  oracleWebAccountCreate: vi.fn(),
  oracleWebAccountLogin: vi.fn(),
  oracleWebAccountRemove: vi.fn(),
  oracleWebRoleSet: vi.fn(),
  fileAssetUrl: vi.fn(),
  fileOpen: vi.fn(),
  fileReveal: vi.fn(),
  openExternalUrl: vi.fn(),
  pptMasterDecksList: vi.fn(),
  pptMasterStatus: vi.fn(),
  pptMasterInstall: vi.fn(),
  pptMasterUninstall: vi.fn(),
  skillView: vi.fn(),
  skillsList: vi.fn().mockResolvedValue([]),
}));

vi.mock("../api/transport", () => ({
  hasNativeBackend: () => true,
}));

const globalServer = {
  name: "global-server",
  command: "global-mcp",
  args: ["serve"],
  env: {},
  requestTimeoutSecs: 300,
};

const oracleRuntimeStatus = (runtimeStatus: "missing" | "ready" = "missing"): OracleWebStatusView => ({
  runtime: {
    status: runtimeStatus,
    source: runtimeStatus === "ready" ? "managed" : "none",
    version: runtimeStatus === "ready" ? "0.18.0" : null,
    commandPath: runtimeStatus === "ready" ? "C:/SomniQ/oracle-mcp.js" : null,
    nodePath: runtimeStatus === "ready" ? "C:/SomniQ/node.exe" : null,
    installSupported: true,
    message: runtimeStatus === "ready" ? "Oracle is ready." : "Oracle is not installed.",
  },
  browsers: [],
  accounts: [],
  consultAccountId: null,
  reviewerAccountId: null,
  imageAccountId: null,
  dataDir: "C:/SomniQ/oracle-web",
});

const pptStatus = (
  status: "missing" | "ready" | "broken" | "unmanaged" | "updateAvailable" = "missing",
) => ({
  status,
  installed: status !== "missing",
  managed: status === "ready" || status === "broken" || status === "updateAvailable",
  current: status === "ready" || status === "broken",
  dependenciesReady: status === "ready",
  installSupported: status !== "unmanaged",
  version: status === "missing" ? null : "6.3.0",
  availableVersion: "6.3.0",
  commit: status === "missing" ? null : "d3d81fe",
  skillPath: "C:/Users/test/.config/SomniQ/skills/ppt-master",
  pythonPath: status === "ready" ? "C:/Users/test/.config/SomniQ/skill-runtimes/ppt-master/6.3.0/Scripts/python.exe" : null,
  message: status,
} as const);

function view(oracleStatus: "missing" | "ready" = "missing"): McpConfigView {
  return {
    configPath: "C:/Users/test/.config/SomniQ/mcp.json",
    servers: [globalServer],
    mergedServers: [{
      name: globalServer.name,
      source: "global",
      transport: "stdio",
      command: globalServer.command,
    }],
    managedServers: [{
      name: "oracle-web",
      source: "managed",
      transport: "stdio",
      command: oracleStatus === "ready" ? "C:/SomniQ/oracle-mcp.js" : null,
      status: oracleStatus,
      message: oracleStatus === "ready" ? "Oracle is ready." : "Oracle is not installed.",
      installSupported: true,
      capabilities: ["ChatGptWebConsult", "ChatGptWebImage", "IndependentReview"],
    }],
    presets: [
      {
        id: "codex",
        available: true,
        message: "Ready: C:/bin/codex.cmd",
        server: {
          name: "codex",
          command: "C:/Windows/System32/cmd.exe",
          args: ["/D", "/S", "/C", "C:/bin/codex.cmd", "mcp-server"],
          env: {},
          requestTimeoutSecs: 900,
        },
      },
      { id: "claude", available: false, message: "Claude Code was not found.", server: null },
      {
        id: "playwright",
        available: false,
        message: "Bundled launcher missing.",
        installPath: "C:/SomniQ/resources/bin/aris-playwright-mcp.cmd",
        server: null,
      },
    ],
  };
}

describe("Extensions global MCP settings", () => {
  beforeEach(() => {
    useStore.setState({ language: "cn" });
    vi.mocked(mcpConfigGet).mockResolvedValue(view());
    vi.mocked(mcpConfigSet).mockImplementation(async (servers) => ({
      ...view(),
      servers,
      mergedServers: servers.map((server) => ({
        name: server.name,
        source: "global",
        transport: "stdio",
        command: server.command,
      })),
    }));
    vi.mocked(oracleWebRuntimeInstall).mockResolvedValue({} as never);
    vi.mocked(oracleWebStatus).mockResolvedValue(oracleRuntimeStatus());
    vi.mocked(mcpConfigTest).mockResolvedValue({ ok: true, servers: [] });
    vi.mocked(pptMasterDecksList).mockResolvedValue([]);
    vi.mocked(pptMasterStatus).mockResolvedValue(pptStatus());
    vi.mocked(pptMasterInstall).mockResolvedValue(pptStatus("ready"));
    vi.mocked(pptMasterUninstall).mockResolvedValue(pptStatus());
    vi.mocked(skillView).mockResolvedValue("# PPT Master");
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows one global configuration and the managed Oracle service", async () => {
    render(<Extensions />);

    expect(await screen.findByText("已配置的 MCP")).toBeTruthy();
    expect(screen.getByText(/SomniQ\/mcp\.json/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /global-server/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /oracle-web/ })).toBeTruthy();
  });

  it("edits a SomniQ global server instead of a project file", async () => {
    render(<Extensions />);
    fireEvent.click(await screen.findByRole("button", { name: /global-server/ }));

    fireEvent.change(screen.getByLabelText("命令"), { target: { value: "global-mcp-v2" } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));

    await waitFor(() => expect(mcpConfigSet).toHaveBeenCalledWith([
      expect.objectContaining({ name: "global-server", command: "global-mcp-v2" }),
    ]));
  });

  it("keeps a successful verification visible after closing and reopening details", async () => {
    vi.mocked(mcpConfigTest).mockResolvedValue({
      ok: true,
      servers: [{
        name: "global-server",
        ok: true,
        transport: "stdio",
        tools: ["global-server__tool"],
        message: "Connected; 1 tool(s) discovered",
      }],
    });
    render(<Extensions />);
    fireEvent.click(await screen.findByRole("button", { name: /global-server/ }));
    expect((screen.getByRole("button", { name: "已保存" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "检测工具" }));
    expect(await screen.findByText("工具加载成功")).toBeTruthy();
    const drawerClose = document.querySelector<HTMLButtonElement>(".ext-drawer-close");
    expect(drawerClose).not.toBeNull();
    fireEvent.click(drawerClose!);
    expect(screen.getByText("已验证")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /global-server/ }));
    expect(screen.getByText("工具加载成功")).toBeTruthy();
  });

  it("restores a verification result persisted by the backend", async () => {
    const persisted = view();
    persisted.verification = {
      testedAt: 1_700_000_000,
      result: {
        ok: true,
        servers: [{
          name: "global-server",
          ok: true,
          transport: "stdio",
          tools: ["global-server__tool"],
          message: "Connected; 1 tool(s) discovered",
        }],
      },
    };
    vi.mocked(mcpConfigGet).mockResolvedValue(persisted);
    render(<Extensions />);

    expect(await screen.findByText("已验证")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /global-server/ }));
    expect(screen.getByText("工具加载成功")).toBeTruthy();
  });

  it("hosts the full Oracle account and routing settings inside MCP details", async () => {
    vi.mocked(oracleWebRuntimeInstall).mockResolvedValue(oracleRuntimeStatus("ready"));
    render(<Extensions />);
    fireEvent.click(await screen.findByRole("button", { name: /oracle-web/ }));

    expect(await screen.findByText("ChatGPT 网页自动化")).toBeTruthy();
    const closeButton = screen
      .getAllByRole("button", { name: "关闭" })
      .find((button) => button.querySelector('svg[data-icon="close"]'));
    expect(closeButton).toBeTruthy();
    expect(screen.getByPlaceholderText("例如：GPT 审稿账号")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "安装运行时" }));

    await waitFor(() => expect(oracleWebRuntimeInstall).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText("运行时已安装。")).toBeTruthy());
  });

  it("adds only a backend-resolved available preset", async () => {
    render(<Extensions />);
    fireEvent.click(await screen.findByRole("button", { name: "添加" }));

    await waitFor(() => expect(mcpConfigSet).toHaveBeenCalledWith([
      globalServer,
      expect.objectContaining({
        name: "codex",
        command: "C:/Windows/System32/cmd.exe",
      }),
    ]));
    expect(screen.getAllByRole("button", { name: "本机不可用" })).toHaveLength(2);
    expect(screen.getByText("内置路径")).toBeTruthy();
    expect(screen.getByText("C:/SomniQ/resources/bin/aris-playwright-mcp.cmd")).toBeTruthy();
  });

  it("installs the pinned PPT Master Skill and refreshes the skill list", async () => {
    render(<Extensions />);
    fireEvent.click(await screen.findByRole("tab", { name: "技能" }));

    expect(await screen.findByText("PPT Master")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "安装" }));

    await waitFor(() => expect(pptMasterInstall).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/独立 Python 环境已就绪/)).toBeTruthy());
  });

  it("opens the project slide preview from the managed Skill card", async () => {
    render(<Extensions />);
    fireEvent.click(await screen.findByRole("tab", { name: "技能" }));
    fireEvent.click(await screen.findByRole("button", { name: "幻灯片预览" }));

    expect(await screen.findByRole("dialog", { name: "PPT Master 幻灯片预览" })).toBeTruthy();
    expect(await screen.findByText("还没有发现可预览的幻灯片")).toBeTruthy();
  });

  it("does not offer to overwrite an unmanaged ppt-master Skill", async () => {
    vi.mocked(pptMasterStatus).mockResolvedValue(pptStatus("unmanaged"));
    render(<Extensions />);
    fireEvent.click(await screen.findByRole("tab", { name: "技能" }));

    expect(await screen.findByText(/不会覆盖/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "安装" })).toBeNull();
    expect(screen.queryByRole("button", { name: "卸载" })).toBeNull();
  });

  it("updates an older managed PPT Master through the same audited installer", async () => {
    vi.mocked(pptMasterStatus).mockResolvedValue(pptStatus("updateAvailable"));
    render(<Extensions />);
    fireEvent.click(await screen.findByRole("tab", { name: "技能" }));
    fireEvent.click(await screen.findByRole("button", { name: "更新" }));

    await waitFor(() => expect(pptMasterInstall).toHaveBeenCalledTimes(1));
  });

  it("requires confirmation before removing the managed Skill and runtime", async () => {
    vi.mocked(pptMasterStatus).mockResolvedValue(pptStatus("ready"));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Extensions />);
    fireEvent.click(await screen.findByRole("tab", { name: "技能" }));
    fireEvent.click(await screen.findByRole("button", { name: "卸载" }));

    await waitFor(() => expect(pptMasterUninstall).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("独立 Python 环境"));
  });

  // The regression this whole change exists for: the installer used to reject
  // with an English string carrying a Python traceback, and the card rendered
  // it verbatim into a Chinese UI.
  it("explains a failed install in the UI language and offers the remedy", async () => {
    vi.mocked(pptMasterStatus).mockResolvedValue(pptStatus("missing"));
    vi.mocked(pptMasterInstall).mockRejectedValue({
      code: "pythonMissing",
      params: { command: "python" },
      detail: "The system cannot find the file specified. (os error 2)",
      fix: { kind: "openUrl", url: "https://www.python.org/downloads/" },
    });
    render(<Extensions />);
    fireEvent.click(await screen.findByRole("tab", { name: "技能" }));
    fireEvent.click(await screen.findByRole("button", { name: "安装" }));

    expect(await screen.findByText(/找不到 Python 解释器/)).toBeTruthy();
    // The raw subprocess text is still reachable, but only as evidence.
    expect(screen.getByText(/os error 2/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "前往下载" })).toBeTruthy();
    // The old failure mode: never render the rejection object as a string.
    expect(screen.queryByText(/\[object Object\]/)).toBeNull();
  });

  it("routes a failure's remedy to the matching action", async () => {
    vi.mocked(pptMasterStatus).mockResolvedValue(pptStatus("missing"));
    vi.mocked(pptMasterInstall).mockRejectedValue({
      code: "pythonMissing",
      params: {},
      detail: "",
      fix: { kind: "openUrl", url: "https://www.python.org/downloads/" },
    });
    render(<Extensions />);
    fireEvent.click(await screen.findByRole("tab", { name: "技能" }));
    fireEvent.click(await screen.findByRole("button", { name: "安装" }));
    fireEvent.click(await screen.findByRole("button", { name: "前往下载" }));

    await waitFor(() =>
      expect(openExternalUrl).toHaveBeenCalledWith("https://www.python.org/downloads/"),
    );
  });

  // A rejection that is not ours must still surface somewhere, not vanish.
  // The shared banner lives in the app shell, not in this component, so the
  // assertion reads the store rather than the rendered tree.
  it("falls back to the shared error banner for an unstructured rejection", async () => {
    vi.mocked(pptMasterStatus).mockResolvedValue(pptStatus("missing"));
    vi.mocked(pptMasterInstall).mockRejectedValue("transport closed");
    render(<Extensions />);
    fireEvent.click(await screen.findByRole("tab", { name: "技能" }));
    fireEvent.click(await screen.findByRole("button", { name: "安装" }));

    await waitFor(() =>
      expect(useStore.getState().error).toEqual(expect.stringContaining("transport closed")),
    );
    // And it must not have been mistaken for a structured failure.
    expect(screen.queryByRole("button", { name: "前往下载" })).toBeNull();
  });
});
