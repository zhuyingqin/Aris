/**
 * Normalizes the path under which the mobile PWA is served.  This is kept
 * deliberately path-only: accepting an absolute or protocol-relative URL
 * would turn the Vite asset base into an unexpected cross-origin target.
 */
export function normalizeMobileBasePath(value: string | undefined): string {
  const raw = value?.trim() ?? "";
  if (!raw || raw === "/") {
    return "/";
  }

  if (raw.startsWith("//") || raw.includes("://") || /[?#\\]/.test(raw)) {
    throw new Error("SOMNIQ_MOBILE_BASE_PATH must be a URL path without a query, fragment, or host.");
  }

  const segments = raw.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("SOMNIQ_MOBILE_BASE_PATH cannot contain . or .. path segments.");
  }

  return `/${segments.join("/")}/`;
}

/** Returns a same-origin URL path within a normalized mobile PWA base. */
export function mobileBasePathUrl(path: string, basePath = "/"): string {
  const suffix = path.replace(/^\/+/, "");
  return `${normalizeMobileBasePath(basePath)}${suffix}`;
}
