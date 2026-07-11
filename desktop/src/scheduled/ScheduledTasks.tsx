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
import type {
  ChatModelOption,
  MailAccount,
  ScheduledTask,
  ScheduledTaskInput,
  SessionSummary,
} from "../types";

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

const UNIT_LABELS: Record<IntervalUnit, string> = {
  minutes: "分钟",
  hours: "小时",
  days: "天",
};

const DEFAULT_INTERVAL = 15;

interface TaskTemplate {
  id: string;
  label: string;
  description: string;
  title: string;
  prompt: string;
  triggerKind: TriggerKind;
  intervalValue: number;
  intervalUnit: IntervalUnit;
  mailKeywords?: string;
}

// Editable workflow templates. They only pre-fill the form below; the saved
// task remains a normal scheduled task.
const TASK_TEMPLATES: TaskTemplate[] = [
  {
    id: "literature-mail-on-arrival",
    label: "新邮件触发·论文求助回复",
    description: "收到含「文献求助/论文求助」等关键词的新邮件时，自动检索并回复 PDF。",
    title: "新邮件·论文求助自动回复",
    prompt:
      "有一封新邮件触发了本任务（邮件信息见末尾）。先用 mail_read 读取该邮件确认是文献/论文求助，然后调用 mail_literature_catch_up（可只针对该账户）完成检索、下载 PDF，并按「设置 > 邮件自动化」配置回复。最后用一句话汇总处理结果；若不是求助邮件则跳过，不要编造。",
    triggerKind: "mail",
    intervalValue: DEFAULT_INTERVAL,
    intervalUnit: "minutes",
    mailKeywords: "文献求助, 论文求助, paper request, literature request",
  },
  {
    id: "literature-mail-poll",
    label: "定时轮询·论文求助回复",
    description: "按间隔扫描收件箱中的文献/论文求助邮件并回复 PDF。",
    title: "定时轮询·论文求助自动回复",
    prompt:
      "检查我已连接邮箱的收件箱，找出文献/论文求助类邮件。调用 mail_literature_catch_up 工具完成检索、下载 PDF，并按「设置 > 邮件自动化」的配置（来源、自动发送、白名单）回复。处理完成后用一句话汇总：本次识别了哪些求助、发送/准备了多少封回复、是否有失败。若没有连接的邮箱或没有匹配邮件，明确说明即可，不要编造。",
    triggerKind: "interval",
    intervalValue: 30,
    intervalUnit: "minutes",
  },
];

