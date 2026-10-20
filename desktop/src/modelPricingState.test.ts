// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newapiModelPricing, type NewApiAccount } from "./api/tauri";
import { writeCachedAccount } from "./accountCache";
import { MANAGED_NEWAPI_BASE_URL } from "./managedNewApi";
import { notifyChatModelsUpdated } from "./modelEvents";
import { MODEL_PRICING_TTL_MS } from "./modelPricing";
import { clearModelPricingCache, getModelPricingSnapshot, refreshModelPricing, subscribeModelPricing } from "./modelPricingState";
import { pricingCatalog } from "./tests/modelPricingFixture";
import type { ModelPricingCatalog } from "./types";

vi.mock("./api/tauri", () => ({ newapiModelPricing: vi.fn() }));

const account = (username = "researcher", group = "go") => ({ username, group } as NewApiAccount);
const subscriptions: (() => void)[] = [];
const subscribe = () => { const stop = subscribeModelPricing(vi.fn()); subscriptions.push(stop); return stop; };
function deferred() {
  let resolve!: (value: ModelPricingCatalog) => void;
  const promise = new Promise<ModelPricingCatalog>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-20T05:00:00Z"));
  localStorage.clear();
  clearModelPricingCache();
  writeCachedAccount(account());
  vi.mocked(newapiModelPricing).mockReset().mockResolvedValue(pricingCatalog());
});
afterEach(() => {
  subscriptions.splice(0).forEach((stop) => stop());
  writeCachedAccount(null);
  clearModelPricingCache();
  vi.useRealTimers();
});

describe("shared model-price cache", () => {
  it("refetches an unexpired snapshot from before the fixed peak comparison basis", async () => {
    const { peakBaseline: _peakBaseline, ...oldCatalog } = pricingCatalog();
    localStorage.setItem("somniq-model-pricing-v1", JSON.stringify({
      key: JSON.stringify([MANAGED_NEWAPI_BASE_URL, "researcher", "go"]), catalog: oldCatalog,
    }));
    const request = deferred();
    vi.mocked(newapiModelPricing).mockReturnValueOnce(request.promise);
    subscribe();
    expect(getModelPricingSnapshot().catalog).toBeNull();
    expect(newapiModelPricing).toHaveBeenCalledOnce();
    request.resolve(pricingCatalog());
    await refreshModelPricing();
    expect(getModelPricingSnapshot().catalog?.peakBaseline?.tier).toBe("peak");
  });

  it("honours the next time-based price boundary before the ordinary TTL", async () => {
    vi.mocked(newapiModelPricing).mockImplementation(async () => pricingCatalog({ validUntil: Date.now() + 1000 }));
    subscribe(); await refreshModelPricing();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(newapiModelPricing).toHaveBeenCalledTimes(2);
  });

  it("hides another account's prices before a new selector subscribes", async () => {
    const stop = subscribe(); await refreshModelPricing(); stop();
    writeCachedAccount(account("other"));
    expect(getModelPricingSnapshot().catalog).toBeNull();
    vi.mocked(newapiModelPricing).mockResolvedValue(pricingCatalog({ username: "other" }));
    subscribe(); await refreshModelPricing();
    expect(getModelPricingSnapshot().catalog?.username).toBe("other");
  });
  it("coalesces consumers, respects TTL, and refreshes on model synchronisation", async () => {
    subscribe(); subscribe();
    await refreshModelPricing();
    expect(newapiModelPricing).toHaveBeenCalledTimes(1);
    await refreshModelPricing();
    expect(newapiModelPricing).toHaveBeenCalledTimes(1);
    notifyChatModelsUpdated();
    await refreshModelPricing();
    expect(newapiModelPricing).toHaveBeenCalledTimes(1);
    notifyChatModelsUpdated({ refreshPricing: true });
    await refreshModelPricing();
    expect(newapiModelPricing).toHaveBeenCalledTimes(2);
    expect(getModelPricingSnapshot().catalog?.username).toBe("researcher");
  });

  it("preserves confirmed prices and marks them stale after a failed refresh", async () => {
    subscribe(); await refreshModelPricing();
    const confirmed = getModelPricingSnapshot().catalog;
    vi.setSystemTime(Date.now() + MODEL_PRICING_TTL_MS + 1);
    vi.mocked(newapiModelPricing).mockRejectedValue(new Error("offline"));
    await refreshModelPricing();
    expect(getModelPricingSnapshot()).toMatchObject({ catalog: confirmed, stale: true, failed: true, loading: false });
    await refreshModelPricing();
    expect(newapiModelPricing).toHaveBeenCalledTimes(2);
  });

  it("discards in-flight prices when an account or group changes and clears on logout", async () => {
    const old = deferred();
    const next = deferred();
    vi.mocked(newapiModelPricing).mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    subscribe();
    const oldRequest = refreshModelPricing();
    writeCachedAccount(account("other", "plus"));
    expect(getModelPricingSnapshot().catalog).toBeNull();
    next.resolve(pricingCatalog({ username: "other", group: "plus" }));
    await refreshModelPricing();
    old.resolve(pricingCatalog());
    await oldRequest;
    expect(getModelPricingSnapshot().catalog?.username).toBe("other");
    writeCachedAccount(null);
    expect(getModelPricingSnapshot().catalog).toBeNull();
    expect(localStorage.getItem("somniq-model-pricing-v1")).toBeNull();
  });

  it("loads an account-matched offline snapshot but rejects another account's prices", async () => {
    const cached = pricingCatalog({ fetchedAt: Date.now() - MODEL_PRICING_TTL_MS - 1 });
    localStorage.setItem("somniq-model-pricing-v1", JSON.stringify({
      key: JSON.stringify([MANAGED_NEWAPI_BASE_URL, "researcher", "go"]), catalog: cached,
    }));
    vi.mocked(newapiModelPricing).mockRejectedValue(new Error("offline"));
    subscribe(); await refreshModelPricing();
    expect(getModelPricingSnapshot().catalog).toEqual(cached);
    writeCachedAccount(account("other"));
    await refreshModelPricing();
    expect(getModelPricingSnapshot().catalog).toBeNull();
  });

  it("rejects a response for the wrong billing group and works when storage is disabled", async () => {
    vi.mocked(newapiModelPricing).mockResolvedValueOnce(pricingCatalog({ group: "plus" }));
    subscribe(); await refreshModelPricing();
    expect(getModelPricingSnapshot()).toMatchObject({ catalog: null, failed: true });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("disabled"); });
    await refreshModelPricing(true);
    expect(getModelPricingSnapshot().catalog?.group).toBe("go");
    vi.restoreAllMocks();
  });
});
