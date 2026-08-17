// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  mcpConfigGet,
  mcpConfigSet,
  mcpConfigTest,
  oracleWebStatus,
  oracleWebRuntimeInstall,
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
      { id: "playwright", available: false, message: "Bundled launcher missing.", server: null },
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
  });
});
