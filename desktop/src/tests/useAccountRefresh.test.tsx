// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AppAccountMenu from "../AppAccountMenu";
import { accountMenuPlan } from "../accountMenuPlan";
import { ACCOUNT_CACHE_KEY, readCachedAccount, writeCachedAccount } from "../accountCache";
import { newapiBootstrap, type NewApiAccount } from "../api/tauri";
import type { FigureView } from "../figures/types";
import { useStore } from "../store";
import { useAccountRefresh } from "../useAccountRefresh";

const events = vi.hoisted(() => ({
  done: null as (() => void) | null,
  error: null as (() => void) | null,
  figure: null as ((view: FigureView) => void) | null,
  unlisten: vi.fn(),
}));
vi.mock("../api/tauri", async (original) => ({
  ...await original<typeof import("../api/tauri")>(),
  isTauri: () => false,
  newapiBootstrap: vi.fn(),
  onChatDone: async (handler: () => void) => { events.done = handler; return events.unlisten; },
  onChatError: async (handler: () => void) => { events.error = handler; return events.unlisten; },
}));
vi.mock("../api/transport", async (original) => ({
  ...await original<typeof import("../api/transport")>(), hasNativeBackend: () => true,
}));
vi.mock("../figures/figureApi", () => ({
  onFigureUpdated: async (handler: (view: FigureView) => void) => { events.figure = handler; return events.unlisten; },
}));

const initialAccount: NewApiAccount = {
  username: "zhuyingqin", displayName: "", group: "go", groupDesc: "Go", groupRatio: "1",
  quota: 100_000_000, usedQuota: 0, models: ["test-model"], model: "test-model",
  subscriptionName: "Go", subscriptionQuota: 16_350_000, subscriptionUsedQuota: 13_650_000,
};
const consumedAccount = { ...initialAccount, subscriptionQuota: 15_000_000, subscriptionUsedQuota: 15_000_000 };
const initialStore = useStore.getState();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function Harness() {
  const [open, setOpen] = useState(false);
  const { account, refreshing, error, refresh } = useAccountRefresh(open);
  return <AppAccountMenu language="en" name={account?.username ?? "Account"} initials="Z" avatar={null}
    plan={accountMenuPlan(account, "en")} open={open} refreshing={refreshing} refreshError={error ? String(error) : null}
    onRefresh={() => void refresh({ force: true })} onMenuKeyDown={() => {}}
    onToggle={() => setOpen((current) => !current)} onSettings={() => {}} onMembership={() => {}} onLogout={useStore.getState().logout} />;
}
const settle = () => act(async () => {});
const openMenu = () => fireEvent.click(screen.getByRole("button", { name: "User menu" }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
  vi.mocked(newapiBootstrap).mockReset().mockResolvedValue(initialAccount);
  events.unlisten.mockClear();
  events.done = null;
  events.error = null;
  events.figure = null;
  localStorage.clear();
  writeCachedAccount(initialAccount);
  useStore.setState({ ...initialStore, authed: true });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  useStore.setState(initialStore, true);
  vi.useRealTimers();
});

