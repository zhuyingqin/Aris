import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Chooses where `invoke` and `listen` go.
 *
 * `tauri` is the packaged app. `http` points the same calls at `aris-devserver`
 * so the UI can be driven from a plain browser against real Rust — no webview,
 * no installer, and the request/response of every command is visible in the
 * network panel. Without either, calls fall through to the Tauri bindings and
 * fail exactly as they do today, so the existing browser-preview fallbacks in
 * `tauri.ts` keep their current behaviour.
 */
export type TransportKind = "tauri" | "http";

const DEV_BACKEND_STORAGE_KEY = "somniq-dev-backend";
const DEFAULT_DEV_BACKEND = "http://127.0.0.1:1421";

const isTauriRuntime = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Resolved once: the flag is sticky so a reload or an in-app navigation that
 * drops the query string does not silently fall back to a dead transport. */
const resolveDevBackend = (): string | null => {
  if (typeof window === "undefined") return null;
  const fromEnv = import.meta.env.VITE_ARIS_DEV_BACKEND as string | undefined;
  const param = new URLSearchParams(window.location.search).get("devBackend");
  const requested = param === "1" ? DEFAULT_DEV_BACKEND : param || fromEnv || null;
  try {
    if (requested) window.localStorage.setItem(DEV_BACKEND_STORAGE_KEY, requested);
    return requested ?? window.localStorage.getItem(DEV_BACKEND_STORAGE_KEY);
  } catch {
    // Storage disabled — the query string and env var still work for this load.
    return requested;
  }
};

const devBackend = isTauriRuntime() ? null : resolveDevBackend();

export const transportKind = (): TransportKind => (devBackend ? "http" : "tauri");

export const devBackendUrl = (): string | null => devBackend;

/**
 * True when `invoke` reaches real Rust — inside the app, or through the
 * devserver.
 *
 * Callers that pick between the backend and a browser-preview fake must branch
 * on this rather than on `isTauri()`: "am I in a webview" and "is there a
 * backend" stopped being the same question once the devserver existed.
 */
export const hasNativeBackend = (): boolean => isTauriRuntime() || devBackend !== null;

/** Mirrors Tauri's argument casing: command args are camelCase over the wire. */
export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!devBackend) return tauriInvoke<T>(command, args);
  const response = await fetch(`${devBackend}/invoke/${command}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args ?? {}),
  });
  if (!response.ok) {
    throw new Error(`devserver ${command}: HTTP ${response.status} ${response.statusText}`);
  }
  const payload = (await response.json()) as { ok?: T; err?: string };
  // The devserver reports a rejected command as `err` in a 200 body so the
  // promise rejects the same way `invoke` does inside the webview.
  if (payload.err !== undefined) throw new Error(payload.err);
  return payload.ok as T;
}

type Handler = (event: { payload: unknown }) => void;

const handlers = new Map<string, Set<Handler>>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let seq = 0;

/** The devserver buffers emitted events instead of pushing them, so one poller
 * fans out to every subscriber. Same rate for all listeners: event ordering
 * matters more than latency when reproducing a bug. */
const startPolling = () => {
  if (pollTimer || !devBackend) return;
  pollTimer = setInterval(() => {
    void (async () => {
      try {
        const response = await fetch(`${devBackend}/events?since=${seq}`);
        if (!response.ok) return;
        const body = (await response.json()) as {
          events: { seq: number; name: string; payload: unknown }[];
          next: number;
        };
        seq = body.next;
        for (const event of body.events) {
          for (const handler of handlers.get(event.name) ?? []) {
            handler({ payload: event.payload });
          }
        }
      } catch {
        // The devserver is allowed to be restarted mid-session; the next tick
        // picks the stream back up from the same cursor.
      }
    })();
  }, 400);
};

export async function listen<T>(
  event: string,
  handler: (event: { payload: T }) => void,
): Promise<UnlistenFn> {
  if (!devBackend) return tauriListen<T>(event, handler);
  const typed = handler as Handler;
  const existing = handlers.get(event) ?? new Set<Handler>();
  existing.add(typed);
  handlers.set(event, existing);
  startPolling();
  return () => {
    const current = handlers.get(event);
    current?.delete(typed);
    if (current && current.size === 0) handlers.delete(event);
  };
}
