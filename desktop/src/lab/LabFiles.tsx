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

function iconForFile(path: string): string {
  const ext = extension(path);
  if (ext === ".ipynb") return "[]";
  if (ext === ".json" || ext === ".toml" || ext === ".yaml" || ext === ".yml") return "{}";
  if (ext === ".md") return "i";
  if (ext === ".lock") return "=";
  if ([".ts", ".tsx", ".js", ".jsx", ".rs", ".py", ".sh"].includes(ext)) return "<>";
  return "-";
}

type FileIconName = "attach" | "delete" | "file" | "folder" | "open" | "refresh" | "rename";

function FileActionIcon({ name }: { name: FileIconName }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {name === "attach" && <path d="M8 3.2v9.6M3.2 8h9.6" />}
      {name === "delete" && <path d="M3 4h10M6.5 4V2.8h3V4M5 4l.6 9h4.8L11 4" />}
      {name === "file" && <path d="M4 2.5h5.2L12 5.3v8.2H4zM9.2 2.5v2.8H12" />}
      {name === "folder" && <path d="M2.5 4.2h4l1 1h6v7.3h-11z" />}
      {name === "open" && <path d="M5.5 3h7.5v7.5M12.8 3.2 7.5 8.5M3 5.5v7.5h7.5" />}
      {name === "refresh" && <path d="M12.5 5.6A4.8 4.8 0 1 0 13 8M12.5 2.8v2.8H9.7" />}
      {name === "rename" && <path d="m3 11.8 2.3-.5 6.3-6.3-1.8-1.8-6.3 6.3zM8.6 4.4l1.8 1.8M3 13h10" />}
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

interface Props {
  projectPath: string | null;
  notebooks: string[];
  activePath: string | null;
  onOpenNotebook: (path: string) => void;
  onOpenFile: (path: string) => void;
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
  const [children, setChildren] = useState<Record<string, FileTreeEntry[]>>({});
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const [operationBusy, setOperationBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const notebookSet = useMemo(() => new Set(notebooks), [notebooks]);
  const previewMode = isLabPreviewMode();

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

  const openFile = (path: string) => {
    if (extension(path) === ".ipynb" || notebookSet.has(path)) {
      onOpenNotebook(path);
      return;
    }
    onOpenFile(path);
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
      openFile(file.path);
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

  const renderEntry = (entry: FileTreeEntry, depth: number) => {
    const isExpanded = expanded.has(entry.path);
    const isActive = activePath === entry.path;
    const nested = children[entry.path] ?? [];
    return (
      <div key={entry.path}>
        <div
          className={`lab-explorer-row${entry.isDir ? " folder" : " file"}${isActive ? " active" : ""}`}
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
        >
          <button
            className="lab-explorer-main"
            title={entry.path}
            onClick={() => {
              if (entry.isDir) toggleDir(entry.path);
              else openFile(entry.path);
            }}
          >
            <span className="lab-explorer-caret">{entry.isDir ? (isExpanded ? "v" : ">") : ""}</span>
            <span className={`lab-explorer-icon ${entry.isDir ? "folder" : "file"}`}>
              {entry.isDir ? "" : iconForFile(entry.path)}
            </span>
            <span className="lab-explorer-name">{entry.name}</span>
          </button>
          <div className="lab-explorer-row-actions">
          {entry.isDir ? (
            <button
              className="lab-explorer-action"
              title="Attach folder listing to assistant"
              disabled={operationBusy}
              onClick={() => onAttachToAssistant(folderAttachment(entry, nested))}
            >
              <FileActionIcon name="attach" />
            </button>
          ) : (
            <button
              className="lab-explorer-action"
              title="Attach to assistant"
              disabled={operationBusy}
              onClick={() => onAttachToAssistant(attachmentFromPath(entry.path))}
            >
              <FileActionIcon name="attach" />
            </button>
          )}
            <button
              className="lab-explorer-action"
              title="Rename or move"
              disabled={operationBusy}
              onClick={(event) => {
                event.stopPropagation();
                void renameEntry(entry);
              }}
            >
              <FileActionIcon name="rename" />
            </button>
            <button
              className="lab-explorer-action danger"
              title="Delete"
              disabled={operationBusy}
              onClick={(event) => {
                event.stopPropagation();
                void deleteEntry(entry);
              }}
            >
              <FileActionIcon name="delete" />
            </button>
          </div>
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
            {nested.map((child) => renderEntry(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

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
              {!loading.has("") && rootChildren.map((entry) => renderEntry(entry, 0))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
