import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  isTauri,
  onWorkTaskChanged,
  workTaskAccept,
  workTaskCancel,
  workTaskCreate,
  workTaskCreateAndStart,
  workTaskDelete,
  workTaskPause,
  workTaskReply,
  workTaskResume,
  workTaskReturnToTodo,
  workTaskSnapshot,
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
  canPause,
  canResume,
  canStart,
  groupTasksByColumn,
  heartbeatIsFresh,
  isEngineOwned,
  pendingQuestion,
} from "./boardColumns";
import { TASKS_COPY } from "./i18n";
import TaskReviewPanel from "./TaskReviewPanel";
// NOTE: `Tasks.css` is deliberately NOT imported here. This module is lazily
// loaded (`Chat.tsx` wraps it in `lazy()`), so importing the stylesheet from
// it puts the board's entire appearance in a separate CSS chunk fetched at the
// moment the tab is opened. One failed fetch and the page renders as bare
// HTML. It is imported from `App.tsx` instead, which is in the main bundle —
// `tasksStylesheetIsLoadedFromTheShell` in `Tasks.test.tsx` pins that.

type Draft = { id: string | null; title: string; prompt: string };

const EMPTY_DRAFT: Draft = { id: null, title: "", prompt: "" };
/** Events are the fast path; this only repairs a dropped notification. */
const BOARD_POLL_MS = 30_000;

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

/**
 * The one-line result shown on the card face.
 *
 * Keyed on the snapshot rather than on `changes.filesChanged` alone. A task
 * asked to write a report changes zero repository files, and reporting that as
 * "no changes were produced" is the misstatement the structured snapshot
 * exists to end — it is not enough to fix it in the panel while the card above
 * still says it.
 */
function resultLine(task: WorkTask, copy: (typeof TASKS_COPY)["en"]): string {
  const changes = task.changes;
  if (changes && changes.filesChanged > 0) {
    return copy.changesSummary(changes.filesChanged, changes.additions, changes.deletions);
  }
  const artifacts = task.reviewSnapshot?.artifacts?.length ?? 0;
  if (artifacts > 0) return copy.artifactCount(artifacts);
  if (task.reviewSnapshot?.emptyReason === "worktree_missing") return copy.resultUnreadable;
  if (task.reviewSnapshot?.emptyReason === "no_repository_changes") return copy.noFileChanges;
  return copy.noChanges;
}

export interface TasksProps {
  onOpenSession?: (task: WorkTask) => void;
}

