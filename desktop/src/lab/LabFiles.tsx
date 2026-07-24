import { useCallback, useEffect, useMemo, useState } from "react";

import { isLabPreviewMode } from "../api/labPreview";
import {
  fileCreateDir,
  fileCreateText,
  fileDelete,
  fileListDir,
  fileOpen,
  fileRename,
  isTauri,
  type FileTreeEntry,
} from "../api/tauri";
import { makeId } from "../chat/model";
import type { ChatAttachment } from "../types";

function basename(path: string | null | undefined): string {
  if (!path) return "";
  return path.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() || path;
}

function extension(path: string): string {
  const name = basename(path);
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index).toLowerCase() : "";
}

function rootLabel(projectPath: string | null): string {
  return (basename(projectPath) || "Project").toUpperCase();
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function dirname(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : "";
}

function joinPath(parent: string, name: string): string {
  const cleanParent = normalizePath(parent);
  const cleanName = normalizePath(name);
  return cleanParent ? `${cleanParent}/${cleanName}` : cleanName;
}

function defaultFileContent(path: string): string {
  const ext = extension(path);
  if (ext === ".ipynb") {
    return `${JSON.stringify({
      cells: [],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    }, null, 2)}\n`;
  }
  if (ext === ".py") return "# New experiment\n";
  if (ext === ".md") return "# Notes\n";
  if (ext === ".json") return "{}\n";
  if (ext === ".toml") return "# Configuration\n";
  return "";
}

export type WorkspaceFileIconKind =
  | "folder"
  | "notebook"
  | "pdf"
  | "latex-source"
  | "latex-template"
  | "bibliography"
  | "latex-artifact"
  | "database"
  | "data"
  | "config"
  | "markdown"
  | "document"
  | "log"
  | "image"
  | "archive"
  | "code"
  | "binary"
  | "file";

const LATEX_BUILD_ARTIFACT_EXTENSIONS = new Set([
  ".aux", ".bb", ".bbl", ".blg", ".fdb_latexmk", ".fls", ".lof",
  ".lot", ".nav", ".out", ".snm", ".synctex", ".toc", ".vrb", ".xdv",
]);
const LATEX_TEMPLATE_EXTENSIONS = new Set([".cls", ".sty"]);
const BIBLIOGRAPHY_EXTENSIONS = new Set([".bib", ".bst"]);
const DATABASE_EXTENSIONS = new Set([".db", ".duckdb", ".sqlite", ".sqlite3"]);
const DATA_EXTENSIONS = new Set([
  ".arrow", ".avro", ".csv", ".feather", ".h5", ".hdf5", ".jsonl", ".mat", ".npy",
  ".npz", ".parquet", ".pkl", ".pickle", ".rds", ".sav", ".tsv", ".xls", ".xlsx",
]);
const CONFIG_EXTENSIONS = new Set([".cfg", ".conf", ".env", ".ini", ".json", ".lock", ".properties", ".toml", ".yaml", ".yml"]);
const DOCUMENT_EXTENSIONS = new Set([".doc", ".docx", ".odt", ".pdf", ".ppt", ".pptx", ".rtf", ".txt"]);
const IMAGE_EXTENSIONS = new Set([".avif", ".bmp", ".gif", ".ico", ".jpeg", ".jpg", ".png", ".svg", ".tif", ".tiff", ".webp"]);
const ARCHIVE_EXTENSIONS = new Set([".7z", ".bz2", ".gz", ".rar", ".tar", ".xz", ".zip"]);
const CODE_EXTENSIONS = new Set([
  ".bash", ".c", ".cc", ".cpp", ".cs", ".css", ".cxx", ".go", ".h", ".hpp", ".html",
  ".java", ".js", ".jsx", ".m", ".mdx", ".mjs", ".ps1", ".py", ".pyw", ".r", ".rb",
  ".rs", ".sass", ".scss", ".sh", ".sql", ".ts", ".tsx", ".vue", ".xml", ".zsh",
]);

/** Returns whether a file is a disposable output of LaTeX compilation.
 * These files are grouped in the explorer, so sources remain easy to scan. */
export function isLatexBuildArtifact(path: string): boolean {
  const name = basename(path).toLowerCase().replace(/\.(?:bak|backup|old)$/i, "");
  return LATEX_BUILD_ARTIFACT_EXTENSIONS.has(extension(name)) || name.endsWith(".synctex.gz");
}

/** Assigns a recognizable visual family to workspace files. */
export function workspaceFileIconKind(path: string, directory = false): WorkspaceFileIconKind {
  if (directory) return "folder";
  const name = basename(path).toLowerCase();
  const withoutBackupSuffix = name.replace(/\.(?:bak|backup|old)$/i, "");
  const ext = extension(withoutBackupSuffix);
  if (ext === ".ipynb") return "notebook";
  if (ext === ".pdf") return "pdf";
  if (ext === ".tex") return "latex-source";
  if (LATEX_TEMPLATE_EXTENSIONS.has(ext)) return "latex-template";
  if (BIBLIOGRAPHY_EXTENSIONS.has(ext)) return "bibliography";
  if (isLatexBuildArtifact(withoutBackupSuffix)) return "latex-artifact";
  if (DATABASE_EXTENSIONS.has(ext)) return "database";
  if (DATA_EXTENSIONS.has(ext)) return "data";
  if (CONFIG_EXTENSIONS.has(ext) || withoutBackupSuffix === "makefile" || withoutBackupSuffix === "dockerfile") return "config";
  if (ext === ".md" || ext === ".markdown" || ext === ".rst") return "markdown";
  if (ext === ".log" || ext === ".trace") return "log";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (ARCHIVE_EXTENSIONS.has(ext)) return "archive";
  if (CODE_EXTENSIONS.has(ext)) return "code";
  if (DOCUMENT_EXTENSIONS.has(ext)) return "document";
  if ([".dll", ".dylib", ".exe", ".so", ".wasm"].includes(ext)) return "binary";
  return "file";
}

export function WorkspaceFileIcon({
  path,
  directory = false,
  className,
  kind: explicitKind,
}: {
  path: string;
  directory?: boolean;
  className?: string;
  kind?: WorkspaceFileIconKind;
}) {
  const kind = explicitKind ?? workspaceFileIconKind(path, directory);
  return (
    <svg
      className={["lab-file-icon", kind, className].filter(Boolean).join(" ")}
      data-file-kind={kind}
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="none"
    >
      {kind === "folder" && <path d="M2.1 4.5h4l1.2 1.3h6.6v6.5a1.1 1.1 0 0 1-1.1 1.1H3.2a1.1 1.1 0 0 1-1.1-1.1z" />}
      {kind === "notebook" && <><rect x="3" y="2.8" width="10" height="10.4" rx="1.3" /><path d="M5.3 5.3h1.5M9.2 5.3h1.5M5.3 8h1.5M9.2 8h1.5M5.3 10.7h5.4" /></>}
      {kind === "pdf" && <><path d="M4 2.4h5.1l2.9 2.9v8.2H4zM9.1 2.4v2.9H12" /><path d="M5.5 8.2h4.6M5.5 10.5h3.1" /></>}
      {kind === "latex-source" && <><path d="M3.7 2.3h5.1l2.7 2.8v7.6H3.7zM8.8 2.3v2.8h2.7" /><path d="M5.2 8.2h4.7M5.2 10.5h3.3" /></>}
      {kind === "latex-template" && <><path d="M3.3 2.7h9.4v10.6H3.3z" /><path d="M5.2 5.1h5.6M5.2 7.8h2.2M9.2 7.8h1.6M5.2 10.5h5.6" /></>}
      {kind === "bibliography" && <><path d="M2.9 3.4c1.8-.8 3.3-.6 5.1.4v8.4c-1.8-1-3.3-1.2-5.1-.4zM13.1 3.4c-1.8-.8-3.3-.6-5.1.4v8.4c1.8-1 3.3-1.2 5.1-.4z" /><path d="M8 3.8v8.4M4.5 6h1.8M9.7 6h1.8" /></>}
      {kind === "latex-artifact" && <><path d="M3.7 2.5h5.2l2.7 2.8v8.2H3.7zM8.9 2.5v2.8h2.7" /><path d="M5.3 9h4.9M5.3 11.1h3.3" /></>}
      {kind === "database" && <><ellipse cx="8" cy="4" rx="4.8" ry="1.8" /><path d="M3.2 4v4.1c0 1 2.1 1.8 4.8 1.8s4.8-.8 4.8-1.8V4M3.2 8.1v3.9c0 1 2.1 1.8 4.8 1.8s4.8-.8 4.8-1.8V8.1" /></>}
      {kind === "data" && <><rect x="2.7" y="3" width="10.6" height="10" rx="1" /><path d="M2.7 6.3h10.6M2.7 9.7h10.6M6.2 3v10M9.8 3v10" /></>}
      {kind === "config" && <><path d="M3 4.4h10M3 8h10M3 11.6h10" /><circle cx="6.1" cy="4.4" r="1.1" /><circle cx="10.1" cy="8" r="1.1" /><circle cx="5" cy="11.6" r="1.1" /></>}
      {kind === "markdown" && <><path d="M4 2.5h5.2L12 5.3v8.2H4zM9.2 2.5v2.8H12" /><path d="M5.5 8.2h4.8M5.5 10.6h3.3" /></>}
      {kind === "document" && <><path d="M4 2.5h5.2L12 5.3v8.2H4zM9.2 2.5v2.8H12" /><path d="M5.6 8h4.6M5.6 10.2h4.6M5.6 12.1h2.8" /></>}
      {kind === "log" && <><path d="M3.4 2.8h9.2v10.4H3.4z" /><path d="M5.4 5.5h5.2M5.4 8h5.2M5.4 10.5h3.5" /></>}
      {kind === "image" && <><rect x="2.7" y="3" width="10.6" height="10" rx="1" /><circle cx="6" cy="6.1" r="1" /><path d="m4.2 11 2.7-2.7 1.8 1.7 1.2-1.2 2 2.2" /></>}
      {kind === "archive" && <><path d="M3.6 3.2h8.8v9.6H3.6zM3.6 5.3h8.8" /><path d="M8 6.8v1.1M8 9v1.1M8 11.2v.1" /></>}
      {kind === "code" && <path d="m6.2 4-3.1 4 3.1 4M9.8 4l3.1 4-3.1 4M8.9 3.3 7.1 12.7" />}
      {kind === "binary" && <path d="m8 2.4 4.7 2.7v5.8L8 13.6l-4.7-2.7V5.1zM3.3 5.1 8 7.8l4.7-2.7M8 7.8v5.8" />}
      {kind === "file" && <path d="M4 2.5h5.2L12 5.3v8.2H4zM9.2 2.5v2.8H12" />}
    </svg>
  );
}

type FileIconName = "file" | "folder" | "open" | "refresh";

function FileActionIcon({ name }: { name: FileIconName }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {name === "file" && <path d="M4 2.5h5.2L12 5.3v8.2H4zM9.2 2.5v2.8H12" />}
      {name === "folder" && <path d="M2.5 4.2h4l1 1h6v7.3h-11z" />}
      {name === "open" && <path d="M5.5 3h7.5v7.5M12.8 3.2 7.5 8.5M3 5.5v7.5h7.5" />}
      {name === "refresh" && <path d="M12.5 5.6A4.8 4.8 0 1 0 13 8M12.5 2.8v2.8H9.7" />}
    </svg>
  );
}

