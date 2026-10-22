// @vitest-environment jsdom
//
// Runs Settings against a mocked native backend, which is where the two
// defects covered here are reachable: the browser-preview path short-circuits
// `save()` before it reloads the config, and never signs anybody out.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configGet, configSet, newapiBootstrap, newapiModels, newapiPaymentCatalog, newapiUsageLogs, profileStats } from "../api/tauri";
import { ACCOUNT_CACHE_KEY, readCachedAccount, readCachedUsageLogPages, subscribeCachedAccount, writeCachedAccount, writeCachedUsageLogPages } from "../accountCache";
import { useStore } from "../store";
import { SETTINGS_TAB_REQUEST_EVENT } from "../settingsTabRequest";
import Settings from "./Settings";
import { PREVIEW_SETTINGS_DATA } from "./settingsPreviewData";
import { writeCachedProfileStats } from "./profileStatsCache";
import type { ConfigView, ProfileStats } from "../types";

vi.mock("../api/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/tauri")>()),
  isTauri: () => true,
  configGet: vi.fn(),
  configSet: vi.fn(),
  newapiBootstrap: vi.fn(),
  newapiModels: vi.fn(),
  newapiUsageLogs: vi.fn(),
  newapiPaymentCatalog: vi.fn(),
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

  it("clears explicit OpenCode identity when choosing an account connection", async () => {
    let confirmed = { ...preview.configView, executorProvider: "opencode", reviewerProvider: "opencode" };
    vi.mocked(configGet).mockResolvedValue(confirmed);
    vi.mocked(configSet).mockImplementation(async (patch) => { confirmed = { ...confirmed, ...patch }; return confirmed; });
    render(<Settings />);
    const executor = await screen.findByRole("combobox", { name: "执行模型" });
    await waitFor(() => expect((executor as HTMLSelectElement).value).toBe("MiniMax-M3"));
    fireEvent.change(executor, { target: { value: "MiniMax-M2.7" } });
    await waitFor(() => expect(configSet).toHaveBeenCalledWith({ executorProvider: "openai", executorModel: "MiniMax-M2.7" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Reviewer 模型" }), { target: { value: "gpt-5.5" } });
    await waitFor(() => expect(configSet).toHaveBeenCalledWith({ reviewerProvider: "custom", reviewerModel: "gpt-5.5" }));
  });

  it("saves the review mode by itself, reads it back on the next visit, and keeps the confirmed mode when a save fails", async () => {
    let confirmed: ConfigView = { ...preview.configView, reviewMode: "thread" };
    vi.mocked(configGet).mockImplementation(async () => confirmed);
    vi.mocked(configSet).mockImplementation(async (patch) => { confirmed = { ...confirmed, ...patch }; return confirmed; });
    const first = render(<Settings />);
    const mode = await screen.findByRole("combobox", { name: "审查方式" }) as HTMLSelectElement;
    await waitFor(() => expect(mode.value).toBe("thread"));
    expect(screen.getByText(/只读工具自行核对项目文件/)).toBeTruthy();

    fireEvent.change(mode, { target: { value: "oneshot" } });
    await waitFor(() => expect(configSet).toHaveBeenCalledWith({ reviewMode: "oneshot" }));
    await waitFor(() => expect(mode.value).toBe("oneshot"));
    expect(screen.getByText(/Reviewer 模型不能调用工具时选此项/)).toBeTruthy();
    expect(screen.queryByText(/只读工具自行核对项目文件/)).toBeNull();

    first.unmount();
    sessionStorage.setItem("somniq-settings-tab-request", "models");
    render(<Settings />);
    const reopened = await screen.findByRole("combobox", { name: "审查方式" }) as HTMLSelectElement;
    await waitFor(() => expect(reopened.value).toBe("oneshot"));

    useStore.setState({ error: null });
    vi.mocked(configSet).mockRejectedValueOnce(new Error("Disk is read-only"));
    fireEvent.change(reopened, { target: { value: "thread" } });
    await waitFor(() => expect(useStore.getState().error).toBeTruthy());
    expect(reopened.value).toBe("oneshot");
    expect(confirmed.reviewMode).toBe("oneshot");
  });

  it("neither sends nor discards unsaved model drafts when the review mode changes", async () => {
    render(<Settings />);
    fireEvent.change(await screen.findByPlaceholderText("例如 http://127.0.0.1:10808"), { target: { value: "http://proxy.keep.test" } });
    fireEvent.change(screen.getByRole("combobox", { name: "审查方式" }), { target: { value: "oneshot" } });
    await waitFor(() => expect(configSet).toHaveBeenCalledWith({ reviewMode: "oneshot" }));
    // The draft goes out through its own auto-save, on its own.
    await waitFor(() => expect(configSet).toHaveBeenCalledWith(expect.objectContaining({ webProxyUrl: "http://proxy.keep.test" })));
    expect(vi.mocked(configSet).mock.calls.find(([patch]) => patch.webProxyUrl)?.[0]).not.toHaveProperty("reviewMode");
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

  it("opens membership purchasing from the native account overview", async () => {
    sessionStorage.setItem("somniq-settings-tab-request", "profile");
    const free = { ...preview.account, group: "default", subscriptionName: "", subscriptionDesc: "" };
    writeCachedAccount(free);
    vi.mocked(newapiBootstrap).mockResolvedValue(free);
    vi.mocked(newapiPaymentCatalog).mockResolvedValue({ userId: 17, purchaseEnabled: true,
      pagePayEnabled: true, studentCheckUnavailable: false, offers: [{ group: "go", planId: 8,
        priceFen: 1900, totalAmount: 30_000_000, originalFen: 2900, promotionFen: 1900,
        studentFen: null, priceKind: "promotion", revision: 2 }] });
    render(<Settings />);
    fireEvent.click(await screen.findByRole("button", { name: "购买会员" }));
    await screen.findByRole("button", { name: /Go.*19.00/ });
    expect(screen.getByRole("button", { name: "确认并前往支付宝支付" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("link", { name: "用户服务协议" }).getAttribute("href")).toBe("https://ensuanx.com/user-service-agreement.html?lang=zh");
    fireEvent.click(screen.getByRole("button", { name: "收起购买" }));
    expect(screen.queryByRole("button", { name: /Go.*19.00/ })).toBeNull();
  });

  it.each(["before mount", "while mounted"])("opens and reopens the membership panel from an account-menu request %s", async (timing) => {
    const member = { ...preview.account, group: "plus", subscriptionName: "Plus" };
    writeCachedAccount(member);
    vi.mocked(newapiBootstrap).mockResolvedValue(member);
    vi.mocked(newapiPaymentCatalog).mockResolvedValue({ userId: 17, purchaseEnabled: true,
      pagePayEnabled: true, studentCheckUnavailable: false, offers: ["go", "plus", "pro"].map((group, index) => ({
        group: group as "go" | "plus" | "pro", planId: index + 8, priceFen: 1900 + index * 2000,
        totalAmount: 30_000_000, originalFen: 2900 + index * 2000, promotionFen: 1900 + index * 2000,
        studentFen: null, priceKind: "promotion" as const, revision: 2,
      })) });
    if (timing === "before mount") sessionStorage.setItem("somniq-settings-tab-request", "membership");
    render(<Settings />);
    if (timing === "while mounted") act(() => window.dispatchEvent(new CustomEvent(SETTINGS_TAB_REQUEST_EVENT, { detail: "membership" })));
    await screen.findByRole("heading", { name: "会员升级" });
    await screen.findByRole("button", { name: /Pro.*59.00/ });
    expect(screen.getByRole("tab", { name: "个人资料" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "收起购买" }));
    expect(screen.queryByRole("heading", { name: "会员升级" })).toBeNull();
    act(() => window.dispatchEvent(new CustomEvent(SETTINGS_TAB_REQUEST_EVENT, { detail: "membership" })));
    await screen.findByRole("heading", { name: "会员升级" });
    expect(screen.getByRole("checkbox")).toHaveProperty("checked", false);
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

  it("publishes refreshed allowance to the menu and receives background balance updates", async () => {
    sessionStorage.setItem("somniq-settings-tab-request", "profile");
    const observer = vi.fn();
    const unsubscribe = subscribeCachedAccount(observer);
    try {
      const { container } = render(<Settings />);
      await waitFor(() => expect(newapiBootstrap).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(screen.getByRole("button", { name: "刷新" })).toHaveProperty("disabled", false));
      const updated = { ...preview.account, subscriptionQuota: 12_345_000, subscriptionUsedQuota: 17_655_000 };
      vi.mocked(newapiBootstrap).mockResolvedValueOnce(updated);
      fireEvent.click(screen.getByRole("button", { name: "刷新" }));
      await waitFor(() => expect(observer).toHaveBeenLastCalledWith(updated));
      const card = container.querySelector<HTMLElement>(".sp-usage-quota-card.subscription")!;
      expect(within(card).getByText("$24.69")).toBeTruthy();
      act(() => writeCachedAccount({ ...updated, subscriptionQuota: 10_000_000, subscriptionUsedQuota: 20_000_000 }));
      expect(within(card).getByText("$20.00")).toBeTruthy();
      expect(newapiBootstrap).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
    }
  });

  it("does not repopulate the account cache from a response arriving after logout", async () => {
    let finish!: (account: typeof preview.account) => void;
    vi.mocked(newapiBootstrap).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const { unmount } = render(<Settings />);
    await waitFor(() => expect(newapiBootstrap).toHaveBeenCalledTimes(1));
    act(() => useStore.getState().logout());
    unmount();
    await act(async () => { finish(preview.account); });
    expect(readCachedAccount()).toBeNull();
  });

  it("finishes loading when another window supersedes a pending account read", async () => {
    sessionStorage.setItem("somniq-settings-tab-request", "profile");
    let finish!: (account: typeof preview.account) => void;
    vi.mocked(newapiBootstrap).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    writeCachedAccount(preview.account);
    render(<Settings />);
    await waitFor(() => expect(newapiBootstrap).toHaveBeenCalledTimes(1));
    const updated = { ...preview.account, subscriptionQuota: 12_345_000 };
    const newValue = JSON.stringify(updated);
    act(() => {
      localStorage.setItem(ACCOUNT_CACHE_KEY, newValue);
      fireEvent(window, new StorageEvent("storage", { key: ACCOUNT_CACHE_KEY, newValue }));
    });
    await act(async () => { finish(preview.account); });
    await waitFor(() => expect(screen.getByRole("button", { name: "刷新" })).toHaveProperty("disabled", false));
    expect(readCachedAccount()).toEqual(updated);
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

  it("saves the research proxy without third-party API keys", async () => {
    render(<Settings />);

    const proxyInput = await screen.findByPlaceholderText("例如 http://127.0.0.1:10808");
    fireEvent.change(proxyInput, { target: { value: "http://proxy.draft.test" } });



    await waitFor(() => {
      expect(vi.mocked(configSet)).toHaveBeenCalledWith(
        expect.objectContaining({ webProxyUrl: "http://proxy.draft.test" }),
      );
    });
    await waitFor(() => {
      expect((proxyInput as HTMLInputElement).value).toBe("http://proxy.draft.test");
    });
  });

  it("drops cached usage-log pages on sign-out so the next account cannot see them", () => {
    writeCachedUsageLogPages({ 1: { page: 1, pageSize: 12, total: 1, items: [] } });
    expect(readCachedUsageLogPages()).toHaveProperty("1");

    useStore.getState().logout();

    expect(readCachedUsageLogPages()).toEqual({});
  });

  it("applies a Python environment without clearing unsaved model preferences", async () => {
    render(<Settings />);
    fireEvent.change(await screen.findByPlaceholderText("例如 http://127.0.0.1:10808"), { target: { value: "http://proxy.keep.test" } });
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


    await waitFor(() => expect(configSet).toHaveBeenLastCalledWith(expect.objectContaining({ webProxyUrl: "http://proxy.keep.test" })));
  });

  it("keeps the confirmed memory policy on failure and retries without losing model drafts", async () => {
    render(<Settings />);
    fireEvent.change(await screen.findByPlaceholderText("例如 http://127.0.0.1:10808"), { target: { value: "http://proxy.unsaved.test" } });
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


    await waitFor(() => expect(vi.mocked(configSet)).toHaveBeenLastCalledWith(expect.objectContaining({ webProxyUrl: "http://proxy.unsaved.test" })));
    expect(vi.mocked(configSet).mock.calls.find(([patch]) => patch.webProxyUrl === "http://proxy.unsaved.test")?.[0]).not.toHaveProperty("memoryWriteApproval");
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
    fireEvent.change(await screen.findByPlaceholderText("例如 http://127.0.0.1:10808"), { target: { value: "http://proxy.language.test" } });
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
    expect(screen.getByDisplayValue("http://proxy.language.test")).toBeTruthy();
  });
});
