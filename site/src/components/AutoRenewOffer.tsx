import { useEffect, useState } from "react";
import type { Lang } from "../i18n";
import { accountTokens, useAuth } from "../context/AuthContext";
import { beginAutoRenewSign, getAutoRenewSubscription } from "../autoRenew";
import { AUTO_RENEW_OFFER, AUTO_RENEW_SIGN_AVAILABLE, yuan } from "../billingConfig";

const labels = {
  zh: {
    title: "SomniQ Studio 专业版 · 月度自动续费",
    charge: (amount: string) => `开通后每个计费月自动扣款 ${amount}。`,
    cancel: "可随时在个人中心 → 我的会员 → 自动续费管理关闭；关闭后不再产生下一周期扣款。",
    consentStart: "我已阅读并同意",
    consentEnd: (amount: string, merchant: string) => `中的自动续费条款，授权 ${merchant} 按每个自然月 ${amount} 自动续费，可随时取消。`,
    serviceAgreement: "《用户服务协议》",
    confirm: "确认开通自动续费",
    signing: "正在前往支付渠道签约…",
    unavailable: "签约服务尚未开放，此页面不会发起自动扣款。",
    statusUnknown: "暂时无法确认是否已有签约，请稍后重试。",
    alreadyActive: "已开通自动续费，可在个人中心查询和关闭。",
    manage: "管理自动续费",
    error: "无法发起签约，请稍后重试。未完成支付渠道签约前不会自动扣款。",
  },
  en: {
    title: "SomniQ Studio Pro · Monthly auto-renewal",
    charge: (amount: string) => `${amount} will be charged automatically each billing month after you subscribe.`,
    cancel: "You can turn it off at any time in Account → My membership → Auto-renewal. No further period will be charged after cancellation.",
    consentStart: "I have read and agree to the",
    consentEnd: (amount: string, merchant: string) => ` renewal terms and authorize ${merchant} to charge ${amount} each calendar month. I can cancel at any time.`,
    serviceAgreement: "User Service Agreement",
    confirm: "Authorize auto-renewal",
    signing: "Opening the payment authorization…",
    unavailable: "Payment authorization is not yet available. This page cannot start recurring charges.",
    statusUnknown: "We cannot verify whether you already have an authorization. Please try again later.",
    alreadyActive: "Auto-renewal is on. You can review or cancel it in your account.",
    manage: "Manage auto-renewal",
    error: "We could not start authorization. No recurring charge can occur until you complete it with the payment provider.",
  },
  es: {
    title: "SomniQ Studio Pro · Renovación mensual",
    charge: (amount: string) => `Tras la suscripción se cobrarán automáticamente ${amount} cada mes de facturación.`,
    cancel: "Puedes desactivarla en cualquier momento en Cuenta → Mi membresía → Renovación automática. No se cobrará el siguiente periodo.",
    consentStart: "He leído y acepto el",
    consentEnd: (amount: string, merchant: string) => ` y sus condiciones de renovación, y autorizo a ${merchant} a cobrar ${amount} cada mes natural. Puedo cancelar en cualquier momento.`,
    serviceAgreement: "Acuerdo de servicio",
    confirm: "Autorizar renovación automática",
    signing: "Abriendo la autorización de pago…",
    unavailable: "La autorización de pago aún no está disponible. Esta página no puede iniciar cobros recurrentes.",
    statusUnknown: "No podemos verificar si ya tienes una autorización. Inténtalo más tarde.",
    alreadyActive: "La renovación automática está activada. Puedes consultarla o cancelarla en tu cuenta.",
    manage: "Gestionar renovación",
    error: "No se pudo iniciar la autorización. No habrá cobros recurrentes hasta que la completes con el proveedor de pagos.",
  },
};

type MandateState = "unknown" | "none" | "active" | "unavailable";

export default function AutoRenewOffer({ lang }: { lang: Lang }) {
  const { user } = useAuth();
  const t = labels[lang];
  const [accepted, setAccepted] = useState(false);
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState("");
  const [mandate, setMandate] = useState<MandateState>("unknown");

  useEffect(() => {
    if (!user?.id) {
      setMandate("unknown");
      return;
    }
    let mounted = true;
    getAutoRenewSubscription(accountTokens()).then(
      (subscription) => {
        if (mounted) setMandate(subscription.status === "active" ? "active" : "none");
      },
      () => { if (mounted) setMandate("unavailable"); },
    );
    return () => { mounted = false; };
  }, [user?.id]);

  const sign = async () => {
    if (!user || !accepted || !AUTO_RENEW_SIGN_AVAILABLE || mandate !== "none" || signing) return;
    setError("");
    setSigning(true);
    try {
      const url = await beginAutoRenewSign(accountTokens());
      window.location.assign(url);
    } catch {
      setError(t.error);
      setSigning(false);
    }
  };

  const price = yuan(AUTO_RENEW_OFFER.amountFen);
  const canSign = accepted && AUTO_RENEW_SIGN_AVAILABLE && !signing && mandate === "none";

  return (
    <section className="auto-renew-offer" aria-labelledby="auto-renew-offer-title">
      <div className="auto-renew-offer-head">
        <span className="auto-renew-offer-eyebrow">AUTO RENEWAL · 自动续费</span>
        <h2 id="auto-renew-offer-title">{t.title}</h2>
        <strong>{price}<span>{lang === "zh" ? "/月" : lang === "es" ? "/mes" : "/month"}</span></strong>
      </div>
      <p className="auto-renew-charge">{t.charge(price)}</p>
      <p className="auto-renew-cancel-rule">{t.cancel}</p>

      {mandate === "active" ? (
        <div className="auto-renew-sign-state">
          <p>{t.alreadyActive}</p>
          <a className="btn btn--outline" href="#auto-renew-manage-title">{t.manage}</a>
        </div>
      ) : (
        <>
          <label className="auto-renew-consent">
            <input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />
            <span>
              {t.consentStart}{" "}
              <a href={`./user-service-agreement.html?lang=${lang}#legal-auto-renewal`} target="_blank" rel="noopener noreferrer">{t.serviceAgreement}</a>
              {t.consentEnd(price, AUTO_RENEW_OFFER.merchantLegalName)}
            </span>
          </label>
          <button type="button" className="btn btn--primary btn--lg auto-renew-sign-btn" disabled={!canSign} onClick={() => void sign()}>
            {signing ? t.signing : t.confirm}
          </button>
          <p className="auto-renew-sign-footnote" role="status">
            {!AUTO_RENEW_SIGN_AVAILABLE ? t.unavailable : mandate === "unavailable" ? t.statusUnknown : null}
          </p>
          {error ? <p className="auto-renew-sign-error" role="alert">{error}</p> : null}
        </>
      )}
    </section>
  );
}
