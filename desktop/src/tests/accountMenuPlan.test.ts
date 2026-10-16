import { describe, expect, it } from "vitest";
import type { NewApiAccount } from "../api/tauri";
import { accountMenuPlan } from "../accountMenuPlan";

const account = (overrides: Partial<NewApiAccount> = {}): NewApiAccount => ({
  username: "research@example.com", displayName: "Research", group: "default", groupDesc: "", groupRatio: "1",
  quota: 20_000_000, usedQuota: 5_000_000, models: [], model: "", ...overrides,
});

describe("accountMenuPlan", () => {
  it.each(["Free", "Go", "Plus", "Pro"])("recognizes the %s subscription without inferring a tier from money", (name) => {
    expect(accountMenuPlan(account({ subscriptionName: `SomniQ ${name} 月度套餐`, quota: 0 }), "cn")).toMatchObject({ tier: name.toLowerCase(), label: name });
  });

  it("prefers an explicitly named subscription over the account routing group", () => {
    expect(accountMenuPlan(account({ subscriptionName: "SomniQ Go", group: "pro" }), "cn").tier).toBe("go");
  });

  it("uses named account groups when no plan title is available", () => {
    expect(accountMenuPlan(account({ group: "somniq_plus" }), "cn")).toMatchObject({ tier: "plus", label: "Plus" });
  });

  it("does not turn similar words or unknown subscriptions into a premium tier", () => {
    expect(accountMenuPlan(account({ group: "research", groupDesc: "Programming", subscriptionName: "Mongo Research" }), "cn")).toMatchObject({ tier: "unknown", label: "Mongo Research" });
  });

  it("uses the Free account allowance when the native projection has no subscription", () => {
    expect(accountMenuPlan(account({ subscriptionName: "", subscriptionDesc: "", subscriptionQuota: 0, subscriptionUsedQuota: 0 }), "cn"))
      .toMatchObject({ tier: "free", remaining: 20_000_000, remainingPercent: 80 });
  });

  it("shows one subscription bucket instead of adding or substituting the wallet balance", () => {
    expect(accountMenuPlan(account({ subscriptionName: "Plus", subscriptionQuota: 2_000_000, subscriptionUsedQuota: 8_000_000 }), "cn"))
      .toMatchObject({ remaining: 2_000_000, remainingPercent: 20 });
  });

  it("keeps an exhausted subscription at zero even when the wallet has money", () => {
    expect(accountMenuPlan(account({ subscriptionName: "Pro", subscriptionQuota: 0, subscriptionUsedQuota: 8_000_000 }), "cn"))
      .toMatchObject({ remaining: 0, remainingPercent: 0 });
  });

  it("does not substitute wallet money for missing subscription data", () => {
    expect(accountMenuPlan(account({ subscriptionName: "Pro" }), "cn"))
      .toMatchObject({ remaining: null, remainingPercent: null });
    expect(accountMenuPlan(account({ subscriptionName: "Pro", subscriptionQuota: 10_000_000 }), "cn"))
      .toMatchObject({ remaining: 10_000_000, remainingPercent: null });
  });

  it("handles invalid counters and empty allowance without a false percentage", () => {
    expect(accountMenuPlan(account({ quota: Number.NaN }), "cn").remainingPercent).toBeNull();
    expect(accountMenuPlan(account({ quota: 0, usedQuota: 0 }), "cn").remainingPercent).toBe(0);
    expect(accountMenuPlan(account({ quota: -100, usedQuota: 100 }), "cn").remainingPercent).toBe(0);
  });

  it("keeps missing account data neutral and localized", () => {
    expect(accountMenuPlan(null, "en")).toEqual({ tier: "unknown", label: "Account", remaining: null, remainingPercent: null });
  });
});
