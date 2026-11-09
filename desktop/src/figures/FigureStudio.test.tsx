// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FigureConnections, FigureEditingDraft, FigureView } from "./types";

const state = vi.hoisted(() => ({ currentProject: { id: "project-a", name: "Research" }, language: "cn", setTab: vi.fn(), setFigureDirty: vi.fn() }));
const api = vi.hoisted(() => ({ figureSaveDraft: vi.fn(), figureDiscardDraft: vi.fn(), figureEditSvg: vi.fn(), figureList: vi.fn(), figureConnections: vi.fn(), figurePrepare: vi.fn(), figureStart: vi.fn(), figureDocument: vi.fn(), figureSave: vi.fn(), figureReview: vi.fn(), figureCancel: vi.fn(), figureExport: vi.fn(), figureDelete: vi.fn(), figureSelectRaster: vi.fn(), figureEditImage: vi.fn(), figureEditResultDocument: vi.fn(), figureResolveEditResult: vi.fn(), figureRasterDocument: vi.fn(), onFigureUpdated: vi.fn() }));
const canvas = vi.hoisted(() => ({ serialize: vi.fn() }));
vi.mock("../store", () => ({ useStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), { getState: () => state }) }));
vi.mock("../api/tauri", () => ({ isTauri: () => false }));
vi.mock("./figureApi", () => ({ ...api, figuresAvailable: () => true }));
vi.mock("./FigureEditor", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return { default: forwardRef(({ onDirty, readOnly }: { onDirty: () => void; readOnly: boolean }, ref) => {
    useImperativeHandle(ref, () => ({ serialize: canvas.serialize }));
    return <div data-testid="editor"><button disabled={readOnly} onClick={onDirty}>模拟画布修改</button></div>;
  }) };
});
vi.mock("./FigureSourceEditor", () => ({ default: ({ value, readOnly, onChange }: { value: string; readOnly: boolean; onChange: (svg: string) => void }) => <textarea aria-label="SVG" value={value} readOnly={readOnly} onChange={(event) => onChange(event.target.value)} /> }));
import FigureStudio from "./FigureStudio";
import { parseFigureStyle } from "./figureStyles";

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
  api.figureRasterDocument.mockResolvedValue({ dataUrl: "data:image/png;base64,AAAA", hash: "source", index: 1, width: 100, height: 100 });
  api.onFigureUpdated.mockResolvedValue(() => {});
  canvas.serialize.mockResolvedValue('<svg xmlns="http://www.w3.org/2000/svg"><text>Canvas edit</text></svg>');
  api.figureSaveDraft.mockImplementation(async (_project, _id, expectedHash, svg, baseIndex) => ({ svg, expectedHash, baseIndex, updatedAt: "now" }));
  api.figureDiscardDraft.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("SomniQ figure application", () => {
  it("debounces source edits into a draft without adding a version or calling models", async () => {
    api.figureList.mockResolvedValue([fixture()]);
    render(<FigureStudio />); fireEvent.click(await screen.findByText("架构草稿"));
    await screen.findByTestId("editor"); fireEvent.click(screen.getByRole("button", { name: "SVG 源码" }));
    const source = screen.getByLabelText("SVG");
    fireEvent.change(source, { target: { value: "first" } });
    fireEvent.change(source, { target: { value: "<svg>unfinished" } });
    await screen.findByText("草稿已自动保存");
    expect(api.figureSaveDraft).toHaveBeenCalledTimes(1);
    expect(api.figureSaveDraft).toHaveBeenCalledWith("project-a", "a".repeat(32), "parent", "<svg>unfinished", 1);
    expect(api.figureSave).not.toHaveBeenCalled(); expect(api.figureReview).not.toHaveBeenCalled(); expect(api.figureStart).not.toHaveBeenCalled();
    expect(canvas.serialize).not.toHaveBeenCalled();
    expect(within(screen.getByLabelText("版本")).getAllByRole("option")).toHaveLength(2);
    expect((screen.getByRole("button", { name: /保存新版本/ }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: /^审查/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(state.setFigureDirty).toHaveBeenLastCalledWith(false);
  });
  it("autosaves successive canvas changes even while the version remains uncommitted", async () => {
    api.figureList.mockResolvedValue([fixture()]);
    render(<FigureStudio />); fireEvent.click(await screen.findByText("架构草稿"));
    fireEvent.click(await screen.findByRole("button", { name: "模拟画布修改" }));
    await screen.findByText("草稿已自动保存");
    expect(api.figureSaveDraft.mock.calls[0][3]).toContain("Canvas edit");
    canvas.serialize.mockResolvedValue('<svg xmlns="http://www.w3.org/2000/svg"><text>Second edit</text></svg>');
    fireEvent.click(screen.getByRole("button", { name: "模拟画布修改" }));
    await screen.findByText("草稿已自动保存");
    expect(api.figureSaveDraft).toHaveBeenCalledTimes(2);
    expect(api.figureSaveDraft.mock.calls[1][3]).toContain("Second edit");
    expect(api.figureSave).not.toHaveBeenCalled();
    expect(api.figureDocument).toHaveBeenCalledTimes(1);
  });
  it("restores an autosaved draft after switching figures and after remounting", async () => {
    const original = fixture(), other = fixture(); other.run.id = "b".repeat(32); other.run.title = "另一个绘图";
    api.figureList.mockResolvedValue([original, other]);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Recovered</text></svg>';
    let persisted: FigureEditingDraft | null = null;
    api.figureSaveDraft.mockImplementation(async (_project, _id, expectedHash, svg, baseIndex) => persisted = { expectedHash, svg, baseIndex, updatedAt: "now" });
    api.figureDocument.mockImplementation(async (_project, id, index) => ({ svg: id === original.run.id && index == null && persisted ? persisted.svg : "original", sourceDataUrl: null, previewDataUrl: null, draft: id === original.run.id && index == null ? persisted : null }));
    const mounted = render(<FigureStudio />); fireEvent.click(await screen.findByText("架构草稿"));
    await screen.findByTestId("editor"); fireEvent.click(screen.getByRole("button", { name: "SVG 源码" }));
    fireEvent.change(screen.getByLabelText("SVG"), { target: { value: svg } });
    await screen.findByText("草稿已自动保存");
    fireEvent.click(screen.getByText("另一个绘图"));
    await screen.findByRole("heading", { name: "另一个绘图" });
    fireEvent.click(screen.getByText("架构草稿"));
    await screen.findByText("草稿已自动保存");
    fireEvent.click(screen.getByRole("button", { name: "SVG 源码" }));
    expect((await screen.findByLabelText("SVG") as HTMLTextAreaElement).value).toBe(svg);
    mounted.unmount(); render(<FigureStudio />); fireEvent.click(await screen.findByText("架构草稿"));
    await screen.findByText("草稿已自动保存"); fireEvent.click(screen.getByRole("button", { name: "SVG 源码" }));
    expect((await screen.findByLabelText("SVG") as HTMLTextAreaElement).value).toBe(svg);
    expect(api.figureSaveDraft).toHaveBeenCalledTimes(1); expect(api.figureSave).not.toHaveBeenCalled();
    expect(state.setFigureDirty).toHaveBeenLastCalledWith(false);
  });
  it("restores incomplete draft source directly into the source editor", async () => {
    api.figureList.mockResolvedValue([fixture()]);
    api.figureDocument.mockResolvedValue({ svg: null, sourceDataUrl: null, previewDataUrl: null, draft: { svg: "<svg>partial", expectedHash: "parent", baseIndex: 1, updatedAt: "now" } });
    render(<FigureStudio />); fireEvent.click(await screen.findByText("架构草稿"));
    expect((await screen.findByLabelText("SVG") as HTMLTextAreaElement).value).toBe("<svg>partial");
    expect(screen.queryByTestId("editor")).toBeNull();
    expect(screen.getByText("草稿已自动保存")).toBeTruthy();
    expect(api.figureSaveDraft).not.toHaveBeenCalled(); expect(api.figureSave).not.toHaveBeenCalled();
  });
  it("ignores a late canvas serialization after selecting a different figure", async () => {
    const other = fixture(); other.run.id = "b".repeat(32); other.run.title = "另一张图";
    api.figureList.mockResolvedValue([fixture(), other]);
    render(<FigureStudio />); fireEvent.click(await screen.findByText("架构草稿"));
    fireEvent.click(await screen.findByRole("button", { name: "模拟画布修改" }));
    await screen.findByText("草稿已自动保存");
    let finish!: (svg: string) => void;
    canvas.serialize.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "SVG 源码" }));
    fireEvent.click(screen.getByText("另一张图"));
    await screen.findByRole("heading", { name: "另一张图" });
    await act(async () => { finish("previous figure source"); });
    expect(screen.queryByLabelText("SVG")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "SVG 源码" }));
    expect((await screen.findByLabelText("SVG") as HTMLTextAreaElement).value).not.toContain("previous figure");
    expect(api.figureSave).not.toHaveBeenCalled();
  });
  it("keeps newer edits unsaved until their own autosave finishes", async () => {
    api.figureList.mockResolvedValue([fixture()]);
    let finish!: (draft: FigureEditingDraft) => void;
    api.figureSaveDraft.mockImplementationOnce(() => new Promise<FigureEditingDraft>((resolve) => { finish = resolve; }));
    render(<FigureStudio />); fireEvent.click(await screen.findByText("架构草稿"));
    await screen.findByTestId("editor"); fireEvent.click(screen.getByRole("button", { name: "SVG 源码" }));
    fireEvent.change(screen.getByLabelText("SVG"), { target: { value: "old edit" } });
    await waitFor(() => expect(api.figureSaveDraft).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("SVG"), { target: { value: "new edit" } });
    await act(async () => { finish({ svg: "old edit", expectedHash: "parent", baseIndex: 1, updatedAt: "now" }); });
    expect(state.setFigureDirty).toHaveBeenLastCalledWith(true);
    expect(screen.queryByText("草稿已自动保存")).toBeNull();
    await screen.findByText("草稿已自动保存");
    expect(api.figureSaveDraft).toHaveBeenCalledTimes(2);
    expect(api.figureSaveDraft.mock.calls[1][3]).toBe("new edit");
    expect(state.setFigureDirty).toHaveBeenLastCalledWith(false);
  });
  it("allows a project switch after autosave and restores the draft only in its owning project", async () => {
    api.figureList.mockImplementation(async (projectId) => projectId === "project-a" ? [fixture()] : []);
    let persisted: FigureEditingDraft | null = null;
    api.figureSaveDraft.mockImplementation(async (_project, _id, expectedHash, svg, baseIndex) => persisted = { expectedHash, svg, baseIndex, updatedAt: "now" });
    api.figureDocument.mockImplementation(async (projectId) => ({ svg: persisted?.svg ?? "original", sourceDataUrl: null, previewDataUrl: null, draft: projectId === "project-a" ? persisted : null }));
    const mounted = render(<FigureStudio />); fireEvent.click(await screen.findByText("架构草稿"));
    await screen.findByTestId("editor"); fireEvent.click(screen.getByRole("button", { name: "SVG 源码" }));
    fireEvent.change(screen.getByLabelText("SVG"), { target: { value: "project A draft" } });
    await screen.findByText("草稿已自动保存"); expect(state.setFigureDirty).toHaveBeenLastCalledWith(false);
    state.currentProject = { id: "project-b", name: "Other project" }; mounted.rerender(<FigureStudio />);
    await screen.findByText("还没有绘图任务。");
    expect(screen.queryByText("草稿已自动保存")).toBeNull();
    state.currentProject = { id: "project-a", name: "Research" }; mounted.rerender(<FigureStudio />);
    fireEvent.click(await screen.findByText("架构草稿")); await screen.findByText("草稿已自动保存");
    fireEvent.click(screen.getByRole("button", { name: "SVG 源码" }));
    expect((await screen.findByLabelText("SVG") as HTMLTextAreaElement).value).toBe("project A draft");
    expect(api.figureSaveDraft).toHaveBeenCalledTimes(1);
  });
  it("keeps the current draft when viewing the immutable latest saved version", async () => {
    api.figureList.mockResolvedValue([fixture()]);
    const draft = { svg: "draft source", expectedHash: "parent", baseIndex: 1, updatedAt: "now" };
    api.figureDocument.mockImplementation(async (_project, _id, index) => ({ svg: index === 1 ? "saved source" : draft.svg, sourceDataUrl: null, previewDataUrl: null, draft: index === 1 ? null : draft }));
    render(<FigureStudio />); fireEvent.click(await screen.findByText("架构草稿")); await screen.findByText("草稿已自动保存");
    fireEvent.click(screen.getByRole("button", { name: "SVG 源码" }));
    fireEvent.change(screen.getByLabelText("版本"), { target: { value: "1" } });
    await waitFor(() => expect((screen.getByLabelText("SVG") as HTMLTextAreaElement).value).toBe("saved source"));
    expect(screen.queryByText("草稿已自动保存")).toBeNull();
    fireEvent.change(screen.getByLabelText("版本"), { target: { value: "latest" } });
    await screen.findByText("草稿已自动保存");
    expect((screen.getByLabelText("SVG") as HTMLTextAreaElement).value).toBe("draft source");
    expect(api.figureDiscardDraft).not.toHaveBeenCalled(); expect(api.figureSave).not.toHaveBeenCalled();
  });
  it("keeps failed autosaves unsaved and retries when the source changes", async () => {
    api.figureList.mockResolvedValue([fixture()]);
    api.figureSaveDraft.mockRejectedValueOnce(new Error("Disk full"));
    render(<FigureStudio />); fireEvent.click(await screen.findByText("架构草稿"));
    await screen.findByTestId("editor"); fireEvent.click(screen.getByRole("button", { name: "SVG 源码" }));
    fireEvent.change(screen.getByLabelText("SVG"), { target: { value: "retain this" } });
    await screen.findByText("草稿自动保存失败：Error: Disk full");
    expect((screen.getByLabelText("SVG") as HTMLTextAreaElement).value).toBe("retain this");
    expect(state.setFigureDirty).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "新建绘图" }));
    expect(screen.getByText("请等待草稿自动保存完成，或放弃当前编辑。")).toBeTruthy();
    expect(screen.queryByLabelText(/图形描述/)).toBeNull();
    fireEvent.change(screen.getByLabelText("SVG"), { target: { value: "retry" } });
    await screen.findByText("草稿已自动保存");
    expect(api.figureSaveDraft).toHaveBeenCalledTimes(2);
    expect(state.setFigureDirty).toHaveBeenLastCalledWith(false);
  });
  it.each(["commit", "discard", "delete"])("waits for an in-flight autosave before %s", async (action) => {
    api.figureList.mockResolvedValue([fixture()]);
    let finish!: (draft: FigureEditingDraft) => void;
    api.figureSaveDraft.mockImplementation(() => new Promise<FigureEditingDraft>((resolve) => { finish = resolve; }));
    const saved = fixture(); saved.run.versions.push({ ...saved.run.versions[0], index: 2, hash: "new", author: "user" });
    api.figureSave.mockResolvedValue(saved);
    api.figureDelete.mockResolvedValue(undefined);
    if (action === "delete") vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<FigureStudio />); fireEvent.click(await screen.findByText("架构草稿"));
    await screen.findByTestId("editor"); fireEvent.click(screen.getByRole("button", { name: "SVG 源码" }));
    fireEvent.change(screen.getByLabelText("SVG"), { target: { value: "latest edit" } });
    await waitFor(() => expect(api.figureSaveDraft).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: action === "commit" ? /保存新版本/ : action === "discard" ? "放弃编辑" : "删除 架构草稿" }));
    expect(api.figureSave).not.toHaveBeenCalled(); expect(api.figureDiscardDraft).not.toHaveBeenCalled(); expect(api.figureDelete).not.toHaveBeenCalled();
    await act(async () => { finish({ svg: "latest edit", expectedHash: "parent", baseIndex: 1, updatedAt: "now" }); });
    await waitFor(() => expect(action === "commit" ? api.figureSave : action === "discard" ? api.figureDiscardDraft : api.figureDelete).toHaveBeenCalledTimes(1));
    if (action === "delete") await waitFor(() => expect(screen.queryByLabelText("删除 架构草稿")).toBeNull());
    else await waitFor(() => expect((screen.getByRole("button", { name: /保存新版本/ }) as HTMLButtonElement).disabled).toBe(true));
    if (action === "commit") {
      expect(api.figureSave).toHaveBeenCalledWith("project-a", "a".repeat(32), "parent", "latest edit", 1);
      expect(within(screen.getByLabelText("版本")).getAllByRole("option")).toHaveLength(3);
    } else expect(action === "discard" ? api.figureDiscardDraft : api.figureDelete).toHaveBeenCalledWith("project-a", "a".repeat(32));
    expect(api.figureSaveDraft).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("草稿已自动保存")).toBeNull();
  });
  it("retains the original draft parent when a newer version arrives", async () => {
    api.figureList.mockResolvedValue([fixture()]);
    let notify!: (view: FigureView) => void;
    api.onFigureUpdated.mockImplementation(async (callback) => { notify = callback; return () => {}; });
    api.figureSave.mockRejectedValue(new Error("Figure changed"));
    render(<FigureStudio />); fireEvent.click(await screen.findByText("架构草稿"));
    await screen.findByTestId("editor"); fireEvent.click(screen.getByRole("button", { name: "SVG 源码" }));
    fireEvent.change(screen.getByLabelText("SVG"), { target: { value: "my draft" } });
    await screen.findByText("草稿已自动保存");
    const newer = fixture(); newer.run.versions.push({ ...newer.run.versions[0], index: 2, hash: "other" }); api.figureList.mockResolvedValue([newer]);
    act(() => notify(newer));
    fireEvent.click(screen.getByRole("button", { name: /保存新版本/ }));
    await screen.findByText("Error: Figure changed");
    expect(api.figureSave).toHaveBeenCalledWith("project-a", "a".repeat(32), "parent", "my draft", 1);
    expect((screen.getByLabelText("SVG") as HTMLTextAreaElement).value).toBe("my draft");
  });
  it("restores a historical draft with its base version and opens it on the canvas without committing", async () => {
    const run = fixture(); run.run.versions.push({ ...run.run.versions[0], index: 2, hash: "latest" });
    api.figureList.mockResolvedValue([run]);
    const draft = { svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Historical edit</text></svg>', expectedHash: "latest", baseIndex: 1, updatedAt: "now" };
    api.figureDocument.mockResolvedValue({ svg: draft.svg, sourceDataUrl: null, previewDataUrl: null, draft });
    api.figureSave.mockResolvedValue(run);
    render(<FigureStudio />); fireEvent.click(await screen.findByText("架构草稿")); await screen.findByText("草稿已自动保存");
    fireEvent.click(screen.getByRole("button", { name: "SVG 源码" }));
    fireEvent.click(screen.getByRole("button", { name: "画布" }));
    await waitFor(() => expect(screen.queryByLabelText("SVG")).toBeNull());
    expect(api.figureSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /保存新版本/ }));
    await waitFor(() => expect(api.figureSave).toHaveBeenCalled());
    expect(api.figureSave.mock.calls[0][2]).toBe("latest");
    expect(api.figureSave.mock.calls[0][4]).toBe(1);
  });
  it("submits SVG conversation turns once against the latest version and retains their history", async () => {
    const original = fixture(); api.figureList.mockResolvedValue([original]);
    api.figureEditSvg.mockImplementation(async (input) => {
      const next = structuredClone(original);
      next.run.versions.push({ ...next.run.versions[0], index: 2, hash: "edited", parentIndex: 1, svgEditId: input.editId, author: "executor_edit", reviewStatus: "accepted" });
      next.run.svgEdits = [{ id: input.editId, baseVersion: 1, baseHash: "parent", prompt: input.prompt, resultVersion: 2, status: "completed", error: null, createdAt: "now", finishedAt: "now" }];
      return next;
    });
    render(<FigureStudio />); fireEvent.click(await screen.findByText("架构草稿"));
    fireEvent.click(screen.getByRole("button", { name: "对话修改" }));
    const input = screen.getByLabelText("SVG 修改要求");
    fireEvent.change(input, { target: { value: "把右边箭头反向，保留文字" } });
    fireEvent.click(screen.getByRole("button", { name: "修改 SVG" })); fireEvent.click(screen.getByRole("button", { name: "修改 SVG" }));
    await waitFor(() => expect(api.figureEditSvg).toHaveBeenCalledTimes(1));
    expect(api.figureEditSvg.mock.calls[0][0]).toMatchObject({ projectId: "project-a", id: original.run.id, baseIndex: 1, expectedHash: "parent", prompt: "把右边箭头反向，保留文字" });
    expect(api.figureEditSvg.mock.calls[0][0].editId).toMatch(/^[a-f0-9]{32}$/);
    await screen.findByText("修改已保存，审查通过。");
    expect((input as HTMLTextAreaElement).value).toBe("");
    fireEvent.change(input, { target: { value: "再把字号放大" } }); fireEvent.click(screen.getByRole("button", { name: "修改 SVG" }));
    await waitFor(() => expect(api.figureEditSvg).toHaveBeenCalledTimes(2));
    expect(api.figureEditSvg.mock.calls[1][0]).toMatchObject({ baseIndex: 2, expectedHash: "edited", prompt: "再把字号放大" });
    expect(api.figurePrepare).not.toHaveBeenCalled(); expect(api.figureEditImage).not.toHaveBeenCalled(); expect(api.figureReview).not.toHaveBeenCalled();
  });
  it("blocks conversation edits on unsaved or historical SVG versions", async () => {
    api.figureList.mockResolvedValue([fixture()]);
    render(<FigureStudio />); fireEvent.click(await screen.findByText("架构草稿"));
    fireEvent.click(screen.getByRole("button", { name: "对话修改" }));
    fireEvent.change(screen.getByLabelText("SVG 修改要求"), { target: { value: "Fix arrows" } });
    fireEvent.change(screen.getByLabelText("版本"), { target: { value: "1" } });
    expect((screen.getByRole("button", { name: "修改 SVG" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("版本"), { target: { value: "latest" } });
    fireEvent.click(screen.getByRole("button", { name: "SVG 源码" }));
    fireEvent.change(screen.getByLabelText("SVG"), { target: { value: "<svg>unsaved</svg>" } });
    expect(screen.getByText("请先保存或放弃当前编辑。")).toBeTruthy();
    expect((screen.getByRole("button", { name: "修改 SVG" }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.figureEditSvg).not.toHaveBeenCalled();
  });
  it("preserves rejected instructions and reuses the turn ID after an IPC error", async () => {
    api.figureList.mockResolvedValue([fixture()]); api.figureEditSvg.mockRejectedValue(new Error("Disconnected"));
    render(<FigureStudio />); fireEvent.click(await screen.findByText("架构草稿")); fireEvent.click(screen.getByRole("button", { name: "对话修改" }));
    const input = screen.getByLabelText("SVG 修改要求"); fireEvent.change(input, { target: { value: "Fix arrows" } });
    fireEvent.click(screen.getByRole("button", { name: "修改 SVG" })); await screen.findByText("Error: Disconnected");
    expect((input as HTMLTextAreaElement).value).toBe("Fix arrows");
    fireEvent.click(screen.getByRole("button", { name: "修改 SVG" })); await waitFor(() => expect(api.figureEditSvg).toHaveBeenCalledTimes(2));
    expect(api.figureEditSvg.mock.calls[1][0].editId).toBe(api.figureEditSvg.mock.calls[0][0].editId);
  });
  it("restores failed SVG turns and blocks another request when its result is unknown", async () => {
    const view = fixture(); view.run.status = "unknown";
    view.run.svgEdits = [{ id: "b".repeat(32), baseVersion: 1, baseHash: "parent", prompt: "Fix arrow", resultVersion: null, status: "unknown", error: "timeout", createdAt: "now", finishedAt: "now" }];
    view.run.requests = [{ id: "request-01", kind: "manual_svg_edit", role: "executor", identity, maxOutputTokens: 0, status: "unknown", startedAt: "now", finishedAt: null, stopReason: null, usage: null, error: "timeout", durationMs: 0 }];
    api.figureList.mockResolvedValue([view]);
    render(<FigureStudio />); fireEvent.click(await screen.findByText("架构草稿")); fireEvent.click(screen.getByRole("button", { name: "对话修改" }));
    expect(screen.getByText("Fix arrow")).toBeTruthy(); expect(screen.getByText("修改未完成，原版本已保留。")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("SVG 修改要求"), { target: { value: "Try again" } });
    expect((screen.getByRole("button", { name: "修改 SVG" }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.figureEditSvg).not.toHaveBeenCalled();
  });
  it("continues from an unresolved image edit without a new-task form or repeating the edit", async () => {
    const previous=fixture(); previous.run.versions=[]; previous.run.review=null; previous.run.status="unknown";
    previous.run.requests=[{id:"request-01",kind:"manual_image_edit",role:"image",identity,maxOutputTokens:0,status:"unknown",startedAt:"now",finishedAt:null,stopReason:null,usage:null,error:"cancelled",durationMs:0}];
    api.figureList.mockResolvedValue([previous]);
    api.figureRasterDocument.mockResolvedValue({dataUrl:"data:image/png;base64,AAAA",hash:"selected",index:3,width:100,height:100,editPrompts:["Move ARMA inside reservoir"]});
    const prepared=fixture(); prepared.run.id="b".repeat(32);prepared.run.status="image_ready";prepared.run.versions=[];prepared.run.review=null;prepared.run.sourceHash="selected";prepared.run.sourceRaster=1;
    api.figurePrepare.mockResolvedValue(prepared);
    api.figureStart.mockResolvedValue({...prepared,active:true,run:{...prepared.run,status:"probing",imageConfirmed:true}});
    render(<FigureStudio />);fireEvent.click(await screen.findByText("架构草稿"));
    fireEvent.click(screen.getByRole("button",{name:"PNG 修改"}));
    const next=await screen.findByRole("button",{name:"下一步"});
    await waitFor(()=>expect((next as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole("button",{name:/用此图新建|下载此版本|下载原图/})).toBeNull();
    fireEvent.click(next);fireEvent.click(next);
    await waitFor(()=>expect(api.figureStart).toHaveBeenCalledTimes(1));
    expect(api.figurePrepare).toHaveBeenCalledTimes(1);
    expect(api.figurePrepare.mock.calls[0][0]).toMatchObject({projectId:"project-a",sourceMode:"import",sourceBase64:"AAAA",imageModel:null,model:identity.model,reviewerModel:"independent-reviewer",confirmedRaster:{id:previous.run.id,index:3,hash:"selected"}});
    expect(api.figurePrepare.mock.calls[0][0].method).toContain("Move ARMA inside reservoir");
    expect(api.figureStart).toHaveBeenCalledWith("project-a",prepared.run.id,"selected",1);
    expect(api.figureEditImage).not.toHaveBeenCalled();expect(api.figureSelectRaster).not.toHaveBeenCalled();
    expect(previous.run.requests[0].status).toBe("unknown");
    expect(screen.queryByLabelText(/图形描述/)).toBeNull();
  });
  it("returns to an existing SVG from its reference image without any model call", async () => {
    const existing=fixture();existing.run.imageConfirmed=true;
    api.figureList.mockResolvedValue([existing]);
    render(<FigureStudio />);fireEvent.click(await screen.findByText("架构草稿"));
    fireEvent.click(screen.getByRole("button",{name:"PNG 修改"}));
    const next=await screen.findByRole("button",{name:"下一步"});
    await waitFor(()=>expect((next as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(next);await screen.findByTestId("editor");
    expect(api.figurePrepare).not.toHaveBeenCalled();expect(api.figureStart).not.toHaveBeenCalled();expect(api.figureEditImage).not.toHaveBeenCalled();
  });
  it.each(["returned", "selection", "keep"] as const)("previews and explicitly applies %s without another model request", async (choice) => {
    const pending = fixture(); pending.run.status="image_ready"; pending.run.versions=[]; pending.run.review=null;
    pending.run.rasterVersions=[{ index:1,hash:"source",path:"original",mimeType:"image/png",width:100,height:100,parentHash:null,prompt:null,maskPath:null,requestId:null,createdAt:"" }];
    pending.run.pendingRasterEdit={ ...pending.run.rasterVersions[0], index:0,hash:"returned",path:"request-02.result.png",width:200,height:120,parentHash:"source",parentIndex:1,prompt:"MA",maskPath:"mask",requestId:"request-02" };
    api.figureList.mockResolvedValue([pending]);
    api.figureConnections.mockResolvedValue({ executor:identity,reviewer:identity,image:{available:false,enabled:false,model:null,models:[]} });
    api.figureEditResultDocument.mockImplementation(async (_project,_id,_request,_hash,mode) => ({ dataUrl:"data:image/png;base64,AAAA",hash:mode,index:0,width:mode==="returned"?200:100,height:mode==="returned"?120:100 }));
    api.figureResolveEditResult.mockResolvedValue({ ...pending,run:{...pending.run,pendingRasterEdit:null} });
    render(<FigureStudio />); fireEvent.click(await screen.findByText("架构草稿"));
    await screen.findByRole("img",{name:"图片结果预览"});
    expect((screen.getByRole("button",{name:"下一步"}) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("采用方式") as HTMLSelectElement).value).toBe("selection");
    expect(screen.getByRole("img",{name:"图片结果预览"}).getAttribute("viewBox")).toBe("0 0 100 100");
    fireEvent.change(screen.getByLabelText("采用方式"),{target:{value:choice}});
    const label=choice==="returned"?"使用整张修改图":choice==="selection"?"应用修改":"保留原图";
    const button=screen.getByRole("button",{name:label});
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    const preview=screen.getByRole("img",{name:"图片结果预览"});
    expect(preview.getAttribute("viewBox")).toBe(choice==="returned"?"0 0 200 120":"0 0 100 100");
    expect(api.figureResolveEditResult).not.toHaveBeenCalled();
    fireEvent.click(button); fireEvent.click(button);
    await waitFor(() => expect(api.figureResolveEditResult).toHaveBeenCalledTimes(1));
    expect(api.figureResolveEditResult).toHaveBeenCalledWith("project-a",pending.run.id,"request-02","returned",choice);
    expect(api.figureEditImage).not.toHaveBeenCalled(); expect(api.figureStart).not.toHaveBeenCalled(); expect(api.figurePrepare).not.toHaveBeenCalled();
  });
  it("keeps edit history and the Executor prompt collapsed without technical hints", async () => {
    const pending = fixture(); pending.run.status = "image_ready"; pending.run.versions = []; pending.run.review = null;
    api.figureList.mockResolvedValue([pending]);
    pending.run.rasterVersions=[{index:1,hash:"source",path:"original",mimeType:"image/png",width:100,height:100,parentHash:null,prompt:"Move the ARMA module inside the reservoir and preserve all scientific relationships.",maskPath:null,requestId:null,createdAt:""}];
    api.figureRasterDocument.mockResolvedValue({ dataUrl: "data:image/png;base64,AAAA", hash: "source", index: 1, width: 100, height: 100, resolvedPrompt: "Draw AR and MA inside the reservoir.", promptModel: "vision-executor" });
    render(<FigureStudio />);
    fireEvent.click(await screen.findByText("架构草稿"));
    const history=await screen.findByText("修改记录");
    expect((history.closest("details") as HTMLDetailsElement).open).toBe(false);
    const prompt = await screen.findByText("Executor 整理的提示词");
    expect((prompt.closest("details") as HTMLDetailsElement).open).toBe(false);
    fireEvent.click(prompt);
    expect(screen.getByText("Draw AR and MA inside the reservoir.")).toBeTruthy();
    expect(screen.queryByText(/1 次 Executor \+ 1 次生图调用/)).toBeNull();
    expect((screen.getByLabelText("修改要求") as HTMLTextAreaElement).value).toBe("");
    expect(api.figureEditImage).not.toHaveBeenCalled();
    expect(api.figureStart).not.toHaveBeenCalled();
  });

  it("opens the PNG confirmation stage and starts SVG only after an explicit confirmation", async () => {
    const pending = fixture(); pending.run.status = "image_ready"; pending.run.versions = []; pending.run.review = null; pending.run.sourceRaster = 1;
    api.figureList.mockResolvedValue([pending]);
    api.figureDocument.mockResolvedValue({ svg: null, sourceDataUrl: "data:image/png;base64,AAAA", previewDataUrl: null });
    api.figureStart.mockResolvedValue({ ...pending, active: true, run: { ...pending.run, status: "probing", imageConfirmed: true } });
    render(<FigureStudio />); fireEvent.click(await screen.findByText("架构草稿"));
    const confirm = await screen.findByRole("button", { name: "下一步" });
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
    expect(api.figureStart).not.toHaveBeenCalled(); expect(api.figureEditImage).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("修改要求"), { target: { value: "改为输入层" } });
    expect((screen.getByRole("button", { name: "修改选区" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(confirm); fireEvent.click(confirm);
    await waitFor(() => expect(api.figureStart).toHaveBeenCalledTimes(1));
    expect(api.figureStart).toHaveBeenCalledWith("project-a", "a".repeat(32), "source", 1);
    expect(api.figureEditImage).not.toHaveBeenCalled(); expect(api.figureReview).not.toHaveBeenCalled();
  });
  it("displays a concise legacy title without rewriting its full requirements or history", async () => {
    const pending = fixture();
    pending.run.title = "构建一个ESN的流程图，ESN结合了AR和MA，ARMA应该放到储备池里面的";
    pending.run.method = pending.run.title;
    api.figureList.mockResolvedValue([pending]);
    render(<FigureStudio />); fireEvent.click(await screen.findByText("ESN的流程图"));
    expect(await screen.findByRole("heading", { name: "ESN的流程图", level: 1 })).toBeTruthy();
    expect(pending.run.method).toBe(pending.run.title);
    expect(api.figurePrepare).not.toHaveBeenCalled(); expect(api.figureSave).not.toHaveBeenCalled();
    expect(api.figureStart).not.toHaveBeenCalled();
  });
  it("blocks another PNG request after an unresolved submission but allows local history", async () => {
    const pending = fixture(); pending.run.status = "unknown";
    api.figureList.mockResolvedValue([pending]);
    render(<FigureStudio />); fireEvent.click(await screen.findByText("架构草稿"));
    fireEvent.click(screen.getByRole("button", { name: "PNG 修改" }));
    await screen.findByRole("img", { name: "圈选图片区域" });
    expect((screen.getByRole("button", { name: "修改选区" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/请求结果未决/)).toBeNull();
    fireEvent.click(screen.getByRole("button",{name:"整图修改"}));
    fireEvent.change(screen.getByLabelText("修改要求"),{target:{value:"Move the module"}});
    const edit=screen.getByRole("button",{name:"修改整图"}) as HTMLButtonElement;
    expect(edit.disabled).toBe(true); expect(edit.title).toBe(""); fireEvent.click(edit);
    expect(api.figureStart).not.toHaveBeenCalled(); expect(api.figureEditImage).not.toHaveBeenCalled();
  });
  it("explains the missing selection and allows an explicit whole-image scope without sending a request", async () => {
    const pending = fixture(); pending.run.status = "image_ready"; pending.run.versions = []; pending.run.review = null;
    api.figureList.mockResolvedValue([pending]);
    api.figureDocument.mockResolvedValue({ svg: null, sourceDataUrl: "data:image/png;base64,AAAA", previewDataUrl: null });
    render(<FigureStudio />); fireEvent.click(await screen.findByText("架构草稿"));
    await screen.findByRole("img", { name: "圈选图片区域" });
    fireEvent.change(screen.getByLabelText("修改要求"), { target: { value: "MA" } });
    const selected = screen.getByRole("button", { name: "修改选区" }) as HTMLButtonElement;
    expect(selected.disabled).toBe(true);
    expect(selected.title).toContain("请先在左侧图片拖动圈选区域");
    expect(screen.getByRole("status").textContent).toContain("整图修改");
    fireEvent.click(screen.getByRole("button", { name: "整图修改" }));
    expect((screen.getByRole("button", { name: "修改整图" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("修改范围：整张图片")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("AI 可修改整张图片");
    expect(api.figureEditImage).not.toHaveBeenCalled(); expect(api.figureStart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "圈选区域" }));
    expect((screen.getByRole("button", { name: "修改选区" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("已选 0 个区域")).toBeTruthy();
  });
  it("keeps a text Reviewer result visually pending", async () => {
    api.figureList.mockResolvedValue([fixture()]); render(<FigureStudio />);
    fireEvent.click(await screen.findByText("架构草稿"));
    const review = screen.getByRole("region", { name: "产物与审查" });
    expect(within(review).getAllByText(/结构通过 · 视觉待检查/).length).toBeGreaterThan(0);
    expect(within(review).getByText("待验证／无视觉能力")).toBeTruthy();
    expect(screen.queryByText("结构与视觉通过")).toBeNull();
    expect(api.figureStart).not.toHaveBeenCalled();
  });
  it("expands the request ledger from its pill without sending requests", async () => {
    const run = fixture();
    run.run.requests = [{ id: "r1", kind: "reconstruct", role: "executor", identity, maxOutputTokens: 16384, status: "completed", startedAt: "2026-10-06T10:00:00Z", finishedAt: "2026-10-06T10:00:10Z", stopReason: "length", usage: { inputTokens: 400, outputTokens: 16384 }, error: null, durationMs: 10000 }];
    api.figureList.mockResolvedValue([run]); render(<FigureStudio />);
    fireEvent.click(await screen.findByText("架构草稿"));
    fireEvent.click(screen.getByLabelText("展开运行记录"));
    const ledger = screen.getByRole("region", { name: "运行记录" });
    expect(within(ledger).getByText("重建 SVG")).toBeTruthy();
    expect(within(ledger).getByText(/length · 截断/)).toBeTruthy();
    expect(within(ledger).getByText(/16,384\/16K/)).toBeTruthy();
    expect(api.figureStart).not.toHaveBeenCalled(); expect(api.figureReview).not.toHaveBeenCalled();
  });
  it("submits an imported figure once with the current project", async () => {
    const prepared = fixture(); prepared.run.status = "ready"; prepared.run.versions = [];
    api.figurePrepare.mockResolvedValue(prepared); api.figureStart.mockResolvedValue({ ...prepared, active: true });
    render(<FigureStudio />);
    await screen.findByRole("option", { name: "independent-reviewer" });
    fireEvent.change(screen.getByLabelText(/图形描述/), { target: { value: "A points to B" } });
    fireEvent.change(screen.getByLabelText("上传参考图"), { target: { files: [new File([new Uint8Array([1, 2, 3])], "source.png", { type: "image/png" })] } });
    await screen.findByText("source.png");
    const button = screen.getByText("预览参考图"); fireEvent.click(button); fireEvent.click(button);
    await waitFor(() => expect(api.figureStart).toHaveBeenCalledTimes(1));
    expect(api.figurePrepare).toHaveBeenCalledTimes(1);
    expect(api.figurePrepare.mock.calls[0][0]).toMatchObject({ projectId: "project-a", title: "A points to B", method: "A points to B", sourceMode: "import", model: "vision-executor", reviewerModel: "independent-reviewer", imageModel: null });
    // The output cap follows Chat on the native side; the UI never sends one.
    expect(api.figurePrepare.mock.calls[0][0]).not.toHaveProperty("outputLimit");
    expect(screen.queryByText(/输出上限/)).toBeNull();
  });
  it("resolves a verified task model before enabling paid work", async () => {
    api.figureConnections.mockImplementation(async (model: string | null) => ({ executor: { ...identity, model: model ?? identity.model }, executorModels: [identity.model, "other-vision-model"], reviewer: { ...identity, model: "independent-reviewer" }, image: { available: true, enabled: true, model: "somni-image", models: ["somni-image"] } }));
    render(<FigureStudio />); await screen.findByText("other-vision-model");
    fireEvent.change(screen.getByLabelText("Executor 模型"), { target: { value: "other-vision-model" } });
    await waitFor(() => expect(api.figureConnections).toHaveBeenCalledWith("other-vision-model", null));
    expect(api.figurePrepare).not.toHaveBeenCalled(); expect(api.figureStart).not.toHaveBeenCalled();
  });
  it.each(["executor", "reviewer"] as const)("recovers conflicting defaults by changing the %s without losing model choices", async (role) => {
    api.figureConnections.mockImplementation(async (executor: string | null, reviewer: string | null): Promise<FigureConnections> => {
      const executorModel = executor ?? identity.model;
      const reviewerModel = reviewer ?? identity.model;
      const conflict = executorModel === reviewerModel;
      return {
        executor: conflict ? null : { ...identity, model: executorModel },
        reviewer: conflict ? null : { ...identity, model: reviewerModel },
        executorModel, reviewerModel,
        executorModels: [identity.model, "other-model"], reviewerModels: [identity.model, "other-model"],
        image: { available: true, enabled: true, model: "somni-image", models: ["somni-image", "somni-image-pro"] },
        error: conflict ? "Figure Executor and independent Reviewer must use different models" : null,
      };
    });
    const prepared = fixture(); prepared.run.status = "ready"; prepared.run.versions = [];
    api.figurePrepare.mockResolvedValue(prepared); api.figureStart.mockResolvedValue({ ...prepared, active: true });
    render(<FigureStudio />);
    await screen.findByText("执行模型与审查模型相同，请更换其中一个模型以进行独立审查。");
    const executor = screen.getByLabelText("Executor 模型") as HTMLSelectElement;
    const reviewer = screen.getByLabelText("Reviewer 模型") as HTMLSelectElement;
    expect(executor.value).toBe(identity.model); expect(reviewer.value).toBe(identity.model);
    expect(within(executor).getByRole("option", { name: "other-model" })).toBeTruthy();
    expect(within(reviewer).getByRole("option", { name: "other-model" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("生图模型"), { target: { value: "somni-image-pro" } });
    fireEvent.change(screen.getByLabelText("图形描述"), { target: { value: "A → B" } });
    const submit = screen.getByRole("button", { name: "生成图形" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit); expect(api.figurePrepare).not.toHaveBeenCalled();
    fireEvent.change(role === "executor" ? executor : reviewer, { target: { value: "other-model" } });
    await waitFor(() => expect(submit.disabled).toBe(false));
    expect(api.figureConnections).toHaveBeenLastCalledWith(role === "executor" ? "other-model" : null, role === "reviewer" ? "other-model" : null);
    expect(screen.queryByText("执行模型与审查模型相同，请更换其中一个模型以进行独立审查。")).toBeNull();
    fireEvent.click(submit);
    await waitFor(() => expect(api.figureStart).toHaveBeenCalledTimes(1));
    expect(api.figurePrepare.mock.calls[0][0]).toMatchObject({
      model: role === "executor" ? "other-model" : identity.model,
      reviewerModel: role === "reviewer" ? "other-model" : identity.model,
      imageModel: "somni-image-pro",
    });
  });
  it("retains both selections while resolving and after a rejected model change", async () => {
    const resolved: FigureConnections = {
      executor: identity, reviewer: { ...identity, model: "independent-reviewer" },
      executorModels: [identity.model, "other-model"], reviewerModels: ["independent-reviewer", "second-reviewer"],
      image: { available: true, enabled: true, model: "somni-image", models: ["somni-image"] },
    };
    let reject!: (error: Error) => void;
    api.figureConnections.mockResolvedValueOnce(resolved).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; })).mockResolvedValue(resolved);
    render(<FigureStudio />); await screen.findByRole("option", { name: "other-model" });
    fireEvent.change(screen.getByLabelText("图形描述"), { target: { value: "A → B" } });
    const submit = screen.getByRole("button", { name: "生成图形" }) as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Executor 模型"), { target: { value: "other-model" } });
    expect((screen.getByLabelText("Reviewer 模型") as HTMLSelectElement).value).toBe("independent-reviewer");
    expect(submit.disabled).toBe(true);
    await act(async () => reject(new Error("Model setup failed")));
    await screen.findByText("Error: Model setup failed");
    expect((screen.getByLabelText("Executor 模型") as HTMLSelectElement).value).toBe("other-model");
    expect((screen.getByLabelText("Reviewer 模型") as HTMLSelectElement).value).toBe("independent-reviewer");
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Executor 模型"), { target: { value: identity.model } });
    await waitFor(() => expect(submit.disabled).toBe(false));
    expect(api.figurePrepare).not.toHaveBeenCalled(); expect(api.figureStart).not.toHaveBeenCalled();
  });
  it("generates the reference when nothing is uploaded, with the chosen Reviewer and image model", async () => {
    api.figureConnections.mockImplementation(async (_model: string | null, reviewer: string | null) => ({ executor: identity, executorModels: [identity.model], reviewer: { ...identity, model: reviewer ?? "independent-reviewer" }, reviewerModels: ["independent-reviewer", "second-reviewer", identity.model], image: { available: true, enabled: true, model: "somni-image", models: ["somni-image", "somni-image-pro"] } }));
    const prepared = fixture(); prepared.run.status = "ready"; prepared.run.versions = []; prepared.run.sourceMode = "generate";
    api.figurePrepare.mockResolvedValue(prepared); api.figureStart.mockResolvedValue({ ...prepared, active: true });
    render(<FigureStudio />); await screen.findByText("second-reviewer");
    const reviewer = screen.getByLabelText("Reviewer 模型");
    expect(within(reviewer).queryByText(identity.model)).toBeNull();
    fireEvent.change(reviewer, { target: { value: "second-reviewer" } });
    await waitFor(() => expect(api.figureConnections).toHaveBeenCalledWith(null, "second-reviewer"));
    fireEvent.change(screen.getByLabelText("生图模型"), { target: { value: "somni-image-pro" } });
    fireEvent.change(screen.getByLabelText("布局"), { target: { value: "vertical" } });
    fireEvent.change(screen.getByLabelText("配色"), { target: { value: "mono" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /印刷适配/ }));
    fireEvent.click(screen.getByRole("radio", { name: "张量与空间" }));
    fireEvent.change(screen.getByLabelText(/图形描述/), { target: { value: "## 研究流程\nA → B" } });
    fireEvent.click(await screen.findByText("生成图形"));
    await waitFor(() => expect(api.figureStart).toHaveBeenCalledTimes(1));
    expect(api.figurePrepare.mock.calls[0][0]).toMatchObject({ title: "研究流程", sourceMode: "generate", sourceBase64: null, reviewerModel: "second-reviewer", imageModel: "somni-image-pro" });
    expect(parseFigureStyle(api.figurePrepare.mock.calls[0][0].style)).toEqual({ family: "tensors", layout: "vertical", palette: "mono", density: "balanced", print: true });
    expect(api.figurePrepare.mock.calls[0][0].style).toContain("stacked planes");
  });
  it("deletes a figure only after confirmation and never while it runs", async () => {
    const running = fixture(); running.run.id = "b".repeat(32); running.run.title = "运行中"; running.active = true;
    api.figureList.mockResolvedValue([fixture(), running]); api.figureDelete.mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<FigureStudio />); fireEvent.click(await screen.findByText("架构草稿"));
    expect((screen.getByLabelText("删除 运行中") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("删除 架构草稿"));
    expect(api.figureDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("删除 架构草稿"));
    await waitFor(() => expect(api.figureDelete).toHaveBeenCalledWith("project-a", "a".repeat(32)));
    await waitFor(() => expect(screen.queryByText("架构草稿")).toBeNull());
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(screen.getByText("生成图形")).toBeTruthy();
    expect(api.figureStart).not.toHaveBeenCalled();
  });
  it("keeps the figure visible and blocks repeated deletion until disk cleanup succeeds", async () => {
    api.figureList.mockResolvedValue([fixture()]);
    let fail!: (error: Error) => void;
    api.figureDelete.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<FigureStudio />); fireEvent.click(await screen.findByText("架构草稿"));
    fireEvent.click(screen.getByLabelText("删除 架构草稿"));
    await waitFor(() => expect(api.figureDelete).toHaveBeenCalledTimes(1));
    expect((screen.getByLabelText("删除 架构草稿") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("heading", { name: "架构草稿" })).toBeTruthy();
    await act(async () => fail(new Error("Cannot remove figure usage records")));
    expect(await screen.findByText(/Cannot remove figure usage records/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "架构草稿" })).toBeTruthy();
    expect((screen.getByLabelText("删除 架构草稿") as HTMLButtonElement).disabled).toBe(false);
  });
  it("loads a domain scenario explicitly, preserves visual choices and forwards it only after submission", async () => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.setAttribute("open", ""); } });
    Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.removeAttribute("open"); } });
    const prepared = fixture(); prepared.run.status = "ready"; prepared.run.versions = []; prepared.run.sourceMode = "generate";
    api.figurePrepare.mockResolvedValue(prepared); api.figureStart.mockResolvedValue({ ...prepared, active: true });
    render(<FigureStudio />); await screen.findByRole("option", { name: "independent-reviewer" });
    fireEvent.change(screen.getByLabelText("图形描述"), { target: { value: "我的研究需求" } });
    fireEvent.change(screen.getByLabelText("配色"), { target: { value: "mono" } });
    fireEvent.change(screen.getByLabelText("间距"), { target: { value: "compact" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /印刷适配/ }));
    fireEvent.click(screen.getByRole("radio", { name: "张量与空间" }));
    expect((screen.getByLabelText("图形描述") as HTMLTextAreaElement).value).toBe("我的研究需求");
    fireEvent.click(screen.getByRole("button", { name: "学科示例" }));
    fireEvent.click(screen.getByRole("button", { name: "查看Transformer 编码器细节" }));
    fireEvent.click(screen.getByRole("button", { name: "替换描述并载入场景" }));
    expect((screen.getByLabelText("图形描述") as HTMLTextAreaElement).value).toMatch(/^Transformer 编码器与多头自注意力展开/);
    expect((screen.getByLabelText("配色") as HTMLSelectElement).value).toBe("mono");
    expect((screen.getByLabelText("间距") as HTMLSelectElement).value).toBe("compact");
    expect(api.figurePrepare).not.toHaveBeenCalled(); expect(api.figureStart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "生成图形" }));
    await waitFor(() => expect(api.figureStart).toHaveBeenCalledTimes(1));
    expect(api.figurePrepare.mock.calls[0][0].method).toContain("第一条残差");
    expect(api.figurePrepare.mock.calls[0][0].method).toContain("QKᵀ / √dₖ");
    expect(parseFigureStyle(api.figurePrepare.mock.calls[0][0].style)).toEqual({ family: "tensors", layout: "auto", palette: "mono", density: "compact", print: true });
  });
  it("starts from a quick example and a visual style preset", async () => {
    render(<FigureStudio />); await screen.findByRole("option", { name: "independent-reviewer" });
    fireEvent.click(screen.getByText("训练流程"));
    expect((screen.getByLabelText(/图形描述/) as HTMLTextAreaElement).value).toMatch(/^模型训练流程图\n/);
    expect(screen.queryByText("快速示例")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "抽象关系图" }));
    expect(screen.getByRole("radio", { name: "抽象关系图" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "技术框图" }).getAttribute("aria-checked")).toBe("false");
  });
  it("starts a new task from a submitted one, reusing its reference image", async () => {
    api.figureList.mockResolvedValue([fixture()]);
    api.figureDocument.mockResolvedValue({ svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>A</text></svg>', sourceDataUrl: "data:image/png;base64,AAAA", previewDataUrl: null });
    render(<FigureStudio />); fireEvent.click(await screen.findByText("架构草稿"));
    await screen.findByTestId("editor");
    fireEvent.click(screen.getByRole("tab", { name: "任务输入" }));
    expect(screen.getByText("A → B")).toBeTruthy();
    fireEvent.click(screen.getByText("用相同输入新建"));
    expect((await screen.findByLabelText(/图形描述/) as HTMLTextAreaElement).value).toBe("A → B");
    expect(screen.getByText("原任务参考图")).toBeTruthy();
    expect(screen.getByText("预览参考图")).toBeTruthy();
    expect(api.figurePrepare).not.toHaveBeenCalled(); expect(api.figureStart).not.toHaveBeenCalled();
  });
  it("exports from the menu without any model call", async () => {
    api.figureList.mockResolvedValue([fixture()]); api.figureExport.mockResolvedValue({ filename: "figure.svg", mimeType: "image/svg+xml", dataBase64: "" });
    // jsdom has no blob URLs; the browser-download fallback only needs them to exist.
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:figure"), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    render(<FigureStudio />); fireEvent.click(await screen.findByText("架构草稿"));
    await screen.findByTestId("editor");
    fireEvent.click(screen.getByRole("button", { name: "导出" }));
    const menu = screen.getByRole("menu", { name: "导出格式" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent?.slice(0, 3))).toEqual(["SVG", "PNG", "PDF"]);
    fireEvent.click(within(menu).getByText("PDF"));
    await waitFor(() => expect(api.figureExport).toHaveBeenCalledWith("project-a", "a".repeat(32), "pdf", null, null));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(api.figureStart).not.toHaveBeenCalled(); expect(api.figureReview).not.toHaveBeenCalled();
  });
  it("saves against the parent hash and retains an unsaved draft on conflict", async () => {
    api.figureList.mockResolvedValue([fixture()]); api.figureSave.mockRejectedValue(new Error("Figure changed. Reload before saving"));
    render(<FigureStudio />); fireEvent.click(await screen.findByText("架构草稿"));
    await screen.findByTestId("editor"); fireEvent.click(screen.getByText("SVG 源码"));
    const source = screen.getByLabelText("SVG");
    fireEvent.change(source, { target: { value: '<svg xmlns="http://www.w3.org/2000/svg"><text>Changed</text></svg>' } });
    fireEvent.click(screen.getByRole("button", { name: /保存新版本/ }));
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
    fireEvent.click(screen.getByRole("button", { name: /保存新版本/ }));
    await waitFor(() => expect(api.figureSave).toHaveBeenCalled());
    expect(api.figureSave.mock.calls[0][2]).toBeNull();
    expect(api.figureStart).not.toHaveBeenCalled(); expect(api.figureReview).not.toHaveBeenCalled();
  });
  it("explains a reasoning-heavy truncation and prefills a new task that reuses the image", async () => {
    const run = fixture(); run.run.status = "budget_truncated"; run.run.versions = []; run.run.sourceMode = "generate";
    run.run.executor = { ...identity, model: "MiniMax-M3.1-Flash-Preview" };
    run.run.requests = [{ id: "r1", kind: "reconstruct", role: "executor", identity, maxOutputTokens: 16384, status: "completed", startedAt: "", finishedAt: null, stopReason: "length", usage: { outputTokens: 16384 }, error: null, durationMs: 202604 }];
    api.figureList.mockResolvedValue([run]);
    api.figureDocument.mockResolvedValue({ svg: null, rawOutput: `<svg xmlns="http://www.w3.org/2000/svg">${" ".repeat(9200)}`, sourceDataUrl: "data:image/png;base64,AAAA", previewDataUrl: null });
    render(<FigureStudio />); fireEvent.click(await screen.findByText("架构草稿"));
    expect(await screen.findByText(/只有 9,240 个字符/)).toBeTruthy();
    expect(screen.getByText(/MiniMax-M3.1-Flash-Preview 的隐藏推理/)).toBeTruthy();
    expect(screen.getByText(/新任务的输出上限与 Chat 相同/)).toBeTruthy();
    fireEvent.click(screen.getByText("换个 Executor 新建 · 复用参考图"));
    expect((await screen.findByLabelText(/图形描述/) as HTMLTextAreaElement).value).toBe("A → B");
    expect(screen.getByText("原任务参考图")).toBeTruthy();
    expect((screen.getByLabelText("Executor 模型") as HTMLSelectElement).disabled).toBe(false);
    expect(screen.getByText("预览参考图")).toBeTruthy();
    expect(api.figurePrepare).not.toHaveBeenCalled(); expect(api.figureStart).not.toHaveBeenCalled();
  });
});
