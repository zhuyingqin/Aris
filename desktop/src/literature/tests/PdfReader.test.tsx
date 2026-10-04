// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PdfAnnotation } from "../literatureTypes";

const readerMocks = vi.hoisted(() => {
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({
      width: 240 * scale,
      height: 120 * scale,
    }),
    getTextContent: vi.fn().mockResolvedValue({ items: [] }),
  };
  const document = {
    numPages: 3,
    getPage: vi.fn().mockResolvedValue(page),
    destroy: vi.fn(),
  };
  return {
    isTauri: vi.fn(() => false),
    chatModelOptions: vi.fn(),
    fileReadBytes: vi.fn().mockResolvedValue([]),
    literaturePdfBytes: vi.fn().mockResolvedValue([]),
    openPdfDocument: vi.fn().mockResolvedValue(document),
    openPdfDocumentFromPath: vi.fn().mockResolvedValue(document),
    getPdfJs: vi.fn(),
    renderPdfPageToCanvas: vi.fn((_page, _canvas, scale: number) => ({
      task: { promise: Promise.resolve(), cancel: vi.fn() },
      viewport: { width: 240 * scale, height: 120 * scale },
      outputScale: 1,
      cssWidth: 240 * scale,
      cssHeight: 120 * scale,
    })),
    document,
    page,
  };
});

vi.mock("../../api/tauri", () => ({
  isTauri: readerMocks.isTauri,
  chatModelOptions: readerMocks.chatModelOptions,
  fileReadBytes: readerMocks.fileReadBytes,
  literaturePdfBytes: readerMocks.literaturePdfBytes,
}));

vi.mock("../../pdf/runtime", () => ({
  getPdfJs: readerMocks.getPdfJs,
  openPdfDocument: readerMocks.openPdfDocument,
  openPdfDocumentFromPath: readerMocks.openPdfDocumentFromPath,
}));

vi.mock("../../pdf/canvas", () => ({
  renderPdfPageToCanvas: readerMocks.renderPdfPageToCanvas,
}));

import PdfReader, {
  clampFloatingToolbarPosition,
  firstPageForLayout,
  fitZoomForLayout,
  fitZoomForPage,
  highlightBoxesForPage,
  pageRangeForLayout,
} from "../PdfReader";
import { useStore } from "../../store";

