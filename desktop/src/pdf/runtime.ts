import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { fileReadBytes, fileReadBytesInfo, fileReadBytesRange } from "../api/tauri";

// macOS Tauri windows run on the system WKWebView. The legacy build keeps the
// PDF runtime usable on older WebKit versions instead of assuming every recent
// Promise and language API used by the modern PDF.js bundle is available.
type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

export type PdfDocumentBytes = readonly number[] | Uint8Array | ArrayBuffer;

/**
 * Keep whole-file loading fast for ordinary PDFs, while making large PDFs
 * incremental.  The range transport below keeps each IPC payload bounded.
 */
export const PDF_FULL_READ_LIMIT_BYTES = 16 * 1024 * 1024;
export const PDF_RANGE_CHUNK_SIZE = 1024 * 1024;

const workerSrc = new URL(
  "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

let pdfJsPromise: Promise<PdfJsModule> | null = null;

/**
 * Return the one configured PDF.js runtime for every desktop PDF surface.
 * Keeping worker setup here prevents individual viewers from racing to
 * configure global PDF.js state during route transitions.
 */
export function getPdfJs(): Promise<PdfJsModule> {
  if (!pdfJsPromise) {
    pdfJsPromise = import("pdfjs-dist/legacy/build/pdf.mjs").then((pdfjs) => {
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
  return pdfjs.getDocument({ data: pdfBytesToArray(bytes) }).promise;
}

function pdfBytesToArray(bytes: PdfDocumentBytes): Uint8Array {
  if (bytes instanceof Uint8Array) return new Uint8Array(bytes);
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes.slice(0));
  return Uint8Array.from(bytes);
}

/**
 * Does this failure mean "the cross-reference table disagrees with the bytes"?
 *
 * A PDF whose xref is only *partly* wrong still opens: the catalog, the page
 * tree and the first/last page resolve, so PDF.js never enters the recovery
 * path it reserves for a table it cannot read at all. The mismatch then
 * surfaces one page at a time, when that page's content stream turns out not to
 * live at its recorded offset — `Bad (uncompressed) XRef entry: 1327R`.
 * `rebuildPdfXref` below is the answer to exactly this family.
 */
export function isPdfXrefError(error: unknown): boolean {
  const message = error instanceof Error
    ? `${error.name}: ${error.message}`
    : typeof error === "string"
      ? error
      : String((error as { message?: unknown } | null)?.message ?? error ?? "");
  return /XRef entry|XRefEntryException|XRefParseException|Inconsistent generation in XRef/i.test(message)
    || /Invalid PDF structure|Invalid Root reference|Invalid num/i.test(message);
}

const STARTXREF = "startxref";
/** `startxref` sits in the trailer; a generous window covers even /Prev chains. */
const PDF_TRAILER_SCAN_BYTES = 4096;

/**
 * Force PDF.js to rebuild the cross-reference table by scanning the file for
 * `N G obj`, the same repair it performs on its own for a table it cannot read.
 *
 * That repair is not reachable through the public API, but it is reachable
 * through the file: PDF.js reindexes whenever the trailing `startxref` offset
 * does not lead to a usable table. Overwriting the offset digits in place with
 * `9`s keeps the byte length — and therefore every object offset that *is*
 * still correct — untouched, while making the broken table unreadable.
 *
 * Returns null when there is no `startxref` to blank, in which case the
 * original failure is the honest answer.
 */
export function rebuildPdfXref(bytes: PdfDocumentBytes): Uint8Array | null {
  const data = pdfBytesToArray(bytes);
  const windowStart = Math.max(0, data.length - PDF_TRAILER_SCAN_BYTES);
  let keyword = -1;
  for (let index = data.length - STARTXREF.length; index >= windowStart; index -= 1) {
    let matched = true;
    for (let offset = 0; offset < STARTXREF.length; offset += 1) {
      if (data[index + offset] !== STARTXREF.charCodeAt(offset)) {
        matched = false;
        break;
      }
    }
    if (matched) {
      keyword = index;
      break;
    }
  }
  if (keyword < 0) return null;

  let cursor = keyword + STARTXREF.length;
  while (cursor < data.length && (data[cursor] === 0x20 || data[cursor] === 0x0d || data[cursor] === 0x0a)) {
    cursor += 1;
  }
  let digits = 0;
  while (cursor + digits < data.length && data[cursor + digits] >= 0x30 && data[cursor + digits] <= 0x39) {
    digits += 1;
  }
  if (digits === 0) return null;
  data.fill(0x39, cursor, cursor + digits);
  return data;
}

/**
 * Reopen a workspace PDF with its cross-reference table rebuilt from the file
 * itself. Always a whole-file read: reindexing scans every object, so the range
 * transport would only add round trips.
 */
export async function openPdfDocumentWithRebuiltXref(path: string): Promise<PDFDocumentProxy> {
  const repaired = rebuildPdfXref(await fileReadBytes(path));
  if (!repaired) throw new Error("This PDF has no cross-reference table to rebuild.");
  return openPdfDocument(repaired);
}

/**
 * Load a workspace PDF without sending the entire file through Tauri IPC.
 * PDF.js needs the first bytes to inspect the document, then asks the custom
 * range transport for the portions required by the xref table and pages.
 *
 * A document that will not open because of its cross-reference table is
 * reopened once with that table rebuilt, rather than reported as unreadable.
 */
export async function openPdfDocumentFromPath(path: string): Promise<PDFDocumentProxy> {
  try {
    return await loadPdfDocumentFromPath(path);
  } catch (error) {
    if (!isPdfXrefError(error)) throw error;
    return openPdfDocumentWithRebuiltXref(path).catch(() => {
      throw error;
    });
  }
}

async function loadPdfDocumentFromPath(path: string): Promise<PDFDocumentProxy> {
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
