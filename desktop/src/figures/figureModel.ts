// Pure view-model helpers for SomniQ Figures. They only read the run manifest;
// nothing here sends requests or decides review outcomes.
import type { FigureRequest, FigureRun } from "./types";

type Copy = [cn: string, en: string];
export type Language = "cn" | "en";
export type StatusTone = "ok" | "warn" | "danger" | "running" | "neutral";
export type StepState = "done" | "active" | "warn" | "failed" | "pending";
export interface PipelineStep { key: string; label: Copy; state: StepState }

export const STATUS: Record<string, Copy> = {
  ready: ["待启动", "Ready"], probing: ["检查视觉能力", "Checking vision"], generating: ["生成参考图", "Generating image"],
  image_ready: ["图片待确认", "Confirm image"], editing_image: ["修改 PNG 选区", "Editing PNG region"],
  planning_image: ["Executor 整理生图需求", "Executor planning image"], planning_image_edit: ["Executor 理解修改要求", "Executor planning edit"],
  reconstructing: ["重建 SVG", "Reconstructing SVG"], reviewing: ["独立审查", "Independent review"], revising: ["修订 SVG", "Revising SVG"],
  editing_svg: ["按要求修改 SVG", "Editing SVG"],
  accepted: ["结构与视觉通过", "Structure and visual passed"], visual_pending: ["结构通过 · 视觉待检查", "Structure passed · visual pending"],
  draft: ["草稿 · 待检查", "Draft · check needed"], unknown: ["请求结果不明", "Request result unknown"], cancelled: ["已取消", "Cancelled"],
  needs_vision_executor: ["需配置视觉 Executor", "Vision Executor required"], budget_truncated: ["输出达到上限", "Output limit reached"],
};

const REQUEST_KIND: Record<string, Copy> = {
  vision_probe: ["视觉探针", "Vision probe"], generate_image: ["生成参考图", "Generate image"],
  manual_image_edit: ["修改 PNG 选区", "Edit PNG region"],
  manual_svg_edit: ["对话修改 SVG", "Edit SVG with chat"], manual_review: ["独立审查", "Review"],
  plan_image: ["Executor 整理生图提示词", "Plan image prompt"], manual_image_prompt: ["Executor 整理修改提示词", "Plan edit prompt"],
  reconstruct: ["重建 SVG", "Reconstruct"], review: ["独立审查", "Review"], revise: ["修订 SVG", "Revise"],
};
const REQUEST_STATUS: Record<string, Copy> = {
  submitted: ["进行中", "In flight"], completed: ["完成", "Done"], failed: ["失败", "Failed"],
  unknown: ["结果不明", "Unknown"], cancelled: ["已取消", "Cancelled"],
};
const ACTIVE_STEP: Record<string, string> = {
  probing: "probe", generating: "source", editing_image: "source", reconstructing: "reconstruct", reviewing: "review", revising: "revise",
  planning_image: "prompt", planning_image_edit: "edit_prompt",
  editing_svg: "svg_edit",
};

const pick = (copy: Copy | undefined, language: Language, fallback: string) => copy?.[language === "cn" ? 0 : 1] ?? fallback;
export const statusLabel = (status: string, language: Language) => pick(STATUS[status], language, status);
export const requestKindLabel = (kind: string, language: Language) => pick(REQUEST_KIND[kind], language, kind);
export const requestStatusLabel = (status: string, language: Language) => pick(REQUEST_STATUS[status], language, status);

export function statusTone(status: string): StatusTone {
  if (status === "accepted") return "ok";
  if (["visual_pending", "draft", "budget_truncated"].includes(status)) return "warn";
  if (["unknown", "needs_vision_executor"].includes(status)) return "danger";
  if (status in ACTIVE_STEP) return "running";
  return "neutral";
}

export function requestTone(request: FigureRequest): StatusTone {
  if (request.status === "submitted") return "running";
  if (request.status === "failed") return "danger";
  if (request.status === "unknown" || request.status === "cancelled") return "warn";
  return isTruncated(request.stopReason) ? "warn" : "ok";
}

export const isTruncated = (reason: string | null) => !!reason && [
  "length", "max_tokens", "max_output_tokens", "max_output",
  "stream_truncated", "stream_error_after_partial_output",
].includes(reason);

function requestState(run: FigureRun, kind: string): StepState | null {
  const last = run.requests.filter((request) => request.kind === kind).at(-1);
  if (!last) return null;
  if (last.status === "submitted") return "active";
  if (last.status === "failed") return "failed";
  if (last.status !== "completed" || isTruncated(last.stopReason)) return "warn";
  return "done";
}

/** Executor → independent Reviewer stages, derived only from recorded state.
 * Revision appears only when the run actually used its single revision. */
