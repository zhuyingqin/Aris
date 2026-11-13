// @vitest-environment jsdom

import { EditorState } from "@codemirror/state";
import type { EditorView, WidgetType } from "@codemirror/view";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../../store";
import { renderCompiledDiagram } from "../compiledDiagramPreview";
import { visualCompiledDocument, visualDecorations, visualSourcePath } from "../visualDecorations";
import forecastingTasks from "./fixtures/forecasting-tasks.tex?raw";

vi.mock("../compiledDiagramPreview", () => ({ renderCompiledDiagram: vi.fn() }));

const source = `\\begin{document}\n\\begin{figure}\n${forecastingTasks}\\caption{Six forecasting tasks.}\n\\end{figure}\n\\end{document}`;

function diagram(snapshot = source, revision = 1) {
  const state = EditorState.create({
    doc: source,
    extensions: [
      visualDecorations,
      visualSourcePath.of("Ch2/ch2_foundations.tex"),
      visualCompiledDocument.of({ pdfPath: "Ch2/ch2_foundations.pdf", source: snapshot, revision }),
    ],
  });
  let widget: WidgetType | null = null;
  state.field(visualDecorations).deco.between(0, source.length, (_from, _to, decoration) => {
    if (decoration.spec.widget?.constructor.name === "DiagramWidget") widget = decoration.spec.widget;
  });
  if (!widget) throw new Error("No diagram widget");
  return widget as WidgetType;
}

beforeEach(() => {
  vi.resetAllMocks();
  useStore.setState({ language: "cn" });
});

describe("visual compiled diagrams", () => {
  it("replaces the complex-figure placeholder with its compiled drawing and keeps one caption", async () => {
    const canvas = document.createElement("canvas");
    canvas.className = "cm-vis-diagram-compiled";
    vi.mocked(renderCompiledDiagram).mockResolvedValue(canvas);
    const widget = diagram();
    const measure = vi.fn();
    const dom = widget.toDOM({ requestMeasure: measure } as unknown as EditorView);
    expect(dom.querySelector("svg.cm-vis-diagram-preview")).toBeNull();
    await vi.waitFor(() => expect(dom.querySelector(".cm-vis-diagram-compiled")).toBe(canvas));
    const end = source.indexOf("\\end{tikzpicture}");
    expect(renderCompiledDiagram).toHaveBeenCalledWith({
      pdfPath: "Ch2/ch2_foundations.pdf", revision: 1, sourcePath: "Ch2/ch2_foundations.tex",
      endLine: source.slice(0, end).split("\n").length,
    }, expect.any(AbortSignal));
    expect(dom.querySelectorAll(".cm-vis-caption")).toHaveLength(1);
    expect(dom.textContent).toContain("Six forecasting tasks.");
    expect(measure).toHaveBeenCalledOnce();
    widget.destroy(dom);
  });

  it("does not present the old compiled image after its source has changed", () => {
    const widget = diagram(source.replace("0.42", "0.50"));
    const dom = widget.toDOM({} as EditorView);
    expect(renderCompiledDiagram).not.toHaveBeenCalled();
    expect(dom.textContent).toContain("保存并编译");
    expect(dom.querySelector("svg.cm-vis-diagram-preview")).toBeNull();
  });

  it("keeps the source and caption available when compiled rendering fails", async () => {
    vi.mocked(renderCompiledDiagram).mockRejectedValue(new Error("No SyncTeX file"));
    const widget = diagram();
    const dom = widget.toDOM({ requestMeasure: vi.fn() } as unknown as EditorView);
    await vi.waitFor(() => expect(dom.textContent).toContain("保存并编译"));
    expect(dom.dataset.visualSelectFrom).toBe(String(source.indexOf("\\begin{figure}")));
    expect(dom.textContent).toContain("Six forecasting tasks.");
    widget.destroy(dom);
  });

  it("ignores a pending render after its widget is destroyed", async () => {
    let finish!: (canvas: HTMLCanvasElement) => void;
    vi.mocked(renderCompiledDiagram).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const widget = diagram();
    const measure = vi.fn();
    const dom = widget.toDOM({ requestMeasure: measure } as unknown as EditorView);
    const signal = vi.mocked(renderCompiledDiagram).mock.calls[0][1];
    widget.destroy(dom);
    expect(signal.aborted).toBe(true);
    finish(document.createElement("canvas"));
    await Promise.resolve();
    expect(dom.querySelector("canvas")).toBeNull();
    expect(measure).not.toHaveBeenCalled();
  });

  it("refreshes the drawing after another PDF build", () => {
    expect(diagram().eq(diagram(source, 2))).toBe(false);
  });
});
