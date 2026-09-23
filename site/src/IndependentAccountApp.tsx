import { useCallback, useEffect, useState } from "react";
import { useAutoLang } from "./i18n";
import {
  acceptAccountAgreement, beginComputeConnection, independentAccountsEnabled,
  IndependentAccountError,
  loadAccountAgreement, loadComputeUsage, loadIndependentAccount, logoutIndependentAccount,
  type AccountAgreement, type ComputeUsage, type IndependentAccount,
} from "./independentAccount";
import "./independentAccount.css";
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

export default function IndependentAccountApp() {
  const [lang, setLang] = useAutoLang();
  const c = words[lang];
  const [account, setAccount] = useState<IndependentAccount | null>(null);
  const [agreement, setAgreement] = useState<AccountAgreement | null>(null);
  const [usage, setUsage] = useState<ComputeUsage | null>(null);
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
      setAccount(next); setUsage(null); setAgreement(null); setAccepted(false);
      // Account loading does not wait for a potentially unavailable compute service.
      if (next?.agreement_required) setAgreement(await loadAccountAgreement());
      if (next?.compute_connected && !next.agreement_required) void refreshUsage();
    } catch { setFailed(true); }
    finally { setLoading(false); }
  }, [refreshUsage]);
  useEffect(() => { if (independentAccountsEnabled) void refreshAccount(); }, [refreshAccount]);
  useEffect(() => { document.documentElement.lang = lang === "zh" ? "zh-CN" : lang; document.title = `${c.title} · SomniQ`; }, [lang, c.title]);

  async function action(work: () => Promise<void>) {
    setBusy(true); setOperationFailed(false);
    try { await work(); }
    catch (error) {
      if (error instanceof IndependentAccountError && error.status === 401) { setAccount(null); setUsage(null); }
      else setOperationFailed(true);
    } finally { setBusy(false); }
  }
  if (!independentAccountsEnabled) { window.location.replace("./dashboard.html"); return null; }

  return <div className="identity-page">
    <header className="identity-nav"><a href={`./?lang=${lang}`} className="identity-brand"><img src="./app-logo.png" alt="" width="32" height="32" />SomniQ Studio</a>
      <div><select aria-label="Language" value={lang} onChange={e => setLang(e.target.value as typeof lang)}><option value="zh">中文</option><option value="en">English</option><option value="es">Español</option></select><a href={`./?lang=${lang}`}>{c.home}</a></div>
    </header>
    <main className="identity-main">
      <div className="identity-heading"><span className="identity-kicker">{c.preview}</span><h1>{c.title}</h1><p>{c.intro}</p></div>
      {loading ? <p role="status">{c.loading}</p> : failed ? <section className="identity-card" role="alert"><p>{c.failed}</p><button onClick={() => void refreshAccount()}>{c.retry}</button></section> : !account ?
        <section className="identity-card identity-welcome"><h2>{c.login}</h2><p>{c.loginHint}</p><a className="identity-primary" href="/v2/account/login">{c.login} →</a><p className="identity-note">{c.oldAccount}</p></section> : <>
          <section className="identity-card" aria-labelledby="identity-profile-title"><div className="identity-card-header"><h2 id="identity-profile-title">{c.profile}</h2><span className="identity-status">{c.signedIn}</span></div>
            <h3 data-testid="account-name">{account.user.display_name}</h3><dl className="identity-details"><div><dt>{c.email}</dt><dd>{account.user.email}</dd></div><div><dt>{c.identity}</dt><dd className="identity-id">{account.user.id}</dd></div></dl>
            <button disabled={busy} onClick={() => void action(async () => { await logoutIndependentAccount(); setAccount(null); setUsage(null); setAgreement(null); })}>{c.logout}</button>
          </section>
          {account.agreement_required && agreement ? <section className="identity-card" aria-labelledby="identity-agreement-title"><h2 id="identity-agreement-title">{c.agreement}</h2><p className="identity-note">{agreement.version}</p><pre className="identity-agreement">{agreement.text}</pre>
            <label className="identity-checkbox"><input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} />{c.accept}</label>
            <button className="identity-primary" disabled={busy || !accepted} onClick={() => void action(async () => { await acceptAccountAgreement(agreement); await refreshAccount(); })}>{c.continue}</button>
          </section> : null}
          {!account.agreement_required && <section className="identity-card" aria-labelledby="identity-compute-title"><div className="identity-card-header"><h2 id="identity-compute-title">{c.compute}</h2><span className={account.compute_connected ? "identity-status" : "identity-status identity-pending"}>{account.compute_connected ? c.connected : c.pending}</span></div>
            {computeFailed && <p role="status" className="identity-note">{c.computeFailed}</p>}
            {usage && <><dl className="identity-metrics"><div><dt>{c.quota}</dt><dd>{usage.quota.toLocaleString(lang)}<small>{c.unit}</small></dd></div><div><dt>{c.used}</dt><dd>{usage.used_quota.toLocaleString(lang)}<small>{c.unit}</small></dd></div><div><dt>{c.requests}</dt><dd>{usage.request_count.toLocaleString(lang)}</dd></div></dl><p className="identity-note">{c.unitHint}</p></>}
            {!account.compute_connected && <><p>{c.pendingHint}</p><p className="identity-note">{c.oldAccount}</p></>}
            <div className="identity-actions">{account.compute_connected && <button disabled={busy} onClick={() => void action(refreshUsage)}>{c.refresh}</button>}<button className={account.compute_connected ? "" : "identity-primary"} disabled={busy} onClick={() => void action(async () => { window.location.assign(await beginComputeConnection()); })}>{account.compute_connected ? c.reconnect : c.connect} →</button></div>
          </section>}
        </>}
      {account && <MembershipSummary key={account.user.id} lang={lang} isAdmin={!!account.is_admin} />}
      <MembershipPlans key={account?.user.id || "anonymous"} lang={lang} />
      {operationFailed && <p role="alert" className="identity-error">{c.operationFailed}</p>}
      <p className="identity-footer">{c.scope}</p>
    </main>
  </div>;
}
