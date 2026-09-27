import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useStore } from "../store";
import { chatModelOptions } from "../api/tauri";
import type { ChatModelOption } from "../types";
import {
  onPaperReadingError, onPaperReadingUpdated, paperReadingCancel,
  paperReadingGet, paperReadingPrepare, paperReadingSource, paperReadingStart,
  type PaperReadingView, type PaperContentKind,
} from "./paperReadingApi";
import { paperDocumentRevision, preparePaperPageEvidence } from "./pdfExtraction";
import PaperReadingContent from "./PaperReadingContent";
import PaperGuideView from "./PaperGuideView";
import "./PaperReadingPanel.css";

const COPY = {
  zh: {
    start: "多模态论文解析", results: "查看论文讲解", resume: "继续生成／重试失败内容", explain: "生成论文讲解",
    heading: "论文讲解", guideTab: "图文讲解", rawTab: "原文识别", records: "查看处理记录",
    intro: "从原图与公式，读懂论文的思路。",
    introDetail: "点击一次，Somni 会阅读原文、梳理论文主线，再逐个解释关键主题，提供分步说明、教学例子和原文对照。",
    outline: "正在梳理论文主线", teaching: "正在生成图文讲解", guideReady: "论文讲解已生成",
    stageRead: "阅读原文", stageOutline: "梳理主线", stageTeach: "图文讲解",
    preparing: "正在准备原始页面", running: "正在解析页面", cancel: "取消",
    hide: "收起结果", show: "展开结果", pageCoverage: "页面处理",
    candidates: "已识别内容（候选）", completeness: "识别完整性：未验证",
    notReviewed: "尚未独立审核", notTaught: "理解与教学：未执行",
    complete: "全部页面已处理", partial: "部分完成", cancelled: "已取消，可继续",
    source: "查看原页", empty: "尚无感知结果", failed: "失败",
    data: "使用 Somni 当前模型读取页面图像并生成讲解，结果保存为未审核草稿。",
    exhausted: "本轮自动尝试已结束。可以手动再试一轮，每轮最多 3 次，历史记录会保留。",
    retry: "重试未完成内容", attention: "需要继续", details: "查看错误详情",
    saved: "已完成的页面和讲解已保存，继续时只处理未完成的内容。",
    formatError: "模型返回的内容格式未通过校验。可以继续重试，不需要重新导入 PDF。",
    otherError: "这一步暂未完成。请查看错误详情，处理后继续，已有结果会保留。",
    waiting: "从主线开始，逐步理解论文", waitingDetail: "原文识别结果已保存。继续梳理论文主线后，这里会呈现关键主题、分步解释和原文对照。",
    readingDetail: "正在对照原文整理内容，完成后会自动梳理主线并生成讲解。",
    figureTitle: "看懂方法图", formulaTitle: "理解关键公式", experimentTitle: "读懂实验结论",
    figureDetail: "沿着模块和箭头，理解方法如何工作。", formulaDetail: "从符号、前提到推导，逐步解释核心难点。", experimentDetail: "对照指标、基线和表格，区分证据与结论。",
    badge: "多模态阅读", progressTitle: "阅读进度", lessonCount: "主题讲解", notPlanned: "待梳理",
    pending: "待处理", blank: "未识别到内容，请核对原页",
    kind: { text: "文本", formula: "公式", figure: "图片", table: "表格" },
  },
  en: {
    start: "Analyze paper", results: "View paper guide", resume: "Continue / retry failed content", explain: "Generate paper guide",
    heading: "Paper guide", guideTab: "Visual explanations", rawTab: "Transcriptions", records: "Processing details",
    intro: "Understand the paper through its figures, formulas and experiments.",
    introDetail: "One click reads the original, follows the paper's argument and explains key topics with steps, teaching examples and original sources.",
    outline: "Following the paper's argument", teaching: "Generating visual explanations", guideReady: "Paper guide ready",
    stageRead: "Read originals", stageOutline: "Follow the argument", stageTeach: "Explain visually",
    preparing: "Preparing original pages", running: "Processing pages", cancel: "Cancel",
    hide: "Hide results", show: "Show results", pageCoverage: "Page processing",
    candidates: "Identified content (candidates)", completeness: "Recognition completeness: not checked",
    notReviewed: "Not independently reviewed", notTaught: "Understanding and teaching: not run",
    complete: "All pages processed", partial: "Partially completed", cancelled: "Cancelled; resumable",
    source: "View source page", empty: "No perception results yet", failed: "failed",
    data: "Somni's configured model reads page images and generates explanations, saved as unreviewed drafts.",
    exhausted: "This automatic attempt batch has ended. Retry manually for up to 3 more attempts; history is preserved.",
    retry: "Retry unfinished content", attention: "Needs attention", details: "Error details",
    saved: "Completed pages and explanations are saved. Continuing processes only unfinished content.",
    formatError: "The model response did not match the required format. Retry without importing the PDF again.",
    otherError: "This step could not finish. Check the details, resolve the issue and continue with saved results.",
    waiting: "From the original to understanding", waitingDetail: "Transcriptions are saved. Continue to generate the argument, key topics and explanations alongside the originals.",
    readingDetail: "Reading the original evidence, then automatically organizing the argument and explanations.",
    figureTitle: "Understand the figures", formulaTitle: "Follow the mathematics", experimentTitle: "Read the evidence",
    figureDetail: "Follow modules and arrows to see how the method works.", formulaDetail: "Build from symbols and assumptions to the central derivation.", experimentDetail: "Compare metrics and baselines to see what results support.",
    badge: "MULTIMODAL READING", progressTitle: "Reading progress", lessonCount: "Explanations", notPlanned: "Not planned",
    pending: "pending", blank: "No content identified; check the original page",
    kind: { text: "Text", formula: "Formulas", figure: "Figures", table: "Tables" },
  },
};

