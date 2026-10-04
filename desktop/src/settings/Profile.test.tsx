// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NewApiAccount } from "../api/tauri";
import { profileStats } from "../api/tauri";
import { PROFILE_AVATAR_CACHE_KEY, writeProfileAvatar } from "../profileAvatar";
import type { ProfileStats } from "../types";
import Profile from "./Profile";
import { PROFILE_STATS_CACHE_KEY, writeCachedProfileStats } from "./profileStatsCache";

const mocks = vi.hoisted(() => ({ backendAvailable: false }));

vi.mock("../api/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/transport")>()),
  hasNativeBackend: () => mocks.backendAvailable,
}));

vi.mock("../api/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/tauri")>()),
  profileStats: vi.fn(),
}));

const account: NewApiAccount = {
  username: "real-user",
  displayName: "Real Researcher",
  role: 1,
  isAdmin: false,
  subscriptionName: "Research",
  subscriptionDesc: "",
  subscriptionQuota: 0,
  subscriptionUsedQuota: 0,
  group: "default",
  groupDesc: "",
  groupRatio: "1",
  quota: 0,
  usedQuota: 0,
  models: [],
  model: "gpt-5.5",
};

const stats: ProfileStats = {
  cumulativeTokens: 12_000,
  peakDailyTokens: 1_200,
  totalTurns: 3,
  activeDays: 1,
  currentStreak: 1,
  longestStreak: 1,
  longestTaskSeconds: 7,
  daily: [{ date: "2026-08-26", tokens: 1_200, turns: 3 }],
  byModel: [{ model: "gpt-5.5", provider: "openai", tokens: 12_000, turns: 3 }],
  topSkills: [{ name: "research-wiki", runs: 2 }],
  skillsExplored: 1,
  toolCalls: 4,
  topReasoningEffort: "high",
  metaLoggingEnabled: true,
  since: 1_777_000_000,
};

