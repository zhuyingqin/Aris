import { useRef, useState } from "react";
import type { TrackedChange } from "../editor/trackChanges";
import { languageLocale, tr, type Language } from "../language";
import { TypesetPopover } from "./TypesetPopover";

/**
 * The editor toolbar's track-changes switch, and the list of what it has
 * recorded: each change with accept/reject, and both for all of them.
 */
export default function TypesetTrackChangesControl({
  enabled,
  changes,
  language,
  onToggle,
  onResolve,
  onNavigate,
}: {
  enabled: boolean;
  changes: TrackedChange[];
  language: Language;
  onToggle: () => void;
  onResolve: (ids: string[], action: "accept" | "reject") => void;
  onNavigate: (change: TrackedChange) => void;
}) {
  const t = (cn: string, en: string, es: string) => tr(language, cn, en, es);
  const [open, setOpen] = useState(false);
  const listButtonRef = useRef<HTMLButtonElement | null>(null);
  const toggleLabel = enabled
    ? t("停止追踪修订", "Stop tracking changes", "Dejar de controlar cambios")
    : t("追踪修订", "Track changes", "Control de cambios");
  const listLabel = t(`修订（${changes.length}）`, `Tracked changes (${changes.length})`, `Cambios (${changes.length})`);
  const ids = changes.map((change) => change.id);
  const snippet = (text: string) => {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat || "⏎";
  };

  return (
    <span className={`typeset-track-changes${enabled ? " recording" : ""}`}>
      <button
        type="button"
        className={`ol-cm-toolbar-button typeset-track-changes-toggle${enabled ? " active" : ""}`}
        title={toggleLabel}
        aria-label={toggleLabel}
        aria-pressed={enabled}
        onClick={onToggle}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M3 12.5 10.6 4.9l1.9 1.9-7.6 7.6H3zM9.6 5.9l1.9 1.9M2.5 2.5h5" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {(changes.length > 0 || enabled) && (
        <button
          ref={listButtonRef}
          type="button"
          className="ol-cm-toolbar-button typeset-track-changes-count"
          title={listLabel}
          aria-label={listLabel}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {changes.length}
        </button>
      )}
      <TypesetPopover
        open={open}
        anchorRef={listButtonRef}
        align="start"
        width={340}
        maxHeight={420}
        className="typeset-track-changes-menu"
        label={t("修订列表", "Tracked changes list", "Lista de cambios")}
        onClose={() => setOpen(false)}
      >
        <header>
          <strong>{listLabel}</strong>
          <button type="button" disabled={ids.length === 0} onClick={() => onResolve(ids, "accept")}>{t("全部接受", "Accept all", "Aceptar todo")}</button>
          <button type="button" disabled={ids.length === 0} onClick={() => onResolve(ids, "reject")}>{t("全部拒绝", "Reject all", "Rechazar todo")}</button>
        </header>
        {changes.length === 0 ? (
          <p className="typeset-track-changes-empty">{enabled
            ? t("正在追踪：之后的插入和删除会列在这里。", "Tracking: insertions and deletions from now on appear here.", "Controlando: las inserciones y eliminaciones aparecerán aquí.")
            : t("没有修订。", "No tracked changes.", "No hay cambios.")}</p>
        ) : (
          <ol>
            {changes.map((change) => (
              <li key={change.id} className={change.kind}>
                <button type="button" className="typeset-track-changes-jump" onClick={() => onNavigate(change)}>
                  <b>{change.kind === "insert" ? "+" : "−"}</b>
                  <span>{snippet(change.text)}</span>
                  <em>{change.author} · {new Date(change.createdAtMs).toLocaleString(languageLocale(language))}</em>
                </button>
                <button type="button" aria-label={t("接受", "Accept", "Aceptar")} title={t("接受", "Accept", "Aceptar")} onClick={() => onResolve([change.id], "accept")}>✓</button>
                <button type="button" aria-label={t("拒绝", "Reject", "Rechazar")} title={t("拒绝", "Reject", "Rechazar")} onClick={() => onResolve([change.id], "reject")}>✕</button>
              </li>
            ))}
          </ol>
        )}
      </TypesetPopover>
    </span>
  );
}
