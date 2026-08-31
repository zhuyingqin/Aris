import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fileAssetUrl, fileOpen, fileReadBytes, fileReadText, fileReveal, isTauri } from "../api/tauri";
import { SharedEditor } from "../editor/SharedEditor";
import { basename, languageForPath, workspaceFileOpenTarget } from "../editor/workspaceFiles";
import { useStore, type SidePanelEvidenceTarget } from "../store";
import { SvgIcon } from "../SvgIcon";
import type { PdfAnnotation } from "../literature/literatureTypes";
import MarkdownContent from "./MarkdownContent";
import {
  fileHandoff,
  imageMimeType,
  sideFileKind,
  sideFileTitle,
  type SidePanelMetadata,
} from "./sidePanelFiles";
import "./SideFileViewer.css";

/** PDF support (reader + literature stylesheet) is only paid for on first use. */
const PdfReader = lazy(async () => {
  await import("../literature/Literature.css");
  return import("../literature/PdfReader");
});

const EMPTY_ANNOTATIONS: PdfAnnotation[] = [];

const VIEWER_COPY = {
  cn: {
    loading: "正在读取文件…",
    failed: (reason: string) => `无法在侧栏打开：${reason}`,
    empty: "文件为空。",
    preview: "预览",
    source: "源码",
    viewMode: "文件视图",
    projectRoot: "项目根目录",
    kinds: {
      pdf: "PDF",
      image: "图片",
      markdown: "Markdown",
      text: "文本",
    },
    refresh: "重新读取",
    openWorkspace: (target: string) => target === "code" ? "在 Code 页面打开" : "在 LaTeX 页面打开",
    openExternal: "用系统程序打开",
    reveal: "在资源管理器中显示",
    selectionHint: (count: number) => `已选中 ${count} 个字符 · 可发送到主任务`,
    pdfPage: (page: number) => `第 ${page} 页`,
    citedEvidence: "回答引用证据",
    citedEvidenceHint: "已跳转到原文页；黄色标记是本次回答使用的证据片段。",
  },
  en: {
    loading: "Reading file…",
    failed: (reason: string) => `Cannot open here: ${reason}`,
    empty: "This file is empty.",
    preview: "Preview",
    source: "Source",
    viewMode: "File view",
    projectRoot: "Project root",
    kinds: {
      pdf: "PDF",
      image: "Image",
      markdown: "Markdown",
      text: "Text",
    },
    refresh: "Reload",
    openWorkspace: (target: string) => target === "code" ? "Open in Code" : "Open in LaTeX",
    openExternal: "Open with system app",
    reveal: "Show in file manager",
    selectionHint: (count: number) => `${count} characters selected · can be sent to the main task`,
    pdfPage: (page: number) => `Page ${page}`,
    citedEvidence: "Cited evidence",
    citedEvidenceHint: "Opened at the source page; yellow marks show evidence used by the answer.",
  },
} as const;

function fileParent(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : "";
}

function formatFileBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

interface Props {
  tabId: string;
  path: string;
  evidence?: SidePanelEvidenceTarget;
  onOpenInWorkspace: (path: string) => void;
  onMetadataChange: (tabId: string, metadata: SidePanelMetadata) => void;
}

/**
 * Read-only reading surface for the chat side panel. It deliberately reuses the
 * existing viewers — `PdfReader` for PDFs, the shared CodeMirror editor for
 * text, `MarkdownContent` for markdown — so the panel stays a thin composition
 * layer rather than a second implementation of each format.
 */
