// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import type { KeyboardEvent, PointerEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTypesetPanels } from "../useTypesetPanels";

afterEach(cleanup);

describe("Typeset Chat panel width", () => {
  it("keeps file and Chat widths independent through keyboard and pointer resizing", () => {
    const { result, rerender } = renderHook(({ chat }) => useTypesetPanels(chat), {
      initialProps: { chat: false },
    });
    const arrow = { key: "ArrowRight", shiftKey: false, preventDefault: vi.fn() } as unknown as KeyboardEvent<HTMLDivElement>;
    act(() => result.current.handlePanelResizeKey("project", arrow));
    const fileWidth = result.current.projectPanelWidth;

    rerender({ chat: true });
    expect(result.current.projectPanelWidth).toBeGreaterThan(fileWidth);
    const chatWidth = result.current.projectPanelWidth;
    act(() => result.current.handlePanelResizeKey("project", arrow));
    expect(result.current.projectPanelWidth).toBe(chatWidth + 16);

    const divider = document.createElement("div");
    vi.spyOn(divider, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 6, 400));
    act(() => result.current.beginPanelResizeFromPointer("project", {
      pointerType: "mouse", button: 0, clientX: 300, clientY: 0, currentTarget: divider,
      preventDefault: vi.fn(), stopPropagation: vi.fn(),
    } as unknown as PointerEvent<HTMLDivElement>));
    act(() => window.dispatchEvent(new MouseEvent("mousemove", { clientX: 380, clientY: 0 })));
    act(() => window.dispatchEvent(new MouseEvent("mouseup")));
    expect(result.current.projectPanelWidth).toBe(chatWidth + 96);

    rerender({ chat: false });
    expect(result.current.projectPanelWidth).toBe(fileWidth);
    rerender({ chat: true });
    expect(result.current.projectPanelWidth).toBe(chatWidth + 96);
  });
});
