// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FigureView } from "./types";

const state = vi.hoisted(() => ({ currentProject: { id: "project-a", name: "Research" }, language: "cn", setTab: vi.fn(), setFigureDirty: vi.fn() }));
const api = vi.hoisted(() => ({ figureList: vi.fn(), figureConnections: vi.fn(), figurePrepare: vi.fn(), figureStart: vi.fn(), figureDocument: vi.fn(), figureSave: vi.fn(), figureReview: vi.fn(), figureCancel: vi.fn(), figureExport: vi.fn(), onFigureUpdated: vi.fn() }));
vi.mock("../store", () => ({ useStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), { getState: () => state }) }));
vi.mock("../api/tauri", () => ({ isTauri: () => false }));
vi.mock("./figureApi", () => ({ ...api, figuresAvailable: () => true }));
vi.mock("./FigureEditor", async () => ({ default: (await import("react")).forwardRef(() => <div data-testid="editor" />) }));
import FigureStudio from "./FigureStudio";

const identity = { model: "vision-executor", provider: "custom", endpoint: "https://local.example/v1", transport: "chat_completions", signature: "executor" };
function fixture(): FigureView {
  return { projectId: "project-a", active: false, run: {
    schemaVersion: 1, id: "a".repeat(32), title: "架构草稿", method: "A → B", style: "paper", sourceMode: "import", sourceMime: "image/png", sourceHash: "source", status: "visual_pending", outputLimit: 16384,
    executor: identity, reviewer: { ...identity, model: "independent-reviewer", signature: "reviewer" }, executorVision: true, reviewerVision: false, revisionUsed: false,
    requests: [], review: { versionHash: "parent", structurePass: true, visualPass: null, issues: [], receivedImages: false, evidenceHashes: [], rawResponse: "{}" },
    versions: [{ index: 1, hash: "parent", svgPath: "versions/0001.svg", pngPath: "versions/0001.png", pdfPath: "versions/0001.pdf", author: "executor", classification: "editable_vector", textCount: 2, vectorCount: 2, reviewStatus: "visual_pending", renderer: "resvg", fontFingerprint: "fonts", createdAt: "2026-10-06" }],
    error: null, createdAt: "2026-10-06", updatedAt: "2026-10-06",
  } };
}
beforeEach(() => {
  vi.resetAllMocks(); state.currentProject = { id: "project-a", name: "Research" };
  api.figureList.mockResolvedValue([]);
  api.figureConnections.mockResolvedValue({ executor: identity, reviewer: { ...identity, model: "independent-reviewer" }, image: { available: true, enabled: true, model: "somni-image", models: ["somni-image"] } });
  api.figureDocument.mockResolvedValue({ svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>A</text></svg>', sourceDataUrl: null, previewDataUrl: null });
  api.onFigureUpdated.mockResolvedValue(() => {});
});
afterEach(cleanup);

describe("SomniQ figure application", () => {
  it("keeps a text Reviewer result visually pending", async () => {
    api.figureList.mockResolvedValue([fixture()]); render(<FigureStudio />);
    fireEvent.click(await screen.findByText("架构草稿"));
    fireEvent.click(screen.getByText("参考与审查"));
    expect(screen.getAllByText(/结构通过 · 视觉待检查/).length).toBeGreaterThan(0);
    expect(screen.queryByText("结构与视觉通过")).toBeNull();
    expect(api.figureStart).not.toHaveBeenCalled();
  });
  it("submits an imported figure once with the displayed budget and current project", async () => {
    const prepared = fixture(); prepared.run.status = "ready"; prepared.run.versions = [];
    api.figurePrepare.mockResolvedValue(prepared); api.figureStart.mockResolvedValue({ ...prepared, active: true });
    render(<FigureStudio />);
    await screen.findByText("independent-reviewer");
    fireEvent.change(screen.getByLabelText("方法与必需内容"), { target: { value: "A points to B" } });
    fireEvent.change(screen.getByLabelText(/选择 PNG/), { target: { files: [new File([new Uint8Array([1, 2, 3])], "source.png", { type: "image/png" })] } });
    await screen.findByText("source.png");
    const button = screen.getByText("开始重建并审查"); fireEvent.click(button); fireEvent.click(button);
    await waitFor(() => expect(api.figureStart).toHaveBeenCalledTimes(1));
    expect(api.figurePrepare).toHaveBeenCalledTimes(1);
    expect(api.figurePrepare.mock.calls[0][0]).toMatchObject({ projectId: "project-a", outputLimit: 16384, sourceMode: "import", model: "vision-executor" });
  });
  it("resolves a verified task model before enabling paid work", async () => {
    api.figureConnections.mockImplementation(async (model: string | null) => ({ executor: { ...identity, model: model ?? identity.model }, executorModels: [identity.model, "other-vision-model"], reviewer: { ...identity, model: "independent-reviewer" }, image: { available: true, enabled: true, model: "somni-image", models: ["somni-image"] } }));
    render(<FigureStudio />); await screen.findByText("other-vision-model");
    fireEvent.change(screen.getByLabelText("重建模型"), { target: { value: "other-vision-model" } });
    await waitFor(() => expect(api.figureConnections).toHaveBeenCalledWith("other-vision-model"));
    expect(api.figurePrepare).not.toHaveBeenCalled(); expect(api.figureStart).not.toHaveBeenCalled();
  });
  it("saves against the parent hash and retains an unsaved draft on conflict", async () => {
    api.figureList.mockResolvedValue([fixture()]); api.figureSave.mockRejectedValue(new Error("Figure changed. Reload before saving"));
    render(<FigureStudio />); fireEvent.click(await screen.findByText("架构草稿"));
    await screen.findByTestId("editor"); fireEvent.click(screen.getByText("SVG 源码"));
    const source = screen.getByLabelText("SVG");
    fireEvent.change(source, { target: { value: '<svg xmlns="http://www.w3.org/2000/svg"><text>Changed</text></svg>' } });
    fireEvent.click(screen.getByText(/保存新版本/));
    await screen.findByText(/Figure changed/);
    expect(api.figureSave.mock.calls[0].slice(0, 3)).toEqual(["project-a", "a".repeat(32), "parent"]);
    expect((source as HTMLTextAreaElement).value).toContain("Changed");
    expect(state.setFigureDirty).toHaveBeenCalledWith(true);
    expect(api.figureStart).not.toHaveBeenCalled();
  });
  it("lets the user repair raw truncated output without another model call", async () => {
    const run = fixture(); run.run.status = "budget_truncated"; run.run.versions = [];
    api.figureList.mockResolvedValue([run]);
    api.figureDocument.mockResolvedValue({ svg: null, rawOutput: '<svg xmlns="http://www.w3.org/2000/svg"><text>A', sourceDataUrl: null, previewDataUrl: null });
    api.figureSave.mockResolvedValue(fixture());
    render(<FigureStudio />); fireEvent.click(await screen.findByText("架构草稿"));
    fireEvent.click(await screen.findByText("查看并手动修复原始输出"));
    fireEvent.change(screen.getByLabelText("SVG"), { target: { value: '<svg xmlns="http://www.w3.org/2000/svg"><text>A</text></svg>' } });
    fireEvent.click(screen.getByText(/保存新版本/));
    await waitFor(() => expect(api.figureSave).toHaveBeenCalled());
    expect(api.figureSave.mock.calls[0][2]).toBeNull();
    expect(api.figureStart).not.toHaveBeenCalled(); expect(api.figureReview).not.toHaveBeenCalled();
  });
});
