// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TypesetPdfPreview from "../TypesetPdfPreview";
import { useStore } from "../../store";

const mocks = vi.hoisted(() => ({
  fileOpen: vi.fn(),
  typesetOutputFiles: vi.fn(async () => []),
  openPdfDocumentFromPath: vi.fn<() => Promise<PDFDocumentProxy>>(async () => {
    throw new Error("no pdf in this test");
  }),
}));

vi.mock("../../api/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/tauri")>()),
  fileOpen: mocks.fileOpen,
  typesetOutputFiles: mocks.typesetOutputFiles,
}));

vi.mock("../../pdf/runtime", () => ({
  isPdfXrefError: () => false,
  openPdfDocumentFromPath: mocks.openPdfDocumentFromPath,
  openPdfDocumentWithRebuiltXref: mocks.openPdfDocumentFromPath,
}));

/**
 * jsdom has no layout, so the toolbar would measure 0 everywhere and never
 * collapse. Stand in for the browser with the real control sizes: leaf widths
 * by class, containers as the sum of their children.
 */
const LEAF_WIDTHS: [string, number][] = [
  [".typeset-compile-button-group", 120],
  [".typeset-log-toggle", 32],
  [".typeset-pdf-status-strip", 0],
  [".typeset-pdf-page-control", 70],
  [".toolbar-pdf-controls", 60],
  [".typeset-icon-btn", 28],
];

const ORIGINAL_LAYOUT = {
  offsetWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth"),
  clientWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth"),
  getClientRects: Element.prototype.getClientRects,
};

function restoreLayout() {
  if (ORIGINAL_LAYOUT.offsetWidth) {
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", ORIGINAL_LAYOUT.offsetWidth);
  }
  if (ORIGINAL_LAYOUT.clientWidth) {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", ORIGINAL_LAYOUT.clientWidth);
  }
  Element.prototype.getClientRects = ORIGINAL_LAYOUT.getClientRects;
}

function stubLayout(toolbarWidth: number) {
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      for (const [selector, width] of LEAF_WIDTHS) {
        if (this.matches(selector)) return width;
      }
      return Array.from(this.children).reduce(
        (total, child) => total + (child as HTMLElement).offsetWidth,
        0,
      );
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("typeset-preview-toolbar") ? toolbarWidth : 0;
    },
  });
  // Only elements with client rects count as laid-out flex items.
  Element.prototype.getClientRects = () => [{}] as unknown as DOMRectList;
}

const noop = () => {};

function renderToolbar(toolbarWidth: number) {
  stubLayout(toolbarWidth);
  return render(
    <TypesetPdfPreview
      path="paper.pdf"
      sourcePath="paper.tex"
      refreshKey={0}
      status="idle"
      result={null}
      dirty={false}
      disabled={false}
      logOpen={false}
      diagnosticsCount={0}
      continueOnError={false}
      engine="auto"
      compileOnSave={false}
      inverted={false}
      canCancel={false}
      onCompile={noop}
      onCancelCompile={noop}
      onClearCacheCompile={noop}
      onSetContinueOnError={noop}
      onSetEngine={noop}
      onSetCompileOnSave={noop}
      onToggleInverted={noop}
      onExportPdf={noop}
      onToggleLog={noop}
      onSourceTextClick={noop}
      onHide={noop}
      onSyncToPdf={noop}
    />,
  );
}

