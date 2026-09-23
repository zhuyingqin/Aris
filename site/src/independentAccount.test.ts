import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptAccountAgreement, beginComputeConnection, loadComputeUsage, loadIndependentAccount, logoutIndependentAccount } from "./independentAccount";

afterEach(() => vi.unstubAllGlobals());
describe("independent account boundary", () => {
  it("uses a server session and never reads legacy credentials", async () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("must not read legacy tokens"); } });
    const payload = { user: { id: "c09d8867-2b60-48b8-992a-17018ee77110", email: "a@example.invalid", display_name: "Alice" }, agreement_required: false, compute_connected: true };
    const fetcher = vi.fn(async () => new Response(JSON.stringify(payload)));
    vi.stubGlobal("fetch", fetcher);
    expect(await loadIndependentAccount()).toEqual(payload);
    expect(fetcher).toHaveBeenCalledWith("/v2/account/me", { credentials: "same-origin", cache: "no-store", redirect: "error" });
  });
  it("treats only a rejected session as signed out", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    expect(await loadIndependentAccount()).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    await expect(loadIndependentAccount()).rejects.toMatchObject({ status: 503 });
  });
  it("rejects a numeric legacy identity instead of coercing it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ user: { id: 42 } }))));
    await expect(loadIndependentAccount()).rejects.toMatchObject({ code: "invalid_account" });
  });
  it("submits the exact displayed agreement and revokes the server session", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 })); vi.stubGlobal("fetch", fetcher);
    await acceptAccountAgreement({ version: "v2", text: "Terms", content_hash: "expected" });
    expect(JSON.parse(fetcher.mock.calls[0][1].body as string)).toEqual({ version: "v2", content_hash: "expected", accepted: true });
    await logoutIndependentAccount();
    expect(fetcher.mock.calls[1][0]).toBe("/v2/account/logout");
    expect(fetcher.mock.calls[1][1].method).toBe("POST");
  });
  it("does not accept script redirects or reinterpret unknown quota units", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ authorization_url: "javascript:alert(1)" }))));
    await expect(beginComputeConnection()).rejects.toMatchObject({ code: "invalid_authorization_url" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ quota: 1, used_quota: 2, request_count: 3, unit: "tokens" }))));
    await expect(loadComputeUsage()).rejects.toMatchObject({ code: "invalid_usage" });
  });
});
