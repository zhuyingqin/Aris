// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  fileOpen: vi.fn(() => Promise.resolve()),
  fileReveal: vi.fn(() => Promise.resolve()),
  fileReadBytes: vi.fn(() => Promise.resolve(new ArrayBuffer(4))),
  fileReadText: vi.fn(() => Promise.resolve({ path: "notes.md", content: "# Heading\n\nbody", bytes: 16, version: "v1" })),
}));

const pdfMocks = vi.hoisted(() => ({
  props: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../api/tauri", () => apiMocks);

vi.mock("../../literature/PdfReader", () => ({
  default: (props: Record<string, unknown>) => {
    pdfMocks.props.push(props);
    return <div data-testid="pdf-reader" />;
  },
}));

vi.mock("../../editor/SharedEditor", () => ({
  SharedEditor: ({ doc, readOnly }: { doc: string; readOnly?: boolean }) => (
    <pre data-testid="shared-editor" data-readonly={String(Boolean(readOnly))}>{doc}</pre>
  ),
}));

import { useStore } from "../../store";
import SideFileViewer from "../SideFileViewer";
import { fileHandoff, sideFileKind, sideFileTitle } from "../sidePanelFiles";

describe("sidePanelFiles", () => {
  it("routes a path to the viewer that can render it", () => {
    expect(sideFileKind("F:/p/paper.PDF")).toBe("pdf");
    expect(sideFileKind("F:/p/figure.png")).toBe("image");
    expect(sideFileKind("F:/p/README.md")).toBe("markdown");
    expect(sideFileKind("F:/p/main.rs")).toBe("text");
    // Unknown extensions still read as text; the backend rejects real binaries.
    expect(sideFileKind("F:/p/run.log")).toBe("text");
  });

  it("keeps the tab label short without losing the extension", () => {
    expect(sideFileTitle("F:/p/notes.md")).toBe("notes.md");
    expect(sideFileTitle("F:/p/a-very-long-generated-report-name.md")).toMatch(/…\.md$/);
  });

  it("quotes a selection and falls back to the path", () => {
    expect(fileHandoff("F:/p/paper.pdf", "", "cn", 3)).toContain("第 3 页");
    const quoted = fileHandoff("F:/p/paper.pdf", "  key claim  ", "cn", 3);
    expect(quoted).toContain("侧栏摘录");
    expect(quoted).toContain("key claim");
  });
});

describe("SideFileViewer", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    pdfMocks.props.length = 0;
    useStore.setState({ language: "cn" });
  });

  afterEach(() => cleanup());

  it("previews markdown, exposes the source, and reports the file as a handoff", async () => {
    const onMetadataChange = vi.fn();
    render(
      <SideFileViewer
        tabId="tab-1"
        path="F:/project/docs/notes.md"
        onOpenInWorkspace={() => undefined}
        onMetadataChange={onMetadataChange}
      />,
    );

    await waitFor(() => expect(apiMocks.fileReadText).toHaveBeenCalledWith("F:/project/docs/notes.md"));
    await waitFor(() => expect(document.querySelector(".side-file-markdown")).toBeTruthy());
    expect(screen.queryByTestId("shared-editor")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "源码" }));
    const editor = await screen.findByTestId("shared-editor");
    expect(screen.getByRole("button", { name: "预览" })).toBeTruthy();
    expect(editor.textContent).toContain("# Heading");
    expect(editor.getAttribute("data-readonly")).toBe("true");

    expect(onMetadataChange).toHaveBeenLastCalledWith("tab-1", {
      title: "notes.md",
      handoff: expect.stringContaining("F:/project/docs/notes.md"),
    });
  });

  it("hands a PDF to the shared reader as a read-only workspace file", async () => {
    render(
      <SideFileViewer
        tabId="tab-2"
        path="F:/project/papers/draft.pdf"
        onOpenInWorkspace={() => undefined}
        onMetadataChange={() => undefined}
      />,
    );

    await screen.findByTestId("pdf-reader");
    expect(apiMocks.fileReadText).not.toHaveBeenCalled();
    expect(pdfMocks.props[0]).toMatchObject({
      relativePath: "F:/project/papers/draft.pdf",
      sourceKind: "path",
      readOnly: true,
    });
  });

  it("jumps to cited evidence and passes a focused read-only highlight", async () => {
    render(
      <SideFileViewer
        tabId="tab-evidence"
        path="F:/project/papers/paper-1.pdf"
        evidence={{
          path: "F:/project/papers/paper-1.pdf",
          paperId: "paper-1",
          page: 7,
          citation: "[paper-1 p.7]",
          quotes: ["Only 20 samples were used in the evaluation."],
          requestKey: "evidence-request-1",
        }}
        onOpenInWorkspace={() => undefined}
        onMetadataChange={() => undefined}
      />,
    );

    await screen.findByTestId("pdf-reader");
    expect(screen.getByText("回答引用证据 · [paper-1 p.7]")).toBeTruthy();
    expect(pdfMocks.props[0]).toMatchObject({
      initialPage: 7,
      pageRequestKey: "evidence-request-1",
      focusedAnnotationId: "evidence-request-1:0",
      annotations: [{
        id: "evidence-request-1:0",
        page: 7,
        quote: "Only 20 samples were used in the evaluation.",
        kind: "answer-support",
        color: "yellow",
      }],
      readOnly: true,
    });
  });

  it("offers the system app when the file cannot be read in place", async () => {
    apiMocks.fileReadText.mockRejectedValueOnce(new Error("file is too large for the Lab editor"));
    render(
      <SideFileViewer
        tabId="tab-3"
        path="F:/project/data/huge.csv"
        onOpenInWorkspace={() => undefined}
        onMetadataChange={() => undefined}
      />,
    );

    const fallback = await screen.findByRole("button", { name: "用系统程序打开" });
    await userEvent.click(fallback);
    expect(apiMocks.fileOpen).toHaveBeenCalledWith("F:/project/data/huge.csv");
  });
});