function formatTaskTime(value: string | null | undefined) {
  if (!value) return "暂无";
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

function runSummary(task: ScheduledTask) {
  if (taskStatus(task) === "paused") return "已暂停";
  if (task.lastError) return "最近执行失败";
  if (task.triggerKind === "mail") {
    return task.lastRunAt ? `上次 ${formatTaskTime(task.lastRunAt)}` : "等待新邮件触发";
  }
  if (task.nextRun) return `下次 ${formatTaskTime(task.nextRun)}`;
  if (task.lastRunAt) return `上次 ${formatTaskTime(task.lastRunAt)}`;
  return "等待首次执行";
}

function triggerMeta(task: ScheduledTask | FormState): { kind: "interval" | "mail"; label: string } {
  return task.triggerKind === "mail"
    ? { kind: "mail", label: "邮件" }
    : { kind: "interval", label: "间隔" };
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

function optionFromChatSession(session: ChatSession): SessionOption {
  return {
    id: session.id,
    title: session.title || `对话 ${shortId(session.id)}`,
    updatedAt: session.updatedAt ?? 0,
    model: session.model ?? null,
  };
}

function optionFromRuntimeSession(session: SessionSummary): SessionOption {
  return {
    id: session.id,
    title: `对话 ${shortId(session.id)}`,
    updatedAt: session.modifiedEpochSecs * 1000,
  };
}

async function loadSessionOptions(projectId?: string | null): Promise<SessionOption[]> {
  const byId = new Map<string, SessionOption>();
  const uiSessions = await chatUiSessionsList<ChatSession>().catch(() => []);
  for (const session of uiSessions) {
    if (projectId && session.projectId && session.projectId !== projectId) continue;
    byId.set(session.id, optionFromChatSession(session));
  }
  if (byId.size === 0) {
    const runtimeSessions = await sessionsList().catch(() => []);
    for (const session of runtimeSessions) byId.set(session.id, optionFromRuntimeSession(session));
  }
  return [...byId.values()].sort((left, right) => right.updatedAt - left.updatedAt);
}

function sessionTitle(sessionId: string | null | undefined, sessions: SessionOption[]) {
  if (!sessionId) return "未绑定";
  return sessions.find((session) => session.id === sessionId)?.title ?? `对话 ${shortId(sessionId)}`;
}

function modelLabel(model: string | null | undefined) {
  return model?.trim() || "跟随当前模型";
}

function intervalLabel(value: number, unit: IntervalUnit) {
  return `每 ${Math.max(1, Math.floor(value || 1))} ${UNIT_LABELS[unit]}`;
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
  onSelect,
  onStatus,
  onOpenChat,
}: {
  active: boolean;
  task: ScheduledTask;
  sessionName: string;
  onSelect: () => void;
  onStatus: (status: TaskStatus) => void;
  onOpenChat: () => void;
}) {
  const paused = taskStatus(task) === "paused";
  const meta = triggerMeta(task);
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
      <span className={`sched-row-play${paused ? " paused" : ""}`} aria-hidden="true">▶</span>
      <div className="sched-row-main">
        <span className="sched-row-title">{task.title || "未命名任务"}</span>
        <span className="sched-row-sub">
          <span>{sessionName}</span>
          <span>{task.scheduleLabel || task.rrule || meta.label}</span>
          <span>{modelLabel(task.model)}</span>
        </span>
        <span className={task.lastError ? "sched-row-run error" : "sched-row-run"}>{runSummary(task)}</span>
      </div>
      <button
        className="sched-row-action"
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onStatus(paused ? "active" : "paused");
        }}
      >
        {paused ? "启动" : "暂停"}
      </button>
      <button
        className="sched-row-open"
        type="button"
        disabled={!task.sessionId}
        title="查看该任务运行的对话记录"
        onClick={(event) => {
          event.stopPropagation();
          onOpenChat();
        }}
      >
        ↗
      </button>
    </div>
  );
}

function TemplateRow({
  template,
  disabled,
  onUse,
}: {
  template: TaskTemplate;
  disabled: boolean;
  onUse: () => void;
}) {
  const label = template.triggerKind === "mail"
    ? "收到新邮件时"
    : intervalLabel(template.intervalValue, template.intervalUnit);
  return (
    <button className="sched-template-row" disabled={disabled} onClick={onUse} type="button">
      <span className="sched-template-title">{template.label}</span>
      <span className="sched-template-desc">{template.description}</span>
      <span className="sched-template-meta">{label}</span>
    </button>
  );
}

function normalizeModelOptions(current: string | undefined, options: ChatModelOption[]) {
  const seen = new Set<string>();
  const out: ChatModelOption[] = [];
  const add = (option: ChatModelOption) => {
    const value = option.value.trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    out.push({ ...option, value });
  };
  if (current?.trim()) add({ value: current.trim(), label: current.trim(), description: "当前模型" });
  for (const option of options) add(option);
  return out;
}

