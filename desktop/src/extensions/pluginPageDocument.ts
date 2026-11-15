// The document a plugin page runs in.
//
// Two frames, both without an origin of their own (`sandbox` without
// `allow-same-origin`):
//
//   app  >  shell (host-written, no script)  >  page (the package's HTML)
//
// The page's CSP allows inline script and style and nothing from the network.
// CSP does not govern a frame navigating itself (`location.href = …` would
// carry data out in the URL), so the shell exists to carry `frame-src 'none'`:
// every navigation of the page is then a blocked frame load. A sandboxed frame
// may not navigate its parent or the app either. Measured in Edge/WebView2:
// navigation, meta refresh, links, forms, fetch, images, stylesheets, scripts,
// beacons, sockets, popups and nested frames all send nothing.
//
// A page may use the package's other files by relative path. Nothing is served
// to the frame: before it loads, scripts and stylesheets are inlined, other
// files become `data:` URLs, and `.mjs` modules are reachable by the
// `pkg:<path>` names of an import map. The page's links never leave the
// package, and nothing it names outside the package resolves.
import type { UiPageFile } from "../api/plugins";
import bootstrap from "./pluginPageBootstrap.js?raw";

export interface PluginPageTheme {
  mode: "light" | "dark";
  /** bg, surface, raised, border, text, muted, accent. */
  colors: Record<string, string>;
  font: string;
}
export interface PluginPageInitial {
  language: "en" | "cn";
  theme: PluginPageTheme;
  /** Every declared widget's value, by widget id. */
  data: Record<string, unknown>;
}

const PAGE_CSP = [
  "default-src 'none'", "script-src 'unsafe-inline' data:", "style-src 'unsafe-inline'", "img-src data: blob:", "font-src data:",
  "media-src data: blob:", "connect-src 'none'", "form-action 'none'", "base-uri 'none'", "webrtc 'block'",
].join("; ");
/** `allow-forms` only lets a form fire its submit event; `form-action 'none'` and the shell stop it leaving. */
export const PLUGIN_PAGE_SANDBOX = "allow-scripts allow-forms";
const MAX_CSS_IMPORT_DEPTH = 8;

/** A value as a JavaScript expression that cannot end the inline script it sits in. */
const literal = (value: unknown) => JSON.stringify(value)
  .replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
const attribute = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const decode = (base64: string) => new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
const isCode = (path: string) => /\.(m?js|css|html)$/i.test(path);

/** `reference` from the file at `from`, as a package-relative path; null when it leaves the package or is not relative. */
export function packagePath(from: string, reference: string): string | null {
  const ref = reference.trim().split(/[?#]/)[0];
  if (!ref || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("//") || ref.startsWith("/")) return null;
  const parts = from.split("/").slice(0, -1);
  for (const part of ref.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") { if (!parts.length) return null; parts.pop(); } else parts.push(part);
  }
  return parts.join("/");
}

function inline({ html, path: pagePath, assets }: Pick<UiPageFile, "html" | "path" | "assets">): string {
  const dataUrl = (path: string) => `data:${assets[path].mime};base64,${assets[path].data}`;
  const find = (from: string, reference: string) => {
    const path = packagePath(from, reference);
    return path !== null && assets[path] ? path : null;
  };
  const css = (text: string, from: string, depth = 0): string => text
    .replace(/@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1\s*\)?([^;]*);/g, (whole, _q, reference: string) => {
      const path = find(from, reference);
      return path && depth < MAX_CSS_IMPORT_DEPTH ? css(decode(assets[path].data), path, depth + 1) : whole;
    })
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (whole, _q, reference: string) => {
      const path = find(from, reference);
      return path ? `url("${dataUrl(path)}")` : whole;
    })
    .replace(/<\/style/gi, "<\\/style");
  const script = (text: string) => text.replace(/<\/script/gi, "<\\/script");

  const doc = new DOMParser().parseFromString(html.replace(/^\uFEFF/, ""), "text/html");
  for (const element of [...doc.querySelectorAll("script[src]")]) {
    const path = find(pagePath, element.getAttribute("src")!);
    if (!path) continue;
    element.removeAttribute("src");
    // A module file keeps its import-map name, so its own `pkg:` imports resolve.
    element.textContent = element.getAttribute("type") === "module" ? `import ${literal(`pkg:${path}`)};` : script(decode(assets[path].data));
  }
  for (const element of [...doc.querySelectorAll('link[rel~="stylesheet"][href]')]) {
    const path = find(pagePath, element.getAttribute("href")!);
    if (!path) continue;
    const style = doc.createElement("style");
    const media = element.getAttribute("media");
    if (media) style.setAttribute("media", media);
    style.textContent = css(decode(assets[path].data), path);
    element.replaceWith(style);
  }
  for (const element of [...doc.querySelectorAll("style")]) element.textContent = css(element.textContent ?? "", pagePath);
  for (const element of [...doc.querySelectorAll("[style]")]) element.setAttribute("style", css(element.getAttribute("style")!, pagePath));
  const swap = (selector: string, name: string) => {
    for (const element of [...doc.querySelectorAll(selector)]) {
      const path = find(pagePath, element.getAttribute(name)!);
      if (path) element.setAttribute(name, dataUrl(path));
    }
  };
  swap("img[src], source[src], video[src], audio[src], track[src], input[src], embed[src]", "src");
  swap("video[poster]", "poster");
  swap('link[rel~="icon"][href], image[href], feImage[href]', "href");
  for (const element of [...doc.querySelectorAll("img[srcset], source[srcset]")]) {
    element.setAttribute("srcset", element.getAttribute("srcset")!.split(",").map((candidate) => {
      const [reference, ...rest] = candidate.trim().split(/\s+/);
      const path = find(pagePath, reference);
      return [path ? dataUrl(path) : reference, ...rest].join(" ");
    }).join(", "));
  }
  // Modules: `import x from "pkg:ui/lib/x.mjs"` works from any module, at any depth.
  const modules = Object.keys(assets).filter((path) => /\.mjs$/i.test(path));
  if (modules.length) {
    const map = doc.createElement("script");
    map.setAttribute("type", "importmap");
    map.textContent = literal({ imports: Object.fromEntries(modules.map((path) => [`pkg:${path}`, `data:text/javascript;base64,${assets[path].data}`])) });
    doc.head.prepend(map);
  }
  return doc.documentElement.outerHTML;
}

export function pluginPageDocument(file: Pick<UiPageFile, "html" | "path" | "assets">, channel: string, initial: PluginPageInitial): string {
  // Images, fonts and data files the page loads from script: `somniq.asset(path)` / `somniq.text(path)`.
  const files = Object.fromEntries(Object.entries(file.assets).filter(([path]) => !isCode(path)));
  const start = `${bootstrap.trim().replace(/;$/, "")}(${literal(channel)}, ${literal({ ...initial, page: file.path, files })});`;
  // The host's head comes first; the parser folds the page's own <html> and
  // <head> into it, so the page's code always runs after the bootstrap.
  const page = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}"><script>${start}</script>${inline(file)}`;
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="frame-src 'none'">`
    + `<style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}iframe{display:block;border:0;width:100%;height:100%}</style>`
    + `<iframe sandbox="${PLUGIN_PAGE_SANDBOX}" srcdoc="${attribute(page)}"></iframe>`;
}
