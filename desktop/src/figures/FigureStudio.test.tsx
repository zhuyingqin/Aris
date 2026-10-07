// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FigureView } from "./types";

const state = vi.hoisted(() => ({ currentProject: { id: "project-a", name: "Research" }, language: "cn", setTab: vi.fn(), setFigureDirty: vi.fn() }));
const api = vi.hoisted(() => ({ figureEditSvg: vi.fn(), figureList: vi.fn(), figureConnections: vi.fn(), figurePrepare: vi.fn(), figureStart: vi.fn(), figureDocument: vi.fn(), figureSave: vi.fn(), figureReview: vi.fn(), figureCancel: vi.fn(), figureExport: vi.fn(), figureDelete: vi.fn(), figureSelectRaster: vi.fn(), figureEditImage: vi.fn(), figureEditResultDocument: vi.fn(), figureResolveEditResult: vi.fn(), figureRasterDocument: vi.fn(), figureExportRaster: vi.fn(), onFigureUpdated: vi.fn() }));
vi.mock("../store", () => ({ useStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), { getState: () => state }) }));
vi.mock("../api/tauri", () => ({ isTauri: () => false }));
vi.mock("./figureApi", () => ({ ...api, figuresAvailable: () => true }));
vi.mock("./FigureEditor", async () => ({ default: (await import("react")).forwardRef(() => <div data-testid="editor" />) }));
vi.mock("./FigureSourceEditor", () => ({ default: ({ value, readOnly, onChange }: { value: string; readOnly: boolean; onChange: (svg: string) => void }) => <textarea aria-label="SVG" value={value} readOnly={readOnly} onChange={(event) => onChange(event.target.value)} /> }));
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
  api.figureRasterDocument.mockResolvedValue({ dataUrl: "data:image/png;base64,AAAA", hash: "source", index: 1, width: 100, height: 100 });
  api.onFigureUpdated.mockResolvedValue(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("SomniQ figure application", () => {
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
  it("submits an imported figure once with the displayed budget and current project", async () => {
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
    fireEvent.change(screen.getByLabelText(/图形描述/), { target: { value: "## 研究流程\nA → B" } });
    fireEvent.click(await screen.findByText("生成图形"));
    await waitFor(() => expect(api.figureStart).toHaveBeenCalledTimes(1));
    expect(api.figurePrepare.mock.calls[0][0]).toMatchObject({ title: "研究流程", sourceMode: "generate", sourceBase64: null, reviewerModel: "second-reviewer", imageModel: "somni-image-pro" });
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
  it("starts from a quick example and a visual style preset", async () => {
    render(<FigureStudio />); await screen.findByRole("option", { name: "independent-reviewer" });
    fireEvent.click(screen.getByText("训练流程"));
    expect((screen.getByLabelText(/图形描述/) as HTMLTextAreaElement).value).toMatch(/^模型训练流程图\n/);
    expect(screen.queryByText("快速示例")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "极简线框" }));
    expect(screen.getByRole("radio", { name: "极简线框" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "学术扁平" }).getAttribute("aria-checked")).toBe("false");
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
