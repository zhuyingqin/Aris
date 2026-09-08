import { useCallback, useEffect, useMemo, useState } from "react";
import {
  typesetCommentDelete,
  typesetCommentsList,
  typesetCommentUpsert,
  type TypesetComment,
} from "../api/tauri";
import { useStore } from "../store";
import { TYPESET_EDITOR_COPY } from "./i18n";

export type TypesetSourceRange = { from: number; to: number };

/** Re-anchor a durable comment after nearby source edits. */
export function commentRangeInSource(comment: TypesetComment, source: string): TypesetSourceRange {
  const from = Math.max(0, Math.min(comment.from, source.length));
  const to = Math.max(from, Math.min(comment.to, source.length));
  if (!comment.selectedText || source.slice(from, to) === comment.selectedText) return { from, to };
  const candidates: number[] = [];
  let cursor = source.indexOf(comment.selectedText);
  while (cursor >= 0 && candidates.length < 200) {
    candidates.push(cursor);
    cursor = source.indexOf(comment.selectedText, cursor + 1);
  }
  if (candidates.length === 0) return { from, to };
  const best = candidates.reduce((left, right) =>
    Math.abs(right - comment.from) < Math.abs(left - comment.from) ? right : left);
  return { from: best, to: best + comment.selectedText.length };
}

export default function TypesetCommentsPanel({
  path,
  source,
  selection,
  onClose,
  onNavigate,
}: {
  path: string;
  source: string;
  selection: TypesetSourceRange;
  onClose: () => void;
  onNavigate: (range: TypesetSourceRange) => void;
}) {
  const language = useStore((state) => state.language);
  const copy = TYPESET_EDITOR_COPY[language].workbench;
  const [comments, setComments] = useState<TypesetComment[]>([]);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const anchoredSelection = useMemo(() => {
    const from = Math.max(0, Math.min(selection.from, source.length));
    return { from, to: Math.max(from, Math.min(selection.to, source.length)) };
  }, [selection, source.length]);

  const refresh = useCallback(async () => {
    try {
      setComments(await typesetCommentsList(path));
    } catch (reason) {
      setError(String(reason));
    }
  }, [path]);

  useEffect(() => { void refresh(); }, [refresh]);

  const add = async () => {
    if (!body.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await typesetCommentUpsert(path, {
        id: "",
        path,
        from: anchoredSelection.from,
        to: anchoredSelection.to,
        selectedText: source.slice(anchoredSelection.from, anchoredSelection.to),
        body,
        author: copy.commentAuthorYou,
        origin: "user",
        resolved: false,
        createdAtMs: 0,
        updatedAtMs: 0,
      });
      setBody("");
      await refresh();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleResolved = async (comment: TypesetComment) => {
    setBusy(true);
    try {
      await typesetCommentUpsert(path, { ...comment, resolved: !comment.resolved });
      await refresh();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (comment: TypesetComment) => {
    setBusy(true);
    try {
      await typesetCommentDelete(path, comment.id);
      await refresh();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const ordered = [...comments].sort((left, right) => Number(left.resolved) - Number(right.resolved));
  return (
    <div className="typeset-comments-backdrop" role="presentation" onMouseDown={onClose}>
      <aside className="typeset-comments-panel" role="dialog" aria-modal="true" aria-label={copy.commentsTitle} onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <strong>{copy.commentsTitle}</strong>
          <button type="button" aria-label={copy.commentsClose} onClick={onClose}>×</button>
        </header>
        <div className="typeset-comment-compose">
          <p>{anchoredSelection.to > anchoredSelection.from
            ? copy.commentSelected(source.slice(anchoredSelection.from, anchoredSelection.to).replace(/\s+/g, " ").slice(0, 120))
            : copy.commentAtCursor}</p>
          <textarea autoFocus value={body} placeholder={copy.commentPlaceholder} onChange={(event) => setBody(event.target.value)} />
          <button type="button" disabled={busy || !body.trim()} onClick={() => void add()}>{copy.commentAdd}</button>
        </div>
        {error && <p className="typeset-comments-error">{error}</p>}
        <div className="typeset-comments-list">
          {ordered.length === 0 && <p>{copy.commentsEmpty}</p>}
          {ordered.map((comment) => {
            const range = commentRangeInSource(comment, source);
            return (
              <article key={comment.id} className={comment.resolved ? "resolved" : ""}>
                <button type="button" className="typeset-comment-body" onClick={() => onNavigate(range)}>
                  <strong>{comment.author}</strong>
                  <span>{comment.body}</span>
                  {comment.selectedText && <code>{comment.selectedText.replace(/\s+/g, " ").slice(0, 160)}</code>}
                </button>
                <footer>
                  <time>{new Date(comment.updatedAtMs).toLocaleString()}</time>
                  <button type="button" disabled={busy} onClick={() => void toggleResolved(comment)}>{comment.resolved ? copy.commentReopen : copy.commentResolve}</button>
                  <button type="button" disabled={busy} onClick={() => void remove(comment)}>{copy.commentDelete}</button>
                </footer>
              </article>
            );
          })}
        </div>
      </aside>
    </div>
  );
}
