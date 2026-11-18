// A plugin page that draws itself: the package's HTML in a sandboxed frame,
// and the only bridge it has to the app. The page can read and write its own
// panel's data, ask for a prompt to be put in the composer, and ask for a
// project file to be opened. Everything else stays on this side.
import { useCallback, useEffect, useRef, useState } from "react";
import { PLUGIN_PANEL_CHANGED_EVENT, pluginsDraftPage, pluginsUiPage, pluginsUiStateGet, pluginsUiStateUpdate, samePluginProject, type ActiveUiPanel, type PluginPanelChange, type UiPanel, type UiPanelState } from "../api/plugins";
import type { Language } from "../store";
import { hasNativeBackend } from "../api/transport";
import { onWorkTaskChanged, workTaskList } from "../api/tauri";
import { pluginTaskRecords, type PluginTaskRecord } from "./pluginTaskRecords";
import { PLUGIN_PAGE_SANDBOX, pluginPageDocument, type PluginPageTheme } from "./pluginPageDocument";
import PluginTaskProposal, { MAX_TASK_PROMPT_CHARS, MAX_TASK_TITLE_CHARS, type TaskOutcome, type TaskProposal } from "./PluginTaskProposal";
import { pluginTextLanguage, uiText, type PluginPageAction } from "./useChatPluginPanels";

const COPY = {
  cn: { loading: "正在打开页面…", retry: "重新加载", isolation: "无法隔离这个页面，已停止运行它。" },
  en: { loading: "Opening page…", retry: "Reload", isolation: "This page could not be isolated, so it was not run." },
  es: { loading: "Abriendo página…", retry: "Recargar", isolation: "No se pudo aislar esta página, así que no se ejecutó." },
};
const MAX_PROMPT_CHARS = 4000;
const MAX_PATH_CHARS = 1024;
const THEME_TOKENS = { bg: "--bg-1", surface: "--bg-2", raised: "--bg-3", border: "--border", text: "--text", muted: "--text-dim", accent: "--accent" };

function readTheme(): PluginPageTheme {
  const root = window.document.documentElement;
  const style = getComputedStyle(root);
  return {
    mode: root.dataset.theme === "light" ? "light" : "dark",
    colors: Object.fromEntries(Object.entries(THEME_TOKENS).map(([name, token]) => [name, style.getPropertyValue(token).trim()])),
    font: style.getPropertyValue("--font-sans").trim(),
  };
}

/** Every declared widget's value by id, whichever store the host keeps it in. */
function pageData(panel: Pick<UiPanel, "widgets">, state: UiPanelState): Record<string, unknown> {
  return Object.fromEntries(panel.widgets.map((widget) => [widget.id,
    widget.type === "todo-list" ? state.todoLists[widget.id] ?? [] : widget.type === "notes" ? state.notes[widget.id] ?? "" : state.data?.[widget.id] ?? null]));
}

const PANEL_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** The heights a glance in the project summary may ask for. */
export const GLANCE_HEIGHT = { min: 40, max: 320 };

const EMPTY_STATE: UiPanelState = { revision: 0, todoLists: {}, notes: {}, data: {} };

