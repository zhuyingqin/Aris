import { useCallback, useEffect, useMemo, useState } from "react";
import {
  chatUiSessionsLoad,
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
import type { MailAccount, ScheduledTask, ScheduledTaskInput, SessionSummary } from "../types";

type IntervalUnit = ScheduledTaskInput["intervalUnit"];
type TaskStatus = NonNullable<ScheduledTaskInput["status"]>;
type TriggerKind = NonNullable<ScheduledTaskInput["triggerKind"]>;

interface SessionOption {
  id: string;
  title: string;
  updatedAt: number;
}

interface FormState {
  title: string;
  prompt: string;
  sessionId: string;
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

// Editable workflow templates. They only pre-fill the form below — the user can
// freely change the prompt, interval, and bound session before saving, and the
// saved task is a plain scheduled task. This is how the literature-mail-reply
// flow is decoupled from the mailbox: it becomes a timer-driven prompt that any
// connected provider (Gmail/Outlook/IMAP) honours, not a hardcoded event hook.
const TASK_TEMPLATES: TaskTemplate[] = [
  {
    id: "literature-mail-on-arrival",
    label: "新邮件触发·论文求助回复",
    description:
      "每当收到含「文献求助/论文求助」等关键词的新邮件时，自动检索并回复 PDF（仅 IMAP 账户支持事件触发）。",
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
    description:
      "按间隔扫描收件箱中的文献/论文求助邮件并回复 PDF（适用于所有邮箱，含 Gmail/Outlook）。",
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

function triggerMeta(task: ScheduledTask): { kind: "interval" | "mail"; label: string } {
  return task.triggerKind === "mail"
    ? { kind: "mail", label: "邮件" }
    : { kind: "interval", label: "间隔" };
}

function TriggerIcon({ kind }: { kind: "interval" | "mail" }) {
  if (kind === "mail") {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="m3 7 9 6 9-6" />
      </svg>
    );
  }
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
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
  const uiSessions = await chatUiSessionsLoad<ChatSession>().catch(() => []);
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

function Row({
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
      <span className={`sched-dot${paused ? " paused" : " active"}`} aria-hidden="true" />
      <div className="sched-row-main">
        <span className="sched-row-titleline">
          <span className={`sched-trigger-tag ${meta.kind}`}>
            <TriggerIcon kind={meta.kind} />
            {meta.label}
          </span>
          <span className="sched-row-title">{task.title || "未命名任务"}</span>
        </span>
        <span className="sched-row-schedule">{task.scheduleLabel || task.rrule}</span>
        <span className={task.lastError ? "sched-row-run error" : "sched-row-run"}>{runSummary(task)}</span>
        <button
          type="button"
          className="sched-row-open"
          disabled={!task.sessionId}
          title="查看该任务运行的对话记录"
          onClick={(event) => {
            event.stopPropagation();
            onOpenChat();
          }}
        >
          {sessionName} ›
        </button>
      </div>
      <button
        className={`sched-badge${paused ? " paused" : " active"}`}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onStatus(paused ? "active" : "paused");
        }}
      >
        {paused ? "启动" : "暂停"}
      </button>
    </div>
  );
}

export default function ScheduledTasks() {
  const setTab = useStore((s) => s.setTab);
  const setError = useStore((s) => s.setError);
  const setPendingSessionViewId = useStore((s) => s.setPendingSessionViewId);
  const projectId = useStore((s) => s.currentProject?.id);
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [sessions, setSessions] = useState<SessionOption[]>([]);
  const [mailAccounts, setMailAccounts] = useState<MailAccount[]>([]);
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

  const canCreate = sessions.length > 0;
  const canSave =
    form.prompt.trim().length > 0 &&
    form.sessionId.trim().length > 0 &&
    (form.triggerKind === "mail" || form.intervalValue > 0);

  const refresh = useCallback(async () => {
    if (!isTauri()) {
      setTasks([]);
      setSessions([]);
      setSelectedId(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [nextTasks, nextSessions, nextMailAccounts] = await Promise.all([
        scheduledTasksList(),
        loadSessionOptions(projectId),
        mailAccountsGet().catch(() => [] as MailAccount[]),
      ]);
      setTasks(nextTasks);
      setSessions(nextSessions);
      setMailAccounts(nextMailAccounts.filter((account) => account.connected));
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
    if (selectedId === "new") {
      setForm(emptyForm(sessions[0]?.id ?? ""));
      return;
    }
    if (selectedTask) {
      setForm(taskToForm(selectedTask, sessions[0]?.id ?? ""));
      return;
    }
    setForm(emptyForm(sessions[0]?.id ?? ""));
  }, [selectedId, selectedTask, sessions]);

  const selectNew = () => {
    if (!canCreate) return;
    setSelectedId("new");
  };

  const openBoundSession = (sessionId: string | null | undefined) => {
    if (!sessionId) return;
    setPendingSessionViewId(sessionId);
    setTab("sessions");
  };

  const applyTemplate = (template: TaskTemplate) => {
    setForm((current) => ({
      ...current,
      title: template.title,
      prompt: template.prompt,
      triggerKind: template.triggerKind,
      intervalValue: template.intervalValue,
      intervalUnit: template.intervalUnit,
      mailKeywords: template.mailKeywords ?? "",
    }));
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

  return (
    <div className="sched-page">
      <div className="sched-head">
        <button className="sched-back" onClick={() => setTab("chat")} type="button">← 返回对话</button>
        <div className="sched-head-row">
          <div>
            <h1 className="sched-title">定时任务</h1>
            <p className="sched-sub">{tasks.length} 个任务 · {sessions.length} 个可绑定对话</p>
          </div>
          <button className="primary" disabled={!canCreate || busy} onClick={selectNew} type="button">
            新建任务
          </button>
        </div>
      </div>

      {loading ? (
        <div className="sched-empty">加载中…</div>
      ) : (
        <div className="sched-shell">
          <div className="sched-list-pane">
            {tasks.length === 0 ? (
              <div className="sched-empty compact">
                <div className="sched-empty-title">暂无定时任务</div>
              </div>
            ) : (
              <div className="sched-list">
                {tasks.map((task) => (
                  <Row
                    active={selectedId === task.id}
                    key={task.id}
                    task={task}
                    sessionName={sessionTitle(task.sessionId, sessions)}
                    onSelect={() => setSelectedId(task.id)}
                    onStatus={(status) => void handleStatus(task, status)}
                    onOpenChat={() => openBoundSession(task.sessionId)}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="sched-detail">
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
                <div className="sched-detail-head">
                  <div>
                    <div className="sched-detail-kicker">{selectedId === "new" ? "新任务" : shortId(selectedId)}</div>
                    <h2>{form.title.trim() || "未命名任务"}</h2>
                  </div>
                  {selectedId !== "new" && (
                    <button
                      className={form.status === "paused" ? "sched-status paused" : "sched-status active"}
                      type="button"
                      onClick={() => {
                        if (selectedTask) void handleStatus(selectedTask, form.status === "paused" ? "active" : "paused");
                      }}
                    >
                      {form.status === "paused" ? "启动" : "暂停"}
                    </button>
                  )}
                </div>

                {selectedId === "new" && TASK_TEMPLATES.length > 0 && (
                  <div className="sched-templates">
                    <span className="sched-templates-label">从模板新建</span>
                    <div className="sched-templates-row">
                      {TASK_TEMPLATES.map((template) => (
                        <button
                          key={template.id}
                          type="button"
                          className="sched-template-chip"
                          title={template.description}
                          onClick={() => applyTemplate(template)}
                        >
                          {template.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {selectedTask && (
                  <div className="sched-run-panel">
                    <div className="sched-run-item">
                      <span>下次执行</span>
                      <strong>{taskStatus(selectedTask) === "paused" ? "已暂停" : formatTaskTime(selectedTask.nextRun)}</strong>
                    </div>
                    <div className="sched-run-item">
                      <span>上次执行</span>
                      <strong>{formatTaskTime(selectedTask.lastRunAt)}</strong>
                    </div>
                    <div className={selectedTask.lastError ? "sched-run-error visible" : "sched-run-error"}>
                      <span>最近错误</span>
                      <strong>{selectedTask.lastError || "无"}</strong>
                    </div>
                  </div>
                )}

                <label className="sched-field">
                  <span>任务名称</span>
                  <input
                    value={form.title}
                    onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
                    placeholder="例如：检查签证预约"
                  />
                </label>

                <label className="sched-field">
                  <span>绑定对话</span>
                  <select
                    value={form.sessionId}
                    onChange={(event) => setForm((current) => ({ ...current, sessionId: event.target.value }))}
                    required
                  >
                    <option value="" disabled>选择对话</option>
                    {sessionOptions.map((session) => (
                      <option key={session.id} value={session.id}>{session.title}</option>
                    ))}
                  </select>
                </label>

                <label className="sched-field">
                  <span>执行内容</span>
                  <textarea
                    rows={6}
                    value={form.prompt}
                    onChange={(event) => setForm((current) => ({ ...current, prompt: event.target.value }))}
                    placeholder="写下 SomniQ 到时间后要在该对话里继续执行的任务"
                  />
                </label>

                <div className="sched-field">
                  <span>触发方式</span>
                  <div className="sched-status-toggle" role="group" aria-label="触发方式">
                    <button
                      className={form.triggerKind === "interval" ? "selected" : ""}
                      type="button"
                      onClick={() => setForm((current) => ({ ...current, triggerKind: "interval" }))}
                    >
                      按时间间隔
                    </button>
                    <button
                      className={form.triggerKind === "mail" ? "selected" : ""}
                      type="button"
                      onClick={() => setForm((current) => ({ ...current, triggerKind: "mail" }))}
                    >
                      收到新邮件时
                    </button>
                  </div>
                </div>

                {form.triggerKind === "interval" ? (
                  <div className="sched-field">
                    <span>间隔</span>
                    <div className="sched-interval">
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
                  </div>
                ) : (
                  <>
                    <label className="sched-field">
                      <span>触发账户</span>
                      <select
                        value={form.mailAccountId}
                        onChange={(event) => setForm((current) => ({ ...current, mailAccountId: event.target.value }))}
                      >
                        <option value="">任意已连接邮箱</option>
                        {mailAccounts.map((account) => (
                          <option key={account.id} value={account.id}>
                            {account.email}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="sched-field">
                      <span>关键词过滤（可选，逗号分隔）</span>
                      <input
                        value={form.mailKeywords}
                        onChange={(event) => setForm((current) => ({ ...current, mailKeywords: event.target.value }))}
                        placeholder="留空 = 任意新邮件都触发；例如：文献求助, 论文求助"
                      />
                    </label>

                    <p className="sched-hint">
                      事件触发目前仅对 IMAP 邮箱生效（Gmail/Outlook 请用「按时间间隔」轮询）。
                    </p>
                  </>
                )}

                <div className="sched-field">
                  <span>状态</span>
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
                </div>

                <div className="sched-actions">
                  <button className="primary" disabled={!canSave || busy} type="submit">保存</button>
                  {selectedTask && (
                    <button
                      type="button"
                      disabled={!selectedTask.sessionId}
                      onClick={() => openBoundSession(selectedTask.sessionId)}
                    >
                      查看对话记录
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
          </div>
        </div>
      )}
    </div>
  );
}
