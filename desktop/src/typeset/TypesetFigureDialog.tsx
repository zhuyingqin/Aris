/**
 * The insert/edit-figure dialog — our answer to Overleaf's `figure-modal`.
 *
 * The toolbar used to drop a fixed snippet pointing at a `figure.png` that does
 * not exist, leaving the user to fix the path, the width, the caption and the
 * label by hand. This picks the file from the project, sizes it, and writes a
 * float that compiles as it stands.
 */
import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { TYPESET_EDITOR_COPY } from "./i18n";
import { ToolIcon } from "./ToolIcon";
import {
  DEFAULT_FIGURE_DRAFT,
  FIGURE_WIDTH_CHOICES,
  isFigureImage,
  suggestedFigureLabel,
  type FigureDraft,
} from "./latexFigure";

export default function TypesetFigureDialog({
  open,
  initial,
  imagePaths,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  /** Pre-filled when editing an existing `\includegraphics`. */
  initial?: Partial<FigureDraft> | null;
  /** Project-relative paths of every image the project contains. */
  imagePaths: readonly string[];
  onCancel: () => void;
  onConfirm: (draft: FigureDraft) => void;
}) {
  const language = useStore((state) => state.language);
  const copy = TYPESET_EDITOR_COPY[language].figureDialog;
  const [draft, setDraft] = useState<FigureDraft>(DEFAULT_FIGURE_DRAFT);
  const [filter, setFilter] = useState("");
  const [labelTouched, setLabelTouched] = useState(false);

  const images = useMemo(
    () => imagePaths.filter(isFigureImage).filter((path) => path.toLowerCase().includes(filter.trim().toLowerCase())),
    [filter, imagePaths],
  );

  useEffect(() => {
    if (!open) return;
    setDraft({ ...DEFAULT_FIGURE_DRAFT, ...(initial ?? {}) });
    setFilter("");
    setLabelTouched(Boolean(initial?.label));
  }, [initial, open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, open]);

  if (!open) return null;

  const choose = (path: string) => {
    setDraft((current) => ({
      ...current,
      path,
      // Keep a label the user typed; otherwise follow the file they picked.
      label: labelTouched ? current.label : suggestedFigureLabel(path),
    }));
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft.path.trim()) return;
    onConfirm(draft);
  };

  return (
    <div className="typeset-citation-backdrop" role="presentation" onMouseDown={onCancel}>
      <form
        className="typeset-figure-dialog"
        aria-label={copy.title}
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={submit}
      >
        <header>
          <strong>{copy.title}</strong>
          <button type="button" aria-label={copy.cancel} title={copy.cancel} onClick={onCancel}>
            <ToolIcon name="clear" />
          </button>
        </header>

        <label className="typeset-figure-field">
          <span>{copy.imageFile}</span>
          <input
            type="text"
            value={draft.path}
            placeholder={copy.pathPlaceholder}
            onChange={(event) => choose(event.currentTarget.value)}
          />
        </label>

        <div className="typeset-figure-picker">
          <div className="typeset-figure-filter">
            <ToolIcon name="search" />
            <input
              type="search"
              value={filter}
              aria-label={copy.filterLabel}
              placeholder={copy.filterPlaceholder}
              onChange={(event) => setFilter(event.currentTarget.value)}
            />
          </div>
          <div className="typeset-figure-list" role="listbox" aria-label={copy.projectImages}>
            {images.map((path) => (
              <button
                key={path}
                type="button"
                role="option"
                aria-selected={path === draft.path}
                className={path === draft.path ? "selected" : ""}
                onClick={() => choose(path)}
              >
                {path}
              </button>
            ))}
            {images.length === 0 ? <p>{copy.noImages}</p> : null}
          </div>
        </div>

        <div className="typeset-figure-row">
          <label className="typeset-figure-field">
            <span>{copy.width}</span>
            <select
              value={String(draft.widthFraction)}
              onChange={(event) => {
                // Read the value now: React clears `currentTarget` when the
                // handler returns, and a functional updater runs later.
                const widthFraction = Number(event.currentTarget.value);
                setDraft((current) => ({ ...current, widthFraction }));
              }}
            >
              {FIGURE_WIDTH_CHOICES.map((fraction) => (
                <option key={fraction} value={String(fraction)}>
                  {fraction === 0 ? copy.originalSize : `${Math.round(fraction * 100)}%`}
                </option>
              ))}
            </select>
          </label>
          <label className="typeset-figure-field">
            <span>{copy.placement}</span>
            <input
              type="text"
              value={draft.placement}
              onChange={(event) => {
                const placement = event.currentTarget.value;
                setDraft((current) => ({ ...current, placement }));
              }}
            />
          </label>
        </div>

        <label className="typeset-figure-field">
          <span>{copy.caption}</span>
          <input
            type="text"
            value={draft.caption}
            onChange={(event) => {
              const caption = event.currentTarget.value;
              setDraft((current) => ({ ...current, caption }));
            }}
          />
        </label>

        <label className="typeset-figure-field">
          <span>{copy.label}</span>
          <input
            type="text"
            value={draft.label}
            placeholder="fig:example"
            onChange={(event) => {
              const label = event.currentTarget.value;
              setLabelTouched(true);
              setDraft((current) => ({ ...current, label }));
            }}
          />
        </label>

        <label className="typeset-figure-check">
          <input
            type="checkbox"
            checked={draft.centered}
            onChange={(event) => {
              const centered = event.currentTarget.checked;
              setDraft((current) => ({ ...current, centered }));
            }}
          />
          <span>{copy.centered}</span>
        </label>

        <footer>
          <button type="button" onClick={onCancel}>{copy.cancel}</button>
          <button type="submit" className="primary" disabled={!draft.path.trim()}>{copy.insert}</button>
        </footer>
      </form>
    </div>
  );
}
