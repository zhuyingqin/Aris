import { useCallback, useEffect, useState } from "react";
import { detectTheme, persistTheme, useAutoLang, type Theme } from "./i18n";
import { CONSOLE_COPY } from "./consoleI18n";
import ConsoleShell, { type ConsoleTab } from "./components/ConsoleShell";
import AdminPanel from "./AdminApp";
import { loadEntitlements, type Entitlements } from "./membership";
import {
  acceptAccountAgreement, beginComputeConnection, independentAccountsEnabled,
  IndependentAccountError,
  loadAccountAgreement, loadComputeUsage, loadIndependentAccount, logoutIndependentAccount,
  type AccountAgreement, type ComputeUsage, type IndependentAccount,
} from "./independentAccount";
import "./membership.css";
import MembershipPlans, { MembershipSummary } from "./components/MembershipPlans";

const words = {
  zh: {
    home: "返回首页", title: "你的 SomniQ 账户", intro: "管理个人身份、服务协议和研究算力。", preview: "账号预览",
    login: "登录 / 创建账号", loginHint: "在 SomniQ 身份页面完成登录、注册或找回密码。", loading: "正在加载账户…",
    profile: "个人资料", signedIn: "已登录", logout: "退出当前会话", identity: "账户 ID", email: "邮箱",
    agreement: "服务协议", accept: "我已阅读并同意以上协议", continue: "同意并继续",
    compute: "研究算力", connected: "已连接", pending: "尚未开通", connect: "连接算力服务", reconnect: "重新连接",
    pendingHint: "你的账号已经建立。完成连接后即可查看算力和用量。", quota: "剩余额度", used: "累计用量", requests: "调用次数",
    unit: "额度单位", unitHint: "额度按照模型价格与用量结算，不等于原始词元数量。", refresh: "刷新", retry: "重试",
    failed: "账户服务暂不可用，请重试。", computeFailed: "算力服务暂不可用，你的账号仍可使用。可重试或重新连接。",
    operationFailed: "操作未完成，请重试。已有算力账户需先完成账户绑定。", oldAccount: "已有算力账号？请先完成旧账户绑定，保留原有余额与使用记录。当前预览仅支持新测试账号。",
    scope: "这是独立账号的预览入口。桌面登录、远程设备和订单仍使用原有入口。",
  },
  en: {
    home: "Back to home", title: "Your SomniQ account", intro: "Manage your identity, service agreement and research compute.", preview: "Account preview",
    login: "Sign in / Create account", loginHint: "Sign in, register or recover your password on the SomniQ identity page.", loading: "Loading your account…",
    profile: "Profile", signedIn: "Signed in", logout: "Sign out this session", identity: "Account ID", email: "Email",
    agreement: "Service agreement", accept: "I have read and agree to the agreement above", continue: "Agree and continue",
    compute: "Research compute", connected: "Connected", pending: "Not connected", connect: "Connect compute", reconnect: "Reconnect",
    pendingHint: "Your account is ready. Connect compute to view your quota and usage.", quota: "Remaining quota", used: "Total usage", requests: "Requests",
    unit: "quota units", unitHint: "Quota reflects model pricing and usage; it is not a raw token count.", refresh: "Refresh", retry: "Retry",
    failed: "Account service unavailable. Please retry.", computeFailed: "Compute is temporarily unavailable. Your account remains available. Retry or reconnect.",
    operationFailed: "The operation did not finish. Please retry. Existing compute accounts must be linked first.", oldAccount: "Already have a compute account? Link it first to preserve your balance and history. This preview supports new test accounts only.",
    scope: "Independent account preview. Desktop login, remote devices and orders still use their existing entry points.",
  },
  es: {
    home: "Volver al inicio", title: "Tu cuenta de SomniQ", intro: "Gestiona tu identidad, el acuerdo de servicio y el cómputo para investigación.", preview: "Vista previa",
    login: "Iniciar sesión / Crear cuenta", loginHint: "Inicia sesión, regístrate o recupera tu contraseña en la página de identidad de SomniQ.", loading: "Cargando tu cuenta…",
    profile: "Perfil", signedIn: "Sesión iniciada", logout: "Cerrar esta sesión", identity: "ID de cuenta", email: "Correo",
    agreement: "Acuerdo de servicio", accept: "He leído y acepto el acuerdo anterior", continue: "Aceptar y continuar",
    compute: "Cómputo de investigación", connected: "Conectado", pending: "Sin conectar", connect: "Conectar cómputo", reconnect: "Reconectar",
    pendingHint: "Tu cuenta está lista. Conecta el cómputo para ver tu cuota y consumo.", quota: "Cuota restante", used: "Consumo total", requests: "Solicitudes",
    unit: "unidades de cuota", unitHint: "La cuota depende del precio y uso del modelo; no es un recuento de tokens.", refresh: "Actualizar", retry: "Reintentar",
    failed: "El servicio de cuentas no está disponible. Inténtalo de nuevo.", computeFailed: "El cómputo no está disponible. Tu cuenta sigue disponible. Reintenta o reconecta.",
    operationFailed: "La operación no se completó. Reintenta. Las cuentas de cómputo existentes deben vincularse primero.", oldAccount: "¿Ya tienes una cuenta de cómputo? Vincúlala primero para conservar tu saldo e historial. Esta vista previa solo admite nuevas cuentas de prueba.",
    scope: "Vista previa de cuentas independientes. El escritorio, los dispositivos remotos y los pedidos siguen usando sus accesos actuales.",
  },
};

