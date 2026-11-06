import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { pluginsUiStateGet, pluginsUiStateUpdate, type ActiveUiPanel, type UiAction, type UiPanelState, type UiTodo } from "../api/plugins";
import { SvgIcon, type SvgIconName } from "../SvgIcon";
import type { Language } from "../store";
import type { ChatTodoItem } from "../types";
import { uiText } from "./useChatPluginPanels";
import "./ChatPluginPanel.css";

interface Props {
  panel: ActiveUiPanel;
  projectPath: string;
  sessionId: string;
  language: Language;
  agentTodos: ChatTodoItem[];
}

const COPY = {
  cn: {
    scope: "当前会话", local: "本地", loading: "正在读取面板…", retry: "重新加载", saving: "正在保存…",
    storage: "待办和笔记保存在此项目的当前会话中。",
    add: "添加待办", addLabel: "新待办", addPlaceholder: "添加下一步…", empty: "记下下一步，让研究继续。", remove: "删除",
    completed: "已完成", allDone: "待办已全部完成。", limit: "已达到 200 项上限，可先删除已完成的待办。",
    readOnly: "只读", planEmpty: "Agent 创建计划后，执行进度会显示在这里。",
    planStatus: { completed: "已完成", in_progress: "进行中", pending: "待处理" },
    notes: "记下线索、想法或待核对的问题…", save: "保存笔记", saved: "已保存", unsaved: "未保存",
    startSession: "发送第一条消息后，可以在这里添加待办和笔记，并随当前会话保存。",
  },
  en: {
    scope: "This conversation", local: "Local", loading: "Loading panel…", retry: "Reload", saving: "Saving…",
    storage: "Todos and notes are saved in this project for the current conversation.",
    add: "Add todo", addLabel: "New todo", addPlaceholder: "Add a next step…", empty: "Capture a next step to keep your research moving.", remove: "Delete",
    completed: "Completed", allDone: "All caught up.", limit: "200-item limit reached. Delete completed todos to make room.",
    readOnly: "Read only", planEmpty: "Execution progress appears here when the agent creates a plan.",
    planStatus: { completed: "Completed", in_progress: "In progress", pending: "Pending" },
    notes: "Capture a lead, an idea, or an open question…", save: "Save notes", saved: "Saved", unsaved: "Unsaved changes",
    startSession: "Send your first message to add todos and notes saved with this conversation.",
  },
};

type Mutate = (action: UiAction) => Promise<boolean>;

// Adapted from DeepSeek Harness TodoPanel / DisclosureRow at fcc0ad4 (MIT).
// Keep the compact icon/title/summary disclosure, with SomniQ tokens and a
// native button. Hidden bodies stay mounted so folding never discards a draft.
function WidgetSection({ title, icon, summary, preview, attention, children }: {
  title: string; icon: SvgIconName; summary?: string; preview?: string; attention?: boolean; children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const bodyId = useId();
  return <section className="chat-plugin-widget" aria-label={title}>
    <h3 className="chat-plugin-widget-heading">
      <button type="button" className="chat-plugin-disclosure" aria-label={title} aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((value) => !value)}>
        <SvgIcon name={icon} size={15} className="chat-plugin-widget-icon" />
        <span className="chat-plugin-widget-title">{title}</span>
        {summary && <span className={`chat-plugin-summary${attention ? " has-changes" : ""}`}>{summary}</span>}
        <SvgIcon name={open ? "chevronDown" : "chevronRight"} size={12} className="chat-plugin-chevron" />
      </button>
    </h3>
    {!open && preview && <p className="chat-plugin-plan-summary">{preview}</p>}
    <div id={bodyId} className="chat-plugin-widget-body" hidden={!open}>{children}</div>
  </section>;
}