function attachmentFromPath(path: string): ChatAttachment {
  return {
    id: makeId("att"),
    kind: "file",
    name: basename(path),
    path,
  };
}

function folderAttachment(entry: FileTreeEntry, children: FileTreeEntry[]): ChatAttachment {
  const listing = children.length
    ? children.map((child) => `${child.isDir ? "dir " : "file"} ${child.path}`).join("\n")
    : "(Folder not expanded yet.)";
  return {
    id: makeId("att"),
    kind: "file",
    name: entry.name,
    path: entry.path,
    content: `Folder: ${entry.path}\n\n${listing}`,
  };
}

export interface LabOpenOptions {
  /** false = open as a replaceable preview tab (single click); true = pin permanently (double click). */
  pin?: boolean;
}

interface Props {
  projectPath: string | null;
  notebooks: string[];
  activePath: string | null;
  onOpenNotebook: (path: string, options?: LabOpenOptions) => void;
  onOpenFile: (path: string, options?: LabOpenOptions) => void;
  onAttachToAssistant: (attachment: ChatAttachment) => void;
  onFileChanged?: (change: LabFileChange) => void;
}

export type LabFileChange =
  | { type: "create"; path: string; isDir: boolean }
  | { type: "delete"; path: string; isDir: boolean }
  | { type: "rename"; path: string; newPath: string; isDir: boolean };

