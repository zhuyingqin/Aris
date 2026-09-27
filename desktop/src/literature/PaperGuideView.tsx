import { useEffect, useId, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { renderPdfPageToCanvas } from "../pdf/canvas";
import type { PaperGuide } from "./paperReadingApi";
import PaperReadingContent from "./PaperReadingContent";
import "./PaperGuideView.css";

const COPY = {
  zh: {
    storyline: "先看懂论文主线", topics: "结合原文深入理解", draft: "讲解草稿 · 尚未独立审核",
    source: "对照原文", page: "第", suffix: "页",
    previewFailed: "预览暂不可用，点击查看原页", intuition: "先建立直觉", notation: "符号与图示说明",
    assumptions: "适用前提", steps: "一步步理解", paper: "原文说明", teaching: "讲解补充",
    example: "简单例题：一步步算明白", exampleNote: "教学构造示例，不是论文实验结果", evidence: "原文支持什么",
    check: "检查自己是否理解", answer: "展开参考答案", caution: "需要留意", goal: "这个主题要理解什么",
    pending: "等待生成这个主题的讲解", running: "正在对照原图生成讲解…", failed: "这个主题尚未生成成功，可从上方继续重试。",
    overview: { problem: "研究什么问题", method: "方法为什么这样设计", evidence: "实验说明了什么", limitations: "结论的边界" },
    kind: { figure: "看懂方法图", formula: "理解关键公式", experiment: "读懂实验", concept: "理清概念" },
  },
  en: {
    storyline: "Follow the paper's argument", topics: "Understand with the original evidence", draft: "Explanation draft · Not independently reviewed",
    source: "Read original", page: "Page", suffix: "",
    previewFailed: "Preview unavailable; open the original page", intuition: "Build an intuition", notation: "Symbols and visual legend",
    assumptions: "Assumptions and scope", steps: "Step by step", paper: "From the paper", teaching: "Teaching addition",
    example: "A simple worked problem", exampleNote: "An illustrative teaching example, not a paper experiment", evidence: "What the evidence supports",
    check: "Check your understanding", answer: "Show the answer", caution: "Keep in mind", goal: "What you will learn",
    pending: "Waiting to explain this topic", running: "Reading the original images to explain this topic…", failed: "This topic could not be generated. Continue above to retry.",
    overview: { problem: "The research problem", method: "Why the method works this way", evidence: "What the experiments show", limitations: "Limits of the conclusions" },
    kind: { figure: "Understand a figure", formula: "Understand a formula", experiment: "Read the experiments", concept: "Clarify a concept" },
  },
};

function OriginalPage({ document, page, english, onJump }: {
  document: PDFDocumentProxy | null; page: number; english: boolean; onJump: (page: number) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  useEffect(() => {
    let disposed = false;
    let task: RenderTask | undefined;
    setState("loading");
    void (async () => {
      try {
        if (!document) throw new Error("No PDF");
        const original = await document.getPage(page);
        if (disposed || !canvas.current) return;
        const scale = 640 / original.getViewport({ scale: 1 }).width;
        task = renderPdfPageToCanvas(original, canvas.current, scale, { devicePixelRatio: 1.5, maxPixels: 2_000_000 }).task;
        await task.promise;
        if (!disposed) setState("ready");
      } catch { if (!disposed) setState("failed"); }
    })();
    return () => { disposed = true; task?.cancel(); };
  }, [document, page]);
  return <figure className="paper-essay-original">
    <div className="paper-essay-original-toolbar"><span>{english ? "ORIGINAL PAGE" : "原始页面"} / {page}</span>
      <button type="button" onClick={() => onJump(page)}>{english ? "Locate in PDF" : "在 PDF 中定位"} ↗</button>
    </div>
    {state !== "ready" && <p role="status">{state === "loading" ? (english ? "Loading original…" : "正在载入原图…") : COPY[english ? "en" : "zh"].previewFailed}</p>}
    <div className="paper-essay-page-scroll" hidden={state !== "ready"}><canvas ref={canvas} aria-label={english ? `Original PDF page ${page}` : `PDF 原文第 ${page} 页`} /></div>
    <figcaption>{english ? "Original PDF page. Scroll to inspect the full page." : "来自原始 PDF，可滚动查看完整页面。"}</figcaption>
  </figure>;
}

export default function PaperGuideView({ guide, document, onJump, language, title, totalPages }: {
  guide: PaperGuide; document: PDFDocumentProxy | null; onJump: (page: number) => void; language: string; title?: string; totalPages?: number;
}) {
  const english = language === "en";
  const copy = COPY[english ? "en" : "zh"];
  const [selected, setSelected] = useState(-1);
  const [sourcePage, setSourcePage] = useState<number | null>(null);
  const anchor = useId();
  const main = useRef<HTMLElement>(null);
  const current = selected >= 0 ? guide.lessons[selected] : undefined;
  const lesson = current?.task.result;
  const outline = guide.outline.result;
  const scrollWithinPanel = (target: Element | null | undefined) => {
    const panel = main.current?.closest<HTMLElement>(".lit-paper-analysis");
    if (!panel || !target) return;
    const top = panel.scrollTop + target.getBoundingClientRect().top
      - panel.getBoundingClientRect().top - panel.clientTop - 26;
    if (typeof panel.scrollTo === "function") panel.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    else panel.scrollTop = Math.max(0, top);
  };
  const changeTopic = (index: number) => {
    setSelected(index);
    const topic = guide.lessons[index]?.topic;
    setSourcePage(topic && (topic.kind === "figure" || topic.kind === "experiment") ? topic.sourcePages[0] : null);
    scrollWithinPanel(main.current);
  };
  const sources = (pages: number[]) => <div className="paper-essay-sources">
    <span>{english ? "SOURCE" : "原文"}</span>
    {pages.map(page => <button key={page} type="button" onClick={() => onJump(page)} aria-label={`${copy.source} ${page}`}>{english ? `p. ${page}` : `第 ${page} 页`} ↗</button>)}
  </div>;
  const completed = guide.lessons.filter(item => item.task.status === "completed").length;
  const problem = outline?.overview.find(section => section.kind === "problem");
  const sectionLink = (section: string, label: string) => <a href={`#${anchor}-${section}`} onClick={event => {
    event.preventDefault(); scrollWithinPanel(main.current?.querySelector(`[data-section="${section}"]`));
  }}>{label}</a>;

  return <div className="paper-essay">
    <nav className="paper-essay-contents" aria-label={english ? "Reading contents" : "阅读目录"}>
      <p className="paper-essay-nav-label">{english ? "READING PATH" : "阅读路线"}</p>
      <button type="button" className={selected === -1 ? "is-current" : ""} aria-current={selected === -1 ? "page" : undefined} onClick={() => changeTopic(-1)}><span>00</span><strong>{english ? "The paper at a glance" : "先看懂论文主线"}</strong></button>
      {guide.lessons.map(({ topic, task }, index) => <button type="button" key={index} className={selected === index ? "is-current" : ""} aria-current={selected === index ? "page" : undefined} onClick={() => changeTopic(index)}>
        <span>{String(index + 1).padStart(2, "0")}</span><div><strong>{topic.title}</strong><small>{copy.kind[topic.kind]}{task.status === "failed" ? (english ? " · Retry needed" : " · 待重试") : task.status === "running" ? (english ? " · Generating" : " · 生成中") : task.status === "pending" ? (english ? " · Pending" : " · 待生成") : ""}</small></div>
      </button>)}
      <div className="paper-essay-nav-foot"><span>{english ? "EXPLANATIONS" : "主题讲解"}</span><strong>{completed} / {guide.lessons.length}</strong>{totalPages && <p>{totalPages} {english ? "original pages" : "页原文"}</p>}</div>
    </nav>
    <label className="paper-essay-mobile-nav">{english ? "Read" : "阅读章节"}<select value={selected} onChange={event => changeTopic(Number(event.target.value))}>
      <option value={-1}>{copy.storyline}</option>{guide.lessons.map(({ topic }, index) => <option key={index} value={index}>{String(index + 1).padStart(2, "0")} · {topic.title}</option>)}
    </select></label>
    <main ref={main} className="paper-essay-main" tabIndex={-1}>
      <div className="paper-essay-meta"><span>{selected === -1 ? (english ? "PAPER / OVERVIEW" : "论文导读") : `${String(selected + 1).padStart(2, "0")} / ${current ? copy.kind[current.topic.kind] : ""}`}</span><span>{copy.draft}</span></div>
      {!current && outline && <article className="paper-essay-overview" aria-label={copy.storyline}>
        <header><h1>{title || (english ? "Understand the argument behind the paper." : "读懂论文，也读懂它的依据。")}</h1>
          {problem && <div className="paper-essay-deck"><PaperReadingContent content={problem.content} /></div>}
          {problem && sources(problem.sourcePages)}
        </header>
        <div className="paper-essay-rule"><span>{english ? "THE ARGUMENT" : "论文脉络"}</span></div>
        {outline.overview.filter(section => section.kind !== "problem").map((section, index) => <section className="paper-essay-overview-section" key={section.kind}>
          <span className="paper-essay-section-number">{String(index + 1).padStart(2, "0")}</span><div><h2>{copy.overview[section.kind]}</h2><PaperReadingContent content={section.content} />{sources(section.sourcePages)}</div>
        </section>)}
        {outline.cautions.length > 0 && <details className="paper-essay-cautions"><summary>{copy.caution}</summary>{outline.cautions.map((text, index) => <PaperReadingContent key={index} content={text} />)}</details>}
        {guide.lessons.length > 0 && <button type="button" className="paper-essay-next" onClick={() => changeTopic(0)}><span>{english ? "START READING" : "开始深入理解"}</span><strong>{guide.lessons[0].topic.title}</strong><b aria-hidden="true">→</b></button>}
      </article>}
      {current && <article className="paper-essay-chapter" key={selected}>
        <header><h1>{current.topic.title}</h1><div className="paper-essay-deck"><PaperReadingContent content={current.topic.learningGoal} /></div>{sources(current.topic.sourcePages)}</header>
        <div className="paper-essay-chapter-tools">
          <nav aria-label={english ? "On this page" : "本节目录"}>{lesson && <>{sectionLink("intuition", copy.intuition)}{sectionLink("steps", copy.steps)}{sectionLink("check", copy.check)}</>}</nav>
          <button type="button" aria-expanded={sourcePage !== null} onClick={() => setSourcePage(sourcePage === null ? current.topic.sourcePages[0] : null)}>{sourcePage === null ? (english ? "View original image" : "查看原图") : (english ? "Close original image" : "收起原图")}</button>
        </div>
        {sourcePage !== null && <section aria-label={english ? "Original evidence" : "原文对照"} className="paper-essay-evidence-viewer">
          {current.topic.sourcePages.length > 1 && <div className="paper-essay-page-picker">{current.topic.sourcePages.map(page => <button key={page} type="button" aria-pressed={sourcePage === page} onClick={() => setSourcePage(page)}>{copy.page} {page} {copy.suffix}</button>)}</div>}
          <OriginalPage document={document} page={sourcePage} english={english} onJump={onJump} />
        </section>}
        {!lesson && <p role="status" className="paper-essay-pending">{current.task.status === "running" ? copy.running : current.task.status === "failed" ? copy.failed : copy.pending}</p>}
        {current.task.error && <details className="paper-essay-cautions"><summary>{english ? "Error details" : "查看错误详情"}</summary><pre>{current.task.error}</pre></details>}
        {lesson && <>
          <section className="paper-essay-intuition" id={`${anchor}-intuition`} data-section="intuition"><h2>{copy.intuition}</h2><PaperReadingContent content={lesson.intuition} /></section>
          {(lesson.notation || lesson.assumptions) && <div className="paper-essay-foundations">
            {lesson.notation && <section><h3>{copy.notation}</h3><PaperReadingContent content={lesson.notation} /></section>}
            {lesson.assumptions && <section><h3>{copy.assumptions}</h3><PaperReadingContent content={lesson.assumptions} /></section>}
          </div>}
          <section className="paper-essay-derivation" id={`${anchor}-steps`} data-section="steps"><h2>{copy.steps}</h2><ol>{lesson.steps.map((step, index) => <li key={index}>
            <div className="paper-essay-step-number">{String(index + 1).padStart(2, "0")}</div><div><header><h3>{step.title}</h3><span>{step.origin === "paper" ? copy.paper : copy.teaching}</span></header><PaperReadingContent content={step.explanation} /></div>
          </li>)}</ol></section>
          {lesson.example && <section className="paper-essay-example"><span className="paper-essay-eyebrow">{english ? "WORKED EXAMPLE" : "推演一个例子"}</span><h2>{copy.example}</h2><PaperReadingContent content={lesson.example} /><p className="paper-essay-caption">{copy.exampleNote}</p></section>}
          <section className="paper-essay-evidence"><h2>{copy.evidence}</h2><PaperReadingContent content={lesson.evidence} />{sources(lesson.sourcePages)}</section>
          <section className="paper-essay-check" id={`${anchor}-check`} data-section="check"><span className="paper-essay-eyebrow">{english ? "PAUSE & THINK" : "停下来，想一想"}</span><h2>{copy.check}</h2><PaperReadingContent content={lesson.checkQuestion} /><details><summary>{copy.answer}</summary><PaperReadingContent content={lesson.checkAnswer} /></details></section>
          {lesson.cautions.length > 0 && <details className="paper-essay-cautions"><summary>{copy.caution}</summary>{lesson.cautions.map((text, index) => <PaperReadingContent key={index} content={text} />)}</details>}
        </>}
        <footer className="paper-essay-pagination"><button type="button" onClick={() => changeTopic(selected - 1)}>← {selected === 0 ? (english ? "Overview" : "论文主线") : (english ? "Previous topic" : "上一主题")}</button>{selected + 1 < guide.lessons.length && <button type="button" onClick={() => changeTopic(selected + 1)}>{english ? "Next topic" : "下一主题"} →</button>}</footer>
      </article>}
    </main>
  </div>;
}