function TodoWidget({ id, title, todos, disabled, mutate, language }: {
  id: string; title: string; todos: UiTodo[]; disabled: boolean; mutate: Mutate; language: Language;
}) {
  const [draft, setDraft] = useState("");
  const [showCompleted, setShowCompleted] = useState(false);
  const inputId = useId();
  const completedId = useId();
  const copy = COPY[language];
  const pending = todos.filter((item) => !item.completed);
  const completed = todos.filter((item) => item.completed);
  const renderTodo = (item: UiTodo) => <li key={item.id} className={item.completed ? "is-complete" : ""}>
    <label><input type="checkbox" checked={item.completed} disabled={disabled} onChange={(event) => void mutate({ type: "todoSetCompleted", widgetId: id, itemId: item.id, completed: event.target.checked })} /><span>{item.text}</span></label>
    <button type="button" className="chat-plugin-icon chat-plugin-remove" aria-label={`${copy.remove}: ${item.text}`} title={copy.remove} disabled={disabled} onClick={() => void mutate({ type: "todoRemove", widgetId: id, itemId: item.id })}><SvgIcon name="trash" size={13} /></button>
  </li>;
  return <WidgetSection title={title} icon="list" summary={todos.length ? `${completed.length} / ${todos.length}` : undefined}>
    {todos.length > 0 && <div className="chat-plugin-progress" role="progressbar" aria-label={title} aria-valuemin={0} aria-valuemax={todos.length} aria-valuenow={completed.length} aria-valuetext={`${completed.length} / ${todos.length} ${copy.completed}`}><span style={{ width: `${completed.length / todos.length * 100}%` }} /></div>}
    <div className="chat-plugin-task-scroll">
      {pending.length > 0 && <ul className="chat-plugin-todos">{pending.map(renderTodo)}</ul>}
      {todos.length === 0 && <p className="chat-plugin-empty">{copy.empty}</p>}
      {todos.length > 0 && pending.length === 0 && <p className="chat-plugin-caught-up"><SvgIcon name="check" size={14} />{copy.allDone}</p>}
      {completed.length > 0 && <>
        <button type="button" className="chat-plugin-completed-toggle" aria-expanded={showCompleted} aria-controls={completedId} onClick={() => setShowCompleted((value) => !value)}>
          <SvgIcon name={showCompleted ? "chevronDown" : "chevronRight"} size={11} /><span>{copy.completed}</span><span className="chat-plugin-count">{completed.length}</span>
        </button>
        <ul id={completedId} className="chat-plugin-todos chat-plugin-completed" hidden={!showCompleted}>{completed.map(renderTodo)}</ul>
      </>}
    </div>
    <form className="chat-plugin-add" onSubmit={(event) => {
      event.preventDefault();
      if (draft.trim() && !disabled) void mutate({ type: "todoAdd", widgetId: id, text: draft }).then((saved) => { if (saved) setDraft(""); });
    }}>
      <label className="chat-plugin-input-label" htmlFor={inputId}>{copy.addLabel}</label>
      <input id={inputId} value={draft} maxLength={500} disabled={disabled || todos.length >= 200} placeholder={copy.addPlaceholder} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }} />
      <button type="submit" className="chat-plugin-icon" disabled={disabled || !draft.trim() || todos.length >= 200} aria-label={copy.add}><SvgIcon name="plus" size={15} /></button>
    </form>
    {todos.length >= 200 && <p className="chat-plugin-caption">{copy.limit}</p>}
  </WidgetSection>;
}

function NotesWidget({ id, title, saved, disabled, mutate, language }: {
  id: string; title: string; saved: string; disabled: boolean; mutate: Mutate; language: Language;
}) {
  const [draft, setDraft] = useState(saved);
  const [dirty, setDirty] = useState(false);
  const inputId = useId();
  const copy = COPY[language];
  useEffect(() => { if (!dirty) setDraft(saved); }, [saved, dirty]);
  const save = () => { if (!disabled && dirty) void mutate({ type: "notesSet", widgetId: id, text: draft }).then((ok) => { if (ok) setDirty(false); }); };
  return <WidgetSection title={title} icon="notebook" summary={dirty ? copy.unsaved : copy.saved} attention={dirty}>
    <label className="chat-plugin-input-label" htmlFor={inputId}>{title}</label>
    <textarea id={inputId} value={draft} maxLength={32000} disabled={disabled} rows={3} placeholder={copy.notes} onChange={(event) => { setDraft(event.target.value); setDirty(true); }} onKeyDown={(event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); save(); }
    }} />
    <div className="chat-plugin-note-actions"><span className="chat-plugin-caption"><SvgIcon name="messageCircle" size={11} />{copy.scope}</span>
      <button type="button" className="chat-plugin-button" disabled={disabled || !dirty} title={`${copy.save} (Ctrl / ⌘ + Enter)`} onClick={save}><SvgIcon name="check" size={12} />{copy.save}</button>
    </div>
  </WidgetSection>;
}

