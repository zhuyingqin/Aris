import { SvgIcon } from "../SvgIcon";
import { useStore } from "../store";
import { LITERATURE_COPY } from "./i18n";

export type LiteratureSortKey = "added" | "fit" | "year" | "title" | "venue" | "citations" | "authors";
export type LibraryQuickFilter = "all" | "starred" | "unread";

export default function LiteratureToolbar({
  count, filter, advancedSearchOpen, conditionCount,
  tags, isTrashView, onOpenAdvancedSearch, onSaveSearch,
  onRemoveTag, onClearFilters, onEmptyTrash, quickFilter, quickCounts, onQuickFilter,
}: {
  count: number;
  filter: string;
  advancedSearchOpen: boolean;
  conditionCount: number;
  tags: string[];
  isTrashView: boolean;
  onOpenAdvancedSearch: () => void;
  onSaveSearch: () => void;
  onRemoveTag: (tag: string) => void;
  onClearFilters: () => void;
  onEmptyTrash: () => void;
  quickFilter: LibraryQuickFilter;
  quickCounts: Record<LibraryQuickFilter, number>;
  onQuickFilter: (value: LibraryQuickFilter) => void;
}) {
  const language = useStore((s) => s.language);
  const copy = LITERATURE_COPY[language];
  const ui = copy.libraryUi;
  const filtered = Boolean(filter.trim() || tags.length || conditionCount || quickFilter !== "all");
  return (
    <div className="lit-library-toolbar" data-language={language}>
      <div className="lit-library-filter-row">
        <div className="lit-quick-filters" role="group" aria-label={ui.quickFilters}>
          {(["all", "starred", "unread"] as const).map((key) => <button key={key} type="button"
            className={`lit-quick-filter${quickFilter === key ? " active" : ""}`} aria-pressed={quickFilter === key}
            onClick={() => onQuickFilter(key)}>
            {key !== "all" && <SvgIcon name={key === "starred" ? "star" : "inbox"} size={16} />}
            <span>{key === "all" ? ui.quickAll : key === "starred" ? copy.sidebar.starred : ui.unread}</span>
            <span className="lit-quick-count">{quickCounts[key]}</span>
          </button>)}
        </div>
        <button type="button" className={`lit-library-filter-button${advancedSearchOpen || conditionCount ? " active" : ""}`}
          title={copy.table.advancedSearch} aria-label={copy.table.advancedSearch} aria-expanded={advancedSearchOpen} onClick={onOpenAdvancedSearch}>
          <SvgIcon name="filter" size={16} /><span>{ui.moreFilters}</span>
          {conditionCount > 0 && <span className="lit-filter-count">{conditionCount}</span>}
        </button>
        {isTrashView && count > 0 && <button type="button" className="lit-quiet-button danger" onClick={onEmptyTrash}>{copy.table.emptyTrash}</button>}
      </div>
      {filtered && <div className="lit-active-filters" aria-label={ui.filters}>
        {tags.map((tag) => <button type="button" key={tag} className="lit-filter-chip" aria-label={ui.removeTag(tag)} onClick={() => onRemoveTag(tag)}>
          <span>{tag}</span><SvgIcon name="close" size={11} />
        </button>)}
        {conditionCount > 0 && <span className="lit-filter-chip">{ui.conditions(conditionCount)}</span>}
        <button type="button" className="lit-quiet-button" onClick={onClearFilters}>{ui.clearFilters}</button>
        {filter.trim() && <button type="button" className="lit-quiet-button lit-save-view" title={copy.table.saveSearchTitle} onClick={onSaveSearch}>{ui.saveView}</button>}
      </div>}
    </div>
  );
}