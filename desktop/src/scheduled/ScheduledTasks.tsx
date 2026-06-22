import { useCallback, useEffect, useMemo, useState } from "react";
import {
  chatUiSessionsLoad,
  isTauri,
  scheduledTaskCreate,
  scheduledTaskDelete,
  scheduledTasksList,
  scheduledTaskSetStatus,
  scheduledTaskUpdate,
  sessionsList,
} from "../api/tauri";
import type { ChatSession } from "../chat/types";
import { useStore } from "../store";
import type { ScheduledTask, ScheduledTaskInput, SessionSummary } from "../types";

type IntervalUnit = ScheduledTaskInput["intervalUnit"];
type TaskStatus = NonNullable<ScheduledTaskInput["status"]>;

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
}

const UNIT_LABELS: Record<IntervalUnit, string> = {
  minutes: "分钟",
  hours: "小时",
  days: "天",
};

const DEFAULT_INTERVAL = 15;

function shortId(id: string) {
  return id.length > 18 ? `${id.slice(0, 18)}...` : id;
}

function isIntervalUnit(value: string | undefined): value is IntervalUnit {
  return value === "minutes" || value === "hours" || value === "days";
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
  };
}

function formToInput(form: FormState): ScheduledTaskInput {
  return {
    title: form.title.trim(),
    prompt: form.prompt.trim(),
    sessionId: form.sessionId,
    intervalValue: Math.max(1, Math.floor(form.intervalValue || 1)),
    intervalUnit: form.intervalUnit,
    status: form.status,
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
}: {
  active: boolean;
  task: ScheduledTask;
  sessionName: string;
  onSelect: () => void;
  onStatus: (status: TaskStatus) => void;
}) {
  const paused = taskStatus(task) === "paused";
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
        <span className="sched-row-title">{task.title || "未命名任务"}</span>
        <span className="sched-row-schedule">{task.scheduleLabel || task.rrule}</span>
        <span className="sched-row-id">{sessionName}</span>
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
  const projectId = useStore((s) => s.currentProject?.id);
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [sessions, setSessions] = useState<SessionOption[]>([]);
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
  const canSave = form.prompt.trim().length > 0 && form.sessionId.trim().length > 0 && form.intervalValue > 0;

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
      const [nextTasks, nextSessions] = await Promise.all([
        scheduledTasksList(),
        loadSessionOptions(projectId),
      ]);
      setTasks(nextTasks);
      setSessions(nextSessions);
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
                    placeholder="写下 Aris 到时间后要在该对话里继续执行的任务"
                  />
                </label>

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
