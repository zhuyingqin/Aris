import { useEffect, useId, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { renderPdfPageToCanvas } from "../pdf/canvas";
import type { FollowUpMode, GuideLesson, GuideLessonEntry, PaperFollowUp, PaperGuide, TopicLevel } from "./paperReadingApi";
import { currentLesson, finalReview } from "./paperGuideModel";
import PaperReadingContent from "./PaperReadingContent";
import PaperGuideDiagram, { diagramMarkdown } from "./PaperGuideDiagram";
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
    oneSentence: "一句话看懂这篇论文", atGlance: "一图看懂论文", diagram: "看图理解", plainSummary: "一句话看懂", analogy: "打个比方", prerequisites: "先补基础",
    misconceptions: "容易想错的地方", wrong: "误区", right: "正解", glossary: "关键术语：先认识这些词",
    readingPath: "阅读路线：由浅入深", relevance: "和你的研究有什么关系", prereqLabel: "先读懂",
    levels: { foundation: "打基础", core: "核心思想", advanced: "深入细节" } as Record<TopicLevel, string>,
    depth: "阅读深度", depthBasic: "入门", depthFull: "完整",
    goDeeper: "继续深入：符号、推导与原文证据", goDeeperNote: "入门部分讲完了。准备好后，再看符号、逐步推导和原文依据。",
    startLearning: "从基础开始学习", reviewTitle: "独立审核", reviewer: "审核模型",
    severity: { critical: "严重", major: "重要", minor: "次要" },
    review: {
      pass: "独立审核通过", revisedPass: "已按审核意见修订 · 复核通过", needsRevision: "独立审核发现问题",
      revisedIssues: "修订后仍有审核问题", revising: "正在按审核意见修订…", insufficient: "原文文本不足以核对",
      unavailable: "未经独立审核", pending: "等待独立审核",
    },
    reviewNote: "审核模型只能看到原文文本，看不到图片；图表相关内容请对照原图。",
    ask: {
      title: "还没懂？继续问", simpler: "讲得更简单", example: "再举个例子", why: "为什么成立",
      placeholder: "输入你的问题，例如：这里的每个符号分别代表什么？", send: "提问", asking: "正在对照原文回答…",
      focus: "针对", step: "这一步没懂？", section: "没看懂？", failed: "回答失败：",
      note: "回答由模型对照原文页面生成，属于讲解草稿。", you: "你问", modeLabel: { simpler: "讲得更简单", example: "再举个例子", why: "为什么成立", question: "提问" } as Record<FollowUpMode, string>,
    },
    saveNote: "保存到笔记", savedNote: "已保存到文献笔记",
    noteSource: (pages: string, status: string) => `来源：SomniQ 论文讲解（PDF 第 ${pages} 页）· ${status}`,
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
    oneSentence: "The paper in one sentence", atGlance: "The paper at a glance", diagram: "See it in a picture", plainSummary: "In plain words", analogy: "An analogy", prerequisites: "Background first",
    misconceptions: "Easy to get wrong", wrong: "Misconception", right: "Correction", glossary: "Key terms to know first",
    readingPath: "Reading path: simple to deep", relevance: "Why it may matter for your research", prereqLabel: "First understand",
    levels: { foundation: "Foundations", core: "Core idea", advanced: "Going deeper" } as Record<TopicLevel, string>,
    depth: "Reading depth", depthBasic: "Essentials", depthFull: "Full",
    goDeeper: "Go deeper: notation, derivation and evidence", goDeeperNote: "That covers the essentials. When ready, continue with the symbols, the step-by-step reasoning and the original evidence.",
    startLearning: "Start with the foundations", reviewTitle: "Independent review", reviewer: "Reviewer model",
    severity: { critical: "Critical", major: "Major", minor: "Minor" },
    review: {
      pass: "Passed independent review", revisedPass: "Revised after review · passed re-check", needsRevision: "Independent review found issues",
      revisedIssues: "Issues remain after revision", revising: "Revising after review…", insufficient: "Original text insufficient to verify",
      unavailable: "Not independently reviewed", pending: "Awaiting independent review",
    },
    reviewNote: "The Reviewer sees the original text but not images; check figure-related content against the original page.",
    ask: {
      title: "Still unclear? Ask", simpler: "Explain more simply", example: "Another example", why: "Why does it hold?",
      placeholder: "Ask a question, e.g. what does each symbol here mean?", send: "Ask", asking: "Answering from the original pages…",
      focus: "About", step: "Lost here?", section: "Unclear?", failed: "Could not answer: ",
      note: "Answers are generated from the original pages and are explanation drafts.", you: "You asked", modeLabel: { simpler: "Explain more simply", example: "Another example", why: "Why does it hold?", question: "Question" } as Record<FollowUpMode, string>,
    },
    saveNote: "Save to notes", savedNote: "Saved to paper notes",
    noteSource: (pages: string, status: string) => `Source: SomniQ paper guide (PDF pages ${pages}) · ${status}`,
  },
};
type Copy = typeof COPY.zh;
type AskRequest = { target: string; mode: FollowUpMode; question?: string; focus?: string };

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