describe("account allowance refresh", () => {
  it("reads the server again when the menu opens within the background throttle interval", async () => {
    render(<Harness />);
    await settle();
    vi.mocked(newapiBootstrap).mockResolvedValue(consumedAccount);
    openMenu();
    await settle();
    expect(newapiBootstrap).toHaveBeenCalledTimes(2);
    expect(screen.getByText("$30.00")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("50");
    expect(screen.queryByText("$32.70")).toBeNull();
  });

  it("queues one fresh read when consumption finishes during an older request", async () => {
    const older = deferred<NewApiAccount>();
    vi.mocked(newapiBootstrap).mockReturnValueOnce(older.promise).mockResolvedValue(consumedAccount);
    render(<Harness />);
    await settle();
    openMenu();
    act(() => { events.done?.(); events.done?.(); events.error?.(); });
    expect(newapiBootstrap).toHaveBeenCalledTimes(1);
    await act(async () => { older.resolve(initialAccount); });
    expect(newapiBootstrap).toHaveBeenCalledTimes(2);
    expect(screen.getByText("$30.00")).toBeTruthy();
    expect(readCachedAccount()).toEqual(consumedAccount);
  });

  it("immediately shows a confirmed balance written by Settings without another request", async () => {
    render(<Harness />);
    await settle();
    openMenu();
    await settle();
    act(() => writeCachedAccount(consumedAccount));
    expect(screen.getByText("$30.00")).toBeTruthy();
    expect(screen.getByText("50% remaining")).toBeTruthy();
    expect(newapiBootstrap).toHaveBeenCalledTimes(2);
  });

  it("refreshes after a drawing request finishes and after a partially failed chat", async () => {
    render(<Harness />);
    await settle();
    const completed = { active: false, run: { requests: [{ finishedAt: "2026-10-16T12:00:01Z" }] } } as FigureView;
    act(() => events.figure?.({ ...completed, active: true }));
    expect(newapiBootstrap).toHaveBeenCalledTimes(1);
    vi.mocked(newapiBootstrap).mockResolvedValue(consumedAccount);
    act(() => events.figure?.(completed));
    await settle();
    expect(newapiBootstrap).toHaveBeenCalledTimes(2);
    act(() => events.error?.());
    await settle();
    expect(newapiBootstrap).toHaveBeenCalledTimes(3);
    expect(readCachedAccount()).toEqual(consumedAccount);
  });

  it("retains the last allowance on failure and lets the user retry immediately", async () => {
    render(<Harness />);
    await settle();
    vi.mocked(newapiBootstrap).mockRejectedValueOnce(new Error("network unavailable"));
    openMenu();
    await settle();
    expect(screen.getByText("$32.70")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Refresh failed. Showing last allowance.");
    const retry = deferred<NewApiAccount>();
    vi.mocked(newapiBootstrap).mockReturnValueOnce(retry.promise);
    fireEvent.click(screen.getByRole("button", { name: "Refresh allowance" }));
    expect(screen.getByRole("button", { name: "Refreshing allowance" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("group", { name: "Plan allowance" }).getAttribute("aria-busy")).toBe("true");
    await act(async () => { retry.resolve(consumedAccount); });
    expect(screen.getByText("$30.00")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "Refresh allowance" })).toHaveProperty("disabled", false);
  });

  it("keeps the periodic refresh and refreshes after returning to the window", async () => {
    render(<Harness />);
    await settle();
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(newapiBootstrap).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(15_000); fireEvent(window, new Event("focus")); });
    expect(newapiBootstrap).toHaveBeenCalledTimes(3);
  });

  it("keeps the account signed in when a temporary token or model key is rejected", async () => {
    render(<Harness />);
    await settle();
    for (const error of ["401 Unauthorized: invalid access token", "Invalid token", "AUTH_TOKEN_EXPIRED"]) {
      vi.mocked(newapiBootstrap).mockRejectedValueOnce(new Error(error));
      await act(async () => { vi.advanceTimersByTime(60_000); });
      expect(useStore.getState().authed).toBe(true);
      expect(readCachedAccount()).toEqual(initialAccount);
    }
    vi.mocked(newapiBootstrap).mockResolvedValue(consumedAccount);
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(readCachedAccount()).toEqual(consumedAccount);
    expect(useStore.getState().authed).toBe(true);
  });

  it("signs out when the backend confirms the long-lived login has expired", async () => {
    render(<Harness />);
    await settle();
    vi.mocked(newapiBootstrap).mockRejectedValueOnce(new Error("Login expired. Please sign in again."));
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(useStore.getState().authed).toBe(false);
    expect(readCachedAccount()).toBeNull();
  });

  it("does not restore a signed-out account from a late response", async () => {
    const older = deferred<NewApiAccount>();
    vi.mocked(newapiBootstrap).mockReturnValueOnce(older.promise);
    render(<Harness />);
    openMenu();
    await settle();
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    await act(async () => { older.resolve(initialAccount); });
    expect(readCachedAccount()).toBeNull();
    expect(screen.queryByText("$32.70")).toBeNull();
    expect(useStore.getState().authed).toBe(false);
    expect(newapiBootstrap).toHaveBeenCalledTimes(1);
  });

  it("ignores an old session's failure after a different account signs in", async () => {
    const older = deferred<NewApiAccount>();
    vi.mocked(newapiBootstrap).mockReturnValueOnce(older.promise);
    render(<Harness />);
    await settle();
    act(() => {
      useStore.getState().logout();
      writeCachedAccount({ ...consumedAccount, username: "new-account" });
      useStore.setState({ authed: true });
    });
    await act(async () => { older.reject(new Error("登录已失效，请重新登录")); });
    expect(useStore.getState().authed).toBe(true);
    expect(readCachedAccount()?.username).toBe("new-account");
  });

  it("keeps an allowance confirmed in another window when an older read returns", async () => {
    const older = deferred<NewApiAccount>();
    vi.mocked(newapiBootstrap).mockReturnValueOnce(older.promise).mockResolvedValue(consumedAccount);
    render(<Harness />);
    await settle();
    const newValue = JSON.stringify(consumedAccount);
    act(() => {
      localStorage.setItem(ACCOUNT_CACHE_KEY, newValue);
      fireEvent(window, new StorageEvent("storage", { key: ACCOUNT_CACHE_KEY, newValue }));
    });
    await act(async () => { older.resolve(initialAccount); });
    expect(readCachedAccount()).toEqual(consumedAccount);
    openMenu();
    await settle();
    expect(screen.getByText("$30.00")).toBeTruthy();
  });

  it("discards a response and removes completion listeners after unmounting", async () => {
    const older = deferred<NewApiAccount>();
    vi.mocked(newapiBootstrap).mockReturnValueOnce(older.promise);
    const view = render(<Harness />);
    await settle();
    view.unmount();
    await act(async () => { older.resolve(consumedAccount); });
    expect(readCachedAccount()).toEqual(initialAccount);
    expect(events.unlisten).toHaveBeenCalledTimes(3);
  });
});
