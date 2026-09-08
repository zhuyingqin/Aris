import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ACCOUNT_ACCESS_EXPIRES_KEY,
  ACCOUNT_ACCESS_TOKEN_KEY,
  ACCOUNT_AUTH_SESSION_KEY,
  ACCOUNT_PROFILE_KEY,
} from "./account";
import { AccountSessionError, AccountTokenManager, accountRefreshUrl } from "./accountToken";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const REFRESH_URL = "https://somni.chat/api/user/auth/refresh";
let clock = 1_800_000_000_000;

function storageWith(overrides: Record<string, string> = {}): MemoryStorage {
  const storage = new MemoryStorage();
  storage.setItem(ACCOUNT_PROFILE_KEY, JSON.stringify({ id: 42, username: "researcher" }));
  storage.setItem(ACCOUNT_ACCESS_TOKEN_KEY, "old-token");
  storage.setItem(ACCOUNT_AUTH_SESSION_KEY, "sid-1");
  storage.setItem(ACCOUNT_ACCESS_EXPIRES_KEY, String(clock + 10 * 60_000));
  for (const [key, value] of Object.entries(overrides)) storage.setItem(key, value);
  return storage;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renewalBody(token = "fresh-token", accessExpiresAt = (clock + 900_000) / 1000) {
  return { success: true, data: { access_token: token, access_expires_at: accessExpiresAt } };
}

function managerFor(
  storage: Storage,
  fetchImpl: ReturnType<typeof vi.fn>,
  onSessionExpired?: () => void,
) {
  return new AccountTokenManager({
    refreshUrl: REFRESH_URL,
    storage,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => clock,
    onSessionExpired,
  });
}

beforeEach(() => {
  clock = 1_800_000_000_000;
});

describe("account token renewal", () => {
  it("resolves the renewal endpoint under the site root, not the PWA mount", () => {
    expect(accountRefreshUrl("https://somni.chat/")).toBe(REFRESH_URL);
    expect(accountRefreshUrl("https://somni.chat/somniq/")).toBe(
      "https://somni.chat/somniq/api/user/auth/refresh",
    );
  });

  it("uses the stored token untouched while it is far from expiry", async () => {
    const fetchImpl = vi.fn();
    const session = await managerFor(storageWith(), fetchImpl).currentSession();
    expect(session).toMatchObject({ userId: 42, accessToken: "old-token" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("renews inside the skew window and persists the rotated credential", async () => {
    const storage = storageWith({ [ACCOUNT_ACCESS_EXPIRES_KEY]: String(clock + 30_000) });
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        success: true,
        data: {
          access_token: "fresh-token",
          access_expires_at: (clock + 900_000) / 1000,
          session: { sid: "sid-2" },
        },
      }),
    );

    const session = await managerFor(storage, fetchImpl).currentSession();

    expect(session.accessToken).toBe("fresh-token");
    expect(storage.getItem(ACCOUNT_ACCESS_TOKEN_KEY)).toBe("fresh-token");
    expect(storage.getItem(ACCOUNT_AUTH_SESSION_KEY)).toBe("sid-2");
    expect(Number(storage.getItem(ACCOUNT_ACCESS_EXPIRES_KEY))).toBe(clock + 900_000);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(REFRESH_URL);
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect((init.headers as Record<string, string>)["X-Auth-Session"]).toBe("sid-1");
  });

  it("renews a session whose token predates renewal only after a rejection", async () => {
    const storage = storageWith();
    storage.removeItem(ACCOUNT_ACCESS_EXPIRES_KEY);
    const fetchImpl = vi.fn(async () => jsonResponse(renewalBody()));
    const manager = managerFor(storage, fetchImpl);

    expect((await manager.currentSession()).accessToken).toBe("old-token");
    expect(fetchImpl).not.toHaveBeenCalled();

    const call = vi.fn(async (session: { accessToken: string }) =>
      session.accessToken === "fresh-token" ? jsonResponse({ ok: true }) : jsonResponse({}, 401),
    );
    const response = await manager.fetchWithSession(call);

    expect(response.status).toBe(200);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("collapses concurrent renewals onto a single rotating request", async () => {
    const storage = storageWith({ [ACCOUNT_ACCESS_EXPIRES_KEY]: String(clock + 30_000) });
    const fetchImpl = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return jsonResponse(renewalBody());
    });
    const manager = managerFor(storage, fetchImpl);

    const sessions = await Promise.all([
      manager.currentSession(),
      manager.currentSession(),
      manager.currentSession(),
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sessions.map((session) => session.accessToken)).toEqual([
      "fresh-token",
      "fresh-token",
      "fresh-token",
    ]);
  });

  it("assumes the desktop's lifetime when the response reports no expiry", async () => {
    const storage = storageWith({ [ACCOUNT_ACCESS_EXPIRES_KEY]: String(clock + 30_000) });
    const fetchImpl = vi.fn(async () => jsonResponse({ success: true, data: { access_token: "fresh-token" } }));

    await managerFor(storage, fetchImpl).currentSession();

    expect(Number(storage.getItem(ACCOUNT_ACCESS_EXPIRES_KEY))).toBe(clock + 14 * 60_000);
  });

  it("accepts a millisecond expiry without shortening the session", async () => {
    const storage = storageWith({ [ACCOUNT_ACCESS_EXPIRES_KEY]: String(clock + 30_000) });
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ success: true, data: { access_token: "fresh-token", access_expires_at: clock + 900_000 } }),
    );

    await managerFor(storage, fetchImpl).currentSession();

    expect(Number(storage.getItem(ACCOUNT_ACCESS_EXPIRES_KEY))).toBe(clock + 900_000);
  });

  it("keeps the credential when renewal is unreachable", async () => {
    const storage = storageWith({ [ACCOUNT_ACCESS_EXPIRES_KEY]: String(clock + 30_000) });
    const expired = vi.fn();
    const offline = vi.fn(async () => { throw new TypeError("network down"); });

    const session = await managerFor(storage, offline, expired).currentSession();

    expect(session.accessToken).toBe("old-token");
    expect(storage.getItem(ACCOUNT_ACCESS_TOKEN_KEY)).toBe("old-token");
    expect(expired).not.toHaveBeenCalled();
  });

  it("keeps the credential when the edge does not route renewal yet", async () => {
    const storage = storageWith({ [ACCOUNT_ACCESS_EXPIRES_KEY]: String(clock + 30_000) });
    const expired = vi.fn();
    const notFound = vi.fn(async () => new Response("<!doctype html>", { status: 404 }));

    const session = await managerFor(storage, notFound, expired).currentSession();

    expect(session.accessToken).toBe("old-token");
    expect(expired).not.toHaveBeenCalled();
  });

  it("drops the credential when renewal is rejected", async () => {
    const storage = storageWith({ [ACCOUNT_ACCESS_EXPIRES_KEY]: String(clock + 30_000) });
    const expired = vi.fn();
    const rejected = vi.fn(async () => jsonResponse({ success: false, message: "Unauthorized" }, 401));

    await expect(managerFor(storage, rejected, expired).currentSession()).rejects.toMatchObject({
      reason: "expired",
    });
    expect(storage.getItem(ACCOUNT_ACCESS_TOKEN_KEY)).toBeNull();
    expect(storage.getItem(ACCOUNT_ACCESS_EXPIRES_KEY)).toBeNull();
    // The cached profile survives so the login screen can still greet the user.
    expect(storage.getItem(ACCOUNT_PROFILE_KEY)).not.toBeNull();
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it("drops the credential when renewal answers success:false with a 200", async () => {
    const storage = storageWith({ [ACCOUNT_ACCESS_EXPIRES_KEY]: String(clock + 30_000) });
    const refused = vi.fn(async () => jsonResponse({ success: false, message: "session revoked" }));

    await expect(managerFor(storage, refused).currentSession()).rejects.toMatchObject({
      reason: "expired",
    });
    expect(storage.getItem(ACCOUNT_ACCESS_TOKEN_KEY)).toBeNull();
  });

  it("renews and replays a call the account API rejected", async () => {
    const storage = storageWith();
    const fetchImpl = vi.fn(async () => jsonResponse(renewalBody()));
    const manager = managerFor(storage, fetchImpl);
    const seen: string[] = [];
    const call = vi.fn(async (session: { accessToken: string }) => {
      seen.push(session.accessToken);
      return session.accessToken === "fresh-token" ? jsonResponse({ devices: [] }) : jsonResponse({}, 403);
    });

    const response = await manager.fetchWithSession(call);

    expect(response.status).toBe(200);
    expect(seen).toEqual(["old-token", "fresh-token"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("ends the session when the replay is rejected too", async () => {
    const storage = storageWith();
    const expired = vi.fn();
    const fetchImpl = vi.fn(async () => jsonResponse(renewalBody()));
    const manager = managerFor(storage, fetchImpl, expired);

    await expect(manager.fetchWithSession(async () => jsonResponse({}, 401))).rejects.toMatchObject({
      reason: "expired",
    });
    expect(storage.getItem(ACCOUNT_ACCESS_TOKEN_KEY)).toBeNull();
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it("ends the session when a rejected call cannot be renewed", async () => {
    const storage = storageWith();
    const expired = vi.fn();
    const offline = vi.fn(async () => { throw new TypeError("network down"); });
    const manager = managerFor(storage, offline, expired);

    // Unlike a merely near-expiry token, a credential the API just rejected
    // cannot be salvaged by replaying it.
    await expect(manager.fetchWithSession(async () => jsonResponse({}, 401))).rejects.toMatchObject({
      reason: "expired",
    });
    expect(storage.getItem(ACCOUNT_ACCESS_TOKEN_KEY)).toBeNull();
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it("reports a signed-out browser without calling renewal", async () => {
    const storage = new MemoryStorage();
    const fetchImpl = vi.fn();
    const manager = managerFor(storage, fetchImpl);

    await expect(manager.currentSession()).rejects.toBeInstanceOf(AccountSessionError);
    await expect(manager.currentSession()).rejects.toMatchObject({ reason: "signed-out" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stores a login credential with its reported expiry and session id", () => {
    const storage = new MemoryStorage();
    storage.setItem(ACCOUNT_PROFILE_KEY, JSON.stringify({ id: 42 }));
    const manager = managerFor(storage, vi.fn());

    manager.rememberLogin({
      accessToken: "login-token",
      expiresAt: (clock + 900_000) / 1000,
      authSessionId: "sid-9",
    });

    expect(manager.peek()).toMatchObject({
      userId: 42,
      accessToken: "login-token",
      expiresAtMs: clock + 900_000,
      authSessionId: "sid-9",
    });
  });

  it("forgets everything on an explicit sign-out", () => {
    const storage = storageWith();
    const manager = managerFor(storage, vi.fn());

    manager.forget();

    expect(manager.peek()).toBeNull();
    expect(storage.getItem(ACCOUNT_AUTH_SESSION_KEY)).toBeNull();
  });
});
