import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  backgroundProcessStop,
  backgroundProcessesList,
  configGet,
  configSet,
  gitStatus,
  isTauri,
  projectBriefGet,
  type BackgroundProcessView,
  type GitWorkspaceSnapshot,
  type ProjectBriefView,
  type ProjectIntentStatus,
} from "../api/tauri";
import type { Language } from "../store";
import { tr } from "../language";
import { SvgIcon } from "../SvgIcon";
import { subscribeGitWorkspaceStatus } from "../git/workspaceStatusEvents";
import ChatImagePreview from "./ChatImagePreview";
import type { ImageAssistActivity } from "../remote/imageAssistActivity";

const PROJECT_BRIEF_UPDATED_EVENT = "somniq:project-brief-updated";

export function notifyProjectBriefUpdated() {
  window.dispatchEvent(new CustomEvent(PROJECT_BRIEF_UPDATED_EVENT));
}

interface ProjectBriefPreference {
  hidden: boolean;
}

// v2: the summary starts collapsed and opens only when the user clicks the
// toggle. Bumping the key drops v1 records, which were mostly the old
// open-by-default state rather than a deliberate choice.
function preferenceKey(projectId: string) {
  return `somniq-project-brief-v2:${projectId}`;
}

function loadPreference(projectId: string): ProjectBriefPreference {
  try {
    const raw = localStorage.getItem(preferenceKey(projectId));
    if (!raw) return { hidden: true };
    const parsed = JSON.parse(raw) as Partial<ProjectBriefPreference>;
    return { hidden: parsed.hidden !== false };
  } catch {
    return { hidden: true };
  }
}

export function useProjectBrief(projectId?: string | null) {
  const id = projectId ?? "default";
  const [brief, setBrief] = useState<ProjectBriefView | null>(null);
  const [repository, setRepository] = useState<GitWorkspaceSnapshot | null>(null);
  const [preference, setPreference] = useState<ProjectBriefPreference>(() => loadPreference(id));
  const [reviewEnabled, setReviewEnabledState] = useState(false);
  const [reviewSaving, setReviewSaving] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const projectIdRef = useRef(id);
  projectIdRef.current = id;

  const refresh = useCallback(async () => {
    if (!isTauri()) return null;
    const [nextBrief, nextRepository] = await Promise.all([
      projectBriefGet(id).catch(() => null),
      gitStatus().catch(() => null),
    ]);
    if (projectIdRef.current === id) {
      setBrief(nextBrief);
      setRepository(nextRepository);
    }
    return nextBrief;
  }, [id]);

  useEffect(() => {
    setPreference(loadPreference(id));
    setBrief(null);
    setRepository(null);
    void refresh();
  }, [id, refresh]);

  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    void configGet()
      .then((config) => {
        if (active) setReviewEnabledState(config.reviewEnabled === true);
      })
      .catch((error) => {
        if (active) setReviewError(String(error));
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const listener = () => void refresh();
    window.addEventListener(PROJECT_BRIEF_UPDATED_EVENT, listener);
    return () => window.removeEventListener(PROJECT_BRIEF_UPDATED_EVENT, listener);
  }, [refresh]);

  useEffect(() => subscribeGitWorkspaceStatus(setRepository), []);

  useEffect(() => {
    const listener = () => void refresh();
    window.addEventListener("focus", listener);
    return () => window.removeEventListener("focus", listener);
  }, [refresh]);

  const updatePreference = useCallback((patch: Partial<ProjectBriefPreference>) => {
    setPreference((current) => {
      const next = { ...current, ...patch };
      try {
        localStorage.setItem(preferenceKey(id), JSON.stringify(next));
      } catch {
        // The visible in-memory preference still works when storage is blocked.
      }
      return next;
    });
  }, [id]);

  const setHidden = useCallback((hidden: boolean) => updatePreference({ hidden }), [updatePreference]);

  const setReviewEnabled = useCallback(async (enabled: boolean) => {
    setReviewSaving(true);
    setReviewError(null);
    if (!isTauri()) {
      setReviewEnabledState(enabled);
      setReviewSaving(false);
      return;
    }
    try {
      const config = await configSet({ reviewEnabled: enabled });
      setReviewEnabledState(config.reviewEnabled !== false);
    } catch (error) {
      setReviewError(String(error));
    } finally {
      setReviewSaving(false);
    }
  }, []);

  return {
    brief,
    repository,
    hidden: preference.hidden,
    reviewEnabled,
    reviewSaving,
    reviewError,
    refresh,
    setHidden,
    setReviewEnabled,
  };
}

