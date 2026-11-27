// A plugin page asked for a background work task. The page drew nothing of
// this: the app draws it, says which package asked, lets the user edit the
// request, and only the user's click creates or starts the task. The page is
// told the outcome and nothing else.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { workTaskCreate, workTaskCreateAndStart } from "../api/tauri";
import type { Language } from "../store";
import { tr } from "../language";
import "./PluginTaskProposal.css";

export const MAX_TASK_TITLE_CHARS = 120;
export const MAX_TASK_PROMPT_CHARS = 8000;
/** How long the proposal is shown before it can be accepted. */
export const TASK_PROPOSAL_ARM_MS = 600;

export interface TaskProposal {
  pluginName: string;
  /** The page panel that asked. Recorded on the task so the page can follow it. */
  pageId: string;
  panelTitle: string;
  title: string;
  prompt: string;
  /** Where the finished task writes its conclusion, already checked against the panel. */
  report?: { panelId: string; widgetId: string; widgetType: string };
}
export type TaskOutcome = { status: "started" | "created"; taskId: string } | { status: "declined" };

/**
 * The task's prompt as the board runs it: the page's request, then what the
 * host itself vouches for. The provenance line is written here, never by the
 * page, so a task always says where it came from.
 */
export function taskPrompt(proposal: TaskProposal, prompt: string, language: Language): string {
  const lines = [prompt.trim(), "", "---",
    tr(
      language,
      `来源：插件 ${proposal.pluginName} 的页面「${proposal.panelTitle}」提议了这个任务，用户在 SomniQ 中确认创建。`,
      `Origin: proposed by the page "${proposal.panelTitle}" of plugin ${proposal.pluginName}; the user confirmed it in SomniQ.`,
      `Origen: propuesta por la página "${proposal.panelTitle}" del plugin ${proposal.pluginName}; el usuario la confirmó en SomniQ.`,
    )];
  if (proposal.report) {
    const { panelId, widgetId, widgetType } = proposal.report;
    lines.push(tr(
      language,
      `完成后：先用 PluginPanel 工具的 list 查看插件 ${proposal.pluginName} 面板 ${panelId} 的组件 ${widgetId}（${widgetType}）需要的值形状，再用 write 把本任务的结论写进去。结论要简短、只写有证据支持的内容，并标明未核实的部分。`,
      `When done: use the PluginPanel tool's list to see the value shape of widget ${widgetId} (${widgetType}) on panel ${panelId} of plugin ${proposal.pluginName}, then write this task's conclusion there with write. Keep it short, state only what the evidence supports, and mark what stayed unverified.`,
      `Al terminar: usa list de la herramienta PluginPanel para ver la forma del valor del widget ${widgetId} (${widgetType}) en el panel ${panelId} del plugin ${proposal.pluginName}, y luego escribe ahí la conclusión de esta tarea con write. Sé breve, indica solo lo que respalda la evidencia y marca lo que quedó sin verificar.`,
    ));
  }
  return lines.join("\n");
}

const COPY = {
  cn: {
    heading: "插件提议了一个后台任务",
    from: "来自", title: "任务标题", prompt: "任务内容", report: "完成后写回",
    note: "任务在独立的工作副本中运行：它改动的文件要等你在待办任务看板上验收后才会合入项目；写回本页的结论会直接显示。本页能看到这个任务的进度、审查结论和改动清单。",
    effects: "只有文件要等验收。任务调用的插件工具（MCP）和命令会立刻在这台电脑上生效，例如启动或停止服务、访问网络，不会等你验收，也撤不回。任务按你设置的默认权限运行，权限不够时这些工具会被拒绝。",
    start: "创建并开始", create: "只创建", decline: "不创建", busy: "正在创建…",
  },
  en: {
    heading: "A plugin proposes a background task",
    from: "From", title: "Task title", prompt: "Task", report: "Reports back to",
    note: "The task runs in its own working copy: files it changes reach the project only after you accept them on the task board; a conclusion it writes back to this page shows up right away. This page can follow the task's progress, review verdict and list of changes.",
    effects: "Only files wait for your acceptance. The plugin tools (MCP) and commands the task calls take effect on this computer right away, such as starting or stopping a service or reaching the network; they do not wait for you and cannot be undone. The task runs with your default permission mode, and those tools are refused when it does not allow them.",
    start: "Create and start", create: "Create only", decline: "Decline", busy: "Creating…",
  },
  es: {
    heading: "Un plugin propone una tarea en segundo plano",
    from: "De", title: "Título de la tarea", prompt: "Tarea", report: "Informa a",
    note: "La tarea se ejecuta en su propia copia de trabajo: los archivos que cambie llegan al proyecto solo cuando los aceptes en el tablero de tareas; la conclusión que escriba en esta página aparece al instante. Esta página puede seguir el progreso de la tarea, el veredicto de la revisión y la lista de cambios.",
    effects: "Solo los archivos esperan tu aceptación. Las herramientas del plugin (MCP) y los comandos que use la tarea surten efecto en este equipo al momento, como iniciar o detener un servicio o acceder a la red; no esperan por ti ni se pueden deshacer. La tarea se ejecuta con tu modo de permisos predeterminado y esas herramientas se rechazan si no lo permite.",
    start: "Crear e iniciar", create: "Solo crear", decline: "Rechazar", busy: "Creando…",
  },
};