export default function IndependentAccountApp({ initialTab }: { initialTab?: ConsoleTab }) {
  const [lang, setLang] = useAutoLang();
  const c = words[lang];
  const consoleCopy = CONSOLE_COPY[lang];
  const [theme, setTheme] = useState<Theme>(detectTheme);
  const [tab, setTab] = useState<ConsoleTab>(() => initialTab || (new URLSearchParams(window.location.search).get("tab") === "plan" ? "plan" : "activity"));
  const [account, setAccount] = useState<IndependentAccount | null>(null);
  const [agreement, setAgreement] = useState<AccountAgreement | null>(null);
  const [usage, setUsage] = useState<ComputeUsage | null>(null);
  const [entitlements, setEntitlements] = useState<Entitlements | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [computeFailed, setComputeFailed] = useState(false);
  const [operationFailed, setOperationFailed] = useState(false);

  const refreshUsage = useCallback(async () => {
    setComputeFailed(false);
    try { setUsage(await loadComputeUsage()); }
    catch (error) {
      setUsage(null);
      if (error instanceof IndependentAccountError && error.status === 401) setAccount(null);
      else setComputeFailed(true);
    }
  }, []);
  const refreshAccount = useCallback(async () => {
    setLoading(true); setFailed(false);
    try {
      const next = await loadIndependentAccount();
      setAccount(next); setUsage(null); setAgreement(null); setAccepted(false); setEntitlements(null);
      if (next) void loadEntitlements().then(setEntitlements).catch(() => {});
      if (next?.agreement_required) setAgreement(await loadAccountAgreement());
      if (next?.compute_connected && !next.agreement_required) void refreshUsage();
    } catch { setFailed(true); }
    finally { setLoading(false); }
  }, [refreshUsage]);
  useEffect(() => { if (independentAccountsEnabled) void refreshAccount(); }, [refreshAccount]);
  useEffect(() => { document.documentElement.lang = lang === "zh" ? "zh-CN" : lang; document.title = consoleCopy.docTitle; }, [lang, consoleCopy.docTitle]);
  useEffect(() => { persistTheme(theme); document.documentElement.setAttribute("data-theme", theme); }, [theme]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const follow = (event: MediaQueryListEvent) => { if (!localStorage.getItem("somniq-site-theme")) setTheme(event.matches ? "light" : "dark"); };
    media.addEventListener("change", follow); return () => media.removeEventListener("change", follow);
  }, []);
  async function action(work: () => Promise<void>) {
    setBusy(true); setOperationFailed(false);
    try { await work(); }
    catch (error) {
      if (error instanceof IndependentAccountError && error.status === 401) { setAccount(null); setUsage(null); setEntitlements(null); }
      else setOperationFailed(true);
    } finally { setBusy(false); }
  }
  if (!independentAccountsEnabled) { window.location.replace("./dashboard.html"); return null; }

  const remaining = usage?.quota || 0;
  const total = remaining + (usage?.used_quota || 0);
  const showMetrics = usage && <div className="console-grid-metrics" data-testid="compute-metrics">
    {[[c.quota, usage.quota], [c.used, usage.used_quota]].map(([label, value]) => <section className={"console-card " + (label === c.quota ? "console-card--balance" : "console-card--usage")} key={label}>
      <div className="console-card-header"><span className="console-kicker">{label}</span></div>
      <div className="console-metric-val"><span className="console-number-huge">{Number(value).toLocaleString(lang)}</span><span className="console-number-usd">{c.unit}</span></div>
      {label === c.quota ? <div className="console-progress-track"><div className="console-progress-fill" style={{width: (total > 0 ? remaining / total * 100 : 0) + "%"}} /></div> : <p className="console-card-desc">{consoleCopy.activity.cumulativeUsageDesc(usage.request_count.toLocaleString(lang))}</p>}
    </section>)}
  </div>;
  const compute = <section className="console-card">
    <div className="console-card-header"><h2>{c.compute}</h2><span className="console-tag">{account?.compute_connected ? c.connected : c.pending}</span></div>
    {computeFailed && <p role="status" className="console-membership-note">{c.computeFailed}</p>}
    <p className="console-membership-note">{account?.compute_connected ? c.unitHint : c.pendingHint}</p>
    <div className="console-membership-actions">
      {account?.compute_connected && <button className="btn btn--outline" disabled={busy} onClick={() => void action(refreshUsage)}>{c.refresh}</button>}
      <button className="btn btn--primary" disabled={busy} onClick={() => void action(async () => { window.location.assign(await beginComputeConnection()); })}>{account?.compute_connected ? c.reconnect : c.connect} →</button>
    </div>
  </section>;
  return <ConsoleShell lang={lang} theme={theme} onSelectLang={setLang} onToggleTheme={() => setTheme(current => current === "dark" ? "light" : "dark")}
    user={account ? {id: account.user.id, username: account.user.display_name} : null} activeTab={tab} onSelectTab={setTab}
    onLogout={() => void action(async () => { await logoutIndependentAccount(); setAccount(null); setUsage(null); setAgreement(null); setEntitlements(null); })}
    onRefresh={() => void action(refreshAccount)} refreshing={busy || loading} quotaLabel={usage ? remaining.toLocaleString(lang) : "—"}
    balanceLabel={c.unit} remainingPercent={total > 0 ? remaining / total * 100 : 0}
    tierName={entitlements?.active ? entitlements.plan?.name : undefined} isAdmin={!!account?.is_admin} showInstallBanner={false}>
    <div className="console-canvas-inner console-membership-content">
      {operationFailed && <p role="alert" className="console-membership-error">{c.operationFailed}</p>}
      {loading ? <p role="status">{c.loading}</p> : failed ? <section className="console-card" role="alert"><p>{c.failed}</p><button className="btn btn--outline" onClick={() => void refreshAccount()}>{c.retry}</button></section> : !account ?
        <section className="console-card"><div className="console-hero"><h1 className="console-greeting">{c.login}</h1><p className="console-subtitle">{c.loginHint}</p></div><a className="btn btn--primary" href="/v2/account/login">{c.login} →</a></section> : <>
          {tab !== "admin" && <div className="console-hero"><h1 className="console-greeting">{tab === "plan" ? consoleCopy.nav.planFull : tab === "usage" ? consoleCopy.usage.heroTitle : tab === "remote" ? consoleCopy.nav.remoteFull : consoleCopy.nav.activityFull}</h1><p className="console-subtitle" data-testid="account-name">{account.user.display_name} · {account.user.email}</p><div className="console-tags"><span className="console-tag">{entitlements?.active ? entitlements.plan?.name : c.signedIn}</span><span className="console-tag">{consoleCopy.activity.tagReviewer}</span></div></div>}
          {account.agreement_required && agreement && <section className="console-card"><h2>{c.agreement}</h2><p className="console-membership-note">{agreement.version}</p><pre className="console-agreement">{agreement.text}</pre>
            <label className="console-agreement-check"><input data-testid="agreement-checkbox" type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} />{c.accept}</label>
            <button data-testid="accept-agreement" className="btn btn--primary" disabled={busy || !accepted} onClick={() => void action(async () => { await acceptAccountAgreement(agreement); await refreshAccount(); })}>{c.continue}</button>
          </section>}
          {tab === "admin" ? <AdminPanel account={account} /> : tab === "remote" ? <section className="console-card console-remote-handoff-card"><span className="console-kicker">{consoleCopy.remote.kicker}</span><h2>{consoleCopy.remote.mobileTitle}</h2><p className="console-membership-note">{lang === "zh" ? "已有设备请继续使用原账号登录远程工作台。新账号的设备关联尚未开放。" : lang === "es" ? "Usa tu cuenta existente para abrir tus dispositivos. La vinculación de dispositivos para cuentas nuevas aún no está disponible." : "Use your existing account to open paired devices. Device linking for new accounts is not yet available."}</p><a className="btn btn--primary" href="./remote/" target="_blank" rel="noreferrer">{consoleCopy.remote.openInNewTabBtn}</a></section> : tab === "plan" ? <>
            <MembershipSummary key={account.user.id} lang={lang} isAdmin={!!account.is_admin} />
            <MembershipPlans lang={lang} />
          </> : <>
            {!account.agreement_required && <>{showMetrics}{compute}</>}
            {tab === "activity" && <><MembershipSummary key={account.user.id} lang={lang} isAdmin={!!account.is_admin} /><section className="console-card"><div className="console-card-header"><h2>{c.profile}</h2></div><dl className="console-member-details"><div><dt>{c.email}</dt><dd>{account.user.email}</dd></div><div><dt>{c.identity}</dt><dd>{account.user.id}</dd></div></dl></section></>}
          </>}
        </>}
    </div>
  </ConsoleShell>;
}
