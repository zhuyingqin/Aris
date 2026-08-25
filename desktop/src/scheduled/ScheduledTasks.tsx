import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  chatModelOptions,
  chatUiSessionsList,
  isTauri,
  mailAccountsGet,
  scheduledTaskCreate,
  scheduledTaskDelete,
  scheduledTasksList,
  scheduledTaskSetStatus,
  scheduledTaskUpdate,
  sessionsList,
} from "../api/tauri";
import type { ChatSession } from "../chat/types";
import { useStore } from "../store";
import { SvgIcon } from "../SvgIcon";
import type {
  ChatModelOption,
  MailAccount,
  ScheduledTask,
  ScheduledTaskInput,
  SessionSummary,
} from "../types";
import { SCHEDULED_TASKS_COPY, type TaskTemplate } from "./i18n";

type ScheduledTasksCopy = (typeof SCHEDULED_TASKS_COPY)["cn"];

type IntervalUnit = ScheduledTaskInput["intervalUnit"];
type TaskStatus = NonNullable<ScheduledTaskInput["status"]>;
type TriggerKind = NonNullable<ScheduledTaskInput["triggerKind"]>;
type Pane = "tasks" | "templates";
type FilterTab = "all" | "active" | "paused";

interface SessionOption {
  id: string;
  title: string;
  updatedAt: number;
  model?: string | null;
}

interface FormState {
  title: string;
  prompt: string;
  sessionId: string;
  model: string;
  intervalValue: number;
  intervalUnit: IntervalUnit;
  status: TaskStatus;
  triggerKind: TriggerKind;
  mailAccountId: string;
  mailKeywords: string;
}

const DEFAULT_INTERVAL = 15;

const PRESET_INTERVALS: Array<{ value: number; unit: IntervalUnit; label: string }> = [
  { value: 15, unit: "minutes", label: "15 分钟" },
  { value: 30, unit: "minutes", label: "30 分钟" },
  { value: 1, unit: "hours", label: "1 小时" },
  { value: 6, unit: "hours", label: "6 小时" },
  { value: 1, unit: "days", label: "1 天" },
];

const PRESET_KEYWORDS = [
  "文献求助",
  "论文求助",
  "paper request",
  "literature request",
  "PDF",
];

