import { useCallback, useEffect, useState } from "react";

import {
  workTaskArtifactExport,
  workTaskReviewPatch,
  workTaskReviewSnapshot,
} from "../api/tauri";
import type { Language } from "../store";
import { SvgIcon } from "../SvgIcon";
import type {
  WorkTask,
  WorkTaskArtifact,
  WorkTaskReviewFile,
  WorkTaskReviewSnapshot,
} from "../types";
import { REVIEW_COPY } from "./i18n";

/**
 * What a task produced, as a file list rather than a wall of patch text.
 *
 * The inline `<pre>` this replaces could only show a text diff, so a task that
 * produced a PDF, renamed a file, or deliberately changed nothing all rendered
 * as the same empty string under the caption "no changes were produced". Here
 * every file is listed with what happened to it, binaries are named and sized
 * instead of being silently dropped, and an empty result says *which kind* of
 * empty it is.
 *
 * The patch is fetched per file rather than whole: the whole-diff cap
 * truncates, and a truncated patch hides whichever files sort last without
 * saying so.
 */
export interface TaskReviewPanelProps {
  task: WorkTask;
  language: Language;
  onError: (message: string) => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** A short, non-numeric marker for the change kind — `A`/`M`/`D` reads the way
 *  `git status` does and survives a narrow column. */
const KIND_MARK: Record<WorkTaskReviewFile["changeKind"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  type_changed: "T",
  other: "?",
};

export default function TaskReviewPanel({ task, language, onError }: TaskReviewPanelProps) {
  const copy = REVIEW_COPY[language];
  const [snapshot, setSnapshot] = useState<WorkTaskReviewSnapshot | null>(
    task.reviewSnapshot ?? null,
  );
  const [loading, setLoading] = useState(!task.reviewSnapshot);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [patch, setPatch] = useState<string | null>(null);
  const [patchLoading, setPatchLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Always re-read on open. The card's copy may predate structured review,
    // and for those the backend repairs and persists a snapshot as a side
    // effect of being asked for one.
    setLoading(true);
    workTaskReviewSnapshot(task.id)
      .then((result) => {
        if (!cancelled) setSnapshot(result);
      })
      .catch((error) => {
        if (!cancelled) onError(String(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [task.id, onError]);

  const openFile = useCallback(
    async (file: WorkTaskReviewFile) => {
      if (openPath === file.path) {
        setOpenPath(null);
        setPatch(null);
        return;
      }
      setOpenPath(file.path);
      setPatch(null);
      if (file.binary) return;
      setPatchLoading(true);
      try {
        setPatch(await workTaskReviewPatch(task.id, file.path));
      } catch (error) {
        onError(String(error));
        setPatch(null);
      } finally {
        setPatchLoading(false);
      }
    },
    [openPath, task.id, onError],
  );

  /**
   * Copy a deliverable to a path the user picks.
   *
   * The save dialog is imported lazily because it is the only thing on this
   * panel that needs the Tauri dialog plugin, and the panel renders inside a
   * board that also has to work in the browser preview.
   */
  const exportArtifact = useCallback(
    async (artifact: WorkTaskArtifact) => {
      try {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const destination = await save({ defaultPath: artifact.title });
        if (!destination) return;
        const updated = await workTaskArtifactExport(task.id, artifact.id, destination);
        setSnapshot(updated.reviewSnapshot ?? null);
      } catch (error) {
        onError(String(error));
      }
    },
    [task.id, onError],
  );

  /**
   * The independent Reviewer's verdict, shown above the files.
   *
   * Before this, the executor's own closing summary was the only quality
   * signal a card carried — so a task that confidently announced success and
   * had produced nothing of the kind looked exactly like one that worked.
   * `unavailable` is rendered as its own thing rather than hidden: a result
   * nobody checked must not read as one that passed.
   */
  const review = task.reviewState;
  const verdictSection = review && (
    <div className={`tasks-review-verdict tasks-review-verdict-${review.verdict}`}>
      <div className="tasks-review-verdict-head">
        <SvgIcon
          name={
            review.verdict === "pass"
              ? "shieldCheck"
              : review.verdict === "unavailable"
                ? "info"
                : "warning"
          }
          size={14}
        />
        <strong>{copy.verdict[review.verdict]}</strong>
        {review.reviewerModel && (
          <code title={copy.reviewedBy(review.reviewerModel)}>{review.reviewerModel}</code>
        )}
      </div>
      {review.summary && <p>{review.summary}</p>}
      {review.exhausted && <p className="tasks-review-exhausted">{copy.exhausted(review.maxRounds)}</p>}
      {review.issues.length > 0 && (
        <ul className="tasks-review-issues">
          {review.issues.map((issue, index) => (
            <li key={`${issue.title}-${index}`}>
              <span className={`tasks-review-severity tasks-review-severity-${issue.severity}`}>
                {issue.severity || "—"}
              </span>
              <div>
                <strong>{issue.title}</strong>
                {issue.detail && <p>{issue.detail}</p>}
                {issue.recommendation && <em>{issue.recommendation}</em>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  const artifacts = snapshot?.artifacts ?? [];
  const artifactSection = artifacts.length > 0 && (
    <div className="tasks-review-artifacts">
      <div className="tasks-review-head">
        <strong>{copy.artifacts}</strong>
        {/* Said out loud, because the whole point is that these do NOT go
            through the diff and are not affected by accepting the merge. */}
        <small>{copy.artifactsNote}</small>
      </div>
      <ul className="tasks-review-files">
        {artifacts.map((artifact) => (
          <li key={artifact.id}>
            <div className="tasks-review-artifact">
              <SvgIcon name="document" size={13} />
              <span className="tasks-review-path" title={artifact.relativePath}>
                {artifact.title}
              </span>
              <span className="tasks-review-binary">{formatBytes(artifact.byteSize)}</span>
              <button type="button" onClick={() => void exportArtifact(artifact)}>
                {artifact.exportedPath ? copy.exportAgain : copy.export}
              </button>
            </div>
            {artifact.exportedPath && (
              <p className="tasks-review-exported" title={artifact.exportedPath}>
                {copy.exportedTo(artifact.exportedPath)}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );

  if (loading && !snapshot) {
    return (
      <div className="tasks-review-panel tasks-review-loading">
        <span className="app-loading-spinner" />
        {copy.loading}
      </div>
    );
  }
  if (!snapshot) return null;

  if (snapshot.files.length === 0) {
    // The whole reason this component exists: name which kind of nothing it is.
    const reason = snapshot.emptyReason ?? "nothing_produced";
    return (
      <div className="tasks-review-panel">
        {verdictSection}
        <div className={`tasks-review-empty tasks-review-empty-${reason}`}>
          <SvgIcon
            name={
              reason === "worktree_missing" || reason === "snapshot_failed"
                ? "warning"
                : "info"
            }
            size={14}
          />
          <span>{copy.empty[reason]}</span>
        </div>
        {/* An empty diff beside a real deliverable is the common case for
            "write me a report", not an error. */}
        {artifactSection}
      </div>
    );
  }

  return (
    <div className="tasks-review-panel">
      {verdictSection}
      <div className="tasks-review-head">
        <strong>{copy.fileCount(snapshot.files.length)}</strong>
        <code title={`${snapshot.baseSha}..${snapshot.headSha}`}>
          {snapshot.baseSha.slice(0, 7)}..{snapshot.headSha.slice(0, 7)}
        </code>
      </div>
      <ul className="tasks-review-files">
        {snapshot.files.map((file) => (
          <li key={file.path}>
            <button
              type="button"
              className={`tasks-review-file${openPath === file.path ? " open" : ""}`}
              onClick={() => void openFile(file)}
            >
              <span className={`tasks-review-kind tasks-review-kind-${file.changeKind}`}>
                {KIND_MARK[file.changeKind]}
              </span>
              <span className="tasks-review-path" title={file.path}>
                {file.previousPath && (
                  <em title={file.previousPath}>{file.previousPath} → </em>
                )}
                {file.path}
              </span>
              {/* A binary file has no line counts. Showing "+0 −0" would read
                  as "nothing changed" for the exact files where that is most
                  misleading — the PDF or deck the task was asked to produce. */}
              {file.binary ? (
                <span className="tasks-review-binary">
                  {copy.binary}
                  {typeof file.byteSize === "number" && ` · ${formatBytes(file.byteSize)}`}
                </span>
              ) : (
                <span className="tasks-review-counts">
                  <span className="tasks-review-add">+{file.additions ?? 0}</span>
                  <span className="tasks-review-del">−{file.deletions ?? 0}</span>
                </span>
              )}
            </button>
            {openPath === file.path && (
              <div className="tasks-review-detail">
                {file.binary ? (
                  <p className="tasks-review-binary-note">{copy.binaryNote}</p>
                ) : patchLoading ? (
                  <p className="tasks-review-binary-note">
                    <span className="app-loading-spinner" />
                    {copy.loading}
                  </p>
                ) : (
                  <pre className="tasks-card-diff">{patch || copy.noPatch}</pre>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {artifactSection}
    </div>
  );
}