beforeEach(() => {
  useStore.setState({ language: "cn", languagePreferenceSet: true });
  readerMocks.isTauri.mockReset().mockReturnValue(false);
  readerMocks.chatModelOptions.mockReset().mockResolvedValue({
    provider: "test",
    current: "default-model",
    options: [{ value: "default-model", label: "Default model", description: null }],
  });
  readerMocks.fileReadBytes.mockReset().mockResolvedValue([]);
  readerMocks.literaturePdfBytes.mockReset().mockResolvedValue([]);
  readerMocks.openPdfDocument.mockReset().mockResolvedValue(readerMocks.document);
  readerMocks.openPdfDocumentFromPath.mockReset().mockResolvedValue(readerMocks.document);
  readerMocks.getPdfJs.mockReset().mockResolvedValue({});
  readerMocks.renderPdfPageToCanvas.mockReset().mockImplementation((_page, _canvas, scale: number) => ({
    task: { promise: Promise.resolve(), cancel: vi.fn() },
    viewport: { width: 240 * scale, height: 120 * scale },
    outputScale: 1,
    cssWidth: 240 * scale,
    cssHeight: 120 * scale,
  }));
  readerMocks.page.getTextContent.mockReset().mockResolvedValue({ items: [] });
  readerMocks.document.numPages = 3;
  readerMocks.document.getPage.mockReset().mockResolvedValue(readerMocks.page);
  readerMocks.document.destroy.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const annotation: PdfAnnotation = {
  id: "annotation-1",
  page: 1,
  quote: "Original core",
  note: "Original note",
  kind: "note",
  color: "purple",
  rects: [{ left: 0.1, top: 0.2, width: 0.3, height: 0.1 }],
  createdAt: "2026-06-13T00:00:00.000Z",
};

const renderReader = (overrides: {
  paperId?: string;
  initialPage?: number;
  onAddAnnotation?: ReturnType<typeof vi.fn>;
  onUpdateAnnotation?: ReturnType<typeof vi.fn>;
  onDeleteAnnotation?: ReturnType<typeof vi.fn>;
  onRunAi?: ReturnType<typeof vi.fn>;
  onReveal?: ReturnType<typeof vi.fn>;
  readOnly?: boolean;
} = {}) => {
  const handlers = {
    onAddAnnotation: overrides.onAddAnnotation ?? vi.fn(),
    onUpdateAnnotation: overrides.onUpdateAnnotation ?? vi.fn(),
    onDeleteAnnotation: overrides.onDeleteAnnotation ?? vi.fn(),
    onRunAi: overrides.onRunAi ?? vi.fn().mockResolvedValue(""),
  };
  const result = render(
    <PdfReader
      relativePath="papers/test.pdf"
      paperId={overrides.paperId}
      initialPage={overrides.initialPage}
      annotations={[annotation]}
      onOpenExternal={() => undefined}
      onReveal={overrides.onReveal}
      readOnly={overrides.readOnly}
      {...handlers}
    />,
  );
  return { ...result, ...handlers };
};

const mockTextSelection = (sourceText = "Selected research text") => {
  const scroll = document.querySelector(".lit-pdf-scroll");
  if (!(scroll instanceof HTMLElement)) throw new Error("PDF scroll container not found");

  const page = document.createElement("div");
  page.dataset.page = "2";
  const span = document.createElement("span");
  span.textContent = sourceText;
  page.append(span);
  scroll.append(page);

  vi.spyOn(page, "getBoundingClientRect").mockReturnValue({
    left: 100,
    top: 100,
    right: 500,
    bottom: 700,
    width: 400,
    height: 600,
    x: 100,
    y: 100,
    toJSON: () => ({}),
  });

  const removeAllRanges = vi.fn();
  const range = {
    commonAncestorContainer: span.firstChild,
    getClientRects: () => [
      {
        left: 140,
        top: 180,
        right: 340,
        bottom: 200,
        width: 200,
        height: 20,
      },
    ],
    getBoundingClientRect: () => ({
      left: 140,
      top: 180,
      right: 340,
      bottom: 200,
      width: 200,
      height: 20,
    }),
  };
  vi.spyOn(window, "getSelection").mockReturnValue({
    isCollapsed: false,
    rangeCount: 1,
    getRangeAt: () => range,
    toString: () => sourceText,
    removeAllRanges,
  } as unknown as Selection);

  return { scroll, removeAllRanges };
};

describe("PdfReader annotation interactions", () => {
  it("starts on the requested page when opened from an annotation", async () => {
    readerMocks.isTauri.mockReturnValue(true);
    Object.defineProperty(globalThis, "DOMMatrix", {
      configurable: true,
      value: class DOMMatrix {},
    });
    renderReader({ initialPage: 2, readOnly: true });

    await waitFor(() => expect(document.querySelectorAll(".lit-pdf-page-slot")).toHaveLength(3));
    expect(document.querySelector<HTMLInputElement>(".lit-pdf-page-input input")?.value).toBe("2");
    const previous = screen.getByRole("button", { name: "上一页" }) as HTMLButtonElement;
    const next = screen.getByRole("button", { name: "下一页" }) as HTMLButtonElement;
    expect(previous.closest(".lit-pdf-toolbar")).toBeTruthy();
    expect(next.closest(".lit-pdf-toolbar")).toBeTruthy();
    expect(screen.getByRole("button", { name: "更多 PDF 工具" }).getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(previous);
    expect(document.querySelector<HTMLInputElement>(".lit-pdf-page-input input")?.value).toBe("1");
    expect(previous.disabled).toBe(true);
    fireEvent.click(next);
    fireEvent.click(next);
    expect(document.querySelector<HTMLInputElement>(".lit-pdf-page-input input")?.value).toBe("3");
    expect(next.disabled).toBe(true);
  });

  it("keeps the PDF page and manual zoom while opening and closing the guide", async () => {
    readerMocks.isTauri.mockReturnValue(true);
    Object.defineProperty(globalThis, "DOMMatrix", { configurable: true, value: class DOMMatrix {} });
    useStore.setState({ currentProject: null });
    renderReader({ initialPage: 2, paperId: "paper-1" });
    await waitFor(() => expect(document.querySelectorAll(".lit-pdf-page-slot")).toHaveLength(3));
    const page = screen.getByRole("spinbutton", { name: "PDF 页码" }) as HTMLInputElement;
    const toggle = screen.getByRole("button", { name: "论文讲解" });
    fireEvent.click(screen.getByRole("button", { name: "放大" }));
    const zoom = document.querySelector(".lit-pdf-zoom-value")?.textContent;
    fireEvent.click(toggle);
    expect(screen.getByRole("complementary", { name: "论文讲解" })).toBeTruthy();
    expect(page.value).toBe("2");
    fireEvent.keyDown(screen.getByRole("button", { name: "关闭讲解" }), { key: "Escape" });
    expect(screen.queryByRole("complementary", { name: "论文讲解" })).toBeNull();
    expect(document.activeElement).toBe(toggle);
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "关闭讲解" }));
    expect(page.value).toBe("2");
    expect(document.querySelector(".lit-pdf-zoom-value")?.textContent).toBe(zoom);
    expect(readerMocks.openPdfDocumentFromPath).toHaveBeenCalledTimes(1);
    expect(readerMocks.document.destroy).not.toHaveBeenCalled();
  });

  it("renders the initial page when IntersectionObserver is unavailable", async () => {
    readerMocks.isTauri.mockReturnValue(true);
    Object.defineProperty(globalThis, "DOMMatrix", {
      configurable: true,
      value: class DOMMatrix {},
    });
    const observerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver");
    Object.defineProperty(globalThis, "IntersectionObserver", {
      configurable: true,
      value: undefined,
    });

    try {
      renderReader({ readOnly: true });
      await waitFor(() => expect(readerMocks.renderPdfPageToCanvas).toHaveBeenCalled());
      expect(document.querySelector(".lit-pdf-page-slot canvas")).toBeTruthy();
    } finally {
      if (observerDescriptor) Object.defineProperty(globalThis, "IntersectionObserver", observerDescriptor);
      else Reflect.deleteProperty(globalThis, "IntersectionObserver");
    }
  });

  it("surfaces a page rendering failure instead of leaving a white page", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    readerMocks.isTauri.mockReturnValue(true);
    Object.defineProperty(globalThis, "DOMMatrix", {
      configurable: true,
      value: class DOMMatrix {},
    });
    readerMocks.renderPdfPageToCanvas.mockImplementationOnce(() => {
      throw new Error("Canvas rendering is unavailable.");
    });

    renderReader({ readOnly: true });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Canvas rendering is unavailable."));
  });

  it("uses vector icons for every graphical PDF toolbar action", () => {
    // This assertion only needs the synchronously rendered toolbar. Keep the
    // document request pending so a detached page render cannot leak into the
    // next test after Testing Library cleans this component up.
    readerMocks.openPdfDocument.mockReturnValueOnce(new Promise(() => undefined));
    renderReader({ readOnly: true, onReveal: vi.fn() });

    const toolbar = document.querySelector(".lit-pdf-toolbar");
    expect(toolbar).toBeTruthy();
    for (const icon of ["document", "chevronLeft", "chevronRight", "zoomIn", "zoomOut", "fit", "externalLink", "moreHorizontal"]) {
      expect(toolbar?.querySelector(`svg[data-icon="${icon}"]`), `${icon} icon`).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: "系统阅读器" }).textContent).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "更多 PDF 工具" }));
    const moreTools = screen.getByRole("dialog", { name: "更多 PDF 工具" });
    for (const icon of ["folder", "refresh"]) {
      expect(moreTools.querySelector(`svg[data-icon="${icon}"]`), `${icon} icon`).toBeTruthy();
    }
  });

  it("shows multiple pages at once and keeps navigation aligned to page groups", async () => {
    readerMocks.isTauri.mockReturnValue(true);
    readerMocks.document.numPages = 5;
    Object.defineProperty(globalThis, "DOMMatrix", {
      configurable: true,
      value: class DOMMatrix {},
    });
    renderReader({ readOnly: true });

    await waitFor(() => expect(document.querySelectorAll(".lit-pdf-page-slot")).toHaveLength(5));
    expect(document.querySelector(".lit-pdf-pages")?.classList.contains("pages-1")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "更多 PDF 工具" }));
    const layoutSelect = screen.getByRole("combobox", { name: "阅读布局" });
    expect(Array.from((layoutSelect as HTMLSelectElement).options, (option) => option.text)).toEqual([
      "单页",
      "双页并排",
      "四页网格",
    ]);
    fireEvent.change(layoutSelect, { target: { value: "2" } });
    expect(document.querySelector(".lit-pdf-pages")?.classList.contains("pages-2")).toBe(true);
    expect((layoutSelect as HTMLSelectElement).value).toBe("2");
    expect(document.querySelector(".lit-pdf-page-caption")?.textContent).toBe("起始页");

    const slots = Array.from(document.querySelectorAll<HTMLElement>(".lit-pdf-page-slot"));
    Object.defineProperty(slots[0], "offsetTop", { configurable: true, value: 0 });
    Object.defineProperty(slots[1], "offsetTop", { configurable: true, value: 0 });
    Object.defineProperty(slots[2], "offsetTop", { configurable: true, value: 160 });
    Object.defineProperty(slots[3], "offsetTop", { configurable: true, value: 160 });
    Object.defineProperty(slots[4], "offsetTop", { configurable: true, value: 320 });
    const scroll = document.querySelector<HTMLElement>(".lit-pdf-scroll");
    Object.defineProperty(scroll!, "scrollTo", { configurable: true, value: vi.fn() });

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(document.querySelector<HTMLInputElement>(".lit-pdf-page-input input")?.value).toBe("3");

    fireEvent.change(layoutSelect, { target: { value: "4" } });
    expect(document.querySelector(".lit-pdf-pages")?.classList.contains("pages-4")).toBe(true);
    expect(document.querySelector<HTMLInputElement>(".lit-pdf-page-input input")?.value).toBe("1");

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(document.querySelector<HTMLInputElement>(".lit-pdf-page-input input")?.value).toBe("5");
    expect(screen.getByRole("button", { name: "下一页" }).getAttribute("disabled")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "上一页" }));
    expect(document.querySelector<HTMLInputElement>(".lit-pdf-page-input input")?.value).toBe("1");
  });

  it("keeps a typed page number intact until it is committed in a multi-page layout", async () => {
    readerMocks.isTauri.mockReturnValue(true);
    readerMocks.document.numPages = 29;
    Object.defineProperty(globalThis, "DOMMatrix", {
      configurable: true,
      value: class DOMMatrix {},
    });
    renderReader({ readOnly: true });

    await waitFor(() => expect(document.querySelectorAll(".lit-pdf-page-slot")).toHaveLength(29));
    fireEvent.click(screen.getByRole("button", { name: "更多 PDF 工具" }));
    fireEvent.change(screen.getByRole("combobox", { name: "阅读布局" }), { target: { value: "2" } });
    const pageInput = document.querySelector<HTMLInputElement>(".lit-pdf-page-input input")!;
    fireEvent.change(pageInput, { target: { value: "29" } });
    expect(pageInput.value).toBe("29");

    fireEvent.blur(pageInput);
    expect(pageInput.value).toBe("29");
  });

  it("fits the complete simultaneous page row within the reader", () => {
    expect(firstPageForLayout(6, 4)).toBe(5);
    expect(pageRangeForLayout(2, 3, 2)).toEqual({ start: 1, end: 2 });
    expect(pageRangeForLayout(3, 3, 2)).toEqual({ start: 3, end: 3 });
    expect(pageRangeForLayout(5, 5, 4)).toEqual({ start: 5, end: 5 });
    expect(fitZoomForLayout(1000, 500, 1)).toBeCloseTo(1.904);
    expect(fitZoomForLayout(1000, 500, 2)).toBeCloseTo(0.936);
    expect(fitZoomForLayout(1000, 500, 4)).toBeCloseTo(0.452);
  });

  it("fits a complete page to both the reader width and its available height", () => {
    expect(fitZoomForPage(1000, 700, 500, 800, 1)).toBeCloseTo(0.815);
    expect(fitZoomForPage(1000, 1000, 500, 800, 2)).toBeCloseTo(0.936);
    expect(fitZoomForPage(1000, 1000, 500, 800, 4)).toBeCloseTo(0.452);
  });

  it("keeps a moved floating toolbar inside the visible PDF viewport", () => {
    const bounds = { minX: 12, maxX: 604, minY: 12, maxY: 280 };
    expect(clampFloatingToolbarPosition({ x: -50, y: 500 }, bounds)).toEqual({ x: 12, y: 280 });
    expect(clampFloatingToolbarPosition({ x: 420, y: 160 }, bounds)).toEqual({ x: 420, y: 160 });
  });

  it("floats the PDF controls and drags them within the reader viewport", () => {
    renderReader({ readOnly: true });
    const reader = document.querySelector<HTMLElement>(".lit-pdf-reader")!;
    const scroll = document.querySelector<HTMLElement>(".lit-pdf-scroll")!;
    const toolbar = screen.getByRole("toolbar", { name: "PDF 悬浮工具栏" });
    const handle = screen.getByRole("button", { name: "移动 PDF 工具栏" });
    const rect = (left: number, top: number, width: number, height: number) => ({
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
      x: left,
      y: top,
      toJSON: () => ({}),
    });
    vi.spyOn(reader, "getBoundingClientRect").mockReturnValue(rect(0, 0, 800, 600));
    vi.spyOn(scroll, "getBoundingClientRect").mockReturnValue(rect(0, 0, 800, 600));
    vi.spyOn(toolbar, "getBoundingClientRect").mockReturnValue(rect(12, 12, 184, 308));
    const dispatchPointer = (type: string, values: Record<string, number>) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      for (const [key, value] of Object.entries(values)) {
        Object.defineProperty(event, key, { configurable: true, value });
      }
      fireEvent(handle, event);
    };

    dispatchPointer("pointerdown", { pointerId: 7, button: 0, clientX: 20, clientY: 20 });
    dispatchPointer("pointermove", { pointerId: 7, buttons: 1, clientX: 700, clientY: 500 });
    expect(toolbar.getAttribute("style")).toContain("left: 604px");
    expect(toolbar.getAttribute("style")).toContain("top: 280px");
    dispatchPointer("pointerup", { pointerId: 7, button: 0, clientX: 700, clientY: 500 });

    fireEvent.doubleClick(handle);
    expect(toolbar.getAttribute("style")).toContain("left: 12px");
    expect(toolbar.getAttribute("style")).toContain("top: 12px");
  });

  it("keeps the page, spread and manual zoom when more tools are dismissed and reopened", async () => {
    readerMocks.isTauri.mockReturnValue(true);
    Object.defineProperty(globalThis, "DOMMatrix", { configurable: true, value: class DOMMatrix {} });
    renderReader({ readOnly: true });
    await waitFor(() => expect(document.querySelectorAll(".lit-pdf-page-slot")).toHaveLength(3));
    const moreTools = screen.getByRole("button", { name: "更多 PDF 工具" });
    fireEvent.click(moreTools);
    fireEvent.change(screen.getByRole("combobox", { name: "阅读布局" }), { target: { value: "2" } });
    const input = screen.getByRole("spinbutton", { name: "PDF 页码" });
    fireEvent.change(input, { target: { value: "3" } });
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole("button", { name: "放大" }));
    const zoom = document.querySelector(".lit-pdf-zoom-value")?.textContent;

    fireEvent.keyDown(moreTools, { key: "Escape" });
    expect(moreTools.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(moreTools);
    expect(screen.queryByRole("combobox", { name: "阅读布局" })).toBeNull();
    expect((input as HTMLInputElement).value).toBe("3");

    fireEvent.click(moreTools);
    fireEvent.click(screen.getByRole("button", { name: "上一页" }));
    expect((screen.getByRole("spinbutton", { name: "PDF 页码" }) as HTMLInputElement).value).toBe("1");
    expect((screen.getByRole("combobox", { name: "阅读布局" }) as HTMLSelectElement).value).toBe("2");
    expect(document.querySelector(".lit-pdf-zoom-value")?.textContent).toBe(zoom);
    expect(readerMocks.openPdfDocumentFromPath).toHaveBeenCalledTimes(1);
    expect(readerMocks.document.destroy).not.toHaveBeenCalled();
  });

  it("opens more tools on the free side of a rail moved to the viewport edge", () => {
    renderReader({ readOnly: true });
    const reader = document.querySelector<HTMLElement>(".lit-pdf-reader")!;
    const scroll = document.querySelector<HTMLElement>(".lit-pdf-scroll")!;
    const toolbar = screen.getByRole("toolbar", { name: "PDF 悬浮工具栏" });
    const rect = (left: number, top: number, width: number, height: number) => ({
      left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}),
    });
    vi.spyOn(reader, "getBoundingClientRect").mockReturnValue(rect(0, 0, 800, 600));
    vi.spyOn(scroll, "getBoundingClientRect").mockReturnValue(rect(0, 0, 800, 600));
    vi.spyOn(toolbar, "getBoundingClientRect").mockImplementation(() =>
      rect(parseFloat(toolbar.style.left), parseFloat(toolbar.style.top), 60, 430),
    );
    const popover = document.querySelector<HTMLElement>(".lit-pdf-tools-popover")!;
    vi.spyOn(popover, "getBoundingClientRect").mockReturnValue(rect(0, 0, 232, 280));
    const handle = screen.getByRole("button", { name: "移动 PDF 工具栏" });
    for (let index = 0; index < 30; index += 1) {
      fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
      fireEvent.keyDown(handle, { key: "ArrowDown", shiftKey: true });
    }
    expect(toolbar.style.left).toBe("728px");
    expect(toolbar.style.top).toBe("158px");
    fireEvent.click(screen.getByRole("button", { name: "更多 PDF 工具" }));
    expect(parseFloat(popover.style.left) + 232).toBeLessThanOrEqual(parseFloat(toolbar.style.left) - 8);
    expect(parseFloat(popover.style.top) + 280).toBeLessThanOrEqual(588);
    fireEvent.pointerDown(scroll);
    expect(screen.queryByRole("dialog", { name: "更多 PDF 工具" })).toBeNull();
  });

  it("keeps the guide on the rail and opens annotations from more tools", async () => {
    readerMocks.isTauri.mockReturnValue(true);
    Object.defineProperty(globalThis, "DOMMatrix", { configurable: true, value: class DOMMatrix {} });
    useStore.setState({ currentProject: null });
    renderReader({ paperId: "paper-1" });
    await waitFor(() => expect(document.querySelectorAll(".lit-pdf-page-slot")).toHaveLength(3));
    const guide = screen.getByRole("button", { name: "论文讲解" });
    fireEvent.click(guide);
    fireEvent.click(screen.getByRole("button", { name: "关闭讲解" }));
    expect(document.activeElement).toBe(guide);
    const moreTools = screen.getByRole("button", { name: "更多 PDF 工具" });
    fireEvent.click(moreTools);
    const annotations = screen.getByRole("button", { name: "标注 · 1" });
    fireEvent.click(annotations);
    expect(annotations.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector(".lit-pdf-reader-body")?.classList.contains("with-annotations")).toBe(true);
    expect(screen.queryByRole("dialog", { name: "更多 PDF 工具" })).toBeNull();
    expect(document.activeElement).toBe(moreTools);
    expect(readerMocks.openPdfDocumentFromPath).toHaveBeenCalledTimes(1);
  });

  it("defaults to whole-page reading and lets the reader switch to fit width", () => {
    renderReader({ readOnly: true });

    const fitPage = screen.getByRole("button", { name: "适合整页" });
    fireEvent.click(screen.getByRole("button", { name: "更多 PDF 工具" }));
    const fitWidth = screen.getByRole("button", { name: "适应宽度" });
    const scroll = document.querySelector(".lit-pdf-scroll");
    expect(fitPage.getAttribute("aria-pressed")).toBe("true");
    expect(fitWidth.getAttribute("aria-pressed")).toBe("false");
    expect(scroll?.classList.contains("fit-page")).toBe(true);

    fireEvent.click(fitWidth);
    expect(fitPage.getAttribute("aria-pressed")).toBe("false");
    expect(fitWidth.getAttribute("aria-pressed")).toBe("true");
    expect(scroll?.classList.contains("fit-width")).toBe(true);
  });

  it("recomputes whole-page zoom when the available reader height changes", async () => {
    readerMocks.isTauri.mockReturnValue(true);
    Object.defineProperty(globalThis, "DOMMatrix", {
      configurable: true,
      value: class DOMMatrix {},
    });
    const observerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
    let notifyResize: (() => void) | null = null;
    class ReaderResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        notifyResize = () => callback([], {} as ResizeObserver);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: ReaderResizeObserver,
    });

    try {
      renderReader({ readOnly: true });
      await waitFor(() => expect(document.querySelectorAll(".lit-pdf-page-slot")).toHaveLength(3));
      const scroll = document.querySelector<HTMLElement>(".lit-pdf-scroll")!;
      Object.defineProperty(scroll, "clientWidth", { configurable: true, value: 1000 });
      Object.defineProperty(scroll, "clientHeight", { configurable: true, value: 700 });
      act(() => notifyResize?.());
      await waitFor(() => expect(document.querySelector(".lit-pdf-zoom-value")?.textContent).toBe("300%"));

      Object.defineProperty(scroll, "clientHeight", { configurable: true, value: 200 });
      act(() => notifyResize?.());
      await waitFor(() => expect(document.querySelector(".lit-pdf-zoom-value")?.textContent).toBe("127%"));
    } finally {
      if (observerDescriptor) Object.defineProperty(globalThis, "ResizeObserver", observerDescriptor);
      else Reflect.deleteProperty(globalThis, "ResizeObserver");
    }
  });

  it("reloads the current PDF from the reader toolbar", async () => {
    readerMocks.isTauri.mockReturnValue(true);
    Object.defineProperty(globalThis, "DOMMatrix", {
      configurable: true,
      value: class DOMMatrix {},
    });
    renderReader({ readOnly: true });

    await waitFor(() => expect(readerMocks.openPdfDocumentFromPath).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "更多 PDF 工具" }));
    fireEvent.click(screen.getByRole("button", { name: "刷新 PDF" }));
    await waitFor(() => expect(readerMocks.openPdfDocumentFromPath).toHaveBeenCalledTimes(2));
  });

  it("keeps PDF wheel, pointer, and touch gestures inside the reader", () => {
    const onOuterPointerDown = vi.fn();
    const onOuterWheel = vi.fn();
    const onOuterTouchStart = vi.fn();
    render(
      <div
        onPointerDown={onOuterPointerDown}
        onWheel={onOuterWheel}
        onTouchStart={onOuterTouchStart}
      >
        <PdfReader
          relativePath="papers/test.pdf"
          annotations={[]}
          onOpenExternal={() => undefined}
          onAddAnnotation={() => undefined}
          onUpdateAnnotation={() => undefined}
          onDeleteAnnotation={() => undefined}
          onRunAi={() => Promise.resolve("")}
          readOnly
        />
      </div>,
    );

    const scroll = document.querySelector<HTMLElement>(".lit-pdf-scroll");
    expect(scroll).toBeTruthy();
    fireEvent.pointerDown(scroll!);
    fireEvent.wheel(scroll!, { deltaY: 80 });
    fireEvent.touchStart(scroll!);

    expect(onOuterPointerDown).not.toHaveBeenCalled();
    expect(onOuterWheel).not.toHaveBeenCalled();
    expect(onOuterTouchStart).not.toHaveBeenCalled();
  });

  it("turns pages with rapid left and right keys after the PDF surface is focused", async () => {
    readerMocks.isTauri.mockReturnValue(true);
    Object.defineProperty(globalThis, "DOMMatrix", {
      configurable: true,
      value: class DOMMatrix {},
    });
    renderReader({ readOnly: true });

    await waitFor(() => expect(document.querySelectorAll(".lit-pdf-page-slot")).toHaveLength(3));
    const scroll = document.querySelector<HTMLElement>(".lit-pdf-scroll");
    expect(scroll).toBeTruthy();
    const slots = Array.from(document.querySelectorAll<HTMLElement>(".lit-pdf-page-slot"));
    slots.forEach((slot, index) => {
      Object.defineProperty(slot, "offsetTop", { configurable: true, value: index * 160 });
    });
    const scrollTo = vi.fn();
    Object.defineProperty(scroll!, "scrollTo", { configurable: true, value: scrollTo });

    fireEvent.mouseDown(scroll!);
    expect(document.activeElement).toBe(scroll);
    act(() => {
      scroll!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      scroll!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });

    expect((document.querySelector(".lit-pdf-page-input input") as HTMLInputElement).value).toBe("3");
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 312, behavior: "smooth" });

    fireEvent.keyDown(scroll!, { key: "ArrowLeft" });
    expect((document.querySelector(".lit-pdf-page-input input") as HTMLInputElement).value).toBe("2");
  });

  it("keeps the requested page number stable while smooth scrolling crosses an earlier page", async () => {
    readerMocks.isTauri.mockReturnValue(true);
    Object.defineProperty(globalThis, "DOMMatrix", {
      configurable: true,
      value: class DOMMatrix {},
    });
    renderReader({ readOnly: true });

    await waitFor(() => expect(document.querySelectorAll(".lit-pdf-page-slot")).toHaveLength(3));
    const scroll = document.querySelector<HTMLElement>(".lit-pdf-scroll");
    const slots = Array.from(document.querySelectorAll<HTMLElement>(".lit-pdf-page-slot"));
    expect(scroll).toBeTruthy();
    slots.forEach((slot, index) => {
      Object.defineProperty(slot, "offsetTop", { configurable: true, value: index * 160 });
    });
    Object.defineProperty(scroll!, "clientHeight", { configurable: true, value: 100 });
    Object.defineProperty(scroll!, "scrollTo", { configurable: true, value: vi.fn() });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect((document.querySelector(".lit-pdf-page-input input") as HTMLInputElement).value).toBe("2");

    // The smooth animation is still over page 1. Its scroll event must not
    // overwrite the explicit destination shown in the page field.
    scroll!.scrollTop = 40;
    fireEvent.scroll(scroll!);
    expect((document.querySelector(".lit-pdf-page-input input") as HTMLInputElement).value).toBe("2");

    scroll!.scrollTop = 160;
    fireEvent.scroll(scroll!);
    expect((document.querySelector(".lit-pdf-page-input input") as HTMLInputElement).value).toBe("2");
  });

  it("does not skip a short PDF page when several pages fit in the viewport", async () => {
    readerMocks.isTauri.mockReturnValue(true);
    Object.defineProperty(globalThis, "DOMMatrix", {
      configurable: true,
      value: class DOMMatrix {},
    });
    renderReader({ readOnly: true });
    await waitFor(() => expect(document.querySelectorAll(".lit-pdf-page-slot")).toHaveLength(3));
    await act(async () => {
      await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
    });
    const scroll = document.querySelector<HTMLElement>(".lit-pdf-scroll")!;
    const input = document.querySelector<HTMLInputElement>(".lit-pdf-page-input input")!;
    document.querySelectorAll<HTMLElement>(".lit-pdf-page-slot").forEach((slot, index) => {
      Object.defineProperty(slot, "offsetTop", { configurable: true, value: index * 160 });
      Object.defineProperty(slot, "offsetHeight", { configurable: true, value: 140 });
    });
    Object.defineProperty(scroll, "clientHeight", { configurable: true, value: 900 });

    fireEvent.wheel(scroll, { deltaY: 160 });
    scroll.scrollTop = 160;
    fireEvent.scroll(scroll);
    await waitFor(() => expect(input.value).toBe("2"));

    scroll.scrollTop = 300;
    fireEvent.scroll(scroll);
    await waitFor(() => expect(input.value).toBe("3"));
  });

  it("maps quote-only answer evidence onto the PDF text layer", async () => {
    const boxes = await highlightBoxesForPage(
      {
        getViewport: () => ({
          width: 600,
          height: 800,
          convertToViewportPoint: (left: number, baseline: number) => [left, baseline],
        }),
        getTextContent: vi.fn().mockResolvedValue({
          items: [
            {
              str: "Only 20 samples",
              transform: [1, 0, 0, 1, 40, 120],
              width: 120,
              height: 12,
            },
            {
              str: "were used in the evaluation.",
              transform: [1, 0, 0, 1, 165, 120],
              width: 190,
              height: 12,
            },
          ],
        }),
      } as never,
      1,
      [{
        ...annotation,
        quote: "Only 20 samples were used in the evaluation.",
        rects: undefined,
        kind: "answer-support",
        color: "yellow",
      }],
    );

    expect(boxes).toHaveLength(2);
    expect(boxes).toEqual([
      expect.objectContaining({ annotationId: "annotation-1", left: 40, color: "yellow" }),
      expect.objectContaining({ annotationId: "annotation-1", left: 165, color: "yellow" }),
    ]);
  });

  it("only reserves sidebar space while annotations are visible", () => {
    renderReader();

    const body = document.querySelector(".lit-pdf-reader-body");
    expect(body?.classList.contains("with-annotations")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "更多 PDF 工具" }));
    fireEvent.click(screen.getByRole("button", { name: /标注/ }));
    expect(body?.classList.contains("with-annotations")).toBe(true);
  });

  it("does not expose annotation controls in read-only previews", () => {
    renderReader({ readOnly: true });

    fireEvent.click(screen.getByRole("button", { name: "更多 PDF 工具" }));
    expect(screen.queryByRole("button", { name: /标注/ })).toBeNull();
    expect(document.querySelector(".lit-pdf-reader-body")?.classList.contains("with-annotations")).toBe(false);
  });

  it("keeps the sidebar compact and edits an annotation in an on-demand popover", () => {
    const onUpdateAnnotation = vi.fn();
    const onDeleteAnnotation = vi.fn();
    renderReader({ onUpdateAnnotation, onDeleteAnnotation });

    expect(screen.queryByText("Original core")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "更多 PDF 工具" }));
    fireEvent.click(screen.getByRole("button", { name: /标注/ }));

    const summary = screen.getByText("Original core");
    const item = summary.closest("article");
    expect(item).toBeTruthy();
    fireEvent.click(item!);

    expect(screen.getByRole("dialog", { name: "编辑标注" })).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "标注类型" }), {
      target: { value: "core" },
    });
    fireEvent.click(screen.getByRole("button", { name: "设为黄色" }));

    const note = screen.getByRole("textbox", { name: "标注备注" });
    fireEvent.change(note, { target: { value: "Updated note" } });
    fireEvent.blur(note);

    expect(onUpdateAnnotation).toHaveBeenCalledWith("annotation-1", { kind: "core" });
    expect(onUpdateAnnotation).toHaveBeenCalledWith("annotation-1", { color: "yellow" });
    expect(onUpdateAnnotation).toHaveBeenCalledWith("annotation-1", { note: "Updated note" });

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(onDeleteAnnotation).toHaveBeenCalledWith("annotation-1");
  });

  it("shows a compact selection toolbar and creates a highlight with one color click", () => {
    const onAddAnnotation = vi.fn();
    renderReader({ onAddAnnotation });
    const { scroll } = mockTextSelection();

    fireEvent.mouseUp(scroll);
    expect(screen.getByRole("toolbar", { name: "选区操作" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "用黄色高亮" }));

    expect(onAddAnnotation).toHaveBeenCalledWith(2, {
      quote: "Selected research text",
      rects: [{ left: 0.1, top: 0.13333333333333333, width: 0.5, height: 0.03333333333333333 }],
      color: "yellow",
      kind: "note",
      note: "",
      style: "highlight",
    });
  });

  it("creates an underline mark when the underline style is selected before a color", () => {
    const onAddAnnotation = vi.fn();
    renderReader({ onAddAnnotation });
    const { scroll } = mockTextSelection();

    fireEvent.mouseUp(scroll);
    fireEvent.click(screen.getByRole("button", { name: "下划线" }));
    fireEvent.click(screen.getByRole("button", { name: "用绿色下划线" }));

    expect(onAddAnnotation).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ color: "green", style: "underline", kind: "note" }),
    );
  });

  it("surfaces the marking toolbar on selection with no mode toggle to enable first", () => {
    renderReader();
    // The old "滑动标记" prerequisite is gone — selecting text is enough.
    expect(screen.queryByRole("button", { name: "滑动标记" })).toBeNull();

    const { scroll } = mockTextSelection();
    fireEvent.mouseUp(scroll);

    expect(screen.getByRole("toolbar", { name: "选区操作" })).toBeTruthy();
  });

  it("runs the translate AI action and saves the result as a highlight + note", async () => {
    const onRunAi = vi.fn().mockResolvedValue("这是译文。");
    const onAddAnnotation = vi.fn();
    renderReader({ onRunAi, onAddAnnotation });
    const { scroll } = mockTextSelection();

    fireEvent.mouseUp(scroll);
    fireEvent.click(screen.getByRole("button", { name: /翻译/ }));

    expect(onRunAi).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("Selected research text"),
      null,
    );
    const result = await screen.findByText("这是译文。");
    expect(result).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "保存到标注" }));
    expect(onAddAnnotation).toHaveBeenCalledWith(
      2,
      expect.objectContaining({
        color: "blue",
        style: "highlight",
        note: expect.stringContaining("这是译文。"),
      }),
    );
  });

  it("explains a selected passage from simple to deep without the translation direction", async () => {
    const onRunAi = vi.fn().mockResolvedValue("**一句话**：这段说缩放能控制分数的方差。");
    const onAddAnnotation = vi.fn();
    renderReader({ onRunAi, onAddAnnotation });
    const { scroll } = mockTextSelection();

    fireEvent.mouseUp(scroll);
    fireEvent.click(screen.getByRole("button", { name: /由浅入深讲解/ }));

    expect(onRunAi).toHaveBeenCalledWith(
      expect.stringContaining("from simple to deep"),
      expect.stringContaining("<source_text>"),
      null,
    );
    expect(onRunAi.mock.calls[0][0]).toContain("Simplified Chinese");
    expect(await screen.findByText(/这段说缩放能控制分数的方差/)).toBeTruthy();
    expect(screen.queryByLabelText("翻译方向")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "保存到标注" }));
    expect(onAddAnnotation).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ note: expect.stringContaining("由浅入深讲解") }),
    );
  });

  it("defaults an English selection to Chinese even when the app UI is English", async () => {
    useStore.setState({ language: "en", languagePreferenceSet: true });
    const onRunAi = vi.fn().mockResolvedValue('{"translation":"这是翻译后的研究文本。"}');
    renderReader({ onRunAi });
    const { scroll } = mockTextSelection();

    fireEvent.mouseUp(scroll);

    expect(screen.getByText("Auto-detected (English)")).toBeTruthy();
    const targetSelect = screen.getByRole("combobox", { name: "PDF translation target language" }) as HTMLSelectElement;
    expect(targetSelect.value).toBe("zh-CN");

    fireEvent.click(screen.getByRole("button", { name: /Translate/ }));

    expect(onRunAi).toHaveBeenCalledWith(
      expect.stringContaining("required output language is Simplified Chinese (zh-CN)"),
      expect.stringContaining("TARGET LANGUAGE (REQUIRED): Simplified Chinese (zh-CN)"),
      null,
    );
    await screen.findByText("这是翻译后的研究文本。");
    expect(screen.getByLabelText("Translation direction").textContent).toContain("English");
    expect(screen.getByLabelText("Translation direction").textContent).toContain("Simplified Chinese");
  });

  it("does not present reviewer boilerplate plus the unchanged source as a successful translation", async () => {
    const source = "This survey delves into the application of diffusion models in time-series forecasting.";
    const onRunAi = vi.fn().mockResolvedValue(
      `状态：未确认\n证据：本回答未对任何候选建立直接取证。\n\n${source}`,
    );
    renderReader({ onRunAi });
    const { scroll } = mockTextSelection(source);

    fireEvent.mouseUp(scroll);
    fireEvent.click(screen.getByRole("button", { name: /翻译/ }));

    expect(await screen.findByText(/模型返回了原文而不是译文/)).toBeTruthy();
    expect(document.querySelector(".lit-pdf-ai-result")).toBeNull();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
  });

  it("uses the verified model selected for PDF translation", async () => {
    readerMocks.isTauri.mockReturnValue(true);
    Object.defineProperty(globalThis, "DOMMatrix", {
      configurable: true,
      value: class DOMMatrix {},
    });
    readerMocks.chatModelOptions.mockResolvedValue({
      provider: "test",
      current: "default-model",
      options: [
        { value: "default-model", label: "Default model", description: null },
        { value: "translation-pro", label: "Translation Pro", description: "test provider" },
      ],
    });
    const onRunAi = vi.fn().mockResolvedValue("这是译文。");
    renderReader({ onRunAi });
    const { scroll } = mockTextSelection();

    fireEvent.mouseUp(scroll);
    const modelSelect = await screen.findByRole("combobox", { name: "PDF 翻译模型" });
    fireEvent.change(modelSelect, { target: { value: "translation-pro" } });
    fireEvent.click(screen.getByRole("button", { name: /翻译/ }));

    expect(onRunAi).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("<source_text>\nSelected research text\n</source_text>"),
      "translation-pro",
    );
    await screen.findByText("这是译文。");
    expect(document.querySelector(".lit-pdf-ai-model-used")?.textContent).toBe("Translation Pro");
  });

  it("supports dragging the AI translation panel and going back to selection toolbar", async () => {
    const onRunAi = vi.fn().mockResolvedValue("这是译文。");
    renderReader({ onRunAi });
    const { scroll } = mockTextSelection();

    fireEvent.mouseUp(scroll);
    fireEvent.click(screen.getByRole("button", { name: /翻译/ }));
    await screen.findByText("这是译文。");

    const header = document.querySelector(".lit-pdf-ai-head") as HTMLElement;
    expect(header).toBeTruthy();

    const popup = document.querySelector(".lit-pdf-select-popup.ai") as HTMLElement;
    const initialLeft = popup.style.left;
    const initialTop = popup.style.top;

    // Simulate drag
    const downEvent = new Event("pointerdown", { bubbles: true });
    Object.assign(downEvent, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent(header, downEvent);

    const moveEvent = new Event("pointermove", { bubbles: true });
    Object.assign(moveEvent, { clientX: 150, clientY: 160, pointerId: 1 });
    fireEvent(header, moveEvent);

    const upEvent = new Event("pointerup", { bubbles: true });
    Object.assign(upEvent, { clientX: 150, clientY: 160, pointerId: 1 });
    fireEvent(header, upEvent);

    expect(popup.style.left).not.toBe(initialLeft);
    expect(popup.style.top).not.toBe(initialTop);

    // Clicking Back returns to the quick action toolbar
    const backBtn = screen.getByRole("button", { name: "返回" });
    fireEvent.click(backBtn);
    expect(screen.getByRole("button", { name: /翻译/ })).toBeTruthy();
  });
});
