// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { latexForwardSearch, type SyncTexLocation } from "../../api/tauri";
import { openPdfDocumentFromPath } from "../../pdf/runtime";
import { compiledDiagramBox, renderCompiledDiagram } from "../compiledDiagramPreview";

vi.mock("../../api/tauri", () => ({ latexForwardSearch: vi.fn() }));
vi.mock("../../pdf/runtime", () => ({ openPdfDocumentFromPath: vi.fn() }));

const request = { pdfPath: "chapter.pdf", revision: 1, sourcePath: "chapter.tex", endLine: 214 };
const tight: SyncTexLocation = { page: 2, pointX: 98, pointY: 349, boxLeft: 98, boxTop: 342, boxWidth: 386, boxHeight: 168 };
const parent: SyncTexLocation = { ...tight, boxLeft: 71, boxWidth: 442 };

beforeEach(() => vi.resetAllMocks());

function pdfFixture(promise = Promise.resolve()) {
  const cancel = vi.fn();
  const page = {
    getViewport: vi.fn(({ scale, ...rest }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale, ...rest })),
    render: vi.fn(() => ({ promise, cancel })),
  };
  const pdf = { getPage: vi.fn(async () => page), destroy: vi.fn(async () => {}) };
  vi.mocked(latexForwardSearch).mockResolvedValue({ found: true, locations: [parent, tight, tight], stderr: "" });
  vi.mocked(openPdfDocumentFromPath).mockResolvedValue(pdf as never);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as never);
  return { page, pdf, cancel };
}

describe("compiled diagram preview", () => {
  it("uses the tight drawing box from real SyncTeX-style results", () => {
    expect(compiledDiagramBox([parent, tight, { ...tight, boxWidth: 12, boxHeight: 9 }])).toBe(tight);
    expect(compiledDiagramBox([{ ...tight, boxHeight: NaN }, { ...tight, page: -1 }])).toBeNull();
  });

  it("renders only the diagram on its actual PDF page and releases the document", async () => {
    const { page, pdf } = pdfFixture();
    const canvas = await renderCompiledDiagram(request, new AbortController().signal);
    expect(latexForwardSearch).toHaveBeenCalledWith("chapter.tex", "chapter.pdf", 214, 1);
    expect(pdf.getPage).toHaveBeenCalledWith(2);
    expect(canvas.width).toBe(683);
    expect(canvas.height).toBe(301);
    expect(page.getViewport).toHaveBeenLastCalledWith({ scale: 1.75, offsetX: -168, offsetY: -595 });
    expect(page.render).toHaveBeenCalledWith(expect.objectContaining({ canvas, canvasContext: {} }));
    expect(pdf.destroy).toHaveBeenCalledOnce();
  });

  it("clamps drawing margins to the PDF page", async () => {
    const { page } = pdfFixture();
    vi.mocked(latexForwardSearch).mockResolvedValue({ found: true, locations: [{ ...tight, boxLeft: 0, boxTop: 0 }], stderr: "" });
    const canvas = await renderCompiledDiagram(request, new AbortController().signal);
    expect(canvas.width).toBe(679);
    expect(canvas.height).toBe(298);
    expect(page.getViewport).toHaveBeenLastCalledWith({ scale: 1.75, offsetX: -0, offsetY: -0 });
  });

  it("does not load a PDF when no usable synchronized box exists", async () => {
    pdfFixture();
    vi.mocked(latexForwardSearch).mockResolvedValue({ found: false, locations: [], stderr: "" });
    await expect(renderCompiledDiagram(request, new AbortController().signal)).rejects.toThrow("bounds");
    expect(openPdfDocumentFromPath).not.toHaveBeenCalled();
  });

  it("cancels an unmounted drawing and releases the PDF after rendering rejects", async () => {
    let rejectRender!: (error: Error) => void;
    const { page, pdf, cancel } = pdfFixture(new Promise<void>((_resolve, reject) => { rejectRender = reject; }));
    cancel.mockImplementation(() => rejectRender(new Error("cancelled")));
    const controller = new AbortController();
    const rendering = renderCompiledDiagram(request, controller.signal);
    const assertion = expect(rendering).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(page.render).toHaveBeenCalledOnce());
    controller.abort();
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
    expect(pdf.destroy).toHaveBeenCalledOnce();
  });

  it("releases the PDF when a drawing page cannot be loaded", async () => {
    const { pdf } = pdfFixture();
    pdf.getPage.mockRejectedValue(new Error("missing page"));
    await expect(renderCompiledDiagram(request, new AbortController().signal)).rejects.toThrow("missing page");
    expect(pdf.destroy).toHaveBeenCalledOnce();
  });
});
