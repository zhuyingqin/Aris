import { useCallback, useEffect, useMemo, useState } from "react";

import { isLabPreviewMode } from "../api/labPreview";
import { fileListDir, fileOpen, isTauri, type FileTreeEntry } from "../api/tauri";
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

function iconForFile(path: string): string {
  const ext = extension(path);
  if (ext === ".ipynb") return "[]";
  if (ext === ".json" || ext === ".toml" || ext === ".yaml" || ext === ".yml") return "{}";
  if (ext === ".md") return "i";
  if (ext === ".lock") return "=";
  if ([".ts", ".tsx", ".js", ".jsx", ".rs", ".py", ".sh"].includes(ext)) return "<>";
  return "-";
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
}

export default function LabFiles({
  projectPath,
  notebooks,
  activePath,
  onOpenNotebook,
  onOpenFile,
  onAttachToAssistant,
}: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));
  const [children, setChildren] = useState<Record<string, FileTreeEntry[]>>({});
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
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
          {entry.isDir ? (
            <button
              className="lab-explorer-attach"
              title="Attach folder listing to assistant"
              onClick={() => onAttachToAssistant(folderAttachment(entry, nested))}
            >
              +
            </button>
          ) : (
            <button
              className="lab-explorer-attach"
              title="Attach to assistant"
              onClick={() => onAttachToAssistant(attachmentFromPath(entry.path))}
            >
              +
            </button>
          )}
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
        <button title="Refresh files" onClick={() => void loadDir("")}>...</button>
      </div>

      <div className="lab-explorer-root-row">
        <button className="lab-explorer-root" onClick={() => toggleDir("")}>
          <span className="lab-explorer-caret">{expanded.has("") ? "v" : ">"}</span>
          <span>{rootLabel(projectPath)}</span>
        </button>
        {projectPath && (
          <button
            className="lab-explorer-attach"
            title="Open project folder externally"
            onClick={() => void fileOpen(projectPath)}
          >
            o
          </button>
        )}
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
