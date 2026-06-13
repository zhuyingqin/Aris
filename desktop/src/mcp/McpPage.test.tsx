// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mcpConfigGet: vi.fn(),
  mcpConfigSet: vi.fn(),
  mcpConfigTest: vi.fn(),
}));

vi.mock("../api/tauri", () => ({
  isTauri: () => true,
  mcpConfigGet: mocks.mcpConfigGet,
  mcpConfigSet: mocks.mcpConfigSet,
  mcpConfigTest: mocks.mcpConfigTest,
}));

import McpPage from "./McpPage";
import { useStore } from "../store";

const view = {
  projectPath: "C:/ProjectA/.mcp.json",
  servers: [{
    name: "playwright",
    command: "npx.cmd",
    args: ["-y", "@playwright/mcp@latest"],
    env: {},
    requestTimeoutSecs: 300,
  }],
  mergedServers: [{
    name: "playwright",
    source: "project",
    transport: "stdio",
    command: "npx.cmd",
  }, {
    name: "remote-search",
    source: "user",
    transport: "http",
    command: null,
  }],
};

beforeEach(() => {
  useStore.setState({
    currentProject: {
      id: "project-a",
      name: "Project A",
      path: "C:/ProjectA",
      addedAt: 1,
      lastOpenedAt: 1,
    },
    error: null,
  });
  mocks.mcpConfigGet.mockReset().mockResolvedValue(view);
  mocks.mcpConfigSet.mockReset().mockResolvedValue(view);
  mocks.mcpConfigTest.mockReset().mockResolvedValue({
    ok: true,
    servers: [{
      name: "playwright",
      ok: true,
      transport: "stdio",
      tools: ["mcp__playwright__browser_navigate"],
      message: "Connected; 1 tool(s) discovered",
    }],
  });
});

afterEach(() => cleanup());

describe("MCP list and details", () => {
  it("opens editable details for a project STDIO MCP and saves changes", async () => {
    const user = userEvent.setup();
    render(<McpPage />);

    await user.click(await screen.findByRole("button", { name: /playwright/ }));
    expect(screen.getByText("可编辑")).toBeTruthy();
    expect(screen.getByDisplayValue("npx.cmd")).toBeTruthy();
    expect(screen.getByText(/配置文件存在不代表工具已经加载/)).toBeTruthy();

    const timeout = screen.getByLabelText("超时秒数");
    fireEvent.change(timeout, { target: { value: "600" } });
    await user.click(screen.getByRole("button", { name: "保存设置" }));

    await waitFor(() => expect(mocks.mcpConfigSet).toHaveBeenCalled());
    expect(mocks.mcpConfigSet.mock.calls[0][0][0].requestTimeoutSecs).toBe(600);
  });

  it("tests whether a configured MCP actually exposes tools", async () => {
    const user = userEvent.setup();
    render(<McpPage />);

    await user.click(await screen.findByRole("button", { name: /playwright/ }));
    await user.click(screen.getByRole("button", { name: "检测工具" }));

    expect(await screen.findByText("工具加载成功")).toBeTruthy();
    expect(screen.getByText("mcp__playwright__browser_navigate")).toBeTruthy();
  });

  it("shows inherited MCP details as read-only", async () => {
    const user = userEvent.setup();
    render(<McpPage />);

    await user.click(await screen.findByRole("button", { name: /remote-search/ }));

    expect(screen.getByText("只读")).toBeTruthy();
    expect(screen.getAllByText("用户配置")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "保存设置" })).toBeNull();
  });
});
