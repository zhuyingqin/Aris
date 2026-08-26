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
    fileReadBytes: vi.fn().mockResolvedValue([]),
    literaturePdfBytes: vi.fn().mockResolvedValue([]),
    openPdfDocument: vi.fn().mockResolvedValue(document),
    getPdfJs: vi.fn(),
    document,
    page,
  };
});

vi.mock("../../api/tauri", () => ({
  isTauri: readerMocks.isTauri,
  fileReadBytes: readerMocks.fileReadBytes,
  literaturePdfBytes: readerMocks.literaturePdfBytes,
}));

vi.mock("../../pdf/runtime", () => ({
  getPdfJs: readerMocks.getPdfJs,
  openPdfDocument: readerMocks.openPdfDocument,
}));

import PdfReader, { highlightBoxesForPage } from "../PdfReader";
import { useStore } from "../../store";

beforeEach(() => {
  useStore.setState({ language: "cn", languagePreferenceSet: true });
  readerMocks.isTauri.mockReset().mockReturnValue(false);
  readerMocks.fileReadBytes.mockReset().mockResolvedValue([]);
  readerMocks.literaturePdfBytes.mockReset().mockResolvedValue([]);
  readerMocks.openPdfDocument.mockReset().mockResolvedValue(readerMocks.document);
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
      annotations={[annotation]}
      onOpenExternal={() => undefined}
      onReveal={overrides.onReveal}
      readOnly={overrides.readOnly}
      {...handlers}
    />,
  );
  return { ...result, ...handlers };
};

const mockTextSelection = () => {
  const scroll = document.querySelector(".lit-pdf-scroll");
  if (!(scroll instanceof HTMLElement)) throw new Error("PDF scroll container not found");

  const page = document.createElement("div");
  page.dataset.page = "2";
  const span = document.createElement("span");
  span.textContent = "Selected research text";
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
    toString: () => "Selected research text",
    removeAllRanges,
  } as unknown as Selection);

  return { scroll, removeAllRanges };
};

describe("PdfReader annotation interactions", () => {
  it("uses vector icons for every graphical PDF toolbar action", () => {
    // This assertion only needs the synchronously rendered toolbar. Keep the
    // document request pending so a detached page render cannot leak into the
    // next test after Testing Library cleans this component up.
    readerMocks.openPdfDocument.mockReturnValueOnce(new Promise(() => undefined));
    renderReader({ readOnly: true, onReveal: vi.fn() });

    const toolbar = document.querySelector(".lit-pdf-toolbar");
    expect(toolbar).toBeTruthy();
    for (const icon of ["chevronLeft", "chevronRight", "minus", "plus", "fit", "folder", "externalLink"]) {
      expect(toolbar?.querySelector(`svg[data-icon="${icon}"]`), `${icon} icon`).toBeTruthy();
    }
    expect(toolbar?.querySelectorAll(".lit-pdf-icon-button")).toHaveLength(5);
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

    expect(onRunAi).toHaveBeenCalledWith(expect.any(String), "Selected research text");
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
});
