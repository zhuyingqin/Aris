import { useEffect, useState } from "react";
import type { IndependentAccount } from "./independentAccount";
import {
  assignMembership, discoverMembershipModels, loadAdminPlans, loadMemberUsers, loadMembershipAudit,
  membershipError, membershipPrice, modelLines, nextMembershipMonth, retryMembershipSync, saveMembershipPlan,
  type AuditEvent, type MemberUser, type MembershipPlan, type PlanId, type PlanUpdate,
} from "./membership";
import "./membership.css";
import "./admin.css";

function PlanEditor({ plan, knownModels, busy, onSave, onDiscover }: {
  plan: MembershipPlan; knownModels: string[]; busy: boolean;
  onSave: (update: PlanUpdate) => Promise<void>; onDiscover: () => void;
}) {
  const [text, setText] = useState(plan.models.join("\n"));
  const [executor, setExecutor] = useState(plan.default_executor || "");
  const [reviewer, setReviewer] = useState(plan.default_reviewer || "");
  const [enabled, setEnabled] = useState(plan.enabled);
  const models = modelLines(text);
  function replaceModels(next: string[]) {
    setText(next.join("\n"));
    if (!next.includes(executor)) setExecutor(next[0] || "");
    if (!next.includes(reviewer)) setReviewer(next[0] || "");
  }
  return <form className="console-card admin-panel" onSubmit={event => { event.preventDefault(); void onSave({
    models, default_executor: executor || null, default_reviewer: reviewer || null, enabled, expected_revision: plan.revision,
  }); }}>
    <div className="admin-panel-heading"><div><span className="admin-overline">PLAN CONFIGURATION</span><h2>{plan.name} 的模型权限</h2></div><span className="admin-revision">版本 {plan.revision}</span></div>
    <p className="admin-description">选择本版本可以调用的模型，并设置执行与独立审查的默认选择。保存后对已开通的用户生效。</p>
    <div className="admin-model-toolbar"><strong>可用模型 <span>{models.length}</span></strong><button type="button" disabled={busy} onClick={onDiscover}>从 New API 读取模型</button></div>
    {knownModels.length > 0 && <div className="admin-model-picker">{knownModels.map(model => <label key={model}>
      <input type="checkbox" disabled={busy} checked={models.includes(model)} onChange={event => replaceModels(event.target.checked ? [...models, model].sort() : models.filter(m => m !== model))} /><span>{model}</span>
    </label>)}</div>}
    <label className="admin-field">模型 ID，每行一个
      <textarea data-testid="plan-models" rows={6} value={text} disabled={busy} onChange={event => {
        const next = modelLines(event.target.value); setText(event.target.value);
        if (!next.includes(executor)) setExecutor(next[0] || "");
        if (!next.includes(reviewer)) setReviewer(next[0] || "");
      }} spellCheck={false} placeholder="从上方读取模型，或填写已在 New API 配置的精确模型 ID" />
    </label>
    <p className="admin-field-hint">模型列表来自当前已连接的算力账号。若需手动添加，请先确认 New API 的渠道与用户分组能提供该模型。</p>
    <div className="admin-form-grid">
      <label className="admin-field">默认执行模型<select data-testid="plan-executor" value={executor} onChange={e => setExecutor(e.target.value)} disabled={busy} required={enabled}><option value="">请选择模型</option>{models.map(model => <option key={model}>{model}</option>)}</select></label>
      <label className="admin-field">默认审查模型<select data-testid="plan-reviewer" value={reviewer} onChange={e => setReviewer(e.target.value)} disabled={busy} required={enabled}><option value="">请选择模型</option>{models.map(model => <option key={model}>{model}</option>)}</select></label>
    </div>
    <div className="admin-save-row"><label className="admin-switch"><input data-testid="plan-enabled" type="checkbox" checked={enabled} disabled={busy} onChange={e => setEnabled(e.target.checked)} /><span>启用此版本的模型权限</span></label>
      <button className="btn btn--primary" type="submit" disabled={busy} data-testid="save-plan">{busy ? "正在保存…" : "保存并生效"}</button></div>
  </form>;
}

