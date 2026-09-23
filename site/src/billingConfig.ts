import { USER_SERVICE_AGREEMENT_VERSION } from "./agreementConfig";

/**
 * Public terms shown before authorization. Keep these values identical to the
 * offer configured by the account/payment backend before enabling signing.
 */
export const AUTO_RENEW_OFFER = {
  planId: "somniq-pro-monthly",
  planName: "SomniQ Studio 专业版",
  amountFen: 7900,
  currency: "CNY" as const,
  period: "calendar_month" as const,
  agreementVersion: USER_SERVICE_AGREEMENT_VERSION,
  merchantLegalName: (import.meta.env.VITE_SOMNIQ_MERCHANT_LEGAL_NAME ?? "重庆应算科技有限公司").trim(),
};

/** A missing payment integration must never look like a working mandate. */
export const AUTO_RENEW_SIGN_AVAILABLE =
  import.meta.env.VITE_SOMNIQ_AUTO_RENEW_SIGN_ENABLED === "true"
  && AUTO_RENEW_OFFER.merchantLegalName.length > 0;

export function yuan(amountFen: number): string {
  return `¥${(amountFen / 100).toFixed(2)}`;
}
