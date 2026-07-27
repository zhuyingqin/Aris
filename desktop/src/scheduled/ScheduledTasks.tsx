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
): { kind: "interval" | "mail"; label: string } {
  return task.triggerKind === "mail"
    ? { kind: "mail", label: copy.mailTrigger }
    : { kind: "interval", label: copy.intervalTrigger };
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
        {info && <span className="sched-info" title={info}>i</span>}
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
  return (
    <div
      className={`sched-row${active ? " selected" : ""}`}
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
      <span className={`sched-row-play${paused ? " paused" : ""}`} aria-hidden="true"><SvgIcon name="play" size={13} /></span>
      <div className="sched-row-main">
        <span className="sched-row-title">{task.title || copy.untitledTask}</span>
        <span className="sched-row-sub">
          <span>{sessionName}</span>
          <span>{task.scheduleLabel || task.rrule || meta.label}</span>
          <span>{modelLabel(task.model, copy)}</span>
        </span>
        <span className={task.lastError ? "sched-row-run error" : "sched-row-run"}>{runSummary(task, copy)}</span>
      </div>
      <button
        className="sched-row-action"
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onStatus(paused ? "active" : "paused");
        }}
      >
        {paused ? copy.start : copy.pause}
      </button>
      <button
        className="sched-row-open"
        type="button"
        disabled={!task.sessionId}
        title={copy.viewSessionTitle}
        onClick={(event) => {
          event.stopPropagation();
          onOpenChat();
        }}
      >
        <SvgIcon name="externalLink" size={14} />
      </button>
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
  const label = template.triggerKind === "mail"
    ? copy.onNewMail
    : intervalLabel(template.intervalValue, template.intervalUnit, copy);
  return (
    <button className="sched-template-row" disabled={disabled} onClick={onUse} type="button">
      <span className="sched-template-title">{template.label}</span>
      <span className="sched-template-desc">{template.description}</span>
      <span className="sched-template-meta">{label}</span>
    </button>
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
  const [query, setQuery] = useState("");
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [sessions, setSessions] = useState<SessionOption[]>([]);
  const [mailAccounts, setMailAccounts] = useState<MailAccount[]>([]);
  const [modelOptions, setModelOptions] = useState<ChatModelOption[]>([]);
  const [selectedId, setSelectedId] = useState<string | "new" | null>(null);
  const [form, setForm] = useState<FormState>(() => emptyForm());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

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
    if (!term) return tasks;
    return tasks.filter((task) => {
      const haystack = [
        task.title,
        task.prompt,
        task.scheduleLabel,
        task.rrule,
        task.model,
        sessionTitle(task.sessionId, sessions, copy),
      ].join(" ").toLowerCase();
      return haystack.includes(term);
    });
  }, [copy, query, sessions, tasks]);

  const activeTasks = filteredTasks.filter((task) => taskStatus(task) === "active");
  const pausedTasks = filteredTasks.filter((task) => taskStatus(task) === "paused");
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
    // Session transcripts now live in the main Chat workspace; there is no
    // separate Sessions page to route through.
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

  const renderTaskGroup = (label: string, items: ScheduledTask[]) => (
    <div className="sched-group">
      <div className="sched-group-title">{label}</div>
      {items.length === 0 ? (
        <div className="sched-group-empty">{copy.groupEmpty}</div>
      ) : (
        items.map((task) => (
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
        ))
      )}
    </div>
  );

  const projectLabel = currentProject?.name || copy.currentProjectFallback;
  const selectedMeta = selectedTask ? triggerMeta(selectedTask, copy) : triggerMeta(form, copy);

  return (
    <div className="sched-page">
      <div className="sched-shell">
        <aside className="sched-sidebar">
          <div className="sched-tabs" role="tablist" aria-label={copy.tabsAriaLabel}>
            <button className={pane === "tasks" ? "selected" : ""} onClick={() => setPane("tasks")} type="button">{copy.tabTasks}</button>
            <button className={pane === "templates" ? "selected" : ""} onClick={() => setPane("templates")} type="button">{copy.tabTemplates}</button>
          </div>

          <div className="sched-sidebar-head">
            <h1>{copy.heading}</h1>
            <p>{copy.subheading}</p>
          </div>

          <label className="sched-search">
            <span aria-hidden="true"><SvgIcon name="search" size={15} /></span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={copy.searchPlaceholder}
            />
          </label>

          <div className="sched-sidebar-content">
            {loading ? (
              <div className="sched-loading">{copy.loading}</div>
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
            ) : tasks.length === 0 ? (
              <div className="sched-empty compact">
                <div className="sched-empty-title">{copy.emptyTasksTitle}</div>
              </div>
            ) : (
              <>
                {renderTaskGroup(copy.activeGroup, activeTasks)}
                {renderTaskGroup(copy.paused, pausedTasks)}
              </>
            )}
          </div>
        </aside>

        <main className="sched-editor">
          <div className="sched-editor-toolbar">
            <button className="sched-back" onClick={() => setTab("chat")} type="button">{copy.backToChat}</button>
            <div className="sched-editor-actions">
              <button className="sched-create" disabled={!canCreate || busy} onClick={selectNew} type="button">
                {copy.createTask} <SvgIcon name="chevronDown" size={13} />
              </button>
              <button className="sched-icon-button" onClick={() => void refresh()} type="button" aria-label={copy.refreshAriaLabel}>
                <SvgIcon name="refresh" size={16} />
              </button>
            </div>
          </div>

          {!selectedId ? (
            <div className="sched-detail-empty">
              {canCreate ? copy.selectOrCreate : copy.needSavedChat}
            </div>
          ) : (
            <form
              className="sched-form"
              onSubmit={(event) => {
                event.preventDefault();
                void handleSave();
              }}
            >
              <input
                className="sched-title-input"
                value={form.title}
                onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
                placeholder={copy.titlePlaceholder}
              />

              <textarea
                className="sched-prompt-input"
                rows={3}
                value={form.prompt}
                onChange={(event) => setForm((current) => ({ ...current, prompt: event.target.value }))}
                placeholder={copy.promptPlaceholder}
              />

              <section className="sched-detail-section">
                <div className="sched-section-title">{copy.detailsSection}</div>

                <DetailRow label={copy.environmentLabel} info={copy.environmentInfo}>
                  <span className="sched-static-value" title={currentProject?.path}>{copy.workspaceValue}</span>
                </DetailRow>

                <DetailRow label={copy.projectLabel}>
                  <span className="sched-static-value" title={currentProject?.path}>{projectLabel}</span>
                </DetailRow>

                <DetailRow label={copy.boundChatLabel}>
                  <select
                    className="sched-inline-select"
                    value={form.sessionId}
                    onChange={(event) => setForm((current) => ({ ...current, sessionId: event.target.value }))}
                    required
                  >
                    <option value="" disabled>{copy.selectChatPlaceholder}</option>
                    {sessionOptions.map((session) => (
                      <option key={session.id} value={session.id}>{session.title}</option>
                    ))}
                  </select>
                </DetailRow>

                <DetailRow label={copy.triggerLabel}>
                  <select
                    className="sched-inline-select"
                    value={form.triggerKind}
                    onChange={(event) => {
                      const triggerKind = isTriggerKind(event.target.value) ? event.target.value : "interval";
                      setForm((current) => ({ ...current, triggerKind }));
                    }}
                  >
                    <option value="interval">{copy.triggerIntervalOption}</option>
                    <option value="mail">{copy.onNewMail}</option>
                  </select>
                </DetailRow>

                {form.triggerKind === "interval" ? (
                  <DetailRow label={copy.repeatCountLabel}>
                    <div className="sched-inline-interval">
                      <span>{copy.everyLabel}</span>
                      <input
                        min={1}
                        type="number"
                        value={form.intervalValue}
                        onChange={(event) => {
                          const value = Number(event.target.value);
                          setForm((current) => ({ ...current, intervalValue: Number.isFinite(value) ? value : 1 }));
                        }}
                      />
                      <select
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
                  </DetailRow>
                ) : (
                  <>
                    <DetailRow label={copy.triggerAccountLabel}>
                      <select
                        className="sched-inline-select"
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
                        className="sched-inline-input"
                        value={form.mailKeywords}
                        onChange={(event) => setForm((current) => ({ ...current, mailKeywords: event.target.value }))}
                        placeholder={copy.keywordsPlaceholder}
                      />
                    </DetailRow>
                  </>
                )}

                <DetailRow label={copy.modelFieldLabel}>
                  <select
                    className="sched-inline-select"
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

                <DetailRow label={copy.statusLabel}>
                  <div className="sched-status-toggle" role="group" aria-label={copy.statusGroupAriaLabel}>
                    <button
                      className={form.status === "active" ? "selected" : ""}
                      type="button"
                      onClick={() => setForm((current) => ({ ...current, status: "active" }))}
                    >
                      {copy.start}
                    </button>
                    <button
                      className={form.status === "paused" ? "selected" : ""}
                      type="button"
                      onClick={() => setForm((current) => ({ ...current, status: "paused" }))}
                    >
                      {copy.pause}
                    </button>
                  </div>
                </DetailRow>
              </section>

              {selectedTask && (
                <div className="sched-run-panel">
                  <div>
                    <span>{copy.runPanelTriggerLabel}</span>
                    <strong>{selectedMeta.label}</strong>
                  </div>
                  <div>
                    <span>{copy.nextRunLabel}</span>
                    <strong>{taskStatus(selectedTask) === "paused" ? copy.paused : formatTaskTime(selectedTask.nextRun, copy)}</strong>
                  </div>
                  <div>
                    <span>{copy.lastRunLabel}</span>
                    <strong>{formatTaskTime(selectedTask.lastRunAt, copy)}</strong>
                  </div>
                  <div className={selectedTask.lastError ? "error" : ""}>
                    <span>{copy.lastErrorLabel}</span>
                    <strong>{selectedTask.lastError || copy.noErrorValue}</strong>
                  </div>
                </div>
              )}

              <div className="sched-actions">
                <button className="primary" disabled={!canSave || busy} type="submit">{copy.saveButton}</button>
                {selectedTask && (
                  <button
                    type="button"
                    disabled={!selectedTask.sessionId}
                    onClick={() => openBoundSession(selectedTask.sessionId)}
                  >
                    {copy.viewChatButton}
                  </button>
                )}
                {selectedTask && (
                  <button className="sched-danger" disabled={busy} onClick={() => void handleDelete()} type="button">
                    {copy.deleteButton}
                  </button>
                )}
              </div>
            </form>
          )}
        </main>
      </div>
    </div>
  );
}