export default function Tasks({ onOpenSession }: TasksProps = {}) {
  const language = useStore((state) => state.language);
  const currentProject = useStore((state) => state.currentProject);
  const projectId = currentProject?.id ?? null;
  const setError = useStore((state) => state.setError);
  const copy = TASKS_COPY[language];

  const [tasks, setTasks] = useState<WorkTask[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showCanceled, setShowCanceled] = useState(false);
  const [openReview, setOpenReview] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  /**
   * Highest store revision already applied. Events at or below it describe
   * state this board already holds — which is what makes subscribing before
   * the first load safe, rather than a race that re-reads on every event.
   */
  const revision = useRef(-1);
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  const refresh = useCallback(async () => {
    const requestedProjectId = projectId;
    try {
      const snapshot = await workTaskSnapshot();
      // A project switch or a slower, older request must not overwrite the
      // board that has already advanced.
      if (projectIdRef.current !== requestedProjectId) return;
      if (snapshot.revision < revision.current) return;
      revision.current = snapshot.revision;
      setTasks(snapshot.tasks);
    } catch (error) {
      setError(String(error));
    }
  }, [projectId, setError]);

  /**
   * Subscribe first, load second — in that order and awaited.
   *
   * Loading first leaves a window between the snapshot being read and the
   * listener being registered, and anything that changed inside it is lost
   * until the next unrelated event. Registering first cannot produce the
   * opposite problem: an event that arrives during the load carries a revision
   * the load already contains, and the guard below drops it.
   */
  useEffect(() => {
    if (!isTauri()) {
      setTasks([]);
      return;
    }
    let disposed = false;
    let stop: (() => void) | null = null;
    revision.current = -1;
    setTasks(null);
    void (async () => {
      stop = await onWorkTaskChanged((event) => {
        if (projectId && event.projectId !== projectId) return;
        // A revision this board has already applied says nothing new.
        // Reloading on it would mean a full re-read per heartbeat, across
        // every task.
        if (event.revision <= revision.current) return;
        void refresh();
      });
      if (disposed) {
        stop();
        stop = null;
        return;
      }
      await refresh();
    })();
    return () => {
      disposed = true;
      stop?.();
    };
  }, [refresh]);

  /**
   * Low-frequency backstop while anything is in flight.
   *
   * Events are the fast path, not the only path: one dropped notification
   * would otherwise leave a card claiming to be running long after it
   * finished, with nothing to correct it. Only runs when the engine actually
   * owns something, so an idle board costs nothing.
   */
  const hasActiveWork = useMemo(
    // `awaiting_input` is deliberately absent: that state is persisted and no
    // model turn is alive, so there is neither a heartbeat nor a slot to poll.
    () => (tasks ?? []).some((task) => task.status !== "awaiting_input" && isEngineOwned(task)),
    [tasks],
  );
  useEffect(() => {
    if (!isTauri() || !hasActiveWork) return;
    const timer = window.setInterval(() => void refresh(), BOARD_POLL_MS);
    return () => window.clearInterval(timer);
  }, [hasActiveWork, refresh]);

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

  /**
   * `start` distinguishes the dialog's two actions. Creating a task is a
   * request to run it, so that is the primary button; saving it to the board
   * for later is the deliberate, separately-labelled alternative rather than
   * the silent default it used to be.
   */
  const submitDraft = async (start: boolean) => {
    if (!draft) return;
    const title = draft.title.trim();
    if (!title) return;
    try {
      if (draft.id) {
        await workTaskUpdate(draft.id, { title, prompt: draft.prompt });
      } else if (start) {
        await workTaskCreateAndStart(title, draft.prompt);
      } else {
        await workTaskCreate(title, draft.prompt);
      }
      setDraft(null);
      await refresh();
    } catch (error) {
      setError(String(error));
    }
  };

  const answer = async (task: WorkTask, text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    await act(task.id, () => workTaskReply(task.id, trimmed));
    setAnswers((current) => {
      const next = { ...current };
      delete next[task.id];
      return next;
    });
  };

  const toggleReview = (task: WorkTask) => {
    setOpenReview((current) => (current === task.id ? null : task.id));
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
              void submitDraft(!draft.id);
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
              {!draft.id && (
                <button
                  type="button"
                  className="tasks-draft-secondary"
                  disabled={!draft.title.trim()}
                  onClick={() => void submitDraft(false)}
                >
                  {copy.saveOnly}
                </button>
              )}
              <button type="submit" className="tasks-primary" disabled={!draft.title.trim()}>
                {draft.id ? copy.save : copy.createAndStart}
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
                {grouped[column].map((task) => {
                  const question = pendingQuestion(task);
                  return (
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

                    {task.progressMessage && (
                      <p className="tasks-card-phase">
                        {/* Only claim work is happening when a heartbeat says
                            so. A row that says "running" with nothing behind
                            it is the failure this line exists to expose. */}
                        <span
                          className={`tasks-pulse${heartbeatIsFresh(task) ? " tasks-pulse-live" : " tasks-pulse-stale"}`}
                          aria-hidden="true"
                        />
                        {task.progressMessage}
                        <small>
                          {heartbeatIsFresh(task) && task.lastHeartbeatAt
                            ? copy.heartbeatFresh(relativeAge(task.lastHeartbeatAt, language))
                            : copy.heartbeatStale}
                        </small>
                      </p>
                    )}

                    {question && (
                      <div className="tasks-card-question">
                        <strong>{question.header || copy.answerLabel}</strong>
                        <p>{question.question}</p>
                        {question.options.length > 0 && (
                          <div className="tasks-question-options">
                            {question.options.map((option) => (
                              <button
                                key={option}
                                type="button"
                                disabled={busyId === task.id}
                                onClick={() => void answer(task, option)}
                              >
                                {option}
                              </button>
                            ))}
                          </div>
                        )}
                        <div className="tasks-question-free">
                          <input
                            value={answers[task.id] ?? ""}
                            placeholder={copy.answerHint}
                            aria-label={copy.answerHint}
                            onChange={(event) =>
                              setAnswers((current) => ({ ...current, [task.id]: event.target.value }))
                            }
                            onKeyDown={(event) => {
                              if (event.key !== "Enter") return;
                              event.preventDefault();
                              void answer(task, answers[task.id] ?? "");
                            }}
                          />
                          <button
                            type="button"
                            className="tasks-action-primary"
                            disabled={busyId === task.id || !(answers[task.id] ?? "").trim()}
                            onClick={() => void answer(task, answers[task.id] ?? "")}
                          >
                            {copy.answerSend}
                          </button>
                        </div>
                      </div>
                    )}

                    {task.prompt && <p className="tasks-card-prompt">{task.prompt}</p>}
                    {task.resultSummary && <p className="tasks-card-summary">{task.resultSummary}</p>}
                    {task.changes && (
                      <p className="tasks-card-changes">
                        {/* Reads the snapshot, not the file count alone: a
                            task that produced a report changed zero files and
                            would otherwise announce "no changes" on the card
                            face while the panel below it listed the PDF. */}
                        {resultLine(task, copy)}
                      </p>
                    )}
                    {task.mergeCommit && <p className="tasks-card-merged">{copy.mergedAs(task.mergeCommit)}</p>}
                    {task.lastError && <p className="tasks-card-error" role="alert">{task.lastError}</p>}
                    {openReview === task.id && (
                      <TaskReviewPanel task={task} language={language} onError={setError} />
                    )}

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
                      {/* Resume, not Start: the checkout and the transcript are
                          still there, and this continues them rather than
                          cutting a fresh pair. */}
                      {canResume(task) && (
                        <button type="button" className="tasks-action-primary" disabled={busyId === task.id} onClick={() => void act(task.id, () => workTaskResume(task.id))}>
                          <SvgIcon name="play" size={12} />{task.status === "failed" ? copy.retry : copy.resume}
                        </button>
                      )}
                      {canPause(task) && (
                        <button type="button" disabled={busyId === task.id} onClick={() => void act(task.id, () => workTaskPause(task.id))}>
                          <SvgIcon name="stop" size={12} />{copy.pause}
                        </button>
                      )}
                      {canCancel(task) && (
                        <button type="button" disabled={busyId === task.id} onClick={() => void act(task.id, () => workTaskCancel(task.id))}>
                          <SvgIcon name="close" size={12} />{copy.stop}
                        </button>
                      )}
                      {task.status === "review" && (
                        <button type="button" onClick={() => toggleReview(task)}>
                          <SvgIcon name="code" size={12} />{openReview === task.id ? copy.hideDiff : copy.viewDiff}
                        </button>
                      )}
                      {canAccept(task) && (
                        <button type="button" className="tasks-action-primary" disabled={busyId === task.id} onClick={() => void act(task.id, () => workTaskAccept(task.id))}>
                          <SvgIcon name="check" size={12} />{busyId === task.id ? copy.accepting : copy.accept}
                        </button>
                      )}
                      {(task.status === "review"
                        || task.status === "failed"
                        || task.status === "paused"
                        || task.status === "interrupted") && (
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
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
