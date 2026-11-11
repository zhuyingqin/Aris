import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  chatModelOptions,
  chatUiSessionsList,
  isTauri,
  mailAccountsGet,
  onScheduledTasksChanged,
  onWorkTaskChanged,
  scheduledTaskCreate,
  scheduledTaskDelete,
  scheduledTaskHistory,
  scheduledTaskPreview,
  scheduledTaskRunNow,
  scheduledTasksList,
  scheduledTaskSetStatus,
  scheduledTaskUpdate,
  sessionsList,
} from "../api/tauri";
import type { ChatSession } from "../chat/types";
import { useStore, type Language } from "../store";
import { SvgIcon } from "../SvgIcon";
import type {
  ChatModelOption,
  MailAccount,
  ScheduleKind,
  ScheduleMissedPolicy,
  ScheduledDeliveryHistory,
  ScheduledTask,
  ScheduledTaskInput,
  ScheduleTargetMode,
  SessionSummary,
} from "../types";
import { DeliveryHistory } from "./DeliveryHistory";
import { describeScheduledError } from "./errorText";
import { SCHEDULED_TASKS_COPY, type TaskTemplate } from "./i18n";
import {
  COMMON_TIME_ZONES,
  deviceTimeZone,
  formatInZone,
  nextWholeHourInZone,
  supportedTimeZones,
} from "./scheduleFormat";

type ScheduledTasksCopy = (typeof SCHEDULED_TASKS_COPY)["cn"];

type IntervalUnit = ScheduledTaskInput["intervalUnit"];
type TaskStatus = NonNullable<ScheduledTaskInput["status"]>;
type TriggerKind = NonNullable<ScheduledTaskInput["triggerKind"]>;
type Pane = "tasks" | "templates";
type FilterTab = "all" | "active" | "paused";

const SCHEDULE_KINDS: ScheduleKind[] = ["once", "interval", "cron", "rrule"];
const TARGET_MODES: ScheduleTargetMode[] = ["session", "new_once", "new"];
const MISSED_POLICIES: ScheduleMissedPolicy[] = ["run_latest", "skip"];
const PREVIEW_DEBOUNCE_MS = 250;

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
  scheduleKind: ScheduleKind;
  timeZone: string;
  /** datetime-local value on `timeZone`'s wall clock. */
  startLocal: string;
  cron: string;
  rrule: string;
  missedPolicy: ScheduleMissedPolicy;
  targetMode: ScheduleTargetMode;
}

interface PreviewState {
  timeZone: string;
  occurrences: string[];
  error: string | null;
}

const DEFAULT_INTERVAL = 15;
const DEFAULT_CRON = "0 9 * * 1-5";
const DEFAULT_RRULE = "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0";

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

function isIntervalUnit(value: string | undefined): value is IntervalUnit {
  return value === "minutes" || value === "hours" || value === "days";
}

function isScheduleKind(value: string | undefined): value is ScheduleKind {
  return SCHEDULE_KINDS.includes(value as ScheduleKind);
}

function isTargetMode(value: string | undefined): value is ScheduleTargetMode {
  return TARGET_MODES.includes(value as ScheduleTargetMode);
}

function isMissedPolicy(value: string | undefined): value is ScheduleMissedPolicy {
  return MISSED_POLICIES.includes(value as ScheduleMissedPolicy);
}

/** `schedule` on the wire; v1 rows still say `interval`. */
function triggerOf(task: { triggerKind?: string }): TriggerKind {
  return task.triggerKind === "mail" ? "mail" : "schedule";
}

/** What the row and the status filters show. */
function displayStatus(task: ScheduledTask): "active" | "paused" | "ended" {
  if (task.status === "paused") return "paused";
  if (task.status === "ended") return "ended";
  return "active";
}

/** The form's status. An ended task saved with a new rule becomes active. */
function taskStatus(task: ScheduledTask): TaskStatus {
  return task.status === "paused" ? "paused" : "active";
}

function shortId(id: string) {
  return id.length > 18 ? `${id.slice(0, 18)}...` : id;
}

function intervalLabel(value: number, unit: IntervalUnit, copy: ScheduledTasksCopy) {
  return copy.everyInterval(Math.max(1, Math.floor(value || 1)), copy.unitLabels[unit]);
}