export default function ScheduledTasks() {
  const setTab = useStore((s) => s.setTab);
  const setError = useStore((s) => s.setError);
  const currentProject = useStore((s) => s.currentProject);
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
      { id: form.sessionId, title: `对话 ${shortId(form.sessionId)}`, updatedAt: 0 },
      ...sessions,
    ];
  }, [form.sessionId, sessions]);

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
        sessionTitle(task.sessionId, sessions),
      ].join(" ").toLowerCase();
      return haystack.includes(term);
    });
  }, [query, sessions, tasks]);

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
      setModelOptions([{ value: "Preview", label: "Preview", description: "Browser preview" }]);
      setSelectedId(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [nextTasks, nextSessions, nextMailAccounts, nextModels] = await Promise.all([
        scheduledTasksList(),
        loadSessionOptions(projectId),
        mailAccountsGet().catch(() => [] as MailAccount[]),
        chatModelOptions().catch(() => ({ provider: "", current: "", options: [] as ChatModelOption[] })),
      ]);
      setTasks(nextTasks);
      setSessions(nextSessions);
      setMailAccounts(nextMailAccounts.filter((account) => account.connected));
      setModelOptions(normalizeModelOptions(nextModels.current, nextModels.options));
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
  }, [projectId, setError]);

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
    if (!selectedTask || !window.confirm(`删除定时任务「${selectedTask.title || selectedTask.id}」？`)) return;
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
        <div className="sched-group-empty">暂无</div>
      ) : (
        items.map((task) => (
          <TaskRow
            active={selectedId === task.id}
            key={task.id}
            task={task}
            sessionName={sessionTitle(task.sessionId, sessions)}
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

  const projectLabel = currentProject?.name || "当前项目";
  const selectedMeta = selectedTask ? triggerMeta(selectedTask) : triggerMeta(form);

  return (
    <div className="sched-page">
      <div className="sched-shell">
        <aside className="sched-sidebar">
          <div className="sched-tabs" role="tablist" aria-label="定时任务视图">
            <button className={pane === "tasks" ? "selected" : ""} onClick={() => setPane("tasks")} type="button">Tasks</button>
            <button className={pane === "templates" ? "selected" : ""} onClick={() => setPane("templates")} type="button">Templates</button>
          </div>

          <div className="sched-sidebar-head">
            <h1>已安排</h1>
            <p>管理周期性任务、提醒和监控</p>
          </div>

          <label className="sched-search">
            <span aria-hidden="true">⌕</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索已安排任务"
            />
          </label>

          <div className="sched-sidebar-content">
            {loading ? (
              <div className="sched-loading">加载中...</div>
            ) : pane === "templates" ? (
              <div className="sched-template-list">
                {TASK_TEMPLATES.map((template) => (
                  <TemplateRow
                    disabled={!canCreate || busy}
                    key={template.id}
                    template={template}
                    onUse={() => applyTemplate(template)}
                  />
                ))}
              </div>
            ) : tasks.length === 0 ? (
              <div className="sched-empty compact">
                <div className="sched-empty-title">暂无定时任务</div>
              </div>
            ) : (
              <>
                {renderTaskGroup("运行中", activeTasks)}
                {renderTaskGroup("已暂停", pausedTasks)}
              </>
            )}
          </div>
        </aside>

        <main className="sched-editor">
          <div className="sched-editor-toolbar">
            <button className="sched-back" onClick={() => setTab("chat")} type="button">返回对话</button>
            <div className="sched-editor-actions">
              <button className="sched-create" disabled={!canCreate || busy} onClick={selectNew} type="button">
                创建计划任务⌄
              </button>
              <button className="sched-icon-button" onClick={() => void refresh()} type="button" aria-label="刷新定时任务">
                ⟳
              </button>
            </div>
          </div>

          {!selectedId ? (
            <div className="sched-detail-empty">
              {canCreate ? "选择或新建任务" : "需要一个已保存的对话"}
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
                placeholder="已安排任务标题"
              />

              <textarea
                className="sched-prompt-input"
                rows={3}
                value={form.prompt}
                onChange={(event) => setForm((current) => ({ ...current, prompt: event.target.value }))}
                placeholder="添加提示词，例如：在 $sentry 中查找崩溃"
              />

              <section className="sched-detail-section">
                <div className="sched-section-title">详情</div>

                <DetailRow label="运行环境" info="后台任务会在当前工作树执行">
                  <span className="sched-static-value" title={currentProject?.path}>工作树</span>
                </DetailRow>

                <DetailRow label="项目">
                  <span className="sched-static-value" title={currentProject?.path}>{projectLabel}</span>
                </DetailRow>

                <DetailRow label="绑定对话">
                  <select
                    className="sched-inline-select"
                    value={form.sessionId}
                    onChange={(event) => setForm((current) => ({ ...current, sessionId: event.target.value }))}
                    required
                  >
                    <option value="" disabled>选择对话</option>
                    {sessionOptions.map((session) => (
                      <option key={session.id} value={session.id}>{session.title}</option>
                    ))}
                  </select>
                </DetailRow>

                <DetailRow label="触发方式">
                  <select
                    className="sched-inline-select"
                    value={form.triggerKind}
                    onChange={(event) => {
                      const triggerKind = isTriggerKind(event.target.value) ? event.target.value : "interval";
                      setForm((current) => ({ ...current, triggerKind }));
                    }}
                  >
                    <option value="interval">按时间间隔</option>
                    <option value="mail">收到新邮件时</option>
                  </select>
                </DetailRow>

                {form.triggerKind === "interval" ? (
                  <DetailRow label="重复次数">
                    <div className="sched-inline-interval">
                      <span>每</span>
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
                        {Object.entries(UNIT_LABELS).map(([value, label]) => (
                          <option key={value} value={value}>{label}</option>
                        ))}
                      </select>
                    </div>
                  </DetailRow>
                ) : (
                  <>
                    <DetailRow label="触发账户">
                      <select
                        className="sched-inline-select"
                        value={form.mailAccountId}
                        onChange={(event) => setForm((current) => ({ ...current, mailAccountId: event.target.value }))}
                      >
                        <option value="">任意已连接邮箱</option>
                        {mailAccounts.map((account) => (
                          <option key={account.id} value={account.id}>{account.email}</option>
                        ))}
                      </select>
                    </DetailRow>

                    <DetailRow label="关键词">
                      <input
                        className="sched-inline-input"
                        value={form.mailKeywords}
                        onChange={(event) => setForm((current) => ({ ...current, mailKeywords: event.target.value }))}
                        placeholder="文献求助, 论文求助"
                      />
                    </DetailRow>
                  </>
                )}

                <DetailRow label="模型">
                  <select
                    className="sched-inline-select"
                    value={form.model}
                    onChange={(event) => setForm((current) => ({ ...current, model: event.target.value }))}
                  >
                    <option value="">跟随当前模型</option>
                    {visibleModelOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </DetailRow>

                <DetailRow label="状态">
                  <div className="sched-status-toggle" role="group" aria-label="任务状态">
                    <button
                      className={form.status === "active" ? "selected" : ""}
                      type="button"
                      onClick={() => setForm((current) => ({ ...current, status: "active" }))}
                    >
                      启动
                    </button>
                    <button
                      className={form.status === "paused" ? "selected" : ""}
                      type="button"
                      onClick={() => setForm((current) => ({ ...current, status: "paused" }))}
                    >
                      暂停
                    </button>
                  </div>
                </DetailRow>
              </section>

              {selectedTask && (
                <div className="sched-run-panel">
                  <div>
                    <span>触发</span>
                    <strong>{selectedMeta.label}</strong>
                  </div>
                  <div>
                    <span>下次执行</span>
                    <strong>{taskStatus(selectedTask) === "paused" ? "已暂停" : formatTaskTime(selectedTask.nextRun)}</strong>
                  </div>
                  <div>
                    <span>上次执行</span>
                    <strong>{formatTaskTime(selectedTask.lastRunAt)}</strong>
                  </div>
                  <div className={selectedTask.lastError ? "error" : ""}>
                    <span>最近错误</span>
                    <strong>{selectedTask.lastError || "无"}</strong>
                  </div>
                </div>
              )}

              <div className="sched-actions">
                <button className="primary" disabled={!canSave || busy} type="submit">保存</button>
                {selectedTask && (
                  <button
                    type="button"
                    disabled={!selectedTask.sessionId}
                    onClick={() => openBoundSession(selectedTask.sessionId)}
                  >
                    查看对话
                  </button>
                )}
                {selectedTask && (
                  <button className="sched-danger" disabled={busy} onClick={() => void handleDelete()} type="button">
                    删除
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
