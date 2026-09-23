import { IndependentAccountError } from "./independentAccount";

export type PlanId = "go" | "plus" | "pro";
export interface MembershipPlan {
  id: PlanId; name: string; amount_fen: number; currency: "CNY"; billing_period: "month";
  models: string[]; default_executor: string | null; default_reviewer: string | null;
  enabled: boolean; revision: number;
}
export interface Entitlements {
  plan: MembershipPlan | null; expires_at: number | null; membership_revision: number; active: boolean;
  models: string[]; default_executor: string | null; default_reviewer: string | null;
}
export interface MemberUser {
  id: string; email: string; display_name: string; active: boolean;
  entitlements: Entitlements; sync_error: string | null;
}
export interface AuditEvent {
  id: number; actor_email: string; action: string; target: string; reason: string;
  before: string; after: string; created_at: number;
}
export interface PlanUpdate {
  models: string[]; default_executor: string | null; default_reviewer: string | null;
  enabled: boolean; expected_revision: number;
}
async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(path, { method, credentials: "same-origin", cache: "no-store", redirect: "error",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const value = await response.json().catch(() => null);
    throw new IndependentAccountError(value?.error?.code || "service_unavailable", response.status);
  }
  return response.status === 202 || response.status === 204 ? undefined as T : response.json();
}
function validatePlan(value: MembershipPlan): MembershipPlan {
  if (!value || !["go", "plus", "pro"].includes(value.id) || typeof value.name !== "string"
    || value.currency !== "CNY" || value.billing_period !== "month"
    || !Number.isSafeInteger(value.amount_fen) || value.amount_fen < 0
    || !Number.isSafeInteger(value.revision) || !Array.isArray(value.models)
    || !value.models.every(m => typeof m === "string") || typeof value.enabled !== "boolean") {
    throw new IndependentAccountError("invalid_catalog", 502);
  }
  return value;
}
export async function loadMembershipCatalog() {
  const value = await request<{ plans: MembershipPlan[]; checkout_available: boolean }>("/v2/catalog/plans");
  if (!Array.isArray(value.plans) || value.plans.length !== 3 || new Set(value.plans.map(p => p.id)).size !== 3) {
    throw new IndependentAccountError("invalid_catalog", 502);
  }
  return { ...value, plans: value.plans.map(validatePlan) };
}
export const loadEntitlements = () => request<Entitlements>("/v2/account/entitlements");
export const loadAdminPlans = () => request<MembershipPlan[]>("/v2/admin/plans");
export const discoverMembershipModels = () => request<{ models: string[] }>("/v2/admin/models");
export const saveMembershipPlan = (id: PlanId, body: PlanUpdate) =>
  request<MembershipPlan>("/v2/admin/plans/" + encodeURIComponent(id), "PUT", body);
export const loadMemberUsers = (query = "", offset = 0) =>
  request<{ users: MemberUser[] }>("/v2/admin/users?" + new URLSearchParams({ q: query, offset: String(offset) }));
export const assignMembership = (id: string, planId: PlanId | null, expiresAt: number | null, revision: number, reason: string) =>
  request<Entitlements>("/v2/admin/users/" + encodeURIComponent(id) + "/membership", "PUT",
    { plan_id: planId, expires_at: expiresAt, expected_revision: revision, reason });
export const retryMembershipSync = (id: string) =>
  request<void>("/v2/admin/users/" + encodeURIComponent(id) + "/sync", "POST", {});
export const loadMembershipAudit = () => request<{ events: AuditEvent[] }>("/v2/admin/audit");
export function membershipPrice(plan: MembershipPlan, locale = "zh-CN") {
  return new Intl.NumberFormat(locale, { style: "currency", currency: plan.currency, minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(plan.amount_fen / 100);
}
export function modelLines(text: string): string[] {
  return [...new Set(text.split(/\r?\n/).map(s => s.trim()).filter(Boolean))].sort();
}
export function nextMembershipMonth(from = new Date()): Date {
  const next = new Date(from);
  // Clamp January 31 to February's last day instead of overflowing into March.
  next.setDate(1);
  next.setMonth(next.getMonth() + 1);
  const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(from.getDate(), lastDay));
  return next;
}
export function membershipError(error: unknown): string {
  const code = error instanceof IndependentAccountError ? error.code : "";
  const messages: Record<string, string> = {
    admin_required: "此账号没有管理员权限。", sign_in_required: "登录已失效，请重新登录。",
    agreement_required: "请先在账户中心接受服务协议。", origin_rejected: "请求来源不匹配，请从本站重新打开页面。",
    revision_conflict: "配置已被其他操作更新。请刷新后重新编辑，避免覆盖修改。",
    invalid_model_list: "模型 ID 格式无效，最多支持 128 个精确模型名称，不支持通配符。",
    invalid_default_model: "默认模型必须在本版本的模型列表中。",
    plan_models_required: "启用版本前，请选择模型及默认执行、审查模型。",
    plan_unavailable: "该版本尚未启用，请先配置模型。", invalid_expiry: "请选择未来的有效截止时间。",
    reason_required: "请填写变更原因。", user_not_found: "用户不存在或已停用。",
  };
  return messages[code] || "服务暂不可用，请重试。读取模型前，请先在账户中心连接算力服务。";
}
