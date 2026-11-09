/**
 * The SomniQ edge refuses releases older than its configured minimum with
 * `426 Upgrade Required`. The Rust side turns that into an error ending in
 * `(client_outdated)` (see `runtime::client_identity`), whether it surfaced
 * from a command, a chat turn, or the login screen; this module recognizes it
 * and tells the app shell to offer the update.
 */
export const CLIENT_OUTDATED_CODE = "client_outdated";

const CLIENT_OUTDATED_EVENT = "somniq-client-outdated";

const errorText = (error: unknown): string => {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error ?? "");
};

export const isClientOutdatedError = (error: unknown): boolean =>
  errorText(error).includes(CLIENT_OUTDATED_CODE);

/** Broadcasts a refusal; every other error is ignored. */
export const reportClientOutdated = (error: unknown): void => {
  if (typeof window === "undefined" || !isClientOutdatedError(error)) return;
  window.dispatchEvent(new Event(CLIENT_OUTDATED_EVENT));
};

export const onClientOutdated = (handler: () => void): (() => void) => {
  window.addEventListener(CLIENT_OUTDATED_EVENT, handler);
  return () => window.removeEventListener(CLIENT_OUTDATED_EVENT, handler);
};

/** Fallback when the updater finds nothing: the official download page. */
export const CLIENT_DOWNLOAD_URL = "https://ensuanx.com/";
