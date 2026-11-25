import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  literatureWriteBibliographyExport,
  typesetCommentDelete,
  typesetCommentsList,
  typesetCommentUpsert,
  type TypesetComment,
} from "../api/tauri";
import { useStore } from "../store";
import { languageLocale, tr, type Language } from "../language";
import { TYPESET_EDITOR_COPY } from "./i18n";
import { basename } from "./latexText";

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

const lineAt = (source: string, offset: number) => {
  let line = 1;
  for (let index = source.indexOf("\n"); index >= 0 && index < offset; index = source.indexOf("\n", index + 1)) line += 1;
  return line;
};

/**
 * The file's comments as Markdown: each with its line, the text it is on,
 * whether it is resolved, and its replies — something to send a co-author or
 * keep with a revision.
 */
export function commentsMarkdown(path: string, source: string, comments: TypesetComment[], language: Language): string {
  const t = (cn: string, en: string, es: string) => tr(language, cn, en, es);
  const when = (epochMs: number) => new Date(epochMs).toLocaleString(languageLocale(language));
  const quote = (text: string) => text.split("\n").map((line) => `> ${line}`).join("\n");
  const ordered = comments
    .map((comment) => ({ comment, range: commentRangeInSource(comment, source) }))
    .sort((left, right) => left.range.from - right.range.from);
  const open = ordered.filter(({ comment }) => !comment.resolved).length;
  const lines = [
    `# ${t("批注", "Comments", "Comentarios")}: ${path}`,
    "",
    t(
      `共 ${ordered.length} 条，未解决 ${open} 条 · 导出于 ${when(Date.now())}`,
      `${ordered.length} comments, ${open} open · exported ${when(Date.now())}`,
      `${ordered.length} comentarios, ${open} abiertos · exportado ${when(Date.now())}`,
    ),
  ];
  ordered.forEach(({ comment, range }, index) => {
    const status = comment.resolved ? t("已解决", "resolved", "resuelto") : t("未解决", "open", "abierto");
    const line = lineAt(source, range.from);
    lines.push("", `## ${index + 1}. ${t(`第 ${line} 行`, `Line ${line}`, `Línea ${line}`)} · ${status}`, "");
    if (comment.selectedText) lines.push(quote(comment.selectedText), "");
    lines.push(`**${comment.author}** · ${when(comment.createdAtMs)}`, "", comment.body);
    for (const reply of comment.replies ?? []) {
      lines.push("", `- **${reply.author}** · ${when(reply.createdAtMs)}: ${reply.body.replace(/\n/g, "\n  ")}`);
    }
  });
  return `${lines.join("\n")}\n`;
}

