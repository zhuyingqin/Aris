import { isTauri, openExternalUrl } from "./api/tauri";

const EXTERNAL_SCHEME = /^(https?:|mailto:|tel:)/i;

/** The external URL an activated anchor points at, or null when the click
 * belongs to the app (in-app routes, same-origin assets, local files, or a
 * handler that already took the click). */
export function externalHrefForClick(event: MouseEvent): string | null {
  if (event.defaultPrevented) return null;
  if (event.button !== 0 && event.button !== 1) return null;
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const anchor = target.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute("download")) return null;
  const raw = anchor.getAttribute("href")?.trim() ?? "";
  if (!EXTERNAL_SCHEME.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if ((url.protocol === "http:" || url.protocol === "https:") && url.origin === window.location.origin) return null;
  return url.href;
}

/** Tauri's WebView refuses `target="_blank"` (and a plain external link would
 * navigate the app window itself away), so every external anchor in the app —
 * chat Markdown, reasoning blocks, search hits, literature DOI links — is
 * routed to the system browser here instead of per component. */
export function installExternalLinkRouting(): () => void {
  if (typeof document === "undefined" || !isTauri()) return () => undefined;
  const handle = (event: MouseEvent) => {
    const href = externalHrefForClick(event);
    if (!href) return;
    event.preventDefault();
    void openExternalUrl(href).catch((error) => console.warn("open external link failed", error));
  };
  // Bubble phase: component handlers (local-file links, evidence citations)
  // run first and claim their clicks with preventDefault.
  document.addEventListener("click", handle);
  document.addEventListener("auxclick", handle);
  return () => {
    document.removeEventListener("click", handle);
    document.removeEventListener("auxclick", handle);
  };
}