export function pipelineSteps(run: FigureRun): PipelineStep[] {
  const steps: PipelineStep[] = [
    run.sourceMode === "generate"
      ? { key: "source", label: ["生成参考图", "Image"], state: requestState(run, "generate_image") ?? (run.sourceHash ? "done" : "pending") }
      : { key: "source", label: ["导入参考图", "Import"], state: run.sourceHash ? "done" : "pending" },
    { key: "probe", label: ["视觉检查", "Vision"], state: run.status === "needs_vision_executor" ? "failed" : requestState(run, "vision_probe") ?? (run.executorVision ? "done" : "pending") },
    { key: "reconstruct", label: ["重建 SVG", "Reconstruct"], state: requestState(run, "reconstruct") ?? (run.versions.length ? "done" : "pending") },
    { key: "review", label: ["独立审查", "Review"], state: requestState(run, "review") ?? (run.review ? "done" : "pending") },
  ];
  if (run.requests.some((request) => request.kind === "manual_image_prompt")) {
    steps.splice(1, 0, { key: "edit_prompt", label: ["理解修改", "Plan edit"], state: requestState(run, "manual_image_prompt") ?? "pending" });
  }
  if ((run.sourceMode === "generate" && !run.sourceHash) || run.requests.some((request) => request.kind === "plan_image")) {
    steps.unshift({ key: "prompt", label: ["理解需求", "Plan image"], state: requestState(run, "plan_image") ?? "pending" });
  }
  if (run.revisionUsed || run.status === "revising" || run.requests.some((request) => request.kind === "revise")) {
    steps.push({ key: "revise", label: ["修订", "Revise"], state: requestState(run, "revise") ?? "pending" });
  }
  const final: StepState = run.status === "accepted" ? "done"
    : ["visual_pending", "draft", "budget_truncated", "unknown"].includes(run.status) ? "warn" : "pending";
  if (run.svgEdits?.length) {
    steps.push({ key: "svg_edit", label: ["对话修改", "SVG edit"], state: requestState(run, "manual_svg_edit") ?? "pending" });
    steps.push({ key: "svg_review", label: ["修改后审查", "Edit review"], state: requestState(run, "manual_review") ?? "pending" });
  }
  steps.push({ key: "final", label: ["定稿", "Final"], state: final });
  const active = run.status === "reviewing" && run.svgEdits?.at(-1)?.status === "running" ? "svg_review" : ACTIVE_STEP[run.status];
  const at = steps.findIndex((step) => step.key === active);
  if (at >= 0) steps.forEach((step, index) => {
    if (index === at) step.state = "active";
    else if (index > at && step.state !== "done") step.state = "pending";
  });
  if (run.status === "ready") steps.forEach((step) => { step.state = "pending"; });
  return steps;
}

export interface LedgerSummary { requests: number; inputTokens: number; outputTokens: number; durationMs: number; unresolved: number }
export function ledgerSummary(run: FigureRun): LedgerSummary {
  return run.requests.reduce<LedgerSummary>((sum, request) => ({
    requests: sum.requests + 1,
    inputTokens: sum.inputTokens + (Number(request.usage?.inputTokens) || 0),
    outputTokens: sum.outputTokens + (Number(request.usage?.outputTokens) || 0),
    durationMs: sum.durationMs + (request.durationMs || 0),
    unresolved: sum.unresolved + (request.status === "submitted" || request.status === "unknown" ? 1 : 0),
  }), { requests: 0, inputTokens: 0, outputTokens: 0, durationMs: 0, unresolved: 0 });
}

/** 16384 → "16K", 50000 → "50K"; other values stay exact. */
export function formatLimit(value: number): string {
  if (!value) return "—";
  if (value % 1024 === 0) return `${value / 1024}K`;
  if (value % 1000 === 0) return `${value / 1000}K`;
  return value.toLocaleString("en-US");
}
export const formatTokens = (value: number | undefined | null) => typeof value === "number" ? value.toLocaleString("en-US") : "—";
export const formatDuration = (ms: number) => !ms ? "—" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;

export function formatTime(value: string | null | undefined, withDate = false): string {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return withDate ? `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}` : `${time}:${pad(date.getSeconds())}`;
}

/** Expected paid calls shown before submission; mirrors the native budget. */
export const callEstimate = (sourceMode: "import" | "generate") => sourceMode === "import" ? { usual: 2, max: 4 } : { usual: 4, max: 6 };

/** Short provisional title for descriptions/imports and legacy task display.
 * Generation replaces it with the Executor's title from the same prompt call. */