function formatTaskTime(value: string | null | undefined, copy: ScheduledTasksCopy) {
  if (!value) return copy.noValue;
  const numeric = Number(value);
  const date = Number.isFinite(numeric) ? new Date(numeric) : new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function runSummary(task: ScheduledTask, copy: ScheduledTasksCopy) {
  if (taskStatus(task) === "paused") return copy.paused;
  if (task.lastError) return copy.lastRunFailed;
  if (task.triggerKind === "mail") {
    return task.lastRunAt ? copy.lastRunAt(formatTaskTime(task.lastRunAt, copy)) : copy.waitingForMail;
  }
  if (task.nextRun) return copy.nextRunAt(formatTaskTime(task.nextRun, copy));
  if (task.lastRunAt) return copy.lastRunAt(formatTaskTime(task.lastRunAt, copy));
  return copy.waitingFirstRun;
}

function triggerMeta(
  task: ScheduledTask | FormState,
  copy: ScheduledTasksCopy,
): { kind: "interval" | "mail"; label: string; icon: "clock" | "inbox" } {
  return task.triggerKind === "mail"
    ? { kind: "mail", label: copy.mailTrigger, icon: "inbox" }
    : { kind: "interval", label: copy.intervalTrigger, icon: "clock" };
}

function shortId(id: string) {
  return id.length > 18 ? `${id.slice(0, 18)}...` : id;
}

function isIntervalUnit(value: string | undefined): value is IntervalUnit {
  return value === "minutes" || value === "hours" || value === "days";
}

function isTriggerKind(value: string | undefined): value is TriggerKind {
  return value === "interval" || value === "mail";
}

function taskStatus(task: ScheduledTask): TaskStatus {
  return task.status === "paused" ? "paused" : "active";
}

function emptyForm(sessionId = ""): FormState {
  return {
    title: "",
    prompt: "",
    sessionId,
    model: "",
    intervalValue: DEFAULT_INTERVAL,
    intervalUnit: "minutes",
    status: "active",
    triggerKind: "interval",
    mailAccountId: "",
    mailKeywords: "",
  };
}

function taskToForm(task: ScheduledTask, fallbackSessionId = ""): FormState {
  return {
    title: task.title ?? "",
    prompt: task.prompt ?? "",
    sessionId: task.sessionId ?? fallbackSessionId,
    model: task.model ?? "",
    intervalValue: task.intervalValue && task.intervalValue > 0
      ? task.intervalValue
      : DEFAULT_INTERVAL,
    intervalUnit: isIntervalUnit(task.intervalUnit) ? task.intervalUnit : "minutes",
    status: taskStatus(task),
    triggerKind: isTriggerKind(task.triggerKind) ? task.triggerKind : "interval",
    mailAccountId: task.mailAccountId ?? "",
    mailKeywords: (task.mailKeywords ?? []).join(", "),
  };
}

function templateToForm(template: TaskTemplate, fallbackSessionId = ""): FormState {
  return {
    ...emptyForm(fallbackSessionId),
    title: template.title,
    prompt: template.prompt,
    triggerKind: template.triggerKind,
    intervalValue: template.intervalValue,
    intervalUnit: template.intervalUnit,
    mailKeywords: template.mailKeywords ?? "",
  };
}

function parseKeywords(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,，\n]/)) {
    const value = part.trim();
    if (value && !seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

function formToInput(form: FormState): ScheduledTaskInput {
  return {
    title: form.title.trim(),
    prompt: form.prompt.trim(),
    sessionId: form.sessionId,
    model: form.model.trim(),
    intervalValue: Math.max(1, Math.floor(form.intervalValue || 1)),
    intervalUnit: form.intervalUnit,
    status: form.status,
    triggerKind: form.triggerKind,
    mailAccountId: form.triggerKind === "mail" ? form.mailAccountId.trim() : "",
    mailKeywords: form.triggerKind === "mail" ? parseKeywords(form.mailKeywords) : [],
  };
}

function addOrReplaceTask(tasks: ScheduledTask[], task: ScheduledTask) {
  return [task, ...tasks.filter((item) => item.id !== task.id)];
}

function optionFromChatSession(session: ChatSession, copy: ScheduledTasksCopy): SessionOption {
  return {
    id: session.id,
    title: session.title || copy.sessionFallbackTitle(shortId(session.id)),
    updatedAt: session.updatedAt ?? 0,
    model: session.model ?? null,
  };
}

function optionFromRuntimeSession(session: SessionSummary, copy: ScheduledTasksCopy): SessionOption {
  return {
    id: session.id,
    title: copy.sessionFallbackTitle(shortId(session.id)),
    updatedAt: session.modifiedEpochSecs * 1000,
  };
}

async function loadSessionOptions(
  copy: ScheduledTasksCopy,
  projectId?: string | null,
): Promise<SessionOption[]> {
  const byId = new Map<string, SessionOption>();
  const uiSessions = await chatUiSessionsList<ChatSession>().catch(() => []);
  for (const session of uiSessions) {
    if (projectId && session.projectId && session.projectId !== projectId) continue;
    byId.set(session.id, optionFromChatSession(session, copy));
  }
  if (byId.size === 0) {
    const runtimeSessions = await sessionsList().catch(() => []);
    for (const session of runtimeSessions) byId.set(session.id, optionFromRuntimeSession(session, copy));
  }
  return [...byId.values()].sort((left, right) => right.updatedAt - left.updatedAt);
}

function sessionTitle(sessionId: string | null | undefined, sessions: SessionOption[], copy: ScheduledTasksCopy) {
  if (!sessionId) return copy.unboundSession;
  return sessions.find((session) => session.id === sessionId)?.title ?? copy.sessionFallbackTitle(shortId(sessionId));
}

function modelLabel(model: string | null | undefined, copy: ScheduledTasksCopy) {
  return model?.trim() || copy.followCurrentModel;
}

function intervalLabel(value: number, unit: IntervalUnit, copy: ScheduledTasksCopy) {
  return copy.everyInterval(Math.max(1, Math.floor(value || 1)), copy.unitLabels[unit]);
}

function DetailCard({
  title,
  icon,
  children,
  badge,
}: {
  title: string;
  icon?: "clock" | "inbox" | "sparkle" | "target" | "document" | "lightning";
  children: ReactNode;
  badge?: ReactNode;
}) {
  return (
    <div className="sched-card">
      <div className="sched-card-head">
        <div className="sched-card-title">
          {icon && <span className="sched-card-icon"><SvgIcon name={icon} size={15} /></span>}
          <span>{title}</span>
        </div>
        {badge && <div className="sched-card-badge">{badge}</div>}
      </div>
      <div className="sched-card-body">{children}</div>
    </div>
  );
}

function DetailRow({
  label,
  children,
  info,
}: {
  label: string;
  children: ReactNode;
  info?: string;
}) {
  return (
    <div className="sched-detail-row">
      <div className="sched-detail-label">
        <span>{label}</span>
        {info && <span className="sched-info" title={info}><SvgIcon name="info" size={12} /></span>}
      </div>
      <div className="sched-detail-control">{children}</div>
    </div>
  );
}

function TaskRow({
  active,
  task,
  sessionName,
  copy,
  onSelect,
  onStatus,
  onOpenChat,
}: {
  active: boolean;
  task: ScheduledTask;
  sessionName: string;
  copy: ScheduledTasksCopy;
  onSelect: () => void;
  onStatus: (status: TaskStatus) => void;
  onOpenChat: () => void;
}) {
  const paused = taskStatus(task) === "paused";
  const meta = triggerMeta(task, copy);
  const isMail = task.triggerKind === "mail";
  const triggerText = isMail
    ? copy.mailTrigger
    : (task.intervalValue ? intervalLabel(task.intervalValue, (task.intervalUnit as IntervalUnit) || "minutes", copy) : (task.scheduleLabel || task.rrule || meta.label));

  return (
    <div
      className={`sched-task-card${active ? " selected" : ""}${paused ? " is-paused" : ""}${task.lastError ? " has-error" : ""}`}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      role="button"
      tabIndex={0}
    >
      <div className="sched-task-card-header">
        <div className="sched-task-status-light" title={paused ? copy.statusPaused : (task.lastError ? copy.statusError : copy.statusActive)}>
          <span className={`status-dot ${paused ? "paused" : (task.lastError ? "error" : "active")}`} />
        </div>
        <div className="sched-task-card-title" title={task.title || copy.untitledTask}>
          {task.title || copy.untitledTask}
        </div>
        <div className="sched-task-actions">
          <button
            className={`sched-action-pill ${paused ? "start" : "pause"}`}
            type="button"
            title={paused ? copy.start : copy.pause}
            onClick={(event) => {
              event.stopPropagation();
              onStatus(paused ? "active" : "paused");
            }}
          >
            <SvgIcon name={paused ? "play" : "stop"} size={11} />
            <span>{paused ? copy.start : copy.pause}</span>
          </button>
          <button
            className="sched-action-icon"
            type="button"
            disabled={!task.sessionId}
            title={copy.viewSessionTitle}
            onClick={(event) => {
              event.stopPropagation();
              onOpenChat();
            }}
          >
            <SvgIcon name="externalLink" size={13} />
          </button>
        </div>
      </div>

      <div className="sched-task-chips">
        <span className="sched-chip trigger" title={triggerText}>
          <SvgIcon name={meta.icon} size={11} />
          <span>{triggerText}</span>
        </span>
        <span className="sched-chip chat" title={sessionName}>
          <SvgIcon name="notebook" size={11} />
          <span>{sessionName}</span>
        </span>
        <span className="sched-chip model" title={modelLabel(task.model, copy)}>
          <SvgIcon name="sparkle" size={11} />
          <span>{modelLabel(task.model, copy)}</span>
        </span>
      </div>

      <div className="sched-task-card-footer">
        <span className={task.lastError ? "sched-run-summary error" : "sched-run-summary"}>
          <SvgIcon name={task.lastError ? "warning" : "clock"} size={12} />
          <span>{runSummary(task, copy)}</span>
        </span>
      </div>
    </div>
  );
}

function TemplateRow({
  template,
  disabled,
  copy,
  onUse,
}: {
  template: TaskTemplate;
  disabled: boolean;
  copy: ScheduledTasksCopy;
  onUse: () => void;
}) {
  const isMail = template.triggerKind === "mail";
  const triggerText = isMail
    ? copy.onNewMail
    : intervalLabel(template.intervalValue, template.intervalUnit, copy);

  return (
    <div className="sched-template-card">
      <div className="sched-template-head">
        <div className="sched-template-meta-wrap">
          {template.category && <span className="sched-template-category">{template.category}</span>}
          <span className="sched-template-badge">
            <SvgIcon name={isMail ? "inbox" : "clock"} size={11} />
            <span>{triggerText}</span>
          </span>
        </div>
        <button className="sched-template-btn" disabled={disabled} onClick={onUse} type="button">
          <SvgIcon name="lightning" size={12} />
          <span>{copy.useTemplateButton}</span>
        </button>
      </div>
      <h3 className="sched-template-title">{template.label}</h3>
      <p className="sched-template-desc">{template.description}</p>
    </div>
  );
}

function normalizeModelOptions(current: string | undefined, options: ChatModelOption[], copy: ScheduledTasksCopy) {
  const seen = new Set<string>();
  const out: ChatModelOption[] = [];
  const add = (option: ChatModelOption) => {
    const value = option.value.trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    out.push({ ...option, value });
  };
  if (current?.trim()) add({ value: current.trim(), label: current.trim(), description: copy.currentModelOption });
  for (const option of options) add(option);
  return out;
}

export default function ScheduledTasks() {
  const setTab = useStore((s) => s.setTab);
  const setError = useStore((s) => s.setError);
  const currentProject = useStore((s) => s.currentProject);
  const language = useStore((s) => s.language);
  const copy = SCHEDULED_TASKS_COPY[language];
  const projectId = currentProject?.id;
  const [pane, setPane] = useState<Pane>("tasks");
  const [filterTab, setFilterTab] = useState<FilterTab>("all");
  const [query, setQuery] = useState("");
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [sessions, setSessions] = useState<SessionOption[]>([]);
  const [mailAccounts, setMailAccounts] = useState<MailAccount[]>([]);
  const [modelOptions, setModelOptions] = useState<ChatModelOption[]>([]);
  const [selectedId, setSelectedId] = useState<string | "new" | null>(null);
  const [form, setForm] = useState<FormState>(() => emptyForm());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saveSuccessToast, setSaveSuccessToast] = useState(false);

  const selectedTask = selectedId && selectedId !== "new"
    ? tasks.find((task) => task.id === selectedId) ?? null
    : null;

  const sessionOptions = useMemo(() => {
    if (!form.sessionId || sessions.some((session) => session.id === form.sessionId)) {
      return sessions;
    }
    return [
      { id: form.sessionId, title: copy.sessionFallbackTitle(shortId(form.sessionId)), updatedAt: 0 },
      ...sessions,
    ];
  }, [copy, form.sessionId, sessions]);

  const visibleModelOptions = useMemo(() => {
    const current = form.model.trim();
    if (!current || modelOptions.some((option) => option.value === current)) return modelOptions;
    return [{ value: current, label: current, description: null }, ...modelOptions];
  }, [form.model, modelOptions]);

  const filteredTasks = useMemo(() => {
    const term = query.trim().toLowerCase();
    return tasks.filter((task) => {
      // Filter by status tab
      const status = taskStatus(task);
      if (filterTab === "active" && status !== "active") return false;
      if (filterTab === "paused" && status !== "paused") return false;

      // Filter by search keyword
      if (!term) return true;
      const haystack = [
        task.title,
        task.prompt,
        task.scheduleLabel,
        task.rrule,
        task.model,
        (task.mailKeywords ?? []).join(" "),
        sessionTitle(task.sessionId, sessions, copy),
      ].join(" ").toLowerCase();
      return haystack.includes(term);
    });
  }, [copy, filterTab, query, sessions, tasks]);

  const activeCount = useMemo(() => tasks.filter((task) => taskStatus(task) === "active").length, [tasks]);
  const pausedCount = useMemo(() => tasks.filter((task) => taskStatus(task) === "paused").length, [tasks]);

  const canCreate = sessions.length > 0;
  const canSave =
    form.prompt.trim().length > 0 &&
    form.sessionId.trim().length > 0 &&
    (form.triggerKind === "mail" || form.intervalValue > 0);

  const refresh = useCallback(async () => {
    if (!isTauri()) {
      setTasks([]);
      setSessions([]);
      setModelOptions([{
        value: "Preview",
        label: copy.previewModelLabel,
        description: copy.previewModelDescription,
      }]);
      setSelectedId(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [nextTasks, nextSessions, nextMailAccounts, nextModels] = await Promise.all([
        scheduledTasksList(),
        loadSessionOptions(copy, projectId),
        mailAccountsGet().catch(() => [] as MailAccount[]),
        chatModelOptions().catch(() => ({ provider: "", current: "", options: [] as ChatModelOption[] })),
      ]);
      setTasks(nextTasks);
      setSessions(nextSessions);
      setMailAccounts(nextMailAccounts.filter((account) => account.connected));
      setModelOptions(normalizeModelOptions(nextModels.current, nextModels.options, copy));
      setSelectedId((current) => {
        if (current === "new") return current;
        if (current && nextTasks.some((task) => task.id === current)) return current;
        return nextTasks[0]?.id ?? null;
      });
    } catch (error) {
      setError(String(error));
    } finally {
      setLoading(false);
    }
  }, [copy, projectId, setError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (selectedId === "new") return;
    if (selectedTask) {
      setForm(taskToForm(selectedTask, sessions[0]?.id ?? ""));
      return;
    }
    setForm(emptyForm(sessions[0]?.id ?? ""));
  }, [selectedId, selectedTask, sessions]);

  const selectNew = () => {
    if (!canCreate) return;
    setForm(emptyForm(sessions[0]?.id ?? ""));
    setSelectedId("new");
    setPane("tasks");
  };

  const openBoundSession = (sessionId: string | null | undefined) => {
    if (!sessionId) return;
    setTab("chat");
  };

  const applyTemplate = (template: TaskTemplate) => {
    if (!canCreate) return;
    setForm(templateToForm(template, sessions[0]?.id ?? ""));
    setSelectedId("new");
    setPane("tasks");
  };

  const handleSave = async () => {
    if (!canSave) return;
    setBusy(true);
    try {
      const input = formToInput(form);
      const saved = selectedId && selectedId !== "new"
        ? await scheduledTaskUpdate(selectedId, input)
        : await scheduledTaskCreate(input);
      setTasks((previous) => addOrReplaceTask(previous, saved));
      setSelectedId(saved.id);
      setPane("tasks");
      setSaveSuccessToast(true);
      setTimeout(() => setSaveSuccessToast(false), 2500);
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  };

  const handleStatus = async (task: ScheduledTask, status: TaskStatus) => {
    setBusy(true);
    try {
      const saved = await scheduledTaskSetStatus(task.id, status);
      setTasks((previous) => addOrReplaceTask(previous, saved));
      if (selectedId === task.id) setForm(taskToForm(saved, sessions[0]?.id ?? ""));
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedTask || !window.confirm(copy.deleteConfirm(selectedTask.title || selectedTask.id))) return;
    setBusy(true);
    try {
      await scheduledTaskDelete(selectedTask.id);
      setTasks((previous) => {
        const next = previous.filter((task) => task.id !== selectedTask.id);
        setSelectedId(next[0]?.id ?? null);
        return next;
      });
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  };

  // Keyboard shortcut: Ctrl+S / Cmd+S to save
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        if (canSave && !busy) {
          e.preventDefault();
          void handleSave();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canSave, busy, form]);

  const addPresetKeyword = (kw: string) => {
    const currentList = parseKeywords(form.mailKeywords);
    if (!currentList.includes(kw)) {
      const next = currentList.length > 0 ? `${form.mailKeywords.trim()}, ${kw}` : kw;
      setForm((cur) => ({ ...cur, mailKeywords: next }));
    }
  };

  const projectLabel = currentProject?.name || copy.currentProjectFallback;
  const selectedMeta = selectedTask ? triggerMeta(selectedTask, copy) : triggerMeta(form, copy);

  return (
    <div className="sched-page">
      <div className="sched-shell">
        {/* Left Sidebar */}
        <aside className="sched-sidebar">
          <div className="sched-sidebar-top">
            <div className="sched-brand-header">
              <div className="sched-brand-badge">
                <SvgIcon name="lightning" size={16} />
              </div>
              <div className="sched-brand-text">
                <h2>{copy.heading}</h2>
                <span className="sched-badge-count">{tasks.length}</span>
              </div>
            </div>

            {/* Segmented Pane Tabs (Tasks vs Templates) */}
            <div className="sched-nav-tabs" role="tablist" aria-label={copy.tabsAriaLabel}>
              <button
                className={`sched-nav-tab${pane === "tasks" ? " active" : ""}`}
                onClick={() => setPane("tasks")}
                type="button"
              >
                <SvgIcon name="notebook" size={14} />
                <span>{copy.tabTasks}</span>
                <span className="tab-count">{tasks.length}</span>
              </button>
              <button
                className={`sched-nav-tab${pane === "templates" ? " active" : ""}`}
                onClick={() => setPane("templates")}
                type="button"
              >
                <SvgIcon name="sparkle" size={14} />
                <span>{copy.tabTemplates}</span>
                <span className="tab-count">{copy.taskTemplates.length}</span>
              </button>
            </div>

            {pane === "tasks" && (
              <>
                {/* Search Bar */}
                <div className="sched-search-box">
                  <span className="sched-search-icon" aria-hidden="true">
                    <SvgIcon name="search" size={14} />
                  </span>
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={copy.searchPlaceholder}
                  />
                  {query && (
                    <button
                      className="sched-search-clear"
                      type="button"
                      onClick={() => setQuery("")}
                      title="Clear search"
                    >
                      <SvgIcon name="close" size={12} />
                    </button>
                  )}
                </div>

                {/* Status Filter Pills */}
                <div className="sched-filter-pills">
                  <button
                    className={`sched-pill-btn${filterTab === "all" ? " active" : ""}`}
                    type="button"
                    onClick={() => setFilterTab("all")}
                  >
                    <span>{copy.filterAll}</span>
                    <span className="pill-num">{tasks.length}</span>
                  </button>
                  <button
                    className={`sched-pill-btn${filterTab === "active" ? " active" : ""}`}
                    type="button"
                    onClick={() => setFilterTab("active")}
                  >
                    <span className="dot active" />
                    <span>{copy.filterActive}</span>
                    <span className="pill-num">{activeCount}</span>
                  </button>
                  <button
                    className={`sched-pill-btn${filterTab === "paused" ? " active" : ""}`}
                    type="button"
                    onClick={() => setFilterTab("paused")}
                  >
                    <span className="dot paused" />
                    <span>{copy.filterPaused}</span>
                    <span className="pill-num">{pausedCount}</span>
                  </button>
                </div>
              </>
            )}
          </div>

          {/* Sidebar List Content */}
          <div className="sched-sidebar-content">
            {loading ? (
              <div className="sched-empty-state">
                <span className="sched-spin-icon"><SvgIcon name="spinner" size={24} /></span>
                <p>{copy.loading}</p>
              </div>
            ) : pane === "templates" ? (
              <div className="sched-template-list">
                {copy.taskTemplates.map((template) => (
                  <TemplateRow
                    disabled={!canCreate || busy}
                    key={template.id}
                    template={template}
                    copy={copy}
                    onUse={() => applyTemplate(template)}
                  />
                ))}
              </div>
            ) : filteredTasks.length === 0 ? (
              <div className="sched-empty-state">
                <div className="sched-empty-icon">
                  <SvgIcon name="notebook" size={28} />
                </div>
                <div className="sched-empty-title">{query ? copy.filterEmpty : copy.emptyTasksTitle}</div>
                <p className="sched-empty-sub">{copy.emptyTasksSubtitle}</p>
                {!query && (
                  <button className="sched-empty-btn" disabled={!canCreate} onClick={selectNew} type="button">
                    <SvgIcon name="plus" size={13} />
                    <span>{copy.createTask}</span>
                  </button>
                )}
              </div>
            ) : (
              <div className="sched-task-list">
                {filteredTasks.map((task) => (
                  <TaskRow
                    active={selectedId === task.id}
                    key={task.id}
                    task={task}
                    sessionName={sessionTitle(task.sessionId, sessions, copy)}
                    copy={copy}
                    onSelect={() => {
                      setSelectedId(task.id);
                      setPane("tasks");
                    }}
                    onStatus={(status) => void handleStatus(task, status)}
                    onOpenChat={() => openBoundSession(task.sessionId)}
                  />
                ))}
              </div>
            )}
          </div>
        </aside>

        {/* Right Main Editor Pane */}
        <main className="sched-editor">
          {/* Top Unified Navigation Toolbar */}
          <div className="sched-editor-toolbar">
            <button className="sched-back-btn" onClick={() => setTab("chat")} type="button">
              <SvgIcon name="chevronLeft" size={16} />
              <span>{copy.backToChat}</span>
            </button>

            <div className="sched-toolbar-right">
              {saveSuccessToast && (
                <div className="sched-toast success">
                  <SvgIcon name="check" size={13} />
                  <span>{copy.noErrorValue}</span>
                </div>
              )}
              <button
                className="sched-btn primary sched-new-btn"
                disabled={!canCreate || busy}
                onClick={selectNew}
                type="button"
              >
                <SvgIcon name="plus" size={14} />
                <span>{copy.createTask}</span>
              </button>
              <button
                className="sched-icon-btn"
                onClick={() => void refresh()}
                type="button"
                aria-label={copy.refreshAriaLabel}
                title={copy.refreshAriaLabel}
              >
                <SvgIcon name="refresh" size={15} />
              </button>
            </div>
          </div>

          {!selectedId ? (
            <div className="sched-no-selection">
              <div className="sched-no-selection-inner">
                <div className="sched-no-sel-icon">
                  <SvgIcon name="lightning" size={36} />
                </div>
                <h3>{copy.selectOrCreate}</h3>
                <p>{canCreate ? copy.emptyTasksSubtitle : copy.needSavedChat}</p>
                {canCreate && (
                  <button className="sched-btn primary" onClick={selectNew} type="button">
                    <SvgIcon name="plus" size={14} />
                    <span>{copy.createTask}</span>
                  </button>
                )}
              </div>
            </div>
          ) : (
            <form
              className="sched-form-container"
              onSubmit={(event) => {
                event.preventDefault();
                void handleSave();
              }}
            >
              {/* Task Hero Card: Title & Prompt */}
              <div className="sched-hero-card">
                <div className="sched-title-wrap">
                  <span className="sched-title-icon"><SvgIcon name="edit" size={18} /></span>
                  <input
                    className="sched-title-input"
                    value={form.title}
                    onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
                    placeholder={copy.titlePlaceholder}
                    maxLength={100}
                  />
                  <span className="sched-char-count">{form.title.length}/100</span>
                </div>

                <div className="sched-prompt-wrap">
                  <div className="sched-prompt-header">
                    <div className="sched-prompt-title">
                      <SvgIcon name="sparkle" size={13} />
                      <span>{copy.promptHint}</span>
                    </div>
                    <span className="sched-char-count">{form.prompt.length} 字符</span>
                  </div>
                  <textarea
                    className="sched-prompt-textarea"
                    rows={4}
                    value={form.prompt}
                    onChange={(event) => setForm((current) => ({ ...current, prompt: event.target.value }))}
                    placeholder={copy.promptPlaceholder}
                    required
                  />
                </div>
              </div>

              {/* Metric Stats Grid (When editing an existing task) */}
              {selectedTask && (
                <div className="sched-metrics-grid">
                  <div className="sched-metric-item">
                    <div className="sched-metric-head">
                      <span className="metric-icon trigger"><SvgIcon name={selectedMeta.icon} size={14} /></span>
                      <span className="metric-title">{copy.runPanelTriggerLabel}</span>
                    </div>
                    <div className="sched-metric-val">{selectedMeta.label}</div>
                  </div>

                  <div className="sched-metric-item">
                    <div className="sched-metric-head">
                      <span className="metric-icon next"><SvgIcon name="clock" size={14} /></span>
                      <span className="metric-title">{copy.nextRunLabel}</span>
                    </div>
                    <div className="sched-metric-val">
                      {taskStatus(selectedTask) === "paused"
                        ? copy.paused
                        : (selectedTask.triggerKind === "mail" ? copy.waitingForMail : formatTaskTime(selectedTask.nextRun, copy))}
                    </div>
                  </div>

                  <div className="sched-metric-item">
                    <div className="sched-metric-head">
                      <span className="metric-icon last"><SvgIcon name="check" size={14} /></span>
                      <span className="metric-title">{copy.lastRunLabel}</span>
                    </div>
                    <div className="sched-metric-val">{formatTaskTime(selectedTask.lastRunAt, copy)}</div>
                  </div>

                  <div className={`sched-metric-item${selectedTask.lastError ? " is-error" : " is-healthy"}`}>
                    <div className="sched-metric-head">
                      <span className="metric-icon health">
                        <SvgIcon name={selectedTask.lastError ? "warning" : "shieldCheck"} size={14} />
                      </span>
                      <span className="metric-title">{copy.lastErrorLabel}</span>
                    </div>
                    <div className="sched-metric-val" title={selectedTask.lastError || copy.noErrorValue}>
                      {selectedTask.lastError ? copy.statusError : copy.noErrorValue}
                    </div>
                  </div>
                </div>
              )}

              {/* Group 1: Trigger & Schedule Rules */}
              <DetailCard title={copy.triggerSection} icon="clock">
                <DetailRow label={copy.triggerLabel}>
                  <div className="sched-segmented-control" role="radiogroup">
                    <button
                      className={form.triggerKind === "interval" ? "selected" : ""}
                      type="button"
                      onClick={() => setForm((current) => ({ ...current, triggerKind: "interval" }))}
                    >
                      <SvgIcon name="clock" size={13} />
                      <span>{copy.triggerIntervalOption}</span>
                    </button>
                    <button
                      className={form.triggerKind === "mail" ? "selected" : ""}
                      type="button"
                      onClick={() => setForm((current) => ({ ...current, triggerKind: "mail" }))}
                    >
                      <SvgIcon name="inbox" size={13} />
                      <span>{copy.onNewMail}</span>
                    </button>
                  </div>
                </DetailRow>

                {form.triggerKind === "interval" ? (
                  <>
                    <DetailRow label={copy.repeatCountLabel}>
                      <div className="sched-interval-row">
                        <div className="sched-interval-input-group">
                          <span className="sched-interval-prefix">{copy.everyLabel}</span>
                          <input
                            className="sched-number-input"
                            min={1}
                            type="number"
                            value={form.intervalValue}
                            onChange={(event) => {
                              const value = Number(event.target.value);
                              setForm((current) => ({ ...current, intervalValue: Number.isFinite(value) ? value : 1 }));
                            }}
                          />
                          <select
                            className="sched-select-compact"
                            value={form.intervalUnit}
                            onChange={(event) => {
                              const unit = isIntervalUnit(event.target.value) ? event.target.value : "minutes";
                              setForm((current) => ({ ...current, intervalUnit: unit }));
                            }}
                          >
                            {Object.entries(copy.unitLabels).map(([value, label]) => (
                              <option key={value} value={value}>{label}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                    </DetailRow>

                    <DetailRow label={copy.presetIntervalsLabel}>
                      <div className="sched-preset-chips">
                        {PRESET_INTERVALS.map((preset) => {
                          const isCurrent = form.intervalValue === preset.value && form.intervalUnit === preset.unit;
                          return (
                            <button
                              className={`sched-preset-chip${isCurrent ? " active" : ""}`}
                              key={`${preset.value}-${preset.unit}`}
                              type="button"
                              onClick={() => setForm((cur) => ({ ...cur, intervalValue: preset.value, intervalUnit: preset.unit }))}
                            >
                              {preset.label}
                            </button>
                          );
                        })}
                      </div>
                    </DetailRow>
                  </>
                ) : (
                  <>
                    <DetailRow label={copy.triggerAccountLabel}>
                      <select
                        className="sched-select-control"
                        value={form.mailAccountId}
                        onChange={(event) => setForm((current) => ({ ...current, mailAccountId: event.target.value }))}
                      >
                        <option value="">{copy.anyConnectedMailbox}</option>
                        {mailAccounts.map((account) => (
                          <option key={account.id} value={account.id}>{account.email}</option>
                        ))}
                      </select>
                    </DetailRow>

                    <DetailRow label={copy.keywordsLabel}>
                      <input
                        className="sched-text-control"
                        value={form.mailKeywords}
                        onChange={(event) => setForm((current) => ({ ...current, mailKeywords: event.target.value }))}
                        placeholder={copy.keywordsPlaceholder}
                      />
                    </DetailRow>

                    <DetailRow label={copy.presetKeywordsLabel}>
                      <div className="sched-preset-chips">
                        {PRESET_KEYWORDS.map((kw) => (
                          <button
                            className="sched-preset-chip"
                            key={kw}
                            type="button"
                            onClick={() => addPresetKeyword(kw)}
                          >
                            + {kw}
                          </button>
                        ))}
                      </div>
                    </DetailRow>
                  </>
                )}
              </DetailCard>

              {/* Group 2: Target Context & Model */}
              <DetailCard title={copy.targetContextSection} icon="target">
                <DetailRow label={copy.boundChatLabel}>
                  <div className="sched-flex-control">
                    <select
                      className="sched-select-control flex-1"
                      value={form.sessionId}
                      onChange={(event) => setForm((current) => ({ ...current, sessionId: event.target.value }))}
                      required
                    >
                      <option value="" disabled>{copy.selectChatPlaceholder}</option>
                      {sessionOptions.map((session) => (
                        <option key={session.id} value={session.id}>{session.title}</option>
                      ))}
                    </select>
                    {form.sessionId && (
                      <button
                        className="sched-btn-secondary"
                        type="button"
                        onClick={() => openBoundSession(form.sessionId)}
                        title={copy.jumpToSession}
                      >
                        <SvgIcon name="externalLink" size={13} />
                        <span>{copy.jumpToSession}</span>
                      </button>
                    )}
                  </div>
                </DetailRow>

                <DetailRow label={copy.modelFieldLabel}>
                  <select
                    className="sched-select-control"
                    value={form.model}
                    onChange={(event) => setForm((current) => ({ ...current, model: event.target.value }))}
                  >
                    <option value="">{copy.followCurrentModel}</option>
                    {visibleModelOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </DetailRow>

                <DetailRow label={copy.environmentLabel} info={copy.environmentInfo}>
                  <div className="sched-readonly-badge" title={currentProject?.path}>
                    <SvgIcon name="folder" size={13} />
                    <span>{copy.workspaceValue}</span>
                    <span className="sched-sep">/</span>
                    <span>{projectLabel}</span>
                  </div>
                </DetailRow>

                <DetailRow label={copy.statusLabel}>
                  <div className="sched-status-switch" role="group" aria-label={copy.statusGroupAriaLabel}>
                    <button
                      className={`sched-status-pill ${form.status === "active" ? "active selected" : ""}`}
                      type="button"
                      onClick={() => setForm((current) => ({ ...current, status: "active" }))}
                    >
                      <span className="dot active" />
                      <span>{copy.statusActive}</span>
                    </button>
                    <button
                      className={`sched-status-pill ${form.status === "paused" ? "paused selected" : ""}`}
                      type="button"
                      onClick={() => setForm((current) => ({ ...current, status: "paused" }))}
                    >
                      <span className="dot paused" />
                      <span>{copy.statusPaused}</span>
                    </button>
                  </div>
                </DetailRow>
              </DetailCard>

              {/* Bottom Sticky Action Footer */}
              <div className="sched-action-footer">
                <div className="sched-footer-left">
                  {selectedTask && (
                    <button
                      className="sched-btn-danger"
                      disabled={busy}
                      onClick={() => void handleDelete()}
                      type="button"
                    >
                      <SvgIcon name="close" size={13} />
                      <span>{copy.deleteButton}</span>
                    </button>
                  )}
                </div>

                <div className="sched-footer-right">
                  {selectedTask && (
                    <button
                      className="sched-btn-secondary"
                      type="button"
                      disabled={!selectedTask.sessionId}
                      onClick={() => openBoundSession(selectedTask.sessionId)}
                    >
                      <SvgIcon name="externalLink" size={13} />
                      <span>{copy.viewChatButton}</span>
                    </button>
                  )}

                  <button
                    className="sched-btn primary"
                    disabled={!canSave || busy}
                    type="submit"
                  >
                    {busy ? (
                      <>
                        <SvgIcon name="spinner" size={14} className="spin" />
                        <span>{copy.savingText}</span>
                      </>
                    ) : (
                      <>
                        <SvgIcon name="check" size={14} />
                        <span>{selectedTask ? copy.saveChangesButton : copy.createTaskButton}</span>
                        <span className="sched-btn-shortcut">Ctrl+S</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            </form>
          )}
        </main>
      </div>
    </div>
  );
}

