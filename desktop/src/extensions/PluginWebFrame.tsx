// A plugin panel that embeds a web page (`web` in ui.json), e.g. a local
// tool's web UI. The host draws the frame and its controls; no package code
// runs here, and the embedded site gets no `somniq` bridge and no plugin data.
//
// The site keeps its own origin (`allow-same-origin` makes it the site's,
// never the app's), so it can use its cookies and storage. The backend
// refuses the app's own origins (`*.localhost`, the dev server); Tauri rejects
// commands from every other origin because no capability names a remote one.
// It cannot navigate the app (no `allow-top-navigation`), and the windows it
// opens go to the system browser (the webview's new-window handler).
import { useState } from "react";
import { openExternalUrl } from "../api/tauri";
import type { ActiveUiPanel } from "../api/plugins";
import { tr } from "../language";
import type { Language } from "../store";
import { SvgIcon } from "../SvgIcon";
import { uiText } from "./useChatPluginPanels";
import "./PluginWebFrame.css";

export const WEB_PANEL_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

/** Reload and open-in-browser for a web panel. Many public sites refuse to be
 *  embedded, and the frame cannot tell; the browser is always one click away. */
export function PluginWebControls({ url, language, onReload }: { url: string; language: Language; onReload: () => void }) {
  const host = (() => { try { return new URL(url).host; } catch { return url; } })();
  return <span className="plugin-web-controls">
    <span className="plugin-web-host" title={url}>{host}</span>
    <button type="button" className="plugin-web-button" onClick={onReload}
      title={tr(language, "重新加载", "Reload", "Recargar")} aria-label={tr(language, "重新加载", "Reload", "Recargar")}>
      <SvgIcon name="refresh" size={13} />
    </button>
    <button type="button" className="plugin-web-button" onClick={() => void openExternalUrl(url).catch(() => undefined)}
      title={tr(language, "在浏览器中打开", "Open in browser", "Abrir en el navegador")}>
      <SvgIcon name="externalLink" size={13} />
      <span>{tr(language, "在浏览器中打开", "Open in browser", "Abrir en el navegador")}</span>
    </button>
  </span>;
}

export default function PluginWebFrame({ panel, language, reloadKey = 0 }: { panel: ActiveUiPanel; language: Language; reloadKey?: number }) {
  if (!panel.web) return null;
  return <iframe
    key={`${panel.web}#${reloadKey}`}
    className="plugin-page-frame plugin-web-frame"
    src={panel.web}
    title={uiText(panel.title, language)}
    sandbox={WEB_PANEL_SANDBOX}
    referrerPolicy="no-referrer"
    allow="clipboard-read; clipboard-write; fullscreen"
  />;
}

/** The frame plus its reload counter, for hosts that draw the controls. */
export function useWebPanelReload() {
  const [reloadKey, setReloadKey] = useState(0);
  return { reloadKey, reload: () => setReloadKey((value) => value + 1) };
}
