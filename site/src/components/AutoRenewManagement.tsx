import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Lang } from "../i18n";
import { accountTokens, useAuth } from "../context/AuthContext";
import {
  AutoRenewApiError,
  cancelAutoRenewSubscription,
  getAutoRenewSubscription,
  type AutoRenewSubscription,
} from "../autoRenew";

const labels = {
  zh: {
    title: "我的会员 · 自动续费管理",
    description: "自动扣款状态以支付签约记录为准，算力余额不代表已授权代扣。",
    loading: "正在查询自动续费签约状态…",
    unavailable: "当前无法查询自动续费签约记录，请稍后重试。如已签约，可联系 support@somni.chat 核实或关闭。",
    none: "当前没有自动续费签约记录，不会因此自动扣款。",
    cancelled: "自动续费已关闭，当前权益保留至到期日。",
    plan: "当前套餐",
    expires: "当前权益到期",
    state: "自动续费",
    active: "已开启",
    off: "已关闭",
    nextCharge: "下次扣款",
    amount: "预计扣款",
    cancel: "关闭自动续费",
    retry: "重新查询",
    agreement: "查看用户协议中的续费条款",
    confirmTitle: "确认关闭自动续费？",
    confirmBody: (date: string) => `关闭后，当前会员权益仍保留至 ${date}；到期后不再自动扣款。`,
    keep: "暂不关闭",
    confirm: "确认关闭",
    closing: "正在关闭…",
    failed: "关闭失败，自动续费仍可能处于开启状态，请重试或联系 support@somni.chat。",
    cancelledSuccess: "已关闭自动续费，后续周期不再自动扣款。",
  },
  en: {
    title: "My membership · Auto-renewal",
    description: "Payment mandate records determine auto-renewal status. A quota balance does not mean you authorized recurring charges.",
    loading: "Checking your auto-renewal mandate…",
    unavailable: "We cannot check your payment mandate right now. Please try again, or contact support@somni.chat to verify or cancel it.",
    none: "No auto-renewal mandate is recorded for this account.",
    cancelled: "Auto-renewal is off. Your current benefits remain until the end date.",
    plan: "Current plan",
    expires: "Benefits end",
    state: "Auto-renewal",
    active: "On",
    off: "Off",
    nextCharge: "Next charge",
    amount: "Expected charge",
    cancel: "Turn off auto-renewal",
    retry: "Check again",
    agreement: "Read renewal terms in the User Service Agreement",
    confirmTitle: "Turn off auto-renewal?",
    confirmBody: (date: string) => `Your current benefits remain until ${date}. There will be no charge for the next period.`,
    keep: "Keep it on",
    confirm: "Confirm cancellation",
    closing: "Turning off…",
    failed: "Cancellation failed. Auto-renewal may still be on. Please retry or contact support@somni.chat.",
    cancelledSuccess: "Auto-renewal is off. There will be no charge for the next period.",
  },
  es: {
    title: "Mi membresía · Renovación automática",
    description: "El mandato de pago determina el estado de renovación. Tener saldo no significa haber autorizado cobros recurrentes.",
    loading: "Consultando la autorización de renovación…",
    unavailable: "No podemos consultar la autorización de pago ahora. Inténtalo de nuevo o escribe a support@somni.chat para verificarla o cancelarla.",
    none: "Esta cuenta no tiene una autorización de renovación automática registrada.",
    cancelled: "La renovación automática está desactivada. Los beneficios actuales continúan hasta su vencimiento.",
    plan: "Plan actual",
    expires: "Fin de beneficios",
    state: "Renovación automática",
    active: "Activada",
    off: "Desactivada",
    nextCharge: "Próximo cobro",
    amount: "Importe previsto",
    cancel: "Desactivar renovación automática",
    retry: "Consultar de nuevo",
    agreement: "Ver las condiciones de renovación del Acuerdo de servicio",
    confirmTitle: "¿Desactivar la renovación automática?",
    confirmBody: (date: string) => `Tus beneficios actuales continúan hasta ${date}. No se cobrará el siguiente periodo.`,
    keep: "Mantener activada",
    confirm: "Confirmar cancelación",
    closing: "Desactivando…",
    failed: "La cancelación falló. La renovación puede seguir activa. Inténtalo de nuevo o escribe a support@somni.chat.",
    cancelledSuccess: "Renovación automática desactivada. No se cobrará el siguiente periodo.",
  },
};

type LoadState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; subscription: AutoRenewSubscription };

