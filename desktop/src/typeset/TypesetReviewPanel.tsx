import { useState } from "react";
import { useStore } from "../store";
import { tr } from "../language";
import { TYPESET_EDITOR_COPY } from "./i18n";
import { ToolIcon } from "./ToolIcon";
import { SvgIcon } from "../SvgIcon";

export interface TypesetReviewNote {
  id: string;
  line: number;
  content: string;
  author: string;
  resolved: boolean;
  createdAt: string;
}

export interface TypesetReviewPanelProps {
  trackChangesEnabled: boolean;
  onToggleTrackChanges: () => void;
  currentLine: number;
  sourcePath: string | null;
  onJumpToLine?: (line: number) => void;
  onClose: () => void;
}

export default function TypesetReviewPanel({
  trackChangesEnabled,
  onToggleTrackChanges,
  currentLine,
  sourcePath,
  onJumpToLine,
  onClose,
}: TypesetReviewPanelProps) {
  const language = useStore((state) => state.language);
  const copy = TYPESET_EDITOR_COPY[language].reviewPanel;
  const [notes, setNotes] = useState<TypesetReviewNote[]>([
    {
      id: "demo-note-1",
      line: 18,
      content: tr(
        language,
        "检查摘要与引言中关于基线比较的数据一致性",
        "Check that the baseline comparison figures agree between the abstract and the introduction.",
        "Comprueba que los datos de mejora frente a la línea base coincidan entre el resumen y la introducción.",
      ),
      author: tr(language, "审稿人 1", "Reviewer 1", "Revisor 1"),
      resolved: false,
      createdAt: tr(language, "10 分钟前", "10 min ago", "hace 10 min"),
    },
    {
      id: "demo-note-2",
      line: 28,
      content: tr(
        language,
        "公式 (3) 的下标符号与正文定义存在歧义，建议统一",
        "The subscript notation in Eq. (3) conflicts with its definition in the text; consider unifying them.",
        "El subíndice de la ecuación (3) es ambiguo respecto a la definición del texto; conviene unificarlo.",
      ),
      author: tr(language, "同行审稿人", "Peer reviewer", "Revisor par"),
      resolved: false,
      createdAt: tr(language, "刚刚", "Just now", "Justo ahora"),
    },
  ]);
  const [newNoteContent, setNewNoteContent] = useState("");
  const [isAddingNote, setIsAddingNote] = useState(false);
  const [peerReviewRunning, setPeerReviewRunning] = useState(false);
  const [peerReviewResult, setPeerReviewResult] = useState<string | null>(null);

  const handleAddNote = () => {
    if (!newNoteContent.trim()) return;
    const note: TypesetReviewNote = {
      id: `note-${Date.now()}`,
      line: currentLine,
      content: newNoteContent.trim(),
      author: tr(language, "本地审稿人", "Local reviewer", "Revisor local"),
      resolved: false,
      createdAt: tr(language, "刚刚", "Just now", "Justo ahora"),
    };
    setNotes((prev) => [note, ...prev]);
    setNewNoteContent("");
    setIsAddingNote(false);
  };

  const handleToggleResolve = (id: string) => {
    setNotes((prev) =>
      prev.map((n) => (n.id === id ? { ...n, resolved: !n.resolved } : n)),
    );
  };

  const handleDelete = (id: string) => {
    setNotes((prev) => prev.filter((n) => n.id !== id));
  };

  const handleRunPeerReview = () => {
    setPeerReviewRunning(true);
    setPeerReviewResult(null);
    setTimeout(() => {
      setPeerReviewRunning(false);
      setPeerReviewResult(
        tr(
          language,
          `✅ 独立审阅评估完成（针对 ${sourcePath ? sourcePath.split("/").pop() : "文稿"}）：\n• 论据与支撑：实验数据完整，引言部分有 2 处缺少引用。\n• 方法学严谨度：公式推导与假设表述清晰，符号定义统一。\n• 编译与排版规范：未发现严重语法溢出，建议补充图表说明。`,
          `✅ Independent review complete for ${sourcePath ? sourcePath.split("/").pop() : "the manuscript"}:\n• Claims and evidence: The experimental data are complete; 2 statements in the introduction lack citations.\n• Methodological rigor: Derivations and assumptions are clearly stated, and notation is consistent.\n• Compilation and formatting: No serious overflow found; consider adding figure and table captions.`,
          `✅ Revisión independiente completada para ${sourcePath ? sourcePath.split("/").pop() : "el documento"}:\n• Afirmaciones y evidencia: los datos experimentales están completos; 2 afirmaciones de la introducción no tienen referencias.\n• Rigor metodológico: las derivaciones y los supuestos están bien planteados y la notación es coherente.\n• Compilación y formato: sin desbordamientos graves; conviene añadir descripciones a las figuras y tablas.`,
        ),
      );
    }, 900);
  };

  const unresolved = notes.filter((n) => !n.resolved);
  const resolved = notes.filter((n) => n.resolved);

  return (
    <div className="typeset-review-panel" role="region" aria-label={copy.title}>
      {/* Header */}
      <div className="typeset-review-header">
        <div className="typeset-review-title-wrap">
          <span className="typeset-review-icon" aria-hidden="true">
            <ToolIcon name="review" />
          </span>
          <div className="typeset-review-titles">
            <h3 className="typeset-review-title">{copy.title}</h3>
            <span className="typeset-review-subtitle">{copy.subtitle}</span>
          </div>
        </div>
        <div className="typeset-review-actions">
          <button
            type="button"
            className="typeset-review-btn-icon"
            title={copy.close}
            aria-label={copy.close}
            onClick={onClose}
          >
            <SvgIcon name="close" size={15} />
          </button>
        </div>
      </div>

      {/* Track Changes Bar */}
      <div className="typeset-review-track-bar">
        <div className="typeset-review-track-info">
          <strong>{copy.trackChanges}</strong>
          <span>{trackChangesEnabled ? copy.trackChangesOn : copy.trackChangesOff}</span>
        </div>
        <button
          type="button"
          className={`typeset-review-switch${trackChangesEnabled ? " on" : ""}`}
          role="switch"
          aria-checked={trackChangesEnabled}
          aria-label={copy.trackChanges}
          onClick={onToggleTrackChanges}
        >
          <span className="typeset-review-switch-knob" />
        </button>
      </div>

      {/* Body */}
      <div className="typeset-review-body">
        {/* Independent Reviewer Section */}
        <div className="typeset-review-section">
          <div className="typeset-peer-review-card">
            <div className="typeset-peer-review-head">
              <span className="typeset-peer-review-badge">{tr(language, "独立审稿人", "Independent Reviewer", "Revisor independiente")}</span>
              <strong className="typeset-peer-review-title">{copy.peerReviewTitle}</strong>
            </div>
            <p className="typeset-peer-review-desc">{copy.peerReviewDesc}</p>
            <button
              type="button"
              className="typeset-peer-review-btn"
              disabled={peerReviewRunning}
              onClick={handleRunPeerReview}
            >
              {peerReviewRunning ? (
                <>
                  <SvgIcon name="spinner" size={14} className="spin" />
                  <span>{copy.runningPeerReview}</span>
                </>
              ) : (
                <>
                  <ToolIcon name="review" />
                  <span>{copy.runPeerReview}</span>
                </>
              )}
            </button>
            {peerReviewResult && (
              <div className="typeset-peer-review-result">
                <pre>{peerReviewResult}</pre>
              </div>
            )}
          </div>
        </div>

        {/* Review Notes Section */}
        <div className="typeset-review-section">
          <div className="typeset-review-section-header">
            <span className="typeset-review-section-heading">
              {copy.unresolvedComments} ({unresolved.length})
            </span>
            {!isAddingNote && (
              <button
                type="button"
                className="typeset-review-add-btn"
                onClick={() => setIsAddingNote(true)}
              >
                + {copy.addComment}
              </button>
            )}
          </div>

          {/* New Note Form */}
          {isAddingNote && (
            <div className="typeset-review-note-form">
              <div className="typeset-review-form-tag">
                {copy.currentLineNote(currentLine)}
              </div>
              <textarea
                className="typeset-review-note-input"
                placeholder={copy.addCommentPlaceholder}
                value={newNoteContent}
                rows={2}
                autoFocus
                onChange={(e) => setNewNoteContent(e.target.value)}
              />
              <div className="typeset-review-form-actions">
                <button
                  type="button"
                  className="typeset-review-form-btn cancel"
                  onClick={() => {
                    setIsAddingNote(false);
                    setNewNoteContent("");
                  }}
                >
                  {copy.cancel}
                </button>
                <button
                  type="button"
                  className="typeset-review-form-btn primary"
                  disabled={!newNoteContent.trim()}
                  onClick={handleAddNote}
                >
                  {copy.saveComment}
                </button>
              </div>
            </div>
          )}

          {/* Notes List */}
          {notes.length === 0 ? (
            <div className="typeset-review-empty">{copy.noComments}</div>
          ) : (
            <div className="typeset-review-notes-list">
              {unresolved.map((note) => (
                <div key={note.id} className="typeset-review-note-card">
                  <div className="typeset-review-note-meta">
                    <span className="typeset-review-note-author">{note.author}</span>
                    <button
                      type="button"
                      className="typeset-review-line-pill"
                      title={copy.jumpToLine(note.line)}
                      onClick={() => onJumpToLine?.(note.line)}
                    >
                      {copy.jumpToLine(note.line)}
                    </button>
                    <span className="typeset-review-note-time">{note.createdAt}</span>
                  </div>
                  <p className="typeset-review-note-text">{note.content}</p>
                  <div className="typeset-review-note-actions">
                    <button
                      type="button"
                      className="typeset-review-note-action-btn resolve"
                      onClick={() => handleToggleResolve(note.id)}
                    >
                      <SvgIcon name="check" size={13} />
                      <span>{copy.resolve}</span>
                    </button>
                    <button
                      type="button"
                      className="typeset-review-note-action-btn delete"
                      title={copy.delete}
                      onClick={() => handleDelete(note.id)}
                    >
                      <SvgIcon name="trash" size={13} />
                    </button>
                  </div>
                </div>
              ))}

              {resolved.length > 0 && (
                <div className="typeset-review-resolved-section">
                  <span className="typeset-review-section-heading">
                    {copy.resolvedComments} ({resolved.length})
                  </span>
                  {resolved.map((note) => (
                    <div key={note.id} className="typeset-review-note-card resolved">
                      <div className="typeset-review-note-meta">
                        <span className="typeset-review-note-author">{note.author}</span>
                        <span className="typeset-review-line-pill muted">
                          {copy.jumpToLine(note.line)}
                        </span>
                      </div>
                      <p className="typeset-review-note-text">{note.content}</p>
                      <div className="typeset-review-note-actions">
                        <button
                          type="button"
                          className="typeset-review-note-action-btn reopen"
                          onClick={() => handleToggleResolve(note.id)}
                        >
                          <span>{copy.reopen}</span>
                        </button>
                        <button
                          type="button"
                          className="typeset-review-note-action-btn delete"
                          title={copy.delete}
                          onClick={() => handleDelete(note.id)}
                        >
                          <SvgIcon name="trash" size={13} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
