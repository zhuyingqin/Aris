export const ACCOUNT_PROFILE_KEY = "somniq_user_session_v1";
export const ACCOUNT_ACCESS_TOKEN_KEY = "somniq_access_token_v1";
/** Unix milliseconds after which the stored access token stops being accepted. */
export const ACCOUNT_ACCESS_EXPIRES_KEY = "somniq_access_expires_v1";
/** new-api refresh-session id, echoed back on renewal as `X-Auth-Session`. */
export const ACCOUNT_AUTH_SESSION_KEY = "somniq_auth_session_v1";
export const AUTH_RETURN_TO_KEY = "somniq_auth_return_to_v1";

export interface AccountSession {
  userId: number;
  accessToken: string;
  /**
   * Unix milliseconds. Absent for sessions stored before renewal existed:
   * those are used as-is and verified lazily by the first rejection.
   */
  expiresAtMs?: number;
  authSessionId?: string;
}

export function loadAccountSession(storage: Storage = localStorage): AccountSession | null {
  try {
    const accessToken = storage.getItem(ACCOUNT_ACCESS_TOKEN_KEY)?.trim() ?? "";
    const profile = JSON.parse(storage.getItem(ACCOUNT_PROFILE_KEY) ?? "null") as unknown;
    if (!accessToken || accessToken.length > 16 * 1024 || !isRecord(profile)) return null;
    const userId = numericUserId(profile.id);
    if (!userId) return null;
    const session: AccountSession = { userId, accessToken };
    const expiresAtMs = Number(storage.getItem(ACCOUNT_ACCESS_EXPIRES_KEY));
    if (Number.isSafeInteger(expiresAtMs) && expiresAtMs > 0) {
      session.expiresAtMs = expiresAtMs;
    }
    const authSessionId = storage.getItem(ACCOUNT_AUTH_SESSION_KEY)?.trim() ?? "";
    if (authSessionId && authSessionId.length <= 512) {
      session.authSessionId = authSessionId;
    }
    return session;
  } catch {
    return null;
  }
}

/**
 * Persists a freshly issued credential. The refresh cookie that backs it is
 * HttpOnly and stays under the browser's control; only these projections of
 * the sign-in are readable here.
 */
export function saveAccountCredential(
  credential: { accessToken: string; expiresAtMs?: number; authSessionId?: string },
  storage: Storage = localStorage,
): void {
  try {
    storage.setItem(ACCOUNT_ACCESS_TOKEN_KEY, credential.accessToken);
    if (credential.expiresAtMs && Number.isSafeInteger(credential.expiresAtMs)) {
      storage.setItem(ACCOUNT_ACCESS_EXPIRES_KEY, String(credential.expiresAtMs));
    } else {
      storage.removeItem(ACCOUNT_ACCESS_EXPIRES_KEY);
    }
    // A rotation that omits the session id keeps the previous one: new-api
    // only reports it when it changes.
    if (credential.authSessionId) {
      storage.setItem(ACCOUNT_AUTH_SESSION_KEY, credential.authSessionId);
    }
  } catch {
    // A storage quota or private-mode failure must not break the sign-in.
  }
}

/**
 * Drops the access credential while leaving the cached profile in place, so a
 * re-login screen can still greet the user by name.
 */
export function clearAccountCredential(storage: Storage = localStorage): void {
  try {
    storage.removeItem(ACCOUNT_ACCESS_TOKEN_KEY);
    storage.removeItem(ACCOUNT_ACCESS_EXPIRES_KEY);
    storage.removeItem(ACCOUNT_AUTH_SESSION_KEY);
  } catch {
    // ignore
  }
}

export function clearAccountSession(storage: Storage = localStorage): void {
  clearAccountCredential(storage);
  try {
    storage.removeItem(ACCOUNT_PROFILE_KEY);
  } catch {
    // ignore
  }
}

/**
 * Account credentials may only be attached to the same origin that created
 * the website session. A QR-controlled custom gateway must never receive the
 * SomniQ website access token.
 */
export function accountHeadersForGateway(
  gatewayUrl: string,
  session: AccountSession,
  siteOrigin = window.location.origin,
): Record<string, string> {
  let gatewayOrigin: string;
  try {
    gatewayOrigin = new URL(gatewayUrl).origin;
  } catch {
    return {};
  }
  if (gatewayOrigin !== siteOrigin) return {};
  return {
    "X-Somniq-Account-Authorization": `Bearer ${session.accessToken}`,
    "X-Somniq-Account-User": String(session.userId),
  };
}

export function rememberAuthReturnTo(url: string, storage: Storage = sessionStorage): void {
  try {
    const parsed = new URL(url, window.location.href);
    if (parsed.origin !== window.location.origin || !parsed.pathname.startsWith("/remote/")) return;
    storage.setItem(AUTH_RETURN_TO_KEY, parsed.href);
  } catch {
    // A failed convenience redirect must not weaken the pairing flow.
  }
}

export function accountLoginUrl(baseUrl = document.baseURI): string {
  return new URL("../dashboard.html?remote_login=1", baseUrl).href;
}

/** The deployment root that serves the dashboard, one level above the PWA. */
export function siteRootUrl(baseUrl = document.baseURI): string {
  return new URL("../", baseUrl).href;
}

function numericUserId(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