describe("Settings Profile", () => {
  beforeEach(() => {
    mocks.backendAvailable = false;
    window.localStorage.clear();
    writeCachedProfileStats(null);
    vi.mocked(profileStats).mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    writeCachedProfileStats(null);
    window.localStorage.clear();
  });

  it("never presents preview identity or generated activity as real data", () => {
    writeCachedProfileStats({ stats, updatedAt: Date.now() });
    render(<Profile account={account} language="cn" />);

    expect(screen.getByText("未登录")).toBeTruthy();
    expect(screen.queryByText("Real Researcher")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("暂时无法读取本机活动统计。");
    expect(screen.queryByText("累计令牌数")).toBeNull();
    expect(profileStats).not.toHaveBeenCalled();
  });

  it("renders the account and activity returned by the real backend", async () => {
    mocks.backendAvailable = true;
    vi.mocked(profileStats).mockResolvedValue(stats);

    render(<Profile account={account} language="cn" />);

    expect(screen.getByText("Real Researcher")).toBeTruthy();
    expect(screen.getByText("@real-user")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("1.2万")).toBeTruthy());
    expect(screen.getByText("7 秒")).toBeTruthy();
    expect(screen.getByText("/research-wiki")).toBeTruthy();
    expect(screen.queryByText("快速模式")).toBeNull();
  });

  it("loads and removes a locally persisted custom avatar", () => {
    const avatar = "data:image/webp;base64,dGVzdA==";
    expect(writeProfileAvatar(avatar)).toBe(true);

    const { container } = render(<Profile account={account} language="cn" />);
    expect(container.querySelector(".sp-profile-avatar img")?.getAttribute("src")).toBe(avatar);

    fireEvent.click(screen.getByRole("button", { name: "移除" }));
    expect(window.localStorage.getItem(PROFILE_AVATAR_CACHE_KEY)).toBeNull();
    expect(container.querySelector(".sp-profile-avatar img")).toBeNull();
  });

  it("preserves the last snapshot on refresh failure and recovers on retry", async () => {
    mocks.backendAvailable = true;
    vi.useFakeTimers();
    vi.mocked(profileStats).mockResolvedValueOnce(stats).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ ...stats, toolCalls: 9 });
    render(<Profile account={account} language="en" />);
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.getByText(/Refresh failed/)).toBeTruthy();
    expect(screen.getByText("/research-wiki")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.queryByText(/Refresh failed/)).toBeNull();
    expect(profileStats).toHaveBeenCalledTimes(3);
    expect(screen.getByText("9")).toBeTruthy();
  });

  it("refreshes on focus and releases listeners when unmounted", async () => {
    mocks.backendAvailable = true;
    vi.useFakeTimers();
    vi.mocked(profileStats).mockResolvedValue(stats);
    const { unmount } = render(<Profile account={account} language="en" />);
    await act(async () => {});
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(profileStats).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 30_000);
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(profileStats).toHaveBeenCalledTimes(2);
    unmount();
    window.dispatchEvent(new Event("focus"));
    expect(profileStats).toHaveBeenCalledTimes(2);
  });

  it("shows readable activity without a partial coverage banner", async () => {
    mocks.backendAvailable = true;
    vi.mocked(profileStats).mockResolvedValue({ ...stats, partialData: true });
    render(<Profile account={account} language="en" accountError="Connection failed" />);
    await screen.findByText("gpt-5.5");
    expect(screen.queryByText(/Some historical records could not be read/)).toBeNull();
    expect(screen.getByText("gpt-5.5")).toBeTruthy();
    expect(screen.getByText("/research-wiki")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Account refresh failed");
  });

  it("refreshes every 30 seconds without overlapping a pending request", async () => {
    mocks.backendAvailable = true;
    vi.useFakeTimers();
    let resolve!: (value: ProfileStats) => void;
    vi.mocked(profileStats).mockReturnValueOnce(new Promise((done) => { resolve = done; })).mockResolvedValue(stats);
    const { unmount } = render(<Profile account={account} language="en" />);
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(profileStats).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(stats); });
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(profileStats).toHaveBeenCalledTimes(2);
    unmount();
    vi.advanceTimersByTime(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("renders cached activity immediately on re-entry without another scan", async () => {
    mocks.backendAvailable = true;
    vi.mocked(profileStats).mockResolvedValue(stats);
    const first = render(<Profile account={account} language="en" />);
    await screen.findByText("/research-wiki");
    first.unmount();

    render(<Profile account={account} language="en" />);
    expect(screen.getByText("/research-wiki")).toBeTruthy();
    expect(screen.queryByText("Loading…")).toBeNull();
    await act(async () => {});
    expect(profileStats).toHaveBeenCalledTimes(1);
  });

  it("restores a persisted snapshot and refreshes stale activity in the background", async () => {
    mocks.backendAvailable = true;
    window.localStorage.setItem(PROFILE_STATS_CACHE_KEY, JSON.stringify({ stats, updatedAt: Date.now() - 60_000 }));
    let resolve!: (value: ProfileStats) => void;
    vi.mocked(profileStats).mockReturnValue(new Promise((done) => { resolve = done; }));
    render(<Profile account={account} language="en" />);
    expect(screen.getByText("/research-wiki")).toBeTruthy();
    expect(screen.getByText("12.0K")).toBeTruthy();
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(profileStats).toHaveBeenCalledTimes(1);
    await act(async () => { resolve({ ...stats, cumulativeTokens: 24_000 }); });
    expect(screen.getByText("24.0K")).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem(PROFILE_STATS_CACHE_KEY)!).stats.cumulativeTokens).toBe(24_000);
  });

  it("shares a pending scan across unmounts and caches a result after the page closes", async () => {
    mocks.backendAvailable = true;
    let resolve!: (value: ProfileStats) => void;
    vi.mocked(profileStats).mockReturnValue(new Promise((done) => { resolve = done; }));
    const first = render(<Profile account={account} language="en" />);
    first.unmount();
    const second = render(<Profile account={account} language="en" />);
    expect(profileStats).toHaveBeenCalledTimes(1);
    second.unmount();
    await act(async () => { resolve(stats); });
    render(<Profile account={account} language="en" />);
    expect(screen.getByText("/research-wiki")).toBeTruthy();
    await act(async () => {});
    expect(profileStats).toHaveBeenCalledTimes(1);
  });

  it("keeps the heatmap mode while inactive and stops hidden category polling", async () => {
    mocks.backendAvailable = true;
    vi.useFakeTimers();
    vi.mocked(profileStats).mockResolvedValue(stats);
    const { rerender } = render(<Profile account={account} language="en" />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("tab", { name: "Weekly" }));
    rerender(<Profile account={account} language="en" active={false} />);
    vi.advanceTimersByTime(0);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); window.dispatchEvent(new Event("focus")); });
    expect(profileStats).toHaveBeenCalledTimes(1);
    rerender(<Profile account={account} language="en" />);
    await act(async () => {});
    expect(screen.getByRole("tab", { name: "Weekly" }).getAttribute("aria-selected")).toBe("true");
    expect(profileStats).toHaveBeenCalledTimes(2);
  });

  it("switches daily cells to weekly bars and a cumulative line with inspectable values", async () => {
    mocks.backendAvailable = true;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T12:00:00Z"));
    vi.mocked(profileStats).mockResolvedValue({
      ...stats, cumulativeTokens: 1_050,
      daily: [{ date: "2026-10-04", tokens: 20, turns: 1 }, { date: "2026-10-05", tokens: 30, turns: 1 }],
    });
    const { container } = render(<Profile account={account} language="en" />);
    await act(async () => {});
    expect(container.querySelectorAll(".sp-profile-heatmap .sp-profile-heatmap-cell")).toHaveLength(371);
    expect(container.querySelector(".sp-profile-legend")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Weekly" }));
    expect(container.querySelector(".sp-profile-heatmap")).toBeNull();
    expect(container.querySelector(".sp-profile-legend")).toBeNull();
    expect(container.querySelectorAll(".sp-profile-chart-bar")).toHaveLength(53);
    expect(container.querySelectorAll('.sp-profile-chart-bar[height="0"]')).toHaveLength(52);
    expect(container.querySelector(".sp-profile-chart-detail")?.textContent).toBe("2026-10-04 – 2026-10-05 · 50 tokens");

    fireEvent.click(screen.getByRole("tab", { name: "Cumulative" }));
    expect(container.querySelectorAll(".sp-profile-chart-bar")).toHaveLength(0);
    expect(container.querySelector(".sp-profile-chart-line")).toBeTruthy();
    expect(screen.getByText("2026-10-05 · 1,050 tokens")).toBeTruthy();
    const chart = screen.getByRole("img", { name: /Token activity · Cumulative/ });
    fireEvent.keyDown(chart, { key: "ArrowLeft" });
    expect(screen.getByText("2026-10-04 · 1,020 tokens")).toBeTruthy();
    fireEvent.keyDown(chart, { key: "Home" });
    expect(container.querySelector(".sp-profile-chart-detail")?.textContent).toContain("1,000 tokens");
    fireEvent.keyDown(chart, { key: "End" });
    expect(screen.getByText("2026-10-05 · 1,050 tokens")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Daily" }));
    expect(container.querySelector(".sp-profile-chart")).toBeNull();
    expect(container.querySelectorAll(".sp-profile-heatmap .sp-profile-heatmap-cell")).toHaveLength(371);
    expect(profileStats).toHaveBeenCalledTimes(1);
  });

  it("defers scans until the app window is visible", async () => {
    mocks.backendAvailable = true;
    vi.useFakeTimers();
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    vi.mocked(profileStats).mockResolvedValue(stats);
    render(<Profile account={account} language="en" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); window.dispatchEvent(new Event("focus")); });
    expect(profileStats).not.toHaveBeenCalled();
    hidden.mockReturnValue(false);
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(screen.getByText("/research-wiki")).toBeTruthy();
    expect(profileStats).toHaveBeenCalledTimes(1);
  });

  it.each(["{invalid json", JSON.stringify({ stats: { daily: null }, updatedAt: 0 })])("ignores an invalid persisted snapshot", async (raw) => {
    mocks.backendAvailable = true;
    window.localStorage.setItem(PROFILE_STATS_CACHE_KEY, raw);
    vi.mocked(profileStats).mockResolvedValue(stats);
    render(<Profile account={account} language="en" />);
    await screen.findByText("/research-wiki");
    expect(profileStats).toHaveBeenCalledTimes(1);
  });

  it("uses its memory snapshot when local storage is unavailable", async () => {
    mocks.backendAvailable = true;
    window.localStorage.setItem(PROFILE_STATS_CACHE_KEY, JSON.stringify({ stats: { ...stats, cumulativeTokens: 5_000 }, updatedAt: Date.now() - 60_000 }));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage full"); });
    vi.mocked(profileStats).mockResolvedValue(stats);
    const first = render(<Profile account={account} language="en" />);
    await screen.findByText("/research-wiki");
    await waitFor(() => expect(screen.getByText("12.0K")).toBeTruthy());
    first.unmount();
    const second = render(<Profile account={account} language="en" />);
    expect(screen.getByText("12.0K")).toBeTruthy();
    await act(async () => {});
    expect(profileStats).toHaveBeenCalledTimes(1);
    second.unmount();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
    render(<Profile account={account} language="en" />);
    expect(screen.getByText("/research-wiki")).toBeTruthy();
    await act(async () => {});
    expect(profileStats).toHaveBeenCalledTimes(1);
  });

  it("omits the activity scope, update timestamp and combined refresh action", async () => {
    mocks.backendAvailable = true;
    vi.mocked(profileStats).mockResolvedValue(stats);
    const { container } = render(<Profile account={account} language="en" />);
    await screen.findByText("/research-wiki");
    expect(screen.queryByText("Activity recorded across projects on this device")).toBeNull();
    expect(screen.queryByText(/Updated at/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh profile and statistics" })).toBeNull();
    expect(container.querySelector(".sp-profile-data-head")).toBeNull();
  });
});
