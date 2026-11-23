// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfPage } from "../PdfPage";

function makePdf(): PDFDocumentProxy {
  const page = {
    view: [0, 0, 240, 120],
    getViewport: ({ scale }: { scale: number }) => ({
      width: 240 * scale,
      height: 120 * scale,
      transform: [scale, 0, 0, -scale, 0, 120 * scale],
      convertToPdfPoint: (x: number, y: number) => [x / scale, 120 - y / scale],
      convertToViewportRectangle: ([x1, y1, x2, y2]: number[]) => [
        x1 * scale, (120 - y1) * scale, x2 * scale, (120 - y2) * scale,
      ],
    }),
    getTextContent: async () => ({ items: [
      { str: "Forecast validation", transform: [10, 0, 0, 10, 20, 64], width: 100, height: 10, hasEOL: true },
      { str: "Next line", transform: [10, 0, 0, 10, 20, 44], width: 60, height: 10 },
    ] }),
    getAnnotations: async () => [{
      subtype: "Link", rect: [20, 54, 120, 68], dest: "validation",
    }],
    render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
  };
  return { getPage: async () => page } as unknown as PDFDocumentProxy;
}

async function renderPage() {
  const onSourceTextClick = vi.fn();
  const onPdfLinkClick = vi.fn();
  const view = render(<PdfPage pdf={makePdf()} page={1} zoom={1.5}
    onSourceTextClick={onSourceTextClick} onPdfLinkClick={onPdfLinkClick} />);
  await waitFor(() => expect(view.container.querySelector(".typeset-pdf-text-run")).toBeTruthy());
  const page = view.container.querySelector<HTMLElement>(".typeset-pdf-page")!;
  const text = view.container.querySelector<HTMLElement>(".typeset-pdf-text-run")!;
  const layer = view.container.querySelector<HTMLElement>(".typeset-pdf-text-layer")!;
  vi.spyOn(page, "getBoundingClientRect").mockReturnValue({
    left: 100, top: 200, right: 460, bottom: 380, width: 360, height: 180,
    x: 100, y: 200, toJSON: () => ({}),
  });
  const nextLine = view.container.querySelectorAll<HTMLElement>(".typeset-pdf-text-run")[1];
  for (const [run, top, width] of [[text, 273, 150], [nextLine, 303, 90]] as const) {
    vi.spyOn(run, "getBoundingClientRect").mockReturnValue({
      left: 130, top, right: 130 + width, bottom: top + 15, width, height: 15,
      x: 130, y: top, toJSON: () => ({}),
    });
  }
  return { ...view, page, text, layer, nextLine, onSourceTextClick, onPdfLinkClick };
}

describe("PDF selection and navigation", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
  });

  afterEach(() => {
    cleanup();
    window.getSelection()?.removeAllRanges();
    vi.restoreAllMocks();
  });

  it("follows an annotation through the text layer using page-relative coordinates at zoom", async () => {
    const { text, onPdfLinkClick } = await renderPage();
    fireEvent.mouseDown(text, { clientX: 140, clientY: 285 });
    fireEvent.click(text, { clientX: 140, clientY: 285, detail: 1 });
    expect(onPdfLinkClick).toHaveBeenCalledTimes(1);
    expect(onPdfLinkClick).toHaveBeenCalledWith("validation");
  });

  it("leaves a drag from page whitespace through a link to text selection", async () => {
    const { layer, text, onPdfLinkClick, onSourceTextClick } = await renderPage();
    fireEvent.mouseDown(layer, { clientX: 125, clientY: 300 });
    fireEvent.mouseMove(text, { clientX: 140, clientY: 285 });
    fireEvent.click(text, { clientX: 140, clientY: 285, detail: 1 });
    expect(onPdfLinkClick).not.toHaveBeenCalled();
    expect(onSourceTextClick).not.toHaveBeenCalled();
  });

  it("keeps a drag anchored in linked text even when the pointer returns to its start", async () => {
    const { text, onPdfLinkClick } = await renderPage();
    fireEvent.mouseDown(text, { clientX: 140, clientY: 285 });
    fireEvent.mouseMove(text, { clientX: 190, clientY: 290 });
    fireEvent.mouseMove(text, { clientX: 140, clientY: 285 });
    fireEvent.click(text, { clientX: 140, clientY: 285, detail: 1 });
    expect(onPdfLinkClick).not.toHaveBeenCalled();
  });

  it("does not follow a link while a native text selection is still active", async () => {
    const { text, onPdfLinkClick } = await renderPage();
    const range = document.createRange();
    range.selectNodeContents(text);
    window.getSelection()!.addRange(range);
    fireEvent.click(text, { clientX: 140, clientY: 285, detail: 1 });
    expect(onPdfLinkClick).not.toHaveBeenCalled();
    expect(window.getSelection()!.toString()).toBe("Forecast validation");
  });

  it("anchors a drag in line-end whitespace to that line and keeps its text selected after mouseup", async () => {
    const { layer, nextLine, text, onPdfLinkClick, onSourceTextClick } = await renderPage();
    fireEvent.mouseDown(layer, { clientX: 285, clientY: 280, detail: 1 });
    fireEvent.mouseMove(nextLine, { clientX: 175, clientY: 310 });
    fireEvent.mouseUp(window);
    expect(window.getSelection()!.anchorNode).toBe(text.firstChild);
    expect(window.getSelection()!.anchorOffset).toBe(text.textContent!.length);
    // jsdom's Selection omits <br>; line-ending preservation is covered by
    // the PDF content test and the real-browser selection check.
    expect(window.getSelection()!.toString()).toBe("Next ");
    expect(onPdfLinkClick).not.toHaveBeenCalled();
    expect(onSourceTextClick).not.toHaveBeenCalled();
  });

  it("can select backwards and start a new drag inside the existing selection", async () => {
    const { layer, nextLine, text } = await renderPage();
    fireEvent.mouseDown(nextLine, { clientX: 175, clientY: 310, detail: 1 });
    fireEvent.mouseMove(layer, { clientX: 125, clientY: 280 });
    fireEvent.mouseUp(window);
    expect(window.getSelection()!.toString()).toBe("Forecast validationNext ");
    // Prevent browser text drag-and-drop from swallowing the next selection.
    expect(fireEvent.mouseDown(text, { clientX: 140, clientY: 280, detail: 1 })).toBe(false);
    fireEvent.mouseMove(nextLine, { clientX: 220, clientY: 310 });
    fireEvent.mouseUp(window);
    expect(window.getSelection()!.toString()).toBe("orecast validationNext line");
  });

  it("keeps double-click source lookup available in whitespace and keyboard activation on annotations", async () => {
    const { container, layer, onSourceTextClick, onPdfLinkClick } = await renderPage();
    fireEvent.mouseDown(layer, { clientX: 400, clientY: 350 });
    fireEvent.doubleClick(layer, { clientX: 400, clientY: 350 });
    expect(onSourceTextClick).toHaveBeenCalledWith(expect.any(String), expect.any(String),
      expect.objectContaining({ page: 1, x: 200, y: 100 }));
    fireEvent.click(container.querySelector(".typeset-pdf-link")!, { detail: 0 });
    expect(onPdfLinkClick).toHaveBeenCalledTimes(1);
    expect(onPdfLinkClick).toHaveBeenCalledWith("validation");
  });
});
