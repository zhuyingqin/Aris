// A plugin panel in the `nav.page` slot: a page of its own, opened from the
// navigation rail. Either the same declared panel the Chat sidebar draws, laid
// out in columns, or (a panel with a `page`) the package's own HTML in a
// sandboxed frame, or (a panel with `web`) a site the host embeds. A panel may
// pair its page or widgets with a site: the host shows both, split by a divider
// the user drags. All of them show project data only: a button, a form or the
// page hands a prompt to Chat, where the work happens as an ordinary turn.
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { ActiveUiPanel } from "../api/plugins";
import type { Language } from "../store";
import { tr } from "../language";
import ChatPluginPanel from "./ChatPluginPanel";
import PluginEditButton from "./PluginEditButton";
import PluginPageFrame from "./PluginPageFrame";
import PluginWebFrame, { PluginWebControls, useWebPanelReload } from "./PluginWebFrame";
import PluginPanelIcon from "./PluginPanelIcon";
import { uiText, type PluginPageAction } from "./useChatPluginPanels";
import "./PluginPage.css";

/** The share of the page the panel's own page or widgets take beside a site. */
const SPLIT_DEFAULT = 40;
const SPLIT_MIN = 15;
const SPLIT_MAX = 85;
const SPLIT_STEP = 5;

function splitKey(panel: ActiveUiPanel) {
  return `somniq-plugin-split:${panel.pluginName}:${panel.id}`;
}

function clampSplit(value: number) {
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, Math.round(value)));
}

function storedSplit(panel: ActiveUiPanel) {
  try {
    const stored = Number(window.localStorage?.getItem(splitKey(panel)));
    return Number.isFinite(stored) && stored > 0 ? clampSplit(stored) : SPLIT_DEFAULT;
  } catch {
    return SPLIT_DEFAULT;
  }
}

/** A panel whose page or widgets share the page with an embedded site. */
function sharesPageWithWeb(panel: ActiveUiPanel) {
  return Boolean(panel.web) && (Boolean(panel.page) || panel.widgets.length > 0);
}

export default function PluginPage({ panel, store, projectPath, language, onAction }: {
  panel: ActiveUiPanel;
  /** The panel named by `dataPanel`, whose widgets the page reads and writes. */
  store?: ActiveUiPanel;
  projectPath: string; language: Language; onAction: (action: PluginPageAction) => void;
}) {
  const title = uiText(panel.title, language);
  const web = useWebPanelReload();
  const edit = <PluginEditButton panel={panel} language={language} onPrompt={(text) => onAction({ type: "prompt", text, send: false })} />;
  if (sharesPageWithWeb(panel)) return <SplitPage key={`${panel.pluginName}:${panel.id}`} panel={panel} store={store} projectPath={projectPath} language={language} onAction={onAction} />;
  // The host's header stays above a page that draws itself, so the user can
  // always tell which package is on screen, and above an embedded site, so
  // they can always tell which address it is.
  if (panel.web) return <div className="plugin-page plugin-page-own plugin-page-web" aria-label={title}>
    <header className="plugin-page-head">
      <span className="plugin-page-icon" aria-hidden="true"><PluginPanelIcon panel={panel} size={16} /></span>
      <h1>{title}</h1>
      <span className="plugin-page-source" title={panel.pluginName}>{tr(language, "插件网页", "Plugin web page", "Página web del plugin")} · {panel.pluginName}</span>
      <PluginWebControls url={panel.web} language={language} onReload={web.reload} />
      {edit}
    </header>
    <PluginWebFrame panel={panel} language={language} reloadKey={web.reloadKey} />
  </div>;
  if (panel.page) return <div className="plugin-page plugin-page-own" aria-label={title}>
    <header className="plugin-page-head">
      <span className="plugin-page-icon" aria-hidden="true"><PluginPanelIcon panel={panel} size={16} /></span>
      <h1>{title}</h1>
      <span className="plugin-page-source" title={panel.pluginName}>{tr(language, "插件页面", "Plugin page", "Página del plugin")} · {panel.pluginName}</span>
      {edit}
    </header>
    <PluginPageFrame panel={panel} store={store} projectPath={projectPath} language={language} onAction={onAction} />
  </div>;
  return <div className="plugin-page" aria-label={title}>
    <header className="plugin-page-head">
      <span className="plugin-page-icon" aria-hidden="true"><PluginPanelIcon panel={panel} size={18} /></span>
      <h1>{title}</h1>
      <span className="plugin-page-source" title={panel.pluginName}>{tr(language, "插件页面", "Plugin page", "Página del plugin")} · {panel.pluginName}</span>
      {edit}
    </header>
    <div className="plugin-page-body">
      <PanelWidgets panel={panel} projectPath={projectPath} language={language} onAction={onAction} />
    </div>
  </div>;
}