describe("compiled-PDF toolbar overflow", () => {
  beforeEach(() => {
    useStore.setState({ language: "en" });
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    restoreLayout();
  });

  it("keeps every action inline when the pane is wide", () => {
    const { container } = renderToolbar(1200);

    expect(screen.queryByRole("button", { name: "More PDF actions" })).toBeNull();
    expect(container.querySelector(".pdf-open-external")).toBeTruthy();
  });

  it("keeps the PDF toolbar focused on controls rather than redundant labels", () => {
    const { container } = renderToolbar(1200);

    expect(screen.queryByText("Compiled PDF")).toBeNull();
    expect(screen.queryByText("paper.pdf")).toBeNull();
    expect(container.querySelector(".typeset-pdf-page-control")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Recompile" })).toBeTruthy();
  });

  it("renders the presentation button with the presentation icon instead of visual eye icon", () => {
    const { container } = renderToolbar(1200);
    const presentBtn = container.querySelector(".pdf-present");
    expect(presentBtn).toBeTruthy();
    expect(presentBtn?.getAttribute("aria-label")).toBe("Present full screen");
    const svgPath = presentBtn?.querySelector("svg path");
    expect(svgPath?.getAttribute("d")).toContain("M2 2.8h12");
  });

  it("moves the actions that do not fit into the ⋯ menu instead of clipping them", () => {
    const { container } = renderToolbar(380);

    // Still on the row: the page and zoom controls.
    expect(container.querySelector(".typeset-pdf-page-control")).toBeTruthy();
    // Off the row, but one click away rather than gone.
    expect(container.querySelector(".pdf-open-external")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "More PDF actions" }));
    const menu = screen.getByRole("dialog", { name: "More PDF actions menu" });
    expect(within(menu).getByText("Open PDF externally")).toBeTruthy();
    expect(within(menu).getByText("Download")).toBeTruthy();

    fireEvent.click(within(menu).getByText("Open PDF externally"));
    expect(mocks.fileOpen).toHaveBeenCalledWith("paper.pdf");
  });

  it("collapses down to the overflow button alone when the pane is tiny", () => {
    const { container } = renderToolbar(280);

    expect(container.querySelectorAll(".typeset-pdf-action")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "More PDF actions" })).toBeTruthy();
  });

  it("keeps the pressed page canvas mounted throughout a drag-scroll gesture", async () => {
    const pdfPage = {
      view: [0, 0, 240, 120],
      getViewport: ({ scale }: { scale: number }) => ({
        width: 240 * scale,
        height: 120 * scale,
        transform: [scale, 0, 0, -scale, 0, 120 * scale],
      }),
      getTextContent: vi.fn(async () => ({ items: [] })),
      getAnnotations: vi.fn(async () => []),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
    };
    mocks.openPdfDocumentFromPath.mockResolvedValueOnce({
      numPages: 6,
      getPage: vi.fn(async () => pdfPage),
      destroy: vi.fn(),
    } as unknown as PDFDocumentProxy);
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: vi.fn(() => ({})),
    });

    const { container } = renderToolbar(1200);
    await screen.findByLabelText("6 PDF pages");
    fireEvent.click(screen.getByRole("button", { name: /PDF zoom \d+%/ }));
    fireEvent.click(within(screen.getByRole("menu", { name: "PDF zoom menu" }))
      .getByRole("menuitemradio", { name: "400%" }));
    await waitFor(() => expect(container.querySelectorAll(".typeset-pdf-page canvas")).toHaveLength(1));

    const scroll = container.querySelector<HTMLElement>(".typeset-pdf-scroll")!;
    const pages = Array.from(container.querySelectorAll<HTMLElement>(".typeset-pdf-page"));
    Object.defineProperty(scroll, "clientHeight", { configurable: true, value: 100 });
    pages.forEach((page, index) => {
      Object.defineProperty(page, "offsetTop", { configurable: true, value: index * 520 });
      Object.defineProperty(page, "offsetHeight", { configurable: true, value: 480 });
    });

    fireEvent.pointerDown(scroll, { pointerId: 1 });
    scroll.scrollTop = 1_560;
    fireEvent.scroll(scroll);

    await waitFor(() => {
      const firstPage = container.querySelectorAll<HTMLElement>(".typeset-pdf-page")[0];
      expect(firstPage.querySelector("canvas")).toBeTruthy();
    });

    fireEvent.pointerUp(window, { pointerId: 1 });
    await waitFor(() => {
      const firstPage = container.querySelectorAll<HTMLElement>(".typeset-pdf-page")[0];
      expect(firstPage.querySelector("canvas")).toBeNull();
    });
  });
});
