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

function useCatalog() {
  const [plans, setPlans] = useState<MembershipPlan[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    loadMembershipCatalog().then(value => { if (live) setPlans(value.plans); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);
  return { plans, failed };
}
function Models({ plan, lang }: { plan: MembershipPlan; lang: Lang }) {
  const c = words[lang];
  return <><p className="plan-tier-desc">{plan.enabled ? c.models : c.pending}</p>
    {plan.models.length ? <ul className="plan-tier-features">{plan.models.map(model => <li key={model}><span aria-hidden="true">✓</span>{model}</li>)}</ul> : <p className="console-membership-note">{c.empty}</p>}
    {plan.enabled && <dl className="console-member-details membership-defaults"><div><dt>{c.executor}</dt><dd>{plan.default_executor}</dd></div><div><dt>{c.reviewer}</dt><dd>{plan.default_reviewer}</dd></div></dl>}
  </>;
}
export default function MembershipPlans({ lang }: { lang: Lang }) {
  const c = words[lang];
  const { plans, failed } = useCatalog();
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    loadEntitlements().then(value => { if (live) setCurrent(value.active ? value.plan?.id ?? null : null); }).catch(() => {});
    return () => { live = false; };
  }, []);
  return <section className="membership-plans" aria-label={c.membership}>
    {failed ? <p role="alert">{c.error}</p> : !plans ? <p role="status">{c.loading}</p> : <div className="plan-pricing-grid membership-tier-grid">
      {plans.map(plan => <article key={plan.id} className={"plan-tier-card" + (plan.id === "plus" ? " plan-tier-card--pro" : "")} data-testid={"membership-plan-" + plan.id}>
        <div><h3 className="plan-tier-name">{plan.name}</h3>
          <p className="plan-tier-desc">{current === plan.id ? c.current : c.monthly}</p>
          <div className="plan-tier-price"><strong>{membershipPrice(plan, lang)}</strong><span>{c.monthly}</span></div>
          <Models plan={plan} lang={lang} />
        </div>
        <a className={"btn " + (plan.id === "plus" ? "btn--primary" : "btn--outline")} href={"./dashboard.html?tab=plan&lang=" + lang}>{c.account} ↗</a>
      </article>)}
    </div>}
    <p className="pricing-table-footnote">{c.note}</p>
  </section>;
}

// The original pricing hero keeps its single offer card; tabs select the tier.
export function MembershipOffer({ lang }: { lang: Lang }) {
  const { plans, failed } = useCatalog();
  const [selected, setSelected] = useState("go");
  const c = words[lang]; const plan = plans?.find(value => value.id === selected);
  return <article className="pricing-plan">
    {failed ? <p role="alert">{c.error}</p> : !plan ? <p role="status">{c.loading}</p> : <>
      <div className="membership-plan-switch" role="group" aria-label={c.membership}>{plans!.map(value => <button key={value.id} className={"btn " + (value.id === selected ? "btn--primary" : "btn--outline")} aria-pressed={value.id === selected} data-testid={"membership-plan-" + value.id} onClick={() => setSelected(value.id)}>{value.name}<small>{membershipPrice(value, lang)}{c.monthly}</small></button>)}</div>
      <div className="pricing-plan-head"><p className="pricing-plan-name">SomniQ {plan.name}</p><span className="pricing-plan-badge">{plan.enabled ? c.models : c.pending}</span></div>
      <div className="pricing-price"><strong>{membershipPrice(plan, lang)}</strong><span>{c.monthly}</span></div>
      <div className="pricing-includes"><Models plan={plan} lang={lang} /></div>
      <div className="pricing-actions"><a className="btn btn--primary btn--lg" href={"./dashboard.html?tab=plan&lang=" + lang}>{c.account} ↗</a></div>
      <p className="pricing-table-footnote">{c.note}</p>
    </>}
  </article>;
}
export function MembershipModelTable({ lang }: { lang: Lang }) {
  const { plans, failed } = useCatalog(); const c = words[lang];
  const models = [...new Set(plans?.flatMap(plan => plan.models) || [])].sort();
  return <section className="pricing-details-section"><div className="container"><div className="pricing-table-section">
    <div className="pricing-models-head"><div className="pricing-models-title-wrap"><span className="pricing-models-badge">{c.models}</span><p className="pricing-models-subtitle">{c.intro}</p></div></div>
    {failed ? <p role="alert">{c.error}</p> : !plans ? <p role="status">{c.loading}</p> : <div className="pricing-table-container"><table className="pricing-comparison-table"><thead><tr><th scope="col">{c.models}</th>{plans.map(plan => <th scope="col" key={plan.id}>{plan.name} · {membershipPrice(plan, lang)}{c.monthly}</th>)}</tr></thead><tbody>
      {models.length ? models.map(model => <tr key={model}><th scope="row">{model}</th>{plans.map(plan => <td key={plan.id}>{plan.models.includes(model) ? "✓" : "—"}</td>)}</tr>) : <tr><td colSpan={4}>{c.empty}</td></tr>}
    </tbody></table></div>}
  </div></div></section>;
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
  return <section className="console-card plan-section-card" aria-label={c.membership}>
    <div className="plan-active-head"><div className="plan-active-title-group"><div className="plan-active-name"><span>{value?.plan?.name || c.none}</span>{value?.active && <span className="plan-active-status-tag">{c.current}</span>}</div></div><button className="console-refresh-btn" disabled={loading} onClick={() => void refresh()}>{c.refresh}</button></div>
    {failed ? <p role="alert">{c.unavailable}</p> : value ? <>
      {value.plan && !value.active && <p className="console-membership-note">{c.expired}</p>}
      <div className="plan-details-grid"><div className="plan-detail-box"><div className="plan-detail-label">{c.expires}</div><div className="plan-detail-sub">{value.expires_at ? new Date(value.expires_at * 1000).toLocaleString(lang) : "—"}</div></div>
        <div className="plan-detail-box"><div className="plan-detail-label">{c.executor}</div><div className="plan-detail-sub">{value.default_executor || "—"}</div></div>
        <div className="plan-detail-box"><div className="plan-detail-label">{c.reviewer}</div><div className="plan-detail-sub">{value.default_reviewer || "—"}</div></div></div>
      {value.models.length > 0 && <ul className="membership-chips">{value.models.map(model => <li className="console-tag" key={model}>{model}</li>)}</ul>}
    </> : <p role="status">{c.loading}</p>}
    {isAdmin && <a className="console-link-home" href="./admin.html">{c.settings} ↗</a>}
  </section>;
}
