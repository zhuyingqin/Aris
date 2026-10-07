import { useEffect, useRef, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { isTauri } from "../api/tauri";
import ImageLightbox from "../ImageLightbox";
import { useStore } from "../store";
import { SvgIcon, type SvgIconName } from "../SvgIcon";
import FigureComposer, { EMPTY_DRAFT, effectiveModels, type FigureDraft, type FigureModelOptions } from "./FigureComposer";
import FigureEditor, { type FigureEditorHandle } from "./FigureEditor";
import FigureRasterEditor from "./FigureRasterEditor";
import FigureSvgChat from "./FigureSvgChat";
import FigureSourceEditor from "./FigureSourceEditor";
import { ArtifactsCard, ExportMenu, FlowStepper, LedgerCard, LedgerPill, PipelineList, StatusChip } from "./FigurePanels";
import { figureCancel, figureConnections, figureDelete, figureDocument, figureExport, figureList, figurePrepare, figureReview, figureSave, figureSelectRaster, figureStart, figuresAvailable, onFigureUpdated } from "./figureApi";
import { formatTime, formatTokens, statusLabel, statusTone, titleFromDescription, truncationInsight } from "./figureModel";
import type { FigureConnections, FigureDocument, FigureRasterDocument, FigureView } from "./types";
import "./figures.css";

const EMPTY: FigureDocument = { svg: null, sourceDataUrl: null, previewDataUrl: null };
type Panel = "canvas" | "compare" | "source" | "image";

export default function FigureStudio({ visible = true }: { visible?: boolean }) {
  const project = useStore((s) => s.currentProject);
  const language = useStore((s) => s.language);
  const t = (cn: string, en: string) => language === "cn" ? cn : en;
  const projectId = project?.id ?? null;
  const [runs, setRuns] = useState<FigureView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [connections, setConnections] = useState<FigureConnections | null>(null);
  // Last successfully resolved choices; kept while a new selection resolves or fails.
  const [options, setOptions] = useState<FigureModelOptions>({ executor: [], reviewer: [], image: [] });
  const [document, setDocument] = useState<FigureDocument>(EMPTY);
  const [source, setSource] = useState("");
  const [dirty, setDirty] = useState(false);
  const [editOrigin, setEditOrigin] = useState<"canvas" | "source" | null>(null);
  useEffect(() => { useStore.getState().setFigureDirty(dirty); return () => useStore.getState().setFigureDirty(false); }, [dirty]);
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
    setConnections(null);
    void figureConnections(executorModel, reviewerModel).then((next) => {
      if (disposed) return;
      setConnections(next); setError(null);
      setOptions({ executor: next.executorModels ?? [next.executor.model], reviewer: next.reviewerModels ?? [next.reviewer.model], image: next.image.models });
    }).catch((e) => { if (!disposed) setError(String(e)); });
    return () => { disposed = true; };
  }, [visible, projectId, executorModel, reviewerModel]);

  useEffect(() => {
    let disposed = false; let unlisten: (() => void) | null = null;
    setSelected(null); setRuns([]); setDocument(EMPTY); setSource(""); setDirty(false); setError(null); setConnections(null);
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
      setDocument(doc); setSource(doc.svg ?? doc.rawOutput ?? "");
    }).catch((e) => { if (!disposed) setError(String(e)); });
    return () => { disposed = true; };
  }, [projectId, selected, version?.hash, version?.index, current?.run.sourceHash, versionIndex]);

  useEffect(() => {
    if (isTauri()) return;
    const guard = (event: BeforeUnloadEvent) => { if (dirtyRef.current) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", guard); return () => window.removeEventListener("beforeunload", guard);
  }, []);

  const select = (id: string | null) => {
    if (dirty) { setError(t("请先保存版本或放弃当前编辑。", "Save this version or discard edits first.")); return; }
    setSelected(id); setVersionIndex(null); setDocument(EMPTY); setSource(""); setEditOrigin(null); setError(null); setPanel("canvas");
    if (window.innerWidth <= 760) setSidebarOpen(false);
  };
  const upload = async (file?: File) => {
    if (!file) return;
    try {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) throw new Error(t("请选择 10 MB 以内的 PNG、JPEG 或 WebP。", "Choose a PNG, JPEG or WebP under 10 MB."));
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
        projectId: owner, id: crypto.randomUUID().replace(/-/g, ""), title: titleFromDescription(draft.description) || t("科研绘图", "Scientific figure"),
        method: draft.description.trim(), style: draft.style, sourceMode: generate ? "generate" : "import", sourceBase64: draft.image?.base64 ?? null,
        model: connections?.executor.model ?? null, reviewerModel: connections?.reviewer.model ?? null, imageModel: generate ? models.image || null : null,
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
      const svg = editOrigin === "source" ? source : await editor.current?.serialize();
      if (!svg) throw new Error(t("请打开画布或 SVG 源码后保存。", "Open the canvas or SVG source before saving."));
      const next = await figureSave(owner, id, version?.hash ?? null, svg, displayedVersion?.index ?? null);
      if (projectRef.current === owner && selectedRef.current === id) {
        setDirty(false); dirtyRef.current = false; setEditOrigin(null); setVersionIndex(null); upsert(next);
        const doc = await figureDocument(owner, id);
        if (projectRef.current === owner && selectedRef.current === id) { setDocument(doc); setSource(doc.svg ?? ""); }
      }
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const discard = async () => {
    setDirty(false); dirtyRef.current = false; setEditOrigin(null);
    if (projectId && selected) { const doc = await figureDocument(projectId, selected); setDocument(doc); setSource(doc.svg ?? ""); }
    setError(null);
  };
  const exportFile = async (format: string) => {
    if (!projectId || !current) return;
    if (dirty) { setError(t("保存当前版本后再导出。", "Save the current version before exporting.")); return; }
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
    if (dirty && panel === "canvas") {
      try { const svg = await editor.current?.serialize(); if (svg) setSource(svg); } catch (e) { setError(String(e)); return; }
    }
    if (dirty && editOrigin === "source" && next === "canvas") { setError(t("保存 SVG 源码后即可在画布中继续编辑。", "Save SVG source to continue in the canvas.")); return; }
    setPanel(next);
  };
  const remove = async (entry: FigureView) => {
    if (!projectId || entry.active) return;
    const id = entry.run.id; const unsaved = id === selected && dirty; const title = titleFromDescription(entry.run.title);
    const message = t(`删除「${title}」？\n该绘图的全部 SVG / PNG 版本、圈选记录和运行记录将从项目中移除，无法恢复。${unsaved ? "\n未保存的编辑也会丢失。" : ""}`,
      `Delete "${title}"?\nAll SVG/PNG versions, selections and the run log are removed from the project. This cannot be undone.${unsaved ? "\nUnsaved edits are lost too." : ""}`);
    if (!window.confirm(message)) return;
    const owner = projectId;
    try {
      await figureDelete(owner, id);
      deleted.current.add(id);
      if (projectRef.current !== owner) return;
      setRuns((all) => all.filter((item) => item.run.id !== id));
      if (selectedRef.current === id) {
        setDirty(false); dirtyRef.current = false; setEditOrigin(null);
        setSelected(null); setVersionIndex(null); setDocument(EMPTY); setSource(""); setPanel("canvas");
      }
    } catch (e) { setError(String(e)); }
  };
  /** Prefills a new task from this one, reusing its reference image. */
  const duplicate = () => {
    if (!current) return;
    const { run } = current;
    if (dirty) { setError(t("请先保存版本或放弃当前编辑。", "Save this version or discard edits first.")); return; }
    const source = document.sourceDataUrl;
    setDraft({
      description: run.method, style: run.style,
      executorModel: run.executor.model, reviewerModel: run.reviewer.model, imageModel: run.imageIdentity?.model ?? null,
      image: source ? { base64: source.split(",")[1], url: source, name: t("原任务参考图", "Reference from the original task") } : null,
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
        const method = image.editPrompts?.length ? `${run.method}\n\n${t("已确认的 PNG 修改：", "Confirmed PNG edits:")}\n${image.editPrompts.map((prompt, i) => `${i + 1}. ${prompt}`).join("\n")}` : run.method;
        const prepared = await figurePrepare({
          projectId: owner, id: crypto.randomUUID().replace(/-/g, ""), title: titleFromDescription(run.title), method, style: run.style,
          sourceMode: "import", sourceBase64: image.dataUrl.split(",")[1], model: run.executor.model, reviewerModel: run.reviewer.model, imageModel: null,
          confirmedRaster: { id, index: image.index, hash: image.hash },
        });
        if (prepared.run.sourceHash !== image.hash || !prepared.run.sourceRaster) throw new Error(t("图片版本校验失败。", "Image version verification failed."));
        if (projectRef.current === owner && selectedRef.current === id) { upsert(prepared); select(prepared.run.id); }
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
  const locked = dirty || busy || !!current?.active;
  const truncation = current ? truncationInsight(current.run, document.rawOutput) : null;
  const models = effectiveModels(draft, connections);
  const canSubmit = !busy && !!projectId && !!connections && !!draft.description.trim() && (!!draft.image || (connections.image.available && !!models.image)) && figuresAvailable();
  const compare: [string | null, string][] = [
    [document.sourceDataUrl, t("SVG 参考图", "SVG reference")],
    [document.previewDataUrl, `${t("本地导出预览", "Local export preview")}${displayedVersion ? ` · v${displayedVersion.index}` : ""}`],
  ];
  const views: [Panel, string, SvgIconName][] = [["image", t("PNG 修改", "PNG edits"), "image"], ["canvas", t("画布", "Canvas"), "edit"], ["compare", t("对照", "Compare"), "grid"], ["source", t("SVG 源码", "SVG source"), "code"]];

  return <section className={`figure-studio${sidebarOpen ? "" : " sidebar-collapsed"}`} aria-label={t("科研绘图应用", "Scientific figure application")}>
    {sidebarOpen && <button type="button" className="figure-sidebar-dismiss" aria-label={t("关闭绘图列表", "Close figure list")} onClick={() => setSidebarOpen(false)} />}
    {sidebarOpen && <aside className="figure-sidebar">
      <button type="button" className="figure-icon-button figure-sidebar-close" aria-label={t("收起绘图列表", "Collapse figure list")} onClick={() => setSidebarOpen(false)}><SvgIcon name="close" size={14} /></button>
      <button type="button" className="figure-button primary block" onClick={() => select(null)}><SvgIcon name="plus" size={14} />{t("新建绘图", "New figure")}</button>
      <div className="figure-group-label">{t("项目绘图", "Project figures")} <em>{runs.length}</em></div>
      <div className="figure-run-list">
        {runs.length === 0 && <p className="figure-run-empty">{t("还没有绘图任务。", "No figure tasks yet.")}</p>}
        {runs.map((entry) => <div key={entry.run.id} className={`figure-run-item${selected === entry.run.id ? " selected" : ""}`}>
          <button type="button" className="figure-run-open" onClick={() => select(entry.run.id)}>
            <i className={`figure-dot tone-${statusTone(entry.run.status)}`} aria-hidden />
            <span><strong>{titleFromDescription(entry.run.title)}</strong><small>{status(entry.run.status)}</small></span>
            <time>{formatTime(entry.run.updatedAt || entry.run.createdAt, true)}</time>
          </button>
          <button type="button" className="figure-run-delete" disabled={entry.active} aria-label={t(`删除 ${titleFromDescription(entry.run.title)}`, `Delete ${titleFromDescription(entry.run.title)}`)}
            title={entry.active ? t("任务运行中，取消后才能删除", "Cancel the running task before deleting it") : t("删除绘图", "Delete figure")} onClick={() => void remove(entry)}><SvgIcon name="trash" size={13} /></button>
        </div>)}
      </div>
    </aside>}

    <main className="figure-workspace">
      <header className="figure-topbar">
        <button type="button" className="figure-icon-button" aria-label={sidebarOpen ? t("收起绘图列表", "Hide figure list") : t("显示绘图列表", "Show figure list")} onClick={() => setSidebarOpen((open) => !open)}><SvgIcon name="panelLeft" size={16} /></button>
        <div className="figure-title">
          <span className="figure-crumb">{project?.name ?? t("未选择项目", "No project")}</span><span className="figure-crumb-sep" aria-hidden>/</span>
          <h1>{current ? titleFromDescription(current.run.title) : t("新建绘图", "New figure")}</h1>
        </div>
        {current && <div className="figure-actions">
          <div className="figure-segmented" role="group" aria-label={t("视图", "View")}>
            {views.map(([item, label, icon]) => <button type="button" key={item} className={panel === item ? "selected" : ""} onClick={() => void switchPanel(item)}><SvgIcon name={icon} size={13} />{label}</button>)}
          </div>
          {panel !== "image" && <span className="figure-divider" />}
          {panel !== "image" && <button type="button" className={`figure-button${showSvgChat ? " active" : ""}`} aria-pressed={showSvgChat} onClick={() => { setShowSvgChat((open) => !open); setShowArtifacts(false); }}><SvgIcon name="messageCircle" size={14} />{t("对话修改", "Edit with chat")}</button>}
          {current.active && (panel !== "image" || !current.run.sourceHash) && <button type="button" className="figure-button" onClick={cancel}><SvgIcon name="stop" size={13} />{t("取消任务", "Cancel task")}</button>}
          {panel !== "image" && <><select aria-label={t("版本", "Version")} value={versionIndex ?? "latest"} disabled={locked} onChange={(e) => setVersionIndex(e.target.value === "latest" ? null : Number(e.target.value))}><option value="latest">{t("当前版本", "Current version")}</option>{current.run.versions.map((v) => <option key={v.index} value={v.index}>v{v.index} · {v.author}</option>)}</select>
          {dirty && <button type="button" className="figure-button ghost" disabled={busy} onClick={() => void discard().catch((e) => setError(String(e)))}>{t("放弃编辑", "Discard edits")}</button>}
          <button type="button" className={`figure-button${dirty ? " primary" : ""}`} disabled={!dirty || busy || current.active} onClick={() => void save()}>{t("保存新版本", "Save version")}{dirty ? " •" : ""}</button>
          <button type="button" className="figure-button" title={t("提交一次独立 Reviewer 调用", "Sends one independent Reviewer call")} disabled={!version || versionIndex !== null || dirty || busy || current.active || current.run.status === "unknown"} onClick={review}><SvgIcon name="shieldCheck" size={13} />{t("审查", "Review")}<em className="figure-cost">{t("1 次调用", "1 call")}</em></button>
          <ExportMenu disabled={!version || dirty || busy || current.active} t={t} onExport={(format) => void exportFile(format)} /></>}
          {panel !== "image" && <span className="figure-divider" />}
          {panel !== "image" && <button type="button" className={`figure-icon-button${showArtifacts ? " active" : ""}`} aria-pressed={showArtifacts} aria-label={t("产物与审查", "Artifacts and review")} title={t("产物与审查", "Artifacts and review")} onClick={() => { setShowArtifacts((v) => !v); setShowSvgChat(false); }}><SvgIcon name="panelRight" size={15} /></button>}
        </div>}
      </header>
      <FlowStepper run={current?.run ?? null} active={!!current?.active} language={language} t={t} status={current && <StatusChip status={current.run.status} language={language} />} />
      {error && <div className="figure-alert" role="alert"><SvgIcon name="warning" size={14} /><span>{error}</span><button type="button" className="figure-icon-button" aria-label={t("关闭错误", "Dismiss error")} onClick={() => setError(null)}><SvgIcon name="close" size={12} /></button></div>}
      {!figuresAvailable() && <div className="figure-banner">{t("请在 SomniQ 桌面应用中使用此模块。当前浏览器未连接模型与项目服务。", "Open this module in SomniQ Desktop. This browser has no model or project service connection.")}</div>}

      {!current ? <FigureComposer t={t} language={language} draft={draft} onDraft={(patch) => setDraft((d) => ({ ...d, ...patch }))} connections={connections} options={options}
        busy={busy} canSubmit={canSubmit} onUpload={(file) => void upload(file)} onSubmit={() => void create()} onOpenSettings={() => useStore.getState().setTab("settings")} />
        : <div className="figure-stage">
          <div className={`figure-shell view-${document.svg || panel !== "canvas" ? panel : "pending"}`}>
            <div className="figure-canvas-pane" hidden={panel !== "canvas"}>
              {document.svg ? <FigureEditor key={`${projectId}:${selected}`} ref={editor} svg={document.svg} readOnly={busy || current.active} onDirty={() => { setDirty(true); setEditOrigin("canvas"); }} onError={setError} />
                : <div className="figure-pending">
                  {document.sourceDataUrl && <img className="figure-pending-reference" src={document.sourceDataUrl} alt="" aria-hidden />}
                  <div className="figure-pending-card">
                    {current.active ? <span className="figure-spin large" aria-hidden /> : <SvgIcon name={current.run.status === "ready" ? "play" : "info"} size={22} />}
                    <strong>{status(current.run.status)}</strong>
                    {(current.active || current.run.status === "ready") && <p>{t("SVG 完成后会在这里打开可编辑画布。", "The editable canvas opens here when the SVG is ready.")}</p>}
                    <PipelineList run={current.run} language={language} t={t} />
                    {truncation ? <div className="figure-truncation">
                      <p>{t(`模型输出了 ${formatTokens(truncation.outputTokens)} token 后达到上限，但保存下来的 SVG 只有 ${truncation.visibleChars.toLocaleString("en-US")} 个字符（估计约 ${formatTokens(truncation.visibleTokens)} token）。`,
                        `The model stopped at its output limit after ${formatTokens(truncation.outputTokens)} tokens, but only ${truncation.visibleChars.toLocaleString("en-US")} characters of SVG were saved (an estimated ${formatTokens(truncation.visibleTokens)} tokens).`)}</p>
                      {truncation.reasoningHeavy && <p>{t(`这可能与 ${current.run.executor.model} 的隐藏推理有关；字符数估算不能确认实际推理用量。`, `This may involve ${current.run.executor.model}'s hidden reasoning; character estimates cannot confirm its token usage.`)}</p>}
                      <p>{t("新任务的输出上限与 Chat 相同，不需要设置。建议换一个推理更少的 Executor，或简化描述后再试。", "New tasks use the same output limit as Chat; there is nothing to set. Try an Executor that reasons less, or a simpler description.")}</p>
                    </div> : current.run.error && <p className="figure-pending-error">{current.run.error}</p>}
                    <div className="figure-pending-actions">
                      {truncation && <button type="button" className="figure-button primary" title={t("预填新任务并复用参考图，不会重新生图；可先换 Executor，确认后再提交", "Prefills a new task that reuses the reference image, so nothing is regenerated; change the Executor, then submit it yourself")} onClick={duplicate}><SvgIcon name="refresh" size={13} />{t("换个 Executor 新建 · 复用参考图", "New task with another Executor · reuse image")}</button>}
                      {document.rawOutput && <button type="button" className="figure-button" onClick={() => setPanel("source")}><SvgIcon name="code" size={13} />{t("查看并手动修复原始输出", "Inspect and repair raw output")}</button>}
                      {current.run.status === "ready" && <button type="button" className="figure-button primary" onClick={startPrepared}><SvgIcon name="play" size={13} />{t("启动已准备的任务", "Start prepared task")}</button>}
                      {current.active && <button type="button" className="figure-button" onClick={cancel}><SvgIcon name="stop" size={13} />{t("取消任务", "Cancel task")}</button>}
                    </div>
                  </div>
                </div>}
            </div>
            {panel === "image" && (current.run.sourceHash ? <FigureRasterEditor key={`${projectId}:${selected}`} view={current} t={t} available={!!connections?.image.available} locked={dirty || busy}
              onUpdate={(next) => { if (next.projectId === projectRef.current) upsert(next); }} onError={(message) => { if (current.projectId === projectRef.current) setError(message); }} onNext={nextFromImage} onCancel={cancel} /> : <div className="figure-compare-empty">{t("图片生成后可在此圈选修改。", "Select a region here once the image is ready.")}</div>)}
            {panel === "compare" && <div className="figure-compare">
              {compare.map(([src, label]) => <figure key={label}>
                <figcaption>{label}</figcaption>
                {src ? <button type="button" onClick={() => setLightbox({ src, title: label })}><img src={src} alt={label} /></button> : <div className="figure-compare-empty"><SvgIcon name="image" size={20} />{t("尚无图片", "No image yet")}</div>}
              </figure>)}
            </div>}
            {panel === "source" && <FigureSourceEditor key={`${projectId}:${selected}`} value={source} readOnly={busy || current.active} onChange={(svg) => { setSource(svg); setDirty(true); setEditOrigin("source"); }} />}
            {versionIndex !== null && <div className="figure-history-banner"><SvgIcon name="clock" size={13} />{t(`正在查看历史版本 v${versionIndex}，修改后会保存为新版本`, `Viewing v${versionIndex}; saving creates a new version`)}<button type="button" disabled={dirty} onClick={() => setVersionIndex(null)}>{t("返回当前版本", "Back to current")}</button></div>}
            {showLedger ? <LedgerCard run={current.run} language={language} t={t} onClose={() => setShowLedger(false)} />
              : <LedgerPill run={current.run} active={current.active} t={t} onOpen={() => setShowLedger(true)} />}
          </div>
          {showArtifacts && <ArtifactsCard run={current.run} document={document} language={language} t={t} displayed={displayedVersion} versionIndex={versionIndex} locked={locked}
            onVersion={setVersionIndex} onPreview={setLightbox} onClose={() => setShowArtifacts(false)} onDuplicate={duplicate} />}
          {showSvgChat && panel !== "image" && <FigureSvgChat key={`${projectId}:${selected}`} view={current} dirty={dirty} busy={busy} historical={versionIndex !== null} t={t}
            onUpdate={(next) => { if (next.projectId === projectRef.current) upsert(next); }} onError={setError} onBusy={setBusy} onCancel={cancel}
            onClose={() => setShowSvgChat(false)} onVersion={(index) => { setVersionIndex(index); setPanel("canvas"); }} />}
        </div>}
    </main>
    {lightbox && <ImageLightbox src={lightbox.src} title={lightbox.title} alt={lightbox.title} onClose={() => setLightbox(null)} />}
  </section>;
}
