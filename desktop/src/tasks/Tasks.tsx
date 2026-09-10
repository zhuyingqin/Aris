import { useCallback, useEffect, useMemo, useState } from "react";

import {
  isTauri,
  onWorkTaskChanged,
  workTaskAccept,
  workTaskCancel,
  workTaskCreate,
  workTaskDelete,
  workTaskDiff,
  workTaskList,
  workTaskReturnToTodo,
  workTaskStart,
  workTaskUpdate,
} from "../api/tauri";
import { useStore } from "../store";
import { SvgIcon } from "../SvgIcon";
import type { WorkTask } from "../types";
import {
  BOARD_COLUMN_IDS,
  canAccept,
  canCancel,
  canStart,
  groupTasksByColumn,
  isEngineOwned,
} from "./boardColumns";
import { TASKS_COPY } from "./i18n";
import "./Tasks.css";

type Draft = { id: string | null; title: string; prompt: string };

const EMPTY_DRAFT: Draft = { id: null, title: "", prompt: "" };

function relativeAge(timestamp: number, language: "cn" | "en") {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return language === "cn" ? "刚刚" : "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return language === "cn" ? `${minutes} 分钟` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return language === "cn" ? `${hours} 小时` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return language === "cn" ? `${days} 天` : `${days}d`;
}

export interface TasksProps {
  onOpenSession?: (task: WorkTask) => void;
}

