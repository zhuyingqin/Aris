// Browse the local LaTeX library by project and source folder.
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { fileReveal, type TypesetDocument, type TypesetProject } from "../api/tauri";
import { handoffEnvironmentInstall } from "../environmentInstall";
import { SvgIcon } from "../SvgIcon";
import { useStore } from "../store";
import { FileIcon } from "./FileIcon";
import { ToolIcon } from "./ToolIcon";
import { basename, dirname, normalizePath } from "./latexText";
import { buildTypesetLibraryFolders, typesetLibraryRows } from "./typesetLibraryFolders";
import {
  documentCompileLabel,
  documentKindLabel,
  documentRelativeTime,
  TYPESET_LIBRARY_COPY,
  TYPESET_LIBRARY_TEMPLATES,
  type TypesetLibraryScope,
  type TypesetTemplate,
} from "./TypesetLibraryCopy";

const TYPESET_LIBRARY_PREFERENCES_STORAGE_PREFIX = "somniq-typeset-library:";
const TYPESET_LIBRARY_FOLDERS_STORAGE_PREFIX = "somniq-typeset-library-folders:";

type TypesetLibraryPreferences = Record<string, { favorite?: boolean; archived?: boolean }>;

function loadFolderExpansion(projectPath: string | null): Record<string, boolean> {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(`${TYPESET_LIBRARY_FOLDERS_STORAGE_PREFIX}${projectPath || "default"}`) || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, expanded]) => typeof expanded === "boolean"));
  } catch {
    return {};
  }
}

