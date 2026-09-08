const WINDOWS_DRIVE_HREF_RE = /^[a-z]:(?:[\\/]|%5c|%2f)/i;
const FILE_URI_RE = /^file:\/\//i;
const VSCODE_FILE_URI_RE = /^vscode:\/\/file\//i;

function decodeHref(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function stripEditorLocation(value: string) {
  return value
    .replace(/#L\d+(?:C\d+)?$/i, "")
    .replace(/#line-\d+$/i, "")
    .replace(/\?(?:line|lineNumber)=\d+(?:&(?:column|col)=\d+)?$/i, "");
}

function stripCompactEditorLocation(value: string) {
  let stripped = value;
  const lastColon = stripped.lastIndexOf(':');
  const lastSegment = stripped.slice(lastColon + 1);
  if (lastColon > 0 && /^\d+$/.test(lastSegment)) {
    const candidate = stripped.slice(0, lastColon);
    const previousColon = candidate.lastIndexOf(':');
    if (previousColon > 0 && /^\d+$/.test(candidate.slice(previousColon + 1))) {
      stripped = candidate.slice(0, previousColon);
    } else {
      stripped = candidate;
    }
  }
  return stripped;
}

/** Formats a local path for UI text without changing the path sent to the
 * desktop backend. Windows canonical paths may start with `\\?\`, which is
 * needed by the OS but should not leak into chat file labels or diff headers. */
export function displayLocalFilePath(path: string) {
  const normalized = path.replace(/\\/g, "/");
  if (/^\/\/\?\/unc\//i.test(normalized)) return normalized.replace(/^\/\/\?\/unc\//i, "//");
  return normalized.replace(/^\/\/\?\//, "");
}

/** True for local references that react-markdown's default URL sanitizer
 * rejects because a Windows drive letter looks like a custom URI scheme. */
export function isExplicitLocalFileHref(href: string) {
  const value = href.trim();
  return WINDOWS_DRIVE_HREF_RE.test(value)
    || FILE_URI_RE.test(value)
    || VSCODE_FILE_URI_RE.test(value)
    || /^\\\\/.test(value);
}

/** Convert the local link formats commonly emitted by LLMs into a filesystem
 * path understood by the desktop backend. Relative paths remain relative to
 * the selected project workspace. */
export function normalizeLocalFileHref(href: string) {
  let value = decodeHref(href.trim())
    .trim()
    .replace(/^[`<"']+|[`>"']+$/g, "");

  if (VSCODE_FILE_URI_RE.test(value)) {
    value = value.slice("vscode://file/".length);
  } else if (FILE_URI_RE.test(value)) {
    let rest = value.slice("file://".length);
    if (rest.toLowerCase().startsWith("localhost/")) rest = rest.slice("localhost".length);
    if (/^\/[a-z]:[\\/]/i.test(rest)) rest = rest.slice(1);
    else if (!rest.startsWith("/") && !WINDOWS_DRIVE_HREF_RE.test(rest)) rest = `//${rest}`;
    value = rest;
  }

  if (/^\/[a-z]:[\\/]/i.test(value)) value = value.slice(1);
  return stripCompactEditorLocation(stripEditorLocation(value.replace(/\\/g, "/")));
}
