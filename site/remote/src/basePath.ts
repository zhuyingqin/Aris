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

/**
 * Resolves the path the PWA is actually mounted at.
 *
 * `import.meta.env.BASE_URL` only describes the Vite root that produced the
 * bundle, which is not always the root that serves it: the landing-page dev
 * server hosts this app at `/remote/` while owning its own config, so BASE_URL
 * reads `/` even though the document lives one directory down. Falling back to
 * the document's own directory keeps icons and the service-worker scope
 * pointing at the real mount instead of the host application's root.
 */
export function resolveMobileBasePath(baseUrl: string | undefined, pathname: string): string {
  const configured = normalizeMobileBasePath(baseUrl);
  if (configured !== "/") {
    return configured;
  }

  const directory = pathname.slice(0, pathname.lastIndexOf("/") + 1);
  try {
    return normalizeMobileBasePath(directory);
  } catch {
    return "/";
  }
}

/** Returns a same-origin URL path within a normalized mobile PWA base. */
export function mobileBasePathUrl(path: string, basePath = "/"): string {
  const suffix = path.replace(/^\/+/, "");
  return `${normalizeMobileBasePath(basePath)}${suffix}`;
}