export default function SideFileViewer({
  tabId,
  path,
  evidence,
  onOpenInWorkspace,
  onMetadataChange,
}: Props) {
  const language = useStore((state) => state.language);
  const currentProject = useStore((state) => state.currentProject);
  const copy = VIEWER_COPY[language];
  const kind = useMemo(() => sideFileKind(path), [path]);
  const workspaceTarget = useMemo(() => workspaceFileOpenTarget(path), [path]);
  const fileLocation = useMemo(() => {
    const parent = fileParent(path);
    if (!currentProject) return parent || copy.projectRoot;
    const normalizedParent = parent.replace(/\\/g, "/").toLowerCase();
    const normalizedRoot = currentProject.path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    if (normalizedParent === normalizedRoot) return `${currentProject.name} / ${copy.projectRoot}`;
    if (normalizedParent.startsWith(`${normalizedRoot}/`)) {
      return `${currentProject.name} / ${parent.slice(normalizedRoot.length + 1)}`;
    }
    return parent || copy.projectRoot;
  }, [copy.projectRoot, currentProject, path]);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [reloadKey, setReloadKey] = useState(0);
  const [text, setText] = useState("");
  const [fileBytes, setFileBytes] = useState<number | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(kind !== "pdf");
  const [error, setError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [selection, setSelection] = useState("");
  const [pdfPage, setPdfPage] = useState(1);
  const evidenceAnnotations = useMemo<PdfAnnotation[]>(() => (
    evidence?.quotes.map((quote, index) => ({
      id: `${evidence.requestKey}:${index}`,
      page: evidence.page,
      quote,
      note: evidence.citation,
      kind: "answer-support",
      color: "yellow",
      style: "highlight",
      sourceId: evidence.requestKey,
      createdAt: "",
    })) ?? EMPTY_ANNOTATIONS
  ), [evidence]);

  // ── Load ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (kind === "pdf") {
      setLoading(false);
      setError(null);
      setFileBytes(null);
      return;
    }
    let disposed = false;
    setLoading(true);
    setError(null);
    setFileBytes(null);
    if (kind === "image") {
      let objectUrl: string | null = null;
      const imageUrlPromise = isTauri()
        ? fileAssetUrl(path, imageMimeType(path))
        : fileReadBytes(path).then((bytes) => URL.createObjectURL(new Blob([bytes], { type: imageMimeType(path) })));
      void imageUrlPromise
        .then((imageUrl) => {
          if (disposed) return;
          objectUrl = imageUrl.startsWith("blob:") ? imageUrl : null;
          setImageUrl(imageUrl);
        })
        .catch((reason) => { if (!disposed) setError(String(reason)); })
        .finally(() => { if (!disposed) setLoading(false); });
      return () => {
        disposed = true;
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        setImageUrl(null);
      };
    }
    void fileReadText(path)
      .then((file) => {
        if (disposed) return;
        setText(file.content);
        setFileBytes(file.bytes);
      })
      .catch((reason) => { if (!disposed) setError(String(reason)); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [kind, path, reloadKey]);

  useEffect(() => {
    setShowSource(false);
    setSelection("");
    setPdfPage(1);
  }, [path]);

  // ── Selection → handoff ───────────────────────────────────────────────────
  // Any text selected inside the viewer (PDF text layer, markdown, editor) can
  // be quoted back into the main composer, which is the point of reading here
  // rather than in a separate workspace tab.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const capture = () => {
      const active = window.getSelection();
      if (!active || active.isCollapsed || active.rangeCount === 0) {
        setSelection("");
        return;
      }
      const anchor = active.anchorNode;
      const anchorElement = anchor instanceof Element ? anchor : anchor?.parentElement ?? null;
      if (!anchorElement || !container.contains(anchorElement)) return;
      setSelection(active.toString().trim());
    };
    container.addEventListener("mouseup", capture);
    container.addEventListener("keyup", capture);
    return () => {
      container.removeEventListener("mouseup", capture);
      container.removeEventListener("keyup", capture);
    };
  }, []);

  useEffect(() => {
    onMetadataChange(tabId, {
      title: sideFileTitle(path),
      handoff: fileHandoff(path, selection, language, kind === "pdf" ? pdfPage : null),
    });
  }, [kind, language, onMetadataChange, path, pdfPage, selection, tabId]);

  const openExternal = useCallback(() => {
    if (isTauri()) void fileOpen(path).catch(() => undefined);
  }, [path]);

  const revealInExplorer = useCallback(() => {
    if (isTauri()) void fileReveal(path).catch(() => undefined);
  }, [path]);

  const body = () => {
    if (error) {
      return (
        <div className="side-file-state error">
          <p>{copy.failed(error)}</p>
          <button type="button" onClick={openExternal}>{copy.openExternal}</button>
        </div>
      );
    }
    if (loading) return <div className="side-file-state">{copy.loading}</div>;
    if (kind === "pdf") {
      return (
        <div className="side-file-pdf-evidence">
          {evidence && (
            <div className="side-file-evidence-banner">
              <SvgIcon name="search" size={14} />
              <div>
                <strong>{copy.citedEvidence} · {evidence.citation}</strong>
                <span>{copy.citedEvidenceHint}</span>
              </div>
            </div>
          )}
          <Suspense fallback={<div className="side-file-state">{copy.loading}</div>}>
            <PdfReader
              key={reloadKey}
              relativePath={path}
              sourceKind="path"
              initialPage={evidence?.page ?? 1}
              pageRequestKey={evidence?.requestKey}
              annotations={evidenceAnnotations}
              focusedAnnotationId={evidenceAnnotations[0]?.id}
              readOnly
              onOpenExternal={openExternal}
              onReveal={revealInExplorer}
              onAddAnnotation={() => undefined}
              onUpdateAnnotation={() => undefined}
              onDeleteAnnotation={() => undefined}
              onRunAi={() => Promise.resolve("")}
              onPageChange={setPdfPage}
            />
          </Suspense>
        </div>
      );
    }
    if (kind === "image") {
      return (
        <div className="side-file-image-scroll">
          {imageUrl && <img src={imageUrl} alt={basename(path)} />}
        </div>
      );
    }
    if (!text.trim()) return <div className="side-file-state">{copy.empty}</div>;
    if (kind === "markdown" && !showSource) {
      return (
        <div className="side-file-markdown">
          <MarkdownContent text={text} />
        </div>
      );
    }
    return (
      <SharedEditor
        className="side-file-editor"
        doc={text}
        language={languageForPath(path)}
        surface="code"
        readOnly
      />
    );
  };

  return (
    <div className="side-file-viewer" ref={containerRef}>
      <header className="side-file-toolbar">
        <div className="side-file-identity" title={path}>
          <span className="side-file-kind-icon">
            <SvgIcon name={kind === "image" ? "image" : "document"} size={15} />
          </span>
          <span className="side-file-heading">
            <strong>{basename(path)}</strong>
            <span>{fileLocation}</span>
          </span>
          <span className="side-file-meta">
            {copy.kinds[kind]}{fileBytes != null ? ` · ${formatFileBytes(fileBytes)}` : ""}
          </span>
        </div>
        <div className="side-file-controls">
          {kind === "markdown" && (
            <div className="side-file-view-switch" role="group" aria-label={copy.viewMode}>
              <button
                type="button"
                className={!showSource ? "active" : ""}
                aria-pressed={!showSource}
                onClick={() => setShowSource(false)}
              >
                {copy.preview}
              </button>
              <button
                type="button"
                className={showSource ? "active" : ""}
                aria-pressed={showSource}
                onClick={() => setShowSource(true)}
              >
                {copy.source}
              </button>
            </div>
          )}
          <div className="side-file-actions">
            {workspaceTarget !== "external" && (
              <button
                type="button"
                className="side-file-open-workspace"
                aria-label={copy.openWorkspace(workspaceTarget)}
                onClick={() => onOpenInWorkspace(path)}
              >
                <SvgIcon name={workspaceTarget === "code" ? "code" : "document"} size={13} />
                <span>{copy.openWorkspace(workspaceTarget)}</span>
              </button>
            )}
            <button
              type="button"
              aria-label={copy.refresh}
              title={copy.refresh}
              onClick={() => setReloadKey((value) => value + 1)}
            >
              <SvgIcon name="refresh" size={13} />
            </button>
            <button
              type="button"
              aria-label={copy.reveal}
              title={copy.reveal}
              onClick={revealInExplorer}
            >
              <SvgIcon name="folder" size={13} />
            </button>
            <button
              type="button"
              aria-label={copy.openExternal}
              title={copy.openExternal}
              onClick={openExternal}
            >
              <SvgIcon name="externalLink" size={13} />
            </button>
          </div>
        </div>
      </header>
      <div className="side-file-body">{body()}</div>
      {selection && (
        <div className="side-file-selection">
          <SvgIcon name="info" size={13} />
          <span>{copy.selectionHint([...selection].length)}</span>
        </div>
      )}
    </div>
  );
}