function localDate(value: number) {
  const date = new Date(value * 1000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
function MemberEditor({ user, plans, busy, onSave }: { user: MemberUser; plans: MembershipPlan[]; busy: boolean;
  onSave: (plan: PlanId | null, expires: number | null, reason: string) => Promise<void> }) {
  const [plan, setPlan] = useState<PlanId | "">(user.entitlements.plan?.id || "");
  const [expires, setExpires] = useState(user.entitlements.expires_at && user.entitlements.expires_at > Date.now() / 1000 ? localDate(user.entitlements.expires_at) : localDate(nextMembershipMonth().getTime() / 1000));
  const [reason, setReason] = useState("");
  return <form className="console-card admin-panel" onSubmit={e => { e.preventDefault(); void onSave(plan || null, plan ? Math.floor(new Date(expires).getTime() / 1000) : null, reason); }}>
    <span className="admin-overline">MEMBERSHIP</span><h2>{user.display_name || user.email}</h2><p className="admin-description">{user.email}</p>
    <label className="admin-field">会员版本<select data-testid="member-plan" value={plan} disabled={busy} onChange={e => setPlan(e.target.value as PlanId | "")}><option value="">未开通 / 撤销会员</option>{plans.map(p => <option key={p.id} value={p.id} disabled={!p.enabled}>{p.name} · {membershipPrice(p)}/月{p.enabled ? "" : " · 未启用"}</option>)}</select></label>
    <label className="admin-field">有效期至（本地时间）<input data-testid="member-expiry" type="datetime-local" value={expires} disabled={busy || !plan} required={!!plan} onChange={e => setExpires(e.target.value)} /></label>
    <label className="admin-field">变更原因<textarea data-testid="member-reason" value={reason} rows={3} required maxLength={500} disabled={busy} placeholder="例如：已核实订单、试用开通、到期撤销" onChange={e => setReason(e.target.value)} /></label>
    <p className="admin-field-hint">此操作只变更会员和模型权限，不增加算力余额，也不代替支付记录。</p>
    <button type="submit" className="btn btn--primary" data-testid="save-membership" disabled={busy || !user.active}>{busy ? "正在保存…" : "保存会员"}</button>
  </form>;
}

export default function AdminPanel({ account }: { account: IndependentAccount }) {
  const [loading, setLoading] = useState(true);
  const [plans, setPlans] = useState<MembershipPlan[]>([]);
  const [users, setUsers] = useState<MemberUser[]>([]);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [selectedPlan, setSelectedPlan] = useState<PlanId>("go");
  const [selectedUser, setSelectedUser] = useState<MemberUser | null>(null);
  const [tab, setTab] = useState<"plans" | "users" | "audit">("plans");
  const [knownModels, setKnownModels] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function reload() {
    const [p, u, a] = await Promise.all([loadAdminPlans(), loadMemberUsers(query, offset), loadMembershipAudit()]);
    setPlans(p); setUsers(u.users); setEvents(a.events);
    setSelectedUser(current => current ? u.users.find(user => user.id === current.id) || null : null);
  }
  useEffect(() => {
    let live = true;
    if (!account.is_admin) { setLoading(false); return; }
    reload().catch(e => { if (live) setError(membershipError(e)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [account.user.id, account.is_admin]);
  async function run(work: () => Promise<void>, success = "") {
    setBusy(true); setError(""); setNotice("");
    try { await work(); setNotice(success); } catch (e) { setError(membershipError(e)); }
    finally { setBusy(false); }
  }
  async function search(nextOffset: number) {
    const value = await loadMemberUsers(query, nextOffset);
    setUsers(value.users); setOffset(nextOffset); setSelectedUser(null);
  }
  const plan = plans.find(p => p.id === selectedPlan);
  return <section className="admin-content">

      <div className="admin-title-row"><div><span className="admin-overline">SOMNIQ CONTROL CENTER</span><h1 className="console-greeting">会员与模型管理</h1><p>管理 Go、Plus、Pro 的模型权限与用户会员。</p></div>{account?.is_admin && <button disabled={busy} onClick={() => void run(reload)}>刷新数据</button>}</div>
      {error && <p role="alert" className="console-membership-error">{error}</p>}{notice && <p role="status" className="admin-notice">{notice}</p>}
      {loading ? <p role="status">正在验证管理员身份…</p> : !account.is_admin ? <section className="console-card admin-panel"><h2>此账号没有管理员权限</h2><p>管理员由服务器授权。修改本地设置不会改变账号权限。</p><a href="./account.html">返回账户中心 →</a></section> : <>
        {account.agreement_required && <p className="admin-notice">保存配置前，请先在<a href="./account.html">账户中心</a>接受服务协议。</p>}
        <nav className="admin-tabs" aria-label="管理功能">{(["plans", "users", "audit"] as const).map((key, i) => <button key={key} data-testid={"tab-" + key} aria-current={tab === key ? "page" : undefined} disabled={busy} onClick={() => { setTab(key); setError(""); setNotice(""); }}>{["套餐模型", "用户会员", "操作记录"][i]}</button>)}</nav>
        {tab === "plans" && <>
          <div className="admin-plan-cards">{plans.map(p => <button className={selectedPlan === p.id ? "is-selected" : ""} data-testid={"edit-" + p.id} key={p.id} disabled={busy} onClick={() => setSelectedPlan(p.id)}><span className="admin-plan-name">{p.name}<small>{p.enabled ? "已启用" : "待配置"}</small></span><strong>{membershipPrice(p)}<small>/ 月</small></strong><span>{p.models.length} 个模型 <span aria-hidden="true">↗</span></span></button>)}</div>
          {plan && <PlanEditor key={plan.id + ":" + plan.revision} plan={plan} knownModels={knownModels} busy={busy}
            onDiscover={() => void run(async () => { setKnownModels((await discoverMembershipModels()).models); }, "已读取当前算力账号可配置的模型。")}
            onSave={update => run(async () => { const saved = await saveMembershipPlan(plan.id, update); setPlans(current => current.map(p => p.id === saved.id ? saved : p)); setEvents((await loadMembershipAudit()).events); }, "版本配置已生效。New API 模型权限正在同步；新的调用会按当前配置校验。")} />}
        </>}
        {tab === "users" && <div className="admin-users-layout"><section className="console-card admin-panel"><form className="admin-search" onSubmit={e => { e.preventDefault(); void run(() => search(0)); }}><input aria-label="搜索用户" placeholder="邮箱、姓名或账户 ID" value={query} onChange={e => setQuery(e.target.value)} maxLength={200} /><button disabled={busy}>搜索</button></form>
          <div className="admin-user-list">{users.length === 0 ? <p>没有找到用户。</p> : users.map(u => <div className="admin-user-row" key={u.id}><button data-testid={"select-user-" + u.id} disabled={busy} className={selectedUser?.id === u.id ? "is-selected" : ""} onClick={() => setSelectedUser(u)}><strong>{u.display_name || u.email}</strong><span>{u.email}</span><small>{u.entitlements.plan?.name || "未开通"} · {u.entitlements.active ? "有效" : "未生效"}{!u.active ? " · 账号已停用" : ""}</small></button>{u.sync_error && <button className="admin-sync-retry" disabled={busy} onClick={() => void run(() => retryMembershipSync(u.id), "已安排重新同步。")}>重试同步</button>}</div>)}</div>
          <div className="admin-pagination"><button disabled={busy || offset === 0} onClick={() => void run(() => search(Math.max(0, offset - 50)))}>上一页</button><span>第 {offset / 50 + 1} 页</span><button disabled={busy || users.length < 50} onClick={() => void run(() => search(offset + 50))}>下一页</button></div>
        </section>{selectedUser ? <MemberEditor key={selectedUser.id + ":" + selectedUser.entitlements.membership_revision} user={selectedUser} plans={plans} busy={busy} onSave={(id, expires, reason) => run(async () => {
          const entitlements = await assignMembership(selectedUser.id, id, expires, selectedUser.entitlements.membership_revision, reason);
          setSelectedUser({ ...selectedUser, entitlements }); await reload();
        }, "会员已更新，新的模型调用按当前权益执行。")} /> : <aside className="admin-empty"><span aria-hidden="true">↖</span><h2>选择一位用户</h2><p>开通、调整或撤销会员，并记录变更原因。</p></aside>}</div>}
        {tab === "audit" && <section className="console-card admin-panel"><div className="admin-panel-heading"><h2>最近的操作记录</h2><span className="admin-revision">最近 100 条</span></div>{events.length === 0 ? <p className="admin-description">尚无变更记录。</p> : <div className="admin-audit-list">{events.map(event => <details key={event.id}><summary><strong>{event.action === "plan.updated" ? "更新套餐模型" : "变更用户会员"}</strong><span>{event.actor_email}</span><time>{new Date(event.created_at * 1000).toLocaleString()}</time></summary><p>对象：{event.target}</p>{event.reason && <p>原因：{event.reason}</p>}<div className="admin-form-grid"><div><h3>变更前</h3><pre>{JSON.stringify(JSON.parse(event.before), null, 2)}</pre></div><div><h3>变更后</h3><pre>{JSON.stringify(JSON.parse(event.after), null, 2)}</pre></div></div></details>)}</div>}</section>}
      </>}
      <p className="admin-footer">SomniQ 管理会员与模型权限 · New API 提供模型渠道和用量结算</p>
  </section>;
}