function scheduleSummary(task: ScheduledTask, copy: ScheduledTasksCopy) {
  if (triggerOf(task) === "mail") return copy.mailTrigger;
  switch (task.scheduleKind) {
    case "once":
      return copy.onceSummary((task.startLocal ?? "").replace("T", " "));
    case "cron":
      return copy.cronSummary(task.cron ?? "");
    case "rrule":
      return copy.rruleSummary(task.rruleRule ?? task.rrule ?? "");
    default:
      return task.intervalValue
        ? intervalLabel(task.intervalValue, isIntervalUnit(task.intervalUnit) ? task.intervalUnit : "minutes", copy)
        : (task.scheduleLabel || copy.intervalTrigger);
  }
}

function runSummary(task: ScheduledTask, copy: ScheduledTasksCopy, language: Language) {
  const status = displayStatus(task);
  if (status === "paused") return copy.paused;
  if (status === "ended") return copy.ended;
  if (task.scheduleError) return copy.scheduleErrorLabel;
  if (task.lastError) return copy.lastRunFailed;
  if (task.waitingReason) return copy.waitingForPrevious;
  const zone = task.timeZone;
  const format = (value: string | null | undefined) =>
    formatInZone(value, zone, language, { withZone: false }) ?? copy.noValue;
  if (triggerOf(task) === "mail") {
    return task.lastRunAt ? copy.lastRunAt(format(task.lastRunAt)) : copy.waitingForMail;
  }
  if (task.nextRun) return copy.nextRunAt(format(task.nextRun));
  if (task.lastRunAt) return copy.lastRunAt(format(task.lastRunAt));
  return copy.waitingFirstRun;
}

function emptyForm(sessionId = "", zone = deviceTimeZone()): FormState {
  return {
    title: "",
    prompt: "",
    sessionId,
    model: "",
    intervalValue: DEFAULT_INTERVAL,
    intervalUnit: "minutes",
    status: "active",
    triggerKind: "schedule",
    mailAccountId: "",
    mailKeywords: "",
    scheduleKind: "interval",
    timeZone: zone,
    startLocal: "",
    cron: DEFAULT_CRON,
    rrule: DEFAULT_RRULE,
    missedPolicy: "run_latest",
    targetMode: sessionId ? "session" : "new_once",
  };
}

function taskToForm(task: ScheduledTask, fallbackSessionId = ""): FormState {
  const kind = isScheduleKind(task.scheduleKind) ? task.scheduleKind : "interval";
  const targetMode = isTargetMode(task.targetMode) ? task.targetMode : "session";
  return {
    title: task.title ?? "",
    prompt: task.prompt ?? "",
    sessionId: targetMode === "session" ? (task.sessionId ?? fallbackSessionId) : fallbackSessionId,
    model: task.model ?? "",
    intervalValue: task.intervalValue && task.intervalValue > 0
      ? task.intervalValue
      : DEFAULT_INTERVAL,
    intervalUnit: isIntervalUnit(task.intervalUnit) ? task.intervalUnit : "minutes",
    status: taskStatus(task),
    triggerKind: triggerOf(task),
    mailAccountId: task.mailAccountId ?? "",
    mailKeywords: (task.mailKeywords ?? []).join(", "),
    scheduleKind: kind,
    timeZone: task.timeZone || deviceTimeZone(),
    startLocal: task.startLocal ?? "",
    cron: task.cron || DEFAULT_CRON,
    rrule: task.rruleRule || DEFAULT_RRULE,
    missedPolicy: isMissedPolicy(task.missedPolicy) ? task.missedPolicy : "run_latest",
    targetMode,
  };
}