function PanelWidgets({ panel, projectPath, language, onAction }: {
  panel: ActiveUiPanel; projectPath: string; language: Language; onAction: (action: PluginPageAction) => void;
}) {
  return <ChatPluginPanel
    key={`${projectPath}:${panel.pluginName}:${panel.id}:${panel.packageDigest}`}
    panel={panel} projectPath={projectPath} sessionId="" language={language} agentTodos={[]}
    onPrompt={(text, send) => onAction({ type: "prompt", text, send })}
    onOpenFile={(path) => onAction({ type: "open-file", path })}
  />;
}

/** The panel's page or widgets and its site, in two regions. They stay two
 *  frames: the bridge goes only to the package's page, never to the site. */
function SplitPage({ panel, store, projectPath, language, onAction }: {
  panel: ActiveUiPanel; store?: ActiveUiPanel; projectPath: string; language: Language; onAction: (action: PluginPageAction) => void;
}) {
  const title = uiText(panel.title, language);
  const web = useWebPanelReload();
  const layout = panel.webLayout === "right" ? "right" : "below";
  const key = splitKey(panel);
  const [split, setSplit] = useState(() => storedSplit(panel));
  const [dragging, setDragging] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const moved = useRef(false);

  useEffect(() => {
    // Remember only a divider the user moved.
    if (!moved.current) {
      moved.current = true;
      return;
    }
    try {
      window.localStorage?.setItem(key, String(split));
    } catch {
      // The divider still moves when local storage cannot be written.
    }
  }, [key, split]);

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const box = body.current?.getBoundingClientRect();
    if (!box) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    handle.setPointerCapture?.(pointerId);
    const onMove = (move: PointerEvent) => {
      const share = layout === "right"
        ? (move.clientX - box.left) / Math.max(1, box.width)
        : (move.clientY - box.top) / Math.max(1, box.height);
      setSplit(clampSplit(share * 100));
    };
    const onUp = () => {
      handle.releasePointerCapture?.(pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      setDragging(false);
    };
    // Frames swallow pointer events; while dragging they ignore the pointer.
    setDragging(true);
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };

  const onKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const less = layout === "right" ? "ArrowLeft" : "ArrowUp";
    const more = layout === "right" ? "ArrowRight" : "ArrowDown";
    if (event.key !== less && event.key !== more) return;
    event.preventDefault();
    setSplit((current) => clampSplit(current + (event.key === more ? SPLIT_STEP : -SPLIT_STEP)));
  };

  // The widgets keep their own sidebar drawing; only the site moves out of it.
  const widgetsOnly: ActiveUiPanel = { ...panel, web: undefined, webLayout: undefined };
  return <div className={`plugin-page plugin-page-own plugin-page-split${dragging ? " is-dragging" : ""}`} data-layout={layout} aria-label={title}>
    <header className="plugin-page-head">
      <span className="plugin-page-icon" aria-hidden="true"><PluginPanelIcon panel={panel} size={16} /></span>
      <h1>{title}</h1>
      <span className="plugin-page-source" title={panel.pluginName}>{tr(language, "插件页面", "Plugin page", "Página del plugin")} · {panel.pluginName}</span>
      {panel.web && <PluginWebControls url={panel.web} language={language} onReload={web.reload} />}
      <PluginEditButton panel={panel} language={language} onPrompt={(text) => onAction({ type: "prompt", text, send: false })} />
    </header>
    <div ref={body} className="plugin-page-split-body" style={{ "--plugin-split": `${split}%` } as CSSProperties}>
      <section className="plugin-page-split-main" aria-label={title}>
        {panel.page
          ? <PluginPageFrame panel={panel} store={store} projectPath={projectPath} language={language} onAction={onAction} />
          : <div className="plugin-page-split-widgets"><PanelWidgets panel={widgetsOnly} projectPath={projectPath} language={language} onAction={onAction} /></div>}
      </section>
      <div
        className="plugin-page-split-handle"
        role="separator"
        tabIndex={0}
        aria-orientation={layout === "right" ? "vertical" : "horizontal"}
        aria-valuemin={SPLIT_MIN}
        aria-valuemax={SPLIT_MAX}
        aria-valuenow={split}
        aria-label={tr(language, "调整页面与网页的分隔", "Resize the page and the web page", "Ajustar la división entre la página y la web")}
        onPointerDown={startDrag}
        onKeyDown={onKey}
        onDoubleClick={() => setSplit(SPLIT_DEFAULT)}
      />
      <section className="plugin-page-split-web" aria-label={panel.web}>
        <PluginWebFrame panel={panel} language={language} reloadKey={web.reloadKey} />
      </section>
    </div>
  </div>;
}
