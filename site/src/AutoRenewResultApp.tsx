import { useCallback, useEffect, useState } from "react";
import { AuthProvider, accountTokens, useAuth } from "./context/AuthContext";
import { getAutoRenewSubscription, type AutoRenewSubscription } from "./autoRenew";
import { COPY, detectTheme, persistTheme, useAutoLang, type Lang, type Theme } from "./i18n";
import Nav from "./components/Nav";
import Footer from "./components/Footer";
import AuthModal from "./components/AuthModal";
import UserDashboard from "./components/UserDashboard";

const labels = {
  zh: {
    title: "自动续费签约结果",
    checking: "正在核对支付渠道签约记录…",
    signedOut: "请先登录，随后在个人中心查询签约状态。",
    active: "自动续费已开通",
    pending: "签约结果尚未确认",
    pendingBody: "支付渠道返回后可能需要一点时间同步。请重新查询；确认前不会在本站显示已开通。",
    unavailable: "暂时无法核对签约结果，请稍后在个人中心查询或联系 support@somni.chat。",
    plan: "套餐",
    next: "下次扣款",
    amount: "预计扣款",
    retry: "重新查询",
    manage: "前往自动续费管理",
    pricing: "返回套餐页面",
  },
  en: {
    title: "Auto-renewal authorization result",
    checking: "Checking the payment provider's mandate record…",
    signedOut: "Sign in, then check the mandate in your account.",
    active: "Auto-renewal is active",
    pending: "Authorization is not yet confirmed",
    pendingBody: "The payment provider may need time to report the result. Check again; this site will show success only after server confirmation.",
    unavailable: "We cannot confirm the result now. Check again in your account or contact support@somni.chat.",
    plan: "Plan",
    next: "Next charge",
    amount: "Expected charge",
    retry: "Check again",
    manage: "Manage auto-renewal",
    pricing: "Back to pricing",
  },
  es: {
    title: "Resultado de autorización de renovación",
    checking: "Verificando la autorización del proveedor de pagos…",
    signedOut: "Inicia sesión y consulta la autorización en tu cuenta.",
    active: "Renovación automática activada",
    pending: "La autorización aún no está confirmada",
    pendingBody: "El proveedor puede tardar en comunicar el resultado. Consulta de nuevo; el sitio solo mostrará éxito tras la confirmación del servidor.",
    unavailable: "No podemos confirmar el resultado ahora. Consulta tu cuenta o escribe a support@somni.chat.",
    plan: "Plan",
    next: "Próximo cobro",
    amount: "Importe previsto",
    retry: "Consultar de nuevo",
    manage: "Gestionar renovación",
    pricing: "Volver a los planes",
  },
};

type ResultState =
  | { kind: "checking" }
  | { kind: "unavailable" }
  | { kind: "pending" }
  | { kind: "active"; subscription: Extract<AutoRenewSubscription, { status: "active" }> };

function ResultContent() {
  const [lang, setLang] = useAutoLang();
  const [theme, setTheme] = useState<Theme>(detectTheme);
  const { user, isLoading } = useAuth();
  const t = labels[lang];
  const copy = COPY[lang];
  const [state, setState] = useState<ResultState>({ kind: "checking" });

  const refresh = useCallback(async () => {
    if (!user?.id) return;
    setState({ kind: "checking" });
    try {
      const subscription = await getAutoRenewSubscription(accountTokens());
      setState(subscription.status === "active"
        ? { kind: "active", subscription }
        : { kind: "pending" });
    } catch {
      setState({ kind: "unavailable" });
    }
  }, [user?.id]);

  useEffect(() => { if (user?.id) void refresh(); }, [refresh, user?.id]);
  useEffect(() => {
    document.documentElement.lang = copy.htmlLang;
    document.title = `${t.title} — SomniQ Studio`;
  }, [copy.htmlLang, t.title]);
  useEffect(() => {
    persistTheme(theme);
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const date = (value: string) => new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : lang === "es" ? "es-ES" : "en-US", {
    year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Shanghai",
  }).format(new Date(value));

  return (
    <div className={`page legal-page lang-${lang} theme-${theme}`}>
      <Nav copy={copy} theme={theme} currentLang={lang} onSelectLang={setLang} onToggleLang={() => setLang((current: Lang) => current === "zh" ? "en" : current === "en" ? "es" : "zh")} onToggleTheme={() => setTheme((value) => value === "dark" ? "light" : "dark")} />
      <main id="main" className="legal-main">
        <div className="container">
          <article className="legal-card auto-renew-result-card" aria-live="polite">
            <p className="section-kicker">SomniQ Studio · AUTO RENEWAL</p>
            <h1>{t.title}</h1>
            {isLoading ? <p>{t.checking}</p> : !user ? <p>{t.signedOut}</p> : state.kind === "checking" ? <p>{t.checking}</p> : null}
            {user && state.kind === "active" ? (
              <>
                <h2 className="auto-renew-result-success">✓ {t.active}</h2>
                <dl className="legal-facts">
                  <div><dt>{t.plan}</dt><dd>{state.subscription.planName}</dd></div>
                  <div><dt>{t.next}</dt><dd>{date(state.subscription.nextChargeAt)}</dd></div>
                  <div><dt>{t.amount}</dt><dd>¥{(state.subscription.nextChargeFen / 100).toFixed(2)}</dd></div>
                </dl>
              </>
            ) : null}
            {user && state.kind === "pending" ? <><h2>{t.pending}</h2><p>{t.pendingBody}</p></> : null}
            {user && state.kind === "unavailable" ? <p role="alert">{t.unavailable}</p> : null}
            <div className="auto-renew-result-actions">
              {user && state.kind !== "active" ? <button type="button" className="btn btn--outline" onClick={() => void refresh()}>{t.retry}</button> : null}
              <a className="btn btn--primary" href={`./dashboard.html?lang=${lang}&tab=plan`}>{t.manage}</a>
              <a className="btn btn--outline" href={`./pricing.html?lang=${lang}`}>{t.pricing}</a>
            </div>
          </article>
        </div>
      </main>
      <Footer />
      <AuthModal copy={copy} />
      <UserDashboard copy={copy} />
    </div>
  );
}

export default function AutoRenewResultApp() {
  return <AuthProvider><ResultContent /></AuthProvider>;
}
