// @vitest-environment jsdom
//
// Runs Settings against a mocked native backend, which is where the two
// defects covered here are reachable: the browser-preview path short-circuits
// `save()` before it reloads the config, and never signs anybody out.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configGet, configSet, newapiBootstrap, newapiModels, newapiUsageLogs, profileStats } from "../api/tauri";
import { readCachedUsageLogPages, writeCachedUsageLogPages } from "../accountCache";
import { useStore } from "../store";
import { SETTINGS_TAB_REQUEST_EVENT } from "../settingsTabRequest";
import Settings from "./Settings";
import { PREVIEW_SETTINGS_DATA } from "./settingsPreviewData";
import { writeCachedProfileStats } from "./profileStatsCache";
import type { ProfileStats } from "../types";

vi.mock("../api/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/tauri")>()),
  isTauri: () => true,
  configGet: vi.fn(),
  configSet: vi.fn(),
  newapiBootstrap: vi.fn(),
  newapiModels: vi.fn(),
  newapiUsageLogs: vi.fn(),
  profileStats: vi.fn(),
  newapiLogout: vi.fn(async () => undefined),
}));

vi.mock("../api/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/transport")>()),
  hasNativeBackend: () => true,
}));

const preview = PREVIEW_SETTINGS_DATA.cn;
const emptyStats: ProfileStats = {
  cumulativeTokens: 0, peakDailyTokens: 0, totalTurns: 0, activeDays: 0,
  currentStreak: 0, longestStreak: 0, longestTaskSeconds: null,
  daily: [], byModel: [], topSkills: [], skillsExplored: 0, toolCalls: 0,
  topReasoningEffort: null, metaLoggingEnabled: false, since: null,
};

