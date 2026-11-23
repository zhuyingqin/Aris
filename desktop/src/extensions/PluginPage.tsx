// A plugin panel in the `nav.page` slot: a page of its own, opened from the
// navigation rail. Either the same declared panel the Chat sidebar draws, laid
// out in columns, or (a panel with a `page`) the package's own HTML in a
// sandboxed frame. Both show project data only: a button, a form or the page
// hands a prompt to Chat, where the work happens as an ordinary turn.
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

export default function PluginPage({ panel, projectPath, language, onAction }: {
  panel: ActiveUiPanel; projectPath: string; language: Language; onAction: (action: PluginPageAction) => void;
}) {
  const title = uiText(panel.title, language);
  const web = useWebPanelReload();
  const edit = <PluginEditButton panel={panel} language={language} onPrompt={(text) => onAction({ type: "prompt", text, send: false })} />;
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
    <PluginPageFrame panel={panel} projectPath={projectPath} language={language} onAction={onAction} />
  </div>;
  return <div className="plugin-page" aria-label={title}>
    <header className="plugin-page-head">
      <span className="plugin-page-icon" aria-hidden="true"><PluginPanelIcon panel={panel} size={18} /></span>
      <h1>{title}</h1>
      <span className="plugin-page-source" title={panel.pluginName}>{tr(language, "插件页面", "Plugin page", "Página del plugin")} · {panel.pluginName}</span>
      {edit}
    </header>
    <div className="plugin-page-body">
      <ChatPluginPanel
        key={`${projectPath}:${panel.pluginName}:${panel.id}:${panel.packageDigest}`}
        panel={panel} projectPath={projectPath} sessionId="" language={language} agentTodos={[]}
        onPrompt={(text, send) => onAction({ type: "prompt", text, send })}
        onOpenFile={(path) => onAction({ type: "open-file", path })}
      />
    </div>
  </div>;
}
