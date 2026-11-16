// A plugin page asked for a background work task. The page drew nothing of
// this: the app draws it, says which package asked, lets the user edit the
// request, and only the user's click creates or starts the task. The page is
// told the outcome and nothing else.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { workTaskCreate, workTaskCreateAndStart } from "../api/tauri";
import type { Language } from "../store";
import "./PluginTaskProposal.css";

export const MAX_TASK_TITLE_CHARS = 120;
export const MAX_TASK_PROMPT_CHARS = 8000;

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
  const cn = language === "cn";
  const lines = [prompt.trim(), "", "---",
    cn ? `来源：插件 ${proposal.pluginName} 的页面「${proposal.panelTitle}」提议了这个任务，用户在 SomniQ 中确认创建。`
      : `Origin: proposed by the page "${proposal.panelTitle}" of plugin ${proposal.pluginName}; the user confirmed it in SomniQ.`];
  if (proposal.report) {
    const { panelId, widgetId, widgetType } = proposal.report;
    lines.push(cn
      ? `完成后：先用 PluginPanel 工具的 list 查看插件 ${proposal.pluginName} 面板 ${panelId} 的组件 ${widgetId}（${widgetType}）需要的值形状，再用 write 把本任务的结论写进去。结论要简短、只写有证据支持的内容，并标明未核实的部分。`
      : `When done: use the PluginPanel tool's list to see the value shape of widget ${widgetId} (${widgetType}) on panel ${panelId} of plugin ${proposal.pluginName}, then write this task's conclusion there with write. Keep it short, state only what the evidence supports, and mark what stayed unverified.`);
  }
  return lines.join("\n");
}

const COPY = {
  cn: {
    heading: "插件提议了一个后台任务",
    from: "来自", title: "任务标题", prompt: "任务内容", report: "完成后写回",
    note: "任务在独立的工作副本中运行：它改动的文件要等你在待办任务看板上验收后才会合入项目；写回本页的结论会直接显示。本页能看到这个任务的进度、审查结论和改动清单。",
    start: "创建并开始", create: "只创建", decline: "不创建", busy: "正在创建…",
  },
  en: {
    heading: "A plugin proposes a background task",
    from: "From", title: "Task title", prompt: "Task", report: "Reports back to",
    note: "The task runs in its own working copy: files it changes reach the project only after you accept them on the task board; a conclusion it writes back to this page shows up right away. This page can follow the task's progress, review verdict and list of changes.",
    start: "Create and start", create: "Create only", decline: "Decline", busy: "Creating…",
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
  const first = useRef<HTMLButtonElement>(null);
  const done = useRef(onDone); done.current = onDone;
  useEffect(() => { first.current?.focus(); }, []);
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
        {error && <p className="plugin-task-error" role="alert">{error}</p>}
        <footer>
          <button type="button" className="plugin-task-secondary" onClick={() => done.current({ status: "declined" })} disabled={busy}>{copy.decline}</button>
          <button type="button" className="plugin-task-secondary" onClick={() => void create(false)} disabled={!valid || busy}>{copy.create}</button>
          <button ref={first} type="button" className="plugin-task-primary" onClick={() => void create(true)} disabled={!valid || busy}>{busy ? copy.busy : copy.start}</button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
