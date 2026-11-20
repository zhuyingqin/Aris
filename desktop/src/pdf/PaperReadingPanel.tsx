import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useStore, type Language } from "../store";
import { languageLocale, tr } from "../language";
import { SvgIcon, type SvgIconName } from "../SvgIcon";
import { chatModelOptions } from "../api/tauri";
import type { ChatModelOption } from "../types";
import {
  onPaperReadingError, onPaperReadingUpdated, paperReadingAsk, paperReadingCancel, paperReadingDelete,
  paperReadingFollowUps, paperReadingGet, paperReadingList, paperReadingLoad, paperReadingPrepare,
  paperReadingSource, paperReadingStart,
  type FollowUpMode, type PaperFollowUp, type PaperReadingLanguage, type PaperReadingVersion, type PaperReadingView, type PaperContentKind,
} from "./paperReadingApi";
import { currentLesson, finalReview } from "./paperGuideModel";
import { paperDocumentRevision, preparePaperPageEvidence } from "./pdfExtraction";
import PaperReadingContent from "./PaperReadingContent";
import PaperGuideView from "./PaperGuideView";
import "./PaperReadingPanel.css";

const COPY = {
  cn: {
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
    textLayer: "直接读取文本层", textLayerNote: (count: number) => `${count} 页有可用的 PDF 文本层，已直接读取原文，未做逐页模型识别。`,
    transcribeAll: "逐页识别这些页面（重建表格与公式）", reviewing: "正在独立审核讲解",
    legacy: "这份讲解由旧版本生成，可以继续阅读；重新生成可获得“由浅入深”的分层讲解和独立审核。",
    regenerateNew: "按新版重新生成", versions: "讲解版本", deleteVersion: "删除此版本",
    deleteConfirm: "删除这个讲解版本？它的原页图片、追问记录和生成会话都会被删除，不影响 PDF 与其他版本。",
    oldFormat: "旧版格式",
    reviewSummary: (counts: { passed: number; needsRevision: number; insufficientEvidence: number; unavailable: number; pending: number }) =>
      `独立审核：通过 ${counts.passed} · 发现问题 ${counts.needsRevision} · 证据不足 ${counts.insufficientEvidence} · 未能审核 ${counts.unavailable} · 待审核 ${counts.pending}`,
    reviewerMissing: "部分讲解未能独立审核（例如未配置审核模型）。配置后点“补做独立审核”即可补审。",
    reReview: "补做独立审核",
    status: { preparing: "准备中", running: "生成中", partial: "未完成", cancelled: "已取消", page_processing_complete: "已读原文", guide_ready: "讲解已生成" },
  },
  en: {
    start: "Analyze paper", results: "View paper guide", resume: "Continue / retry failed content", explain: "Generate paper guide",
    heading: "Paper guide", guideTab: "Visual explanations", rawTab: "Transcriptions", records: "Processing details",
    intro: "Understand the paper through its figures, formulas and experiments.",
    introDetail: "One click reads the original, follows the paper's argument and explains key topics with steps, teaching examples and original sources.",
    outline: "Following the paper's argument", teaching: "Generating visual explanations", guideReady: "Paper guide ready",
    stageRead: "Read the original", stageOutline: "Follow the argument", stageTeach: "Explain visually",
    preparing: "Preparing original pages", running: "Processing pages", cancel: "Cancel",
    hide: "Hide results", show: "Show results", pageCoverage: "Page processing",
    candidates: "Identified content (candidates)", completeness: "Recognition completeness: not checked",
    notReviewed: "Not independently reviewed", notTaught: "Understanding and teaching: not run",
    complete: "All pages processed", partial: "Partially completed", cancelled: "Cancelled; resumable",
    source: "View source page", empty: "No perception results yet", failed: "failed",
    data: "Somni's configured model reads page images and generates explanations, saved as unreviewed drafts.",
    exhausted: "Automatic retries for this round have ended. You can start another round manually (up to 3 attempts per round); history is kept.",
    retry: "Retry unfinished content", attention: "Needs attention", details: "Error details",
    saved: "Completed pages and explanations are saved. Continuing processes only unfinished content.",
    formatError: "The model response did not match the required format. Retry without importing the PDF again.",
    otherError: "This step could not finish. Check the details, resolve the issue and continue with saved results.",
    waiting: "Start from the main argument and work through the paper", waitingDetail: "Transcriptions are saved. Continue to generate the argument, key topics and explanations alongside the originals.",
    readingDetail: "Reading the original evidence, then automatically organizing the argument and explanations.",
    figureTitle: "Understand the figures", formulaTitle: "Follow the mathematics", experimentTitle: "Read the evidence",
    figureDetail: "Follow modules and arrows to see how the method works.", formulaDetail: "Build from symbols and assumptions to the central derivation.", experimentDetail: "Compare metrics and baselines to see what results support.",
    badge: "MULTIMODAL READING", progressTitle: "Reading progress", lessonCount: "Explanations", notPlanned: "Not outlined yet",
    pending: "pending", blank: "No content identified; check the original page",
    kind: { text: "Text", formula: "Formulas", figure: "Figures", table: "Tables" },
    textLayer: "Read from the text layer", textLayerNote: (count: number) => `${count} pages have a usable PDF text layer and were read directly, without page-by-page model transcription.`,
    transcribeAll: "Transcribe these pages (rebuild tables and formulas)", reviewing: "Independently reviewing explanations",
    legacy: "This guide was generated by an earlier release. It stays readable; regenerate to get the layered simple-to-deep lessons with independent review.",
    regenerateNew: "Regenerate in the new format", versions: "Guide version", deleteVersion: "Delete this version",
    deleteConfirm: "Delete this guide version? Its page images, questions and generation sessions are removed; the PDF and other versions are kept.",
    oldFormat: "earlier format",
    reviewSummary: (counts: { passed: number; needsRevision: number; insufficientEvidence: number; unavailable: number; pending: number }) =>
      `Independent review: ${counts.passed} passed · ${counts.needsRevision} with issues · ${counts.insufficientEvidence} insufficient evidence · ${counts.unavailable} not reviewed · ${counts.pending} pending`,
    reviewerMissing: "Some explanations could not be independently reviewed (for example, no Reviewer is configured). Configure one, then choose “Run independent review”.",
    reReview: "Run independent review",
    status: { preparing: "Preparing", running: "Generating", partial: "Unfinished", cancelled: "Cancelled", page_processing_complete: "Originals read", guide_ready: "Guide ready" },
  },
  es: {
    start: "Analizar artículo", results: "Ver la guía del artículo", resume: "Continuar / reintentar lo que falló", explain: "Generar guía del artículo",
    heading: "Guía del artículo", guideTab: "Explicaciones visuales", rawTab: "Transcripciones", records: "Detalles del procesamiento",
    intro: "Entiende el artículo a través de sus figuras, fórmulas y experimentos.",
    introDetail: "Con un clic, Somni lee el original, sigue el argumento del artículo y explica los temas clave con pasos, ejemplos didácticos y las fuentes originales.",
    outline: "Siguiendo el argumento del artículo", teaching: "Generando explicaciones visuales", guideReady: "Guía del artículo lista",
    stageRead: "Leer los originales", stageOutline: "Seguir el argumento", stageTeach: "Explicar visualmente",
    preparing: "Preparando las páginas originales", running: "Procesando páginas", cancel: "Cancelar",
    hide: "Ocultar resultados", show: "Mostrar resultados", pageCoverage: "Procesamiento de páginas",
    candidates: "Contenido identificado (candidatos)", completeness: "Integridad del reconocimiento: sin comprobar",
    notReviewed: "Sin revisión independiente", notTaught: "Comprensión y enseñanza: sin ejecutar",
    complete: "Todas las páginas procesadas", partial: "Completado en parte", cancelled: "Cancelado; se puede reanudar",
    source: "Ver la página de origen", empty: "Aún no hay resultados de percepción", failed: "con error",
    data: "El modelo configurado en Somni lee las imágenes de las páginas y genera explicaciones, que se guardan como borradores sin revisar.",
    exhausted: "Los reintentos automáticos de esta ronda han terminado. Puedes iniciar otra ronda manualmente (hasta 3 intentos por ronda); el historial se conserva.",
    retry: "Reintentar lo pendiente", attention: "Requiere atención", details: "Detalles del error",
    saved: "Las páginas y explicaciones completadas están guardadas. Al continuar solo se procesa lo pendiente.",
    formatError: "La respuesta del modelo no tenía el formato requerido. Reintenta sin volver a importar el PDF.",
    otherError: "Este paso no pudo terminar. Revisa los detalles, resuelve el problema y continúa con los resultados guardados.",
    waiting: "Empieza por el argumento principal y avanza por el artículo", waitingDetail: "Las transcripciones están guardadas. Continúa para generar el argumento, los temas clave y las explicaciones junto a los originales.",
    readingDetail: "Leyendo la evidencia original; después se organizarán automáticamente el argumento y las explicaciones.",
    figureTitle: "Entender las figuras", formulaTitle: "Seguir las matemáticas", experimentTitle: "Leer la evidencia",
    figureDetail: "Sigue los módulos y las flechas para ver cómo funciona el método.", formulaDetail: "Avanza desde los símbolos y supuestos hasta la derivación central.", experimentDetail: "Compara métricas y referencias para ver qué respaldan los resultados.",
    badge: "LECTURA MULTIMODAL", progressTitle: "Progreso de lectura", lessonCount: "Explicaciones", notPlanned: "Aún sin esbozar",
    pending: "pendiente", blank: "No se identificó contenido; revisa la página original",
    kind: { text: "Texto", formula: "Fórmulas", figure: "Figuras", table: "Tablas" },
    textLayer: "Leído de la capa de texto", textLayerNote: (count: number) => `${count} páginas tienen una capa de texto PDF utilizable y se leyeron directamente, sin transcripción del modelo página por página.`,
    transcribeAll: "Transcribir estas páginas (reconstruir tablas y fórmulas)", reviewing: "Revisando las explicaciones de forma independiente",
    legacy: "Esta guía se generó con una versión anterior. Puedes seguir leyéndola; regenérala para obtener lecciones por niveles, de lo simple a lo profundo, con revisión independiente.",
    regenerateNew: "Regenerar en el nuevo formato", versions: "Versión de la guía", deleteVersion: "Eliminar esta versión",
    deleteConfirm: "¿Eliminar esta versión de la guía? Se borran sus imágenes de página, preguntas y sesiones de generación; el PDF y las demás versiones se conservan.",
    oldFormat: "formato anterior",
    reviewSummary: (counts: { passed: number; needsRevision: number; insufficientEvidence: number; unavailable: number; pending: number }) =>
      `Revisión independiente: ${counts.passed} aprobadas · ${counts.needsRevision} con problemas · ${counts.insufficientEvidence} con evidencia insuficiente · ${counts.unavailable} sin revisar · ${counts.pending} pendientes`,
    reviewerMissing: "Algunas explicaciones no se pudieron revisar de forma independiente (por ejemplo, no hay un Reviewer configurado). Configura uno y elige «Ejecutar revisión independiente».",
    reReview: "Ejecutar revisión independiente",
    status: { preparing: "Preparando", running: "Generando", partial: "Sin terminar", cancelled: "Cancelado", page_processing_complete: "Originales leídos", guide_ready: "Guía lista" },
  },
};