describe("Settings against a native backend", () => {
  beforeEach(() => {
    vi.mocked(configGet).mockResolvedValue(preview.configView);
    vi.mocked(configSet).mockImplementation(async (patch) => ({ ...preview.configView, ...patch }));
    vi.mocked(newapiBootstrap).mockResolvedValue(preview.account);
    vi.mocked(newapiModels).mockResolvedValue(preview.configView.managedModels ?? []);
    vi.mocked(newapiUsageLogs).mockReset().mockResolvedValue(preview.usageLogs);
    vi.mocked(profileStats).mockResolvedValue(emptyStats);
    writeCachedProfileStats(null);
    sessionStorage.setItem("somniq-settings-tab-request", "models");
    useStore.setState({ language: "cn" });
  });

  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    writeCachedUsageLogPages({});
    writeCachedProfileStats(null);
    vi.clearAllMocks();
  });

  it("shows cached Profile statistics before settings configuration finishes loading", async () => {
    sessionStorage.setItem("somniq-settings-tab-request", "profile");
    writeCachedProfileStats({ stats: emptyStats, updatedAt: Date.now() });
    let finish!: (view: typeof preview.configView) => void;
    vi.mocked(configGet).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const { container } = render(<Settings />);
    expect(screen.getByText("累计令牌数")).toBeTruthy();
    expect(container.querySelector(".sp-profile-loading")).toBeNull();
    expect(profileStats).not.toHaveBeenCalled();
    await act(async () => { finish(preview.configView); });

    fireEvent.click(screen.getByRole("tab", { name: "每周" }));
    fireEvent.click(screen.getByRole("tab", { name: "常规" }));
    fireEvent.click(screen.getByRole("tab", { name: "个人资料" }));
    expect(screen.getByRole("tab", { name: "每周" }).getAttribute("aria-selected")).toBe("true");
    await act(async () => {});
    expect(profileStats).not.toHaveBeenCalled();
  });

  it("shows account balances and call details in Profile with one copy of the identity", async () => {
    sessionStorage.setItem("somniq-settings-tab-request", "profile");
    const { container } = render(<Settings />);
    await waitFor(() => expect(container.querySelectorAll(".sp-usage-row-call:not(.sp-usage-row-head)")).toHaveLength(preview.usageLogs.items.length));
    const profilePage = within(screen.getByRole("region", { name: "个人资料" }));
    expect(profilePage.getAllByText(preview.account.displayName)).toHaveLength(1);
    expect(profilePage.getAllByText(preview.account.subscriptionName!)).toHaveLength(1);
    expect(profilePage.getAllByText("分组 default")).toHaveLength(1);
    expect(profilePage.getAllByText("账户余额")).toHaveLength(1);
    expect(profilePage.getAllByText("订阅余额")).toHaveLength(1);
    expect(profilePage.getByText("调用明细")).toBeTruthy();
    const callDetails = container.querySelector(".sp-usage-detail-panel")!;
    expect(callDetails.parentElement?.lastElementChild).toBe(callDetails);
    const balances = container.querySelector(".sp-usage-hero")!;
    const activity = container.querySelector(".sp-profile-activity")!;
    const models = container.querySelector(".sp-profile-models")!;
    expect(balances.compareDocumentPosition(activity) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(models.compareDocumentPosition(callDetails) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(profilePage.getByRole("button", { name: "刷新" })).toBeTruthy();
    expect(profilePage.getByRole("button", { name: "退出登录" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "账户与用量" })).toBeNull();
    expect(container.querySelector('[data-settings-page="account"]')).toBeNull();
    expect(container.querySelector(".sp-account-avatar")).toBeNull();
    expect(newapiUsageLogs).toHaveBeenCalledTimes(1);
    expect(newapiUsageLogs).toHaveBeenCalledWith(1, 12);
  });

  it("retains call pagination across category switches and refreshes account data from Profile", async () => {
    sessionStorage.setItem("somniq-settings-tab-request", "profile");
    vi.mocked(newapiUsageLogs).mockImplementation(async (page) => ({ ...preview.usageLogs, total: 13, page,
      items: page === 1 ? preview.usageLogs.items : [{ ...preview.usageLogs.items[0], id: "page-two-call", model: "page-two-model" }],
    }));
    render(<Settings />);
    await waitFor(() => expect(screen.getByRole("button", { name: "下一页" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await screen.findByText("page-two-model");
    expect(newapiUsageLogs).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("tab", { name: "常规" }));
    fireEvent.click(screen.getByRole("tab", { name: "个人资料" }));
    expect(screen.getByText("page-two-model")).toBeTruthy();
    await act(async () => {});
    expect(newapiUsageLogs).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "上一页" }));
    await act(async () => {});
    expect(screen.queryByText("page-two-model")).toBeNull();
    expect(newapiUsageLogs).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await screen.findByText("page-two-model");
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(newapiUsageLogs).toHaveBeenCalledTimes(3));
    expect(newapiUsageLogs).toHaveBeenLastCalledWith(1, 12);
    expect(newapiBootstrap).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("page-two-model")).toBeNull();
  });

  it("does not duplicate pending call requests when Profile is hidden and reopened", async () => {
    sessionStorage.setItem("somniq-settings-tab-request", "profile");
    let finish!: (page: typeof preview.usageLogs) => void;
    vi.mocked(newapiUsageLogs).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const { container } = render(<Settings />);
    await waitFor(() => expect(newapiUsageLogs).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("tab", { name: "常规" }));
    fireEvent.click(screen.getByRole("tab", { name: "个人资料" }));
    expect(newapiUsageLogs).toHaveBeenCalledTimes(1);
    await act(async () => { finish(preview.usageLogs); });
    expect(container.querySelectorAll(".sp-usage-row-call:not(.sp-usage-row-head)")).toHaveLength(preview.usageLogs.items.length);
  });

  it("discards a pending call response after logout and unmount instead of refilling the account cache", async () => {
    sessionStorage.setItem("somniq-settings-tab-request", "profile");
    let finish!: (page: typeof preview.usageLogs) => void;
    vi.mocked(newapiUsageLogs).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const { unmount } = render(<Settings />);
    await waitFor(() => expect(newapiUsageLogs).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    unmount();
    await act(async () => { finish(preview.usageLogs); });
    expect(readCachedUsageLogPages()).toEqual({});
  });

  it("clears API-key drafts after saving the connection configuration", async () => {
    render(<Settings />);

    const scopusInput = await screen.findByPlaceholderText("粘贴 Elsevier 密钥");
    fireEvent.change(scopusInput, { target: { value: "scopus-draft" } });



    await waitFor(() => {
      expect(vi.mocked(configSet)).toHaveBeenCalledWith(
        expect.objectContaining({ scopusApiKey: "scopus-draft" }),
      );
    });
    await waitFor(() => {
      expect((scopusInput as HTMLInputElement).value).toBe("");
    });
  });

  it("drops cached usage-log pages on sign-out so the next account cannot see them", () => {
    writeCachedUsageLogPages({ 1: { page: 1, pageSize: 12, total: 1, items: [] } });
    expect(readCachedUsageLogPages()).toHaveProperty("1");

    useStore.getState().logout();

    expect(readCachedUsageLogPages()).toEqual({});
  });

  it("applies a Python environment without clearing unsaved model connection keys", async () => {
    render(<Settings />);
    fireEvent.change(await screen.findByPlaceholderText("粘贴 Elsevier 密钥"), { target: { value: "keep-scopus-draft" } });
    fireEvent.click(screen.getByRole("tab", { name: "关于与环境" }));
    const input = screen.getByRole("textbox", { name: "首选 Python / Conda 环境" });
    fireEvent.change(input, { target: { value: "C:/Conda/research" } });
    const apply = await screen.findByRole("button", { name: "使用此环境" });
    await waitFor(() => expect(apply).toHaveProperty("disabled", false));
    fireEvent.click(apply);
    await screen.findByText("已应用");
    expect(configSet).toHaveBeenLastCalledWith({ pythonEnvironmentPath: "C:/Conda/research" });
    expect(screen.queryByRole("button", { name: "使用此环境" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "模型服务" }));


    await waitFor(() => expect(configSet).toHaveBeenLastCalledWith(expect.objectContaining({ scopusApiKey: "keep-scopus-draft" })));
  });

  it("keeps the confirmed memory policy on failure and retries without losing model drafts", async () => {
    render(<Settings />);
    fireEvent.change(await screen.findByPlaceholderText("粘贴 Elsevier 密钥"), { target: { value: "unsaved-key" } });
    fireEvent.click(screen.getByRole("tab", { name: "常规" }));
    const group = within(screen.getByRole("radiogroup", { name: "记忆策略" }));
    const previous = group.getAllByRole("radio").find((radio) => radio.getAttribute("aria-checked") === "true")!;
    const target = group.getAllByRole("radio").find((radio) => radio !== previous)!;
    vi.mocked(configSet).mockRejectedValueOnce(new Error("Disk is read-only"));
    fireEvent.click(target);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("已保留原设置"));
    expect(previous.getAttribute("aria-checked")).toBe("true");
    expect(target.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText("记忆策略已保存");
    expect(target.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "模型服务" }));


    await waitFor(() => expect(vi.mocked(configSet)).toHaveBeenLastCalledWith(expect.objectContaining({ scopusApiKey: "unsaved-key" })));
    expect(vi.mocked(configSet).mock.calls.find(([patch]) => patch.scopusApiKey === "unsaved-key")?.[0]).not.toHaveProperty("memoryWriteApproval");
  });

  it("prevents duplicate writes and retains an in-flight policy change across tab switches", async () => {
    sessionStorage.setItem("somniq-settings-tab-request", "general");
    render(<Settings />);
    const group = within(await screen.findByRole("radiogroup", { name: "记忆策略" }));
    const target = group.getAllByRole("radio").find((radio) => radio.getAttribute("aria-checked") === "false")!;
    const next = target.textContent === "写入前确认";
    let finish!: (view: typeof preview.configView) => void;
    vi.mocked(configSet).mockClear();
    vi.mocked(configSet).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    fireEvent.click(target);
    fireEvent.click(target);
    expect(target).toHaveProperty("disabled", true);
    expect(vi.mocked(configSet)).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("tab", { name: "模型服务" }));
    finish({ ...preview.configView, memoryWriteApproval: next });
    await waitFor(() => expect(vi.mocked(configSet)).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("tab", { name: "常规" }));
    await screen.findByText("记忆策略已保存");
    expect(screen.getByRole("radio", { name: target.textContent! }).getAttribute("aria-checked")).toBe("true");
  });

  it("reports language failures locally and only applies a confirmed language without clearing connection drafts", async () => {
    render(<Settings />);
    fireEvent.change(await screen.findByPlaceholderText("粘贴 Elsevier 密钥"), { target: { value: "keep-this-draft" } });
    fireEvent.click(screen.getByRole("tab", { name: "常规" }));
    vi.mocked(configSet).mockClear();
    vi.mocked(configSet).mockRejectedValueOnce(new Error("Disk is read-only"));
    fireEvent.click(screen.getByRole("radio", { name: "English" }));
    expect(screen.getByRole("radio", { name: "English" })).toHaveProperty("disabled", true);
    await screen.findByRole("alert");
    expect(useStore.getState().language).toBe("cn");
    expect(screen.queryByText("已保存")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText("Saved");
    expect(useStore.getState().language).toBe("en");
    expect(vi.mocked(configSet).mock.calls).toEqual([[{ language: "en" }], [{ language: "en" }]]);
    // Use the stable category request contract so translations do not couple this test to nav copy.
    fireEvent(window, new CustomEvent(SETTINGS_TAB_REQUEST_EVENT, { detail: "models" }));
    await waitFor(() => expect(screen.queryByText("Saved")).toBeNull());
    expect(screen.getByDisplayValue("keep-this-draft")).toBeTruthy();
  });
});
