import { useEffect, useRef, useState, type ReactNode } from "react";
import { SvgIcon, type SvgIconName } from "../SvgIcon";
import {
  flowSteps, formatDuration, formatLimit, formatTime, formatTokens, isTruncated, ledgerSummary, pipelineSteps,
  requestKindLabel, requestStatusLabel, requestTone, statusLabel, statusTone, styleLabel, type Language, type StepState,
} from "./figureModel";
import type { FigureDocument, FigureRun, FigureVersion } from "./types";

type T = (cn: string, en: string) => string;

export function StatusChip({ status, language }: { status: string; language: Language }) {
  const tone = statusTone(status);
  return <span className={`figure-chip tone-${tone}`}>
    {tone === "running" ? <span className="figure-spin" aria-hidden /> : <i aria-hidden />}{statusLabel(status, language)}
  </span>;
}

function StepMark({ state, index }: { state: StepState; index?: number }) {
  return <span className="figure-step-dot" aria-hidden>{state === "done" ? <SvgIcon name="check" size={10} /> : state === "failed" ? <SvgIcon name="close" size={10} /> : state === "warn" ? "!" : index}</span>;
}

/** Describe → Generate → Edit → Export. */
export function FlowStepper({ run, active, status, language, t }: { run: FigureRun | null; active: boolean; status?: ReactNode; language: Language; t: T }) {
  return <div className="figure-flowbar">
    <ol aria-label={t("流程", "Flow")}>{flowSteps(run, active, language).map((step, index) => <li key={step.key} className={`step-${step.state}`} aria-current={step.state === "active" ? "step" : undefined}>
      <StepMark state={step.state} index={index + 1} />
      <span>{step.label[language === "cn" ? 0 : 1]}{step.detail && <small>{step.detail}</small>}</span>
    </li>)}</ol>
    {status}
  </div>;
}

/** Detailed Executor → independent Reviewer stages, recorded state only. */
export function PipelineList({ run, language, t }: { run: FigureRun; language: Language; t: T }) {
  return <ol className="figure-timeline" aria-label={t("运行进度", "Run progress")}>
    {pipelineSteps(run).map((step) => <li key={step.key} className={`step-${step.state}`}><StepMark state={step.state} /><span>{step.label[language === "cn" ? 0 : 1]}</span></li>)}
  </ol>;
}

