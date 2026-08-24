import { describe, expect, it } from "vitest";

import { accountHeadersForGateway, loadAccountSession } from "./account";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

describe("remote account session", () => {
  it("loads the same account session written by the website", () => {
    const storage = new MemoryStorage();
    storage.setItem("somniq_access_token_v1", "access-token");
    storage.setItem("somniq_user_session_v1", JSON.stringify({ id: 42, username: "researcher" }));
    expect(loadAccountSession(storage)).toEqual({ userId: 42, accessToken: "access-token" });
  });

  it("never forwards the website token to a QR-selected foreign gateway", () => {
    const session = { userId: 42, accessToken: "top-secret" };
    expect(accountHeadersForGateway("https://somni.chat", session, "https://somni.chat")).toEqual({
      "X-Somniq-Account-Authorization": "Bearer top-secret",
      "X-Somniq-Account-User": "42",
    });
    expect(accountHeadersForGateway("https://attacker.example", session, "https://somni.chat")).toEqual({});
  });
});
