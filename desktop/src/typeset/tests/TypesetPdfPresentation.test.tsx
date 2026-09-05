// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PDFDocumentProxy } from "pdfjs-dist";
import TypesetPdfPresentation from "../TypesetPdfPresentation";

function makeMockPdf(numPages = 5): PDFDocumentProxy {
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({
      width: 960 * scale,
      height: 540 * scale,
      transform: [scale, 0, 0, -scale, 0, 540 * scale],
      convertToPdfPoint: (x: number, y: number) => [x / scale, (540 * scale - y) / scale],
      convertToViewportRectangle: (rect: number[]) => rect,
    }),
    view: [0, 0, 960, 540],
    getTextContent: vi.fn(async () => ({ items: [] })),
    getAnnotations: vi.fn(async () => []),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
  };

  return {
    numPages,
    getPage: vi.fn(async () => page),
    getPageIndex: vi.fn(async () => 0),
    getDestination: vi.fn(async () => null),
    destroy: vi.fn(),
  } as unknown as PDFDocumentProxy;
}

describe("TypesetPdfPresentation", () => {
  const onPageChange = vi.fn();
  const onClose = vi.fn();
  const onToggleInverted = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4) })),
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  });

  afterEach(() => {
    cleanup();
  });

  function renderPresentation(props: Partial<Parameters<typeof TypesetPdfPresentation>[0]> = {}) {
    const pdf = props.pdf ?? makeMockPdf(5);
    return render(
      <TypesetPdfPresentation
        pdf={pdf}
        numPages={5}
        currentPage={1}
        pageSizes={{ 1: { width: 960, height: 540 } }}
        inverted={false}
        language="en"
        onToggleInverted={onToggleInverted}
        onPageChange={onPageChange}
        onClose={onClose}
        {...props}
      />,
    );
  }

  it("renders presentation overlay, stage, and HUD with page indicator", () => {
    renderPresentation();

    expect(screen.getByRole("dialog", { name: "Present full screen" })).toBeTruthy();
    expect(screen.getByRole("toolbar", { name: "Presentation controls" })).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
  });

  it("advances and steps back via keyboard navigation", () => {
    renderPresentation({ currentPage: 2 });

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(onPageChange).toHaveBeenLastCalledWith(3);

    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(onPageChange).toHaveBeenLastCalledWith(4);

    fireEvent.keyDown(window, { key: "PageDown" });
    expect(onPageChange).toHaveBeenLastCalledWith(5);

    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(onPageChange).toHaveBeenLastCalledWith(4);

    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(onPageChange).toHaveBeenLastCalledWith(3);

    fireEvent.keyDown(window, { key: "Home" });
    expect(onPageChange).toHaveBeenLastCalledWith(1);

    fireEvent.keyDown(window, { key: "End" });
    expect(onPageChange).toHaveBeenLastCalledWith(5);
  });

  it("exits presentation when pressing Escape or Q", () => {
    renderPresentation();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "q" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("exits presentation when clicking the HUD exit button", () => {
    renderPresentation();

    const exitBtn = screen.getByRole("button", { name: "Exit presentation (Esc)" });
    fireEvent.click(exitBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("toggles colors when clicking the invert button", () => {
    renderPresentation();

    const invertBtn = screen.getByRole("button", { name: "Invert PDF colours" });
    fireEvent.click(invertBtn);
    expect(onToggleInverted).toHaveBeenCalledTimes(1);
  });

  it("advances on right-side click and goes back on left-side click", () => {
    const { container } = renderPresentation({ currentPage: 2 });
    const overlay = container.querySelector(".typeset-pdf-presentation-overlay")!;

    // Mock getBoundingClientRect
    vi.spyOn(overlay, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 1000,
      height: 600,
      right: 1000,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    // Click on the right side (clientX = 600, which is > 25% of 1000)
    fireEvent.click(overlay, { clientX: 600 });
    expect(onPageChange).toHaveBeenLastCalledWith(3);

    // Click on the left side (clientX = 100, which is < 25% of 1000)
    fireEvent.click(overlay, { clientX: 100 });
    expect(onPageChange).toHaveBeenLastCalledWith(2);

    // Shift-click on right side should go back
    fireEvent.click(overlay, { clientX: 800, shiftKey: true });
    expect(onPageChange).toHaveBeenLastCalledWith(1);
  });

  it("advances even when clicking on the transparent source-target element", () => {
    const { container } = renderPresentation({ currentPage: 1 });
    const overlay = container.querySelector(".typeset-pdf-presentation-overlay")!;

    vi.spyOn(overlay, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 1000,
      height: 600,
      right: 1000,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    // Create a mock source target button inside the stage
    const sourceTarget = document.createElement("button");
    sourceTarget.className = "typeset-pdf-page-source-target";
    overlay.appendChild(sourceTarget);

    fireEvent.click(sourceTarget, { clientX: 700 });
    expect(onPageChange).toHaveBeenLastCalledWith(2);
  });

  it("switches to dual-page mode, renders two pages, and steps by 2", () => {
    const { container } = renderPresentation({ currentPage: 1, numPages: 5 });

    // Click the dual-page layout button in HUD
    const dualBtn = screen.getByRole("radio", { name: "Two pages (2)" });
    fireEvent.click(dualBtn);

    // Expect stage to have class 'dual'
    expect(container.querySelector(".typeset-pdf-presentation-stage.dual")).toBeTruthy();

    // In dual mode starting at 1, pages indicator displays "1 - 2"
    expect(screen.getByText("1 - 2")).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();

    // Advance to next spread
    const nextBtn = screen.getByRole("button", { name: "Next page" });
    fireEvent.click(nextBtn);
    expect(onPageChange).toHaveBeenLastCalledWith(3);
  });

  it("switches to grid overview mode, renders all thumbnails, and allows selecting a page", () => {
    const { container } = renderPresentation({ currentPage: 1, numPages: 5 });

    // Press 'g' to enter grid mode
    fireEvent.keyDown(window, { key: "g" });

    // Expect stage to have class 'grid'
    expect(container.querySelector(".typeset-pdf-presentation-stage.grid")).toBeTruthy();

    // Expect 5 grid items
    const gridItems = container.querySelectorAll(".typeset-presentation-grid-item");
    expect(gridItems.length).toBe(5);

    // Click thumbnail for page 4
    const page4Item = screen.getByRole("button", { name: "Page 4" });
    fireEvent.click(page4Item);

    // Should call onPageChange with 4 and exit grid mode back to single
    expect(onPageChange).toHaveBeenLastCalledWith(4);
    expect(container.querySelector(".typeset-pdf-presentation-stage.single")).toBeTruthy();
  });

  it("switches layouts using keyboard shortcuts '1', '2', and 'g'", () => {
    const { container } = renderPresentation({ currentPage: 1 });

    // Press '2' for dual mode
    fireEvent.keyDown(window, { key: "2" });
    expect(container.querySelector(".typeset-pdf-presentation-stage.dual")).toBeTruthy();

    // Press '1' for single mode
    fireEvent.keyDown(window, { key: "1" });
    expect(container.querySelector(".typeset-pdf-presentation-stage.single")).toBeTruthy();

    // Press 'g' for grid mode
    fireEvent.keyDown(window, { key: "g" });
    expect(container.querySelector(".typeset-pdf-presentation-stage.grid")).toBeTruthy();

    // Press 'g' again to toggle back
    fireEvent.keyDown(window, { key: "g" });
    expect(container.querySelector(".typeset-pdf-presentation-stage.single")).toBeTruthy();
  });
});

