import { useRef, type RefObject } from "react";
import { SvgIcon } from "../SvgIcon";
import { useStore } from "../store";
import { LITERATURE_COPY } from "./i18n";
import LibraryActionMenu from "./LibraryActionMenu";

export type LiteratureSortKey = "added" | "fit" | "year" | "title" | "venue" | "citations";

export default function LiteratureToolbar({
  viewLabel, count, total, filter, sort, sortDescending, onToggleSortDirection, advancedSearchOpen, conditionCount,
  tags, navigationOpen, detailsOpen, isTrashView, onFilterChange, onSortChange,
  onToggleNavigation, onToggleDetails, onOpenAdvancedSearch, onSaveSearch,
  onRemoveTag, onClearFilters, onCreateItem, onImportBibliography, onImportPdf,
  onAddIdentifier, onEmptyTrash, searchRef,
}: {
  viewLabel: string;
  count: number;
  total?: number;
  filter: string;
  sort: LiteratureSortKey;
  sortDescending: boolean;
  onToggleSortDirection: () => void;
  advancedSearchOpen: boolean;
  conditionCount: number;
  tags: string[];
  navigationOpen: boolean;
  detailsOpen: boolean;
  isTrashView: boolean;
  onFilterChange: (value: string) => void;
  onSortChange: (value: LiteratureSortKey) => void;
  onToggleNavigation: () => void;
  onToggleDetails: () => void;
  onOpenAdvancedSearch: () => void;
  onSaveSearch: () => void;
  onRemoveTag: (tag: string) => void;
  onClearFilters: () => void;
  onCreateItem: () => void;
  onImportBibliography: () => void;
  onImportPdf: () => void;
  onAddIdentifier: () => void;
  onEmptyTrash: () => void;
  /** Lets the page focus the search from its keyboard shortcut. */
  searchRef?: RefObject<HTMLInputElement>;
}) {
  const language = useStore((s) => s.language);
  const copy = LITERATURE_COPY[language];
  const ui = copy.libraryUi;
  const localSearch = useRef<HTMLInputElement>(null);
  const search = searchRef ?? localSearch;
  const filtered = Boolean(filter.trim() || tags.length || conditionCount);

  return (
    <div className="lit-library-toolbar" data-language={language}>
      <div className="lit-library-heading">
        <button type="button" className="lit-layout-toggle" aria-label={navigationOpen ? ui.hideNavigation : ui.showNavigation}
          title={navigationOpen ? ui.hideNavigation : ui.showNavigation} aria-expanded={navigationOpen}
          aria-controls="literature-navigation" onClick={onToggleNavigation}>
          <SvgIcon name="panelLeft" size={17} />
        </button>
        <div className="lit-library-heading-copy">
          <h2 title={viewLabel}>{viewLabel}</h2>
          <span aria-live="polite">{total === undefined ? ui.results(count) : ui.filteredResults(count, total)}</span>
        </div>
        {isTrashView ? count > 0 && (
          <button type="button" className="lit-quiet-button danger" onClick={onEmptyTrash}>{copy.table.emptyTrash}</button>
        ) : (
          <LibraryActionMenu label={ui.add} icon="plus" showLabel primary actions={[
            { id: "pdf", label: copy.table.importPdf, description: ui.importPdfHint, icon: "upload", onSelect: onImportPdf },
            { id: "bibliography", label: copy.table.importBibliography, description: ui.importBibliographyHint, icon: "library", onSelect: onImportBibliography },
            { id: "identifier", label: copy.table.addIdentifier, description: ui.identifierHint, icon: "search", onSelect: onAddIdentifier },
            { id: "manual", label: copy.table.newItem, description: ui.manualHint, icon: "edit", onSelect: onCreateItem },
          ]} />
        )}
        <button type="button" className={`lit-layout-toggle${detailsOpen ? " active" : ""}`}
          aria-label={detailsOpen ? ui.hideDetails : ui.showDetails} title={detailsOpen ? ui.hideDetails : ui.showDetails}
          aria-expanded={detailsOpen} aria-controls="literature-details" onClick={onToggleDetails}>
          <SvgIcon name="panelRight" size={17} />
        </button>
      </div>
      <div className="lit-library-search-row">
        <div className="lit-library-search">
          <SvgIcon name="search" size={15} />
          <input ref={search} value={filter} onChange={(event) => onFilterChange(event.target.value)}
            placeholder={copy.table.filterPlaceholder} aria-label={copy.table.filterAria} aria-keyshortcuts="/ Control+F Meta+F"
            onKeyDown={(event) => { if (event.key === "Escape" && filter) { event.stopPropagation(); onFilterChange(""); } }} />
          {filter && <button type="button" aria-label={copy.table.clearFilterAria} title={copy.table.clearFilterAria}
            onClick={() => { onFilterChange(""); search.current?.focus(); }}><SvgIcon name="close" size={14} /></button>}
        </div>
        <button type="button" className={`lit-library-filter-button${advancedSearchOpen || conditionCount ? " active" : ""}`}
          title={copy.table.advancedSearch} aria-label={copy.table.advancedSearch} aria-expanded={advancedSearchOpen}
          onClick={onOpenAdvancedSearch}>
          <SvgIcon name="filter" size={15} /><span>{ui.filters}</span>
          {conditionCount > 0 && <span className="lit-filter-count">{conditionCount}</span>}
        </button>
        <select className="lit-library-sort" value={sort} onChange={(event) => onSortChange(event.target.value as LiteratureSortKey)} aria-label={copy.table.sortAria}>
          <option value="added">{copy.table.sortAdded}</option>
          <option value="fit">{copy.table.sortFit}</option>
          <option value="year">{copy.table.sortYear}</option>
          <option value="citations">{copy.table.sortCitations}</option>
          <option value="title">{copy.table.sortTitle}</option>
          <option value="venue">{copy.table.columnVenue}</option>
        </select>
        <button type="button" className="lit-library-sort-direction" onClick={onToggleSortDirection}
          aria-label={sortDescending ? ui.sortDescending : ui.sortAscending}
          title={sortDescending ? ui.sortDescending : ui.sortAscending}>
          <SvgIcon name={sortDescending ? "chevronDown" : "chevronUp"} size={14} />
        </button>
      </div>
      {filtered && (
        <div className="lit-active-filters" aria-label={ui.filters}>
          {tags.map((tag) => <button type="button" key={tag} className="lit-filter-chip" aria-label={ui.removeTag(tag)} onClick={() => onRemoveTag(tag)}>
            <span>{tag}</span><SvgIcon name="close" size={11} />
          </button>)}
          {conditionCount > 0 && <span className="lit-filter-chip">{ui.conditions(conditionCount)}</span>}
          <button type="button" className="lit-quiet-button" onClick={onClearFilters}>{ui.clearFilters}</button>
          {filter.trim() && <button type="button" className="lit-quiet-button lit-save-view" title={copy.table.saveSearchTitle} onClick={onSaveSearch}>{ui.saveView}</button>}
        </div>
      )}
    </div>
  );
}