/** The generation language for a new run, following the interface language. */
function paperReadingLanguage(language: Language): PaperReadingLanguage {
  return tr<PaperReadingLanguage>(language, "zh", "en", "es");
}

interface Props {
  id?: string;
  hidden?: boolean;
  onClose?: () => void;
  /** Save a lesson into the paper's library notes. */
  onSaveNote?: (note: { title: string; content: string }) => void;
  paperId: string;
  relativePath: string;
  document: PDFDocumentProxy | null;
  onJump: (page: number) => void;
}

export default function PaperReadingPanel({ id, paperId, relativePath, document, onJump, hidden = false, onClose, onSaveNote }: Props) {
  const language = useStore(state => state.language);
  const projectId = useStore(state => state.currentProject?.id);
  const copy = COPY[language];
  const t = (cn: string, en: string, es: string) => tr(language, cn, en, es);
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
  const [versions, setVersions] = useState<PaperReadingVersion[]>([]);
  const [followUps, setFollowUps] = useState<PaperFollowUp[]>([]);
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
    setVersions([]);
    setFollowUps([]);
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

  const boundRunId = view?.run.id;
  const boundActive = view?.active;
  useEffect(() => {
    if (!projectId || !boundRunId) return;
    let disposed = false;
    const epoch = generation.current;
    void paperReadingFollowUps(projectId, boundRunId)
      .then(items => { if (!disposed && generation.current === epoch && viewRef.current?.run.id === boundRunId) setFollowUps(items ?? []); })
      .catch(() => { /* Questions are optional; the guide stays readable. */ });
    void paperReadingList(projectId, paperId)
      // Only versions of the PDF open in this reader can be shown beside it.
      .then(items => { if (!disposed && generation.current === epoch) setVersions((items ?? []).filter(item => item.documentRevision === revisionRef.current)); })
      .catch(() => { /* The version picker is optional. */ });
    return () => { disposed = true; };
  }, [projectId, paperId, boundRunId, boundActive]);

  const openVersion = async (runId: string) => {
    if (!projectId || runId === viewRef.current?.run.id) return;
    try {
      const next = await paperReadingLoad(projectId, runId);
      setFollowUps([]);
      accept(next);
    } catch (reason) { setError(String(reason)); }
  };

  const deleteVersion = async () => {
    const current = viewRef.current;
    if (!current || !projectId || current.active) return;
    if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm(copy.deleteConfirm)) return;
    try {
      await paperReadingDelete(projectId, current.run.id);
      viewRef.current = null;
      setView(null);
      setFollowUps([]);
      const next = await paperReadingGet(projectId, paperId, relativePath);
      if (next) accept(next);
      else setVersions([]);
    } catch (reason) { setError(String(reason)); }
  };

  const askGuide = async (request: { target: string; mode: FollowUpMode; question?: string; focus?: string }) => {
    const current = viewRef.current;
    if (!current || !projectId) return;
    const answer = await paperReadingAsk({ projectId, runId: current.run.id, ...request });
    if (viewRef.current?.run.id === current.run.id) setFollowUps(items => [...items, answer]);
  };

  const transcribeAll = async () => {
    const current = viewRef.current;
    if (!current || !projectId || current.active || preparation.current) return;
    setError("");
    try {
      accept(await paperReadingStart(current.projectId, current.run.id, true));
    } catch (reason) { setError(String(reason)); }
  };

  const start = async (regenerate = false) => {
    if (!document || !projectId || preparation.current || viewRef.current?.active) return;
    setOpen(true);
    setError("");
    const requestedModel = selectedModel || configuredModel || viewRef.current?.run.model;
    const pendingReviews = !!viewRef.current?.coverage.reviewCounts?.unavailable;
    if (!regenerate && viewRef.current?.run.status === "guide_ready" && requestedModel === viewRef.current.run.model && !pendingReviews) {
      if (viewRef.current.resumable === false) void start(true);
      return;
    }
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
      const continuing = !regenerate && viewRef.current && viewRef.current.resumable !== false && requestedModel === viewRef.current.run.model
        ? viewRef.current : null;
      // Continuing keeps the saved task's own language, even if the interface
      // language changed since; a new task follows the interface language.
      owned = await paperReadingPrepare({ projectId, paperId, relativePath, documentRevision,
        language: continuing ? continuing.run.language : paperReadingLanguage(language), model: requestedModel || undefined,
        ...(regenerate ? { regenerate: true } : continuing ? { runId: continuing.run.id } : {}),
      });
      controller.signal.throwIfAborted();
      if (generation.current !== epoch) return;
      accept(owned);
      // A finished guide is only restarted to review lessons a missing Reviewer could not check.
      if (owned.active || (owned.run.status === "guide_ready" && !owned.coverage.reviewCounts?.unavailable)) return;
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
  const resumable = view?.resumable !== false;
  const pageCoverage = view?.coverage.pageProcessingCoverage;
  const pagesRead = (pageCoverage?.completed ?? 0) + (pageCoverage?.notRequired ?? 0);
  const textLayerPages = view?.run.pages.filter(page => page.status === "not_required").length ?? 0;
  const reviewCounts = view?.coverage.reviewCounts;
  const counts = view?.coverage.identifiedContentCoverage.candidatesByKind;
  const guide = view?.run.guide;
  const exhausted = !!view && (view.run.pages.some(page => page.status !== "completed" && page.attempts.length >= (page.attemptLimit ?? 3))
    || !!guide && (guide.outline.status !== "completed" && guide.outline.attempts.length >= (guide.outline.attemptLimit ?? 3)
    || guide.lessons.some(lesson => lesson.task.status !== "completed" && lesson.task.attempts.length >= (lesson.task.attemptLimit ?? 3))));
  const failure = !busy ? error || view?.run.lastError || guide?.outline.error || view?.run.pages.find(page => page.error)?.error : null;
  const needsAttention = !busy && (failure || exhausted || guide?.lessons.some(lesson => lesson.task.status === "failed"));
  const completedLessons = guide?.lessons.filter(lesson => currentLesson(lesson)).length ?? 0;
  const guideBusy = guide?.outline.status === "running" ? copy.outline
    : guide?.lessons.some(lesson => lesson.task.status === "running" || lesson.revision?.status === "running") ? copy.teaching
    : view?.active && guide?.reviewRequired && guide.lessons.some(lesson => currentLesson(lesson) && !finalReview(lesson)) ? copy.reviewing : null;
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
    <span>{t("生成模型", "Generation model", "Modelo de generación")}</span>
    <select title={t("请选择支持图像输入的模型", "Choose a model that supports image input", "Elige un modelo que admita entrada de imágenes")} aria-label={t("生成模型", "Generation model", "Modelo de generación")} value={selectedModel} disabled={busy} onChange={event => { modelTouched.current = true; setSelectedModel(event.target.value); }}>
      <option value="">{t("Somni 当前模型", "Somni's current model", "Modelo actual de Somni")}{configuredModel ? ` · ${configuredModel}` : ""}</option>
      {modelOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  </label>;
  const hasEssay = !!guide?.outline.result;
  const reviewMissing = !!reviewCounts?.unavailable && resumable;
  const label = modelChanged ? (t("用所选模型生成", "Generate with selected model", "Generar con el modelo seleccionado"))
    : view && !resumable ? copy.regenerateNew
    : reviewMissing && view?.run.status === "guide_ready" ? copy.reReview
    : view?.run.status === "guide_ready" ? copy.results
    : exhausted ? copy.retry
    : view?.run.status === "page_processing_complete" ? copy.explain
    : view && view.run.status !== "preparing" ? copy.resume : copy.start;

  return (
    <aside id={id} className={`lit-paper-analysis${webReading && !hidden ? " web-reading" : ""}${hasEssay ? " has-essay" : ""}`} aria-label={copy.heading} style={hidden ? { display: "none" } : undefined}>
      <header className="paper-guide-header">
        <div className="paper-guide-heading"><SvgIcon name="paperGuide" size={21} /><h2>{copy.heading}</h2></div>
        <div className="paper-reader-generation-actions">
          {versions.length > 1 && view && <label className="paper-reader-version-picker"><span>{copy.versions}</span>
            <select aria-label={copy.versions} value={view.run.id} disabled={busy} onChange={event => void openVersion(event.target.value)}>
              {versions.map(version => <option key={version.id} value={version.id}>{new Date(version.updatedAt).toLocaleString(languageLocale(language))} · {version.model} · {copy.status[version.status]}{version.resumable ? "" : ` · ${copy.oldFormat}`}</option>)}
            </select></label>}
          {view && <button type="button" disabled={busy || !document || !projectId}
            title={t("重新阅读全文并生成新版本，旧结果保留", "Read the whole paper again; previous results are retained", "Vuelve a leer todo el artículo; los resultados anteriores se conservan")}
            onClick={() => void start(true)}><SvgIcon name="refresh" size={14} />{t("重新生成讲解", "Regenerate", "Regenerar")}</button>}
          {view && <button type="button" className="paper-guide-delete" disabled={busy} aria-label={copy.deleteVersion} title={copy.deleteVersion}
            onClick={() => void deleteVersion()}><SvgIcon name="trash" size={14} /></button>}
          {onClose && <button type="button" className="paper-guide-close"
            aria-label={t("关闭讲解", "Close guide", "Cerrar guía")}
            title={t("关闭讲解（Esc）", "Close guide (Esc)", "Cerrar guía (Esc)")} onClick={onClose}><SvgIcon name="close" size={17} /></button>}
        </div>
      </header>
      {hasEssay && <header className="paper-reader-toolbar">
        <div className="paper-reader-toolbar-controls">
          {modelPicker}
          <div role="tablist" aria-label={copy.heading}>
            <button type="button" role="tab" aria-selected={tab === "guide"} onClick={() => setTab("guide")}>{copy.guideTab}</button>
            <button type="button" role="tab" aria-selected={tab === "raw"} onClick={() => setTab("raw")}>{copy.rawTab}</button>
          </div>
          <button type="button" className="paper-reader-compare" aria-pressed={webReading}
            title={webReading
              ? t("返回 PDF 与讲解对照", "Return to the side-by-side PDF and explanation", "Volver a la vista del PDF junto a la explicación")
              : t("隐藏 PDF，用更宽的版面阅读讲解", "Hide the PDF and give the explanation a wider reading layout", "Oculta el PDF y da a la explicación un diseño de lectura más amplio")}
            onClick={() => setWebReading(value => !value)}>{webReading ? t("返回 PDF 对照", "Compare with PDF", "Comparar con el PDF") : t("专注阅读", "Focus view", "Vista de lectura")}</button>
        </div>
      </header>}
      {hasEssay && (busy || modelChanged || reviewMissing || view?.run.status !== "guide_ready") && <div className="paper-reader-task-notice" role="status">
        <span>{modelChanged ? (t("换模型将单独生成，原有结果保留。", "The new model generates a separate result; previous results are retained.", "El nuevo modelo genera un resultado aparte; los resultados anteriores se conservan.")) : !busy && reviewMissing && view?.run.status === "guide_ready" ? copy.reviewerMissing : `${busy ? status : copy.partial} · ${copy.stageTeach} ${completedLessons}/${guide?.lessons.length ?? 0}`}</span>
        {busy ? <button type="button" onClick={() => void cancel()}>{copy.cancel}</button> : <button type="button" onClick={() => void start()} disabled={!document || !projectId}>{label}</button>}
      </div>}
      {view && !resumable && <p className="lit-paper-analysis-note" role="note">{copy.legacy}</p>}
      {reviewMissing && !busy && !hasEssay && <p className="lit-paper-analysis-note">{copy.reviewerMissing}</p>}
      {!hasEssay && <>
      {view && <p className="lit-guide-paper-title">{view.run.title}</p>}
      {!view && <div className="lit-guide-welcome"><h3>{copy.intro}</h3><p>{copy.introDetail}</p></div>}
      {view && <div className="lit-guide-summary" aria-label={copy.progressTitle}>
        <div><span>{copy.stageRead}</span><strong>{pagesRead}<small> / {pageCoverage?.total ?? view.run.totalPages}</small></strong></div>
        <div><span>{copy.lessonCount}</span><strong>{guide?.lessons.length ? <>{completedLessons}<small> / {guide.lessons.length}</small></> : <small>{copy.notPlanned}</small>}</strong></div>
        <span className={`lit-guide-state${needsAttention ? " attention" : ""}`}>{status}</span>
      </div>}
      {modelPicker}
      {modelChanged && <p className="lit-paper-analysis-note">{t("换模型将单独生成，原有结果保留。", "The new model generates a separate result; previous results are retained.", "El nuevo modelo genera un resultado aparte; los resultados anteriores se conservan.")}</p>}
      <div className="lit-paper-analysis-actions">
        <button type="button" className="lit-paper-analysis-start" disabled={!document || !projectId || busy} onClick={() => void start()}>
          <SvgIcon name={busy ? "spinner" : "paperGuide"} size={18} /><span>{busy ? status : label}</span>
        </button>
        {busy && <button type="button" onClick={() => void cancel()}>{copy.cancel}</button>}
        {view && <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? copy.hide : copy.show}</button>}
      </div>
      {(!document || !projectId) && <p className="lit-paper-analysis-note" role="status">{!projectId
        ? t("选择项目后即可生成论文讲解。", "Choose a project to generate a paper guide.", "Elige un proyecto para generar una guía del artículo.")
        : t("PDF 加载完成后即可生成讲解。", "The PDF must finish loading before a guide can be generated.", "El PDF debe terminar de cargarse antes de generar una guía.")}</p>}
      {busy && <p role="status" className="lit-paper-analysis-progress">{status}{preparing ? " " + preparedPages + "/" + (view?.run.totalPages ?? document?.numPages ?? 0) : guideBusy === copy.teaching ? ` ${completedLessons}/${guide?.lessons.length ?? 0}` : view?.active && !guideBusy ? ` ${pagesRead}/${pageCoverage?.total ?? 0}` : ""}</p>}
      {view && <ol className="lit-guide-stages" aria-label={copy.progressTitle}>
        {[{ title: copy.stageRead, done: pagesRead === pageCoverage?.total, active: !!view.active && !guideBusy },
          { title: copy.stageOutline, done: !!guide?.outline.result, active: guide?.outline.status === "running" },
          { title: copy.stageTeach, done: !!guide?.lessons.length && completedLessons === guide.lessons.length, active: guideBusy === copy.teaching }]
          .map((stage, index) => <li key={stage.title} className={stage.done ? "done" : stage.active ? "active" : ""} aria-current={stage.active ? "step" : undefined}>
            <span aria-hidden="true">{stage.done ? "✓" : `0${index + 1}`}</span><strong>{stage.title}</strong>
          </li>)}
      </ol>}
      </>}
      {modelsError && <p className="lit-paper-analysis-note">{t("模型列表暂不可用，仍可使用当前模型。", "Model list unavailable. The current model remains usable.", "La lista de modelos no está disponible. Puedes seguir usando el modelo actual.")}</p>}
      {needsAttention && <section className="lit-guide-recovery" role="alert">
        <strong>{guide?.outline.status === "failed" ? copy.stageOutline : copy.heading} · {copy.attention}</strong>
        <p>{failure && /JSON|invalid type|sourcePages|cautions|invalid content/i.test(failure) ? copy.formatError : copy.otherError}</p>
        <p>{copy.saved}</p>
        {exhausted && <p>{copy.exhausted}</p>}
        {failure && <details><summary>{copy.details}</summary><pre>{failure}</pre></details>}
      </section>}
      {!view && <div className="lit-guide-features">
        {([[copy.figureTitle, copy.figureDetail, "image"], [copy.formulaTitle, copy.formulaDetail, "code"], [copy.experimentTitle, copy.experimentDetail, "graph"]] as Array<[string, string, SvgIconName]>).map(([title, detail, icon]) =>
          <article key={title}><span aria-hidden="true"><SvgIcon name={icon} size={18} /></span><div><h4>{title}</h4><p>{detail}</p></div></article>)}
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
            ? <PaperGuideView guide={guide} title={view.run.title} totalPages={view.run.totalPages} document={document} onJump={page => { setWebReading(false); onJump(page); }} language={language}
              followUps={followUps} onAsk={askGuide} onSaveNote={onSaveNote} />
            : null)}
          {tab === "raw" && textLayerPages > 0 && <div className="lit-paper-analysis-note">
            <p>{copy.textLayerNote(textLayerPages)}</p>
            {resumable && <button type="button" disabled={busy} onClick={() => void transcribeAll()}>{copy.transcribeAll}</button>}
          </div>}
          {tab === "raw" && view.run.pages.map(page => (
            <details key={page.pageIndex} className="lit-paper-analysis-page">
              <summary>{page.pageIndex + 1} / {view.run.totalPages} · {page.result ? copy.notReviewed : page.error ? copy.failed : page.status === "not_required" ? copy.textLayer : copy.pending}</summary>
              <button type="button" onClick={() => { setWebReading(false); onJump(page.pageIndex + 1); }}>{copy.source} {page.pageIndex + 1}</button>
              {page.error && <p className="lit-paper-analysis-error">{page.error}</p>}
              {!page.result && page.status !== "not_required" && <p>{copy.empty}</p>}
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
            <span>{copy.pageCoverage}: {pageCoverage?.completed}/{pageCoverage?.total} · {pageCoverage?.failed} {copy.failed}{pageCoverage?.notRequired ? ` · ${copy.textLayer} ${pageCoverage.notRequired}` : ""}</span>
            <span>{copy.candidates}: {(Object.keys(copy.kind) as PaperContentKind[]).map(kind => copy.kind[kind] + " " + (counts?.[kind] ?? 0)).join(" · ")}</span>
            <span>{copy.completeness}</span>
            <span>{guide?.lessons.length ? `${copy.stageTeach}: ${completedLessons}/${guide.lessons.length}` : copy.notTaught} · {guide?.reviewRequired && reviewCounts ? copy.reviewSummary(reviewCounts) : copy.notReviewed}</span>
          </details>
        </div>
      )}
    </aside>
  );
}