export default function LabFiles({
  projectPath,
  notebooks,
  activePath,
  onOpenNotebook,
  onOpenFile,
  onAttachToAssistant,
  onFileChanged,
}: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));
  const [artifactGroups, setArtifactGroups] = useState<Set<string>>(() => new Set());
  const [children, setChildren] = useState<Record<string, FileTreeEntry[]>>({});
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const [operationBusy, setOperationBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; entry: FileTreeEntry } | null>(null);
  const notebookSet = useMemo(() => new Set(notebooks), [notebooks]);
  const previewMode = isLabPreviewMode();

  // Dismiss the row context menu on any outside interaction (mirrors the
  // editor-tab context menu in Lab.tsx).
  useEffect(() => {
    if (!rowMenu) return;
    const dismiss = () => setRowMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setRowMenu(null);
    };
    window.addEventListener("mousedown", dismiss);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", dismiss);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("keydown", onKey);
    };
  }, [rowMenu]);

  const loadDir = useCallback(async (path: string) => {
    if (!isTauri() && !previewMode) return;
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
  }, [previewMode]);

  useEffect(() => {
    setExpanded(new Set([""]));
    setArtifactGroups(new Set());
    setChildren({});
    setError(null);
    void loadDir("");
  }, [loadDir, projectPath]);

  const toggleDir = (path: string) => {
    setExpanded((items) => {
      const next = new Set(items);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
        if (!children[path] && !loading.has(path)) void loadDir(path);
      }
      return next;
    });
  };

  const toggleArtifactGroup = (path: string) => {
    setArtifactGroups((items) => {
      const next = new Set(items);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const openFile = (path: string, pin: boolean) => {
    if (extension(path) === ".ipynb" || notebookSet.has(path)) {
      onOpenNotebook(path, { pin });
      return;
    }
    onOpenFile(path, { pin });
  };

  const refreshAfterChange = async (paths: string[]) => {
    const unique = Array.from(new Set(paths.map(normalizePath)));
    await Promise.all(unique.map((path) => loadDir(path)));
  };

  const createFile = async (parentPath: string) => {
    const suggested = joinPath(parentPath, "untitled.py");
    const path = window.prompt("New file path", suggested)?.trim();
    if (!path) return;
    setOperationBusy(true);
    setError(null);
    try {
      const file = await fileCreateText(path, defaultFileContent(path));
      const parent = dirname(file.path);
      setExpanded((items) => new Set(items).add(parent));
      await refreshAfterChange([parent]);
      onFileChanged?.({ type: "create", path: file.path, isDir: false });
      openFile(file.path, true);
    } catch (createError) {
      setError(String(createError));
    } finally {
      setOperationBusy(false);
    }
  };

  const createFolder = async (parentPath: string) => {
    const suggested = joinPath(parentPath, "new-folder");
    const path = window.prompt("New folder path", suggested)?.trim();
    if (!path) return;
    setOperationBusy(true);
    setError(null);
    try {
      const entry = await fileCreateDir(path);
      const parent = dirname(entry.path);
      setExpanded((items) => new Set(items).add(parent).add(entry.path));
      await refreshAfterChange([parent, entry.path]);
      onFileChanged?.({ type: "create", path: entry.path, isDir: true });
    } catch (createError) {
      setError(String(createError));
    } finally {
      setOperationBusy(false);
    }
  };

  const renameEntry = async (entry: FileTreeEntry) => {
    const nextPath = window.prompt("Rename or move to", entry.path)?.trim();
    if (!nextPath || normalizePath(nextPath) === normalizePath(entry.path)) return;
    setOperationBusy(true);
    setError(null);
    try {
      const renamed = await fileRename(entry.path, nextPath);
      setExpanded((items) => {
        const next = new Set<string>();
        const prefix = `${entry.path}/`;
        for (const item of items) {
          if (item === entry.path) next.add(renamed.path);
          else if (entry.isDir && item.startsWith(prefix)) next.add(`${renamed.path}/${item.slice(prefix.length)}`);
          else next.add(item);
        }
        return next;
      });
      await refreshAfterChange([dirname(entry.path), dirname(renamed.path)]);
      onFileChanged?.({ type: "rename", path: entry.path, newPath: renamed.path, isDir: entry.isDir });
    } catch (renameError) {
      setError(String(renameError));
    } finally {
      setOperationBusy(false);
    }
  };

  const deleteEntry = async (entry: FileTreeEntry) => {
    const confirmed = window.confirm(`Delete ${entry.isDir ? "folder" : "file"} "${entry.path}"?`);
    if (!confirmed) return;
    setOperationBusy(true);
    setError(null);
    try {
      await fileDelete(entry.path);
      setExpanded((items) => {
        const next = new Set<string>();
        const prefix = `${entry.path}/`;
        for (const item of items) {
          if (item !== entry.path && !item.startsWith(prefix)) next.add(item);
        }
        return next;
      });
      await refreshAfterChange([dirname(entry.path)]);
      onFileChanged?.({ type: "delete", path: entry.path, isDir: entry.isDir });
    } catch (deleteError) {
      setError(String(deleteError));
    } finally {
      setOperationBusy(false);
    }
  };

  function renderEntry(entry: FileTreeEntry, depth: number, generated = false) {
    const isExpanded = expanded.has(entry.path);
    const isActive = activePath === entry.path;
    const nested = children[entry.path] ?? [];
    const iconKind = generated ? "latex-artifact" : workspaceFileIconKind(entry.path, entry.isDir);
    return (
      <div key={entry.path}>
        <div
          className={`lab-explorer-row${entry.isDir ? " folder" : " file"}${iconKind === "latex-artifact" ? " generated" : ""}${isActive ? " active" : ""}`}
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
          onContextMenu={(event) => {
            event.preventDefault();
            setRowMenu({ x: event.clientX, y: event.clientY, entry });
          }}
        >
          <button
            className="lab-explorer-main"
            title={entry.isDir ? entry.path : `${entry.path}\nClick to preview, double-click to keep open. Right-click for more actions.`}
            onClick={() => {
              if (entry.isDir) toggleDir(entry.path);
              else openFile(entry.path, false);
            }}
            onDoubleClick={() => {
              if (!entry.isDir) openFile(entry.path, true);
            }}
          >
            <span className="lab-explorer-caret">{entry.isDir ? (isExpanded ? "v" : ">") : ""}</span>
            <span className="lab-explorer-icon">
              <WorkspaceFileIcon path={entry.path} directory={entry.isDir} kind={iconKind} />
            </span>
            <span className="lab-explorer-name">{entry.name}</span>
          </button>
        </div>
        {entry.isDir && isExpanded && (
          <div>
            {loading.has(entry.path) && (
              <div className="lab-explorer-muted" style={{ paddingLeft: `${(depth + 1) * 14 + 32}px` }}>
                Loading...
              </div>
            )}
            {!loading.has(entry.path) && nested.length === 0 && children[entry.path] && (
              <div className="lab-explorer-muted" style={{ paddingLeft: `${(depth + 1) * 14 + 32}px` }}>
                Empty
              </div>
            )}
            {renderEntries(nested, depth + 1, entry.path)}
          </div>
        )}
      </div>
    );
  }

  function renderEntries(entries: FileTreeEntry[], depth: number, parentPath: string) {
    const isGenerated = (entry: FileTreeEntry) => {
      if (entry.isDir) return false;
      if (isLatexBuildArtifact(entry.path)) return true;
      if (extension(entry.path) !== ".log") return false;
      const stem = basename(entry.path).slice(0, -4).toLowerCase();
      return entries.some((candidate) => !candidate.isDir && basename(candidate.path).toLowerCase() === `${stem}.tex`);
    };
    const generated = entries.filter(isGenerated);
    const visible = entries.filter((entry) => !isGenerated(entry));
    const groupKey = `latex-build:${parentPath}`;
    const groupOpen = artifactGroups.has(groupKey);

    return (
      <>
        {visible.map((entry) => renderEntry(entry, depth))}
        {generated.length > 0 && (
          <div className={`lab-explorer-artifact-group${groupOpen ? " open" : ""}`}>
            <button
              type="button"
              className="lab-explorer-artifact-toggle"
              style={{ paddingLeft: `${depth * 14 + 8}px` }}
              title={`${generated.length} generated files created by LaTeX compilation`}
              onClick={() => toggleArtifactGroup(groupKey)}
            >
              <span className="lab-explorer-caret">{groupOpen ? "v" : ">"}</span>
              <WorkspaceFileIcon path="" kind="latex-artifact" />
              <span>LaTeX build files</span>
              <em>{generated.length}</em>
            </button>
            {groupOpen && generated.map((entry) => renderEntry(entry, depth + 1, true))}
          </div>
        )}
      </>
    );
  }

  const rootChildren = children[""] ?? [];

  return (
    <div className="lab-explorer">
      <div className="lab-explorer-title">
        <span>EXPLORER</span>
        <div className="lab-explorer-title-actions">
          <button title="New file" disabled={operationBusy} onClick={() => void createFile("")}>
            <FileActionIcon name="file" />
          </button>
          <button title="New folder" disabled={operationBusy} onClick={() => void createFolder("")}>
            <FileActionIcon name="folder" />
          </button>
          <button title="Refresh files" disabled={operationBusy} onClick={() => void loadDir("")}>
            <FileActionIcon name="refresh" />
          </button>
        </div>
      </div>

      <div className="lab-explorer-root-row">
        <button className="lab-explorer-root" onClick={() => toggleDir("")}>
          <span className="lab-explorer-caret">{expanded.has("") ? "v" : ">"}</span>
          <WorkspaceFileIcon path={projectPath ?? ""} directory />
          <span>{rootLabel(projectPath)}</span>
        </button>
        {projectPath && (
          <button
            className="lab-explorer-action"
            title="Open project folder externally"
            onClick={() => void fileOpen(projectPath)}
          >
            <FileActionIcon name="open" />
          </button>
        )}
        <button className="lab-explorer-action" title="New file" disabled={operationBusy} onClick={() => void createFile("")}>
          <FileActionIcon name="file" />
        </button>
        <button className="lab-explorer-action" title="New folder" disabled={operationBusy} onClick={() => void createFolder("")}>
          <FileActionIcon name="folder" />
        </button>
      </div>

      {error && <div className="lab-inline-error lab-explorer-error">{error}</div>}

      <div className="lab-explorer-body">
        <div className="lab-explorer-tree">
          {expanded.has("") && (
            <>
              {loading.has("") && <div className="lab-explorer-muted root">Loading...</div>}
              {!loading.has("") && renderEntries(rootChildren, 0, "")}
            </>
          )}
        </div>
      </div>

      {rowMenu && (
        <div
          className="lab-tab-menu"
          style={{ left: rowMenu.x, top: rowMenu.y }}
          role="menu"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            disabled={operationBusy}
            onClick={() => {
              const entry = rowMenu.entry;
              onAttachToAssistant(
                entry.isDir ? folderAttachment(entry, children[entry.path] ?? []) : attachmentFromPath(entry.path),
              );
              setRowMenu(null);
            }}
          >
            Attach to assistant
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={operationBusy}
            onClick={() => {
              void renameEntry(rowMenu.entry);
              setRowMenu(null);
            }}
          >
            Rename / Move
          </button>
          <button
            type="button"
            role="menuitem"
            className="danger"
            disabled={operationBusy}
            onClick={() => {
              void deleteEntry(rowMenu.entry);
              setRowMenu(null);
            }}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
