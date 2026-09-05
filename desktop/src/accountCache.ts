import type { NewApiAccount, NewApiUsageLogPage } from "./api/tauri";

export const ACCOUNT_CACHE_KEY = "somniq-account-v1";
export const ACCOUNT_LEGACY_CACHE_KEY = "aris-account-v1";

export function readCachedAccount(): NewApiAccount | null {
  try {
    const raw = localStorage.getItem(ACCOUNT_CACHE_KEY) ?? localStorage.getItem(ACCOUNT_LEGACY_CACHE_KEY);
    return raw ? (JSON.parse(raw) as NewApiAccount) : null;
  } catch {
    return null;
  }
}

export function writeCachedAccount(account: NewApiAccount | null) {
  try {
    if (account) {
      localStorage.setItem(ACCOUNT_CACHE_KEY, JSON.stringify(account));
      localStorage.removeItem(ACCOUNT_LEGACY_CACHE_KEY);
    } else {
      localStorage.removeItem(ACCOUNT_CACHE_KEY);
      localStorage.removeItem(ACCOUNT_LEGACY_CACHE_KEY);
    }
  } catch {
    // Local storage can be disabled; the in-memory state is still useful.
  }
}

// Usage-log pages live here rather than in Account tab state so they survive
// that tab unmounting on a settings-tab switch. They describe exactly one
// signed-in account, so signing out has to drop them — otherwise the next user
// sees the previous account's call details until the first fetch lands.
let usageLogPageCache: Record<number, NewApiUsageLogPage> = {};

export function readCachedUsageLogPages(): Record<number, NewApiUsageLogPage> {
  return usageLogPageCache;
}

export function writeCachedUsageLogPages(pages: Record<number, NewApiUsageLogPage>) {
  usageLogPageCache = pages;
}

export function clearCachedUsageLogPages() {
  usageLogPageCache = {};
}
