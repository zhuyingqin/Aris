import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DesktopProject } from "../types";
import { SvgIcon } from "../SvgIcon";
import "./NewTaskDialog.css";

interface Props {
  language: "cn" | "en";
  projects: DesktopProject[];
  initialProjectId: string;
  busy?: boolean;
  onCancel: () => void;
  onCreate: (projectId: string, prompt: string) => void | Promise<void>;
}

const COPY = {
  cn: {
    title: "新建任务",
    close: "关闭新建任务窗口",
    question: "要做什么？",
    placeholder: "描述研究任务、预期结果或需要解决的问题…",
    execution: "SomniQ 本机执行",
    review: "完成后由独立 Reviewer 审核",
    target: "目标",
    currentProject: "当前项目",
    cancel: "取消",
    create: "保存",
    creating: "正在保存…",
    shortcut: "Ctrl + Enter 保存",
  },
  en: {
    title: "New task",
    close: "Close new task dialog",
    question: "What should we work on?",
    placeholder: "Describe the research task, desired outcome, or problem to solve…",
    execution: "Run locally with SomniQ",
    review: "Independent Reviewer checks the result",
    target: "Target",
    currentProject: "Current project",
    cancel: "Cancel",
    create: "Save",
    creating: "Saving…",
    shortcut: "Ctrl + Enter to save",
  },
} as const;

function FolderIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 3.8a1 1 0 0 1 1-1h3.2l1.4 1.6H13a1 1 0 0 1 1 1v6.2a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" fill="currentColor" fillOpacity="0.16" />
    </svg>
  );
}

export default function NewTaskDialog({
  language,
  projects,
  initialProjectId,
  busy = false,
  onCancel,
  onCreate,
}: Props) {
  const copy = COPY[language];
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [prompt, setPrompt] = useState("");
  const [projectId, setProjectId] = useState(initialProjectId);
  const [submitting, setSubmitting] = useState(false);
  const availableProjects = useMemo(() => {
    if (projects.some((project) => project.id === initialProjectId)) return projects;
    return [
      { id: initialProjectId, name: copy.currentProject, path: "", addedAt: 0, lastOpenedAt: 0 },
      ...projects,
    ];
  }, [copy.currentProject, initialProjectId, projects]);
  const canCreate = prompt.trim().length > 0 && !busy && !submitting;

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    textareaRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) onCancel();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel, submitting]);

  const submit = async () => {
    if (!canCreate) return;
    setSubmitting(true);
    try {
      await onCreate(projectId, prompt.trim());
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div
      className="new-task-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) onCancel();
      }}
    >
      <section className="new-task-dialog" role="dialog" aria-modal="true" aria-labelledby="new-task-dialog-title">
        <header className="new-task-header">
          <h2 id="new-task-dialog-title">{copy.title}</h2>
          <button type="button" className="new-task-close" aria-label={copy.close} onClick={onCancel} disabled={submitting}>
            <SvgIcon name="close" size={18} />
          </button>
        </header>

        <div className="new-task-body">
          <label className="new-task-question" htmlFor="new-task-prompt">{copy.question}</label>
          <div className="new-task-composer">
            <textarea
              ref={textareaRef}
              id="new-task-prompt"
              value={prompt}
              placeholder={copy.placeholder}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            <div className="new-task-composer-meta">
              <span className="new-task-runtime-pill">
                <span className="new-task-runtime-mark" aria-hidden="true">S</span>
                {copy.execution}
              </span>
              <span className="new-task-review-note">
                <SvgIcon name="check" size={13} />
                {copy.review}
              </span>
              <span className="new-task-shortcut">{copy.shortcut}</span>
            </div>
          </div>

          <div className="new-task-target">
            <label htmlFor="new-task-project">{copy.target}</label>
            <div className="new-task-project-select">
              <FolderIcon />
              <select id="new-task-project" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                {availableProjects.map((project) => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
              </select>
              <SvgIcon name="chevronDown" size={12} />
            </div>
          </div>
        </div>

        <footer className="new-task-footer">
          <button type="button" className="new-task-cancel" onClick={onCancel} disabled={submitting}>{copy.cancel}</button>
          <button type="button" className="new-task-create" onClick={() => void submit()} disabled={!canCreate}>
            {submitting ? copy.creating : copy.create}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
