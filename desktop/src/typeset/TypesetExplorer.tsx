// The file tree beside the editor: workspace listing, rename/delete/upload,
// drag-and-drop and the "new document" affordances.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  fileCreateDir,
  fileCreateText,
  fileDelete,
  fileDuplicate,
  fileListDir,
  fileRename,
  fileReveal,
  typesetImportFile,
  type FileTreeEntry,
} from "../api/tauri";
import { useStore } from "../store";
import { FileIcon } from "./FileIcon";
import { TYPESET_EDITOR_COPY } from "./i18n";
import { basename, dirname, extension } from "./latexText";
import { ToolIcon } from "./ToolIcon";
import type { TypesetTemplate } from "./TypesetLibraryCopy";
import { TYPESET_IMAGE_EXTENSIONS, workDirForSource } from "./typesetPaths";

const DEFAULT_LATEX_DOCUMENT = `\\documentclass{article}
\\usepackage[margin=1in]{geometry}
\\usepackage{hyperref}

\\title{SomniQ LaTeX Draft}
\\author{}
\\date{\\today}

\\begin{document}
\\maketitle

This document is ready for TeX Live compilation inside SomniQ Studio.

\\section{Notes}

Edit the source and compile to refresh the PDF preview.

\\end{document}
`;
function latexEscapeTemplateText(value: string): string {
  return value.replace(/([#$%&_{}])/g, "\\$1");
}
export type TypesetFileMutation =
  | { type: "delete"; path: string; isDir: boolean }
  | { type: "rename"; path: string; newPath: string; isDir: boolean };

export function defaultSourceFor(_path: string, template: TypesetTemplate = "article", title = "SomniQ LaTeX Draft"): string {
  const escapedTitle = latexEscapeTemplateText(title.trim() || "Untitled document");
  if (template === "beamer") {
    return `\\documentclass[aspectratio=169]{beamer}
\\usetheme{metropolis}

\\title{${escapedTitle}}
\\author{}
\\date{\\today}

\\begin{document}

\\begin{frame}
  \\titlepage
\\end{frame}

\\begin{frame}{Overview}
  \\begin{itemize}
    \\item Start with the problem and motivation.
    \\item Add one idea per slide.
  \\end{itemize}
\\end{frame}

\\end{document}
`;
  }
  if (template === "report") {
    return `\\documentclass[11pt]{report}
\\usepackage[margin=1in]{geometry}
\\usepackage{hyperref}

\\title{${escapedTitle}}
\\author{}
\\date{\\today}

\\begin{document}
\\maketitle
\\tableofcontents

\\chapter{Introduction}

Start writing your report here.

\\end{document}
`;
  }
  if (template === "poster") {
    return `\\documentclass{beamer}
\\usepackage[size=a1,scale=1.1]{beamerposter}

\\title{${escapedTitle}}
\\author{}
\\date{}

\\begin{document}
\\begin{frame}[t]
  \\begin{columns}[t]
    \\begin{column}{.48\\textwidth}
      \\begin{block}{Motivation}
        Summarize the research question and why it matters.
      \\end{block}
    \\end{column}
    \\begin{column}{.48\\textwidth}
      \\begin{block}{Results}
        Add the main evidence, figures, and conclusions.
      \\end{block}
    \\end{column}
  \\end{columns}
\\end{frame}
\\end{document}
`;
  }
  return DEFAULT_LATEX_DOCUMENT.replace("SomniQ LaTeX Draft", escapedTitle);
}
export interface ExplorerProps {
  projectPath: string | null;
  rootPath: string;
  activeSourcePath: string | null;
  activePreviewPath: string | null;
  /** The file TeX is pointed at, marked in the tree; null means "detect it". */
  mainDocumentPath: string | null;
  refreshKey: number;
  onOpenPath: (path: string) => void;
  onFileMutation: (mutation: TypesetFileMutation) => void;
  onSetMainDocument: (path: string | null) => void;
}
export default function TypesetExplorer({
  projectPath,
  rootPath,
  activeSourcePath,
  activePreviewPath,
  mainDocumentPath,
  refreshKey,
  onOpenPath,
  onFileMutation,
  onSetMainDocument,
}: ExplorerProps) {
  const language = useStore((state) => state.language);
  const copy = TYPESET_EDITOR_COPY[language].explorer;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["", "papers"]));
  const [children, setChildren] = useState<Record<string, FileTreeEntry[]>>({});
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [operationBusy, setOperationBusy] = useState(false);
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; entry: FileTreeEntry } | null>(null);
  const [renameTarget, setRenameTarget] = useState<FileTreeEntry | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [createTarget, setCreateTarget] = useState<{ parent: string; isDir: boolean } | null>(null);
  const [createValue, setCreateValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<FileTreeEntry | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const rootName = basename(rootPath) || basename(projectPath) || copy.rootFallback;

  const loadDir = useCallback(async (path: string) => {
    setLoading((items) => new Set(items).add(path));
    setError(null);
    try {
      const entries = await fileListDir(path || null);
      setChildren((current) => ({ ...current, [path]: entries }));
    } catch (loadError) {
      setError(String(loadError));
    } finally {
      setLoading((items) => {
        const next = new Set(items);
        next.delete(path);
        return next;
      });
    }
  }, []);

  useEffect(() => {
    const parentDir = workDirForSource(activeSourcePath);
    const dirs = parentDir && parentDir !== rootPath ? [rootPath, parentDir] : [rootPath];
    setExpanded(new Set(dirs));
    setChildren({});
    void loadDir(rootPath);
    if (parentDir) void loadDir(parentDir);
  }, [loadDir, projectPath, refreshKey, activeSourcePath, rootPath]);

  useEffect(() => {
    if (!rowMenu) return;
    const dismiss = () => setRowMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setRowMenu(null);
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [rowMenu]);

  useEffect(() => {
    if (!renameTarget) return;
    const frame = window.requestAnimationFrame(() => renameInputRef.current?.select());
    return () => window.cancelAnimationFrame(frame);
  }, [renameTarget]);

  const toggleDir = (path: string) => {
    setExpanded((items) => {
      const next = new Set(items);
      if (next.has(path)) next.delete(path);
      else {
        next.add(path);
        if (!children[path] && !loading.has(path)) void loadDir(path);
      }
      return next;
    });
  };

  const refreshAfterChange = useCallback(async (paths: string[]) => {
    await Promise.all(Array.from(new Set(paths)).map((path) => loadDir(path)));
  }, [loadDir]);

  const openRenameDialog = (entry: FileTreeEntry) => {
    setRenameValue(entry.name);
    setRenameTarget(entry);
    setRowMenu(null);
  };

  const renameEntry = async () => {
    if (!renameTarget) return;
    const nextName = renameValue.trim();
    if (!nextName || /[\\/]/.test(nextName)) {
      setError(copy.renameNameError);
      return;
    }
    if (nextName === renameTarget.name) {
      setRenameTarget(null);
      return;
    }
    const oldPath = renameTarget.path;
    const parent = dirname(oldPath);
    const newPath = parent ? `${parent}/${nextName}` : nextName;
    setOperationBusy(true);
    setError(null);
    try {
      const renamed = await fileRename(oldPath, newPath);
      setExpanded((items) => {
        const next = new Set<string>();
        const prefix = `${oldPath}/`;
        for (const path of items) {
          if (path === oldPath) next.add(renamed.path);
          else if (renameTarget.isDir && path.startsWith(prefix)) next.add(`${renamed.path}/${path.slice(prefix.length)}`);
          else next.add(path);
        }
        return next;
      });
      await refreshAfterChange([dirname(oldPath), dirname(renamed.path)]);
      onFileMutation({ type: "rename", path: oldPath, newPath: renamed.path, isDir: renameTarget.isDir });
      setRenameTarget(null);
    } catch (renameError) {
      setError(String(renameError));
    } finally {
      setOperationBusy(false);
    }
  };

  const deleteEntry = async () => {
    if (!deleteTarget) return;
    setOperationBusy(true);
    setError(null);
    try {
      await fileDelete(deleteTarget.path);
      setExpanded((items) => {
        const next = new Set<string>();
        const prefix = `${deleteTarget.path}/`;
        for (const path of items) {
          if (path !== deleteTarget.path && !path.startsWith(prefix)) next.add(path);
        }
        return next;
      });
      await refreshAfterChange([dirname(deleteTarget.path)]);
      onFileMutation({ type: "delete", path: deleteTarget.path, isDir: deleteTarget.isDir });
      setDeleteTarget(null);
    } catch (deleteError) {
      setError(String(deleteError));
    } finally {
      setOperationBusy(false);
    }
  };

  const duplicateEntry = async (entry: FileTreeEntry) => {
    setOperationBusy(true);
    setError(null);
    try {
      const duplicated = await fileDuplicate(entry.path);
      const parent = dirname(entry.path);
      setExpanded((items) => {
        const next = new Set(items);
        next.add(parent);
        if (duplicated.isDir) next.add(duplicated.path);
        return next;
      });
      await refreshAfterChange([parent]);
    } catch (duplicateError) {
      setError(String(duplicateError));
    } finally {
      setOperationBusy(false);
      setRowMenu(null);
    }
  };

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard?.writeText(path);
    } catch (copyError) {
      setError(copy.copyPathError(String(copyError)));
    } finally {
      setRowMenu(null);
    }
  };

  const openCreateDialog = (parent: string, isDir: boolean) => {
    setRowMenu(null);
    setCreateTarget({ parent, isDir });
    setCreateValue("");
  };

  const createEntry = async () => {
    if (!createTarget) return;
    const name = createValue.trim();
    if (!name || /[\\/]/.test(name)) {
      setError(copy.renameNameError);
      return;
    }
    const parent = createTarget.parent;
    const path = parent ? `${parent}/${name}` : name;
    setOperationBusy(true);
    setError(null);
    try {
      if (createTarget.isDir) {
        await fileCreateDir(path);
      } else {
        // A new .tex starts as a compilable document rather than an empty file
        // you have to remember the preamble for.
        await fileCreateText(path, extension(path) === ".tex" ? defaultSourceFor(path, "article", name.replace(/\.tex$/i, "")) : "");
      }
      setExpanded((items) => {
        const next = new Set(items);
        next.add(parent);
        if (createTarget.isDir) next.add(path);
        return next;
      });
      await refreshAfterChange([parent]);
      setCreateTarget(null);
      if (!createTarget.isDir) onOpenPath(path);
    } catch (createError) {
      setError(String(createError));
    } finally {
      setOperationBusy(false);
    }
  };

  /**
   * Overleaf's "upload" for a desktop app: pick files anywhere on disk and copy
   * them into the project, because a `\includegraphics` cannot reach outside it.
   */
  const importFiles = async (parent: string) => {
    setRowMenu(null);
    try {
      const picked = await openFileDialog({ multiple: true, title: copy.importFile });
      const sources = Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
      if (sources.length === 0) return;
      setOperationBusy(true);
      setError(null);
      for (const source of sources) {
        const name = source.split(/[\\/]/).pop();
        if (!name) continue;
        await typesetImportFile(source, parent ? `${parent}/${name}` : name);
      }
      setExpanded((items) => new Set(items).add(parent));
      await refreshAfterChange([parent]);
    } catch (importError) {
      setError(String(importError));
    } finally {
      setOperationBusy(false);
    }
  };

  const renderEntry = (entry: FileTreeEntry, depth: number) => {
    const isExpanded = expanded.has(entry.path);
    const sourceActive = activeSourcePath === entry.path;
    const previewActive = !sourceActive && activePreviewPath === entry.path;
    const nested = children[entry.path] ?? [];
    const ext = extension(entry.path);
    const openable = entry.isDir || ext === ".tex" || ext === ".pdf" || TYPESET_IMAGE_EXTENSIONS.has(ext);
    return (
      <div key={entry.path}>
        <button
          type="button"
          className={`typeset-tree-row entity-name${entry.isDir ? " folder" : " file"}${sourceActive ? " active selected" : ""}${previewActive ? " preview-active" : ""}`}
          style={{ paddingLeft: `${depth * 14 + 10}px` }}
          title={openable ? entry.path : copy.rightClickHint(entry.path)}
          onClick={() => {
            if (!openable) return;
            if (entry.isDir) toggleDir(entry.path);
            else onOpenPath(entry.path);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            setRowMenu({ x: event.clientX, y: event.clientY, entry });
          }}
        >
          <span className="typeset-tree-caret">{entry.isDir ? (isExpanded ? "v" : ">") : ""}</span>
          <FileIcon path={entry.path} dir={entry.isDir} />
          <span className="typeset-tree-name">{entry.name}</span>
          {mainDocumentPath === entry.path && (
            <span className="typeset-tree-main-badge" title={copy.setAsMainDocument}>{copy.mainDocumentBadge}</span>
          )}
        </button>
        {entry.isDir && isExpanded && (
          <div>
            {loading.has(entry.path) && (
              <div className="typeset-tree-muted" style={{ paddingLeft: `${(depth + 1) * 14 + 34}px` }}>
                {copy.loading}
              </div>
            )}
            {!loading.has(entry.path) && nested.length === 0 && children[entry.path] && (
              <div className="typeset-tree-muted" style={{ paddingLeft: `${(depth + 1) * 14 + 34}px` }}>
                {copy.empty}
              </div>
            )}
            {nested.map((child) => renderEntry(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  const rootChildren = children[rootPath] ?? [];

  return (
    <aside className="typeset-sidebar file-tree ide-react-file-tree-panel editor-sidebar" aria-label={copy.fileTreeLabel}>
      <div className="file-tree-toolbar typeset-sidebar-head">
        <div className="file-tree-expand-collapse-button">
          <ToolIcon name="chevron" className="file-tree-expand-icon" />
          <h4>{copy.fileTreeHeading}</h4>
        </div>
        <div className="typeset-tree-actions">
          <button
            type="button"
            className="typeset-icon-btn"
            title={copy.newTexFile}
            aria-label={copy.newTexFile}
            disabled={operationBusy}
            onClick={() => openCreateDialog(rootPath, false)}
          >
            <ToolIcon name="new" />
          </button>
          <button
            type="button"
            className="typeset-icon-btn"
            title={copy.newFolder}
            aria-label={copy.newFolder}
            disabled={operationBusy}
            onClick={() => openCreateDialog(rootPath, true)}
          >
            <ToolIcon name="files" />
          </button>
          <button
            type="button"
            className="typeset-icon-btn"
            title={copy.importFile}
            aria-label={copy.importFile}
            disabled={operationBusy}
            onClick={() => void importFiles(rootPath)}
          >
            <ToolIcon name="download" />
          </button>
        </div>
      </div>
      <span className="typeset-sidebar-subpath" title={rootPath || rootName}>{rootPath || rootName}</span>
      {error && <div className="typeset-inline-error">{error}</div>}
      <div className="typeset-tree file-tree-inner">
        <button type="button" className="typeset-tree-root entity-name" onClick={() => toggleDir(rootPath)}>
          <span className="typeset-tree-caret">{expanded.has(rootPath) ? "v" : ">"}</span>
          <FileIcon path={rootName} dir />
          <span>{rootName}</span>
        </button>
        {expanded.has(rootPath) && (
          <div>
            {loading.has(rootPath) && <div className="typeset-tree-muted root">{copy.loading}</div>}
            {rootChildren.map((entry) => renderEntry(entry, 0))}
          </div>
        )}
      </div>
      {rowMenu && typeof document !== "undefined" && createPortal(
        <div
          className="typeset-tree-menu"
          style={{ left: rowMenu.x, top: rowMenu.y }}
          role="menu"
          aria-label={copy.fileActionsLabel}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {rowMenu.entry.isDir && (
            <>
              <button type="button" role="menuitem" disabled={operationBusy} onClick={() => openCreateDialog(rowMenu.entry.path, false)}>
                {copy.newTexFile}
              </button>
              <button type="button" role="menuitem" disabled={operationBusy} onClick={() => openCreateDialog(rowMenu.entry.path, true)}>
                {copy.newFolder}
              </button>
              <button type="button" role="menuitem" disabled={operationBusy} onClick={() => void importFiles(rowMenu.entry.path)}>
                {copy.importFile}
              </button>
            </>
          )}
          {!rowMenu.entry.isDir && extension(rowMenu.entry.path) === ".tex" && (
            <button
              type="button"
              role="menuitem"
              disabled={operationBusy}
              onClick={() => {
                const path = rowMenu.entry.path;
                setRowMenu(null);
                onSetMainDocument(mainDocumentPath === path ? null : path);
              }}
            >
              {mainDocumentPath === rowMenu.entry.path ? copy.clearMainDocument : copy.setAsMainDocument}
            </button>
          )}
          <button type="button" role="menuitem" disabled={operationBusy} onClick={() => void copyPath(rowMenu.entry.path)}>
            {copy.copyPath}
          </button>
          <button type="button" role="menuitem" disabled={operationBusy} onClick={() => void duplicateEntry(rowMenu.entry)}>
            {copy.duplicate}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={operationBusy}
            onClick={() => {
              void fileReveal(rowMenu.entry.path).catch((revealError) => setError(String(revealError)));
              setRowMenu(null);
            }}
          >
            {copy.showInFolder}
          </button>
          <button type="button" role="menuitem" disabled={operationBusy} onClick={() => openRenameDialog(rowMenu.entry)}>
            {copy.rename}
          </button>
          <button
            type="button"
            role="menuitem"
            className="danger"
            disabled={operationBusy}
            onClick={() => {
              setDeleteTarget(rowMenu.entry);
              setRowMenu(null);
            }}
          >
            {copy.delete}
          </button>
        </div>,
        document.body,
      )}
      {renameTarget && typeof document !== "undefined" && createPortal(
        <div className="typeset-file-dialog-backdrop" role="presentation">
          <form
            className="typeset-file-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="typeset-rename-title"
            onSubmit={(event) => {
              event.preventDefault();
              void renameEntry();
            }}
          >
            <h3 id="typeset-rename-title">{copy.renameTitle(renameTarget.isDir)}</h3>
            <label>
              {copy.nameLabel}
              <input
                ref={renameInputRef}
                value={renameValue}
                disabled={operationBusy}
                onChange={(event) => setRenameValue(event.target.value)}
              />
            </label>
            <div className="typeset-file-dialog-actions">
              <button type="button" disabled={operationBusy} onClick={() => setRenameTarget(null)}>{copy.cancel}</button>
              <button type="submit" className="primary" disabled={operationBusy || !renameValue.trim()}>{copy.rename}</button>
            </div>
          </form>
        </div>,
        document.body,
      )}
      {createTarget && typeof document !== "undefined" && createPortal(
        <div className="typeset-file-dialog-backdrop" role="presentation">
          <form
            className="typeset-file-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="typeset-create-title"
            onSubmit={(event) => {
              event.preventDefault();
              void createEntry();
            }}
          >
            <h3 id="typeset-create-title">{createTarget.isDir ? copy.newFolderTitle : copy.newFileTitle}</h3>
            <label>
              {copy.nameLabel}
              <input
                autoFocus
                value={createValue}
                disabled={operationBusy}
                placeholder={createTarget.isDir ? copy.newFolderPlaceholder : copy.newFilePlaceholder}
                onChange={(event) => setCreateValue(event.target.value)}
              />
            </label>
            <div className="typeset-file-dialog-actions">
              <button type="button" disabled={operationBusy} onClick={() => setCreateTarget(null)}>{copy.cancel}</button>
              <button type="submit" className="primary" disabled={operationBusy || !createValue.trim()}>{copy.create}</button>
            </div>
          </form>
        </div>,
        document.body,
      )}
      {deleteTarget && typeof document !== "undefined" && createPortal(
        <div className="typeset-file-dialog-backdrop" role="presentation">
          <div className="typeset-file-dialog" role="alertdialog" aria-modal="true" aria-labelledby="typeset-delete-title">
            <h3 id="typeset-delete-title">{copy.deleteTitle(deleteTarget.isDir)}</h3>
            <p>{copy.deleteConfirmBody(deleteTarget.name)}</p>
            <div className="typeset-file-dialog-actions">
              <button type="button" disabled={operationBusy} onClick={() => setDeleteTarget(null)}>{copy.cancel}</button>
              <button type="button" className="danger" disabled={operationBusy} onClick={() => void deleteEntry()}>{copy.delete}</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </aside>
  );
}