export default function PluginTaskProposal({ proposal, language, onDone }: {
  proposal: TaskProposal; language: Language; onDone: (outcome: TaskOutcome) => void;
}) {
  const copy = COPY[language];
  const [title, setTitle] = useState(proposal.title);
  const [prompt, setPrompt] = useState(proposal.prompt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The page chose when this appears, so the safe answer has the focus: a key
  // the user was already pressing elsewhere declines, never starts a task.
  // Creating is possible only after a moment, so a click aimed at the page
  // cannot land on it either.
  const first = useRef<HTMLButtonElement>(null);
  const [armed, setArmed] = useState(false);
  const done = useRef(onDone); done.current = onDone;
  useEffect(() => { first.current?.focus(); }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => setArmed(true), TASK_PROPOSAL_ARM_MS);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) done.current({ status: "declined" }); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [busy]);

  const valid = title.trim().length > 0 && title.length <= MAX_TASK_TITLE_CHARS && prompt.trim().length > 0 && prompt.length <= MAX_TASK_PROMPT_CHARS;
  const create = async (start: boolean) => {
    if (!valid || busy) return;
    setBusy(true); setError("");
    try {
      const full = taskPrompt(proposal, prompt, language);
      const origin = {
        pluginName: proposal.pluginName,
        panelId: proposal.pageId,
        reportPanel: proposal.report?.panelId ?? null,
        reportWidget: proposal.report?.widgetId ?? null,
      };
      const task = start ? await workTaskCreateAndStart(title.trim(), full, null, origin) : await workTaskCreate(title.trim(), full, null, origin);
      done.current({ status: start ? "started" : "created", taskId: task.id });
    } catch (failure) {
      setError(String(failure));
      setBusy(false);
    }
  };

  return createPortal(
    <div className="plugin-task-backdrop">
      <section className="plugin-task-dialog" role="dialog" aria-modal="true" aria-labelledby="plugin-task-heading">
        <h2 id="plugin-task-heading">{copy.heading}</h2>
        <p className="plugin-task-from">{copy.from} <strong>{proposal.pluginName}</strong> · {proposal.panelTitle}</p>
        <label>{copy.title}
          <input value={title} maxLength={MAX_TASK_TITLE_CHARS} onChange={(event) => setTitle(event.target.value)} disabled={busy} />
        </label>
        <label>{copy.prompt}
          <textarea value={prompt} rows={8} maxLength={MAX_TASK_PROMPT_CHARS} onChange={(event) => setPrompt(event.target.value)} disabled={busy} />
        </label>
        {proposal.report && <p className="plugin-task-report">{copy.report}: <code>{proposal.report.panelId} · {proposal.report.widgetId}</code></p>}
        <p className="plugin-task-note">{copy.note}</p>
        {/* The working copy contains files, not what tools do: said as plainly as the line above. */}
        <p className="plugin-task-note plugin-task-effects" role="note">{copy.effects}</p>
        {error && <p className="plugin-task-error" role="alert">{error}</p>}
        <footer>
          <button ref={first} type="button" className="plugin-task-secondary" onClick={() => done.current({ status: "declined" })} disabled={busy}>{copy.decline}</button>
          <button type="button" className="plugin-task-secondary" onClick={() => void create(false)} disabled={!armed || !valid || busy}>{copy.create}</button>
          <button type="button" className="plugin-task-primary" onClick={() => void create(true)} disabled={!armed || !valid || busy}>{busy ? copy.busy : copy.start}</button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
