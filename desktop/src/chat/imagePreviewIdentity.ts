import { isDirectImageSource } from "./ChatImagePreview";
import { displayLocalFilePath, normalizeLocalFileHref } from "./localFileLinks";

export interface ImagePreviewScope {
  precedingKeys: ReadonlySet<string>;
  projectPath: string | null;
}

export interface ToolImagePreviews {
  paths: string[];
  references: string[];
}

export function normalizeImagePreviewSource(source: string): string {
  return isDirectImageSource(source) ? source.trim() : normalizeLocalFileHref(source);
}

/** Presentation identity only: do not rewrite persisted tool output or URLs.
 * Each assistant turn owns its own set, so later requests can show the image
 * again and virtual rows never depend on mount order or a global registry. */
export function imagePreviewKey(source: string, projectPath: string | null): string {
  const normalized = normalizeImagePreviewSource(source);
  if (isDirectImageSource(normalized)) {
    if (/^https?:\/\//i.test(normalized)) {
      try { return new URL(normalized).href; } catch { /* Keep malformed URLs distinct. */ }
    }
    return normalized;
  }
  let path = displayLocalFilePath(normalized).split(/[?#]/, 1)[0];
  if (!/^(?:[a-z]:\/|\/)/i.test(path) && projectPath) {
    path = `${displayLocalFilePath(projectPath).replace(/\/+$/, "")}/${path}`;
  }
  const prefix = path.startsWith("//") ? "//" : path.startsWith("/") ? "/" : "";
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length && parts[parts.length - 1] !== ".." && !/^[a-z]:$/i.test(parts[parts.length - 1])) {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  path = prefix + parts.join("/");
  return /^(?:[a-z]:\/|\/\/)/i.test(path) ? path.toLowerCase() : path;
}
