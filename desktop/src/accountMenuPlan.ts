import type { NewApiAccount } from "./api/tauri";
import type { Language } from "./store";

export type AccountPlanTier = "free" | "go" | "plus" | "pro" | "unknown";

export interface AccountMenuPlan {
  tier: AccountPlanTier;
  label: string;
  remaining: number | null;
  remainingPercent: number | null;
}

const TIERS = ["pro", "plus", "go", "free"] as const;

function namedTier(value?: string): AccountPlanTier | null {
  const name = value?.trim().toLowerCase();
  if (!name) return null;
  return TIERS.find((tier) => new RegExp(`(^|[^a-z])${tier}([^a-z]|$)`).test(name)) ?? null;
}

function quotaValue(value?: number): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : null;
}

export function accountMenuPlan(account: NewApiAccount | null, language: Language): AccountMenuPlan {
  if (!account) return { tier: "unknown", label: language === "cn" ? "账户" : "Account", remaining: null, remainingPercent: null };
  const subscriptionName = account.subscriptionName?.trim();
  const subscriptionDesc = account.subscriptionDesc?.trim();
  const tier = namedTier(subscriptionName) ?? namedTier(account.group) ?? namedTier(account.groupDesc)
    ?? namedTier(subscriptionDesc) ?? (account.group?.trim().toLowerCase() === "default" ? "free" : "unknown");
  const label = tier === "unknown"
    ? subscriptionName || account.groupDesc?.trim() || (language === "cn" ? "账户" : "Account")
    : tier[0].toUpperCase() + tier.slice(1);

  // The native projection emits empty names and zero subscription counters
  // when there is no active subscription. A zero balance on an identified or
  // previously used subscription must stay zero instead of using the wallet.
  const hasSubscription = Boolean(subscriptionName || subscriptionDesc)
    || (quotaValue(account.subscriptionQuota) ?? 0) > 0
    || (quotaValue(account.subscriptionUsedQuota) ?? 0) > 0;
  const remaining = quotaValue(hasSubscription ? account.subscriptionQuota : account.quota);
  const used = quotaValue(hasSubscription ? account.subscriptionUsedQuota : account.usedQuota);
  const total = remaining !== null && used !== null ? remaining + used : null;
  const remainingPercent = total !== null && Number.isFinite(total)
    ? total > 0 ? Math.min(100, Math.max(0, Math.round((remaining! / total) * 100))) : 0
    : null;
  return { tier, label, remaining, remainingPercent };
}