export default function TypesetCommentsPanel({
  path,
  source,
  selection,
  focusCommentId = null,
  onClose,
  onNavigate,
  onCommentsChanged,
}: {
  path: string;
  source: string;
  selection: TypesetSourceRange;
  /** Opened from a comment in the editor: show that one. */
  focusCommentId?: string | null;
  onClose: () => void;
  onNavigate: (range: TypesetSourceRange) => void;
  /** Every reload of the list, so the editors' highlights follow it. */
  onCommentsChanged?: (comments: TypesetComment[]) => void;
}) {
  const language = useStore((state) => state.language);
  const copy = TYPESET_EDITOR_COPY[language].workbench;
  const [comments, setComments] = useState<TypesetComment[]>([]);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const [exported, setExported] = useState<string | null>(null);
  const focusedRef = useRef<HTMLElement | null>(null);
  const onCommentsChangedRef = useRef(onCommentsChanged);
  onCommentsChangedRef.current = onCommentsChanged;
  const anchoredSelection = useMemo(() => {
    const from = Math.max(0, Math.min(selection.from, source.length));
    return { from, to: Math.max(from, Math.min(selection.to, source.length)) };
  }, [selection, source.length]);

  const refresh = useCallback(async () => {
    try {
      const next = await typesetCommentsList(path);
      setComments(next);
      onCommentsChangedRef.current?.(next);
    } catch (reason) {
      setError(String(reason));
    }
  }, [path]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (focusCommentId && comments.some((comment) => comment.id === focusCommentId)) {
      focusedRef.current?.scrollIntoView?.({ block: "nearest" });
    }
  }, [comments, focusCommentId]);

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

  const reply = async (comment: TypesetComment) => {
    if (!replyBody.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await typesetCommentUpsert(path, {
        ...comment,
        replies: [
          ...(comment.replies ?? []),
          { id: "", body: replyBody, author: copy.commentAuthorYou, origin: "user", createdAtMs: 0 },
        ],
      });
      setReplyBody("");
      setReplyingTo(null);
      await refresh();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const exportMarkdown = async () => {
    setError(null);
    try {
      const destination = await saveDialog({
        defaultPath: `${basename(path).replace(/\.[^.]+$/, "")}-comments.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (typeof destination !== "string") return;
      await literatureWriteBibliographyExport(destination, commentsMarkdown(path, source, comments, language));
      setExported(destination);
    } catch (reason) {
      setError(String(reason));
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
          <button
            type="button"
            className="typeset-comments-export"
            disabled={comments.length === 0}
            onClick={() => void exportMarkdown()}
          >
            {tr(language, "导出 Markdown", "Export Markdown", "Exportar Markdown")}
          </button>
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
        {exported && <p className="typeset-comments-exported" role="status">{tr(language, `已导出到 ${exported}`, `Exported to ${exported}`, `Exportado a ${exported}`)}</p>}
        <div className="typeset-comments-list">
          {ordered.length === 0 && <p>{copy.commentsEmpty}</p>}
          {ordered.map((comment) => {
            const range = commentRangeInSource(comment, source);
            const focused = comment.id === focusCommentId;
            const replies = comment.replies ?? [];
            return (
              <article
                key={comment.id}
                ref={focused ? (element) => { focusedRef.current = element; } : undefined}
                className={`${comment.resolved ? "resolved" : ""}${focused ? " focused" : ""}`.trim()}
              >
                <button type="button" className="typeset-comment-body" onClick={() => onNavigate(range)}>
                  <strong>{comment.author}</strong>
                  <span>{comment.body}</span>
                  {comment.selectedText && <code>{comment.selectedText.replace(/\s+/g, " ").slice(0, 160)}</code>}
                </button>
                {replies.length > 0 && (
                  <ol className="typeset-comment-replies" aria-label={tr(language, "回复", "Replies", "Respuestas")}>
                    {replies.map((item) => (
                      <li key={item.id}>
                        <strong>{item.author}</strong>
                        <time>{new Date(item.createdAtMs).toLocaleString(languageLocale(language))}</time>
                        <p>{item.body}</p>
                      </li>
                    ))}
                  </ol>
                )}
                {replyingTo === comment.id && (
                  <div className="typeset-comment-reply-compose">
                    <textarea
                      autoFocus
                      value={replyBody}
                      aria-label={tr(language, "回复内容", "Reply", "Respuesta")}
                      placeholder={tr(language, "写下回复…（Ctrl+Enter 发送）", "Write a reply… (Ctrl+Enter sends)", "Escribe una respuesta… (Ctrl+Enter envía)")}
                      onChange={(event) => setReplyBody(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                          event.preventDefault();
                          void reply(comment);
                        }
                      }}
                    />
                    <div>
                      <button type="button" disabled={busy} onClick={() => { setReplyingTo(null); setReplyBody(""); }}>{tr(language, "取消", "Cancel", "Cancelar")}</button>
                      <button type="button" className="primary" disabled={busy || !replyBody.trim()} onClick={() => void reply(comment)}>{tr(language, "发送回复", "Send reply", "Enviar respuesta")}</button>
                    </div>
                  </div>
                )}
                <footer>
                  <time>{new Date(comment.updatedAtMs).toLocaleString(languageLocale(language))}</time>
                  <button type="button" disabled={busy} onClick={() => { setReplyingTo(comment.id); setReplyBody(""); }}>{tr(language, "回复", "Reply", "Responder")}</button>
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
