import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountTokenManager } from "../remote/src/accountToken";
import { AUTO_RENEW_OFFER } from "./billingConfig";
import { USER_SERVICE_AGREEMENT_VERSION } from "./agreementConfig";
import {
  AutoRenewApiError,
  beginAutoRenewSign,
  cancelAutoRenewSubscription,
  parseAutoRenewSubscription,
} from "./autoRenew";

const tokens = {
  fetchWithSession: (call: (session: { accessToken: string; userId: number }) => Promise<Response>) =>
    call({ accessToken: "test-token", userId: 42 }),
} as AccountTokenManager;

afterEach(() => vi.unstubAllGlobals());

describe("auto-renew mandate responses", () => {
  it("submits the consolidated user agreement version when authorizing recurring payment", async () => {
    const fetchMock = vi.fn(async (_path: string, options: RequestInit) => {
      expect(JSON.parse(options.body as string)).toEqual({
        plan_id: AUTO_RENEW_OFFER.planId,
        agreement_version: USER_SERVICE_AGREEMENT_VERSION,
        consent: true,
      });
      return new Response(JSON.stringify({
        success: true,
        data: {
          sign_url: "https://pay.example.test/authorize",
          amount_fen: AUTO_RENEW_OFFER.amountFen,
          currency: AUTO_RENEW_OFFER.currency,
          period: AUTO_RENEW_OFFER.period,
          merchant_name: AUTO_RENEW_OFFER.merchantLegalName,
        },
      }), { headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(beginAutoRenewSign(tokens)).resolves.toBe("https://pay.example.test/authorize");
    expect(fetchMock).toHaveBeenCalledWith("./v1/user/auto-renew/sign", expect.objectContaining({ method: "POST" }));
  });

  it("accepts an explicit unsigned state without treating quota as a mandate", () => {
    expect(parseAutoRenewSubscription({ status: "none", quota: 50_000_000 })).toEqual({ status: "none" });
  });

  it("requires a real next charge amount and date before displaying an active mandate", () => {
    expect(parseAutoRenewSubscription({
      status: "active",
      plan_name: "SomniQ Studio Pro",
      current_period_end: "2026-10-22T00:00:00+08:00",
      next_charge_at: "2026-10-22T00:00:00+08:00",
      next_charge_fen: 7900,
      currency: "CNY",
    })).toMatchObject({ status: "active", nextChargeFen: 7900 });

    for (const nextChargeFen of [undefined, "7900", 0, -1]) {
      expect(() => parseAutoRenewSubscription({
        status: "active",
        plan_name: "SomniQ Studio Pro",
        current_period_end: "2026-10-22T00:00:00+08:00",
        next_charge_at: "2026-10-22T00:00:00+08:00",
        next_charge_fen: nextChargeFen,
        currency: "CNY",
      })).toThrow(AutoRenewApiError);
    }
  });

  it("never invents a subscription from a group or a balance", () => {
    expect(() => parseAutoRenewSubscription({ group: "vip", quota: 50_000_000 })).toThrow(AutoRenewApiError);
  });

  it("discards future charge details after cancellation", () => {
    expect(parseAutoRenewSubscription({
      status: "cancelled",
      plan_name: "SomniQ Studio Pro",
      current_period_end: "2026-10-22T00:00:00+08:00",
      next_charge_at: "2026-10-22T00:00:00+08:00",
      next_charge_fen: 7900,
      currency: "CNY",
    })).toEqual({
      status: "cancelled",
      planName: "SomniQ Studio Pro",
      currentPeriodEnd: "2026-10-22T00:00:00+08:00",
      nextChargeAt: null,
      nextChargeFen: null,
      currency: "CNY",
    });
  });

  it("requires backend cancellation confirmation before showing the mandate as closed", async () => {
    const fetchMock = vi.fn(async (_path: string, options: RequestInit) => {
      expect(options.method).toBe("POST");
      expect(options.headers).toMatchObject({ Authorization: "Bearer test-token", "New-Api-User": "42" });
      return new Response(JSON.stringify({ success: true, data: { status: "none" } }), {
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    expect((await cancelAutoRenewSubscription(tokens)).status).toBe("none");
    expect(fetchMock).toHaveBeenCalledWith("./v1/user/auto-renew/cancel", expect.anything());
  });

  it("rejects a payment authorization whose server quote differs from the visible terms", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: {
        sign_url: "https://pay.example.test/authorize",
        amount_fen: AUTO_RENEW_OFFER.amountFen + 1,
        currency: "CNY",
        period: AUTO_RENEW_OFFER.period,
        merchant_name: AUTO_RENEW_OFFER.merchantLegalName,
      },
    }), { headers: { "Content-Type": "application/json" } })));
    await expect(beginAutoRenewSign(tokens)).rejects.toMatchObject({ reason: "invalid" });
  });
});
