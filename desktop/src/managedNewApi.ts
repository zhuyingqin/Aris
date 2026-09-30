import endpoint from "../managed-newapi.json";

export const LEGACY_MANAGED_NEWAPI_BASE_URL = "http://106.53.28.124:18080";

/** A release can override the candidate host while its DNS and TLS are being prepared. */
export function secureManagedNewApiBaseUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
      || !url.hostname || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash) return "";
    return url.origin;
  } catch {
    return "";
  }
}

const configuredUrl = import.meta.env.VITE_MANAGED_NEWAPI_URL ?? endpoint.baseUrl;
// An invalid build override must not silently fall back to a different host.
export const MANAGED_NEWAPI_BASE_URL = secureManagedNewApiBaseUrl(configuredUrl);

export function approvedManagedNewApiBaseUrl(value: string): string {
  const base = secureManagedNewApiBaseUrl(value);
  if (base && base === MANAGED_NEWAPI_BASE_URL) return base;
  if (import.meta.env.DEV && base.startsWith("http://")) return base;
  return "";
}

export function isLegacyManagedNewApiUrl(value: string | null | undefined): boolean {
  const normalized = (value ?? "").trim().replace(/\/+$/, "").toLowerCase();
  const legacy = LEGACY_MANAGED_NEWAPI_BASE_URL.toLowerCase();
  return normalized === legacy || normalized === `${legacy}/v1`;
}