const EXPORTS: [format: string, cn: string, en: string][] = [
  ["svg", "矢量，可继续编辑", "Vector, stays editable"],
  ["png", "位图，适合预览与幻灯片", "Bitmap for previews and slides"],
  ["pdf", "矢量 PDF，适合插入论文", "Vector PDF for papers"],
];
export function ExportMenu({ disabled, t, onExport }: { disabled: boolean; t: T; onExport: (format: string) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  return <div className="figure-export-menu" ref={root}>
    <button type="button" className="figure-button primary" aria-haspopup="menu" aria-expanded={open && !disabled} disabled={disabled} onClick={() => setOpen((value) => !value)}>
      <SvgIcon name="download" size={13} />{t("导出", "Export")}<SvgIcon name="chevronDown" size={12} />
    </button>
    {open && !disabled && <div className="figure-menu" role="menu" aria-label={t("导出格式", "Export format")}>
      {EXPORTS.map(([format, cn, en]) => <button key={format} type="button" role="menuitem" onClick={() => { setOpen(false); onExport(format); }}><strong>{format.toUpperCase()}</strong><small>{t(cn, en)}</small></button>)}
    </div>}
  </div>;
}

function FloatCard({ title, icon, meta, onClose, className, children, t }: { title: string; icon: SvgIconName; meta?: ReactNode; onClose: () => void; className: string; children: ReactNode; t: T }) {
  return <section className={`figure-float ${className}`} aria-label={title}>
    <header><SvgIcon name={icon} size={14} /><strong>{title}</strong>{meta && <span className="figure-float-meta">{meta}</span>}
      <button type="button" className="figure-icon-button" aria-label={t(`收起${title}`, `Hide ${title}`)} onClick={onClose}><SvgIcon name="close" size={12} /></button>
    </header>
    <div className="figure-float-body">{children}</div>
  </section>;
}

/** Collapsed run log: one line of ledger totals that expands into the card. */
export function LedgerPill({ run, active, t, onOpen }: { run: FigureRun; active: boolean; t: T; onOpen: () => void }) {
  const sum = ledgerSummary(run);
  return <button type="button" className="figure-float-pill" aria-label={t("展开运行记录", "Show run log")} onClick={onOpen}>
    {active ? <span className="figure-spin" aria-hidden /> : <SvgIcon name="list" size={13} />}
    <strong>{t("运行记录", "Run log")}</strong>
    <span>{sum.requests} {t("次请求", "requests")} · {formatTokens(sum.outputTokens)} token · {formatDuration(sum.durationMs)}</span>
    {sum.unresolved > 0 && <em>{sum.unresolved} {t("未决", "unresolved")}</em>}
    <SvgIcon name="chevronUp" size={12} />
  </button>;
}

/** Request ledger rendered as a run log; every row is a recorded request. */
export function LedgerCard({ run, language, t, onClose }: { run: FigureRun; language: Language; t: T; onClose: () => void }) {
  const sum = ledgerSummary(run);
  return <FloatCard className="figure-ledger" icon="list" title={t("运行记录", "Run log")} meta={`${sum.requests} ${t("次请求", "requests")}`} onClose={onClose} t={t}>
    {run.requests.length === 0
      ? <p className="figure-float-empty">{run.status === "ready" ? t("任务尚未启动，还没有发出请求。", "Not started; no requests sent yet.") : t("暂无请求记录。", "No recorded requests yet.")}</p>
      : <ol className="figure-log">{run.requests.map((request) => {
        const truncated = isTruncated(request.stopReason);
        return <li key={request.id} className={`tone-${requestTone(request)}`}>
          <time>{formatTime(request.startedAt)}</time>
          <span className="figure-log-kind">{requestKindLabel(request.kind, language)}{request.kind === "vision_probe" ? ` · ${request.role}` : ""}</span>
          <span className="figure-log-model" title={`${request.identity.provider} · ${request.identity.transport}`}>{request.identity.model}</span>
          <span className="figure-log-state">{requestStatusLabel(request.status, language)}{request.stopReason ? ` · ${request.stopReason}` : ""}{truncated ? ` · ${t("截断", "truncated")}` : ""}</span>
          <span className="figure-log-usage">{formatTokens(request.usage?.outputTokens)}/{request.maxOutputTokens ? formatLimit(request.maxOutputTokens) : t("默认", "default")} · {formatDuration(request.durationMs)}</span>
          {request.error && <span className="figure-log-error">{request.error}</span>}
        </li>;
      })}</ol>}
    <footer className="figure-log-summary">
      <span>{t("输入", "In")} {formatTokens(sum.inputTokens)}</span><span>{t("输出", "Out")} {formatTokens(sum.outputTokens)} token</span><span>{formatDuration(sum.durationMs)}</span>
      {sum.unresolved > 0 && <span className="tone-danger">{sum.unresolved} {t("条未决", "unresolved")}</span>}
    </footer>
    <details className="figure-raw"><summary>{t("模型与证据（JSON）", "Models and evidence (JSON)")}</summary>
      <pre>{JSON.stringify({ executor: run.executor, reviewer: run.reviewer, review: run.review, versions: run.versions }, null, 2)}</pre>
    </details>
  </FloatCard>;
}

const AUTHOR: Record<string, [string, string]> = { executor: ["Executor", "Executor"], human: ["人工编辑", "Manual edit"], user: ["人工编辑", "Manual edit"] };

interface ArtifactProps {
  run: FigureRun; document: FigureDocument; language: Language; t: T;
  displayed: FigureVersion | undefined; versionIndex: number | null; locked: boolean;
  onVersion: (index: number | null) => void; onPreview: (image: { src: string; title: string }) => void; onClose: () => void;
  onDuplicate: () => void;
}

/** Review verdict, reference/export images and immutable versions. */
export function ArtifactsCard({ run, document, language, t, displayed, versionIndex, locked, onVersion, onPreview, onClose, onDuplicate }: ArtifactProps) {
  const [tab, setTab] = useState<"review" | "task">("review");
  const review = run.review;
  const latest = run.versions.at(-1);
  const reviewedLatest = !!review && review.versionHash === latest?.hash;
  const pass = (value: boolean | null | undefined, unknown: string) => value === true
    ? <span className="figure-chip tone-ok"><SvgIcon name="check" size={10} />{t("通过", "Pass")}</span>
    : value === false ? <span className="figure-chip tone-danger"><SvgIcon name="close" size={10} />{t("未通过", "Fail")}</span>
      : <span className="figure-chip tone-warn"><i aria-hidden />{unknown}</span>;
  const versionLabel = displayed ? `v${displayed.index}` : "";
  return <FloatCard className="figure-artifacts" icon="image" title={t("产物与审查", "Artifacts and review")} meta={versionLabel} onClose={onClose} t={t}>
    <div className="figure-segmented figure-inspector-tabs" role="tablist" aria-label={t("检查器", "Inspector")}>
      <button type="button" role="tab" aria-selected={tab === "review"} className={tab === "review" ? "selected" : ""} onClick={() => setTab("review")}>{t("审查与产物", "Review & files")}</button>
      <button type="button" role="tab" aria-selected={tab === "task"} className={tab === "task" ? "selected" : ""} onClick={() => setTab("task")}>{t("任务输入", "Task inputs")}</button>
    </div>
    {tab === "task" ? <TaskSpec run={run} language={language} t={t} locked={locked} onDuplicate={onDuplicate} /> : <>
    <div className="figure-group-label">{t("独立审查", "Independent review")}</div>
    <div className="figure-verdict">
      <StatusChip status={run.status} language={language} />
      <dl>
        <dt>{t("结构", "Structure")}</dt><dd>{reviewedLatest ? pass(review?.structurePass, t("待审查", "Pending")) : pass(null, t("待审查", "Pending"))}</dd>
        <dt>{t("视觉", "Visual")}</dt><dd>{reviewedLatest ? pass(review?.visualPass, t("待检查", "Pending")) : pass(null, t("待检查", "Pending"))}</dd>
        <dt>Reviewer</dt><dd className="figure-verdict-model">{run.reviewer.model}<small>{run.reviewerVision ? t("真实图片探针通过", "Real image probe passed") : t("待验证／无视觉能力", "Unverified / unavailable")}</small></dd>
      </dl>
      {reviewedLatest && review && review.issues.length > 0 && <ul className="figure-issues">{review.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>}
      {latest && !reviewedLatest && <p className="figure-hint">{t("当前版本尚未审查。编辑后的版本需要重新检查；论文插图建议导出 PDF 或 PNG。", "This version has not been reviewed. Edited versions need a new check; use PDF or PNG in your paper.")}</p>}
      {run.error && <p className="figure-hint tone-danger">{run.error}</p>}
    </div>

    <div className="figure-group-label">{t("产物", "Artifacts")}</div>
    <div className="figure-artifact-list">
      <ArtifactItem src={document.sourceDataUrl} title={t("SVG 参考图", "SVG reference")} tags={[run.sourceMode === "generate" ? "SomniImage" : t("导入", "Imported"), (run.sourceMime ?? "").replace("image/", "").toUpperCase()]} onPreview={onPreview} empty={t("等待参考图", "Waiting for reference")} />
      <ArtifactItem src={document.previewDataUrl} title={`${t("本地导出预览", "Local export preview")} ${versionLabel}`} tags={displayed ? [displayed.classification, `${displayed.textCount} ${t("可编辑文字", "labels")}`] : []} onPreview={onPreview} empty={t("SVG 完成后生成", "Rendered after SVG is ready")} />
    </div>

    <div className="figure-group-label">{t("版本", "Versions")} <em>{run.versions.length}</em></div>
    {run.versions.length === 0 ? <p className="figure-float-empty">{t("还没有保存的版本。", "No saved versions yet.")}</p>
      : <ol className="figure-version-list">{[...run.versions].reverse().map((version) => {
        const current = version.index === latest?.index;
        const selected = versionIndex === null ? current : versionIndex === version.index;
        return <li key={version.index}><button type="button" className={selected ? "selected" : ""} disabled={locked} onClick={() => onVersion(current ? null : version.index)}>
          <strong>v{version.index}</strong>
          <span>{AUTHOR[version.author]?.[language === "cn" ? 0 : 1] ?? version.author} · {formatTime(version.createdAt, true)}</span>
          <span className="figure-version-tags"><em>{version.classification}</em><em>{version.textCount} {t("文字", "labels")}</em>{current && <em className="current">{t("当前", "Current")}</em>}</span>
        </button></li>;
      })}</ol>}
    </>}
  </FloatCard>;
}

/** Frozen inputs of a submitted task; changing them means a new task. */
function TaskSpec({ run, language, t, locked, onDuplicate }: { run: FigureRun; language: Language; t: T; locked: boolean; onDuplicate: () => void }) {
  return <div className="figure-task">
    <div className="figure-group-label">{t("图形描述", "Description")}</div>
    <p className="figure-task-text">{run.method}</p>
    <dl className="figure-task-meta">
      <dt>{t("风格", "Style")}</dt><dd>{styleLabel(run.style, language)}</dd>
      <dt>{t("参考图", "Reference")}</dt><dd>{run.sourceMode === "generate" ? `SomniImage · ${run.imageIdentity?.model ?? "—"}` : t("导入的图片", "Imported image")}</dd>
      <dt>Executor</dt><dd title={`${run.executor.provider} · ${run.executor.transport}`}>{run.executor.model}</dd>
      <dt>Reviewer</dt><dd title={`${run.reviewer.provider} · ${run.reviewer.transport}`}>{run.reviewer.model}</dd>
      <dt>{t("输出上限", "Output limit")}</dt><dd>{run.outputLimit ? formatLimit(run.outputLimit) : t("与 Chat 相同（服务默认）", "Same as Chat (provider default)")}</dd>
      <dt>{t("任务 ID", "Task ID")}</dt><dd title={run.id}><code>{run.id.slice(0, 8)}</code></dd>
    </dl>
    <div className="figure-group-label">{t("运行进度", "Progress")}</div>
    <PipelineList run={run} language={language} t={t} />
    <button type="button" className="figure-button block" disabled={locked} onClick={onDuplicate}><SvgIcon name="copy" size={13} />{t("用相同输入新建", "New task with these inputs")}</button>
    <p className="figure-hint">{t("提交后输入固定；改描述或模型请新建任务。已有参考图会一并带入，不再重复生图。", "Inputs are fixed once submitted; change them in a new task. An existing reference image is reused, so no new image is generated.")}</p>
  </div>;
}

function ArtifactItem({ src, title, tags, empty, onPreview }: { src: string | null; title: string; tags: string[]; empty: string; onPreview: (image: { src: string; title: string }) => void }) {
  return <button type="button" className="figure-artifact" disabled={!src} onClick={() => src && onPreview({ src, title })}>
    <span className="figure-thumb">{src ? <img src={src} alt={title} /> : <SvgIcon name="image" size={18} />}</span>
    <span className="figure-artifact-text"><strong>{title}</strong>{src ? <small>{tags.filter(Boolean).join(" · ")}</small> : <small>{empty}</small>}</span>
  </button>;
}