const BACKGROUND_POLL_MS = 3_000;

/** Shell services the agent left running — `run_in_background` commands plus
 * services a shell forked with `&` and the registry adopted. Polled because a
 * background process starts and exits outside any UI event. */
export function useBackgroundProcesses(pollMs: number = BACKGROUND_POLL_MS) {
  const [processes, setProcesses] = useState<BackgroundProcessView[]>([]);
  const [stopping, setStopping] = useState<number[]>([]);

  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    const poll = () => {
      backgroundProcessesList()
        .then((next) => {
          if (active) setProcesses(next);
        })
        .catch(() => {
          if (active) setProcesses([]);
        });
    };
    poll();
    const timer = window.setInterval(poll, pollMs);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [pollMs]);

  const stop = useCallback(async (pid: number) => {
    setStopping((current) => (current.includes(pid) ? current : [...current, pid]));
    try {
      setProcesses(await backgroundProcessStop(pid));
    } catch {
      // Leave the entry in place; the next poll reports what really happened.
    } finally {
      setStopping((current) => current.filter((item) => item !== pid));
    }
  }, []);

  return { processes, stopping, stop };
}

/** The registry's marker for a service a shell forked with `&`. */
const ADOPTED_MARKER = " [left running by the shell]";

/** `bash background: npm run dev` → shell `bash`, command `npm run dev`. The
 * adopted marker becomes a flag so it does not crowd out the command. */
export function describeBackgroundProcess(label: string) {
  const adopted = label.endsWith(ADOPTED_MARKER);
  const base = adopted ? label.slice(0, -ADOPTED_MARKER.length) : label;
  const separator = base.indexOf(": ");
  if (separator < 0) return { shell: "", command: base, adopted };
  return {
    shell: base.slice(0, separator).replace(/ background$/, ""),
    command: base.slice(separator + 2),
    adopted,
  };
}

