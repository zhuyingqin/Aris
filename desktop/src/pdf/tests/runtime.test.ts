// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDocument: vi.fn(),
  workerOptions: { workerSrc: "" },
}));

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: mocks.workerOptions,
  getDocument: mocks.getDocument,
}));

describe("shared PDF.js runtime", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.workerOptions.workerSrc = "";
    mocks.getDocument.mockReset();
  });

  it("configures one worker and gives PDF.js an owned copy of local bytes", async () => {
    const document = { destroy: vi.fn() };
    mocks.getDocument.mockReturnValue({ promise: Promise.resolve(document) });
    const { getPdfJs, openPdfDocument } = await import("../runtime");
    const source = new Uint8Array([1, 2, 3]);

    await getPdfJs();
    const loaded = await openPdfDocument(source);

    expect(mocks.workerOptions.workerSrc).toContain("pdf.worker.min.mjs");
    expect(loaded).toBe(document);
    const request = mocks.getDocument.mock.calls[0][0] as { data: Uint8Array };
    expect(request.data).toEqual(source);
    expect(request.data).not.toBe(source);
  });
});
