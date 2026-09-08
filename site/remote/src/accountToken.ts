import {
  clearAccountCredential,
  loadAccountSession,
  saveAccountCredential,
  type AccountSession,
} from "./account";

/**
 * Keeps the website's new-api access token usable without re-prompting for a
 * password.
 *
 * new-api issues a short-lived access token plus an HttpOnly, rotating
 * `new_api_refresh` cookie; the token alone dies within minutes. The desktop
 * client already renews through `POST /api/user/auth/refresh`
 * (`desktop/src-tauri/src/newapi.rs`), which is why it stays signed in for
 * days while the browser surfaces did not. This is the browser half of the
 * same protocol, and it deliberately mirrors the desktop's timings.
 *
 * The refresh cookie is never readable here. Renewal therefore only works on
 * a path the cookie is scoped to, which is why the account edge exposes the
 * upstream path verbatim (see `site/server/deploy/Caddyfile`) instead of a
 * prettier `/v1/...` alias.
 */

/** Renew this long before expiry. Mirrors the desktop's `ACCESS_TOKEN_RENEWAL_SKEW`. */
const RENEWAL_SKEW_MS = 60_000;
/** Assumed lifetime when the gateway reports none. Mirrors `FALLBACK_ACCESS_TOKEN_LIFETIME`. */
const FALLBACK_LIFETIME_MS = 14 * 60_000;
/** Same-origin path of new-api's renewal endpoint, relative to the site root. */
export const ACCOUNT_REFRESH_PATH = "api/user/auth/refresh";

export type AccountSessionFailure =
  /** Nothing is stored: this browser was never signed in, or signed out. */
  | "signed-out"
  /** The credential was rejected and has been dropped; only a login can fix it. */
  | "expired"
  /** Renewal could not be reached. The credential is kept and may still work. */
  | "unavailable";

export class AccountSessionError extends Error {
  constructor(readonly reason: AccountSessionFailure) {
    super(`account session ${reason}`);
    this.name = "AccountSessionError";
  }
}

export interface AccountTokenManagerOptions {
  /** Absolute URL of the renewal endpoint. */
  refreshUrl: string;
  storage?: Storage;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Called once when a credential is rejected, before the error surfaces. */
  onSessionExpired?: () => void;
}

export function accountRefreshUrl(siteRoot: string): string {
  return new URL(ACCOUNT_REFRESH_PATH, siteRoot).href;
}

/** Mirrors the desktop's extractor: new-api varies this shape by deployment. */
export function extractAccessToken(value: unknown): string {
  return rawTokenFromValue(value);
}

export function extractAuthSessionId(value: unknown): string | undefined {
  return sessionIdFromValue(value);
}

export function extractAccessExpiry(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  return value.access_expires_at ?? value.accessExpiresAt ?? value.expires_at;
}

export class AccountTokenManager {
  private readonly refreshUrl: string;
  private readonly storage: Storage;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private onSessionExpired: (() => void) | undefined;
  private refreshInFlight: Promise<AccountSession> | null = null;

  constructor(options: AccountTokenManagerOptions) {
    this.refreshUrl = options.refreshUrl;
    this.storage = options.storage ?? localStorage;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.now = options.now ?? (() => Date.now());
    this.onSessionExpired = options.onSessionExpired;
  }

  /** Registers the surface-specific reaction to a dead credential. */
  onExpired(handler: () => void): void {
    this.onSessionExpired = handler;
  }

  /** The stored session without touching the network. */
  peek(): AccountSession | null {
    return loadAccountSession(this.storage);
  }

  /**
   * Stores a credential straight from a login response.
   *
   * `expiresAt` accepts new-api's unix seconds (or milliseconds); when the
   * response carries none, the desktop's assumed lifetime applies so that
   * renewal still happens ahead of the first rejection.
   */
  rememberLogin(credential: {
    accessToken: string;
    expiresAt?: unknown;
    authSessionId?: string;
  }): void {
    saveAccountCredential(
      {
        accessToken: credential.accessToken,
        expiresAtMs: this.expiryToMs(credential.expiresAt) ?? this.now() + FALLBACK_LIFETIME_MS,
        authSessionId: credential.authSessionId,
      },
      this.storage,
    );
  }

  /** Forgets the credential locally. Used by an explicit sign-out. */
  forget(): void {
    this.refreshInFlight = null;
    clearAccountCredential(this.storage);
  }

  /**
   * Signs out for real: the refresh session dies at the server too, so a
   * copied cookie cannot outlive the click. Local state is cleared even when
   * the call fails, because the user asked to be signed out.
   */
  async revoke(): Promise<void> {
    const session = this.peek();
    const headers: Record<string, string> = { Accept: "application/json" };
    if (session?.authSessionId) headers["X-Auth-Session"] = session.authSessionId;
    this.forget();
    try {
      // `.../auth/refresh` and `.../auth/logout` are siblings upstream, so the
      // deployment only ever has to route one directory.
      await this.fetchImpl(new URL("./logout", this.refreshUrl).href, {
        method: "POST",
        cache: "no-store",
        credentials: "include",
        headers,
      });
    } catch {
      // Offline sign-out still ends the local session.
    }
  }