export default function PluginPageFrame({ panel, store, projectPath, language, onAction, onResize, sessionId = "", draft }: {
  panel: ActiveUiPanel; projectPath: string; language: Language; onAction: (action: PluginPageAction) => void;
  /** The panel whose data the page reads and writes (its `dataPanel`); the panel itself by default. */
  store?: ActiveUiPanel;
  /** The page asked for a height; only a frame sized by its page passes this. */
  onResize?: (height: number) => void;
  /** The conversation a session-scoped panel belongs to; "" for a project panel. */
  sessionId?: string;
  /** Try a draft before approving it: the page comes from the draft (checked
   *  against the digest the card shows), starts from the project's real data,
   *  and keeps every change in memory. Nothing is saved and no action runs. */
  draft?: { source: string; digest: string };
}) {
  const copy = COPY[language];
  const shell = useRef<HTMLIFrameElement>(null);
  const channel = useRef("");
  const state = useRef<UiPanelState | null>(null);
  // One write at a time: each needs the revision the one before it produced.
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const act = useRef(onAction); act.current = onAction;
  const resize = useRef(onResize); resize.current = onResize;
  // The panel list is re-read on every window focus; only a new package
  // version (its digest) is a reason to load the page again.
  const declared = useRef<Pick<UiPanel, "widgets">>(store ?? panel); declared.current = store ?? panel;
  // A draft's own declarations, and what trying it has written so far.
  const drafted = useRef<{ shape: Pick<UiPanel, "widgets">; storeId: string } | null>(null);
  const tried = useRef<Record<string, unknown> | null>(null);
  const shape = () => drafted.current?.shape ?? declared.current;
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  // A task the page proposed, waiting for the user; the page's call waits with it.
  const [proposal, setProposal] = useState<TaskProposal | null>(null);
  const asking = useRef<((outcome: TaskOutcome) => void) | null>(null);
  const policy = useRef({ proposeTasks: false, title: "", projectScope: false });
  policy.current = { proposeTasks: panel.proposeTasks === true, title: uiText(panel.title, language), projectScope: (store ?? panel).scope === "project" };
  const { pluginName, id: pageId } = panel;
  // The data lives with the store panel; the page's files with this one.
  const panelId = store?.id ?? pageId;

  const load = useCallback(async () => {
    if (draft) {
      if (tried.current) return tried.current;
      // The installed version may not have this panel yet: start empty then.
      const real = await pluginsUiStateGet(projectPath, pluginName, drafted.current?.storeId ?? panelId, sessionId).catch(() => EMPTY_STATE);
      tried.current = pageData(shape(), real);
      return tried.current;
    }
    state.current = await pluginsUiStateGet(projectPath, pluginName, panelId, sessionId);
    return pageData(shape(), state.current);
    // `draft` is fixed for a mounted frame, so it is not a dependency.
  }, [projectPath, pluginName, panelId, sessionId]);
  /** The page's window: the one frame inside the shell. Never the shell, which runs nothing. */
  const page = useCallback((): Window | null => {
    try { return (shell.current?.contentWindow as (Window & Record<number, Window>) | null | undefined)?.[0] ?? null; } catch { return null; }
  }, []);
  const send = useCallback((message: Record<string, unknown>) => {
    page()?.postMessage({ ...message, channel: channel.current }, "*");
  }, [page]);

  useEffect(() => {
    let live = true;
    channel.current = crypto.randomUUID();
    setSource(null); setError("");
    const opened = draft
      ? pluginsDraftPage(projectPath, draft.source, draft.digest, pageId).then(async (found) => {
        drafted.current = { shape: found.store ?? found.panel, storeId: found.store?.id ?? found.panel.id };
        tried.current = null;
        return [found.page, await load()] as const;
      })
      : Promise.all([pluginsUiPage(projectPath, pluginName, pageId), load()]);
    opened.then(([file, data]) => {
      if (live) setSource(pluginPageDocument(file, channel.current, { language: pluginTextLanguage(language), locale: language, theme: readTheme(), data }));
    }).catch((failure) => { if (live) setError(String(failure)); });
    return () => { live = false; };
    // `panel.packageDigest`: an upgraded package is a different page.
  }, [projectPath, pluginName, pageId, panel.packageDigest, language, load, attempt]);

  useEffect(() => {
    const write = async (widgetId: unknown, value: unknown) => {
      const widget = shape().widgets.find((item) => item.id === widgetId);
      if (!widget) throw new Error(`This panel declares no widget "${String(widgetId)}"`);
      if (draft) {
        tried.current = { ...(tried.current ?? {}), [widget.id]: value };
        return tried.current;
      }
      // A list is read with the ids the host gave its items and written without them.
      const next = widget.type === "todo-list" && Array.isArray(value)
        ? value.map((item) => ({ text: (item as { text?: unknown })?.text, completed: Boolean((item as { completed?: unknown })?.completed) })) : value;
      for (let tries = 0; ; tries++) {
        if (!state.current) await load();
        try {
          state.current = await pluginsUiStateUpdate(projectPath, pluginName, panelId, sessionId, state.current!.revision, { type: "widgetSet", widgetId: widget.id, value: next });
          // Other views of the same data (a glance, the full page) pick it up.
          window.dispatchEvent(new CustomEvent<PluginPanelChange>(PLUGIN_PANEL_CHANGED_EVENT, { detail: { projectPath, pluginName, panelId, origin: channel.current } }));
          return pageData(shape(), state.current);
        } catch (failure) {
          // The agent wrote in between: take its revision and try once more.
          if (tries > 0 || !/reload before saving/i.test(String(failure))) throw failure;
          state.current = null;
        }
      }
    };
    /**
     * The page asks for a background task. Only a panel that declared
     * `proposeTasks` may ask, one proposal at a time, and the answer is the
     * user's: the call resolves when they decide. A draft being tried is
     * always declined, without showing anything.
     */
    const propose = (args: { title?: unknown; prompt?: unknown; reportTo?: unknown } | undefined): Promise<TaskOutcome> => {
      if (draft) return Promise.resolve({ status: "declined" });
      const { proposeTasks, title: panelTitle, projectScope } = policy.current;
      if (!proposeTasks) return Promise.reject(new Error('This panel does not declare "proposeTasks": true'));
      if (!hasNativeBackend()) return Promise.reject(new Error("Background tasks need the SomniQ desktop app"));
      if (asking.current) return Promise.reject(new Error("A task proposal is already waiting for the user"));
      const title = typeof args?.title === "string" ? args.title.trim() : "";
      const prompt = typeof args?.prompt === "string" ? args.prompt.trim() : "";
      if (!title || title.length > MAX_TASK_TITLE_CHARS) return Promise.reject(new Error(`A task title must contain 1..${MAX_TASK_TITLE_CHARS} characters`));
      if (!prompt || prompt.length > MAX_TASK_PROMPT_CHARS) return Promise.reject(new Error(`A task prompt must contain 1..${MAX_TASK_PROMPT_CHARS} characters`));
      let report: TaskProposal["report"];
      if (args?.reportTo != null) {
        const widget = shape().widgets.find((item) => item.id === args.reportTo);
        if (!widget) return Promise.reject(new Error(`reportTo: this panel declares no widget "${String(args.reportTo)}"`));
        // A task runs in a session of its own, so only project data is one it can reach.
        if (!projectScope) return Promise.reject(new Error('reportTo needs a panel with "scope": "project"'));
        report = { panelId, widgetId: widget.id, widgetType: widget.type };
      }
      return new Promise((resolve) => {
        asking.current = resolve;
        setProposal({ pluginName, pageId, panelTitle, title, prompt, report });
      });
    };
    // A draft being tried, or a page outside the desktop app, has no board.
    const hasBoard = !draft && hasNativeBackend();
    // Only a page that may propose tasks is told about them unasked.
    const followsTasks = () => hasBoard && policy.current.proposeTasks;
    /** The tasks this page proposed, as the board has them. */
    const tasks = async (): Promise<PluginTaskRecord[]> => {
      if (!hasBoard) return [];
      return pluginTaskRecords(await workTaskList(), pluginName, pageId);
    };
    const receive = (event: MessageEvent) => {
      const from = page();
      const message = event.data as { channel?: unknown; type?: unknown; id?: unknown; method?: unknown; args?: { widget?: unknown; value?: unknown }; text?: unknown; path?: unknown; panel?: unknown; height?: unknown } | null;
      if (!from || event.source !== from || !message || typeof message !== "object" || message.channel !== channel.current) return;
      if (message.type === "error") { setSource(null); setError(copy.isolation); return; }
      if (message.type === "resize" && typeof message.height === "number" && Number.isFinite(message.height)) resize.current?.(Math.round(Math.min(GLANCE_HEIGHT.max, Math.max(GLANCE_HEIGHT.min, message.height))));
      // A draft being tried acts on nothing; it only draws and keeps its data in memory.
      if (draft && message.type !== "call") return;
      // The page asks; the user sends. A page never sends a message by itself.
      if (message.type === "prompt" && typeof message.text === "string" && message.text.trim() && message.text.length <= MAX_PROMPT_CHARS) act.current({ type: "prompt", text: message.text, send: false });
      if (message.type === "open-file" && typeof message.path === "string" && message.path && message.path.length <= MAX_PATH_CHARS) act.current({ type: "open-file", path: message.path });
      // A panel of this same package only; the app opens it only if it is a page of the rail.
      if (message.type === "open-panel" && typeof message.panel === "string" && PANEL_ID.test(message.panel)) act.current({ type: "open-panel", pluginName, panelId: message.panel });
      if (message.type !== "call" || typeof message.id !== "number") return;
      const { id, method, args } = message;
      const work = method === "data" ? load() : method === "set" ? (writes.current = writes.current.catch(() => undefined).then(() => write(args?.widget, args?.value)))
        : method === "task" ? propose(args as { title?: unknown; prompt?: unknown; reportTo?: unknown } | undefined).then((outcome) => { if (outcome.status !== "declined") void pushTasks(); return outcome; })
        : method === "tasks" ? tasks() : Promise.reject(new Error(`Unknown call: ${String(method)}`));
      const mine = channel.current;
      void (work as Promise<unknown>).then(
        (value) => { if (mine === channel.current) send({ type: "result", id, ok: true, value }); },
        (failure) => { if (mine === channel.current) send({ type: "result", id, ok: false, error: failure instanceof Error ? failure.message : String(failure) }); },
      );
    };
    // The agent's writes reach the page as they happen.
    const changed = (event: Event) => {
      const change = (event as CustomEvent<PluginPanelChange>).detail;
      if (draft) return;
      if (change?.pluginName !== pluginName || change.panelId !== panelId || !samePluginProject(change.projectPath, projectPath) || change.origin === channel.current) return;
      const mine = channel.current;
      void load().then((data) => { if (mine === channel.current) send({ type: "data", data }); }, () => undefined);
    };
    // A proposed task's progress reaches the page as the board records it.
    // Only what changed is sent, and only to a page that can propose tasks.
    let sentTasks = "";
    let live = true;
    const pushTasks = async () => {
      if (!followsTasks()) return;
      const mine = channel.current;
      const records = await tasks().catch(() => null);
      if (!live || !records || mine !== channel.current) return;
      const text = JSON.stringify(records);
      if (text === sentTasks) return;
      sentTasks = text;
      send({ type: "tasks", tasks: records });
    };
    const unlisten = followsTasks()
      ? onWorkTaskChanged(() => { void pushTasks(); }).catch(() => () => undefined)
      : null;
    window.addEventListener("message", receive);
    window.addEventListener(PLUGIN_PANEL_CHANGED_EVENT, changed);
    return () => {
      live = false;
      void unlisten?.then((stop) => stop());
      window.removeEventListener("message", receive);
      window.removeEventListener(PLUGIN_PANEL_CHANGED_EVENT, changed);
      // The page that asked is going away: its proposal goes with it.
      asking.current?.({ status: "declined" });
      asking.current = null;
      setProposal(null);
    };
  }, [projectPath, pluginName, panelId, sessionId, load, page, send, copy.isolation]);

  useEffect(() => {
    if (!source) return;
    const observer = new MutationObserver(() => send({ type: "theme", theme: readTheme() }));
    observer.observe(window.document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-ui-color", "data-custom-accent", "data-surface", "data-ui-font", "style"] });
    return () => observer.disconnect();
  }, [source, send]);

  if (error) return <div className="plugin-page-frame-status chat-plugin-error" role="alert"><p>{error}</p><button type="button" className="chat-plugin-button" onClick={() => setAttempt((value) => value + 1)}>{copy.retry}</button></div>;
  if (!source) return <p className="plugin-page-frame-status chat-plugin-empty" role="status">{copy.loading}</p>;
  // No `allow-same-origin`: the shell and the page inside it have no origin,
  // no storage and no way to reach this document.
  const decided = (outcome: TaskOutcome) => {
    asking.current?.(outcome);
    asking.current = null;
    setProposal(null);
  };
  return <>
    <iframe ref={shell} className="plugin-page-frame" title={uiText(panel.title, language)} sandbox={PLUGIN_PAGE_SANDBOX} referrerPolicy="no-referrer" srcDoc={source} />
    {proposal && <PluginTaskProposal proposal={proposal} language={language} onDone={decided} />}
  </>;
}