export default function Tasks({ onOpenSession }: TasksProps = {}) {
  const language = useStore((state) => state.language);
  const currentProject = useStore((state) => state.currentProject);
  const setError = useStore((state) => state.setError);
  const copy = TASKS_COPY[language];

  const [tasks, setTasks] = useState<WorkTask[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showCanceled, setShowCanceled] = useState(false);
  const [openDiff, setOpenDiff] = useState<{ id: string; patch: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setTasks(await workTaskList());
    } catch (error) {
      setError(String(error));
    }
  }, [setError]);

  useEffect(() => {
    if (!isTauri()) {
      setTasks([]);
      return;
    }
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = onWorkTaskChanged(() => void refresh());
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, [refresh]);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDraft(null);
    };
    if (draft) window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [draft]);

  const grouped = useMemo(
    () => groupTasksByColumn(tasks ?? [], showCanceled),
    [tasks, showCanceled],
  );

  const act = async (taskId: string, action: () => Promise<unknown>) => {
    setBusyId(taskId);
    try {
      await action();
      await refresh();
    } catch (error) {
      setError(String(error));
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  const submitDraft = async () => {
    if (!draft) return;
    const title = draft.title.trim();
    if (!title) return;
    try {
      if (draft.id) {
        await workTaskUpdate(draft.id, { title, prompt: draft.prompt });
      } else {
        await workTaskCreate(title, draft.prompt);
      }
      setDraft(null);
      await refresh();
    } catch (error) {
      setError(String(error));
    }
  };

  const toggleDiff = async (task: WorkTask) => {
    if (openDiff?.id === task.id) {
      setOpenDiff(null);
      return;
    }
    try {
      const patch = await workTaskDiff(task.id);
      setOpenDiff({ id: task.id, patch });
      // Reading the patch also repairs legacy review cards whose generated
      // artifacts were left dirty rather than committed. Refresh so the card's
      // file and line counts immediately match the recovered diff.
      await refresh();
    } catch (error) {
      setError(String(error));
    }
  };

  if (!isTauri()) {
    return <div className="tasks-page"><div className="tasks-empty">{copy.emptyHint}</div></div>;
  }

  return (
    <div className="tasks-page">
      <header className="tasks-header">
        <div className="tasks-heading">
          <span className="tasks-heading-icon"><SvgIcon name="notebook" size={16} /></span>
          <h1>{copy.title}</h1>
        </div>
        <button type="button" className="tasks-primary tasks-new" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
          <SvgIcon name="plus" size={15} />
          {copy.newTask}
        </button>
      </header>

      <div className="tasks-toolbar">
        <div className="tasks-project-filter" title={currentProject?.path}>
          <SvgIcon name="folder" size={14} />
          <span>{currentProject?.name ?? copy.allProjects}</span>
          <SvgIcon name="chevronDown" size={11} />
        </div>
        <label className="tasks-toggle">
          <SvgIcon name="modified" size={13} />
          <input
            type="checkbox"
            checked={showCanceled}
            onChange={(event) => setShowCanceled(event.target.checked)}
          />
          {copy.showCanceled}
        </label>
      </div>

      {draft && (
        <div className="tasks-draft-backdrop" role="presentation" onMouseDown={() => setDraft(null)}>
          <form
            className="tasks-draft"
            aria-label={draft.id ? copy.edit : copy.newTask}
            onMouseDown={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              void submitDraft();
            }}
          >
            <div className="tasks-draft-head">
              <div>
                <strong>{draft.id ? copy.edit : copy.newTask}</strong>
                <span>{copy.draftHint}</span>
              </div>
              <button type="button" className="tasks-icon-button" onClick={() => setDraft(null)} aria-label={copy.cancel}>
                <SvgIcon name="close" size={15} />
              </button>
            </div>
            <label>
              <span>{copy.titleLabel}</span>
              <input
                value={draft.title}
                placeholder={copy.titleHint}
                onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                autoFocus
              />
            </label>
            <label>
              <span>{copy.promptLabel}</span>
              <textarea
                rows={7}
                value={draft.prompt}
                placeholder={copy.promptHint}
                onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
              />
            </label>
            <div className="tasks-draft-context">
              <span><SvgIcon name="folder" size={13} />{currentProject?.name ?? copy.allProjects}</span>
              <span><SvgIcon name="sparkle" size={13} />{copy.defaultAgent}</span>
            </div>
            <div className="tasks-draft-actions">
              <button type="button" onClick={() => setDraft(null)}>{copy.cancel}</button>
              <button type="submit" className="tasks-primary" disabled={!draft.title.trim()}>
                {draft.id ? copy.save : copy.create}
              </button>
            </div>
          </form>
        </div>
      )}

      {tasks === null ? (
        <div className="tasks-empty"><span className="app-loading-spinner" />{copy.loading}</div>
      ) : tasks.length === 0 ? (
        <div className="tasks-empty">
          <span className="tasks-empty-icon"><SvgIcon name="notebook" size={24} /></span>
          <strong>{copy.empty}</strong>
          <span>{copy.emptyHint}</span>
          <button type="button" className="tasks-primary" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
            <SvgIcon name="plus" size={14} />{copy.newTask}
          </button>
        </div>
      ) : (
        <div className="tasks-board">
          {BOARD_COLUMN_IDS.map((column) => (
            <section key={column} className={`tasks-column tasks-column-${column}`} aria-label={copy.columns[column]}>
              <div className="tasks-column-heading">
                <span className="tasks-column-marker" aria-hidden="true" />
                <h2>{copy.columns[column]}</h2>
                <span className="tasks-count">{grouped[column].length}</span>
              </div>
              <div className="tasks-column-cards">
                {grouped[column].length === 0 && <div className="tasks-column-empty">{copy.columnEmpty[column]}</div>}
                {grouped[column].map((task) => (
                  <article key={task.id} className={`tasks-card tasks-card-${task.status}`}>
                    <header>
                      <div className="tasks-card-title">
                        <span className="tasks-agent-mark"><SvgIcon name="sparkle" size={12} /></span>
                        <strong>{task.title}</strong>
                      </div>
                      <span className="tasks-status">{copy.statuses[task.status]}</span>
                    </header>

                    <div className="tasks-card-meta">
                      <span>SomniQ</span>
                      {task.worktree && <><i>/</i><span title={task.worktree.path}>{task.worktree.branch}</span></>}
                      <i>·</i>
                      <time dateTime={new Date(task.updatedAt).toISOString()}>{relativeAge(task.updatedAt, language)}</time>
                    </div>

                    {task.prompt && <p className="tasks-card-prompt">{task.prompt}</p>}
                    {task.resultSummary && <p className="tasks-card-summary">{task.resultSummary}</p>}
                    {task.changes && (
                      <p className="tasks-card-changes">
                        {task.changes.filesChanged === 0
                          ? copy.noChanges
                          : copy.changesSummary(task.changes.filesChanged, task.changes.additions, task.changes.deletions)}
                      </p>
                    )}
                    {task.mergeCommit && <p className="tasks-card-merged">{copy.mergedAs(task.mergeCommit)}</p>}
                    {task.lastError && <p className="tasks-card-error" role="alert">{task.lastError}</p>}
                    {openDiff?.id === task.id && <pre className="tasks-card-diff">{openDiff.patch || copy.noChanges}</pre>}

                    <footer className="tasks-card-actions">
                      {task.sessionId && onOpenSession && (
                        <button type="button" onClick={() => onOpenSession(task)}>
                          <SvgIcon name="inbox" size={13} />{copy.openChat}
                        </button>
                      )}
                      {canStart(task) && (
                        <button type="button" className="tasks-action-primary" disabled={busyId === task.id} onClick={() => void act(task.id, () => workTaskStart(task.id))}>
                          <SvgIcon name="play" size={12} />{task.status === "todo" ? copy.start : copy.retry}
                        </button>
                      )}
                      {canCancel(task) && (
                        <button type="button" disabled={busyId === task.id} onClick={() => void act(task.id, () => workTaskCancel(task.id))}>
                          <SvgIcon name="stop" size={12} />{copy.stop}
                        </button>
                      )}
                      {task.status === "review" && (
                        <button type="button" onClick={() => void toggleDiff(task)}>
                          <SvgIcon name="code" size={12} />{openDiff?.id === task.id ? copy.hideDiff : copy.viewDiff}
                        </button>
                      )}
                      {canAccept(task) && (
                        <button type="button" className="tasks-action-primary" disabled={busyId === task.id} onClick={() => void act(task.id, () => workTaskAccept(task.id))}>
                          <SvgIcon name="check" size={12} />{busyId === task.id ? copy.accepting : copy.accept}
                        </button>
                      )}
                      {(task.status === "review" || task.status === "failed") && (
                        <button type="button" disabled={busyId === task.id} onClick={() => void act(task.id, () => workTaskReturnToTodo(task.id))}>
                          <SvgIcon name="reset" size={12} />{copy.returnToTodo}
                        </button>
                      )}
                      {!isEngineOwned(task) && (
                        <div className="tasks-card-more">
                          <button type="button" className="tasks-icon-button" title={copy.edit} aria-label={copy.edit} onClick={() => setDraft({ id: task.id, title: task.title, prompt: task.prompt })}>
                            <SvgIcon name="edit" size={13} />
                          </button>
                          <button type="button" className="tasks-icon-button" title={copy.delete} aria-label={copy.delete} disabled={busyId === task.id} onClick={() => {
                            if (!window.confirm(copy.deleteConfirm(task.title))) return;
                            void act(task.id, () => workTaskDelete(task.id));
                          }}>
                            <SvgIcon name="trash" size={13} />
                          </button>
                        </div>
                      )}
                    </footer>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