export function titleFromDescription(text: string): string {
  const line = text.split(/\r?\n/).map((part) => part.replace(/^#+\s*/, "").trim()).find(Boolean) ?? "";
  const request = /^(?:请|帮我|我想|我需要|我要|(?:绘制|画|生成|制作|构建|设计)\s*一(?:张|幅|个))/.test(line)
    || /^(?:please\s+)?(?:draw|generate|create|design|make)\s+(?:a|an)\s+/i.test(line);
  const subject = (request || Array.from(line).length > 24 ? line
    .replace(/^(?:(?:请(?:帮我)?|帮我|我想(?:要)?|我需要|我要)\s*)?(?:绘制|画|生成|制作|构建|设计)\s*(?:一(?:张|幅|个))?\s*/, "")
    .replace(/^(?:please\s+)?(?:draw|generate|create|design|make)\s+(?:(?:a|an)\s+)?/i, "")
    .trim() : line) || line;
  const topic = (request || Array.from(line).length > 24 ? subject.split(/[，。；！？;!?]|,\s/)[0].trim() : subject) || subject;
  const chars = Array.from(topic);
  if (chars.length <= 24) return topic;
  const clipped = chars.slice(0, 23).join("");
  // Avoid splitting an English word when a readable phrase fits.
  const boundary = clipped.lastIndexOf(" ");
  return `${boundary > 10 ? clipped.slice(0, boundary) : clipped}…`;
}

export const STYLE_PRESETS: { key: string; label: Copy; value: string }[] = [
  { key: "academic", label: ["学术扁平", "Academic"], value: "Clean academic diagram, flat vectors, readable labels, restrained colors" },
  { key: "minimal", label: ["极简线框", "Minimal"], value: "Minimal line diagram, monochrome strokes, generous whitespace, sans-serif labels" },
  { key: "soft", label: ["柔和分区", "Soft panels"], value: "Soft pastel grouped panels, rounded modules, clear arrows, consistent spacing" },
  { key: "print", label: ["印刷高对比", "Print"], value: "High-contrast print-safe diagram, bold outlines, colorblind-safe palette" },
];
/** Preset name for a stored style; older free-text styles are shown as written. */
export const styleLabel = (style: string, language: Language) => pick(STYLE_PRESETS.find((preset) => preset.value === style)?.label, language, style);

export type FlowKey = "describe" | "generate" | "edit" | "export";
export interface FlowStep { key: FlowKey; label: Copy; state: StepState; detail: string | null }
/** User-facing Describe → Generate → Edit → Export, derived from the run.
 * The detailed Executor/Reviewer stages stay in `pipelineSteps`. */
export function flowSteps(run: FigureRun | null, active: boolean, language: Language): FlowStep[] {
  const steps: FlowStep[] = [
    { key: "describe", label: ["描述", "Describe"], state: run ? "done" : "active", detail: null },
    { key: "generate", label: ["生成", "Generate"], state: "pending", detail: null },
    { key: "edit", label: ["编辑", "Edit"], state: "pending", detail: null },
    { key: "export", label: ["导出", "Export"], state: "pending", detail: null },
  ];
  if (!run) return steps;
  const [, generate, edit] = steps;
  if (active && run.versions.length && run.svgEdits?.at(-1)?.status === "running") { generate.state = "done"; edit.state = "active"; edit.detail = statusLabel(run.status, language); }
  else if (active || run.status in ACTIVE_STEP) { generate.state = "active"; generate.detail = statusLabel(run.status, language); }
  else if (run.status === "image_ready") { generate.state = "active"; generate.detail = statusLabel(run.status, language); }
  else if (run.versions.length) { generate.state = "done"; edit.state = "active"; }
  else if (run.status === "ready") generate.detail = statusLabel(run.status, language);
  else { generate.state = run.status === "needs_vision_executor" ? "failed" : "warn"; generate.detail = statusLabel(run.status, language); }
  return steps;
}

export interface TruncationInsight { outputTokens: number; visibleChars: number; visibleTokens: number; reasoningHeavy: boolean }
/** Where a truncated output went: the saved raw text is the visible output, the
 * a large difference may indicate hidden reasoning. SVG averages about
 * 3.5 characters per token, so this is an estimate and is labelled as one. */
export function truncationInsight(run: FigureRun, rawOutput: string | null | undefined): TruncationInsight | null {
  const request = run.requests.filter((item) => item.kind === "reconstruct" || item.kind === "revise").at(-1);
  const outputTokens = Number(request?.usage?.outputTokens) || 0;
  if (run.status !== "budget_truncated" || !outputTokens) return null;
  const visibleChars = rawOutput?.length ?? 0;
  const visibleTokens = Math.round(visibleChars / 3.5);
  return { outputTokens, visibleChars, visibleTokens, reasoningHeavy: visibleTokens < outputTokens * 0.5 };
}
