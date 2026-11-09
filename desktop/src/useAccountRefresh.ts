import { useCallback, useEffect, useRef, useState } from "react";
import { newapiBootstrap, onChatDone, onChatError } from "./api/tauri";
import { hasNativeBackend } from "./api/transport";
import { getAccountSessionRevision, readCachedAccount, subscribeCachedAccount, writeCachedAccount } from "./accountCache";
import { onFigureUpdated } from "./figures/figureApi";
import { isManagedAuthInvalidError, useStore } from "./store";

const REFRESH_INTERVAL_MS = 60_000;
const MIN_REFRESH_INTERVAL_MS = 15_000;

interface PendingRefresh {
  promise: Promise<void>;
  repeat: boolean;
  lifecycle: number;
  session: number;
}

/** Keep the account menu current, including consumption during an older read. */
export function useAccountRefresh(menuOpen: boolean) {
  const [account, setAccount] = useState(readCachedAccount);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const logout = useStore((state) => state.logout);
  const pendingRef = useRef<PendingRefresh | null>(null);
  const lifecycleRef = useRef(0);
  const mountedRef = useRef(false);
  const lastSuccessRef = useRef(0);

  const refresh = useCallback((options: { force?: boolean } = {}): Promise<void> => {
    if (!hasNativeBackend() || !mountedRef.current) return Promise.resolve();
    const session = getAccountSessionRevision();
    const lifecycle = lifecycleRef.current;
    const pending = pendingRef.current;
    if (pending && pending.session === session && pending.lifecycle === lifecycle) {
      // A completion event may arrive after the in-flight read sampled the
      // balance. Coalesce such events into a fresh read after it completes.
      if (options.force) pending.repeat = true;
      return pending.promise;
    }
    if (!options.force && Date.now() - lastSuccessRef.current < MIN_REFRESH_INTERVAL_MS) return Promise.resolve();

    const request: PendingRefresh = { promise: Promise.resolve(), repeat: false, lifecycle, session };
    const isCurrent = () => mountedRef.current && lifecycleRef.current === lifecycle
      && getAccountSessionRevision() === session;
    pendingRef.current = request;
    setRefreshing(true);
    setError(null);
    request.promise = (async () => {
      try {
        do {
          request.repeat = false;
          try {
            const next = await newapiBootstrap();
            if (!isCurrent()) return;
            writeCachedAccount(next);
            lastSuccessRef.current = Date.now();
            setError(null);
          } catch (failure) {
            if (!isCurrent()) return;
            if (isManagedAuthInvalidError(failure)) {
              logout();
              return;
            }
            // Preserve the last confirmed balance but make a failed read visible.
            setError(failure);
          }
        } while (request.repeat && isCurrent());
      } finally {
        if (pendingRef.current === request) {
          pendingRef.current = null;
          if (mountedRef.current) setRefreshing(false);
        }
      }
    })();
    return request.promise;
  }, [logout]);

  useEffect(() => {
    mountedRef.current = true;
    const unsubscribe = subscribeCachedAccount((next) => {
      setAccount(next);
      setError(null);
      if (!next) {
        lastSuccessRef.current = 0;
      }
    });
    return () => {
      mountedRef.current = false;
      lifecycleRef.current += 1;
      pendingRef.current = null;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!hasNativeBackend()) return;
    void refresh({ force: true });
    const timer = window.setInterval(() => { void refresh(); }, REFRESH_INTERVAL_MS);
    const refreshOnFocus = () => { void refresh(); };
    window.addEventListener("focus", refreshOnFocus);
    const refreshAfterUsage = () => { void refresh({ force: true }); };
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    const retain = (unlisten: () => void) => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    };
    void onChatDone(refreshAfterUsage).then(retain).catch(() => {});
    void onChatError(refreshAfterUsage).then(retain).catch(() => {});
    void onFigureUpdated(({ active, run }) => {
      if (!active && run.requests.some((request) => request.finishedAt)) refreshAfterUsage();
    }).then(retain).catch(() => {});
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshOnFocus);
      for (const unlisten of unlisteners) unlisten();
    };
  }, [refresh]);

  useEffect(() => {
    if (menuOpen) void refresh({ force: true });
  }, [menuOpen, refresh]);

  return { account, refreshing, error, refresh };
}
