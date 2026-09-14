// @vitest-environment jsdom

import type { Transaction, TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TypesetVisualEditor } from "../TypesetVisualEditor";
import { numberingPrefixFor, outlineFor } from "../outlineModel";
import { theoremDefinitions } from "../theoremEnvironments";

if (!Range.prototype.getClientRects) {
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    writable: true,
    value: vi.fn(() => []),
  });
}

afterEach(() => cleanup());

describe("TypesetVisualEditor document synchronization", () => {
  it("commits a file and all document-scoped facets in one transaction", async () => {
    const first = "\\section{First}\nFirst body";
    const second = "\\section{Second}\nSecond body";
    const root = [
      "\\documentclass{book}",
      "\\newtheorem{requirement}{Requirement}",
      "\\begin{document}",
      "\\input{first}",
      "\\input{second}",
      "\\end{document}",
    ].join("\n");
    const sources = { "main.tex": root, "first.tex": first, "second.tex": second };
    const outline = outlineFor(root, "main.tex", sources);
    const numbering = numberingPrefixFor(outline, "second.tex", root);
    const theorems = theoremDefinitions(root);
    const firstOpenCodeRange = vi.fn();
    const secondOpenCodeRange = vi.fn();
    const firstForwardSearch = vi.fn();
    const secondForwardSearch = vi.fn();
    const changeDraft = vi.fn();
    let view: EditorView | null = null;

    const rendered = render(
      <TypesetVisualEditor
        path="first.tex"
        draft={first}
        numbering={null}
        theorems={null}
        pdfCursor={null}
        onChange={changeDraft}
        onOpenCodeRange={firstOpenCodeRange}
        onForwardSearch={firstForwardSearch}
        onViewReady={(next) => { view = next; }}
      />,
    );
    await waitFor(() => expect(view).not.toBeNull());

    const transactions: Transaction[] = [];
    const liveView = view!;
    const originalDispatch = liveView.dispatch.bind(liveView);
    liveView.dispatch = ((...specs: readonly TransactionSpec[]) => {
      const transaction = liveView.state.update(...specs);
      transactions.push(transaction);
      originalDispatch(transaction);
    }) as EditorView["dispatch"];

    rendered.rerender(
      <TypesetVisualEditor
        path="second.tex"
        draft={second}
        numbering={numbering}
        theorems={theorems}
        pdfCursor={null}
        onChange={changeDraft}
        onOpenCodeRange={secondOpenCodeRange}
        onForwardSearch={secondForwardSearch}
        onViewReady={(next) => { view = next; }}
      />,
    );

    await waitFor(() => expect(liveView.state.doc.toString()).toBe(second));
    const reconfigured = transactions.filter((transaction) => transaction.reconfigured);
    expect(reconfigured).toHaveLength(1);
    expect(reconfigured[0].docChanged).toBe(true);

    transactions.length = 0;
    const revisedSecond = `${second}\nRevised prose`;
    rendered.rerender(
      <TypesetVisualEditor
        path="second.tex"
        draft={revisedSecond}
        numbering={numbering}
        theorems={theorems}
        pdfCursor={null}
        onChange={changeDraft}
        onOpenCodeRange={secondOpenCodeRange}
        onForwardSearch={secondForwardSearch}
        onViewReady={(next) => { view = next; }}
      />,
    );
    await waitFor(() => expect(liveView.state.doc.toString()).toBe(revisedSecond));
    const revisedDocumentTransactions = transactions.filter((transaction) => transaction.docChanged);
    expect(revisedDocumentTransactions).toHaveLength(1);
    expect(revisedDocumentTransactions[0].reconfigured).toBe(false);
  });
});
