import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ACCOUNT_ACCESS_EXPIRES_KEY,
  ACCOUNT_ACCESS_TOKEN_KEY,
  ACCOUNT_PROFILE_KEY,
} from "./account";
import { AccountGatewayApi } from "./accountGateway";
import { AccountTokenManager } from "./accountToken";
import { GatewayApiError } from "./gateway";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const SITE = "https://somni.chat";
const clock = 1_800_000_000_000;

function signedInStorage(): MemoryStorage {
  const storage = new MemoryStorage();
  storage.setItem(ACCOUNT_PROFILE_KEY, JSON.stringify({ id: 42, username: "researcher" }));
  storage.setItem(ACCOUNT_ACCESS_TOKEN_KEY, "old-token");
  storage.setItem(ACCOUNT_ACCESS_EXPIRES_KEY, String(clock + 10 * 60_000));
  return storage;
}

function managerFor(storage: Storage, refreshFetch: typeof fetch = (async () => new Response("{}")) as typeof fetch) {
  return new AccountTokenManager({
    refreshUrl: `${SITE}/api/user/auth/refresh`,
    storage,
    fetchImpl: refreshFetch,
    now: () => clock,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("account gateway client", () => {
  it("carries the account credential and returns validated devices", async () => {
    const calls: Array<[string, RequestInit]> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return jsonResponse([{ id: "desk-1", name: "研究工作站", online: true }]);
    }));

    const api = new AccountGatewayApi(managerFor(signedInStorage()), SITE);
    const devices = await api.devices(SITE);

    expect(devices).toEqual([{ id: "desk-1", name: "研究工作站", online: true }]);
    const [url, init] = calls[0];
    expect(url).toBe(`${SITE}/v1/account/devices`);
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Somniq-Account-Authorization"]).toBe("Bearer old-token");
    expect(headers["X-Somniq-Account-User"]).toBe("42");
    // The gateway authenticates on the header, never on an ambient cookie.
    expect(init.credentials).toBe("omit");
  });

  it("rejects a device list the gateway should never have sent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([{ id: "desk-1", name: "", online: true }])));

    const api = new AccountGatewayApi(managerFor(signedInStorage()), SITE);

    await expect(api.devices(SITE)).rejects.toBeInstanceOf(GatewayApiError);
  });

  it("renews a rejected credential and replays the call once", async () => {
    const storage = signedInStorage();
    const refreshFetch = vi.fn(async () =>
      jsonResponse({ success: true, data: { access_token: "fresh-token", access_expires_at: (clock + 900_000) / 1000 } }),
    );
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      seen.push(headers["X-Somniq-Account-Authorization"]);
      return headers["X-Somniq-Account-Authorization"] === "Bearer fresh-token"
        ? jsonResponse([])
        : jsonResponse({ error: "unauthorized" }, 401);
    }));

    const api = new AccountGatewayApi(managerFor(storage, refreshFetch as unknown as typeof fetch), SITE);
    await expect(api.devices(SITE)).resolves.toEqual([]);

    expect(seen).toEqual(["Bearer old-token", "Bearer fresh-token"]);
    expect(refreshFetch).toHaveBeenCalledTimes(1);
  });

  it("never sends the website credential to a QR-selected foreign gateway", async () => {
    const requests = vi.fn(async () => jsonResponse([]));
    vi.stubGlobal("fetch", requests);

    const api = new AccountGatewayApi(managerFor(signedInStorage()), SITE);

    await expect(api.devices("https://attacker.example")).rejects.toMatchObject({ status: 403 });
    expect(requests).not.toHaveBeenCalled();
  });

  it("validates a connect request before the PWA acts on it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse({ request_id: "req-1", status: "pending_desktop", expires_at_unix_ms: clock + 60_000 }),
    ));

    const api = new AccountGatewayApi(managerFor(signedInStorage()), SITE);
    const response = await api.createConnectRequest(SITE, "desk-1", "SomniQ Web · 桌面浏览器");

    expect(response).toMatchObject({ request_id: "req-1", status: "pending_desktop" });
    expect(response.invitation).toBeUndefined();
  });

  it("refuses a connect request that claims readiness with no invitation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse({ request_id: "req-1", status: "invitation_ready", expires_at_unix_ms: clock + 60_000 }),
    ));

    const api = new AccountGatewayApi(managerFor(signedInStorage()), SITE);

    await expect(api.connectRequest(SITE, "req-1")).rejects.toBeInstanceOf(GatewayApiError);
  });
});
