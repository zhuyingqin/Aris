import { useEffect, useRef, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { isTauri } from "../api/tauri";
import { useStore } from "../store";
import FigureEditor, { type FigureEditorHandle } from "./FigureEditor";
import { figureCancel, figureConnections, figureDocument, figureExport, figureList, figurePrepare, figureReview, figureSave, figureStart, figuresAvailable, onFigureUpdated } from "./figureApi";
import type { FigureConnections, FigureDocument, FigureView } from "./types";
import "./figures.css";

const EMPTY: FigureDocument = { svg: null, sourceDataUrl: null, previewDataUrl: null };
const STATUS: Record<string, [string, string]> = {
  ready: ["待启动", "Ready"], probing: ["检查视觉能力", "Checking vision"], generating: ["生成参考图", "Generating image"],
  reconstructing: ["重建 SVG", "Reconstructing SVG"], reviewing: ["独立审查", "Independent review"], revising: ["修订 SVG", "Revising SVG"],
  accepted: ["结构与视觉通过", "Structure and visual passed"], visual_pending: ["结构通过 · 视觉待检查", "Structure passed · visual pending"],
  draft: ["草稿 · 待检查", "Draft · check needed"], unknown: ["请求结果不明", "Request result unknown"], cancelled: ["已取消", "Cancelled"],
  needs_vision_executor: ["需配置视觉 Executor", "Vision Executor required"], budget_truncated: ["输出额度截断", "Output budget truncated"],
};

export default function FigureStudio({ visible = true }: { visible?: boolean }) {
  const project = useStore((s) => s.currentProject);
  const language = useStore((s) => s.language);
  const t = (cn: string, en: string) => language === "cn" ? cn : en;
  const projectId = project?.id ?? null;
  const [runs, setRuns] = useState<FigureView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [connections, setConnections] = useState<FigureConnections | null>(null);
  const [executorModel, setExecutorModel] = useState<string | null>(null);
  const [executorModels, setExecutorModels] = useState<string[]>([]);
  const [document, setDocument] = useState<FigureDocument>(EMPTY);
  const [source, setSource] = useState("");
  const [dirty, setDirty] = useState(false);
  const [editOrigin, setEditOrigin] = useState<"canvas" | "source" | null>(null);
  useEffect(() => { useStore.getState().setFigureDirty(dirty); return () => useStore.getState().setFigureDirty(false); }, [dirty]);
  const [panel, setPanel] = useState<"canvas" | "source" | "evidence">("canvas");
  const [title, setTitle] = useState("");
  const [method, setMethod] = useState("");
  const [style, setStyle] = useState("Clean academic diagram, flat vectors, readable labels, restrained colors");
  const [sourceMode, setSourceMode] = useState<"import" | "generate">("import");
  const [image, setImage] = useState<{ base64: string; url: string; name: string } | null>(null);
  const [outputLimit, setOutputLimit] = useState(16384);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [versionIndex, setVersionIndex] = useState<number | null>(null);
  const editor = useRef<FigureEditorHandle>(null);
  const submitting = useRef(false);
  const projectRef = useRef(projectId); projectRef.current = projectId;
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const current = runs.find((entry) => entry.run.id === selected) ?? null;
  const version = current?.run.versions.at(-1);
  const displayedVersion = versionIndex === null ? version : current?.run.versions.find((v) => v.index === versionIndex);
  const status = (value: string) => STATUS[value]?.[language === "cn" ? 0 : 1] ?? value;
  const upsert = (next: FigureView) => setRuns((all) => [next, ...all.filter((entry) => entry.run.id !== next.run.id)]);

  useEffect(() => {
    if (!visible || !projectId || !figuresAvailable()) return;
    let disposed = false;
    setConnections(null);
    void figureConnections(executorModel).then((next) => { if (!disposed) { setConnections(next); setExecutorModels(next.executorModels ?? [next.executor.model]); setError(null); } }).catch((e) => { if (!disposed) setError(String(e)); });
    return () => { disposed = true; };
  }, [visible, projectId, executorModel]);

  useEffect(() => {
    let disposed = false; let unlisten: (() => void) | null = null;
    setSelected(null); setRuns([]); setDocument(EMPTY); setSource(""); setDirty(false); setError(null); setConnections(null);
    if (!projectId || !figuresAvailable()) return;
    void figureList(projectId).then((all) => { if (!disposed) setRuns(all); }).catch((e) => { if (!disposed) setError(String(e)); });
    void onFigureUpdated((next) => { if (!disposed && next.projectId === projectId) upsert(next); }).then((fn) => { if (disposed) fn(); else unlisten = fn; }).catch(() => undefined);
    // Reconcile missed events and process restarts. Listing never sends requests.
    const timer = setInterval(() => { void figureList(projectId).then((all) => { if (!disposed) setRuns(all); }).catch(() => undefined); }, 4000);
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
    setSelected(id); setVersionIndex(null); setDocument(EMPTY); setSource(""); setEditOrigin(null); setError(null);
  };
  const upload = async (file?: File) => {
    if (!file) return;
    try {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) throw new Error(t("请选择 10 MB 以内的 PNG、JPEG 或 WebP。", "Choose a PNG, JPEG or WebP under 10 MB."));
      const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); });
      setImage({ base64: data.split(",")[1], url: data, name: file.name }); setError(null);
    } catch (e) { setError(String(e)); }
  };
  const create = async () => {
    if (submitting.current || !projectId) return;
    const owner = projectId; submitting.current = true; setBusy(true); setError(null);
    try {
      const prepared = await figurePrepare({ projectId: owner, id: crypto.randomUUID().replace(/-/g, ""), title: title.trim() || t("科研绘图", "Scientific figure"), method, style, sourceMode, sourceBase64: sourceMode === "import" ? image?.base64 ?? null : null, outputLimit, model: connections?.executor.model ?? null });
      if (projectRef.current === owner) { upsert(prepared); setSelected(prepared.run.id); }
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
      const next = await figureSave(owner, id, version?.hash ?? null, svg);
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
  const switchPanel = async (next: typeof panel) => {
    if (next === panel) return;
    if (dirty && panel === "canvas") {
      try { const svg = await editor.current?.serialize(); if (svg) setSource(svg); } catch (e) { setError(String(e)); return; }
    }
    if (dirty && editOrigin === "source" && next === "canvas") { setError(t("保存 SVG 源码后即可在画布中继续编辑。", "Save SVG source to continue in the canvas.")); return; }
    setPanel(next);
  };

  return <section className="figure-studio" aria-label={t("科研绘图应用", "Scientific figure application")}>
    <aside className="figure-sidebar">
      <div className="figure-brand"><span className="figure-brand-mark">◈</span><div><strong>SomniQ Figures</strong><small>{t("科研绘图", "Scientific figures")}</small></div></div>
      <button className="figure-primary" onClick={() => select(null)}>{t("＋ 新建绘图", "+ New figure")}</button>
      <p className="figure-project">{project?.name ?? t("请先选择本地项目", "Choose a local project")}</p>
      <div className="figure-run-list">{runs.map((entry) => <button key={entry.run.id} className={selected === entry.run.id ? "selected" : ""} onClick={() => select(entry.run.id)}><strong>{entry.run.title}</strong><small>{status(entry.run.status)}</small></button>)}</div>
      <div className="figure-sidebar-note">{t("项目内保存 · 可编辑 SVG\n沿用 SomniQ 模型与独立审查", "Saved in your project · editable SVG\nSomniQ models and independent review")}</div>
    </aside>
    <main className="figure-workspace">
      <header className="figure-header"><div><h1>{current?.run.title ?? t("将研究思路变成可编辑的图", "Turn your research into editable figures")}</h1><p>{current ? status(current.run.status) : t("参考图 → SVG 重建 → 独立审查 → 编辑与导出", "Reference image → SVG reconstruction → independent review → edit and export")}</p></div>
        {current?.active && <button onClick={() => { if (projectId) void figureCancel(projectId, current.run.id).catch((e) => setError(String(e))); }}>{t("取消任务", "Cancel task")}</button>}
      </header>
      {error && <div className="figure-alert" role="alert">{error}<button aria-label={t("关闭错误", "Dismiss error")} onClick={() => setError(null)}>×</button></div>}
      {!figuresAvailable() && <div className="figure-note">{t("请在 SomniQ 桌面应用中使用此模块。当前浏览器未连接模型与项目服务。", "Open this module in SomniQ Desktop. This browser has no model or project service connection.")}</div>}
      {!current ? <div className="figure-new">
        <div className="figure-new-form">
          <label>{t("标题", "Title")}<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder={t("例如：多智能体研究流程", "e.g. Multi-agent research workflow")} /></label>
          <label>{t("方法与必需内容", "Method and required content")}<textarea value={method} onChange={(e) => setMethod(e.target.value)} maxLength={40000} rows={7} placeholder={t("写清模块、标签、关系和箭头方向。数据图请提供真实数据。", "Describe modules, labels, relations and arrow directions. Use real data for scientific plots.")} /></label>
          <label>{t("风格", "Style")}<textarea value={style} onChange={(e) => setStyle(e.target.value)} rows={2} maxLength={2000} /></label>
          <div className="figure-mode" role="group" aria-label={t("参考图来源", "Reference image source")}><button className={sourceMode === "import" ? "selected" : ""} onClick={() => setSourceMode("import")}>{t("导入现有图片", "Import image")}</button><button className={sourceMode === "generate" ? "selected" : ""} onClick={() => setSourceMode("generate")}>{t("SomniImage 生图", "Generate with SomniImage")}</button></div>
          {sourceMode === "import" ? <label className="figure-upload">{image?.name ?? t("选择 PNG / JPEG / WebP（≤ 10 MB）", "Choose PNG / JPEG / WebP (≤ 10 MB)")}<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => void upload(e.target.files?.[0])} />{image && <img src={image.url} alt={t("参考图", "Reference")} />}</label> : <div className="figure-note">{t("沿用当前 SomniImage 账户与模型：", "Current SomniImage account and model: ")}{connections?.image.model ?? t("尚未配置", "Not configured")}</div>}
          <label>{t("重建模型", "Reconstruction model")}<select value={executorModel ?? ""} onChange={(e) => setExecutorModel(e.target.value || null)}><option value="">{t("当前 SomniQ Executor", "Current SomniQ Executor")}</option>{executorModels.map((model) => <option key={model} value={model}>{model}</option>)}</select></label>
          <p className="figure-budget">{t("可选择 SomniQ 已验证连接中的模型。首次调用会检查真实图片能力；选择仅用于新绘图任务。", "Choose a model from verified SomniQ connections. A real image probe runs on first use; selection applies to new figure tasks.")}</p>
          <label>{t("SVG 输出上限", "SVG output limit")}<select value={outputLimit} onChange={(e) => setOutputLimit(Number(e.target.value))}><option value={8192}>{t("8K · 简单图／额度实验", "8K · simple diagram / budget experiment")}</option><option value={16384}>{t("16K · 标准", "16K · standard")}</option><option value={32768}>{t("32K · 复杂架构图", "32K · complex architecture")}</option><option value={50000}>{t("50K · 需模型支持", "50K · requires model support")}</option></select></label>
          <p className="figure-budget">{t(`导入通常 2 次，最多 4 次；生图通常 3 次，最多 5 次。首次使用另计最多 2 次视觉探针。使用轻量推理为 SVG 留出空间；上限仍包含模型的推理 token。最多修订一次，截断后可手动修复或选择更高额度新建任务。`, `Import: usually 2 calls, up to 4; generation: usually 3, up to 5. First use adds up to 2 vision probes. Light reasoning leaves room for SVG; the cap still includes reasoning tokens. One revision at most; repair truncation manually or create a task with a larger budget.`)}</p>
          <button className="figure-primary" disabled={busy || !projectId || !connections || !method.trim() || (sourceMode === "import" && !image) || (sourceMode === "generate" && !connections.image.available) || !figuresAvailable()} onClick={() => void create()}>{busy ? t("正在启动…", "Starting…") : t("开始重建并审查", "Reconstruct and review")}</button>
        </div>
        <div className="figure-new-guide"><div className="figure-illustration"><span>{t("研究方法", "Method")}</span><i>→</i><span>SVG</span><i>→</i><span>{t("编辑", "Edit")}</span></div><h2>{t("让文字、模块和箭头都能修改", "Edit labels, modules and arrows")}</h2><p>{t("适合流程图和架构图。复杂装饰会简化；保留可编辑文字和矢量图形。", "Built for flow and architecture diagrams. Decorative details are simplified; labels and vector shapes remain editable.")}</p>
          {connections && <dl className="figure-models"><dt>Executor</dt><dd>{connections.executor.model}<small>{connections.executor.transport}</small></dd><dt>Reviewer</dt><dd>{connections.reviewer.model}<small>{connections.reviewer.transport}</small></dd></dl>}
          <button onClick={() => useStore.getState().setTab("settings")}>{t("打开模型设置", "Model settings")}</button>
        </div>
      </div> : <>
        <div className="figure-toolbar"><div className="figure-mode">{(["canvas", "source", "evidence"] as const).map((item) => <button key={item} className={panel === item ? "selected" : ""} onClick={() => void switchPanel(item)}>{item === "canvas" ? t("画布", "Canvas") : item === "source" ? t("SVG 源码", "SVG source") : t("参考与审查", "Reference and review")}</button>)}</div>
          <select aria-label={t("版本", "Version")} value={versionIndex ?? "latest"} disabled={dirty || current.active} onChange={(e) => setVersionIndex(e.target.value === "latest" ? null : Number(e.target.value))}><option value="latest">{t("当前版本", "Current version")}</option>{current.run.versions.map((v) => <option key={v.index} value={v.index}>v{v.index} · {v.author}</option>)}</select>
          <button disabled={!dirty || busy || current.active} onClick={() => void save()}>{t("保存新版本", "Save version")}{dirty ? " •" : ""}</button>
          <button disabled={!version || versionIndex !== null || dirty || busy || current.active || current.run.status === "unknown"} onClick={() => { if (projectId) void figureReview(projectId, current.run.id).then(upsert).catch((e) => setError(String(e))); }}>{t("审查当前版本（1 次调用）", "Review version (1 call)")}</button>
          {dirty && <button disabled={busy} onClick={() => void discard().catch((e) => setError(String(e)))}>{t("放弃编辑", "Discard edits")}</button>}
          {['svg', 'png', 'pdf'].map((format) => <button key={format} disabled={!version || dirty || busy || current.active} onClick={() => void exportFile(format)}>{format.toUpperCase()}</button>)}
        </div>
        <div className="figure-content"><div className="figure-canvas-pane" hidden={panel !== "canvas"}>{document.svg ? <FigureEditor key={`${projectId}:${selected}`} ref={editor} svg={document.svg} onDirty={() => { setDirty(true); setEditOrigin("canvas"); }} onError={setError} /> : <div className="figure-empty"><strong>{status(current.run.status)}</strong><p>{t("SVG 完成后会在这里打开可编辑画布。", "The editable canvas opens here when the SVG is ready.")}</p>{current.run.error && <p>{current.run.error}</p>}{document.rawOutput && <button onClick={() => setPanel("source")}>{t("查看并手动修复原始输出", "Inspect and repair raw output")}</button>}{current.run.status === "ready" && <button onClick={() => { if (projectId) void figureStart(projectId, current.run.id).then(upsert).catch((e) => setError(String(e))); }}>{t("启动已准备的任务", "Start prepared task")}</button>}</div>}</div>
          {panel === "source" && <textarea className="figure-source" aria-label="SVG" spellCheck={false} value={source} readOnly={current.active} onChange={(e) => { setSource(e.target.value); setDirty(true); setEditOrigin("source"); }} />}
          {panel === "evidence" && <div className="figure-evidence"><div className="figure-comparison"><div><h3>{t("原始参考图", "Original reference")}</h3>{document.sourceDataUrl && <img src={document.sourceDataUrl} alt={t("原始参考图", "Original reference")} />}</div><div><h3>{t("本地导出预览", "Local export preview")}</h3>{document.previewDataUrl && <img src={document.previewDataUrl} alt={t("导出预览", "Export preview")} />}</div></div>
            <h3>{t("审查与版本", "Review and version")}</h3><p>{versionIndex === null ? status(current.run.status) : `v${versionIndex} · ${t("历史版本", "Historical version")}`} · {displayedVersion?.classification ?? "—"} · {displayedVersion?.textCount ?? 0} {t("可编辑文字", "editable labels")}</p><p>{t("视觉 Reviewer：", "Visual Reviewer: ")}{current.run.reviewerVision ? t("真实图片探针通过", "Real image probe passed") : t("待验证／无视觉能力", "Unverified / unavailable")}</p>
            {current.run.error && <div className="figure-note">{current.run.error}</div>}
            <ul>{current.run.review?.issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul>
            <details><summary>{t("模型与证据", "Models and evidence")}</summary><pre>{JSON.stringify({ executor: current.run.executor, reviewer: current.run.reviewer, review: current.run.review, versions: current.run.versions }, null, 2)}</pre></details>
            <h3>{t("请求账本", "Request ledger")}</h3><table><thead><tr><th>{t("阶段", "Stage")}</th><th>{t("模型", "Model")}</th><th>{t("上限", "Limit")}</th><th>{t("输出 token", "Output tokens")}</th><th>{t("状态／停止原因", "State / stop reason")}</th></tr></thead><tbody>{current.run.requests.map((r) => <tr key={r.id}><td>{r.kind}</td><td>{r.identity.model}</td><td>{r.maxOutputTokens || "—"}</td><td>{r.usage?.outputTokens ?? "—"}</td><td>{r.status}{r.stopReason ? ` / ${r.stopReason}` : ""}{r.error && <small>{r.error}</small>}</td></tr>)}</tbody></table>
          </div>}
        </div>
        <footer className="figure-footer">{t("编辑后的版本需要重新检查。SVG 可继续编辑；论文插图建议使用 PDF 或 PNG。", "Edited versions need a new check. Keep SVG for editing; use PDF or PNG in your paper.")}</footer>
      </>}
    </main>
  </section>;
}
