// A plugin panel in the `nav.page` slot: a page of its own, opened from the
// navigation rail. Either the same declared panel the Chat sidebar draws, laid
// out in columns, or (a panel with a `page`) the package's own HTML in a
// sandboxed frame. Both show project data only: a button, a form or the page
// hands a prompt to Chat, where the work happens as an ordinary turn.
import type { ActiveUiPanel } from "../api/plugins";
import { SvgIcon } from "../SvgIcon";
import type { Language } from "../store";
import ChatPluginPanel from "./ChatPluginPanel";
import PluginEditButton from "./PluginEditButton";
import PluginPageFrame from "./PluginPageFrame";
import { pluginPageIcon, uiText, type PluginPageAction } from "./useChatPluginPanels";
import "./PluginPage.css";

export default function PluginPage({ panel, projectPath, language, onAction }: {
  panel: ActiveUiPanel; projectPath: string; language: Language; onAction: (action: PluginPageAction) => void;
}) {
  const title = uiText(panel.title, language);
  const edit = <PluginEditButton panel={panel} language={language} onPrompt={(text) => onAction({ type: "prompt", text, send: false })} />;
  // The host's header stays above a page that draws itself, so the user can
  // always tell which package is on screen.
  if (panel.page) return <div className="plugin-page plugin-page-own" aria-label={title}>
    <header className="plugin-page-head">
      <span className="plugin-page-icon" aria-hidden="true"><SvgIcon name={pluginPageIcon(panel)} size={16} /></span>
      <h1>{title}</h1>
      <span className="plugin-page-source" title={panel.pluginName}>{language === "cn" ? "插件页面" : "Plugin page"} · {panel.pluginName}</span>
      {edit}
    </header>
    <PluginPageFrame panel={panel} projectPath={projectPath} language={language} onAction={onAction} />
  </div>;
  return <div className="plugin-page" aria-label={title}>
    <header className="plugin-page-head">
      <span className="plugin-page-icon" aria-hidden="true"><SvgIcon name={pluginPageIcon(panel)} size={18} /></span>
      <h1>{title}</h1>
      <span className="plugin-page-source" title={panel.pluginName}>{language === "cn" ? "插件页面" : "Plugin page"} · {panel.pluginName}</span>
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
