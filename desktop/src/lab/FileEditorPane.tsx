import { useEffect, useMemo, useState } from "react";

import { fileOpen, fileReadText, fileWriteText, type FileText } from "../api/tauri";
import { makeId } from "../chat/model";
import type { ChatAttachment } from "../types";
import CodeEditor, { type EditorLanguage } from "./CodeEditor";

function basename(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() || path;
}

function extension(path: string): string {
  const name = basename(path);
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index).toLowerCase() : "";
}

function languageForPath(path: string): EditorLanguage {
  const ext = extension(path);
  if (ext === ".py" || ext === ".pyw") return "python";
  if (ext === ".md" || ext === ".markdown") return "markdown";
  if (ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") return "javascript";
  if (ext === ".ts" || ext === ".tsx" || ext === ".mts" || ext === ".cts") return "typescript";
  if (ext === ".css" || ext === ".scss") return "css";
  if (ext === ".json" || ext === ".jsonl") return "json";
  if (ext === ".html" || ext === ".htm" || ext === ".xml" || ext === ".svg") return "xml";
  if (ext === ".rs") return "rust";
  if (ext === ".sh" || ext === ".bash" || ext === ".zsh") return "bash";
  if (ext === ".ps1" || ext === ".psm1") return "powershell";
  if (ext === ".sql") return "sql";
  if (ext === ".yaml" || ext === ".yml") return "yaml";
  if (ext === ".toml" || ext === ".ini" || ext === ".env") return "ini";
  if (ext === ".tex") return "latex";
  return "text";
}

function attachmentFrom(path: string): ChatAttachment {
  return {
    id: makeId("att"),
    kind: "file",
    name: basename(path),
    path,
  };
}

interface Props {
  path: string;
  onAttachToAssistant: (attachment: ChatAttachment) => void;
}

export default function FileEditorPane({ path, onAttachToAssistant }: Props) {
  const [loaded, setLoaded] = useState<FileText | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const language = useMemo(() => languageForPath(path), [path]);
  const dirty = Boolean(loaded && draft !== loaded.content);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const file = await fileReadText(path);
      setLoaded(file);
      setDraft(file.content);
    } catch (readError) {
      setLoaded(null);
      setDraft("");
      setError(String(readError));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setLoaded(null);
    setDraft("");
    fileReadText(path)
      .then((file) => {
        if (cancelled) return;
        setLoaded(file);
        setDraft(file.content);
      })
      .catch((readError) => {
        if (cancelled) return;
        setError(String(readError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const save = async () => {
    if (!loaded || !dirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      const file = await fileWriteText(path, draft);
      setLoaded(file);
      setDraft(file.content);
    } catch (writeError) {
      setError(String(writeError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="lab-file-editor">
      <div className="lab-file-editor-bar">
        <div className="lab-file-editor-title">
          <strong>{basename(path)}</strong>
          <span title={path}>{path}</span>
        </div>
        <div className="lab-file-editor-actions">
          <span className="lab-file-editor-lang">{language}</span>
          <button className="lab-btn ghost" onClick={() => onAttachToAssistant(attachmentFrom(path))}>
            Attach
          </button>
          <button className="lab-btn ghost" onClick={() => void fileOpen(path)}>
            Open app
          </button>
          <button className="lab-btn ghost" disabled={loading || saving} onClick={() => void load()}>
            Reload
          </button>
          <button className="lab-btn primary" disabled={!dirty || saving || loading || !loaded} onClick={() => void save()}>
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      {error && (
        <div className="lab-file-editor-error">
          <strong>Cannot open this file in Lab.</strong>
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="lab-empty">Loading file...</div>
      ) : loaded ? (
        <CodeEditor
          value={draft}
          language={language}
          onChange={setDraft}
          placeholder="Start typing..."
          readOnly={saving}
        />
      ) : !error ? (
        <div className="lab-empty">Select a text file from Files to open it here.</div>
      ) : null}
    </div>
  );
}
