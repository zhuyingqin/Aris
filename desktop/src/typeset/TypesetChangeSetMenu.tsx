/**
 * The change set's half of the review bar.
 *
 * It used to be a headline, a progress badge and a horizontally scrolling strip
 * of file chips, sitting above the open file's own review row — two rows, two
 * accept/reject pairs, and a diff that read as if it had to be confirmed twice.
 * Everything that identifies the transaction now collapses into one trigger
 * that opens a menu: the file list is the menu's body, and the change-set-wide
 * answers are its footer, so the bar itself carries a single answer pair for
 * whatever is on screen.
 */
import { useRef, useState } from "react";
import { TypesetPopover } from "./TypesetPopover";

export interface ChangeSetMenuFile {
  path: string;
  /** Basename, plus the "deleted" tag when the operation removes the file. */
  label: string;
  title: string;
  /** Its answer is already recorded in the transaction. */
  answered: boolean;
  active: boolean;
}

export interface ChangeSetMenuCopy {
  /** "4 files changed outside the editor" — the trigger's fallback label. */
  headline: string;
  /** "Changed by Chat", already resolved from the actor. */
  actor: string;
  actorTitle: string;
  /** "1 / 4", or null when the set holds a single reviewable file. */
  progress: string | null;
  /** "2 comment changes", or null when the set touches no comments. */
  comments: string | null;
  explanation: string;
  /**
   * "2 earlier unreviewed changes were left in place when this one started",
   * or null when this transaction carried nothing.
   *
   * Those files were never answered and are not being applied — the workspace
   * simply kept what it already held — so the reviewer would otherwise be left
   * believing the queue in front of them is everything outstanding.
   */
  carried: string | null;
  carriedTitle: string | null;
  menuLabel: string;
  selectFile: string;
  acceptAll: string;
  rejectAll: string;
  apply: string;
}

export interface TypesetChangeSetMenuProps {
  files: ChangeSetMenuFile[];
  copy: ChangeSetMenuCopy;
  busy: boolean;
  /** Every file has an answer; the only thing left is writing the set. */
  fullyReviewed: boolean;
  /**
   * The open file owns the bar's right edge, so the change-set-wide answers
   * move into the menu. Two visible accept/reject pairs is the double
   * confirmation this bar exists to avoid.
   */
  actionsInMenu: boolean;
  onSelect: (path: string) => void;
  onAcceptAll: () => void;
  onRejectAll: () => void;
  onApply: () => void;
}

export default function TypesetChangeSetMenu({
  files,
  copy,
  busy,
  fullyReviewed,
  actionsInMenu,
  onSelect,
  onAcceptAll,
  onRejectAll,
  onApply,
}: TypesetChangeSetMenuProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const active = files.find((file) => file.active) ?? null;

  const run = (action: () => void) => {
    setOpen(false);
    action();
  };

  const actions = (
    <>
      {fullyReviewed ? (
        <button type="button" className="accept" disabled={busy} onClick={() => run(onApply)}>
          {copy.apply}
        </button>
      ) : (
        <>
          <button type="button" disabled={busy} onClick={() => run(onRejectAll)}>{copy.rejectAll}</button>
          <button type="button" className="accept" disabled={busy} onClick={() => run(onAcceptAll)}>{copy.acceptAll}</button>
        </>
      )}
    </>
  );

  return (
    <section className="typeset-changeset-review" aria-label="Review project change set">
      <button
        ref={triggerRef}
        type="button"
        className={`typeset-changeset-trigger${open ? " open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={copy.selectFile}
        title={`${copy.headline} · ${copy.actorTitle}`}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="typeset-changeset-trigger-label">{active ? active.label : copy.headline}</span>
        {copy.progress && <span className="typeset-changeset-progress">{copy.progress}</span>}
        <i className="typeset-changeset-caret" aria-hidden="true" />
      </button>
      {/* Attribution stays on the bar. It is the one thing a reviewer needs
          before deciding whether to even open the menu. */}
      <span className="typeset-changeset-actor" title={copy.actorTitle}>{copy.actor}</span>
      {copy.comments && <span className="typeset-changeset-comments">{copy.comments}</span>}
      {!actionsInMenu && <div className="typeset-changeset-actions">{actions}</div>}
      <TypesetPopover
        open={open}
        anchorRef={triggerRef}
        align="start"
        width={320}
        maxHeight={420}
        className="typeset-changeset-menu"
        label={copy.menuLabel}
        onClose={() => setOpen(false)}
      >
        <p className="typeset-changeset-menu-head">
          <strong>{copy.headline}</strong>
          <span title={copy.actorTitle}>{copy.actor}</span>
        </p>
        <div className="typeset-changeset-files" role="menu" aria-label={copy.selectFile}>
          {files.map((file) => (
            <button
              key={file.path}
              type="button"
              role="menuitem"
              className={[file.active ? "active" : "", file.answered ? "reviewed" : ""].filter(Boolean).join(" ")}
              title={file.title}
              onClick={() => run(() => onSelect(file.path))}
            >
              <i className="typeset-changeset-file-done" aria-hidden="true">{file.answered ? "✓" : "•"}</i>
              <span>{file.label}</span>
            </button>
          ))}
        </div>
        {/* Exclusive with the inline cluster: the same label in two places at
            once is the ambiguity this menu was built to remove. */}
        {actionsInMenu && <div className="typeset-changeset-menu-actions">{actions}</div>}
        {copy.carried && (
          <p className="typeset-changeset-menu-note carried" title={copy.carriedTitle ?? undefined}>
            {copy.carried}
          </p>
        )}
        <p className="typeset-changeset-menu-note">{copy.explanation}</p>
      </TypesetPopover>
    </section>
  );
}
