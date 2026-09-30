import { useLayoutEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { SvgIcon } from "../SvgIcon";
import { useStore } from "../store";
import { LITERATURE_COPY } from "./i18n";
import LibraryActionMenu from "./LibraryActionMenu";

export default function LibraryTopbar({
  filter, searchRef, navigationOpen, detailsOpen, onFilterChange, onToggleNavigation,
  onToggleDetails, onRefresh, onActivity, onSettings, onDiscover, onCreateItem,
  onImportBibliography, onImportPdf, onAddIdentifier,
}: {
  filter: string;
  searchRef: RefObject<HTMLInputElement>;
  navigationOpen: boolean;
  detailsOpen: boolean;
  onFilterChange: (value: string) => void;
  onToggleNavigation: () => void;
  onToggleDetails: () => void;
  onRefresh: () => Promise<void>;
  onActivity: () => void;
  onSettings: () => void;
  onDiscover: () => void;
  onCreateItem: () => void;
  onImportBibliography: () => void;
  onImportPdf: () => void;
  onAddIdentifier: () => void;
}) {
  const copy = LITERATURE_COPY[useStore((s) => s.language)];
  const ui = copy.libraryUi;
  const [refreshing, setRefreshing] = useState(false);
  const [host, setHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => { setHost(document.getElementById("literature-toolbar-slot")); }, []);
  const toolbar = (
    <div className={"lit-topbar" + (host ? " lit-topbar-embedded" : "")} role="toolbar" aria-label={copy.tabs.library}>
      {!host && <div className="lit-brand">
        <span>SomniQ <strong>Literature</strong></span>
        <LibraryActionMenu label={copy.tabs.viewSwitchAria} icon="chevronDown" actions={[
          { id: "library", label: copy.tabs.library, icon: "library", onSelect: () => searchRef.current?.focus() },
          { id: "discover", label: copy.tabs.discover, icon: "search", onSelect: onDiscover },
        ]} />
      </div>}
      <button type="button" className="lit-layout-toggle lit-navigation-toggle"
        aria-label={navigationOpen ? ui.hideNavigation : ui.showNavigation}
        title={navigationOpen ? ui.hideNavigation : ui.showNavigation} aria-expanded={navigationOpen}
        aria-controls="literature-navigation" onClick={onToggleNavigation}>
        <SvgIcon name="panelLeft" size={16} />
      </button>
      <div className="lit-library-search">
        <SvgIcon name="search" size={16} />
        <input ref={searchRef} value={filter} onChange={(event) => onFilterChange(event.target.value)}
          placeholder={ui.searchPlaceholder} aria-label={copy.table.filterAria} aria-keyshortcuts="/ Control+F Meta+F Control+K Meta+K"
          onKeyDown={(event) => { if (event.key === "Escape" && filter) { event.stopPropagation(); onFilterChange(""); } }} />
        {filter ? <button type="button" aria-label={copy.table.clearFilterAria} onClick={() => { onFilterChange(""); searchRef.current?.focus(); }}>
          <SvgIcon name="close" size={15} />
        </button> : <kbd className="lit-search-shortcut">{typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl"} K</kbd>}
      </div>
      <LibraryActionMenu label={ui.add} icon="plus" showLabel primary actions={[
        { id: "pdf", label: copy.table.importPdf, description: ui.importPdfHint, icon: "upload", onSelect: onImportPdf },
        { id: "bibliography", label: copy.table.importBibliography, description: ui.importBibliographyHint, icon: "library", onSelect: onImportBibliography },
        { id: "identifier", label: copy.table.addIdentifier, description: ui.identifierHint, icon: "search", onSelect: onAddIdentifier },
        { id: "manual", label: copy.table.newItem, description: ui.manualHint, icon: "edit", onSelect: onCreateItem },
      ]} />
      <div className="lit-topbar-actions">
        {host && <button type="button" className="lit-layout-toggle" aria-label={copy.tabs.discover} title={copy.tabs.discover} onClick={onDiscover}><SvgIcon name="search" size={16} /></button>}
        <button type="button" className="lit-layout-toggle" aria-label={ui.refresh} title={ui.refresh} disabled={refreshing}
          onClick={async () => { setRefreshing(true); try { await onRefresh(); } finally { setRefreshing(false); } }}>
          <SvgIcon name={refreshing ? "spinner" : "refresh"} size={16} />
        </button>
        <button type="button" className="lit-layout-toggle lit-activity-toggle" aria-label={ui.activity} title={ui.activity} onClick={onActivity}>
          <SvgIcon name="list" size={16} />
        </button>
        <button type="button" className={`lit-layout-toggle${detailsOpen ? " active" : ""}`}
          aria-label={detailsOpen ? ui.hideDetails : ui.showDetails} title={detailsOpen ? ui.hideDetails : ui.showDetails}
          aria-expanded={detailsOpen} aria-controls="literature-details" onClick={onToggleDetails}>
          <SvgIcon name="panelRight" size={16} />
        </button>
        <button type="button" className="lit-layout-toggle lit-settings-toggle" aria-label={ui.settings} title={ui.settings} onClick={onSettings}>
          <SvgIcon name="settings" size={16} />
        </button>
      </div>
    </div>
  );
  return host ? createPortal(toolbar, host) : toolbar;
}