function typesetLibraryPreferenceKey(projectPath: string | null): string {
  return `${TYPESET_LIBRARY_PREFERENCES_STORAGE_PREFIX}${projectPath || "default"}`;
}
function loadTypesetLibraryPreferences(projectPath: string | null): TypesetLibraryPreferences {
  if (typeof window === "undefined") return {};
  try {
    const value = window.localStorage.getItem(typesetLibraryPreferenceKey(projectPath));
    if (!value) return {};
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as TypesetLibraryPreferences : {};
  } catch {
    return {};
  }
}
function newTypesetDocumentPath(template: TypesetTemplate, title: string): string {
  const definition = TYPESET_LIBRARY_TEMPLATES.find((item) => item.kind === template) ?? TYPESET_LIBRARY_TEMPLATES[0];
  const safeName = title
    .trim()
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "") || "untitled-document";
  return `${definition.folder}/${safeName}/main.tex`;
}
export default function TypesetStartPage({
  projectPath,
  documents,
  projects,
  latexAvailable,
  loading,
  error,
  onOpenSource,
  onCreateSource,
  onRefresh,
}: {
  projectPath: string | null;
  documents: TypesetDocument[];
  projects: TypesetProject[];
  latexAvailable: boolean | null;
  loading: boolean;
  error: string | null;
  onOpenSource: (path: string) => void;
  onCreateSource: (path: string, template: TypesetTemplate, title: string) => void;
  onRefresh: () => void;
}) {
  const language = useStore((state) => state.language);
  const copy = TYPESET_LIBRARY_COPY[language];
  const [scope, setScope] = useState<TypesetLibraryScope>("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"modified" | "title">("modified");
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set());
  const [folderExpansion, setFolderExpansion] = useState(() => loadFolderExpansion(projectPath));
  const [searchExpansion, setSearchExpansion] = useState<Record<string, boolean>>({});
  const [preferences, setPreferences] = useState<TypesetLibraryPreferences>(() => loadTypesetLibraryPreferences(projectPath));
  const [createOpen, setCreateOpen] = useState(false);
  const [template, setTemplate] = useState<TypesetTemplate>("article");
  const [newTitle, setNewTitle] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setScope("all");
    setSearch("");
    setSelectedPaths(new Set());
    setFolderExpansion(loadFolderExpansion(projectPath));
    setSearchExpansion({});
    setPreferences(loadTypesetLibraryPreferences(projectPath));
  }, [projectPath]);

  useEffect(() => setSearchExpansion({}), [search.trim(), scope]);

  const updateFolderExpansion = (update: (current: Record<string, boolean>) => Record<string, boolean>) => {
    if (search.trim()) {
      setSearchExpansion(update);
      return;
    }
    setFolderExpansion((current) => {
      const next = update(current);
      try {
        window.localStorage.setItem(`${TYPESET_LIBRARY_FOLDERS_STORAGE_PREFIX}${projectPath || "default"}`, JSON.stringify(next));
      } catch {
        // Browsing remains available when local storage is full or disabled.
      }
      return next;
    });
  };

  const updatePreferences = useCallback((update: (current: TypesetLibraryPreferences) => TypesetLibraryPreferences) => {
    setPreferences((current) => {
      const next = update(current);
      try {
        window.localStorage.setItem(typesetLibraryPreferenceKey(projectPath), JSON.stringify(next));
      } catch {
        // Favorites and archive state remain available for this session when storage is unavailable.
      }
      return next;
    });
  }, [projectPath]);

  const activeDocuments = useMemo(
    () => documents.filter((document) => !preferences[document.path]?.archived),
    [documents, preferences],
  );
  const counts = useMemo(() => ({
    all: activeDocuments.length,
    recent: activeDocuments.length,
    favorites: activeDocuments.filter((document) => preferences[document.path]?.favorite).length,
    article: activeDocuments.filter((document) => document.kind === "article").length,
    beamer: activeDocuments.filter((document) => document.kind === "beamer").length,
    poster: activeDocuments.filter((document) => document.kind === "poster").length,
    report: activeDocuments.filter((document) => document.kind === "report").length,
    ready: activeDocuments.filter((document) => document.compileState === "fresh").length,
    "needs-compile": activeDocuments.filter((document) => document.compileState !== "fresh").length,
    archived: documents.filter((document) => preferences[document.path]?.archived).length,
  }), [activeDocuments, documents, preferences]);

  const visibleDocuments = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    const matchesScope = (document: TypesetDocument) => {
      const preference = preferences[document.path];
      if (scope === "archived") return Boolean(preference?.archived);
      if (preference?.archived) return false;
      if (scope === "favorites") return Boolean(preference?.favorite);
      if (scope === "article" || scope === "beamer" || scope === "poster" || scope === "report") return document.kind === scope;
      if (scope === "ready") return document.compileState === "fresh";
      if (scope === "needs-compile") return document.compileState !== "fresh";
      return true;
    };
    return documents
      .filter(matchesScope)
      .filter((document) => !needle || `${document.title} ${document.path} ${document.kind}`.toLocaleLowerCase().includes(needle));
  }, [documents, preferences, scope, search]);

  // Only the unfiltered library lists projects that hold no root document:
  // inside a search or a category they would read as false matches.
  const keepEmptyProjects = !search.trim() && (scope === "all" || scope === "recent");
  const visibleProjects = useMemo(
    () => {
      const owner = (document: TypesetDocument) => normalizePath(document.projectPath ?? dirname(document.path));
      const knownOwners = new Set(documents.map(owner));
      const visibleOwners = new Set(visibleDocuments.map(owner));
      // A folder containing only archived documents should not masquerade as
      // an include-only project in the active library.
      const metadata = projects.filter((project) => !knownOwners.has(normalizePath(project.path)) || visibleOwners.has(normalizePath(project.path)));
      return buildTypesetLibraryFolders(metadata, visibleDocuments, copy.projectRoot, sort, keepEmptyProjects);
    },
    [copy.projectRoot, documents, keepEmptyProjects, projects, sort, visibleDocuments],
  );
  const rows = useMemo(() => typesetLibraryRows(visibleProjects, (folder, depth) => {
    const saved = (search.trim() ? searchExpansion : folderExpansion)[folder.path];
    return typeof saved === "boolean" ? saved : Boolean(search.trim())
      || (depth === 0 && folder.folders.length === 0 && folder.documentCount <= 1);
  }), [folderExpansion, search, searchExpansion, visibleProjects]);
  const visiblePathSet = useMemo(() => new Set(rows.flatMap((row) => row.kind === "document" ? [row.document.path] : [])), [rows]);
  const allVisibleSelected = visiblePathSet.size > 0 && [...visiblePathSet].every((path) => selectedPaths.has(path));
  const setAllFoldersExpanded = (expanded: boolean) => {
    const updates = Object.fromEntries(typesetLibraryRows(visibleProjects, () => true)
      .flatMap((row) => row.kind === "folder" ? [[row.folder.path, expanded]] : []));
    updateFolderExpansion((current) => ({ ...current, ...updates }));
  };
  const title = copy.scopes[scope];

  const toggleSelection = (path: string) => {
    setSelectedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const toggleSelectVisible = () => {
    setSelectedPaths((current) => {
      const next = new Set(current);
      if (allVisibleSelected) {
        for (const path of visiblePathSet) next.delete(path);
      } else {
        for (const path of visiblePathSet) next.add(path);
      }
      return next;
    });
  };

  const toggleFavorite = (path: string) => {
    updatePreferences((current) => ({
      ...current,
      [path]: { ...current[path], favorite: !current[path]?.favorite },
    }));
  };

  const toggleArchived = (path: string) => {
    updatePreferences((current) => ({
      ...current,
      [path]: { ...current[path], archived: !current[path]?.archived },
    }));
    setSelectedPaths((current) => {
      const next = new Set(current);
      next.delete(path);
      return next;
    });
  };

  const revealDocument = (path: string) => {
    setActionError(null);
    void fileReveal(path).catch((revealError) => setActionError(String(revealError)));
  };

  const createDocument = () => {
    const fallbackTitle = copy.templates[template].label;
    const titleValue = newTitle.trim() || fallbackTitle;
    onCreateSource(newTypesetDocumentPath(template, titleValue), template, titleValue);
    setCreateOpen(false);
    setNewTitle("");
  };

  const navigationGroups: Array<{ label: string; items: Array<{ scope: TypesetLibraryScope; label: string }> }> = [
    {
      label: copy.groups.library,
      items: [
        { scope: "all", label: copy.navigation.all },
        { scope: "recent", label: copy.navigation.recent },
        { scope: "favorites", label: copy.navigation.favorites },
      ],
    },
    {
      label: copy.groups.documentType,
      items: [
        { scope: "article", label: copy.navigation.article },
        { scope: "beamer", label: copy.navigation.beamer },
        { scope: "poster", label: copy.navigation.poster },
        { scope: "report", label: copy.navigation.report },
      ],
    },
    {
      label: copy.groups.buildStatus,
      items: [
        { scope: "ready", label: copy.navigation.ready },
        { scope: "needs-compile", label: copy.navigation["needs-compile"] },
        { scope: "archived", label: copy.navigation.archived },
      ],
    },
  ];

  return (
    <section className="typeset-start typeset-library" aria-label={copy.libraryLabel}>
      {error && <div className="typeset-error-bar">{error}</div>}
      <div className="typeset-library-shell">
        <aside className="typeset-library-sidebar" aria-label={copy.categoriesLabel}>
          <button type="button" className="typeset-library-new" onClick={() => setCreateOpen(true)}>
            <ToolIcon name="new" />
            {copy.newDocument}
          </button>
          {navigationGroups.map((group) => (
            <section key={group.label} className="typeset-library-nav-group" aria-label={group.label}>
              <strong>{group.label}</strong>
              {group.items.map((item) => (
                <button
                  key={item.scope}
                  type="button"
                  className={scope === item.scope ? "active" : ""}
                  aria-label={item.label}
                  aria-current={scope === item.scope ? "page" : undefined}
                  onClick={() => setScope(item.scope)}
                >
                  <span>{item.label}</span>
                  <em>{counts[item.scope]}</em>
                </button>
              ))}
            </section>
          ))}
          <div className="typeset-library-sidebar-foot">
            <ToolIcon name="files" />
            <span>{copy.rootDocumentsOnly}</span>
          </div>
        </aside>

        <section className="typeset-library-main" aria-label={title}>
          <header className="typeset-library-header">
            <div>
              <h1>{title}</h1>
              <p>{loading ? copy.scanning : copy.projectSummary(visibleProjects.length, visibleDocuments.length)}</p>
            </div>
            <button type="button" className="typeset-library-refresh" onClick={onRefresh} disabled={loading} aria-label={copy.refreshLibrary}>
              <ToolIcon name="refresh" />
              {copy.refresh}
            </button>
          </header>

          {latexAvailable === false && (
            <div className="typeset-library-runtime-notice" role="status">
              <span className="typeset-library-runtime-mark">TeX</span>
              <div>
                <strong>{copy.latexMissingTitle}</strong>
                <span>{copy.latexMissingBody}</span>
              </div>
              <button type="button" onClick={() => handoffEnvironmentInstall("latex", language)}>
                {copy.installInChat}
              </button>
            </div>
          )}

          <div className="typeset-library-controls">
            <label className="typeset-library-search">
              <ToolIcon name="search" />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={copy.searchPlaceholder} />
            </label>
            <label className="typeset-library-sort">
              <span>{copy.sort}</span>
              <select value={sort} onChange={(event) => setSort(event.target.value as "modified" | "title")} aria-label={copy.sortDocuments}>
                <option value="modified">{copy.sortModified}</option>
                <option value="title">{copy.sortTitle}</option>
              </select>
            </label>
          </div>

          <div className="typeset-library-folder-controls" role="group" aria-label={copy.folderControls}>
            <button type="button" onClick={() => setAllFoldersExpanded(true)} disabled={loading || visibleDocuments.length === 0}>{copy.expandAllFolders}</button>
            <button type="button" onClick={() => setAllFoldersExpanded(false)} disabled={loading || visibleDocuments.length === 0}>{copy.collapseAllFolders}</button>
          </div>
          {actionError && <div className="typeset-error-bar typeset-library-action-error">{actionError}</div>}
          <div className="typeset-library-table-wrap">
            <table className="typeset-library-table">
              <thead>
                <tr>
                  <th className="typeset-library-select-col">
                    <input type="checkbox" aria-label={copy.selectVisible} checked={allVisibleSelected} disabled={visiblePathSet.size === 0} onChange={toggleSelectVisible} />
                  </th>
                  <th>{copy.table.document}</th>
                  <th>{copy.table.type}</th>
                  <th>{copy.table.modified}</th>
                  <th>{copy.table.status}</th>
                  <th className="typeset-library-actions-col">{copy.table.actions}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const rowStyle = { "--typeset-library-depth": row.depth } as CSSProperties;
                  if (row.kind === "folder") {
                    const { folder, expanded, depth } = row;
                    return (
                      <tr key={`folder:${folder.path}`} className={`typeset-library-project-row${depth > 0 ? " typeset-library-subfolder-row" : ""}`} style={rowStyle}>
                        <td colSpan={6}>
                          <div className="typeset-library-project-header">
                            <button
                              type="button"
                              className="typeset-library-project-toggle"
                              aria-label={depth === 0 ? copy.toggleProject(folder.name, expanded) : copy.toggleFolder(folder.name, expanded)}
                              aria-expanded={expanded}
                              disabled={folder.documentCount === 0}
                              onClick={() => updateFolderExpansion((current) => ({
                                ...current,
                                [folder.path]: !expanded,
                              }))}
                            >
                              <span className="typeset-library-project-caret"><ToolIcon name="chevron" /></span>
                              <FileIcon path={folder.path || copy.projectRoot} dir />
                              <span className="typeset-library-project-copy">
                                <strong>{folder.name}</strong>
                                <em title={folder.path || copy.projectRoot}>{folder.path || copy.projectRoot}</em>
                              </span>
                              <span className="typeset-library-project-count">
                                {copy.documentsInProject(folder.documentCount)}
                                {folder.texFileCount !== undefined && <i>{copy.texFilesInProject(folder.texFileCount)}</i>}
                              </span>
                            </button>
                            {folder.primaryDocument && (
                              <button
                                type="button"
                                className="typeset-library-project-open"
                                title={depth === 0 ? copy.openProject(folder.name) : copy.openFolderDocument(folder.name)}
                                aria-label={depth === 0 ? copy.openProject(folder.name) : copy.openFolderDocument(folder.name)}
                                onClick={() => onOpenSource(folder.primaryDocument!.path)}
                              >
                                <ToolIcon name="open" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  }
                  const { document } = row;
                  const archived = Boolean(preferences[document.path]?.archived);
                  const favorite = Boolean(preferences[document.path]?.favorite);
                  return (
                    <tr
                      key={`document:${document.path}`}
                      className={archived ? "typeset-library-project-document archived" : "typeset-library-project-document"}
                      style={rowStyle}
                      onDoubleClick={() => onOpenSource(document.path)}
                    >
                      <td className="typeset-library-select-col">
                        <input type="checkbox" aria-label={copy.selectDocument(document.title)} checked={selectedPaths.has(document.path)} onChange={() => toggleSelection(document.path)} />
                      </td>
                      <td>
                        <button type="button" className="typeset-library-document" onClick={() => onOpenSource(document.path)}>
                          <FileIcon path={document.path} />
                          <span><strong>{document.title}</strong><em title={document.path}>{document.title === basename(document.path) ? dirname(document.path) || copy.projectRoot : basename(document.path)}</em></span>
                        </button>
                      </td>
                      <td><span className={`typeset-library-kind ${document.kind}`}>{documentKindLabel(document.kind, language)}</span></td>
                      <td><time dateTime={new Date(document.modifiedEpochMs).toISOString()}>{documentRelativeTime(document.modifiedEpochMs, language)}</time></td>
                      <td><span className={`typeset-library-status ${document.compileState}`}>{documentCompileLabel(document.compileState, language)}</span></td>
                      <td className="typeset-library-actions-col">
                        <div className="typeset-library-actions" aria-label={copy.actionsFor(document.title)}>
                          <button type="button" title={copy.open} aria-label={copy.openDocument(document.title)} onClick={() => onOpenSource(document.path)}><ToolIcon name="open" /></button>
                          <button type="button" title={copy.reveal} aria-label={copy.revealDocument(document.title)} onClick={() => revealDocument(document.path)}><ToolIcon name="files" /></button>
                          <button type="button" title={favorite ? copy.removeFavorite : copy.addFavorite} aria-label={copy.favoriteDocument(document.title, favorite)} onClick={() => toggleFavorite(document.path)} className={favorite ? "active" : ""}><SvgIcon name="star" size={16} /></button>
                          <button type="button" title={archived ? copy.restore : copy.archive} aria-label={copy.archiveDocument(document.title, archived)} onClick={() => toggleArchived(document.path)}><ToolIcon name={archived ? "undo" : "download"} /></button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!loading && visibleProjects.length === 0 && (
              <div className="typeset-library-empty">
                <ToolIcon name="files" />
                <strong>{documents.length === 0 ? copy.emptyRootTitle : copy.emptyViewTitle}</strong>
                <span>{documents.length === 0 ? copy.emptyRootBody : copy.emptyViewBody}</span>
              </div>
            )}
          </div>
        </section>
      </div>

      {createOpen && (
        <div className="typeset-library-create-backdrop" role="presentation" onMouseDown={() => setCreateOpen(false)}>
          <section className="typeset-library-create-dialog" role="dialog" aria-modal="true" aria-label={copy.dialogLabel} onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <span>{copy.dialogEyebrow}</span>
                <strong>{copy.dialogTitle}</strong>
              </div>
              <button type="button" aria-label={copy.closeDialog} onClick={() => setCreateOpen(false)}><ToolIcon name="clear" /></button>
            </header>
            <label className="typeset-library-title-input">
              <span>{copy.documentTitle}</span>
              <input autoFocus value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder={copy.titlePlaceholder} />
            </label>
            <div className="typeset-library-template-grid" role="radiogroup" aria-label={copy.templateLabel}>
              {TYPESET_LIBRARY_TEMPLATES.map((item) => {
                const templateCopy = copy.templates[item.kind];
                return (
                  <button
                    key={item.kind}
                    type="button"
                    role="radio"
                    aria-checked={template === item.kind}
                    className={template === item.kind ? "active" : ""}
                    onClick={() => setTemplate(item.kind)}
                  >
                    <strong>{templateCopy.label}</strong>
                    <span>{templateCopy.description}</span>
                  </button>
                );
              })}
            </div>
            <footer>
              <button type="button" className="typeset-btn subtle" onClick={() => setCreateOpen(false)}>{copy.cancel}</button>
              <button type="button" className="typeset-recompile-btn" onClick={createDocument}><ToolIcon name="new" />{copy.create}</button>
            </footer>
          </section>
        </div>
      )}
    </section>
  );
}
