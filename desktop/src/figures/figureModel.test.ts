import { describe, expect, it } from "vitest";
import { STYLE_PRESETS, flowSteps, formatLimit, ledgerSummary, pipelineSteps, statusTone, styleLabel, titleFromDescription, truncationInsight } from "./figureModel";
import type { FigureRequest, FigureRun } from "./types";

const identity = { model: "m", provider: "p", endpoint: "e", transport: "chat_completions", signature: "s" };
const request = (kind: string, status: string, extra: Partial<FigureRequest> = {}): FigureRequest => ({
  id: `${kind}-${status}`, kind, role: "executor", identity, maxOutputTokens: 16384, status, startedAt: "2026-10-06T10:00:00Z",
  finishedAt: null, stopReason: "stop", usage: { inputTokens: 10, outputTokens: 20 }, error: null, durationMs: 1000, ...extra,
});
const run = (patch: Partial<FigureRun>): FigureRun => ({
  schemaVersion: 1, id: "a", title: "t", method: "m", style: "s", sourceMode: "import", sourceMime: "image/png", sourceHash: "h",
  status: "ready", outputLimit: 16384, executor: identity, reviewer: identity, executorVision: false, reviewerVision: false,
  revisionUsed: false, versions: [], requests: [], review: null, error: null, createdAt: "", updatedAt: "", ...patch,
});
const states = (value: FigureRun) => Object.fromEntries(pipelineSteps(value).map((step) => [step.key, step.state]));

describe("figure view model", () => {
  it("shows prompt planning before image calls and retains the recorded failure", () => {
    const value = run({ sourceMode: "generate", sourceHash: null, status: "planning_image", requests: [request("plan_image", "submitted")] });
    expect(pipelineSteps(value).map((step) => step.key)).toEqual(["prompt", "source", "probe", "reconstruct", "review", "final"]);
    expect(states(value)).toMatchObject({ prompt: "active", source: "pending", probe: "pending" });
    expect(states(run({ status: "image_ready", requests: [request("manual_image_prompt", "failed")] }))).toMatchObject({ edit_prompt: "failed", source: "done", reconstruct: "pending" });
    expect(statusTone("planning_image_edit")).toBe("running");
  });
  it("marks the running stage active and later stages pending", () => {
    expect(states(run({ status: "reviewing", executorVision: true, requests: [request("reconstruct", "completed"), request("review", "submitted")] })))
      .toEqual({ probe: "done", source: "done", reconstruct: "done", review: "active", final: "pending" });
  });
  it("shows revision only when the run used it and treats truncation as a warning", () => {
    const truncated = states(run({ status: "budget_truncated", requests: [request("reconstruct", "completed", { stopReason: "length" })] }));
    expect(truncated.reconstruct).toBe("warn");
    expect(truncated).not.toHaveProperty("revise");
    expect(states(run({ status: "accepted", revisionUsed: true, requests: [request("revise", "completed")] }))).toMatchObject({ revise: "done", final: "done" });
  });
  it("never reports a final pass for visual-pending or unknown outcomes", () => {
    expect(states(run({ status: "visual_pending" })).final).toBe("warn");
    expect(statusTone("unknown")).toBe("danger");
    expect(statusTone("accepted")).toBe("ok");
  });
  it("warns for every provider output-limit stop reason", () => {
    for (const stopReason of ["length", "max_tokens", "max_output_tokens", "max_output"]) {
      expect(states(run({ status: "budget_truncated", requests: [request("reconstruct", "completed", { stopReason })] })).reconstruct).toBe("warn");
    }
  });
  it("sums recorded usage and counts unresolved requests", () => {
    expect(ledgerSummary(run({ requests: [request("reconstruct", "completed"), request("review", "unknown", { usage: null, durationMs: 0 })] })))
      .toEqual({ requests: 2, inputTokens: 10, outputTokens: 20, durationMs: 1000, unresolved: 1 });
  });
  it("formats output limits by their configured unit", () => {
    expect([8192, 16384, 50000, 1500].map(formatLimit)).toEqual(["8K", "16K", "50K", "1,500"]);
  });
  it("derives the four user-facing steps without claiming success", () => {
    const flow = (value: FigureRun | null, active = false) => Object.fromEntries(flowSteps(value, active, "en").map((step) => [step.key, step.state]));
    expect(flow(null)).toEqual({ describe: "active", generate: "pending", edit: "pending", export: "pending" });
    expect(flow(run({ status: "reconstructing" }))).toMatchObject({ describe: "done", generate: "active", edit: "pending" });
    const version = { index: 1, hash: "h", svgPath: "", pngPath: "", pdfPath: "", author: "executor", classification: "editable_vector", textCount: 1, vectorCount: 1, reviewStatus: "", renderer: "", fontFingerprint: "", createdAt: "" };
    expect(flow(run({ status: "visual_pending", versions: [version] }))).toMatchObject({ generate: "done", edit: "active" });
    expect(flow(run({ status: "revising", versions: [version] }), true)).toMatchObject({ generate: "active", edit: "pending" });
    expect(flow(run({ status: "unknown" }))).toMatchObject({ generate: "warn", edit: "pending" });
    expect(flow(run({ status: "needs_vision_executor" })).generate).toBe("failed");
    expect(flowSteps(run({ status: "ready" }), false, "cn")[1]).toMatchObject({ state: "pending", detail: "待启动" });
  });
  it("explains a truncated budget from the recorded usage and saved output", () => {
    // Real case: 16,384 output tokens billed, 9,239 characters of SVG saved.
    const truncated = run({ status: "budget_truncated", requests: [request("reconstruct", "completed", { stopReason: "length", usage: { outputTokens: 16384 } })] });
    expect(truncationInsight(truncated, "x".repeat(9239))).toEqual({ outputTokens: 16384, visibleChars: 9239, visibleTokens: 2640, reasoningHeavy: true });
    expect(truncationInsight({ ...truncated, outputLimit: 50000 }, "x".repeat(150000))).toMatchObject({ reasoningHeavy: false });
    expect(truncationInsight(run({ status: "draft" }), "")).toBeNull();
  });
  it("names stored styles by preset and keeps custom text", () => {
    expect(styleLabel(STYLE_PRESETS[1].value, "cn")).toBe("极简线框");
    expect(styleLabel("hand-drawn sketch", "en")).toBe("hand-drawn sketch");
  });
  it("keeps short subjects, removes request boilerplate and caps legacy titles", () => {
    expect(titleFromDescription("\n## 多智能体研究流程\nA → B")).toBe("多智能体研究流程");
    expect(titleFromDescription("构建一个ESN的流程图，ESN结合了AR和MA，ARMA应该放到储备池里面的")).toBe("ESN的流程图");
    expect(titleFromDescription("构建一个ESN的流程图，ESN结合了AR和MA，")).toBe("ESN的流程图");
    expect(titleFromDescription("请帮我生成一张ESN-ARMA 流程图")).toBe("ESN-ARMA 流程图");
    expect(titleFromDescription("Please create an ESN diagram, with AR and MA inside the reservoir")).toBe("ESN diagram");
    expect(titleFromDescription("AR, MA comparison")).toBe("AR, MA comparison");
    expect(titleFromDescription("画布字体样式")).toBe("画布字体样式");
    expect(titleFromDescription("Generate prediction")).toBe("Generate prediction");
    const long = titleFromDescription("图".repeat(80));
    expect(Array.from(long)).toHaveLength(24);
    expect(new TextEncoder().encode(titleFromDescription("😀".repeat(80))).length).toBeLessThanOrEqual(200);
    expect(titleFromDescription("   ")).toBe("");
  });
});