function templateToForm(template: TaskTemplate, fallbackSessionId = ""): FormState {
  const base = emptyForm(fallbackSessionId);
  return {
    ...base,
    title: template.title,
    prompt: template.prompt,
    triggerKind: template.triggerKind,
    intervalValue: template.intervalValue,
    intervalUnit: template.intervalUnit,
    scheduleKind: template.scheduleKind ?? "interval",
    cron: template.cron ?? base.cron,
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

function formToInput(form: FormState, projectId?: string | null): ScheduledTaskInput {
  const isMail = form.triggerKind === "mail";
  return {
    title: form.title.trim(),
    prompt: form.prompt.trim(),
    sessionId: form.targetMode === "session" ? form.sessionId : "",
    model: form.model.trim(),
    intervalValue: Math.max(1, Math.floor(form.intervalValue || 1)),
    intervalUnit: form.intervalUnit,
    status: form.status,
    triggerKind: form.triggerKind,
    mailAccountId: isMail ? form.mailAccountId.trim() : "",
    mailKeywords: isMail ? parseKeywords(form.mailKeywords) : [],
    scheduleKind: form.scheduleKind,
    timeZone: form.timeZone.trim(),
    startLocal: form.startLocal.trim() || undefined,
    cron: form.scheduleKind === "cron" ? form.cron.trim() : undefined,
    rrule: form.scheduleKind === "rrule" ? form.rrule.trim() : undefined,
    missedPolicy: form.missedPolicy,
    targetMode: form.targetMode,
    projectId: projectId ?? undefined,
  };
}

/** The rule fields a save needs, before the backend says whether they parse. */
function timingComplete(form: FormState) {
  if (form.triggerKind === "mail") return true;
  if (!form.timeZone.trim()) return false;
  switch (form.scheduleKind) {
    case "once":
      return form.startLocal.trim().length > 0;
    case "cron":
      return form.cron.trim().length > 0;
    case "rrule":
      return form.rrule.trim().length > 0;
    default:
      return form.intervalValue > 0;
  }
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

function targetLabel(task: ScheduledTask, sessions: SessionOption[], copy: ScheduledTasksCopy) {
  const mode = isTargetMode(task.targetMode) ? task.targetMode : "session";
  return mode === "session" ? sessionTitle(task.sessionId, sessions, copy) : copy.targetModes[mode];
}

/** A reserved or per-delivery conversation exists only once a run used it. */
function canOpenTarget(task: ScheduledTask) {
  if (!task.sessionId) return false;
  const mode = isTargetMode(task.targetMode) ? task.targetMode : "session";
  return mode === "session" || Boolean(task.lastDelivery?.workTaskId);
}

function modelLabel(model: string | null | undefined, copy: ScheduledTasksCopy) {
  return model?.trim() || copy.followCurrentModel;
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
  targetName,
  copy,
  language,
  onSelect,
  onStatus,
  onOpenChat,
}: {
  active: boolean;
  task: ScheduledTask;
  targetName: string;
  copy: ScheduledTasksCopy;
  language: Language;
  onSelect: () => void;
  onStatus: (status: TaskStatus) => void;
  onOpenChat: () => void;
}) {
  const status = displayStatus(task);
  const stopped = status !== "active";
  const isMail = triggerOf(task) === "mail";
  const triggerText = scheduleSummary(task, copy);
  const faulted = Boolean(task.lastError || task.scheduleError);

  return (
    <div
      className={`sched-task-card${active ? " selected" : ""}${stopped ? " is-paused" : ""}${faulted ? " has-error" : ""}`}
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
        <div
          className="sched-task-status-light"
          title={status === "ended" ? copy.statusEnded : status === "paused" ? copy.statusPaused : (faulted ? copy.statusError : copy.statusActive)}
        >
          <span className={`status-dot ${stopped ? "paused" : (faulted ? "error" : "active")}`} />
        </div>
        <div className="sched-task-card-title" title={task.title || copy.untitledTask}>
          {task.title || copy.untitledTask}
        </div>
        <div className="sched-task-actions">
          <button
            className={`sched-action-pill ${stopped ? "start" : "pause"}`}
            type="button"
            title={stopped ? copy.start : copy.pause}
            onClick={(event) => {
              event.stopPropagation();
              onStatus(stopped ? "active" : "paused");
            }}
          >
            <SvgIcon name={stopped ? "play" : "stop"} size={11} />
            <span>{stopped ? copy.start : copy.pause}</span>
          </button>
          <button
            className="sched-action-icon"
            type="button"
            disabled={!canOpenTarget(task)}
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
        <span className="sched-chip trigger" title={isMail ? triggerText : `${triggerText} · ${task.timeZone ?? ""}`}>
          <SvgIcon name={isMail ? "inbox" : "clock"} size={11} />
          <span>{triggerText}</span>
        </span>
        <span className="sched-chip chat" title={targetName}>
          <SvgIcon name="notebook" size={11} />
          <span>{targetName}</span>
        </span>
        <span className="sched-chip model" title={modelLabel(task.model, copy)}>
          <SvgIcon name="sparkle" size={11} />
          <span>{modelLabel(task.model, copy)}</span>
        </span>
      </div>

      <div className="sched-task-card-footer">
        <span className={faulted ? "sched-run-summary error" : "sched-run-summary"} title={describeScheduledError(task.waitingReason ?? task.lastError ?? task.scheduleError, language) || undefined}>
          <SvgIcon name={faulted ? "warning" : "clock"} size={12} />
          <span>{runSummary(task, copy, language)}</span>
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
    : template.scheduleKind === "cron" && template.cron
      ? copy.cronSummary(template.cron)
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

/** The rule's next occurrences on its own zone's wall clock, offsets shown. */
function UpcomingList({
  preview,
  copy,
  language,
  inBrowser,
}: {
  preview: PreviewState | null;
  copy: ScheduledTasksCopy;
  language: Language;
  inBrowser: boolean;
}) {
  if (inBrowser) return <p className="sched-preview-note">{copy.previewUnavailable}</p>;
  if (!preview) return <p className="sched-preview-note">{copy.loading}</p>;
  if (preview.error) return <p className="sched-preview-error" role="alert">{preview.error}</p>;
  if (preview.occurrences.length === 0) return <p className="sched-preview-note">{copy.upcomingEmpty}</p>;
  return (
    <div className="sched-upcoming">
      <ol className="sched-upcoming-list" aria-label={copy.upcomingLabel}>
        {preview.occurrences.map((occurrence) => (
          <li key={occurrence}>{formatInZone(occurrence, preview.timeZone, language, { withYear: true })}</li>
        ))}
      </ol>
      <span className="sched-preview-note">{copy.upcomingInZone(preview.timeZone)}</span>
    </div>
  );
}

export default function ScheduledTasks({
  onOpenSession,
}: {
  /** Bring a conversation into view in Chat. Without it the page can only
   *  switch to the Chat tab. */
  onOpenSession?: (sessionId: string, title: string) => void;
} = {}) {
  const setTab = useStore((s) => s.setTab);
  const setError = useStore((s) => s.setError);
  const currentProject = useStore((s) => s.currentProject);
  const language = useStore((s) => s.language);
  const copy = SCHEDULED_TASKS_COPY[language];
  const projectId = currentProject?.id;
  const inBrowser = !isTauri();
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
  const [toast, setToast] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [history, setHistory] = useState<ScheduledDeliveryHistory | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyRevision, setHistoryRevision] = useState(0);
  const toastTimer = useRef<number | null>(null);
  const zoneOptions = useMemo(() => supportedTimeZones(), []);
  const localZone = useMemo(() => deviceTimeZone(), []);

  const selectedTask = selectedId && selectedId !== "new"
    ? tasks.find((task) => task.id === selectedId) ?? null
    : null;

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2500);
  }, []);

  useEffect(() => () => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
  }, []);

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
      const status = displayStatus(task);
      if (filterTab === "active" && status !== "active") return false;
      if (filterTab === "paused" && status === "active") return false;

      if (!term) return true;
      const haystack = [
        task.title,
        task.prompt,
        task.scheduleLabel,
        task.rrule,
        task.cron,
        task.timeZone,
        task.model,
        (task.mailKeywords ?? []).join(" "),
        sessionTitle(task.sessionId, sessions, copy),
      ].join(" ").toLowerCase();
      return haystack.includes(term);
    });
  }, [copy, filterTab, query, sessions, tasks]);

  const activeCount = useMemo(() => tasks.filter((task) => displayStatus(task) === "active").length, [tasks]);
  const pausedCount = useMemo(() => tasks.filter((task) => displayStatus(task) !== "active").length, [tasks]);

  const canCreate = sessions.length > 0 || Boolean(currentProject);
  const previewBlocks = form.triggerKind === "schedule" && Boolean(preview?.error);
  const canSave =
    form.prompt.trim().length > 0 &&
    (form.targetMode !== "session" || form.sessionId.trim().length > 0) &&
    timingComplete(form) &&
    !previewBlocks;

  const refresh = useCallback(async (silent = false) => {
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
    if (!silent) setLoading(true);
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
      if (!silent) setLoading(false);
    }
  }, [copy, projectId, setError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A run being queued (by the timer, a mail, or Run now) and a work task
  // changing state both change what this page shows; neither is worth a
  // spinner, so these refreshes are silent.
  useEffect(() => {
    if (!isTauri()) return;
    // Work-task events include every running card's heartbeat; coalesce them
    // so an open history is re-read at most once a second and a half.
    let pending: number | null = null;
    const bumpHistory = () => {
      if (pending !== null) return;
      pending = window.setTimeout(() => {
        pending = null;
        setHistoryRevision((value) => value + 1);
      }, 1_500);
    };
    const stops: Array<Promise<() => void>> = [
      onScheduledTasksChanged(() => {
        void refresh(true);
        setHistoryRevision((value) => value + 1);
      }),
      onWorkTaskChanged(bumpHistory),
    ];
    return () => {
      if (pending !== null) window.clearTimeout(pending);
      for (const stop of stops) void stop.then((unlisten) => unlisten());
    };
  }, [refresh]);

  useEffect(() => {
    if (selectedId === "new") return;
    if (selectedTask) {
      setForm(taskToForm(selectedTask, sessions[0]?.id ?? ""));
      return;
    }
    setForm(emptyForm(sessions[0]?.id ?? ""));
  }, [selectedId, selectedTask, sessions]);

  const selectedTaskId = selectedTask?.id ?? null;
  useEffect(() => {
    if (!selectedTaskId || !isTauri()) {
      setHistory(null);
      return;
    }
    let active = true;
    setHistoryLoading(true);
    scheduledTaskHistory(selectedTaskId)
      .then((next) => {
        if (active) setHistory(next);
      })
      .catch((error) => {
        if (active) setError(String(error));
      })
      .finally(() => {
        if (active) setHistoryLoading(false);
      });
    return () => {
      active = false;
    };
  }, [historyRevision, selectedTaskId, setError]);

  // Live preview of the rule being edited, computed by the backend so the
  // editor and the runner can never disagree about when it fires.
  const previewKey = JSON.stringify([
    form.triggerKind,
    form.scheduleKind,
    form.timeZone,
    form.startLocal,
    form.cron,
    form.rrule,
    form.intervalValue,
    form.intervalUnit,
  ]);
  useEffect(() => {
    // Nothing to preview until a form is on screen: before the first load the
    // form is a placeholder, and its "next runs" would describe no task.
    if (!isTauri() || !selectedId || form.triggerKind !== "schedule" || !timingComplete(form)) {
      setPreview(null);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      scheduledTaskPreview(formToInput(form, projectId))
        .then((result) => {
          if (active) setPreview({ timeZone: result.timeZone, occurrences: result.occurrences, error: null });
        })
        .catch((error) => {
          if (active) setPreview({ timeZone: form.timeZone, occurrences: [], error: String(error) });
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
    // `previewKey` is the timing half of the form; the rest does not move
    // occurrences.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey, projectId, selectedId]);

  const selectNew = () => {
    if (!canCreate) return;
    setForm(emptyForm(sessions[0]?.id ?? ""));
    setSelectedId("new");
    setPane("tasks");
  };

  const openSession = (sessionId: string | null | undefined, title?: string) => {
    if (!sessionId) return;
    if (onOpenSession) {
      onOpenSession(sessionId, title || copy.sessionFallbackTitle(shortId(sessionId)));
      return;
    }
    setTab("chat");
  };

  const applyTemplate = (template: TaskTemplate) => {
    if (!canCreate) return;
    setForm(templateToForm(template, sessions[0]?.id ?? ""));
    setSelectedId("new");
    setPane("tasks");
  };

  const setScheduleKind = (kind: ScheduleKind) => {
    setForm((current) => ({
      ...current,
      scheduleKind: kind,
      // A one-shot needs a time; start from the next whole hour in its zone.
      startLocal: kind === "once" && !current.startLocal
        ? nextWholeHourInZone(current.timeZone || localZone)
        : current.startLocal,
    }));
  };

  const handleSave = async () => {
    if (!canSave) return;
    setBusy(true);
    try {
      const input = formToInput(form, projectId);
      const saved = selectedId && selectedId !== "new"
        ? await scheduledTaskUpdate(selectedId, input)
        : await scheduledTaskCreate(input);
      setTasks((previous) => addOrReplaceTask(previous, saved));
      setSelectedId(saved.id);
      setPane("tasks");
      showToast(copy.noErrorValue);
    } catch (error) {
      setError(describeScheduledError(String(error), language));
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

  const handleRunNow = async () => {
    if (!selectedTask) return;
    setBusy(true);
    try {
      const saved = await scheduledTaskRunNow(selectedTask.id);
      setTasks((previous) => addOrReplaceTask(previous, saved));
      setHistoryRevision((value) => value + 1);
      showToast(copy.runNowDone);
    } catch (error) {
      setError(describeScheduledError(String(error), language));
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSave, busy, form]);

  const addPresetKeyword = (kw: string) => {
    const currentList = parseKeywords(form.mailKeywords);
    if (!currentList.includes(kw)) {
      const next = currentList.length > 0 ? `${form.mailKeywords.trim()}, ${kw}` : kw;
      setForm((cur) => ({ ...cur, mailKeywords: next }));
    }
  };

  const projectLabel = currentProject?.name || copy.currentProjectFallback;
  const selectedIsMail = selectedTask ? triggerOf(selectedTask) === "mail" : form.triggerKind === "mail";
  const selectedStatus = selectedTask ? displayStatus(selectedTask) : "active";
  const quickZones = [localZone, ...COMMON_TIME_ZONES.filter((zone) => zone !== localZone)].slice(0, 5);
  const reservedSession = selectedTask && selectedTask.targetMode === "new_once" && canOpenTarget(selectedTask)
    ? selectedTask.sessionId
    : null;

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
                    targetName={targetLabel(task, sessions, copy)}
                    copy={copy}
                    language={language}
                    onSelect={() => {
                      setSelectedId(task.id);
                      setPane("tasks");
                    }}
                    onStatus={(status) => void handleStatus(task, status)}
                    onOpenChat={() => openSession(task.sessionId, task.title)}
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
              {toast && (
                <div className="sched-toast success">
                  <SvgIcon name="check" size={13} />
                  <span>{toast}</span>
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
                      <span className="metric-icon trigger"><SvgIcon name={selectedIsMail ? "inbox" : "clock"} size={14} /></span>
                      <span className="metric-title">{copy.runPanelTriggerLabel}</span>
                    </div>
                    <div className="sched-metric-val" title={selectedTask.timeZone}>
                      {scheduleSummary(selectedTask, copy)}
                    </div>
                  </div>

                  <div className="sched-metric-item">
                    <div className="sched-metric-head">
                      <span className="metric-icon next"><SvgIcon name="clock" size={14} /></span>
                      <span className="metric-title">{copy.nextRunLabel}</span>
                    </div>
                    <div className="sched-metric-val" title={selectedTask.waitingReason ?? undefined}>
                      {selectedStatus === "paused"
                        ? copy.paused
                        : selectedStatus === "ended"
                          ? copy.ended
                          : selectedIsMail
                            ? copy.waitingForMail
                            : (formatInZone(selectedTask.nextRun, selectedTask.timeZone, language) ?? copy.noValue)}
                    </div>
                  </div>

                  <div className="sched-metric-item">
                    <div className="sched-metric-head">
                      <span className="metric-icon last"><SvgIcon name="check" size={14} /></span>
                      <span className="metric-title">{copy.lastRunLabel}</span>
                    </div>
                    <div className="sched-metric-val">
                      {formatInZone(selectedTask.lastRunAt, selectedTask.timeZone, language, { withZone: false }) ?? copy.noValue}
                    </div>
                  </div>

                  <div className={`sched-metric-item${selectedTask.lastError || selectedTask.scheduleError ? " is-error" : " is-healthy"}`}>
                    <div className="sched-metric-head">
                      <span className="metric-icon health">
                        <SvgIcon name={selectedTask.lastError || selectedTask.scheduleError ? "warning" : "shieldCheck"} size={14} />
                      </span>
                      <span className="metric-title">{copy.lastErrorLabel}</span>
                    </div>
                    <div
                      className="sched-metric-val"
                      title={describeScheduledError(selectedTask.scheduleError || selectedTask.lastError || selectedTask.waitingReason, language) || copy.noErrorValue}
                    >
                      {selectedTask.scheduleError
                        ? copy.scheduleErrorLabel
                        : selectedTask.lastError
                          ? copy.statusError
                          : selectedTask.waitingReason
                            ? copy.waitingForPrevious
                            : copy.noErrorValue}
                    </div>
                  </div>
                </div>
              )}
              {/* The reason itself, readable without hovering: "last run
                  failed" alone does not tell the user what to fix. */}
              {selectedTask && !selectedTask.scheduleError && (selectedTask.lastError || selectedTask.waitingReason) && (
                <p className="sched-history-error" role="status" data-testid="sched-error-detail">
                  {describeScheduledError(selectedTask.lastError || selectedTask.waitingReason, language)}
                </p>
              )}

              {/* Group 1: Trigger & Schedule Rules */}
              <DetailCard title={copy.triggerSection} icon="clock">
                <DetailRow label={copy.triggerLabel}>
                  <div className="sched-segmented-control" role="radiogroup">
                    <button
                      className={form.triggerKind === "schedule" ? "selected" : ""}
                      type="button"
                      onClick={() => setForm((current) => ({ ...current, triggerKind: "schedule" }))}
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

                {form.triggerKind === "schedule" ? (
                  <>
                    <DetailRow label={copy.ruleKindLabel}>
                      <div className="sched-segmented-control" role="radiogroup" aria-label={copy.ruleKindLabel}>
                        {SCHEDULE_KINDS.map((kind) => (
                          <button
                            aria-checked={form.scheduleKind === kind}
                            className={form.scheduleKind === kind ? "selected" : ""}
                            key={kind}
                            onClick={() => setScheduleKind(kind)}
                            role="radio"
                            type="button"
                          >
                            <span>{copy.ruleKinds[kind]}</span>
                          </button>
                        ))}
                      </div>
                    </DetailRow>

                    <DetailRow label={copy.timeZoneLabel} info={copy.timeZoneInfo}>
                      <div className="sched-zone-control">
                        <input
                          aria-label={copy.timeZoneLabel}
                          className="sched-text-control"
                          list="sched-time-zones"
                          value={form.timeZone}
                          onChange={(event) => setForm((current) => ({ ...current, timeZone: event.target.value }))}
                          placeholder={copy.timeZonePlaceholder}
                          spellCheck={false}
                        />
                        <datalist id="sched-time-zones">
                          {zoneOptions.map((zone) => <option key={zone} value={zone} />)}
                        </datalist>
                        <div className="sched-preset-chips">
                          {quickZones.map((zone) => (
                            <button
                              className={`sched-preset-chip${form.timeZone === zone ? " active" : ""}`}
                              key={zone}
                              onClick={() => setForm((current) => ({ ...current, timeZone: zone }))}
                              type="button"
                            >
                              {zone === localZone ? copy.timeZoneLocal(zone) : zone}
                            </button>
                          ))}
                        </div>
                      </div>
                    </DetailRow>

                    {form.scheduleKind === "once" && (
                      <DetailRow label={copy.onceAtLabel}>
                        <input
                          aria-label={copy.onceAtLabel}
                          className="sched-text-control"
                          type="datetime-local"
                          value={form.startLocal}
                          onChange={(event) => setForm((current) => ({ ...current, startLocal: event.target.value }))}
                        />
                      </DetailRow>
                    )}

                    {form.scheduleKind === "interval" && (
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

                        <DetailRow label={copy.startAtLabel} info={copy.startAtOptional}>
                          <input
                            aria-label={copy.startAtLabel}
                            className="sched-text-control"
                            type="datetime-local"
                            value={form.startLocal}
                            onChange={(event) => setForm((current) => ({ ...current, startLocal: event.target.value }))}
                          />
                        </DetailRow>
                      </>
                    )}

                    {form.scheduleKind === "cron" && (
                      <DetailRow label={copy.cronLabel} info={copy.cronHint}>
                        <input
                          aria-label={copy.cronLabel}
                          className="sched-text-control sched-mono"
                          value={form.cron}
                          onChange={(event) => setForm((current) => ({ ...current, cron: event.target.value }))}
                          placeholder={copy.cronPlaceholder}
                          spellCheck={false}
                        />
                      </DetailRow>
                    )}

                    {form.scheduleKind === "rrule" && (
                      <>
                        <DetailRow label={copy.rruleLabel} info={copy.rruleHint}>
                          <textarea
                            aria-label={copy.rruleLabel}
                            className="sched-text-control sched-mono"
                            rows={2}
                            value={form.rrule}
                            onChange={(event) => setForm((current) => ({ ...current, rrule: event.target.value }))}
                            placeholder={copy.rrulePlaceholder}
                            spellCheck={false}
                          />
                        </DetailRow>
                        <DetailRow label={copy.rruleStartLabel}>
                          <input
                            aria-label={copy.rruleStartLabel}
                            className="sched-text-control"
                            type="datetime-local"
                            value={form.startLocal}
                            onChange={(event) => setForm((current) => ({ ...current, startLocal: event.target.value }))}
                          />
                        </DetailRow>
                      </>
                    )}

                    <DetailRow label={copy.upcomingLabel}>
                      <UpcomingList preview={preview} copy={copy} language={language} inBrowser={inBrowser} />
                    </DetailRow>

                    <DetailRow label={copy.missedPolicyLabel} info={copy.missedPolicyInfo}>
                      <select
                        aria-label={copy.missedPolicyLabel}
                        className="sched-select-control"
                        value={form.missedPolicy}
                        onChange={(event) => {
                          const policy = isMissedPolicy(event.target.value) ? event.target.value : "run_latest";
                          setForm((current) => ({ ...current, missedPolicy: policy }));
                        }}
                      >
                        {MISSED_POLICIES.map((policy) => (
                          <option key={policy} value={policy}>{copy.missedPolicies[policy]}</option>
                        ))}
                      </select>
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
                <DetailRow label={copy.targetModeLabel} info={copy.targetModeInfo}>
                  <div className="sched-segmented-control" role="radiogroup" aria-label={copy.targetModeLabel}>
                    {TARGET_MODES.map((mode) => (
                      <button
                        aria-checked={form.targetMode === mode}
                        className={form.targetMode === mode ? "selected" : ""}
                        key={mode}
                        onClick={() => setForm((current) => ({
                          ...current,
                          targetMode: mode,
                          sessionId: mode === "session" && !current.sessionId ? (sessions[0]?.id ?? "") : current.sessionId,
                        }))}
                        role="radio"
                        type="button"
                      >
                        <span>{copy.targetModes[mode]}</span>
                      </button>
                    ))}
                  </div>
                </DetailRow>

                {form.targetMode === "session" ? (
                  <DetailRow label={copy.boundChatLabel}>
                    <div className="sched-flex-control">
                      <select
                        aria-label={copy.boundChatLabel}
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
                          onClick={() => openSession(form.sessionId, sessionTitle(form.sessionId, sessions, copy))}
                          title={copy.jumpToSession}
                        >
                          <SvgIcon name="externalLink" size={13} />
                          <span>{copy.jumpToSession}</span>
                        </button>
                      )}
                    </div>
                  </DetailRow>
                ) : (
                  <DetailRow label={copy.boundChatLabel}>
                    <div className="sched-flex-control">
                      <p className="sched-note">
                        {form.targetMode === "new_once"
                          ? copy.targetNewOnceNote(projectLabel)
                          : copy.targetNewNote(projectLabel)}
                      </p>
                      {form.targetMode === "new_once" && reservedSession && (
                        <button
                          className="sched-btn-secondary"
                          type="button"
                          onClick={() => openSession(reservedSession, selectedTask?.title)}
                          title={copy.jumpToSession}
                        >
                          <SvgIcon name="externalLink" size={13} />
                          <span>{copy.jumpToSession}</span>
                        </button>
                      )}
                    </div>
                  </DetailRow>
                )}

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
                <p className="sched-note">{copy.reviewerNote}</p>
              </DetailCard>

              {/* Group 3: Delivery records, joined to the work tasks they produced */}
              {selectedTask && (
                <DetailCard title={copy.historySection} icon="document">
                  <DeliveryHistory
                    history={history}
                    loading={historyLoading}
                    timeZone={selectedTask.timeZone || localZone}
                    language={language}
                    copy={copy}
                    onOpenSession={(sessionId) => openSession(sessionId, selectedTask.title)}
                  />
                </DetailCard>
              )}

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
                      disabled={busy || inBrowser}
                      onClick={() => void handleRunNow()}
                      type="button"
                    >
                      <SvgIcon name="play" size={12} />
                      <span>{copy.runNowButton}</span>
                    </button>
                  )}
                  {selectedTask && (
                    <button
                      className="sched-btn-secondary"
                      type="button"
                      disabled={!canOpenTarget(selectedTask)}
                      onClick={() => openSession(selectedTask.sessionId, selectedTask.title)}
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
