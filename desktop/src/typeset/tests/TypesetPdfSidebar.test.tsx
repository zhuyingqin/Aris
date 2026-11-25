// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { afterEach, describe, expect, it, vi } from "vitest";
import TypesetPdfSidebar from "../TypesetPdfSidebar";
import { activeOutlinePath, pdfOutlineEntries } from "../pdfOutline";

/** Page references are objects in a real PDF; `{ num }` stands in for them. */
const ref = (page: number) => ({ num: page * 10, gen: 0 });

function fakePdf(outline: unknown[] | null): PDFDocumentProxy {
  return {
    numPages: 6,
    getOutline: vi.fn(async () => outline),
    getDestination: vi.fn(async (name: string) => (name === "chapter.2" ? [ref(4), { name: "XYZ" }] : null)),
    getPageIndex: vi.fn(async (pageRef: { num: number }) => pageRef.num / 10 - 1),
    getPage: vi.fn(async () => ({
      getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
      render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
    })),
  } as unknown as PDFDocumentProxy;
}

const OUTLINE = [
  {
    title: "1 Introduction",
    dest: [ref(1), { name: "XYZ" }],
    items: [
      { title: "1.1 Background", dest: [ref(2), { name: "XYZ" }], items: [] },
      { title: "1.2 Scope", dest: [ref(3), { name: "XYZ" }], items: [] },
    ],
  },
  { title: "2 Method", dest: "chapter.2", items: [] },
];

describe("PDF bookmarks", () => {
  afterEach(cleanup);

  it("resolves every bookmark to its page, named destinations included", async () => {
    const entries = await pdfOutlineEntries(fakePdf(OUTLINE));
    expect(entries.map((entry) => [entry.title, entry.page])).toEqual([["1 Introduction", 1], ["2 Method", 4]]);
    expect(entries[0].children.map((entry) => entry.page)).toEqual([2, 3]);
    // The reader on page 3 is in 1.2, inside chapter 1.
    expect(activeOutlinePath(entries, 3)).toEqual([entries[0].id, entries[0].children[1].id]);
    expect(activeOutlinePath(entries, 5)).toEqual([entries[1].id]);
  });

  it("lists the bookmarks, marks where the reader is, and jumps on click", async () => {
    const onNavigate = vi.fn();
    render(
      <TypesetPdfSidebar
        pdf={fakePdf(OUTLINE)}
        numPages={6}
        currentPage={2}
        pageSizes={{}}
        language="en"
        tab={null}
        onTabChange={vi.fn()}
        onNavigate={onNavigate}
      />,
    );
    const background = await screen.findByRole("button", { name: /1\.1 Background/ });
    expect(background.closest(".typeset-pdf-outline-row")?.classList.contains("active")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /2 Method/ }));
    expect(onNavigate).toHaveBeenCalledWith(4);

    // Collapsing the chapter keeps showing that the reader is inside it.
    fireEvent.click(screen.getByRole("button", { name: 'Collapse "1 Introduction"' }));
    expect(screen.queryByRole("button", { name: /1\.1 Background/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^1 Introduction/ }).closest(".typeset-pdf-outline-row")?.classList.contains("contains-active")).toBe(true);
  });

  it("falls back to thumbnails, and explains the missing bookmarks, for a PDF without any", async () => {
    const onNavigate = vi.fn();
    const onTabChange = vi.fn();
    const { rerender } = render(
      <TypesetPdfSidebar
        pdf={fakePdf(null)}
        numPages={3}
        currentPage={1}
        pageSizes={{ 1: { width: 600, height: 800 } }}
        language="en"
        tab={null}
        onTabChange={onTabChange}
        onNavigate={onNavigate}
      />,
    );
    const third = await screen.findByRole("button", { name: "Page 3" });
    expect(screen.getByRole("button", { name: "Page 1" }).getAttribute("aria-current")).toBe("page");
    fireEvent.click(third);
    expect(onNavigate).toHaveBeenCalledWith(3);

    fireEvent.click(screen.getByRole("tab", { name: "Bookmarks" }));
    expect(onTabChange).toHaveBeenCalledWith("outline");
    rerender(
      <TypesetPdfSidebar
        pdf={fakePdf(null)}
        numPages={3}
        currentPage={1}
        pageSizes={{}}
        language="en"
        tab="outline"
        onTabChange={onTabChange}
        onNavigate={onNavigate}
      />,
    );
    await waitFor(() => expect(screen.getByText(/usepackage\{hyperref\}/)).toBeTruthy());
  });
});
