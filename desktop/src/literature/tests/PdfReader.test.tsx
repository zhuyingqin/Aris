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

import PdfReader, {
  firstPageForLayout,
  fitZoomForLayout,
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
  });

  it("uses vector icons for every graphical PDF toolbar action", () => {
    // This assertion only needs the synchronously rendered toolbar. Keep the
    // document request pending so a detached page render cannot leak into the
    // next test after Testing Library cleans this component up.
    readerMocks.openPdfDocument.mockReturnValueOnce(new Promise(() => undefined));
    renderReader({ readOnly: true, onReveal: vi.fn() });

    const toolbar = document.querySelector(".lit-pdf-toolbar");
    expect(toolbar).toBeTruthy();
    for (const icon of ["chevronLeft", "chevronRight", "minus", "plus", "fit", "folder", "refresh", "externalLink"]) {
      expect(toolbar?.querySelector(`svg[data-icon="${icon}"]`), `${icon} icon`).toBeTruthy();
    }
    expect(toolbar?.querySelectorAll(".lit-pdf-icon-button")).toHaveLength(7);
    expect(screen.getByRole("button", { name: "系统阅读器" }).textContent).toBe("");
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

  it("reloads the current PDF from the reader toolbar", async () => {
    readerMocks.isTauri.mockReturnValue(true);
    Object.defineProperty(globalThis, "DOMMatrix", {
      configurable: true,
      value: class DOMMatrix {},
    });
    renderReader({ readOnly: true });

    await waitFor(() => expect(readerMocks.openPdfDocumentFromPath).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "刷新 PDF" }));
    await waitFor(() => expect(readerMocks.openPdfDocumentFromPath).toHaveBeenCalledTimes(2));
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

    fireEvent.click(screen.getByRole("button", { name: /标注/ }));
    expect(body?.classList.contains("with-annotations")).toBe(true);
  });

  it("does not expose annotation controls in read-only previews", () => {
    renderReader({ readOnly: true });

    expect(screen.queryByRole("button", { name: /标注/ })).toBeNull();
    expect(document.querySelector(".lit-pdf-reader-body")?.classList.contains("with-annotations")).toBe(false);
  });

  it("keeps the sidebar compact and edits an annotation in an on-demand popover", () => {
    const onUpdateAnnotation = vi.fn();
    const onDeleteAnnotation = vi.fn();
    renderReader({ onUpdateAnnotation, onDeleteAnnotation });

    expect(screen.queryByText("Original core")).toBeNull();
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