export function formatElapsed(elapsedMs: number) {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const COPY = {
  cn: {
    title: "项目摘要",
    mission: "项目使命",
    goal: "当前目标",
    criteria: "成功标准",
    status: "最近状态",
    noGoal: "发送第一条实质性请求后，SomniQ 会从你的问题中提炼当前目标。",
    hide: "收回项目摘要",
    collapse: "折叠项目摘要",
    expand: "展开项目摘要",
    active: "进行中",
    paused: "已暂停",
    complete: "已完成",
    review: "自动审核",
    reviewOn: "已开启",
    reviewOff: "已关闭",
    reviewToggle: "切换自动审核",
    reviewHintOn: "实质性任务完成后由独立 Reviewer 核验",
    reviewHintOff: "后续聊天将跳过自动 Reviewer",
    running: "后台运行中",
    runningHint: "由代理启动；退出应用时会连同它启动的子进程一起结束",
    runningStop: "停止",
    runningStopping: "停止中",
    runningLog: "日志",
    runningNoLog: "无输出日志（由 shell 的 & 启动，未重定向）",
    runningAdopted: "shell 遗留",
    repository: "版本状态",
    branch: "分支",
    detached: "游离 HEAD",
    noUpstream: "未关联上游分支",
    clean: "工作区干净",
    changes: "项变更",
    conflicts: "项冲突",
  },
  en: {
    title: "Project summary",
    mission: "Mission",
    goal: "Current goal",
    criteria: "Success criteria",
    status: "Recent status",
    noGoal: "After the first substantive request, SomniQ will summarize the current goal from your question.",
    hide: "Hide project summary",
    collapse: "Collapse project summary",
    expand: "Expand project summary",
    active: "Active",
    paused: "Paused",
    complete: "Complete",
    review: "Automatic review",
    reviewOn: "On",
    reviewOff: "Off",
    reviewToggle: "Toggle automatic review",
    reviewHintOn: "An independent Reviewer checks substantive completed work",
    reviewHintOff: "Future chat turns will skip the automatic Reviewer",
    running: "Running in background",
    runningHint: "Started by the agent; stops with its child processes when the app quits",
    runningStop: "Stop",
    runningStopping: "Stopping…",
    runningLog: "Log",
    runningNoLog: "No output log (started in the background with & and not redirected)",
    runningAdopted: "left by the shell",
    repository: "Version status",
    branch: "Branch",
    detached: "Detached HEAD",
    noUpstream: "No upstream branch",
    clean: "Working tree clean",
    changes: "changes",
    conflicts: "conflicts",
  },
  es: {
    title: "Resumen del proyecto",
    mission: "Misión",
    goal: "Objetivo actual",
    criteria: "Criterios de éxito",
    status: "Estado reciente",
    noGoal: "Tras la primera solicitud sustantiva, SomniQ resumirá el objetivo actual a partir de tu pregunta.",
    hide: "Ocultar el resumen del proyecto",
    collapse: "Contraer el resumen del proyecto",
    expand: "Expandir el resumen del proyecto",
    active: "Activo",
    paused: "En pausa",
    complete: "Completado",
    review: "Revisión automática",
    reviewOn: "Activada",
    reviewOff: "Desactivada",
    reviewToggle: "Activar o desactivar la revisión automática",
    reviewHintOn: "Un Revisor independiente verifica el trabajo sustantivo completado",
    reviewHintOff: "Los próximos turnos del chat omitirán el Revisor automático",
    running: "En ejecución en segundo plano",
    runningHint: "Iniciado por el agente; se detiene junto con sus procesos hijos al cerrar la app",
    runningStop: "Detener",
    runningStopping: "Deteniendo…",
    runningLog: "Registro",
    runningNoLog: "Sin registro de salida (lanzado por la shell con &, sin redirigir)",
    runningAdopted: "dejado por la shell",
    repository: "Estado de versiones",
    branch: "Rama",
    detached: "HEAD separado",
    noUpstream: "Sin rama upstream",
    clean: "Árbol de trabajo limpio",
    changes: "cambios",
    conflicts: "conflictos",
  },
} satisfies Record<Language, Record<string, string>>;

function intentStatusLabel(status: ProjectIntentStatus | undefined, language: Language) {
  return status === "established"
    ? tr(language, "已形成", "Established", "Consolidado")
    : tr(language, "识别中", "Emerging", "En formación");
}

function RowIcon({ kind }: { kind: "mission" | "goal" | "criteria" | "status" | "running" | "git" }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (kind === "mission") return <svg {...common}><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /><path d="M12 2v3M22 12h-3M12 22v-3M2 12h3" /></svg>;
  if (kind === "goal") return <svg {...common}><path d="M5 4h14v16H5z" /><path d="m8 12 2.2 2.2L16 8.5" /></svg>;
  if (kind === "criteria") return <svg {...common}><path d="M8 6h11M8 12h11M8 18h11" /><path d="m3.5 6 .8.8L6 5M3.5 12l.8.8L6 11M3.5 18l.8.8L6 17" /></svg>;
  if (kind === "running") return <svg {...common}><rect x="3" y="4.5" width="18" height="15" rx="2.5" /><path d="m7.5 10 2.5 2-2.5 2M12.5 14h4" /></svg>;
  if (kind === "git") return <svg {...common}><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="9" r="2" /><path d="M6 7v10M8 15c5 0 8-1 8-4" /></svg>;
  return <svg {...common}><path d="M4 18V6M4 18h16" /><path d="m7 14 4-4 3 2 5-6" /></svg>;
}

const IMAGE_ASSIST_STAGE_LABELS: Record<string, Record<Language, string>> = {
  matching: { cn: "正在匹配互助用户", en: "Matching a helper", es: "Buscando a alguien que ayude" },
  sent: { cn: "已发送，等待接受", en: "Sent, awaiting acceptance", es: "Enviado, esperando aceptación" },
  awaiting_approval: { cn: "等待对方接受", en: "Waiting for the helper to accept", es: "Esperando a que la otra persona acepte" },
  awaiting_acceptance: { cn: "等待你确认", en: "Awaiting your approval", es: "Esperando tu aprobación" },
  accepted: { cn: "已接受，正在建立会话", en: "Accepted, connecting", es: "Aceptado, conectando" },
  connecting: { cn: "正在建立临时会话", en: "Setting up a temporary session", es: "Conectando la sesión temporal" },
  connected: { cn: "临时会话已连接", en: "Temporary session connected", es: "Sesión temporal conectada" },
  requesting: { cn: "请求已送达", en: "Request delivered", es: "Solicitud entregada" },
  generating: { cn: "正在生成图片", en: "Generating image", es: "Generando imagen" },
  transferring: { cn: "正在安全回传图片", en: "Returning image securely", es: "Devolviendo la imagen de forma segura" },
  completed: { cn: "图片已传回", en: "Image received", es: "Imagen recibida" },
  declined: { cn: "请求被拒绝", en: "Request declined", es: "Solicitud rechazada" },
  failed: { cn: "图片互助失败", en: "Image assist failed", es: "Image Assist falló" },
  closed: { cn: "图片互助已结束", en: "Image assist ended", es: "Image Assist finalizado" },
};

function imageName(path: string) {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function transferSize(bytes: number, language: Language) {
  if (bytes < 1024) return tr(language, `${bytes} 字节`, `${bytes} B`, `${bytes} B`);
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || Number.isInteger(value) ? 0 : 1)} ${units[unit]}`;
}

export default function ProjectBriefCard({
  brief,
  repository,
  language,
  onHide,
  reviewEnabled,
  reviewSaving,
  reviewError,
  onReviewEnabledChange,
  agentTasks,
  glances,
  backgroundProcesses = [],
  stoppingBackgroundPids = [],
  onStopBackgroundProcess,
  onOpenBackgroundLog,
  imageAssistActivity,
  onDismissImageAssistActivity,
}: {
  /** Null before the first substantive request; the card can still be shown
   * for background processes alone. */
  brief: ProjectBriefView | null;
  repository?: GitWorkspaceSnapshot | null;
  language: Language;
  onHide: () => void;
  reviewEnabled: boolean;
  reviewSaving?: boolean;
  reviewError?: string | null;
  onReviewEnabledChange: (enabled: boolean) => void;
  agentTasks?: ReactNode;
  /** Plugin glances (the `chat.brief` slot). */
  glances?: ReactNode;
  backgroundProcesses?: BackgroundProcessView[];
  stoppingBackgroundPids?: number[];
  onStopBackgroundProcess?: (pid: number) => void;
  onOpenBackgroundLog?: (path: string) => void;
  imageAssistActivity?: ImageAssistActivity | null;
  onDismissImageAssistActivity?: () => void;
}) {
  const copy = COPY[language];
  const labels = tr(language, {
      goal: "长期目标",
      milestone: "当前里程碑",
      status: "最近进展",
      coreFocus: "当前核心工作",
      relatedWork: "相关工作",
      drift: "偏离主线",
      reviewCoverage: (conversations: number, questions: number, messages: number) =>
        `Reviewer 按上下文 Token 增量复核 · 已覆盖 ${conversations} 个对话、${questions} 次提问，共 ${messages} 条可见消息`,
      noGoal: "SomniQ 正在从持续对话中识别本项目的长期目标。",
    }, {
      goal: "Long-term goal",
      milestone: "Current milestone",
      status: "Recent progress",
      coreFocus: "Current core work",
      relatedWork: "Related work",
      drift: "Off the main line",
      reviewCoverage: (conversations: number, questions: number, messages: number) =>
        `Incremental Reviewer update by context tokens · ${conversations} conversations, ${questions} questions, ${messages} visible messages`,
      noGoal: "SomniQ is identifying this project's long-term goal from your ongoing conversations.",
    }, {
      goal: "Objetivo a largo plazo",
      milestone: "Hito actual",
      status: "Progreso reciente",
      coreFocus: "Trabajo principal actual",
      relatedWork: "Trabajo relacionado",
      drift: "Fuera de la línea principal",
      reviewCoverage: (conversations: number, questions: number, messages: number) =>
        `Revisión incremental del Revisor por tokens de contexto · ${conversations} conversaciones, ${questions} preguntas, ${messages} mensajes visibles`,
      noGoal: "SomniQ está identificando el objetivo a largo plazo de este proyecto a partir de tus conversaciones.",
    });
  const intent = brief?.intent ?? null;
  const activity = brief?.activity ?? null;
  const milestone = brief?.goal ?? null;
  const running = backgroundProcesses;
  const transferTotal = imageAssistActivity?.transferTotalBytes ?? 0;
  const transferReceived = Math.min(imageAssistActivity?.transferReceivedBytes ?? 0, transferTotal);
  const transferProgress = transferTotal > 0 ? Math.round((transferReceived / transferTotal) * 100) : 0;
  const isTransferring = imageAssistActivity?.stage === "transferring" && transferTotal > 0;
  const transferIsSending = imageAssistActivity?.transferDirection === "sending";
  return (
    <section className="project-brief-card" aria-label={copy.title}>
      <div className="project-brief-head">
        <div className="project-brief-heading">
          <RowIcon kind="goal" />
          <span className="project-brief-title">{copy.title}</span>
        </div>
        {intent && <span className={`project-brief-status ${intent.status}`}>{intentStatusLabel(intent.status, language)}</span>}
        <button type="button" className="project-brief-hide" onClick={onHide} title={copy.hide} aria-label={copy.hide}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3.5" y="4" width="17" height="16" rx="2.5" />
            <path d="M15.5 4v16M11.5 9l-3 3 3 3" />
          </svg>
        </button>
      </div>
      <div className="project-brief-review-control">
        <div className="project-brief-review-copy">
          <strong>{copy.review}</strong>
          <small>{reviewEnabled ? copy.reviewHintOn : copy.reviewHintOff}</small>
          {reviewError && <small className="project-brief-review-error" role="alert">{reviewError}</small>}
        </div>
        <button
          type="button"
          role="switch"
          className={`project-brief-review-switch${reviewEnabled ? " enabled" : ""}`}
          aria-checked={reviewEnabled}
          aria-label={copy.reviewToggle}
          title={reviewEnabled ? copy.reviewOn : copy.reviewOff}
          disabled={reviewSaving}
          onClick={() => onReviewEnabledChange(!reviewEnabled)}
        >
          <span className="project-brief-review-switch-track" aria-hidden="true">
            <span />
          </span>
          <span>{reviewSaving ? "…" : reviewEnabled ? copy.reviewOn : copy.reviewOff}</span>
        </button>
      </div>
      {glances}
      <div className="project-brief-body">
        {agentTasks}
        {imageAssistActivity && (
          <section className={`project-brief-image-assist is-${imageAssistActivity.stage}`} aria-label={tr(language, "图片互助", "Image assist", "Image Assist")}>
            <div className="project-brief-image-assist-head">
              <span className="project-brief-image-assist-icon" aria-hidden="true">
                <SvgIcon name={imageAssistActivity.stage === "completed" ? "check" : "image"} size={14} />
              </span>
              <div>
                <strong>{IMAGE_ASSIST_STAGE_LABELS[imageAssistActivity.stage]?.[language] ?? (tr(language, "图片互助处理中", "Image assist in progress", "Image Assist en curso"))}</strong>
                {imageAssistActivity.detail && <small>{imageAssistActivity.detail}</small>}
              </div>
              <button
                type="button"
                className="project-brief-image-assist-dismiss"
                onClick={onDismissImageAssistActivity}
                aria-label={tr(language, "关闭图片互助记录", "Dismiss image assist record", "Cerrar registro de Image Assist")}
                title={tr(language, "关闭记录，不会中断传输", "Dismiss record without interrupting transfer", "Cerrar el registro sin interrumpir la transferencia")}
              >
                <SvgIcon name="close" size={14} />
              </button>
            </div>
            {imageAssistActivity.prompt && (
              <p className="project-brief-image-assist-prompt" title={imageAssistActivity.prompt}>
                {imageAssistActivity.prompt}
              </p>
            )}
            <div className="project-brief-image-assist-meta">
              {imageAssistActivity.aspectRatio && <span>{tr(language, `比例 ${imageAssistActivity.aspectRatio}`, imageAssistActivity.aspectRatio, imageAssistActivity.aspectRatio)}</span>}
              {imageAssistActivity.matchId && <code>{`#${imageAssistActivity.matchId.slice(0, 8)}`}</code>}
            </div>
            {isTransferring && (
              <div className="project-brief-image-assist-transfer">
                <progress value={transferReceived} max={transferTotal} aria-label={tr(language, "图片回传进度", "Image return progress", "Progreso de devolución de imágenes")} />
                <div>
                  <span>{tr(language, `${transferIsSending ? "已发送" : "已接收"} ${transferSize(transferReceived, language)} / ${transferSize(transferTotal, language)} · ${transferProgress}%`, `${transferSize(transferReceived, language)} / ${transferSize(transferTotal, language)} ${transferIsSending ? "sent" : "received"} · ${transferProgress}%`, `${transferSize(transferReceived, language)} / ${transferSize(transferTotal, language)} ${transferIsSending ? "enviados" : "recibidos"} · ${transferProgress}%`)}</span>
                  {imageAssistActivity.transferArtifactCount != null && imageAssistActivity.transferCompletedArtifacts != null && (
                    <small>{tr(language, `${imageAssistActivity.transferCompletedArtifacts} / ${imageAssistActivity.transferArtifactCount} 张`, `${imageAssistActivity.transferCompletedArtifacts} / ${imageAssistActivity.transferArtifactCount} images`, `${imageAssistActivity.transferCompletedArtifacts} / ${imageAssistActivity.transferArtifactCount} imágenes`)}</small>
                  )}
                </div>
              </div>
            )}
            {imageAssistActivity.images && imageAssistActivity.images.length > 0 && (
              <div className="project-brief-image-assist-results" aria-label={tr(language, "已传回图片", "Received images", "Imágenes recibidas")}>
                {imageAssistActivity.images.map((path) => (
                  <ChatImagePreview
                    key={path}
                    src={path}
                    openPath={path}
                    title={tr(language, `打开 ${imageName(path)}`, `Open ${imageName(path)}`, `Abrir ${imageName(path)}`)}
                    alt={tr(language, "已传回的图片", "Received image", "Imagen recibida")}
                    className="project-brief-image-assist-thumbnail"
                  />
                ))}
              </div>
            )}
          </section>
        )}
        {repository?.isRepository && (
          <div className="project-brief-row project-brief-git">
            <RowIcon kind="git" />
            <div>
              <span>{copy.repository}</span>
              <div className="project-brief-git-branch">
                <strong>{repository.detached ? copy.detached : (repository.branch ?? copy.branch)}</strong>
                <small>{repository.upstream ?? copy.noUpstream}</small>
              </div>
              <div className="project-brief-git-facts">
                {(repository.ahead > 0 || repository.behind > 0) && (
                  <small>{`↑${repository.ahead} ↓${repository.behind}`}</small>
                )}
                <small>{repository.files.length > 0 ? `${repository.files.length} ${copy.changes}` : copy.clean}</small>
                {repository.hasConflicts && (
                  <small className="conflict">{`${repository.files.filter((file) => file.conflicted).length} ${copy.conflicts}`}</small>
                )}
              </div>
            </div>
          </div>
        )}
        {running.length > 0 && (
          <div className="project-brief-row project-brief-running">
            <RowIcon kind="running" />
            <div>
              <span>{`${copy.running} · ${running.length}`}</span>
              <ul aria-label={copy.running}>
                {running.map((process) => {
                  const { shell, command, adopted } = describeBackgroundProcess(process.label);
                  const stopping = stoppingBackgroundPids.includes(process.pid);
                  const meta = [
                    shell,
                    formatElapsed(process.elapsedMs),
                    adopted ? copy.runningAdopted : "",
                  ].filter(Boolean).join(" · ");
                  return (
                    <li key={process.pid} title={`PID ${process.pid} · ${process.label}`}>
                      <em aria-hidden="true" />
                      <code>{command}</code>
                      <small>{meta}</small>
                      <div className="project-brief-running-actions">
                        {process.logPath
                          ? (
                            <button
                              type="button"
                              onClick={() => onOpenBackgroundLog?.(process.logPath ?? "")}
                              title={process.logPath}
                            >
                              {copy.runningLog}
                            </button>
                          )
                          : <span title={copy.runningNoLog}>—</span>}
                        <button
                          type="button"
                          className="project-brief-running-stop"
                          disabled={stopping}
                          onClick={() => onStopBackgroundProcess?.(process.pid)}
                        >
                          {stopping ? copy.runningStopping : copy.runningStop}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <small className="project-brief-running-hint">{copy.runningHint}</small>
            </div>
          </div>
        )}
        {brief && (
          <div className="project-brief-row">
            <RowIcon kind="mission" />
            <div><span>{copy.mission}</span><p>{brief.mission}</p></div>
          </div>
        )}
        {activity && (
          <div className="project-brief-row project-brief-activity">
            <RowIcon kind="status" />
            <div>
              <span>{labels.coreFocus}</span>
              <p>{activity.coreFocus}</p>
              {activity.relatedWork.length > 0 && (
                <>
                  <span className="project-brief-related-label">{labels.relatedWork}</span>
                  <ul>{activity.relatedWork.map((item) => <li key={item}>{item}</li>)}</ul>
                </>
              )}
              {activity.drift && (
                <div className="project-brief-drift" role="status">
                  <span className="project-brief-related-label">{labels.drift}</span>
                  <p>{activity.drift.evidence}</p>
                  <p className="project-brief-drift-suggestion">{activity.drift.suggestion}</p>
                </div>
              )}
              <small
                className="project-brief-coverage"
                title={`${activity.reviewer}\n${activity.reviewedAt}`}
              >
                {labels.reviewCoverage(
                  activity.conversationCount,
                  activity.questionCount ?? 0,
                  activity.messageCount,
                )}
              </small>
            </div>
          </div>
        )}
        {brief && (
          <div className="project-brief-row">
            <RowIcon kind="goal" />
            <div><span>{labels.goal}</span><p>{intent?.objective ?? labels.noGoal}</p></div>
          </div>
        )}
        {milestone && (
          <>
            <div className="project-brief-row">
              <RowIcon kind="criteria" />
              <div><span>{labels.milestone}</span><p>{milestone.objective}</p></div>
            </div>
            <div className="project-brief-row">
              <RowIcon kind="criteria" />
              <div>
                <span>{copy.criteria}</span>
                {milestone.successCriteria.length > 0 ? (
                  <ul className="project-brief-criteria">
                    {milestone.successCriteria.map((criterion, index) => {
                      const verification = milestone.verifiedCriteria?.find((item) => item.criterionIndex === index);
                      return (
                        <li key={criterion} className={verification ? "verified" : "pending"}>
                          <span aria-hidden="true"><SvgIcon name={verification ? "check" : "circle"} size={12} /></span>
                          <span>{criterion}</span>
                          {verification && <small title={verification.evidence.join("\n")}>{verification.reviewer}</small>}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p>{tr(language, "尚未记录可核验的成功标准", "No verifiable success criteria recorded", "No hay criterios de éxito verificables registrados")}</p>
                )}
              </div>
            </div>
            <div className="project-brief-row">
              <RowIcon kind="status" />
              <div><span>{labels.status}</span><p>{milestone.recentStatus}</p></div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
