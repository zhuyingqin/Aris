import { useState } from "react";
import {
  typesetProjectReplace,
  typesetProjectSearch,
  type TypesetProjectReplaceResult,
  type TypesetProjectSearchMatch,
} from "../api/tauri";
import { useStore } from "../store";
import { TYPESET_EDITOR_COPY } from "./i18n";

export default function TypesetProjectSearchPanel({
  onClose,
  onOpenMatch,
  onBeforeReplace,
  onReplaced,
}: {
  onClose: () => void;
  onOpenMatch: (match: TypesetProjectSearchMatch) => void;
  onBeforeReplace: () => Promise<boolean>;
  onReplaced: (result: TypesetProjectReplaceResult) => Promise<void>;
}) {
  const language = useStore((state) => state.language);
  const copy = TYPESET_EDITOR_COPY[language].workbench;
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [matches, setMatches] = useState<TypesetProjectSearchMatch[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const search = async () => {
    if (!query.trim()) return;
    setBusy(true);
    setNotice(null);
    try {
      setMatches(await typesetProjectSearch(query, caseSensitive));
    } catch (reason) {
      setNotice(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const replaceAll = async () => {
    if (!matches?.length || !window.confirm(copy.projectReplaceConfirm(matches.length))) return;
    setBusy(true);
    setNotice(null);
    try {
      if (!await onBeforeReplace()) return;
      const result = await typesetProjectReplace(query, replacement, caseSensitive);
      await onReplaced(result);
      setNotice(copy.projectReplaceDone(result.replacements, result.filesChanged));
      setMatches(await typesetProjectSearch(query, caseSensitive));
    } catch (reason) {
      setNotice(String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="typeset-project-search-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="typeset-project-search-panel" role="dialog" aria-modal="true" aria-label={copy.projectSearchTitle} onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <strong>{copy.projectSearchTitle}</strong>
          <button type="button" aria-label={copy.projectSearchClose} onClick={onClose}>×</button>
        </header>
        <div className="typeset-project-search-form">
          <input autoFocus value={query} placeholder={copy.projectSearchPlaceholder} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void search(); }} />
          <input value={replacement} placeholder={copy.projectReplacePlaceholder} onChange={(event) => setReplacement(event.target.value)} />
          <label><input type="checkbox" checked={caseSensitive} onChange={(event) => setCaseSensitive(event.target.checked)} />{copy.projectSearchCaseSensitive}</label>
          <button type="button" disabled={busy || !query.trim()} onClick={() => void search()}>{copy.projectSearchAction}</button>
          <button type="button" disabled={busy || !matches?.length} onClick={() => void replaceAll()}>{copy.projectReplaceAction}</button>
        </div>
        {notice && <p className="typeset-project-search-notice">{notice}</p>}
        <div className="typeset-project-search-results">
          {matches?.length === 0 && <p>{copy.projectSearchEmpty}</p>}
          {matches?.map((match, index) => (
            <button type="button" key={`${match.path}:${match.line}:${match.column}:${index}`} onClick={() => onOpenMatch(match)}>
              <strong>{match.path}</strong>
              <span>{match.line}:{match.column}</span>
              <code>{match.preview}</code>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
