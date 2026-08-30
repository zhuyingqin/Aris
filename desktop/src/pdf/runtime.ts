import type { PDFDocumentProxy } from "pdfjs-dist";
import { fileReadBytes, fileReadBytesInfo, fileReadBytesRange } from "../api/tauri";

type PdfJsModule = typeof import("pdfjs-dist");

export type PdfDocumentBytes = readonly number[] | Uint8Array | ArrayBuffer;

/**
 * Keep whole-file loading fast for ordinary PDFs, while making large PDFs
 * incremental.  The range transport below keeps each IPC payload bounded.
 */
export const PDF_FULL_READ_LIMIT_BYTES = 16 * 1024 * 1024;
export const PDF_RANGE_CHUNK_SIZE = 1024 * 1024;

const workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

let pdfJsPromise: Promise<PdfJsModule> | null = null;

/**
 * Return the one configured PDF.js runtime for every desktop PDF surface.
 * Keeping worker setup here prevents individual viewers from racing to
 * configure global PDF.js state during route transitions.
 */
export function getPdfJs(): Promise<PdfJsModule> {
  if (!pdfJsPromise) {
    pdfJsPromise = import("pdfjs-dist").then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
      return pdfjs;
    });
  }
  return pdfJsPromise;
}

/**
 * Load a local PDF into the shared PDF.js runtime. PDF.js can transfer the
 * supplied buffer to its worker, so callers always retain their own byte data.
 */
export async function openPdfDocument(bytes: PdfDocumentBytes): Promise<PDFDocumentProxy> {
  const pdfjs = await getPdfJs();
  const data = bytes instanceof Uint8Array
    ? new Uint8Array(bytes)
    : bytes instanceof ArrayBuffer
      ? new Uint8Array(bytes.slice(0))
      : Uint8Array.from(bytes);
  return pdfjs.getDocument({ data }).promise;
}

/**
 * Load a workspace PDF without sending the entire file through Tauri IPC.
 * PDF.js needs the first bytes to inspect the document, then asks the custom
 * range transport for the portions required by the xref table and pages.
 */
export async function openPdfDocumentFromPath(path: string): Promise<PDFDocumentProxy> {
  const { bytes: length } = await fileReadBytesInfo(path);
  if (length <= PDF_FULL_READ_LIMIT_BYTES) {
    return openPdfDocument(await fileReadBytes(path));
  }

  const pdfjs = await getPdfJs();
  const initialLength = Math.min(length, PDF_RANGE_CHUNK_SIZE);
  const initialBytes = new Uint8Array(await fileReadBytesRange(path, 0, initialLength));
  let rejectRangeError: ((reason?: unknown) => void) | null = null;
  const rangeError = new Promise<never>((_, reject) => {
    rejectRangeError = reject;
  });

  const BaseRangeTransport = pdfjs.PDFDataRangeTransport;
  class WorkspacePdfRangeTransport extends BaseRangeTransport {
    private aborted = false;

    requestDataRange(begin: number, end: number): void {
      if (this.aborted) return;
      void fileReadBytesRange(path, begin, end)
        .then((bytes) => {
          if (!this.aborted) {
            this.onDataRange(begin, new Uint8Array(bytes));
          }
        })
        .catch((error: unknown) => {
          if (!this.aborted) rejectRangeError?.(error);
        });
    }

    abort(): void {
      this.aborted = true;
    }
  }

  const range = new WorkspacePdfRangeTransport(
    length,
    initialBytes,
    false,
    path.split(/[\\/]/).pop() ?? "document.pdf",
  );
  const loadingTask = pdfjs.getDocument({
    range,
    rangeChunkSize: PDF_RANGE_CHUNK_SIZE,
    disableStream: true,
    disableAutoFetch: true,
  });
  // Promise.race attaches a rejection handler to both promises, so a late
  // range failure cannot become an unhandled rejection after PDF.js resolves.
  try {
    return await Promise.race([loadingTask.promise, rangeError]);
  } catch (error) {
    await loadingTask.destroy().catch(() => undefined);
    throw error;
  }
}
