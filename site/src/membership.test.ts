import { afterEach, describe, expect, it, vi } from "vitest";
import { assignMembership, loadMembershipCatalog, membershipError, modelLines, nextMembershipMonth, saveMembershipPlan } from "./membership";
import { IndependentAccountError } from "./independentAccount";

afterEach(() => vi.unstubAllGlobals());
describe("membership API boundary", () => {
  it("loads authoritative Go/Plus/Pro monthly prices without legacy credentials", async () => {
    const plans = ["go", "plus", "pro"].map((id, i) => ({ id, name: id, amount_fen: [2900, 4900, 9900][i], currency: "CNY", billing_period: "month", models: [], enabled: false, revision: 1 }));
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ plans, checkout_available: false })));
    vi.stubGlobal("fetch", fetcher);
    expect((await loadMembershipCatalog()).plans.map(p => p.amount_fen)).toEqual([2900, 4900, 9900]);
    expect(fetcher.mock.calls[0][0]).toBe("/v2/catalog/plans");
    expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: "same-origin", cache: "no-store", redirect: "error" });
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty("headers");
  });
  it("does not substitute old prices for an unavailable or malformed catalog", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));
    await expect(loadMembershipCatalog()).rejects.toMatchObject({ status: 503 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ plans: [] }))));
    await expect(loadMembershipCatalog()).rejects.toMatchObject({ code: "invalid_catalog" });
  });
  it("sends versioned updates and explicit expiry to the administrator endpoint", async () => {
    const fetcher = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetcher);
    await saveMembershipPlan("go", { models: ["basic"], default_executor: "basic", default_reviewer: "basic", enabled: true, expected_revision: 8 });
    expect(fetcher.mock.calls[0][0]).toBe("/v2/admin/plans/go");
    expect(fetcher.mock.calls[0][1].method).toBe("PUT");
    expect(JSON.parse(fetcher.mock.calls[0][1].body as string).expected_revision).toBe(8);
    await assignMembership("person/id", "plus", 2000000000, 4, "Verified order");
    expect(fetcher.mock.calls[1][0]).toBe("/v2/admin/users/person%2Fid/membership");
    expect(JSON.parse(fetcher.mock.calls[1][1].body as string)).toEqual({ plan_id: "plus", expires_at: 2000000000, expected_revision: 4, reason: "Verified order" });
  });
  it("surfaces stale-update conflicts without silently retrying mutations", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: { code: "revision_conflict" } }), { status: 409 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(assignMembership("person", null, null, 2, "Revoke")).rejects.toMatchObject({ code: "revision_conflict", status: 409 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(membershipError(new IndependentAccountError("revision_conflict", 409))).toContain("刷新");
  });
  it("keeps model case significant and deduplicates multiline configuration", () => {
    expect(modelLines(" basic\r\nadvanced\nbasic\nBASIC\n")).toEqual(["BASIC", "advanced", "basic"]);
  });
  it("suggests one calendar month clamped to month end, including leap years", () => {
    for (const [from, expected] of [
      [new Date(2026, 0, 31, 12, 30), new Date(2026, 1, 28, 12, 30)],
      [new Date(2028, 0, 31, 12, 30), new Date(2028, 1, 29, 12, 30)],
      [new Date(2026, 11, 23, 12, 30), new Date(2027, 0, 23, 12, 30)],
    ]) {
      const original = from.getTime();
      expect(nextMembershipMonth(from)).toEqual(expected);
      expect(from.getTime()).toBe(original);
    }
  });
});