  /**
   * A session that is expected to be accepted, renewing it when it is close
   * to expiry.
   *
   * A renewal that cannot be reached falls back to the stored token rather
   * than signing the user out: the expiry may be this client's conservative
   * estimate, and the request itself is the authority on whether it still
   * works.
   */
  async currentSession(): Promise<AccountSession> {
    const stored = loadAccountSession(this.storage);
    if (!stored) throw new AccountSessionError("signed-out");
    if (stored.expiresAtMs === undefined || stored.expiresAtMs - RENEWAL_SKEW_MS > this.now()) {
      return stored;
    }
    try {
      return await this.refresh();
    } catch (error) {
      if (error instanceof AccountSessionError && error.reason === "unavailable") {
        return stored;
      }
      throw error;
    }
  }

  /**
   * Renews now, collapsing concurrent callers onto one request. Each renewal
   * rotates the cookie, so two in flight would invalidate each other.
   */
  async refresh(): Promise<AccountSession> {
    const existing = this.refreshInFlight;
    if (existing) return existing;
    const attempt = this.performRefresh();
    this.refreshInFlight = attempt;
    try {
      return await attempt;
    } finally {
      if (this.refreshInFlight === attempt) this.refreshInFlight = null;
    }
  }

  /**
   * Runs an authenticated call, renewing and retrying once if the credential
   * is rejected. `call` owns the request because the account API and the
   * remote gateway carry the same credential under different header names.
   */
  async fetchWithSession(
    call: (session: AccountSession) => Promise<Response>,
  ): Promise<Response> {
    const session = await this.currentSession();
    const response = await call(session);
    if (!isRejection(response.status)) return response;

    let renewed: AccountSession;
    try {
      renewed = await this.refresh();
    } catch (error) {
      // The call already returned a definitive rejection, so replaying the
      // same credential can only fail identically. Whatever went wrong with
      // renewal, this session is finished.
      if (error instanceof AccountSessionError && error.reason === "signed-out") throw error;
      this.expire();
      throw new AccountSessionError("expired");
    }
    const retried = await call(renewed);
    if (isRejection(retried.status)) {
      this.expire();
      throw new AccountSessionError("expired");
    }
    return retried;
  }

  private async performRefresh(): Promise<AccountSession> {
    const stored = loadAccountSession(this.storage);
    if (!stored) throw new AccountSessionError("signed-out");

    const headers: Record<string, string> = { Accept: "application/json" };
    if (stored.authSessionId) headers["X-Auth-Session"] = stored.authSessionId;

    let response: Response;
    try {
      response = await this.fetchImpl(this.refreshUrl, {
        method: "POST",
        cache: "no-store",
        // The rotating refresh cookie is the whole credential here.
        credentials: "include",
        headers,
      });
    } catch {
      throw new AccountSessionError("unavailable");
    }

    if (isRejection(response.status)) {
      this.expire();
      throw new AccountSessionError("expired");
    }
    if (!response.ok) {
      // Includes a 404 from an edge that does not route the renewal path yet:
      // a deployment gap must not evict a session that still works.
      throw new AccountSessionError("unavailable");
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new AccountSessionError("unavailable");
    }
    if (isRecord(payload) && payload.success === false) {
      this.expire();
      throw new AccountSessionError("expired");
    }
    const data = isRecord(payload) && isRecord(payload.data) ? payload.data : payload;
    const accessToken = rawTokenFromValue(data);
    if (!accessToken) throw new AccountSessionError("unavailable");

    const expiresAtMs =
      this.expiryToMs(
        isRecord(data)
          ? data.access_expires_at ?? data.accessExpiresAt ?? data.expires_at
          : undefined,
      ) ?? this.now() + FALLBACK_LIFETIME_MS;
    const authSessionId = sessionIdFromValue(data) ?? stored.authSessionId;

    saveAccountCredential({ accessToken, expiresAtMs, authSessionId }, this.storage);
    return { userId: stored.userId, accessToken, expiresAtMs, authSessionId };
  }

  private expire(): void {
    clearAccountCredential(this.storage);
    const handler = this.onSessionExpired;
    if (handler) handler();
  }

  private expiryToMs(value: unknown): number | undefined {
    const parsed =
      typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
    // new-api reports unix seconds; tolerate a millisecond deployment.
    const milliseconds = Math.round(parsed > 1e11 ? parsed : parsed * 1000);
    return Number.isSafeInteger(milliseconds) && milliseconds > this.now()
      ? milliseconds
      : undefined;
  }
}

function isRejection(status: number): boolean {
  return status === 401 || status === 403;
}

/** Mirrors the desktop's extractor: new-api varies this shape by deployment. */
function rawTokenFromValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!isRecord(value)) return "";
  for (const key of ["access_token", "accessToken", "token", "user_token", "key"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return value.data === undefined ? "" : rawTokenFromValue(value.data);
}

function sessionIdFromValue(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.session)) return undefined;
  const sid = value.session.sid;
  return typeof sid === "string" && sid.trim() ? sid.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
