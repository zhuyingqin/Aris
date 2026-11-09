const CHANNEL = "somniq-workspace-trust/v1";
const STORAGE_KEY = "somniq-code-workspace-trust-v1";
const MAX_MODEL_BYTES = 512 * 1024;

export function validTrustModel(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_MODEL_BYTES) return false;
  try {
    const model = JSON.parse(value);
    return Array.isArray(model?.uriTrustInfo) && model.uriTrustInfo.length <= 5000
      && model.uriTrustInfo.every((item: unknown) => {
        if (!item || typeof item !== "object") return false;
        const entry = item as { trusted?: unknown; uri?: { scheme?: unknown; path?: unknown } };
        return entry.trusted === true && typeof entry.uri?.scheme === "string"
          && typeof entry.uri?.path === "string" && entry.uri.path.startsWith("/");
      });
  } catch { return false; }
}

export function workbenchFrameUrl(url: string): string {
  const frame = new URL(url);
  frame.searchParams.set("somniqTrustHost", window.location.origin);
  return frame.toString();
}

/** Accept only the currently mounted, authenticated workbench's storage RPC. */
export function listenForWorkspaceTrust(frame: HTMLIFrameElement, url: string): () => void {
  const origin = new URL(url).origin;
  const receive = (event: MessageEvent) => {
    if (event.source !== frame.contentWindow || event.origin !== origin) return;
    const request = event.data;
    if (request?.channel !== CHANNEL || typeof request.id !== "string" || request.id.length > 64) return;
    let model: string | null = null;
    let saved = false;
    if (request.type === "load") {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (validTrustModel(stored)) model = stored;
      } catch { /* The workbench retains its own IndexedDB fallback. */ }
    } else if (request.type === "save" && validTrustModel(request.model)) {
      try {
        localStorage.setItem(STORAGE_KEY, request.model);
        saved = true;
      } catch { /* Report failure; do not acknowledge durable persistence. */ }
    } else return;
    frame.contentWindow?.postMessage({ channel: CHANNEL, type: "reply", id: request.id, model, saved }, origin);
  };
  window.addEventListener("message", receive);
  return () => window.removeEventListener("message", receive);
}
