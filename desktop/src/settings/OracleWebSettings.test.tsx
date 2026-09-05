// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  oracleWebAccountCreate,
  oracleWebAccountLogin,
  oracleWebAccountModelSet,
  oracleWebAccountRemove,
  oracleWebRoleSet,
  oracleWebRuntimeInstall,
  oracleWebStatus,
} from "../api/tauri";
import type { OracleWebStatusView } from "../types";
import OracleWebSettings from "./OracleWebSettings";

vi.mock("../api/tauri", () => ({
  oracleWebStatus: vi.fn(),
  oracleWebRuntimeInstall: vi.fn(),
  oracleWebAccountCreate: vi.fn(),
  oracleWebAccountLogin: vi.fn(),
  oracleWebAccountModelSet: vi.fn(),
  oracleWebAccountRemove: vi.fn(),
  oracleWebRoleSet: vi.fn(),
}));

vi.mock("../api/transport", () => ({
  hasNativeBackend: () => true,
}));

const ACCOUNT_ID = "00112233445566778899aabbccddeeff";
const SECOND_ACCOUNT_ID = "ffeeddccbbaa99887766554433221100";

const baseStatus = (): OracleWebStatusView => ({
  runtime: {
    status: "ready",
    source: "managed",
    version: "0.18.0",
    commandPath: "C:/SomniQ/oracle-mcp.js",
    nodePath: "C:/SomniQ/node.exe",
    installSupported: true,
    message: "Oracle is ready.",
  },
  browsers: [
    {
      id: "edge-1",
      name: "Microsoft Edge",
      kind: "edge",
      path: "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
      recommended: true,
    },
  ],
  accounts: [],
  consultAccountId: null,
  reviewerAccountId: null,
  imageAccountId: null,
  dataDir: "C:/SomniQ/oracle-web",
});

const statusWithAccount = (): OracleWebStatusView => ({
  ...baseStatus(),
  accounts: [
    {
      id: ACCOUNT_ID,
      displayName: "FPT",
      browserName: "Microsoft Edge",
      browserKind: "edge",
      browserPath: "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
      profilePath: `C:/SomniQ/oracle-web/accounts/${ACCOUNT_ID}/browser-profile`,
      createdAt: 1_700_000_000,
      lastLoginLaunchedAt: null,
      loginConfirmedAt: null,
      model: null,
    },
  ],
});

const statusWithAccounts = (): OracleWebStatusView => ({
  ...statusWithAccount(),
  accounts: [
    statusWithAccount().accounts[0],
    {
      ...statusWithAccount().accounts[0],
      id: SECOND_ACCOUNT_ID,
      displayName: "备用账号",
      profilePath: `C:/SomniQ/oracle-web/accounts/${SECOND_ACCOUNT_ID}/browser-profile`,
    },
  ],
});

