// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    window.localStorage.clear();
  });

  it("never presents preview identity or generated activity as real data", () => {
    render(<Profile account={account} language="cn" />);

    expect(screen.getByText("未登录")).toBeTruthy();
    expect(screen.queryByText("Real Researcher")).toBeNull();
    expect(screen.getByText(/不会再使用模拟数据/)).toBeTruthy();
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
});
