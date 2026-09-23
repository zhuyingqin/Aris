import { useEffect, useState } from "react";
import type { Lang } from "../i18n";
import { loadEntitlements, loadMembershipCatalog, membershipPrice, type Entitlements, type MembershipPlan } from "../membership";
import "../membership.css";

const words = {
  zh: { title: "为你的研究，选择合适的版本", intro: "从 Go 起步，用 Plus 深入，以 Pro 探索更多。每个版本的模型与默认选择在这里一目了然。",
    monthly: "/ 月", popular: "进阶之选", current: "当前版本", account: "查看我的会员", pending: "模型配置中", models: "可用模型",
    empty: "模型名单将在配置完成后显示", executor: "默认执行", reviewer: "独立审查", note: "会员开通与变更请联系管理员。算力额度与使用记录可在账户中心查看。",
    error: "暂时无法读取套餐，请稍后刷新。", loading: "正在读取套餐…", membership: "我的会员", none: "尚未开通会员",
    expired: "已到期或暂停", expires: "有效期至", refresh: "刷新权益", unavailable: "暂时无法读取会员权益。", settings: "管理员后台" },
  en: { title: "The right plan for your research", intro: "Start with Go, go deeper with Plus, and explore more with Pro. See the models and defaults included in each plan.",
    monthly: "/ month", popular: "Go further", current: "Current plan", account: "View my membership", pending: "Models being configured", models: "Available models",
    empty: "Models will appear once configured", executor: "Default executor", reviewer: "Independent reviewer", note: "Contact your administrator to activate or change a plan. Compute quota and usage are shown in your account.",
    error: "Plans are unavailable. Please refresh later.", loading: "Loading plans…", membership: "My membership", none: "No active membership",
    expired: "Expired or paused", expires: "Valid until", refresh: "Refresh access", unavailable: "Membership is temporarily unavailable.", settings: "Administration" },
  es: { title: "El plan adecuado para tu investigación", intro: "Empieza con Go, profundiza con Plus y explora más con Pro. Consulta los modelos y opciones de cada plan.",
    monthly: "/ mes", popular: "Avanza más", current: "Plan actual", account: "Ver mi membresía", pending: "Modelos en configuración", models: "Modelos disponibles",
    empty: "Los modelos aparecerán una vez configurados", executor: "Ejecutor predeterminado", reviewer: "Revisor independiente", note: "Contacta al administrador para activar o cambiar tu plan. Consulta la cuota y el consumo en tu cuenta.",
    error: "No se pudieron cargar los planes. Actualiza más tarde.", loading: "Cargando planes…", membership: "Mi membresía", none: "Sin membresía activa",
    expired: "Vencido o pausado", expires: "Válido hasta", refresh: "Actualizar permisos", unavailable: "La membresía no está disponible.", settings: "Administración" },
};
export default function MembershipPlans({ lang }: { lang: Lang }) {
  const c = words[lang];
  const [plans, setPlans] = useState<MembershipPlan[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    loadMembershipCatalog().then(value => { if (live) setPlans(value.plans); }).catch(() => { if (live) setFailed(true); });
    loadEntitlements().then(value => { if (live) setCurrent(value.active ? value.plan?.id ?? null : null); }).catch(() => {});
    return () => { live = false; };
  }, []);
  return <section id="pricing" className="membership-section">
    <div className="membership-intro"><span className="membership-eyebrow">SOMNIQ MEMBERSHIP</span><h2>{c.title}</h2><p>{c.intro}</p></div>
    {failed ? <p role="alert">{c.error}</p> : !plans ? <p role="status">{c.loading}</p> : <div className="membership-grid">
      {plans.map(plan => <article key={plan.id} className={"membership-plan membership-plan--" + plan.id} data-testid={"membership-plan-" + plan.id}>
        <div className="membership-plan-head"><h3>{plan.name}</h3>{current === plan.id ? <span className="membership-badge">{c.current}</span> : plan.id === "plus" ? <span className="membership-badge">{c.popular}</span> : null}</div>
        <p className="membership-price"><strong>{membershipPrice(plan, lang)}</strong><span>{c.monthly}</span></p>
        <p className="membership-model-title">{plan.enabled ? c.models : c.pending}</p>
        {plan.models.length ? <ul className="membership-models">{plan.models.map(model => <li key={model}>{model}</li>)}</ul> : <p className="membership-muted">{c.empty}</p>}
        {plan.enabled && <dl className="membership-defaults"><div><dt>{c.executor}</dt><dd>{plan.default_executor}</dd></div><div><dt>{c.reviewer}</dt><dd>{plan.default_reviewer}</dd></div></dl>}
        <a className="membership-link" href={"./account.html?lang=" + lang}>{c.account} <span aria-hidden="true">↗</span></a>
      </article>)}
    </div>}
    <p className="membership-footnote">{c.note}</p>
  </section>;
}
export function MembershipSummary({ lang, isAdmin }: { lang: Lang; isAdmin: boolean }) {
  const c = words[lang];
  const [value, setValue] = useState<Entitlements | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  async function refresh() {
    setLoading(true); setFailed(false);
    try { setValue(await loadEntitlements()); } catch { setValue(null); setFailed(true); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);
  return <section className="identity-card" aria-labelledby="membership-title">
    <div className="identity-card-header"><h2 id="membership-title">{c.membership}</h2>{isAdmin && <a href="./admin.html" className="membership-admin-link">{c.settings} ↗</a>}</div>
    {failed ? <p role="alert">{c.unavailable}</p> : value ? <>
      <h3>{value.plan?.name || c.none}{value.plan && !value.active && <small className="membership-muted"> · {c.expired}</small>}</h3>
      {value.expires_at && <p className="identity-note">{c.expires} {new Date(value.expires_at * 1000).toLocaleString(lang)}</p>}
      {value.models.length > 0 && <ul className="membership-chips">{value.models.map(model => <li key={model}>{model}</li>)}</ul>}
      {value.active && <dl className="identity-details"><div><dt>{c.executor}</dt><dd>{value.default_executor}</dd></div><div><dt>{c.reviewer}</dt><dd>{value.default_reviewer}</dd></div></dl>}
    </> : <p role="status">{c.loading}</p>}
    <button disabled={loading} onClick={() => void refresh()}>{c.refresh}</button>
  </section>;
}
