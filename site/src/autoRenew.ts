import type { AccountTokenManager } from "../remote/src/accountToken";
import { AUTO_RENEW_OFFER } from "./billingConfig";

/**
 * The account backend is the only authority for a payment mandate. A user's
 * new-api group or token balance does not prove that auto-renewal is enabled.
 */
export type AutoRenewSubscription =
  | { status: "none" }
  | {
      status: "active";
      planName: string;
      currentPeriodEnd: string;
      nextChargeAt: string;
      nextChargeFen: number;
      currency: "CNY";
    }
  | {
      status: "cancelled";
      planName: string;
      currentPeriodEnd: string;
      nextChargeAt: null;
      nextChargeFen: null;
      currency: "CNY";
    };

export class AutoRenewApiError extends Error {
  constructor(public readonly reason: "unavailable" | "invalid" | "rejected") {
    super(reason);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDate(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

export function parseAutoRenewSubscription(value: unknown): AutoRenewSubscription {
  if (!isRecord(value)) throw new AutoRenewApiError("invalid");
  if (value.status === "none") return { status: "none" };
  if (value.status !== "active" && value.status !== "cancelled") {
    throw new AutoRenewApiError("invalid");
  }
  if (typeof value.plan_name !== "string" || !value.plan_name.trim()
    || !isDate(value.current_period_end) || value.currency !== "CNY") {
    throw new AutoRenewApiError("invalid");
  }
  if (value.status === "active") {
    if (!isDate(value.next_charge_at)
      || typeof value.next_charge_fen !== "number"
      || !Number.isSafeInteger(value.next_charge_fen)
      || value.next_charge_fen <= 0) {
      throw new AutoRenewApiError("invalid");
    }
    return {
      status: "active",
      planName: value.plan_name,
      currentPeriodEnd: value.current_period_end,
      nextChargeAt: value.next_charge_at,
      nextChargeFen: value.next_charge_fen,
      currency: "CNY",
    };
  }
  return {
    status: "cancelled",
    planName: value.plan_name,
    currentPeriodEnd: value.current_period_end,
    nextChargeAt: null,
    nextChargeFen: null,
    currency: "CNY",
  };
}

async function accountRequest(
  tokens: AccountTokenManager,
  method: "GET" | "POST",
  path: string,
): Promise<AutoRenewSubscription> {
  const response = await tokens.fetchWithSession((session) =>
    fetch(path, {
      method,
      cache: "no-store",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${session.accessToken}`,
        "New-Api-User": String(session.userId),
      },
    }),
  );
  if (response.status === 404 || response.status === 501) {
    throw new AutoRenewApiError("unavailable");
  }
  if (!response.ok) throw new AutoRenewApiError("rejected");
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new AutoRenewApiError("invalid");
  }
  if (!isRecord(body) || body.success !== true) throw new AutoRenewApiError("rejected");
  return parseAutoRenewSubscription(body.data);
}

/** GET /v1/user/auto-renew must return a server-owned mandate state. */
export function getAutoRenewSubscription(tokens: AccountTokenManager): Promise<AutoRenewSubscription> {
  return accountRequest(tokens, "GET", "./v1/user/auto-renew");
}

/** POST /v1/user/auto-renew/cancel must revoke the payment mandate server-side. */
export function cancelAutoRenewSubscription(tokens: AccountTokenManager): Promise<AutoRenewSubscription> {
  return accountRequest(tokens, "POST", "./v1/user/auto-renew/cancel");
}

/**
 * Start a payment-channel authorization only after an unchecked-by-default
 * consent box has been checked. The backend must record consent and return
 * exactly the terms the customer saw before we redirect to the channel.
 */
export async function beginAutoRenewSign(tokens: AccountTokenManager): Promise<string> {
  const response = await tokens.fetchWithSession((session) =>
    fetch("./v1/user/auto-renew/sign", {
      method: "POST",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.accessToken}`,
        "New-Api-User": String(session.userId),
      },
      body: JSON.stringify({
        plan_id: AUTO_RENEW_OFFER.planId,
        agreement_version: AUTO_RENEW_OFFER.agreementVersion,
        consent: true,
      }),
    }),
  );
  if (response.status === 404 || response.status === 501) throw new AutoRenewApiError("unavailable");
  if (!response.ok) throw new AutoRenewApiError("rejected");
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new AutoRenewApiError("invalid");
  }
  if (!isRecord(body) || body.success !== true || !isRecord(body.data)) {
    throw new AutoRenewApiError("rejected");
  }
  const data = body.data;
  if (data.amount_fen !== AUTO_RENEW_OFFER.amountFen
    || data.currency !== AUTO_RENEW_OFFER.currency
    || data.period !== AUTO_RENEW_OFFER.period
    || data.merchant_name !== AUTO_RENEW_OFFER.merchantLegalName
    || typeof data.sign_url !== "string") {
    throw new AutoRenewApiError("invalid");
  }
  let signUrl: URL;
  try {
    signUrl = new URL(data.sign_url);
  } catch {
    throw new AutoRenewApiError("invalid");
  }
  if (signUrl.protocol !== "https:") throw new AutoRenewApiError("invalid");
  return signUrl.href;
}
