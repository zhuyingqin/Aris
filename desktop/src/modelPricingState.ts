import { newapiModelPricing, type NewApiAccount } from "./api/tauri";
import { getAccountSessionRevision, readCachedAccount, subscribeCachedAccount } from "./accountCache";
import { MANAGED_NEWAPI_BASE_URL } from "./managedNewApi";
import { onChatModelsUpdated } from "./modelEvents";
import { modelPricingExpiresAt, parseModelPricingCatalog, type ModelPricingState } from "./modelPricing";

const STORAGE_KEY = "somniq-model-pricing-v1";
const EMPTY: ModelPricingState = { catalog: null, loading: false, stale: false, failed: false };
let snapshot = EMPTY;
let scope: { key: string; username: string; group: string } | null = null;
let accountRevision = -1;
let generation = 0;
let retryAfter = 0;
let pending: { promise: Promise<void>; repeat: boolean } | null = null;
const listeners = new Set<() => void>();
let stopTracking: (() => void) | null = null;

function publish(next: ModelPricingState) {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

function removeSavedPrices() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* Storage is optional. */ }
}

export function clearModelPricingCache() {
  generation += 1;
  pending = null;
  scope = null;
  accountRevision = getAccountSessionRevision();
  retryAfter = 0;
  removeSavedPrices();
  publish(EMPTY);
}

function syncAccount(account: NewApiAccount | null) {
  const next = account?.username && account.group
    ? { key: JSON.stringify([MANAGED_NEWAPI_BASE_URL, account.username, account.group]), username: account.username, group: account.group }
    : null;
  const revision = getAccountSessionRevision();
  if (scope?.key === next?.key && accountRevision === revision) return;
  const previous = scope;
  generation += 1;
  pending = null;
  retryAfter = 0;
  scope = next;
  accountRevision = revision;
  if (!next) { removeSavedPrices(); publish(EMPTY); return; }
  if (previous?.key === next.key) {
    publish({ ...snapshot, loading: false });
    return;
  }
  let catalog = null;
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    const parsed = saved?.key === next.key ? parseModelPricingCatalog(saved.catalog) : null;
    if (parsed?.username === next.username && parsed.group === next.group && parsed.fetchedAt <= Date.now()) catalog = parsed;
  } catch { /* A missing or invalid cache must not affect model selection. */ }
  if (!catalog) removeSavedPrices();
  publish({ catalog, loading: false, stale: !!catalog && Date.now() >= modelPricingExpiresAt(catalog), failed: false });
}

export function refreshModelPricing(force = false): Promise<void> {
  if (!scope) return Promise.resolve();
  if (pending) {
    if (force) pending.repeat = true;
    return pending.promise;
  }
  if (!force && (Date.now() < retryAfter || (snapshot.catalog && Date.now() < modelPricingExpiresAt(snapshot.catalog)))) return Promise.resolve();
  const identity = scope;
  const ticket = generation;
  const revision = accountRevision;
  const current = () => ticket === generation && revision === getAccountSessionRevision() && scope?.key === identity.key;
  const request = { promise: Promise.resolve(), repeat: false };
  pending = request;
  publish({ ...snapshot, loading: true, stale: !!snapshot.catalog && (snapshot.stale || Date.now() >= modelPricingExpiresAt(snapshot.catalog)) });
  request.promise = (async () => {
    try {
      do {
        request.repeat = false;
        try {
          const catalog = parseModelPricingCatalog(await newapiModelPricing());
          if (!current()) return;
          if (!catalog || catalog.username !== identity.username || catalog.group !== identity.group || catalog.fetchedAt > Date.now() + 60_000) throw new Error("Price account mismatch");
          try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ key: identity.key, catalog })); } catch { /* Keep the in-memory prices. */ }
          retryAfter = 0;
          publish({ catalog, loading: true, stale: Date.now() >= modelPricingExpiresAt(catalog), failed: false });
        } catch {
          if (!current()) return;
          retryAfter = Date.now() + 30_000;
          publish({ ...snapshot, loading: true, stale: !!snapshot.catalog, failed: true });
        }
      } while (request.repeat && current());
    } finally {
      if (pending === request) {
        pending = null;
        publish({ ...snapshot, loading: false });
      }
    }
  })();
  return request.promise;
}

export const getModelPricingSnapshot = () => {
  const account = readCachedAccount();
  // A selector can mount after an account change while nobody was subscribed.
  // Hide the previous account's snapshot before React installs the subscription.
  if (accountRevision !== getAccountSessionRevision()
    || (scope && account && (scope.username !== account.username || scope.group !== account.group))) return EMPTY;
  return snapshot;
};
export const getEmptyModelPricingSnapshot = () => EMPTY;

export function subscribeModelPricing(listener: () => void) {
  listeners.add(listener);
  if (!stopTracking) {
    syncAccount(readCachedAccount());
    const stopAccount = subscribeCachedAccount((account) => {
      syncAccount(account);
      void refreshModelPricing();
    });
    const stopModels = onChatModelsUpdated(({ refreshPricing }) => { void refreshModelPricing(refreshPricing); });
    const onFocus = () => { void refreshModelPricing(); };
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(onFocus, 15_000);
    stopTracking = () => {
      stopAccount(); stopModels();
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
  }
  void refreshModelPricing();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { stopTracking?.(); stopTracking = null; }
  };
}
