import { Fragment, useEffect, useRef, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { isTauri } from "../api/tauri";
import ImageLightbox from "../ImageLightbox";
import { tr } from "../language";
import { useStore } from "../store";
import { SvgIcon, type SvgIconName } from "../SvgIcon";
import FigureComposer, { EMPTY_DRAFT, effectiveModels, type FigureDraft, type FigureModelOptions } from "./FigureComposer";
import FigureEditor, { type FigureEditorHandle } from "./FigureEditor";
import FigureRasterEditor from "./FigureRasterEditor";
import FigureSvgChat from "./FigureSvgChat";
import FigureSourceEditor from "./FigureSourceEditor";
import { ArtifactsCard, ExportMenu, FlowStepper, LedgerCard, LedgerPill, PipelineList, StatusChip } from "./FigurePanels";
import { figureCancel, figureConnections, figureDelete, figureDiscardDraft, figureDocument, figureExport, figureList, figurePrepare, figureReview, figureSave, figureSelectRaster, figureStart, figuresAvailable, onFigureUpdated } from "./figureApi";
import useFigureDraft from "./useFigureDraft";
import FigureResizeHandle, { useFigurePanelSize } from "./FigureResizeHandle";
import { formatTime, formatTokens, statusLabel, statusTone, titleFromDescription, truncationInsight } from "./figureModel";
import type { FigureConnections, FigureDocument, FigureRasterDocument, FigureView } from "./types";
import "./figures.css";

const EMPTY: FigureDocument = { svg: null, sourceDataUrl: null, previewDataUrl: null };
type Panel = "canvas" | "compare" | "source" | "image";

export default function FigureStudio({ visible = true }: { visible?: boolean }) {
  const project = useStore((s) => s.currentProject);
  const language = useStore((s) => s.language);
  const t = (cn: string, en: string, es: string) => tr(language, cn, en, es);
  const projectId = project?.id ?? null;
  const [runs, setRuns] = useState<FigureView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [connections, setConnections] = useState<FigureConnections | null>(null);
  const [connectionsReady, setConnectionsReady] = useState(false);
  // Choices remain available while a new selection resolves or fails validation.
  const [options, setOptions] = useState<FigureModelOptions>({ executor: [], reviewer: [], image: [] });
  const [document, setDocument] = useState<FigureDocument>(EMPTY);
  const [source, setSource] = useState("");
  const [dirty, setDirty] = useState(false);
  const [editOrigin, setEditOrigin] = useState<"canvas" | "source" | null>(null);
  const [panel, setPanel] = useState<Panel>("canvas");
  const [draft, setDraft] = useState<FigureDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [versionIndex, setVersionIndex] = useState<number | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 760);
  const [showLedger, setShowLedger] = useState(false);
  const [showArtifacts, setShowArtifacts] = useState(() => window.innerWidth > 960);
  const [showSvgChat, setShowSvgChat] = useState(false);
  const [lightbox, setLightbox] = useState<{ src: string; title: string } | null>(null);
  const editor = useRef<FigureEditorHandle>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarLayout = useFigurePanelSize("sidebar");
  const comparisonRef = useRef<HTMLElement>(null);
  const comparisonLayout = useFigurePanelSize("comparison");
  const submitting = useRef(false);
  const projectRef = useRef(projectId); projectRef.current = projectId;
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  // Task IDs are never reused, so a list poll in flight during deletion cannot resurrect one.
  const deleted = useRef(new Set<string>());
  const current = runs.find((entry) => entry.run.id === selected) ?? null;
  const version = current?.run.versions.at(-1);
  const displayedVersion = versionIndex === null ? version : current?.run.versions.find((v) => v.index === versionIndex);
  const status = (value: string) => statusLabel(value, language);
  const upsert = (next: FigureView) => { if (!deleted.current.has(next.run.id)) setRuns((all) => [next, ...all.filter((entry) => entry.run.id !== next.run.id)]); };
  const listed = (all: FigureView[]) => all.filter((entry) => !deleted.current.has(entry.run.id));
  const { executorModel, reviewerModel } = draft;
  const editRef = useRef({ source, editOrigin }); editRef.current = { source, editOrigin };
  const autosave = useFigureDraft({
    projectId, id: selected, blocked: busy || !!current?.active,
    readSvg: async () => {
      const svg = editRef.current.editOrigin === "source" ? editRef.current.source : await editor.current?.serialize();
      if (svg === undefined) throw new Error(t("画布尚未准备好，请稍后再试。", "The canvas is not ready. Try again shortly.", "El lienzo aún no está listo. Inténtalo de nuevo en un momento."));
      return svg;
    },
    onError: (message) => setError(t(`草稿自动保存失败：${message}`, `Draft autosave failed: ${message}`, `No se pudo guardar el borrador automáticamente: ${message}`)),
    onSaved: () => setError((message) => message?.startsWith(t("草稿自动保存失败：", "Draft autosave failed:", "No se pudo guardar el borrador automáticamente:")) ? null : message),
  });
  useEffect(() => {
    useStore.getState().setFigureDirty(autosave.unsaved || (dirty && busy));
    return () => useStore.getState().setFigureDirty(false);
  }, [autosave.unsaved, dirty, busy]);
  const resetEdits = () => {
    autosave.restore(); dirtyRef.current = false; setDirty(false); setEditOrigin(null);
  };
  const edited = (origin: "canvas" | "source") => {
    dirtyRef.current = true; setDirty(true); setEditOrigin(origin);
    autosave.changed({ expectedHash: version?.hash ?? null, baseIndex: displayedVersion?.index ?? null });
  };

  useEffect(() => {
    if (current?.run.pendingRasterEdit || (current?.run.status === "image_ready" && !current.run.versions.length)) setPanel("image");
  }, [selected, current?.run.status, current?.run.pendingRasterEdit?.requestId]);

  useEffect(() => {
    let width = window.innerWidth;
    const resize = () => {
      const next = window.innerWidth;
      // Collapse on entering a compact layout; explicit reopening stays open.
      if (width > 760 && next <= 760) setSidebarOpen(false);
      if (width > 960 && next <= 960) { setShowArtifacts(false); setShowSvgChat(false); }
      width = next;
    };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  useEffect(() => {
    if (!visible || !projectId || !figuresAvailable()) return;
    let disposed = false;
    setConnectionsReady(false);
    void figureConnections(executorModel, reviewerModel).then((next) => {
      if (disposed) return;
      setConnections(next); setConnectionsReady(!next.error && !!next.executor && !!next.reviewer); setError(next.error ?? null);
      setOptions({ executor: next.executorModels ?? (next.executor ? [next.executor.model] : []), reviewer: next.reviewerModels ?? (next.reviewer ? [next.reviewer.model] : []), image: next.image.models });
    }).catch((e) => { if (!disposed) setError(String(e)); });
    return () => { disposed = true; };
  }, [visible, projectId, executorModel, reviewerModel]);

  useEffect(() => {
    let disposed = false; let unlisten: (() => void) | null = null;
    resetEdits(); setSelected(null); setVersionIndex(null); setRuns([]); setDocument(EMPTY); setSource(""); setError(null); setConnections(null);
    if (!projectId || !figuresAvailable()) return;
    void figureList(projectId).then((all) => { if (!disposed) setRuns(listed(all)); }).catch((e) => { if (!disposed) setError(String(e)); });
    void onFigureUpdated((next) => { if (!disposed && next.projectId === projectId) upsert(next); }).then((fn) => { if (disposed) fn(); else unlisten = fn; }).catch(() => undefined);
    // Reconcile missed events and process restarts. Listing never sends requests.
    const timer = setInterval(() => { void figureList(projectId).then((all) => { if (!disposed) setRuns(listed(all)); }).catch(() => undefined); }, 4000);
    return () => { disposed = true; clearInterval(timer); unlisten?.(); };
  }, [projectId]);

  useEffect(() => {
    if (!projectId || !selected) { setDocument(EMPTY); return; }
    let disposed = false;
    void figureDocument(projectId, selected, versionIndex).then((doc) => {
      if (disposed || dirtyRef.current) return;
      autosave.restore(doc.draft ?? null);
      dirtyRef.current = !!doc.draft; setDirty(!!doc.draft); setEditOrigin(doc.draft ? "source" : null);
      setDocument(doc); setSource(doc.draft?.svg ?? doc.svg ?? doc.rawOutput ?? "");
      if (doc.draft && !doc.svg) setPanel("source");
    }).catch((e) => { if (!disposed) setError(String(e)); });
    return () => { disposed = true; };
  }, [projectId, selected, version?.hash, version?.index, current?.run.sourceHash, versionIndex]);

  useEffect(() => {
    if (isTauri()) return;
    const guard = (event: BeforeUnloadEvent) => { if (autosave.unsavedRef.current || useStore.getState().figureDirty) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", guard); return () => window.removeEventListener("beforeunload", guard);
  }, []);

  const select = (id: string | null, prepared = false) => {
    if (id === selected) return;
    if (autosave.unsavedRef.current || (busy && !prepared)) { setError(t("请等待草稿自动保存完成，或放弃当前编辑。", "Wait for draft autosave or discard the current edits.", "Espera a que se guarde el borrador o descarta los cambios actuales.")); return; }
    resetEdits();
    setSelected(id); setVersionIndex(null); setDocument(EMPTY); setSource(""); setEditOrigin(null); setError(null); setPanel("canvas");
    if (window.innerWidth <= 760) setSidebarOpen(false);
  };
  const chooseVersion = (index: number | null) => {
    if (index === versionIndex) return;
    resetEdits(); setVersionIndex(index);
  };
  const upload = async (file?: File) => {
    if (!file) return;
    try {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) throw new Error(t("请选择 10 MB 以内的 PNG、JPEG 或 WebP。", "Choose a PNG, JPEG or WebP under 10 MB.", "Elige un PNG, JPEG o WebP de menos de 10 MB."));
      const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); });
      setDraft((d) => ({ ...d, image: { base64: data.split(",")[1], url: data, name: file.name } })); setError(null);
    } catch (e) { setError(String(e)); }
  };
  const create = async () => {
    if (submitting.current || !projectId) return;
    const owner = projectId; submitting.current = true; setBusy(true); setError(null);
    try {
      const generate = !draft.image;
      const prepared = await figurePrepare({
        projectId: owner, id: crypto.randomUUID().replace(/-/g, ""), title: titleFromDescription(draft.description) || t("科研绘图", "Scientific figure", "Figura científica"),
        method: draft.description.trim(), style: draft.style, sourceMode: generate ? "generate" : "import", sourceBase64: draft.image?.base64 ?? null,
        model: connections?.executor?.model ?? null, reviewerModel: connections?.reviewer?.model ?? null, imageModel: generate ? models.image || null : null,
      });
      if (projectRef.current === owner) { upsert(prepared); setSelected(prepared.run.id); setPanel("canvas"); }
      const started = await figureStart(owner, prepared.run.id);
      if (projectRef.current === owner) upsert(started);
    } catch (e) { if (projectRef.current === owner) setError(String(e)); }
    finally { submitting.current = false; setBusy(false); }
  };
  const save = async () => {
    if (!projectId || !current || busy || current.active) return;
    const owner = projectId; const id = current.run.id; setBusy(true); setError(null);
    try {
      await autosave.settle();
      const svg = editOrigin === "source" ? source : await editor.current?.serialize();
      if (!svg) throw new Error(t("请打开画布或 SVG 源码后保存。", "Open the canvas or SVG source before saving.", "Abre el lienzo o el código SVG antes de guardar."));
      const parent = autosave.base.current ?? { expectedHash: version?.hash ?? null, baseIndex: displayedVersion?.index ?? null };
      const next = await figureSave(owner, id, parent.expectedHash, svg, parent.baseIndex);
      if (projectRef.current === owner && selectedRef.current === id) {
        resetEdits(); setVersionIndex(null); upsert(next);
        const doc = await figureDocument(owner, id);
        if (projectRef.current === owner && selectedRef.current === id) { setDocument(doc); setSource(doc.svg ?? ""); }
      }
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const discard = async () => {
    if (!projectId || !selected || busy) return;
    const owner = projectId, id = selected; setBusy(true);
    try {
      await autosave.settle();
      await figureDiscardDraft(owner, id);
      const doc = await figureDocument(owner, id, versionIndex);
      if (projectRef.current === owner && selectedRef.current === id) {
        resetEdits(); setDocument(doc); setSource(doc.svg ?? doc.rawOutput ?? ""); setError(null);
      }
    } finally { setBusy(false); }
  };
  const exportFile = async (format: string) => {
    if (!projectId || !current) return;
    if (dirty) { setError(t("保存当前版本后再导出。", "Save the current version before exporting.", "Guarda la versión actual antes de exportar.")); return; }
    setBusy(true); setError(null);
    try {
      let destination: string | null = null;
      if (isTauri()) {
        destination = await saveDialog({ defaultPath: `figure-${current.run.id.slice(0, 8)}.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
        if (!destination) return;
      }
      const result = await figureExport(projectId, current.run.id, format, destination, versionIndex);
      if (!destination) {
        const bytes = Uint8Array.from(atob(result.dataBase64), (c) => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: result.mimeType }));
        const link = window.document.createElement("a"); link.href = url; link.download = result.filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const switchPanel = async (next: Panel) => {
    if (next === panel) return;
    const owner = projectId, id = selected;
    const stillSelected = () => projectRef.current === owner && selectedRef.current === id;
    if (dirty && panel === "canvas" && editOrigin === "canvas") {
      try {
        const svg = await editor.current?.serialize();
        if (!stillSelected()) return;
        if (svg) setSource(svg);
      } catch (e) { if (stillSelected()) setError(String(e)); return; }
    }
    if (dirty && editOrigin === "source" && next === "canvas") {
      if (autosave.unsavedRef.current) { setError(t("请等待草稿自动保存完成。", "Wait for draft autosave.", "Espera a que se guarde el borrador.")); return; }
      try {
        const doc = await figureDocument(owner!, id!);
        if (!stillSelected() || autosave.unsavedRef.current) return;
        if (!doc.svg) throw new Error(t("请先修复 SVG 源码，再打开画布。", "Repair the SVG source before opening the canvas.", "Corrige el código SVG antes de abrir el lienzo."));
        setDocument(doc); setEditOrigin("canvas"); setError(null);
      } catch (e) { setError(String(e)); return; }
    }
    setPanel(next);
  };
  const remove = async (entry: FigureView) => {
    if (!projectId || entry.active || busy || submitting.current) return;
    const id = entry.run.id; const unsaved = id === selected && dirty; const title = titleFromDescription(entry.run.title);
    const message = t(`删除「${title}」？\n该绘图的原图、草稿、全部版本和本地运行记录将从磁盘删除，无法恢复。${unsaved ? "\n未保存的编辑也会丢失。" : ""}`,
      `Delete "${title}"?\nThe source image, draft, all versions and local run records will be deleted from disk. This cannot be undone.${unsaved ? "\nUnsaved edits are lost too." : ""}`, `¿Eliminar «${title}»?\nLa imagen original, el borrador, todas las versiones y los registros locales de ejecución se eliminarán del disco. No se puede deshacer.${unsaved ? "\nTambién se perderán los cambios sin guardar." : ""}`);
    if (!window.confirm(message)) return;
    const owner = projectId;
    submitting.current = true; setBusy(true);
    try {
      if (id === selectedRef.current) await autosave.settle();
      await figureDelete(owner, id);
      deleted.current.add(id);
      if (projectRef.current !== owner) return;
      setRuns((all) => all.filter((item) => item.run.id !== id));
      if (selectedRef.current === id) {
        resetEdits();
        setSelected(null); setVersionIndex(null); setDocument(EMPTY); setSource(""); setPanel("canvas");
      }
    } catch (e) { setError(String(e)); }
    finally { submitting.current = false; setBusy(false); }
  };
  /** Prefills a new task from this one, reusing its reference image. */
  const duplicate = () => {
    if (!current) return;
    const { run } = current;
    if (autosave.unsavedRef.current || busy) { setError(t("请等待草稿自动保存完成，或放弃当前编辑。", "Wait for draft autosave or discard the current edits.", "Espera a que se guarde el borrador o descarta los cambios actuales.")); return; }
    const source = document.sourceDataUrl;
    setDraft({
      description: run.method, style: run.style,
      executorModel: run.executor.model, reviewerModel: run.reviewer.model, imageModel: run.imageIdentity?.model ?? null,
      image: source ? { base64: source.split(",")[1], url: source, name: t("原任务参考图", "Reference from the original task", "Referencia de la tarea original") } : null,
    });
    select(null);
  };
  const review = () => { if (projectId && current) void figureReview(projectId, current.run.id).then(upsert).catch((e) => setError(String(e))); };
  const nextFromImage = async (image: FigureRasterDocument) => {
    if (!projectId || !current || busy || current.active || dirty || submitting.current) return;
    const owner = projectId, id = current.run.id;
    submitting.current = true; setBusy(true); setError(null);
    try {
      const { run } = current;
      if (run.versions.length && image.hash === run.sourceHash) {
        setPanel("canvas"); return;
      }
      const confirmHere = run.status === "image_ready" && !run.imageConfirmed && !run.versions.length
        && !run.requests.some((request) => request.status === "unknown" || request.status === "submitted");
      if (confirmHere) {
        if (image.hash !== run.sourceHash || image.index !== run.sourceRaster) await figureSelectRaster(owner, id, image.index, run.sourceHash!);
        const next = await figureStart(owner, id, image.hash, image.index);
        if (projectRef.current === owner && selectedRef.current === id) { upsert(next); setPanel("canvas"); }
      } else {
        const method = image.editPrompts?.length ? `${run.method}\n\n${t("已确认的 PNG 修改：", "Confirmed PNG edits:", "Cambios de PNG confirmados:")}\n${image.editPrompts.map((prompt, i) => `${i + 1}. ${prompt}`).join("\n")}` : run.method;
        const prepared = await figurePrepare({
          projectId: owner, id: crypto.randomUUID().replace(/-/g, ""), title: titleFromDescription(run.title), method, style: run.style,
          sourceMode: "import", sourceBase64: image.dataUrl.split(",")[1], model: run.executor.model, reviewerModel: run.reviewer.model, imageModel: null,
          confirmedRaster: { id, index: image.index, hash: image.hash },
        });
        if (prepared.run.sourceHash !== image.hash || !prepared.run.sourceRaster) throw new Error(t("图片版本校验失败。", "Image version verification failed.", "No se pudo verificar la versión de la imagen."));
        if (projectRef.current === owner && selectedRef.current === id) { upsert(prepared); select(prepared.run.id, true); }
        const next = await figureStart(owner, prepared.run.id, image.hash, prepared.run.sourceRaster);
        if (projectRef.current === owner) {
          upsert(next);
          if (selectedRef.current === id || selectedRef.current === prepared.run.id) setPanel("canvas");
        }
      }
    } finally { submitting.current = false; setBusy(false); }
  };
  const startPrepared = () => { if (projectId && current) void figureStart(projectId, current.run.id).then(upsert).catch((e) => setError(String(e))); };
  const cancel = () => { if (projectId && current) void figureCancel(projectId, current.run.id).catch((e) => setError(String(e))); };
  const locked = autosave.unsaved || busy || !!current?.active;
  const truncation = current ? truncationInsight(current.run, document.rawOutput) : null;
  const models = effectiveModels(draft, connections);
  const canSubmit = !busy && !!projectId && connectionsReady && !!connections && !!draft.description.trim() && (!!draft.image || (connections.image.available && !!models.image)) && figuresAvailable();
  const compare: [string | null, string][] = [
    [document.sourceDataUrl, t("SVG 参考图", "SVG reference", "Referencia del SVG")],
    [document.previewDataUrl, `${t("本地导出预览", "Local export preview", "Vista previa de exportación local")}${displayedVersion ? ` · v${displayedVersion.index}` : ""}`],
  ];
  const views: [Panel, string, SvgIconName][] = [["image", t("PNG 修改", "PNG edits", "Edición PNG"), "image"], ["canvas", t("画布", "Canvas", "Lienzo"), "edit"], ["compare", t("对照", "Compare", "Comparar"), "grid"], ["source", t("SVG 源码", "SVG source", "Código SVG"), "code"]];

  return <section className={`figure-studio${sidebarOpen ? "" : " sidebar-collapsed"}`} aria-label={t("科研绘图应用", "Scientific figure application", "Aplicación de figuras científicas")}>
    {sidebarOpen && <button type="button" className="figure-sidebar-dismiss" aria-label={t("关闭绘图列表", "Close figure list", "Cerrar la lista de figuras")} onClick={() => setSidebarOpen(false)} />}
    {sidebarOpen && <aside ref={sidebarRef} style={sidebarLayout.style} className="figure-sidebar">
      <button type="button" className="figure-icon-button figure-sidebar-close" aria-label={t("收起绘图列表", "Collapse figure list", "Contraer la lista de figuras")} onClick={() => setSidebarOpen(false)}><SvgIcon name="close" size={14} /></button>
      <button type="button" className="figure-button primary block" onClick={() => select(null)}><SvgIcon name="plus" size={14} />{t("新建绘图", "New figure", "Nueva figura")}</button>
      <div className="figure-group-label">{t("项目绘图", "Project figures", "Figuras del proyecto")} <em>{runs.length}</em></div>
      <div className="figure-run-list">
        {runs.length === 0 && <p className="figure-run-empty">{t("还没有绘图任务。", "No figure tasks yet.", "Aún no hay tareas de figuras.")}</p>}
        {runs.map((entry) => <div key={entry.run.id} className={`figure-run-item${selected === entry.run.id ? " selected" : ""}`}>
          <button type="button" className="figure-run-open" onClick={() => select(entry.run.id)}>
            <i className={`figure-dot tone-${statusTone(entry.run.status)}`} aria-hidden />
            <span><strong>{titleFromDescription(entry.run.title)}</strong><small>{status(entry.run.status)}</small></span>
            <time>{formatTime(entry.run.updatedAt || entry.run.createdAt, true)}</time>
          </button>
          <button type="button" className="figure-run-delete" disabled={entry.active || busy} aria-label={t(`删除 ${titleFromDescription(entry.run.title)}`, `Delete ${titleFromDescription(entry.run.title)}`, `Eliminar ${titleFromDescription(entry.run.title)}`)}
            title={entry.active ? t("任务运行中，取消后才能删除", "Cancel the running task before deleting it", "Cancela la tarea en curso antes de eliminarla") : t("删除绘图", "Delete figure", "Eliminar figura")} onClick={() => void remove(entry)}><SvgIcon name="trash" size={13} /></button>
        </div>)}
      </div>
      <FigureResizeHandle className="edge-end" label={t("调整绘图列表宽度", "Resize figure list", "Cambiar el ancho de la lista de figuras")} panelRef={sidebarRef}
        minWidth={180} reserveWidth={560} onResize={sidebarLayout.resize} onReset={sidebarLayout.reset} />
    </aside>}

    <main className="figure-workspace">
      <header className="figure-topbar">
        <button type="button" className="figure-icon-button" aria-label={sidebarOpen ? t("收起绘图列表", "Hide figure list", "Ocultar la lista de figuras") : t("显示绘图列表", "Show figure list", "Mostrar la lista de figuras")} onClick={() => setSidebarOpen((open) => !open)}><SvgIcon name="panelLeft" size={16} /></button>
        <div className="figure-title">
          <span className="figure-crumb">{project?.name ?? t("未选择项目", "No project", "Sin proyecto")}</span><span className="figure-crumb-sep" aria-hidden>/</span>
          <h1>{current ? titleFromDescription(current.run.title) : t("新建绘图", "New figure", "Nueva figura")}</h1>
        </div>
        {current && <div className="figure-actions">
          <div className="figure-segmented" role="group" aria-label={t("视图", "View", "Vista")}>
            {views.map(([item, label, icon]) => <button type="button" key={item} className={panel === item ? "selected" : ""} onClick={() => void switchPanel(item)}><SvgIcon name={icon} size={13} />{label}</button>)}
          </div>
          {panel !== "image" && <span className="figure-divider" />}
          {panel !== "image" && <button type="button" className={`figure-button${showSvgChat ? " active" : ""}`} aria-pressed={showSvgChat} onClick={() => { setShowSvgChat((open) => !open); setShowArtifacts(false); }}><SvgIcon name="messageCircle" size={14} />{t("对话修改", "Edit with chat", "Editar con chat")}</button>}
          {current.active && (panel !== "image" || !current.run.sourceHash) && <button type="button" className="figure-button" onClick={cancel}><SvgIcon name="stop" size={13} />{t("取消任务", "Cancel task", "Cancelar tarea")}</button>}
          {panel !== "image" && <><select aria-label={t("版本", "Version", "Versión")} value={versionIndex ?? "latest"} disabled={locked} onChange={(e) => chooseVersion(e.target.value === "latest" ? null : Number(e.target.value))}><option value="latest">{dirty ? t("当前草稿", "Current draft", "Borrador actual") : t("当前版本", "Current version", "Versión actual")}</option>{current.run.versions.map((v) => <option key={v.index} value={v.index}>v{v.index} · {v.author}</option>)}</select>
          {dirty && <span className="figure-draft-status" role="status">{autosave.status === "saved" ? t("草稿已自动保存", "Draft autosaved", "Borrador guardado automáticamente") : autosave.status === "error" ? t("草稿保存失败", "Draft save failed", "No se pudo guardar el borrador") : t("正在保存草稿…", "Saving draft…", "Guardando borrador…")}</span>}
          {dirty && <button type="button" className="figure-button ghost" disabled={busy} onClick={() => void discard().catch((e) => setError(String(e)))}>{t("放弃编辑", "Discard edits", "Descartar cambios")}</button>}
          <button type="button" className={`figure-button${dirty ? " primary" : ""}`} disabled={!dirty || busy || current.active} onClick={() => void save()}>{t("保存新版本", "Save version", "Guardar versión")}{dirty ? " •" : ""}</button>
          <button type="button" className="figure-button" disabled={!version || versionIndex !== null || dirty || busy || current.active || current.run.status === "unknown"} onClick={review}><SvgIcon name="shieldCheck" size={13} />{t("审查", "Review", "Revisar")}</button>
          <ExportMenu disabled={!version || dirty || busy || current.active} t={t} onExport={(format) => void exportFile(format)} /></>}
          {panel !== "image" && <span className="figure-divider" />}
          {panel !== "image" && <button type="button" className={`figure-icon-button${showArtifacts ? " active" : ""}`} aria-pressed={showArtifacts} aria-label={t("产物与审查", "Artifacts and review", "Resultados y revisión")} title={t("产物与审查", "Artifacts and review", "Resultados y revisión")} onClick={() => { setShowArtifacts((v) => !v); setShowSvgChat(false); }}><SvgIcon name="panelRight" size={15} /></button>}
        </div>}
      </header>
      <FlowStepper run={current?.run ?? null} active={!!current?.active} language={language} t={t} status={current && <StatusChip status={current.run.status} language={language} />} />
      {error && <div className="figure-alert" role="alert"><SvgIcon name="warning" size={14} /><span>{error}</span><button type="button" className="figure-icon-button" aria-label={t("关闭错误", "Dismiss error", "Cerrar el error")} onClick={() => setError(null)}><SvgIcon name="close" size={12} /></button></div>}
      {!figuresAvailable() && <div className="figure-banner">{t("请在 SomniQ 桌面应用中使用此模块。当前浏览器未连接模型与项目服务。", "Open this module in SomniQ Desktop. This browser has no model or project service connection.", "Abre este módulo en SomniQ Desktop. Este navegador no está conectado a los servicios de modelos ni de proyectos.")}</div>}

      {!current ? <FigureComposer t={t} language={language} draft={draft} onDraft={(patch) => setDraft((d) => ({ ...d, ...patch }))} connections={connections} options={options}
        busy={busy} canSubmit={canSubmit} onUpload={(file) => void upload(file)} onSubmit={() => void create()} onOpenSettings={() => useStore.getState().setTab("settings")} />
        : <div className="figure-stage">
          <div className={`figure-shell view-${document.svg || panel !== "canvas" ? panel : "pending"}`}>
            <div className="figure-canvas-pane" hidden={panel !== "canvas"}>
              {document.svg ? <FigureEditor key={`${projectId}:${selected}`} ref={editor} svg={document.svg} readOnly={busy || current.active} onDirty={() => edited("canvas")} onError={setError} />
                : <div className="figure-pending">
                  {document.sourceDataUrl && <img className="figure-pending-reference" src={document.sourceDataUrl} alt="" aria-hidden />}
                  <div className="figure-pending-card">
                    {current.active ? <span className="figure-spin large" aria-hidden /> : <SvgIcon name={current.run.status === "ready" ? "play" : "info"} size={22} />}
                    <strong>{status(current.run.status)}</strong>
                    {(current.active || current.run.status === "ready") && <p>{t("SVG 完成后会在这里打开可编辑画布。", "The editable canvas opens here when the SVG is ready.", "El lienzo editable se abrirá aquí cuando el SVG esté listo.")}</p>}
                    <PipelineList run={current.run} language={language} t={t} />
                    {truncation ? <div className="figure-truncation">
                      <p>{t(`模型输出了 ${formatTokens(truncation.outputTokens)} token 后达到上限，但保存下来的 SVG 只有 ${truncation.visibleChars.toLocaleString("en-US")} 个字符（估计约 ${formatTokens(truncation.visibleTokens)} token）。`,
                        `The model stopped at its output limit after ${formatTokens(truncation.outputTokens)} tokens, but only ${truncation.visibleChars.toLocaleString("en-US")} characters of SVG were saved (an estimated ${formatTokens(truncation.visibleTokens)} tokens).`, `El modelo alcanzó su límite de salida tras ${formatTokens(truncation.outputTokens)} tokens, pero solo se guardaron ${truncation.visibleChars.toLocaleString("en-US")} caracteres de SVG (unos ${formatTokens(truncation.visibleTokens)} tokens estimados).`)}</p>
                      {truncation.reasoningHeavy && <p>{t(`这可能与 ${current.run.executor.model} 的隐藏推理有关；字符数估算不能确认实际推理用量。`, `This may be due to ${current.run.executor.model}'s hidden reasoning; character-based estimates cannot confirm actual reasoning usage.`, `Puede deberse al razonamiento oculto de ${current.run.executor.model}; las estimaciones por caracteres no pueden confirmar su uso de tokens.`)}</p>}
                      <p>{t("新任务的输出上限与 Chat 相同，不需要设置。建议换一个推理更少的 Executor，或简化描述后再试。", "New tasks use the same output limit as Chat; there is nothing to set. Try an Executor that reasons less, or a simpler description.", "Las tareas nuevas usan el mismo límite de salida que Chat; no hay nada que configurar. Prueba un Executor que razone menos o una descripción más sencilla.")}</p>
                    </div> : current.run.error && <p className="figure-pending-error">{current.run.error}</p>}
                    <div className="figure-pending-actions">
                      {truncation && <button type="button" className="figure-button primary" title={t("预填新任务并复用参考图，不会重新生图；可先换 Executor，确认后再提交", "Prefills a new task that reuses the reference image without regenerating it; you can change the Executor before you submit", "Prepara una tarea nueva que reutiliza la imagen de referencia, sin volver a generarla; puedes cambiar el Executor antes de enviarla")} onClick={duplicate}><SvgIcon name="refresh" size={13} />{t("换个 Executor 新建 · 复用参考图", "New task with another Executor · reuse image", "Nueva tarea con otro Executor · reutilizar imagen")}</button>}
                      {document.rawOutput && <button type="button" className="figure-button" onClick={() => setPanel("source")}><SvgIcon name="code" size={13} />{t("查看并手动修复原始输出", "Inspect and repair raw output", "Revisar y corregir la salida sin procesar")}</button>}
                      {current.run.status === "ready" && <button type="button" className="figure-button primary" onClick={startPrepared}><SvgIcon name="play" size={13} />{t("启动已准备的任务", "Start prepared task", "Iniciar la tarea preparada")}</button>}
                      {current.active && <button type="button" className="figure-button" onClick={cancel}><SvgIcon name="stop" size={13} />{t("取消任务", "Cancel task", "Cancelar tarea")}</button>}
                    </div>
                  </div>
                </div>}
            </div>
            {panel === "image" && (current.run.sourceHash ? <FigureRasterEditor key={`${projectId}:${selected}`} view={current} t={t} available={!!connections?.image.available} locked={dirty || busy}
              onUpdate={(next) => { if (next.projectId === projectRef.current) upsert(next); }} onError={(message) => { if (current.projectId === projectRef.current) setError(message); }} onNext={nextFromImage} onCancel={cancel} /> : <div className="figure-compare-empty">{t("图片生成后可在此圈选修改。", "Once the image is generated, select a region here to edit it.", "Cuando se genere la imagen, podrás seleccionar aquí una zona para editarla.")}</div>)}
            {panel === "compare" && <div className="figure-compare">
              {compare.map(([src, label], index) => <Fragment key={label}><figure ref={index === 0 ? comparisonRef : undefined} style={index === 0 ? comparisonLayout.style : undefined}>
                <figcaption>{label}</figcaption>
                {src ? <button type="button" onClick={() => setLightbox({ src, title: label })}><img src={src} alt={label} /></button> : <div className="figure-compare-empty"><SvgIcon name="image" size={20} />{t("尚无图片", "No image yet", "Aún no hay imagen")}</div>}
              </figure>{index === 0 && <FigureResizeHandle label={t("调整对照图片宽度", "Resize comparison images", "Cambiar el ancho de las imágenes comparadas")} panelRef={comparisonRef}
                minWidth={200} reserveWidth={260} onResize={comparisonLayout.resize} onReset={comparisonLayout.reset} />}</Fragment>)}
            </div>}
            {panel === "source" && <FigureSourceEditor key={`${projectId}:${selected}`} value={source} readOnly={busy || current.active} onChange={(svg) => { setSource(svg); edited("source"); }} />}
            {versionIndex !== null && <div className="figure-history-banner"><SvgIcon name="clock" size={13} />{t(`正在查看历史版本 v${versionIndex}，修改后会保存为新版本`, `Viewing v${versionIndex}; saving creates a new version`, `Viendo v${versionIndex}; al guardar se crea una versión nueva`)}<button type="button" disabled={dirty} onClick={() => setVersionIndex(null)}>{t("返回当前版本", "Back to current", "Volver a la actual")}</button></div>}
            {showLedger ? <LedgerCard run={current.run} language={language} t={t} onClose={() => setShowLedger(false)} />
              : <LedgerPill run={current.run} active={current.active} t={t} onOpen={() => setShowLedger(true)} />}
          </div>
          {showArtifacts && <ArtifactsCard run={current.run} document={document} language={language} t={t} displayed={displayedVersion} versionIndex={versionIndex} locked={locked}
            onVersion={chooseVersion} onPreview={setLightbox} onClose={() => setShowArtifacts(false)} onDuplicate={duplicate} />}
          {showSvgChat && panel !== "image" && <FigureSvgChat key={`${projectId}:${selected}`} view={current} dirty={dirty} busy={busy} historical={versionIndex !== null} t={t}
            onUpdate={(next) => { if (next.projectId === projectRef.current) upsert(next); }} onError={setError} onBusy={setBusy} onCancel={cancel}
            onClose={() => setShowSvgChat(false)} onVersion={(index) => { setVersionIndex(index); setPanel("canvas"); }} />}
        </div>}
    </main>
    {lightbox && <ImageLightbox src={lightbox.src} title={lightbox.title} alt={lightbox.title} onClose={() => setLightbox(null)} />}
  </section>;
}
