// Plugin glances in the Chat's project summary (the `chat.brief` slot). A
// glance is a small panel: host widgets drawn compactly, or the package's own
// page in a sandboxed frame that asks for its height. With `dataPanel` it
// shows and edits another panel's data, so a glance and the full page it
// summarizes are one store.
import { useCallback, useState } from "react";
import type { ActiveUiPanel } from "../api/plugins";
import { SvgIcon } from "../SvgIcon";
import type { Language } from "../store";
import { PanelBody } from "./ChatPluginPanel";
import PluginEditButton from "./PluginEditButton";
import PluginPageFrame from "./PluginPageFrame";
import { pluginPageIcon, requestPluginPage, uiPanelKey, uiText } from "./useChatPluginPanels";
import "./ChatBriefGlances.css";

const COPY = {
  cn: { open: "打开", openTitle: (title: string) => `打开“${title}”页面`, collapse: "收起", expand: "展开", region: "插件小组件" },
  en: { open: "Open", openTitle: (title: string) => `Open the ${title} page`, collapse: "Collapse", expand: "Expand", region: "Plugin glances" },
};
const FIRST_HEIGHT = 96;

function storageKey(projectPath: string) {
  return `somniq-brief-glances-v1:${projectPath}`;
}

/** Which glances the user folded, per project. */
function useFolded(projectPath: string) {
  const [folded, setFolded] = useState<string[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(storageKey(projectPath)) ?? "[]");
      return Array.isArray(saved) ? saved.filter((item): item is string => typeof item === "string") : [];
    } catch { return []; }
  });
  const toggle = useCallback((key: string) => setFolded((current) => {
    const next = current.includes(key) ? current.filter((item) => item !== key) : [...current, key];
    try { localStorage.setItem(storageKey(projectPath), JSON.stringify(next)); } catch { /* the in-memory state still works */ }
    return next;
  }), [projectPath]);
  return [folded, toggle] as const;
}

function GlancePage({ panel, store, projectPath, language, onPrompt, onOpenFile }: {
  panel: ActiveUiPanel; store?: ActiveUiPanel; projectPath: string; language: Language;
  onPrompt: (text: string, send: boolean) => void; onOpenFile: (path: string) => void;
}) {
  const [height, setHeight] = useState(FIRST_HEIGHT);
  return <div className="project-brief-glance-frame" style={{ height }}>
    <PluginPageFrame panel={panel} store={store} projectPath={projectPath} language={language} onResize={setHeight}
      onAction={(action) => action.type === "prompt" ? onPrompt(action.text, false)
        : action.type === "open-file" ? onOpenFile(action.path) : requestPluginPage(action.pluginName, action.panelId)} />
  </div>;
}

/** `panels`: the project's `chat.brief` panels; `all`: every panel, for the ones they share data with. */
export default function ChatBriefGlances({ panels, all, projectPath, language, onPrompt, onOpenFile }: {
  panels: ActiveUiPanel[]; all: ActiveUiPanel[]; projectPath: string; language: Language;
  onPrompt: (text: string, send: boolean) => void; onOpenFile: (path: string) => void;
}) {
  const copy = COPY[language];
  const [folded, toggle] = useFolded(projectPath);
  if (!panels.length) return null;
  return <div className="project-brief-glances" role="group" aria-label={copy.region}>
    {panels.map((panel) => {
      const key = uiPanelKey(panel);
      const store = panel.dataPanel ? all.find((other) => other.pluginName === panel.pluginName && other.id === panel.dataPanel) : undefined;
      // The panel it shows is part of the same package, so it is listed with it.
      if (panel.dataPanel && !store) return null;
      const title = uiText(panel.title, language);
      const page = store?.slot === "nav.page" ? store : undefined;
      const open = !folded.includes(key);
      return <section key={key} className={`project-brief-glance${open ? "" : " is-folded"}`} aria-label={title}>
        <header className="project-brief-glance-head">
          <button type="button" className="project-brief-glance-toggle" aria-expanded={open} title={open ? copy.collapse : copy.expand} onClick={() => toggle(key)}>
            <SvgIcon name={pluginPageIcon(page ?? panel)} size={13} />
            <span>{title}</span>
            <SvgIcon name={open ? "chevronDown" : "chevronRight"} size={11} />
          </button>
          <PluginEditButton panel={panel} language={language} compact onPrompt={(text) => onPrompt(text, false)} />
          {page && <button type="button" className="project-brief-glance-open" title={copy.openTitle(uiText(page.title, language))} onClick={() => requestPluginPage(page.pluginName, page.id)}>
            {copy.open}<SvgIcon name="chevronRight" size={11} />
          </button>}
        </header>
        {open && (panel.page
          ? <GlancePage key={JSON.stringify([projectPath, panel.packageDigest])} panel={panel} store={store} projectPath={projectPath} language={language} onPrompt={onPrompt} onOpenFile={onOpenFile} />
          : <PanelBody key={JSON.stringify([projectPath, panel.packageDigest])} panel={panel} projectPath={projectPath} sessionId="" language={language} agentTodos={[]} onPrompt={onPrompt} onOpenFile={onOpenFile} compact />)}
      </section>;
    })}
  </div>;
}
