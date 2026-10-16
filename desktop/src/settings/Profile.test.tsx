// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NewApiAccount } from "../api/tauri";
import { profileStats } from "../api/tauri";
import { PROFILE_AVATAR_CACHE_KEY, writeProfileAvatar } from "../profileAvatar";
import type { ProfileStats } from "../types";
import Profile from "./Profile";

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
    vi.mocked(profileStats).mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    window.localStorage.clear();
  });

  it("never presents preview identity or generated activity as real data", () => {
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
    const refreshAccount = vi.fn().mockResolvedValue(undefined);
    vi.mocked(profileStats).mockResolvedValueOnce(stats).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ ...stats, toolCalls: 9 });
    render(<Profile account={account} language="en" onRefreshAccount={refreshAccount} />);
    await screen.findByText("/research-wiki");
    const refreshButton = screen.getByRole("button", { name: "Refresh profile and statistics" });
    fireEvent.click(refreshButton);
    await screen.findByText(/Refresh failed/);
    expect(screen.getByText("/research-wiki")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh profile and statistics" }));
    await waitFor(() => expect(screen.queryByText(/Refresh failed/)).toBeNull());
    expect(refreshAccount).toHaveBeenCalledTimes(2);
    expect(screen.getByText("9")).toBeTruthy();
  });

  it("refreshes on focus and releases listeners when unmounted", async () => {
    mocks.backendAvailable = true;
    vi.mocked(profileStats).mockResolvedValue(stats);
    const { unmount } = render(<Profile account={account} language="en" />);
    await screen.findByText("/research-wiki");
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(profileStats).toHaveBeenCalledTimes(2);
    unmount();
    window.dispatchEvent(new Event("focus"));
    expect(profileStats).toHaveBeenCalledTimes(2);
  });

  it("shows partial coverage and real model usage without hiding recorded activity", async () => {
    mocks.backendAvailable = true;
    vi.mocked(profileStats).mockResolvedValue({ ...stats, partialData: true });
    render(<Profile account={account} language="en" accountError="Connection failed" />);
    await screen.findByText(/Some historical records could not be read/);
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
    expect(vi.getTimerCount()).toBe(0);
  });
});