/** Reader-facing review state. Only an independent Reviewer verdict counts. */
function reviewBadge(entry: GuideLessonEntry, reviewRequired: boolean, copy: Copy): { tone: string; label: string } | null {
  if (!reviewRequired || !currentLesson(entry)) return null;
  const review = finalReview(entry);
  const revised = !!entry.revision?.result;
  if (!review) return { tone: "pending", label: copy.review.pending };
  if (review.verdict === "pass") return { tone: "pass", label: revised ? copy.review.revisedPass : copy.review.pass };
  if (review.verdict === "needs_revision") {
    if (!revised && entry.revision && entry.revision.status !== "failed") return { tone: "pending", label: copy.review.revising };
    return { tone: "warn", label: revised ? copy.review.revisedIssues : copy.review.needsRevision };
  }
  return { tone: "muted", label: review.verdict === "insufficient_evidence" ? copy.review.insufficient : copy.review.unavailable };
}

function lessonMarkdown(entry: GuideLessonEntry, lesson: GuideLesson, copy: Copy, status: string) {
  const parts = [
    `# ${entry.topic.title}`, `> ${entry.topic.learningGoal}`,
    lesson.plainSummary && `## ${copy.plainSummary}\n\n${lesson.plainSummary}`,
    lesson.analogy && `## ${copy.analogy}\n\n${lesson.analogy}`,
    lesson.prerequisites?.length && `## ${copy.prerequisites}\n\n${lesson.prerequisites.map(item => `- **${item.concept}**：${item.explanation}`).join("\n")}`,
    `## ${copy.intuition}\n\n${lesson.intuition}`,
    lesson.diagram && `## ${copy.diagram}\n\n${diagramMarkdown(lesson.diagram)}`,
    lesson.notation && `## ${copy.notation}\n\n${lesson.notation}`,
    lesson.assumptions && `## ${copy.assumptions}\n\n${lesson.assumptions}`,
    `## ${copy.steps}\n\n${lesson.steps.map((step, index) => `### ${index + 1}. ${step.title}（${step.origin === "paper" ? copy.paper : copy.teaching}）\n\n${step.explanation}`).join("\n\n")}`,
    lesson.example && `## ${copy.example}\n\n${lesson.example}\n\n_${copy.exampleNote}_`,
    lesson.misconceptions?.length && `## ${copy.misconceptions}\n\n${lesson.misconceptions.map(item => `- ${copy.wrong}：${item.misconception}\n  ${copy.right}：${item.correction}`).join("\n")}`,
    `## ${copy.evidence}\n\n${lesson.evidence}`,
    `## ${copy.check}\n\n${lesson.checkQuestion}\n\n${lesson.checkAnswer}`,
    `---\n${copy.noteSource(lesson.sourcePages.join(", "), status)}`,
  ];
  return parts.filter(Boolean).join("\n\n");
}

function Answers({ items, copy }: { items: PaperFollowUp[]; copy: Copy }) {
  if (!items.length) return null;
  return <ol className="paper-essay-answers">{items.map(item => <li key={item.id}>
    <p className="paper-essay-question"><span>{copy.ask.you}</span>{item.question || copy.ask.modeLabel[item.mode]}{item.focus && <small> · {copy.ask.focus}「{item.focus}」</small>}</p>
    <PaperReadingContent content={item.answer} />
  </li>)}</ol>;
}

