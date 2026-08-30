// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDocument: vi.fn(),
  workerOptions: { workerSrc: "" },
  PDFDataRangeTransport: class {
    length: number;
    initialData: Uint8Array | null;
    progressiveDone: boolean;
    contentDispositionFilename: string;
    constructor(length: number, initialData: Uint8Array | null, progressiveDone = false, contentDispositionFilename = "") {
      this.length = length;
      this.initialData = initialData;
      this.progressiveDone = progressiveDone;
      this.contentDispositionFilename = contentDispositionFilename;
    }
    onDataRange() {}
    onDataProgressiveRead() {}
    onDataProgressiveDone() {}
    transportReady() {}
    requestDataRange() {}
    abort() {}
  },
}));

const apiMocks = vi.hoisted(() => ({
  fileReadBytes: vi.fn(),
  fileReadBytesInfo: vi.fn(),
  fileReadBytesRange: vi.fn(),
}));

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: mocks.workerOptions,
  getDocument: mocks.getDocument,
  PDFDataRangeTransport: mocks.PDFDataRangeTransport,
}));

vi.mock("../../api/tauri", () => apiMocks);

describe("shared PDF.js runtime", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.workerOptions.workerSrc = "";
    mocks.getDocument.mockReset();
    apiMocks.fileReadBytes.mockReset();
    apiMocks.fileReadBytesInfo.mockReset();
    apiMocks.fileReadBytesRange.mockReset();
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

  it("uses bounded range requests for large workspace PDFs", async () => {
    const document = { destroy: vi.fn() };
    const largePdfBytes = 32 * 1024 * 1024;
    const initialBytes = new Uint8Array([37, 80, 68, 70]);
    apiMocks.fileReadBytesInfo.mockResolvedValue({ bytes: largePdfBytes });
    apiMocks.fileReadBytesRange.mockResolvedValue(initialBytes.buffer);
    mocks.getDocument.mockReturnValue({
      promise: Promise.resolve(document),
      destroy: vi.fn().mockResolvedValue(undefined),
    });

    const { openPdfDocumentFromPath, PDF_RANGE_CHUNK_SIZE } = await import("../runtime");
    const loaded = await openPdfDocumentFromPath("exports/book.pdf");

    expect(loaded).toBe(document);
    expect(apiMocks.fileReadBytesInfo).toHaveBeenCalledWith("exports/book.pdf");
    expect(apiMocks.fileReadBytes).not.toHaveBeenCalled();
    expect(apiMocks.fileReadBytesRange).toHaveBeenCalledWith("exports/book.pdf", 0, PDF_RANGE_CHUNK_SIZE);
    const request = mocks.getDocument.mock.calls[0][0] as {
      range: { length: number; initialData: Uint8Array };
      rangeChunkSize: number;
      disableStream: boolean;
      disableAutoFetch: boolean;
    };
    expect(request.range.length).toBe(largePdfBytes);
    expect(request.range.initialData).toEqual(initialBytes);
    expect(request.rangeChunkSize).toBe(PDF_RANGE_CHUNK_SIZE);
    expect(request.disableStream).toBe(true);
    expect(request.disableAutoFetch).toBe(true);
  });
});