export default function AutoRenewManagement({ lang }: { lang: Lang }) {
  const { user } = useAuth();
  const t = labels[lang];
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [notice, setNotice] = useState("");

  const refresh = async () => {
    setState({ kind: "loading" });
    setNotice("");
    try {
      const subscription = await getAutoRenewSubscription(accountTokens());
      setState({ kind: "ready", subscription });
    } catch {
      setState({ kind: "error" });
    }
  };

  useEffect(() => {
    if (!user?.id) return;
    let mounted = true;
    setState({ kind: "loading" });
    getAutoRenewSubscription(accountTokens()).then(
      (subscription) => { if (mounted) setState({ kind: "ready", subscription }); },
      () => { if (mounted) setState({ kind: "error" }); },
    );
    return () => { mounted = false; };
  }, [user?.id]);

  const subscription = state.kind === "ready" ? state.subscription : null;

  useEffect(() => {
    if (!confirmOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !closing) setConfirmOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [confirmOpen, closing]);

  const date = (value: string) => new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : lang === "es" ? "es-ES" : "en-US", {
    year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Shanghai",
  }).format(new Date(value));

  const close = async () => {
    if (subscription?.status !== "active" || closing) return;
    setClosing(true);
    setNotice("");
    try {
      const updated = await cancelAutoRenewSubscription(accountTokens());
      if (updated.status !== "cancelled") throw new AutoRenewApiError("invalid");
      setState({ kind: "ready", subscription: updated });
      setConfirmOpen(false);
      setNotice(t.cancelledSuccess);
    } catch {
      setNotice(t.failed);
    } finally {
      setClosing(false);
    }
  };

  return (
    <section className="auto-renew-manage console-card" aria-labelledby="auto-renew-manage-title">
      <div className="auto-renew-manage-heading">
        <div>
          <h2 id="auto-renew-manage-title">{t.title}</h2>
          <p>{t.description}</p>
        </div>
        <a href={`./user-service-agreement.html?lang=${lang}#legal-auto-renewal`}>{t.agreement}</a>
      </div>

      {state.kind === "loading" ? <p role="status">{t.loading}</p> : null}
      {state.kind === "error" ? (
        <div className="auto-renew-manage-empty">
          <p role="alert">{t.unavailable}</p>
          <button type="button" className="btn btn--outline btn--sm" onClick={() => void refresh()}>{t.retry}</button>
        </div>
      ) : null}
      {subscription?.status === "none" ? <p className="auto-renew-manage-empty">{t.none}</p> : null}
      {subscription && subscription.status !== "none" ? (
        <>
          <dl className="auto-renew-manage-grid">
            <div><dt>{t.plan}</dt><dd>{subscription.planName}</dd></div>
            <div><dt>{t.expires}</dt><dd>{date(subscription.currentPeriodEnd)}</dd></div>
            <div><dt>{t.state}</dt><dd>{subscription.status === "active" ? t.active : t.off}</dd></div>
            {subscription.status === "active" ? (
              <>
                <div><dt>{t.nextCharge}</dt><dd>{date(subscription.nextChargeAt)}</dd></div>
                <div><dt>{t.amount}</dt><dd>¥{(subscription.nextChargeFen / 100).toFixed(2)}</dd></div>
              </>
            ) : null}
          </dl>
          {subscription.status === "active" ? (
            <button type="button" className="btn btn--outline" onClick={() => setConfirmOpen(true)}>{t.cancel}</button>
          ) : <p className="auto-renew-manage-empty">{t.cancelled}</p>}
        </>
      ) : null}
      {notice && !confirmOpen ? <p className="auto-renew-notice" role={notice === t.failed ? "alert" : "status"}>{notice}</p> : null}

      {confirmOpen && subscription?.status === "active" ? createPortal(
        <div className="auto-renew-dialog-backdrop" onClick={() => { if (!closing) setConfirmOpen(false); }}>
          <div className="auto-renew-dialog" role="dialog" aria-modal="true" aria-labelledby="auto-renew-confirm-title" onClick={(event) => event.stopPropagation()}>
            <h3 id="auto-renew-confirm-title">{t.confirmTitle}</h3>
            <p>{t.confirmBody(date(subscription.currentPeriodEnd))}</p>
            {notice === t.failed ? <p role="alert">{notice}</p> : null}
            <div className="auto-renew-dialog-actions">
              <button type="button" className="btn btn--outline" autoFocus disabled={closing} onClick={() => setConfirmOpen(false)}>{t.keep}</button>
              <button type="button" className="btn btn--primary" disabled={closing} onClick={() => void close()}>{closing ? t.closing : t.confirm}</button>
            </div>
          </div>
        </div>
      , document.body) : null}
    </section>
  );
}