export default function PaperGuideView({ guide, document, onJump, language, title, totalPages, followUps = [], onAsk, onSaveNote }: {
  guide: PaperGuide; document: PDFDocumentProxy | null; onJump: (page: number) => void; language: string; title?: string; totalPages?: number;
  followUps?: PaperFollowUp[];
  onAsk?: (request: AskRequest) => Promise<unknown>;
  onSaveNote?: (note: { title: string; content: string }) => void;
}) {
  const english = language === "en";
  const copy = COPY[english ? "en" : "zh"];
  const [selected, setSelected] = useState(-1);
  const [sourcePage, setSourcePage] = useState<number | null>(null);
  const [depth, setDepth] = useState<"basic" | "full">("basic");
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState<string | null>(null);
  const [askError, setAskError] = useState("");
  const [savedTarget, setSavedTarget] = useState<string | null>(null);
  const anchor = useId();
  const main = useRef<HTMLElement>(null);
  const current = selected >= 0 ? guide.lessons[selected] : undefined;
  const lesson = current ? currentLesson(current) : null;
  const outline = guide.outline.result;
  const reviewRequired = !!guide.reviewRequired;
  const target = selected >= 0 ? `lesson:${selected}` : "overview";
  const targetFollowUps = followUps.filter(item => item.target === target);
  const layered = !!lesson?.plainSummary;
  const full = !layered || depth === "full";
  const scrollWithinPanel = (element: Element | null | undefined) => {
    const panel = main.current?.closest<HTMLElement>(".lit-paper-analysis");
    if (!panel || !element) return;
    const top = panel.scrollTop + element.getBoundingClientRect().top
      - panel.getBoundingClientRect().top - panel.clientTop - 26;
    if (typeof panel.scrollTo === "function") panel.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    else panel.scrollTop = Math.max(0, top);
  };
  const changeTopic = (index: number) => {
    setSelected(index);
    setQuestion("");
    setAskError("");
    const topic = guide.lessons[index]?.topic;
    setSourcePage(topic && (topic.kind === "figure" || topic.kind === "experiment") ? topic.sourcePages[0] : null);
    scrollWithinPanel(main.current);
  };
  const ask = async (mode: FollowUpMode, focus?: string, text?: string) => {
    if (!onAsk || asking) return;
    const key = focus ?? "";
    setAsking(key);
    setAskError("");
    try {
      await onAsk({ target, mode, question: text, focus });
      if (mode === "question") setQuestion("");
    } catch (reason) {
      setAskError(String(reason));
    } finally {
      setAsking(null);
    }
  };
  const helpButton = (focus: string, label = copy.ask.section) => onAsk ? <button type="button" className="paper-essay-help" disabled={asking !== null} onClick={() => void ask("simpler", focus)}>{asking === focus ? copy.ask.asking : label}</button> : null;
  const inlineAnswers = (focus: string) => <Answers items={targetFollowUps.filter(item => item.focus === focus)} copy={copy} />;
  const sources = (pages: number[]) => <div className="paper-essay-sources">
    <span>{english ? "SOURCE" : "原文"}</span>
    {pages.map(page => <button key={page} type="button" onClick={() => onJump(page)} aria-label={`${copy.source} ${page}`}>{english ? `p. ${page}` : `第 ${page} 页`} ↗</button>)}
  </div>;
  const completed = guide.lessons.filter(item => currentLesson(item)).length;
  const problem = outline?.overview.find(section => section.kind === "problem");
  const sectionLink = (section: string, label: string) => <a href={`#${anchor}-${section}`} onClick={event => {
    event.preventDefault(); scrollWithinPanel(main.current?.querySelector(`[data-section="${section}"]`));
  }}>{label}</a>;
  const levelGroups = (["foundation", "core", "advanced"] as TopicLevel[])
    .map(level => ({ level, items: guide.lessons.map((entry, index) => ({ entry, index })).filter(({ entry }) => (entry.topic.level ?? null) === level) }))
    .filter(group => group.items.length);
  const leveled = levelGroups.length > 0;
  const badge = current ? reviewBadge(current, reviewRequired, copy) : null;
  const review = current ? finalReview(current) : null;
  const inlineFocuses = new Set([copy.plainSummary, copy.analogy, copy.prerequisites, copy.intuition, copy.example, copy.misconceptions, copy.oneSentence, ...(lesson?.steps.map(step => step.title) ?? [])]);
  const navItem = ({ entry, index }: { entry: GuideLessonEntry; index: number }) => {
    const status = entry.task.status === "failed" && !currentLesson(entry) ? (english ? " · Retry needed" : " · 待重试")
      : entry.task.status === "running" ? (english ? " · Generating" : " · 生成中")
      : entry.task.status === "pending" ? (english ? " · Pending" : " · 待生成") : "";
    const mark = reviewBadge(entry, reviewRequired, copy);
    return <button type="button" key={index} className={selected === index ? "is-current" : ""} aria-current={selected === index ? "page" : undefined} onClick={() => changeTopic(index)}>
      <span>{String(index + 1).padStart(2, "0")}</span><div><strong>{entry.topic.title}</strong><small>{copy.kind[entry.topic.kind]}{status}{mark && <i className={`paper-essay-review-dot is-${mark.tone}`} title={mark.label} aria-label={mark.label} />}</small></div>
    </button>;
  };

  return <div className="paper-essay">
    <nav className="paper-essay-contents" aria-label={english ? "Reading contents" : "阅读目录"}>
      <p className="paper-essay-nav-label">{english ? "READING PATH" : "阅读路线"}</p>
      <button type="button" className={selected === -1 ? "is-current" : ""} aria-current={selected === -1 ? "page" : undefined} onClick={() => changeTopic(-1)}><span>00</span><strong>{english ? "The paper at a glance" : "先看懂论文主线"}</strong></button>
      {leveled ? levelGroups.map(group => <div key={group.level} className="paper-essay-nav-group"><p className="paper-essay-nav-level">{copy.levels[group.level]}</p>{group.items.map(navItem)}</div>)
        : guide.lessons.map((entry, index) => navItem({ entry, index }))}
      <div className="paper-essay-nav-foot"><span>{english ? "EXPLANATIONS" : "主题讲解"}</span><strong>{completed} / {guide.lessons.length}</strong>{totalPages && <p>{totalPages} {english ? "original pages" : "页原文"}</p>}</div>
    </nav>
    <label className="paper-essay-mobile-nav">{english ? "Read" : "阅读章节"}<select value={selected} onChange={event => changeTopic(Number(event.target.value))}>
      <option value={-1}>{copy.storyline}</option>{guide.lessons.map(({ topic }, index) => <option key={index} value={index}>{String(index + 1).padStart(2, "0")} · {topic.level ? `${copy.levels[topic.level]} · ` : ""}{topic.title}</option>)}
    </select></label>
    <main ref={main} className="paper-essay-main" tabIndex={-1}>
      <div className="paper-essay-meta"><span>{selected === -1 ? (english ? "PAPER / OVERVIEW" : "论文导读") : `${String(selected + 1).padStart(2, "0")} / ${current ? copy.kind[current.topic.kind] : ""}`}</span>{badge ? <span className={`paper-essay-review-badge is-${badge.tone}`}>{badge.label}</span> : <span>{copy.draft}</span>}</div>
      {!current && outline && <article className="paper-essay-overview" aria-label={copy.storyline}>
        <header><h1>{title || (english ? "Understand the argument behind the paper." : "读懂论文，也读懂它的依据。")}</h1>
          {outline.oneSentence ? <div className="paper-essay-one-sentence"><span className="paper-essay-eyebrow">{copy.oneSentence}</span><PaperReadingContent content={outline.oneSentence} /></div>
            : problem && <><div className="paper-essay-deck"><PaperReadingContent content={problem.content} readableProse /></div>{sources(problem.sourcePages)}</>}
        </header>
        {outline.relevance && <aside className="paper-essay-relevance"><span className="paper-essay-eyebrow">{copy.relevance}</span><PaperReadingContent content={outline.relevance} /></aside>}
        {outline.diagram && <PaperGuideDiagram diagram={outline.diagram} english={english} eyebrow={copy.atGlance} />}
        <div className="paper-essay-rule"><span>{english ? "THE ARGUMENT" : "论文脉络"}</span></div>
        {outline.overview.filter(section => outline.oneSentence || section.kind !== "problem").map((section, index) => <section className="paper-essay-overview-section" key={section.kind}>
          <span className="paper-essay-section-number">{String(index + 1).padStart(2, "0")}</span><div><h2>{copy.overview[section.kind]}</h2><PaperReadingContent content={section.content} readableProse />{sources(section.sourcePages)}</div>
        </section>)}
        {!!outline.glossary?.length && <section className="paper-essay-glossary" aria-label={copy.glossary}>
          <h2>{copy.glossary}</h2>
          <dl>{outline.glossary.map(term => <div key={term.term}><dt>{term.term}</dt><dd><PaperReadingContent content={term.plain} />{term.sourcePages.length > 0 && sources(term.sourcePages)}</dd></div>)}</dl>
        </section>}
        {leveled && <section className="paper-essay-path" aria-label={copy.readingPath}>
          <h2>{copy.readingPath}</h2>
          <ol>{levelGroups.map(group => <li key={group.level}><span className="paper-essay-level">{copy.levels[group.level]}</span>
            <ul>{group.items.map(({ entry, index }) => <li key={index}><button type="button" onClick={() => changeTopic(index)}><strong>{entry.topic.title}</strong><span>{entry.topic.learningGoal}</span></button>
              {!!entry.topic.prerequisites?.length && <small>{copy.prereqLabel}：{entry.topic.prerequisites.join("、")}</small>}</li>)}</ul>
          </li>)}</ol>
        </section>}
        {outline.cautions.length > 0 && <details className="paper-essay-cautions"><summary>{copy.caution}</summary>{outline.cautions.map((text, index) => <PaperReadingContent key={index} content={text} />)}</details>}
        {guide.lessons.length > 0 && <button type="button" className="paper-essay-next" onClick={() => changeTopic(0)}><span>{leveled ? copy.startLearning : english ? "START READING" : "开始深入理解"}</span><strong>{guide.lessons[0].topic.title}</strong><b aria-hidden="true">→</b></button>}
      </article>}
      {current && <article className="paper-essay-chapter" key={selected}>
        <header><h1>{current.topic.title}</h1><div className="paper-essay-deck"><PaperReadingContent content={current.topic.learningGoal} /></div>
          {(current.topic.level || !!current.topic.prerequisites?.length) && <p className="paper-essay-topic-path">{current.topic.level && <span className="paper-essay-level">{copy.levels[current.topic.level]}</span>}{!!current.topic.prerequisites?.length && <span>{copy.prereqLabel}：{current.topic.prerequisites.join("、")}</span>}</p>}
          {sources(current.topic.sourcePages)}</header>
        <div className="paper-essay-chapter-tools">
          <nav aria-label={english ? "On this page" : "本节目录"}>{lesson && <>{sectionLink("intuition", layered ? copy.plainSummary : copy.intuition)}{full && sectionLink("steps", copy.steps)}{sectionLink("check", copy.check)}{onAsk && sectionLink("ask", copy.ask.title)}</>}</nav>
          <div className="paper-essay-chapter-actions">
            {layered && <div className="paper-essay-depth" role="group" aria-label={copy.depth}>
              <button type="button" aria-pressed={depth === "basic"} onClick={() => setDepth("basic")}>{copy.depthBasic}</button>
              <button type="button" aria-pressed={depth === "full"} onClick={() => setDepth("full")}>{copy.depthFull}</button>
            </div>}
            {lesson && onSaveNote && <button type="button" onClick={() => { onSaveNote({ title: current.topic.title, content: lessonMarkdown(current, lesson, copy, badge?.label ?? copy.draft) }); setSavedTarget(target); }}>{savedTarget === target ? copy.savedNote : copy.saveNote}</button>}
            <button type="button" aria-expanded={sourcePage !== null} onClick={() => setSourcePage(sourcePage === null ? current.topic.sourcePages[0] : null)}>{sourcePage === null ? (english ? "View original image" : "查看原图") : (english ? "Close original image" : "收起原图")}</button>
          </div>
        </div>
        {sourcePage !== null && <section aria-label={english ? "Original evidence" : "原文对照"} className="paper-essay-evidence-viewer">
          {current.topic.sourcePages.length > 1 && <div className="paper-essay-page-picker">{current.topic.sourcePages.map(page => <button key={page} type="button" aria-pressed={sourcePage === page} onClick={() => setSourcePage(page)}>{copy.page} {page} {copy.suffix}</button>)}</div>}
          <OriginalPage document={document} page={sourcePage} english={english} onJump={onJump} />
        </section>}
        {!lesson && <p role="status" className="paper-essay-pending">{current.task.status === "running" ? copy.running : current.task.status === "failed" ? copy.failed : copy.pending}</p>}
        {current.task.error && !lesson && <details className="paper-essay-cautions"><summary>{english ? "Error details" : "查看错误详情"}</summary><pre>{current.task.error}</pre></details>}
        {lesson && <>
          {layered && <section className="paper-essay-plain" id={`${anchor}-intuition`} data-section="intuition">
            <header className="paper-essay-layer-head"><span className="paper-essay-layer">01</span><h2>{copy.plainSummary}</h2>{helpButton(copy.plainSummary)}</header>
            <PaperReadingContent content={lesson.plainSummary ?? ""} />{inlineAnswers(copy.plainSummary)}
          </section>}
          {layered && lesson.analogy && <section className="paper-essay-analogy">
            <header className="paper-essay-layer-head"><span className="paper-essay-layer">02</span><h2>{copy.analogy}</h2>{helpButton(copy.analogy)}</header>
            <PaperReadingContent content={lesson.analogy} />{inlineAnswers(copy.analogy)}
          </section>}
          {layered && !!lesson.prerequisites?.length && <section className="paper-essay-prerequisites">
            <header className="paper-essay-layer-head"><span className="paper-essay-layer">03</span><h2>{copy.prerequisites}</h2>{helpButton(copy.prerequisites)}</header>
            <dl>{lesson.prerequisites.map(item => <div key={item.concept}><dt>{item.concept}</dt><dd><PaperReadingContent content={item.explanation} /></dd></div>)}</dl>{inlineAnswers(copy.prerequisites)}
          </section>}
          <section className="paper-essay-intuition" {...(layered ? {} : { id: `${anchor}-intuition`, "data-section": "intuition" })}><h2>{copy.intuition}</h2><PaperReadingContent content={lesson.intuition} />{layered && inlineAnswers(copy.intuition)}</section>
          {lesson.diagram && <PaperGuideDiagram diagram={lesson.diagram} english={english} eyebrow={copy.diagram} />}
          {full && (lesson.notation || lesson.assumptions) && <div className="paper-essay-foundations">
            {lesson.notation && <section><h3>{copy.notation}</h3><PaperReadingContent content={lesson.notation} /></section>}
            {lesson.assumptions && <section><h3>{copy.assumptions}</h3><PaperReadingContent content={lesson.assumptions} /></section>}
          </div>}
          {full && <section className="paper-essay-derivation" id={`${anchor}-steps`} data-section="steps"><h2>{copy.steps}</h2><ol>{lesson.steps.map((step, index) => <li key={index}>
            <div className="paper-essay-step-number">{String(index + 1).padStart(2, "0")}</div><div><header><h3>{step.title}</h3><span>{step.origin === "paper" ? copy.paper : copy.teaching}</span>{helpButton(step.title, copy.ask.step)}</header><PaperReadingContent content={step.explanation} />{inlineAnswers(step.title)}</div>
          </li>)}</ol></section>}
          {lesson.example && <section className="paper-essay-example"><span className="paper-essay-eyebrow">{english ? "WORKED EXAMPLE" : "推演一个例子"}</span><h2>{copy.example}</h2><PaperReadingContent content={lesson.example} /><p className="paper-essay-caption">{copy.exampleNote}</p>{onAsk && <div className="paper-essay-help-row">{helpButton(copy.example)}</div>}{inlineAnswers(copy.example)}</section>}
          {layered && !!lesson.misconceptions?.length && <section className="paper-essay-misconceptions"><h2>{copy.misconceptions}</h2>
            <ul>{lesson.misconceptions.map((item, index) => <li key={index}><div><span className="is-wrong">{copy.wrong}</span><PaperReadingContent content={item.misconception} /></div><div><span className="is-right">{copy.right}</span><PaperReadingContent content={item.correction} /></div></li>)}</ul>
          </section>}
          {!full && <section className="paper-essay-deeper"><p>{copy.goDeeperNote}</p><button type="button" onClick={() => { setDepth("full"); window.setTimeout(() => scrollWithinPanel(main.current?.querySelector('[data-section="steps"]')), 0); }}>{copy.goDeeper} ↓</button></section>}
          {full && <section className="paper-essay-evidence"><h2>{copy.evidence}</h2><PaperReadingContent content={lesson.evidence} readableProse />{sources(lesson.sourcePages)}</section>}
          <section className="paper-essay-check" id={`${anchor}-check`} data-section="check"><span className="paper-essay-eyebrow">{english ? "PAUSE & THINK" : "停下来，想一想"}</span><h2>{copy.check}</h2><PaperReadingContent content={lesson.checkQuestion} /><details><summary>{copy.answer}</summary><PaperReadingContent content={lesson.checkAnswer} /></details></section>
          {lesson.cautions.length > 0 && <details className="paper-essay-cautions"><summary>{copy.caution}</summary>{lesson.cautions.map((text, index) => <PaperReadingContent key={index} content={text} />)}</details>}
          {review && <details className="paper-essay-review" open={review.verdict === "needs_revision"}>
            <summary>{copy.reviewTitle} · {badge?.label}</summary>
            <p>{review.summary}</p>
            {review.reviewer && <p className="paper-essay-caption">{copy.reviewer}：{review.reviewer}</p>}
            {review.issues.length > 0 && <ul>{review.issues.map((issue, index) => <li key={index} className={`is-${issue.severity}`}><strong>{copy.severity[issue.severity]} · {issue.location}</strong><PaperReadingContent content={issue.problem} />{issue.suggestion && <PaperReadingContent content={issue.suggestion} />}</li>)}</ul>}
            <p className="paper-essay-caption">{copy.reviewNote}</p>
          </details>}
        </>}
        <footer className="paper-essay-pagination"><button type="button" onClick={() => changeTopic(selected - 1)}>← {selected === 0 ? (english ? "Overview" : "论文主线") : (english ? "Previous topic" : "上一主题")}</button>{selected + 1 < guide.lessons.length && <button type="button" onClick={() => changeTopic(selected + 1)}>{english ? "Next topic" : "下一主题"} →</button>}</footer>
      </article>}
      {onAsk && (current ? !!lesson : !!outline) && <section className="paper-essay-ask" id={`${anchor}-ask`} data-section="ask" aria-label={copy.ask.title}>
        <h2>{copy.ask.title}</h2>
        <Answers items={targetFollowUps.filter(item => !item.focus || !inlineFocuses.has(item.focus))} copy={copy} />
        <div className="paper-essay-ask-modes">
          {(["simpler", "example", "why"] as FollowUpMode[]).map(mode => <button key={mode} type="button" disabled={asking !== null} onClick={() => void ask(mode)}>{copy.ask[mode as "simpler" | "example" | "why"]}</button>)}
        </div>
        <form onSubmit={event => { event.preventDefault(); if (question.trim()) void ask("question", undefined, question.trim()); }}>
          <textarea value={question} rows={2} maxLength={2000} placeholder={copy.ask.placeholder} aria-label={copy.ask.placeholder} onChange={event => setQuestion(event.target.value)} />
          <button type="submit" disabled={asking !== null || !question.trim()}>{asking === "" ? copy.ask.asking : copy.ask.send}</button>
        </form>
        {asking !== null && <p role="status" className="paper-essay-caption">{copy.ask.asking}</p>}
        {askError && <p role="alert" className="paper-essay-ask-error">{copy.ask.failed}{askError}</p>}
        <p className="paper-essay-caption">{copy.ask.note}</p>
      </section>}
    </main>
  </div>;
}
