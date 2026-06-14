// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PdfAnnotation } from "./literatureTypes";

vi.mock("../api/tauri", () => ({
  isTauri: () => false,
  literaturePdfBytes: vi.fn(),
}));

import PdfReader from "./PdfReader";

afterEach(cleanup);

describe("PdfReader annotations", () => {
  it("renders toolbar and edits annotation quote, note, kind, and color via the sidebar", () => {
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
    const onUpdateAnnotation = vi.fn();
    render(
      <PdfReader
        relativePath="papers/test.pdf"
        annotations={[annotation]}
        onOpenExternal={() => undefined}
        onAddAnnotation={() => undefined}
        onUpdateAnnotation={onUpdateAnnotation}
        onDeleteAnnotation={() => undefined}
      />,
    );

    // Toolbar should have zoom controls and sidebar toggle
    expect(screen.getByRole("button", { name: "系统阅读器" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "适应宽度" })).toBeTruthy();

    // Sidebar annotation editing still works
    expect(screen.getByRole("combobox", { name: "标注颜色" })).toBeTruthy();

    const core = screen.getByDisplayValue("Original core");
    fireEvent.change(core, { target: { value: "Updated core" } });
    fireEvent.blur(core);
    expect(onUpdateAnnotation).toHaveBeenCalledWith("annotation-1", { quote: "Updated core" });

    const note = screen.getByDisplayValue("Original note");
    fireEvent.change(note, { target: { value: "Updated note" } });
    fireEvent.blur(note);
    expect(onUpdateAnnotation).toHaveBeenCalledWith("annotation-1", { note: "Updated note" });

    fireEvent.change(screen.getByRole("combobox", { name: "标注类型" }), {
      target: { value: "core" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "标注颜色" }), {
      target: { value: "green" },
    });
    expect(onUpdateAnnotation).toHaveBeenCalledWith("annotation-1", { kind: "core" });
    expect(onUpdateAnnotation).toHaveBeenCalledWith("annotation-1", { color: "green" });
  });
});