// DeepSeek TodoPanel.progressLabel: omit zero-count segments and count every
// active item. SomniQ reads its existing plan; this view never writes to it.
function AgentPlanWidget({ title, todos, language }: { title: string; todos: ChatTodoItem[]; language: Language }) {
  const copy = COPY[language];
  const statuses = ["completed", "in_progress", "pending"] as const;
  const progress = statuses.flatMap((status) => {
    const count = todos.filter((item) => item.status === status).length;
    return count > 0 ? [`${count} ${copy.planStatus[status]}`] : [];
  }).join(" · ");
  return <WidgetSection title={title} icon="target" summary={copy.readOnly} preview={progress}>
    {todos.length === 0 ? <p className="chat-plugin-empty">{copy.planEmpty}</p> : <>
      <p className="chat-plugin-plan-summary">{progress}</p>
      <ol className="chat-plugin-agent-plan">{todos.map((item, index) => <li key={index} data-status={item.status}>
        <span className="chat-plugin-plan-indicator" role="img" aria-label={copy.planStatus[item.status]}>{item.status === "completed" ? <SvgIcon name="check" size={11} /> : item.status === "in_progress" ? <SvgIcon name="clock" size={11} /> : index + 1}</span>
        <span>{item.status === "in_progress" ? item.activeForm || item.content : item.content}</span>
      </li>)}</ol>
    </>}
  </WidgetSection>;
}

function PanelBody({ panel, projectPath, sessionId, language, agentTodos }: Props) {
  const copy = COPY[language];
  const [state, setState] = useState<UiPanelState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const writing = useRef(false);
  const reload = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true); setError("");
    try {
      const next = await pluginsUiStateGet(projectPath, panel.pluginName, panel.id, sessionId);
      if (request === generation.current) setState(next);
    } catch (failure) { if (request === generation.current) setError(String(failure)); }
    finally { if (request === generation.current) setLoading(false); }
  }, [projectPath, panel.pluginName, panel.id, sessionId]);

  useEffect(() => { void reload(); return () => { ++generation.current; }; }, [reload]);
  const mutate: Mutate = async (action) => {
    if (!state || writing.current || loading || error) return false;
    writing.current = true;
    const request = generation.current;
    setSaving(true); setError("");
    try {
      const next = await pluginsUiStateUpdate(projectPath, panel.pluginName, panel.id, sessionId, state.revision, action);
      if (request !== generation.current) return false;
      setState(next);
      return true;
    } catch (failure) {
      if (request === generation.current) setError(String(failure));
      return false;
    } finally {
      writing.current = false;
      if (request === generation.current) setSaving(false);
    }
  };
  const disabled = loading || saving || Boolean(error) || !state;
  return <div className="chat-plugin-panel" aria-label={uiText(panel.title, language)} aria-busy={loading || saving}>
    <header className="chat-plugin-panel-header"><span className="chat-plugin-panel-mark" aria-hidden="true"><SvgIcon name="grid" size={17} /></span><div><h2>{uiText(panel.title, language)}</h2><span className="chat-plugin-caption">{copy.scope}</span></div><span className="chat-plugin-local" title={copy.storage}>{copy.local}</span></header>
    <div className="chat-plugin-panel-content">
    {error && <div className="chat-plugin-error" role="alert"><p>{error}</p><button type="button" className="chat-plugin-button" onClick={() => void reload()} disabled={saving || loading}>{copy.retry}</button></div>}
    {loading && <p className="chat-plugin-empty" role="status">{copy.loading}</p>}
    {panel.widgets.map((widget) => {
      if (widget.type === "text") return <p className="chat-plugin-text" key={widget.id}>{uiText(widget.text, language)}</p>;
      const title = uiText(widget.title, language);
      if (widget.type === "agent-plan") return <AgentPlanWidget key={widget.id} title={title} todos={agentTodos} language={language} />;
      // Keep drafts mounted across a failed save/reload. Scope changes remount
      // the whole body, so delayed responses cannot touch another session.
      if (!state) return null;
      return widget.type === "todo-list"
        ? <TodoWidget key={widget.id} id={widget.id} title={title} todos={state.todoLists[widget.id] ?? []} disabled={disabled} mutate={mutate} language={language} />
        : <NotesWidget key={widget.id} id={widget.id} title={title} saved={state.notes[widget.id] ?? ""} disabled={disabled} mutate={mutate} language={language} />;
    })}
    <footer className="chat-plugin-panel-footer"><span className="chat-plugin-source" title={panel.pluginName}><SvgIcon name="grid" size={11} />{panel.pluginName}</span><span role="status">{saving ? copy.saving : ""}</span></footer>
    </div>
  </div>;
}

export default function ChatPluginPanel(props: Props) {
  // The shared home draft is not a durable conversation. Never store personal
  // data under it: its id changes when the user sends their first message.
  if (!props.sessionId || props.sessionId === "chat-home") return <div className="chat-plugin-panel">
    <header className="chat-plugin-panel-header"><h2>{uiText(props.panel.title, props.language)}</h2></header>
    <p className="chat-plugin-empty">{COPY[props.language].startSession}</p>
  </div>;
  return <PanelBody key={JSON.stringify([props.projectPath, props.sessionId, props.panel.pluginName, props.panel.id, props.panel.packageDigest])} {...props} />;
}
