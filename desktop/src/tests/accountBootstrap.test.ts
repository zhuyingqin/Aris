// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { writeCachedAccount } from "../accountCache";
import { invoke } from "../api/transport";
import { newapiBootstrap, type NewApiAccount } from "../api/tauri";
import { notifyChatModelsUpdated } from "../modelEvents";

vi.mock("../api/transport", async (original) => ({
  ...await original<typeof import("../api/transport")>(), invoke: vi.fn(),
}));
vi.mock("../modelEvents", () => ({ notifyChatModelsUpdated: vi.fn() }));

beforeEach(() => { vi.clearAllMocks(); writeCachedAccount(null); });

describe("account bootstrap coalescing", () => {
  it("shares overlapping startup reads within the same signed-in session", async () => {
    let finish!: (account: NewApiAccount) => void;
    vi.mocked(invoke).mockReturnValueOnce(new Promise<NewApiAccount>((resolve) => { finish = resolve; }));
    const first = newapiBootstrap();
    const second = newapiBootstrap();
    expect(second).toBe(first);
    expect(invoke).toHaveBeenCalledTimes(1);
    finish({ username: "first" } as NewApiAccount);
    await first;
    expect(notifyChatModelsUpdated).toHaveBeenCalledTimes(1);
  });

  it("does not reuse a pending read from a previous session or clear the newer read", async () => {
    let finishOld!: (account: NewApiAccount) => void;
    let finishNew!: (account: NewApiAccount) => void;
    vi.mocked(invoke)
      .mockReturnValueOnce(new Promise<NewApiAccount>((resolve) => { finishOld = resolve; }))
      .mockReturnValueOnce(new Promise<NewApiAccount>((resolve) => { finishNew = resolve; }));
    const old = newapiBootstrap();
    writeCachedAccount(null);
    const current = newapiBootstrap();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(current).not.toBe(old);
    finishOld({ username: "old" } as NewApiAccount);
    await old;
    expect(notifyChatModelsUpdated).not.toHaveBeenCalled();
    expect(newapiBootstrap()).toBe(current);
    finishNew({ username: "current" } as NewApiAccount);
    expect((await current).username).toBe("current");
    expect(notifyChatModelsUpdated).toHaveBeenCalledTimes(1);
  });
});
