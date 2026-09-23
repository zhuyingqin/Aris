// Separate contract: a SomniQ UUID is never coerced into a New API user ID.
// This client uses only same-origin HttpOnly sessions, with no storage fallback.
export const independentAccountsEnabled = import.meta.env.VITE_ACCOUNT_MODE === "independent";

export interface IndependentAccount {
  user: { id: string; email: string; display_name: string };
  agreement_required: boolean;
  compute_connected: boolean;
}
export interface AccountAgreement { version: string; text: string; content_hash: string }
export interface ComputeUsage { quota: number; used_quota: number; request_count: number; unit: "newapi_quota" }

export class IndependentAccountError extends Error {
  constructor(public readonly code: string, public readonly status: number) { super(code); }
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/v2/account/${path}`, {
    credentials: "same-origin", cache: "no-store", redirect: "error",
    ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const value = await response.json().catch(() => null);
    throw new IndependentAccountError(value?.error?.code || "service_unavailable", response.status);
  }
  return response.status === 204 ? undefined as T : response.json();
}

export async function loadIndependentAccount(): Promise<IndependentAccount | null> {
  try {
    const value = await api<IndependentAccount>("me");
    if (typeof value.user?.id !== "string" || !/^[a-f0-9-]{36}$/i.test(value.user.id)
      || typeof value.user.email !== "string" || typeof value.user.display_name !== "string"
      || typeof value.agreement_required !== "boolean" || typeof value.compute_connected !== "boolean") {
      throw new IndependentAccountError("invalid_account", 502);
    }
    return value;
  } catch (error) {
    if (error instanceof IndependentAccountError && error.status === 401) return null;
    throw error;
  }
}
export const loadAccountAgreement = () => api<AccountAgreement>("agreement");
export const acceptAccountAgreement = (agreement: AccountAgreement) => api<void>("consent", {
  version: agreement.version, content_hash: agreement.content_hash, accepted: true,
});
export const logoutIndependentAccount = () => api<void>("logout", {});
export async function loadComputeUsage(): Promise<ComputeUsage> {
  const value = await api<ComputeUsage>("compute");
  if (value.unit !== "newapi_quota" || ![value.quota, value.used_quota, value.request_count].every(Number.isFinite)) {
    throw new IndependentAccountError("invalid_usage", 502);
  }
  return value;
}
export async function beginComputeConnection(): Promise<string> {
  const value = await api<{ authorization_url: string }>("compute/connect", {});
  const url = new URL(value.authorization_url);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) {
    throw new IndependentAccountError("invalid_authorization_url", 502);
  }
  return url.href;
}