interface Props {
  hidden?: boolean;
  onClose?: () => void;
  paperId: string;
  relativePath: string;
  document: PDFDocumentProxy | null;
  onJump: (page: number) => void;
}

export default function PaperReadingPanel({ paperId, relativePath, document, onJump, hidden = false, onClose }: Props) {
  const language = useStore(state => state.language);
  const projectId = useStore(state => state.currentProject?.id);
  const copy = COPY[language === "en" ? "en" : "zh"];
  const [view, setView] = useState<PaperReadingView | null>(null);
  const [open, setOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState("");
  const [models, setModels] = useState<ChatModelOption[]>([]);
  const [modelsError, setModelsError] = useState(false);
  const [configuredModel, setConfiguredModel] = useState("");
  useEffect(() => {
    let disposed = false;
    setModelsError(false);
    void chatModelOptions().then(result => {
      if (!disposed) { setModels(result.options); setConfiguredModel(result.current); }
    }).catch(() => { if (!disposed) setModelsError(true); });
    return () => { disposed = true; };
  }, [projectId]);
  const [webReading, setWebReading] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState("");
  const [preparedPages, setPreparedPages] = useState(0);
  const [tab, setTab] = useState<"guide" | "raw">("guide");
  const viewRef = useRef<PaperReadingView | null>(null);
  const revisionRef = useRef("");
  const preparation = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const modelTouched = useRef(false);

  const accept = (next: PaperReadingView) => {
    const previous = viewRef.current;
    if (next.projectId !== projectId || next.run.paperId !== paperId || next.run.documentRevision !== revisionRef.current) return;
    if (previous?.run.id === next.run.id && previous.run.revision > next.run.revision) return;
    viewRef.current = next;
    setView(next);
    if ((!previous && !modelTouched.current) || (previous && previous.run.id !== next.run.id)) setSelectedModel(next.run.model);
    if (!previous && next.run.guide) setOpen(true);
  };

  useEffect(() => {
    const epoch = ++generation.current;
    let disposed = false;
    const cleanups: Array<() => void> = [];
    viewRef.current = null;
    revisionRef.current = "";
    setView(null);
    setSelectedModel("");
    modelTouched.current = false;
    setError("");
    setOpen(false);
    setPreparing(false);
    setPreparedPages(0);
    setTab("guide");
    setWebReading(false);
    if (!document || !projectId) return;

    void (async () => {
      try {
        const revision = await paperDocumentRevision(document);
        if (disposed) return;
        revisionRef.current = revision;
        const offUpdate = await onPaperReadingUpdated(next => {
          if (disposed || generation.current !== epoch) return;
          const current = viewRef.current;
          if (current && next.projectId !== current.projectId) return;
          // Once bound, another task/model for this paper must not replace it.
          if (current && next.run.id !== current.run.id) return;
          accept(next);
        });
        if (disposed) { offUpdate(); return; }
        cleanups.push(offUpdate);
        const offError = await onPaperReadingError(event => {
          const current = viewRef.current;
          if (!disposed && current?.run.id === event.runId && current.projectId === event.projectId) {
            setError(event.message);
          }
        });
        if (disposed) { offError(); return; }
        cleanups.push(offError);
        const saved = await paperReadingGet(projectId, paperId, relativePath);
        if (!disposed && saved && (!viewRef.current || viewRef.current.run.id === saved.run.id)) accept(saved);
      } catch (reason) {
        if (!disposed) setError(String(reason));
      }
    })();
    return () => {
      disposed = true;
      generation.current += 1;
      preparation.current?.abort();
      for (const cleanup of cleanups) cleanup();
    };
    // A PDF reload creates a new document and a new source identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, paperId, relativePath, document]);

  const start = async (regenerate = false) => {
    if (!document || !projectId || preparation.current || viewRef.current?.active) return;
    setOpen(true);
    setError("");
    const requestedModel = selectedModel || configuredModel || viewRef.current?.run.model;
    if (!regenerate && viewRef.current?.run.status === "guide_ready" && requestedModel === viewRef.current.run.model) return;
    const controller = new AbortController();
    preparation.current = controller;
    const epoch = generation.current;
    let owned: PaperReadingView | null = null;
    let dispatched = false;
    setPreparing(true);
    try {
      const documentRevision = await paperDocumentRevision(document);
      controller.signal.throwIfAborted();
      revisionRef.current = documentRevision;
      owned = await paperReadingPrepare({ projectId, paperId, relativePath, documentRevision, language: language === "en" ? "en" : "zh", model: requestedModel || undefined,
        ...(regenerate ? { regenerate: true } : viewRef.current && requestedModel === viewRef.current.run.model ? { runId: viewRef.current.run.id } : {}),
      });
      controller.signal.throwIfAborted();
      if (generation.current !== epoch) return;
      accept(owned);
      if (owned.active || owned.run.status === "guide_ready") return;
      const ready = owned.run.pages.filter(page => page.source).length;
      setPreparedPages(ready);
      for (const page of owned.run.pages) {
        if (page.source) continue;
        controller.signal.throwIfAborted();
        const source = await preparePaperPageEvidence(document, page.pageIndex, controller.signal);
        controller.signal.throwIfAborted();
        const saved = await paperReadingSource({
          projectId: owned.projectId, runId: owned.run.id,
          documentRevision, pageIndex: page.pageIndex, ...source,
        });
        controller.signal.throwIfAborted();
        if (generation.current !== epoch) return;
        owned = saved;
        accept(saved);
        setPreparedPages(saved.run.pages.filter(item => item.source).length);
      }
      controller.signal.throwIfAborted();
      const started = await paperReadingStart(owned.projectId, owned.run.id);
      dispatched = true;
      if (generation.current === epoch) accept(started);
    } catch (reason) {
      if (!controller.signal.aborted && generation.current === epoch) setError(String(reason));
    } finally {
      if (controller.signal.aborted && owned && !dispatched && !owned.active) {
        try {
          const cancelled = await paperReadingCancel(owned.projectId, owned.run.id);
          if (generation.current === epoch) accept(cancelled);
        } catch { /* The persisted source preparation can still be resumed. */ }
      }
      if (preparation.current === controller) preparation.current = null;
      if (generation.current === epoch) setPreparing(false);
    }
  };

  const cancel = async () => {
    const epoch = generation.current;
    preparation.current?.abort();
    const current = viewRef.current;
    if (!current) return;
    try {
      const cancelled = await paperReadingCancel(current.projectId, current.run.id);
      if (generation.current === epoch) accept(cancelled);
    }
    catch (reason) { if (generation.current === epoch) setError(String(reason)); }
  };

  const busy = preparing || !!view?.active;
  const pageCoverage = view?.coverage.pageProcessingCoverage;
  const counts = view?.coverage.identifiedContentCoverage.candidatesByKind;
  const guide = view?.run.guide;
  const exhausted = !!view && (view.run.pages.some(page => page.status !== "completed" && page.attempts.length >= (page.attemptLimit ?? 3))
    || !!guide && (guide.outline.status !== "completed" && guide.outline.attempts.length >= (guide.outline.attemptLimit ?? 3)
    || guide.lessons.some(lesson => lesson.task.status !== "completed" && lesson.task.attempts.length >= (lesson.task.attemptLimit ?? 3))));
  const failure = !busy ? error || view?.run.lastError || guide?.outline.error || view?.run.pages.find(page => page.error)?.error : null;
  const needsAttention = !busy && (failure || exhausted || guide?.lessons.some(lesson => lesson.task.status === "failed"));
  const completedLessons = guide?.lessons.filter(lesson => lesson.task.status === "completed").length ?? 0;
  const guideBusy = guide?.outline.status === "running" ? copy.outline
    : guide?.lessons.some(lesson => lesson.task.status === "running") ? copy.teaching : null;
  const status = preparing ? copy.preparing
    : view?.active ? guideBusy ?? copy.running
    : view?.run.status === "guide_ready" ? copy.guideReady
    : view?.run.status === "page_processing_complete" ? copy.complete
    : view?.run.status === "cancelled" ? copy.cancelled
    : needsAttention ? copy.attention : view ? copy.partial : "";
  const modelChanged = !!view && !!(selectedModel || configuredModel) && (selectedModel || configuredModel) !== view.run.model;
  const modelOptions = [...models];
  for (const value of [selectedModel, view?.run.model, configuredModel]) {
    if (value && !modelOptions.some(option => option.value === value)) modelOptions.push({ value, label: value, description: null });
  }
  const modelPicker = <label className="paper-reader-model-picker">
    <span>{language === "en" ? "Generation model" : "生成模型"}</span>
    <select title={language === "en" ? "Choose a model that supports image input" : "请选择支持图像输入的模型"} aria-label={language === "en" ? "Generation model" : "生成模型"} value={selectedModel} disabled={busy} onChange={event => { modelTouched.current = true; setSelectedModel(event.target.value); }}>
      <option value="">{language === "en" ? "Somni current model" : "Somni 当前模型"}{configuredModel ? ` · ${configuredModel}` : ""}</option>
      {modelOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  </label>;
  const hasEssay = !!guide?.outline.result;
  const label = modelChanged ? (language === "en" ? "Generate with selected model" : "用所选模型生成") : view?.run.status === "guide_ready" ? copy.results
    : exhausted ? copy.retry
    : view?.run.status === "page_processing_complete" ? copy.explain
    : view && view.run.status !== "preparing" ? copy.resume : copy.start;

  return (
    <aside className={`lit-paper-analysis${webReading && !hidden ? " web-reading" : ""}${hasEssay ? " has-essay" : ""}`} aria-label={copy.heading} style={hidden ? { display: "none" } : undefined}>
      <div className="paper-reader-generation-actions">
        {view && <button type="button" disabled={busy || !document || !projectId} title={language === "en" ? "Read the whole paper again; previous results are retained" : "重新阅读全文并生成新版本，旧结果保留"} onClick={() => void start(true)}>{language === "en" ? "Regenerate" : "重新生成讲解"}</button>}
        {onClose && <button type="button" onClick={onClose}>{language === "en" ? "Close guide" : "关闭讲解"}</button>}
      </div>
      {hasEssay && <header className="paper-reader-toolbar">
        <div className="paper-reader-toolbar-brand"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M3 4h6c2 0 3 1 3 2 0-1 1-2 3-2h6v15h-6c-2 0-3 1-3 2 0-1-1-2-3-2H3zM12 6v15" /></svg>SomniQ <span> / {language === "en" ? "Paper reader" : "论文阅读"}</span></div>
        <div className="paper-reader-toolbar-controls">
          {modelPicker}
          <div role="tablist" aria-label={copy.heading}>
            <button type="button" role="tab" aria-selected={tab === "guide"} onClick={() => setTab("guide")}>{copy.guideTab}</button>
            <button type="button" role="tab" aria-selected={tab === "raw"} onClick={() => setTab("raw")}>{copy.rawTab}</button>
          </div>
          <button type="button" className="paper-reader-compare" aria-pressed={webReading} onClick={() => setWebReading(value => !value)}>{language === "en" ? webReading ? "Compare PDF ↗" : "Reading view ↗" : webReading ? "对照 PDF ↗" : "网页阅读 ↗"}</button>
        </div>
      </header>}
      {hasEssay && (busy || modelChanged || view?.run.status !== "guide_ready") && <div className="paper-reader-task-notice" role="status">
        <span>{modelChanged ? (language === "en" ? "The new model generates a separate result; previous results are retained." : "换模型将单独生成，原有结果保留。") : `${busy ? status : copy.partial} · ${copy.stageTeach} ${completedLessons}/${guide?.lessons.length ?? 0}`}</span>
        {busy ? <button type="button" onClick={() => void cancel()}>{copy.cancel}</button> : <button type="button" onClick={() => void start()} disabled={!document || !projectId}>{label}</button>}
      </div>}
      {!hasEssay && <>
      <header className="lit-paper-analysis-head">
        <div><span className="lit-guide-eyebrow">{copy.badge}</span><h2>{copy.heading}</h2></div>
        {view && <span className="lit-guide-model">{view.run.model}</span>}
      </header>
      {view && <p className="lit-guide-paper-title">{view.run.title}</p>}
      {!view && <div className="lit-guide-welcome"><h3>{copy.intro}</h3><p>{copy.introDetail}</p></div>}
      {view && <div className="lit-guide-summary" aria-label={copy.progressTitle}>
        <div><span>{copy.stageRead}</span><strong>{pageCoverage?.completed ?? 0}<small> / {pageCoverage?.total ?? view.run.totalPages}</small></strong></div>
        <div><span>{copy.lessonCount}</span><strong>{guide?.lessons.length ? <>{completedLessons}<small> / {guide.lessons.length}</small></> : <small>{copy.notPlanned}</small>}</strong></div>
        <span className={`lit-guide-state${needsAttention ? " attention" : ""}`}>{status}</span>
      </div>}
      {modelPicker}
      {modelChanged && <p className="lit-paper-analysis-note">{language === "en" ? "The new model generates a separate result; previous results are retained." : "换模型将单独生成，原有结果保留。"}</p>}
      <div className="lit-paper-analysis-actions">
        <button type="button" className="lit-paper-analysis-start" disabled={!document || !projectId || busy} onClick={() => void start()}>
          {busy ? status : label}<span aria-hidden="true">{busy ? " ···" : " ↗"}</span>
        </button>
        {busy && <button type="button" onClick={() => void cancel()}>{copy.cancel}</button>}
        {view && <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? copy.hide : copy.show}</button>}
      </div>
      {busy && <p role="status" className="lit-paper-analysis-progress">{status}{preparing ? " " + preparedPages + "/" + (view?.run.totalPages ?? document?.numPages ?? 0) : guideBusy === copy.teaching ? ` ${completedLessons}/${guide?.lessons.length ?? 0}` : view?.active && !guideBusy ? ` ${pageCoverage?.completed ?? 0}/${pageCoverage?.total ?? 0}` : ""}</p>}
      {view && <ol className="lit-guide-stages" aria-label={copy.progressTitle}>
        {[{ title: copy.stageRead, done: pageCoverage?.completed === pageCoverage?.total, active: !!view.active && !guideBusy },
          { title: copy.stageOutline, done: !!guide?.outline.result, active: guide?.outline.status === "running" },
          { title: copy.stageTeach, done: !!guide?.lessons.length && completedLessons === guide.lessons.length, active: guideBusy === copy.teaching }]
          .map((stage, index) => <li key={stage.title} className={stage.done ? "done" : stage.active ? "active" : ""} aria-current={stage.active ? "step" : undefined}>
            <span aria-hidden="true">{stage.done ? "✓" : `0${index + 1}`}</span><strong>{stage.title}</strong>
          </li>)}
      </ol>}
      </>}
      {modelsError && <p className="lit-paper-analysis-note">{language === "en" ? "Model list unavailable. The current model remains usable." : "模型列表暂不可用，仍可使用当前模型。"}</p>}
      {needsAttention && <section className="lit-guide-recovery" role="alert">
        <strong>{guide?.outline.status === "failed" ? copy.stageOutline : copy.heading} · {copy.attention}</strong>
        <p>{failure && /JSON|invalid type|sourcePages|cautions|invalid content/i.test(failure) ? copy.formatError : copy.otherError}</p>
        <p>{copy.saved}</p>
        {exhausted && <p>{copy.exhausted}</p>}
        {failure && <details><summary>{copy.details}</summary><pre>{failure}</pre></details>}
      </section>}
      {!view && <div className="lit-guide-features">
        {[[copy.figureTitle, copy.figureDetail], [copy.formulaTitle, copy.formulaDetail], [copy.experimentTitle, copy.experimentDetail]].map(([title, detail], index) =>
          <article key={title}><span aria-hidden="true">0{index + 1}</span><div><h4>{title}</h4><p>{detail}</p></div></article>)}
        <p className="lit-paper-analysis-note">{copy.data}</p>
      </div>}
      {(open || hasEssay) && view && (
        <div className="lit-paper-analysis-results">
          {!hasEssay && <div className="lit-guide-tabs" role="tablist" aria-label={copy.heading}>
            <button type="button" role="tab" aria-selected={tab === "guide"} onClick={() => setTab("guide")}>{copy.guideTab}</button>
            <button type="button" role="tab" aria-selected={tab === "raw"} onClick={() => setTab("raw")}>{copy.rawTab}</button>
          </div>}
          {tab === "guide" && !guide?.outline.result && <div className="lit-guide-empty">
            <span className="lit-guide-empty-symbol" aria-hidden="true">◎</span>
            <h3>{busy ? status : copy.waiting}</h3><p>{busy ? copy.readingDetail : copy.waitingDetail}</p>
          </div>}
          {tab === "guide" && (guide?.outline.result
            ? <PaperGuideView guide={guide} title={view.run.title} totalPages={view.run.totalPages} document={document} onJump={page => { setWebReading(false); onJump(page); }} language={language} />
            : null)}
          {tab === "raw" && view.run.pages.map(page => (
            <details key={page.pageIndex} className="lit-paper-analysis-page">
              <summary>{page.pageIndex + 1} / {view.run.totalPages} · {page.result ? copy.notReviewed : page.error ? copy.failed : copy.pending}</summary>
              <button type="button" onClick={() => { setWebReading(false); onJump(page.pageIndex + 1); }}>{copy.source} {page.pageIndex + 1}</button>
              {page.error && <p className="lit-paper-analysis-error">{page.error}</p>}
              {!page.result && <p>{copy.empty}</p>}
              {page.result?.warnings.map((warning, index) => <p key={index} className="lit-paper-analysis-warning">{warning}</p>)}
              {page.result?.items.length === 0 && <p>{copy.blank}</p>}
              {page.result?.items.map((item, index) => (
                <div key={index} className="lit-paper-analysis-item">
                  <strong>{copy.kind[item.kind]}</strong>
                  <PaperReadingContent content={item.content} />
                  {item.uncertainties.map((uncertainty, itemIndex) => <p key={itemIndex} className="lit-paper-analysis-warning">{uncertainty}</p>)}
                </div>
              ))}
            </details>
          ))}
          <details className="lit-paper-analysis-coverage"><summary>{copy.records}</summary>
            <span>{copy.pageCoverage}: {pageCoverage?.completed}/{pageCoverage?.total} · {pageCoverage?.failed} {copy.failed}</span>
            <span>{copy.candidates}: {(Object.keys(copy.kind) as PaperContentKind[]).map(kind => copy.kind[kind] + " " + (counts?.[kind] ?? 0)).join(" · ")}</span>
            <span>{copy.completeness}</span>
            <span>{guide?.lessons.length ? `${copy.stageTeach}: ${completedLessons}/${guide.lessons.length}` : copy.notTaught} · {copy.notReviewed}</span>
          </details>
        </div>
      )}
    </aside>
  );
}
