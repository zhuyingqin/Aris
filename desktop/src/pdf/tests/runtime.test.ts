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

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
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

describe("cross-reference repair", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.getDocument.mockReset();
    apiMocks.fileReadBytes.mockReset();
    apiMocks.fileReadBytesInfo.mockReset();
    apiMocks.fileReadBytesRange.mockReset();
  });

  /** A trailer whose `startxref` offset is the thing a rebuild has to blank. */
  const pdfWithTrailer = (offset: string) =>
    new TextEncoder().encode(`%PDF-1.5\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\nstartxref\n${offset}\n%%EOF\n`);

  it("recognises the failures a rebuilt table can fix", async () => {
    const { isPdfXrefError } = await import("../runtime");

    expect(isPdfXrefError(new Error("Bad (uncompressed) XRef entry: 1327R"))).toBe(true);
    expect(isPdfXrefError({ name: "XRefEntryException", message: "Bad (compressed) XRef entry: 8R" })).toBe(true);
    expect(isPdfXrefError("InvalidPDFException: Invalid PDF structure.")).toBe(true);
    expect(isPdfXrefError(new Error("The PDF document contains no pages."))).toBe(false);
    expect(isPdfXrefError(new Error("file is too large to preview (41943041 bytes)"))).toBe(false);
  });

  it("blanks the startxref offset in place so object offsets keep their bytes", async () => {
    const { rebuildPdfXref } = await import("../runtime");
    const original = pdfWithTrailer("0000000123");

    const rebuilt = rebuildPdfXref(original);

    expect(rebuilt).not.toBeNull();
    expect(rebuilt!.byteLength).toBe(original.byteLength);
    const text = new TextDecoder().decode(rebuilt!);
    expect(text).toContain("startxref\n9999999999\n");
    expect(text.slice(0, text.indexOf("startxref"))).toBe(
      new TextDecoder().decode(original).slice(0, text.indexOf("startxref")),
    );
  });

  it("leaves a file without a startxref alone", async () => {
    const { rebuildPdfXref } = await import("../runtime");

    expect(rebuildPdfXref(new TextEncoder().encode("%PDF-1.5\n1 0 obj\n<<>>\nendobj\n"))).toBeNull();
  });

  it("reopens a document that will not load because of its xref table", async () => {
    const repaired = { destroy: vi.fn() };
    apiMocks.fileReadBytesInfo.mockResolvedValue({ bytes: 64 });
    apiMocks.fileReadBytes.mockResolvedValue(pdfWithTrailer("0000000123").buffer);
    mocks.getDocument
      .mockReturnValueOnce({ promise: Promise.reject(new Error("Bad (uncompressed) XRef entry: 1327R")) })
      .mockReturnValueOnce({ promise: Promise.resolve(repaired) });

    const { openPdfDocumentFromPath } = await import("../runtime");
    const loaded = await openPdfDocumentFromPath("main.pdf");

    expect(loaded).toBe(repaired);
    const retried = mocks.getDocument.mock.calls[1][0] as { data: Uint8Array };
    expect(new TextDecoder().decode(retried.data)).toContain("startxref\n9999999999\n");
  });

  it("reports the original failure when the rebuild cannot help either", async () => {
    apiMocks.fileReadBytesInfo.mockResolvedValue({ bytes: 64 });
    apiMocks.fileReadBytes.mockResolvedValue(pdfWithTrailer("0000000123").buffer);
    mocks.getDocument
      .mockReturnValueOnce({ promise: Promise.reject(new Error("Bad (uncompressed) XRef entry: 1327R")) })
      .mockReturnValueOnce({ promise: Promise.reject(new Error("Invalid PDF structure.")) });

    const { openPdfDocumentFromPath } = await import("../runtime");

    await expect(openPdfDocumentFromPath("main.pdf")).rejects.toThrow("Bad (uncompressed) XRef entry: 1327R");
  });

  it("does not rebuild for failures that have nothing to do with the xref table", async () => {
    apiMocks.fileReadBytesInfo.mockResolvedValue({ bytes: 64 });
    apiMocks.fileReadBytes.mockResolvedValue(pdfWithTrailer("0000000123").buffer);
    mocks.getDocument.mockReturnValueOnce({ promise: Promise.reject(new Error("Password required")) });

    const { openPdfDocumentFromPath } = await import("../runtime");

    await expect(openPdfDocumentFromPath("main.pdf")).rejects.toThrow("Password required");
    expect(mocks.getDocument).toHaveBeenCalledTimes(1);
  });
});
