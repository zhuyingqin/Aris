import type { PDFDocumentProxy } from "pdfjs-dist";

type PdfJsModule = typeof import("pdfjs-dist");

export type PdfDocumentBytes = readonly number[] | Uint8Array | ArrayBuffer;

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
