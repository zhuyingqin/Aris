// @vitest-environment jsdom
import { useRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FigureResizeHandle, { useFigurePanelSize } from "./FigureResizeHandle";

function Harness({ corner = false }: { corner?: boolean }) {
  const panelRef = useRef<HTMLElement>(null);
  const layout = useFigurePanelSize("test-panel");
  return <div data-testid="bounds"><section ref={panelRef} data-testid="panel" style={{ width: layout.size.width ?? 300, height: layout.size.height ?? 240 }}>
    <FigureResizeHandle label="Resize panel" panelRef={panelRef} axis={corner ? "both" : "x"}
      directionX={-1} directionY={-1} minWidth={260} reserveWidth={344} onResize={layout.resize} onReset={layout.reset} />
  </section></div>;
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("PointerEvent", class extends MouseEvent {
    pointerId: number; isPrimary: boolean;
    constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; this.isPrimary = init.isPrimary ?? true; }
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const panel = this.dataset.testid === "panel", width = panel ? parseFloat(this.style.width) : 1000, height = panel ? parseFloat(this.style.height) : 700;
    const left = panel ? 980 - width : 0, top = panel ? 680 - height : 0;
    return { width, height, left, top, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) };
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("figure panel resizing", () => {
  it("sizes a right dock in the drag direction, leaves room for the canvas and restores pointer state", () => {
    const mounted = render(<Harness />);
    const handle = screen.getByLabelText("Resize panel"), panel = screen.getByTestId("panel");
    document.body.style.cursor = "crosshair"; document.body.style.userSelect = "text";
    fireEvent.pointerDown(handle, { pointerId: 2, clientX: 680, button: 0 });
    fireEvent.pointerMove(window, { pointerId: 3, clientX: 400 });
    expect(panel.style.width).toBe("300px");
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 180 });
    expect(panel.style.width).toBe("636px");
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 880 });
    expect(panel.style.width).toBe("260px");
    fireEvent.pointerUp(window, { pointerId: 2 });
    expect(document.querySelector(".figure-resize-shield")).toBeNull();
    expect(document.body.style.cursor).toBe("crosshair"); expect(document.body.style.userSelect).toBe("text");
    mounted.unmount(); render(<Harness />);
    expect(screen.getByTestId("panel").style.width).toBe("260px");
    fireEvent.doubleClick(screen.getByLabelText("Resize panel"));
    expect(screen.getByTestId("panel").style.width).toBe("300px");
    document.body.style.cursor = ""; document.body.style.userSelect = "";
  });

  it("resizes both dimensions and releases the iframe shield on cancellation or unmount", () => {
    const mounted = render(<Harness corner />);
    const handle = screen.getByLabelText("Resize panel");
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 680, clientY: 440, button: 0 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 600, clientY: 390 });
    expect(screen.getByTestId("panel").style.width).toBe("380px");
    expect(screen.getByTestId("panel").style.height).toBe("290px");
    fireEvent.pointerCancel(window, { pointerId: 1 });
    expect(document.querySelector(".figure-resize-shield")).toBeNull();
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 600, clientY: 390, button: 0 });
    mounted.unmount();
    expect(document.querySelector(".figure-resize-shield")).toBeNull();
    expect(document.body.style.userSelect).toBe("");
  });

  it("supports keyboard sizing and reset when saved preferences are invalid", () => {
    localStorage.setItem("somniq.figure.layout.test-panel", '{"width":-1,"height":"bad"}');
    render(<Harness />);
    const handle = screen.getByLabelText("Resize panel");
    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
    expect(screen.getByTestId("panel").style.width).toBe("364px");
    fireEvent.keyDown(handle, { key: "Home" });
    expect(screen.getByTestId("panel").style.width).toBe("300px");
  });
});