describe("OracleWebSettings", () => {
  beforeEach(() => {
    vi.mocked(oracleWebStatus).mockResolvedValue(baseStatus());
    vi.mocked(oracleWebRuntimeInstall).mockResolvedValue(baseStatus());
    vi.mocked(oracleWebAccountCreate).mockResolvedValue(statusWithAccount());
    vi.mocked(oracleWebAccountLogin).mockResolvedValue({
      account: statusWithAccount().accounts[0],
      pid: 42,
      message: "opened",
    });
    vi.mocked(oracleWebAccountModelSet).mockImplementation(async ({ model }) => ({
      ...statusWithAccount().accounts[0],
      model: model ?? null,
    }));
    vi.mocked(oracleWebAccountRemove).mockResolvedValue(baseStatus());
    vi.mocked(oracleWebRoleSet).mockImplementation(async ({ role, accountId }) => ({
      ...statusWithAccount(),
      consultAccountId: role === "consult" ? accountId : null,
      reviewerAccountId: role === "reviewer" ? accountId : null,
      imageAccountId: role === "image" ? accountId : null,
    }));
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("creates an isolated account with a detected browser", async () => {
    render(<OracleWebSettings language="cn" />);

    expect(await screen.findByText("可用")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("例如：GPT 审稿账号"), {
      target: { value: "GPT 审稿账号" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建账号" }));

    await waitFor(() => {
      expect(oracleWebAccountCreate).toHaveBeenCalledWith({
        displayName: "GPT 审稿账号",
        browserPath: "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
      });
    });
    expect(await screen.findByRole("button", { name: "打开登录" })).toBeTruthy();
    expect(screen.getByText("待验证")).toBeTruthy();
  });

  it("saves an account default ChatGPT model", async () => {
    vi.mocked(oracleWebStatus).mockResolvedValue(statusWithAccount());
    render(<OracleWebSettings language="cn" />);

    fireEvent.change(await screen.findByRole("combobox", { name: "FPT · 默认模型" }), {
      target: { value: "gpt-5.6" },
    });

    await waitFor(() => {
      expect(oracleWebAccountModelSet).toHaveBeenCalledWith({
        accountId: ACCOUNT_ID,
        model: "gpt-5.6",
      });
    });
    expect(await screen.findByText("账号默认模型已保存。")).toBeTruthy();
  });

  it("offers installation when the optional Oracle runtime is missing", async () => {
    vi.mocked(oracleWebStatus).mockResolvedValue({
      ...baseStatus(),
      runtime: {
        status: "missing",
        source: "none",
        version: null,
        commandPath: null,
        nodePath: null,
        installSupported: true,
        message: "Oracle is not installed.",
      },
    });
    render(<OracleWebSettings language="cn" />);

    expect(await screen.findByText("未安装")).toBeTruthy();
    expect(screen.getByText("下一步：安装 Oracle 运行时")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "安装运行时" }));

    await waitFor(() => expect(oracleWebRuntimeInstall).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("运行时已安装。")).toBeTruthy();
  });

  it("offers an isolated managed runtime update when a system Oracle version is incompatible", async () => {
    vi.mocked(oracleWebStatus).mockResolvedValue({
      ...baseStatus(),
      runtime: {
        status: "incompatible",
        source: "system",
        version: "0.9.0",
        commandPath: "C:/Users/test/AppData/Roaming/npm/oracle-mcp.cmd",
        nodePath: null,
        installSupported: true,
        message: "Detected Oracle MCP 0.9.0, but SomniQ requires 0.18.0.",
      },
    });
    render(<OracleWebSettings language="cn" />);

    expect(await screen.findByText("版本不兼容")).toBeTruthy();
    expect(screen.getByText("v0.9.0")).toBeTruthy();
    expect(screen.getByText("下一步：更新 Oracle 运行时")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "更新运行时" }));

    await waitFor(() => expect(oracleWebRuntimeInstall).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("运行时已更新，账号和用途路由均已保留。")).toBeTruthy();
  });

  it("reports a compatible runtime as current without offering an unnecessary install", async () => {
    render(<OracleWebSettings language="cn" />);

    expect(await screen.findByText("已是当前兼容版本。运行时随 SomniQ 版本更新，不会静默升级到未经验证的上游版本。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "安装运行时" })).toBeNull();
    expect(screen.queryByRole("button", { name: "更新运行时" })).toBeNull();
  });

  it("binds the reviewer role explicitly", async () => {
    vi.mocked(oracleWebStatus).mockResolvedValue(statusWithAccount());
    render(<OracleWebSettings language="cn" />);

    const reviewer = await screen.findByRole("checkbox", { name: "FPT · 独立审稿" });
    fireEvent.click(reviewer);

    await waitFor(() => {
      expect(oracleWebRoleSet).toHaveBeenCalledWith({
        role: "reviewer",
        accountId: ACCOUNT_ID,
      });
    });
    expect(await screen.findByText("独立审稿已切换到 ChatGPT 网页账号，下一次审稿生效。")).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "FPT · 独立审稿" }) as HTMLInputElement).checked).toBe(true);
  });

  it("describes an unbound reviewer as the model-services fallback, not disabled", async () => {
    vi.mocked(oracleWebStatus).mockResolvedValue(statusWithAccount());
    render(<OracleWebSettings language="cn" />);

    const reviewer = (await screen.findByRole("checkbox", { name: "FPT · 独立审稿" })) as HTMLInputElement;
    expect(reviewer.checked).toBe(false);
    expect(screen.getByText("关闭时使用「模型服务」Reviewer")).toBeTruthy();
  });

  it("keeps a pending route selection visible while the backend saves it", async () => {
    vi.mocked(oracleWebStatus).mockResolvedValue(statusWithAccount());
    let resolveRole: ((status: OracleWebStatusView) => void) | undefined;
    vi.mocked(oracleWebRoleSet).mockImplementationOnce(
      () =>
        new Promise<OracleWebStatusView>((resolve) => {
          resolveRole = resolve;
        }),
    );
    render(<OracleWebSettings language="cn" />);

    const consult = (await screen.findByRole("checkbox", { name: "FPT · Chat 咨询" })) as HTMLInputElement;
    fireEvent.click(consult);

    expect(consult.checked).toBe(true);
    expect(consult.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("正在保存…")).toBeTruthy();

    resolveRole?.({ ...statusWithAccount(), consultAccountId: ACCOUNT_ID });
    await waitFor(() => expect(consult.getAttribute("aria-busy")).toBe("false"));
  });

  it("binds Chat webpage consultation so the next Chat turn can call it", async () => {
    vi.mocked(oracleWebStatus).mockResolvedValue(statusWithAccount());
    render(<OracleWebSettings language="cn" />);

    fireEvent.click(await screen.findByRole("checkbox", { name: "FPT · Chat 咨询" }));

    await waitFor(() => {
      expect(oracleWebRoleSet).toHaveBeenCalledWith({
        role: "consult",
        accountId: ACCOUNT_ID,
      });
    });
    expect((screen.getByRole("checkbox", { name: "FPT · Chat 咨询" }) as HTMLInputElement).checked).toBe(true);
  });

  it("releases a bound role back to unassigned", async () => {
    vi.mocked(oracleWebStatus).mockResolvedValue({
      ...statusWithAccount(),
      consultAccountId: ACCOUNT_ID,
    });
    render(<OracleWebSettings language="cn" />);

    fireEvent.click(await screen.findByRole("checkbox", { name: "FPT · Chat 咨询" }));

    await waitFor(() => {
      expect(oracleWebRoleSet).toHaveBeenCalledWith({ role: "consult", accountId: null });
    });
  });

  it("moves a capability route when another account is switched on", async () => {
    vi.mocked(oracleWebStatus).mockResolvedValue({
      ...statusWithAccounts(),
      imageAccountId: ACCOUNT_ID,
    });
    vi.mocked(oracleWebRoleSet).mockResolvedValue({
      ...statusWithAccounts(),
      imageAccountId: SECOND_ACCOUNT_ID,
    });
    render(<OracleWebSettings language="cn" />);

    const current = (await screen.findByRole("checkbox", { name: "FPT · 图片生成" })) as HTMLInputElement;
    const replacement = screen.getByRole("checkbox", { name: "备用账号 · 图片生成" }) as HTMLInputElement;
    expect(current.checked).toBe(true);
    expect(replacement.checked).toBe(false);

    fireEvent.click(replacement);

    await waitFor(() => {
      expect(oracleWebRoleSet).toHaveBeenCalledWith({ role: "image", accountId: SECOND_ACCOUNT_ID });
      expect(current.checked).toBe(false);
      expect(replacement.checked).toBe(true);
    });
  });

  it("requires confirmation before archiving an account", async () => {
    vi.mocked(oracleWebStatus).mockResolvedValue(statusWithAccount());
    render(<OracleWebSettings language="cn" />);

    fireEvent.click(await screen.findByRole("button", { name: "移除" }));
    fireEvent.click(screen.getByRole("button", { name: "确认移除" }));

    await waitFor(() => expect(oracleWebAccountRemove).toHaveBeenCalledWith(ACCOUNT_ID));
    expect(await screen.findByText("账号已移除，本地账号目录已归档。")).toBeTruthy();
  });
});
