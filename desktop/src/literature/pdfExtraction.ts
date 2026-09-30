import { literatureImageOcr, literaturePdfBytes } from "../api/tauri";
import type { PDFPageProxy } from "pdfjs-dist";
import { renderPdfPageToCanvas } from "../pdf/canvas";
import { openPdfDocument } from "../pdf/runtime";
import { useStore } from "../store";
import { LITERATURE_COPY } from "./i18n";
import { bytesToBase64, fingerprintBytes, normalizeText, pageEmbeddedText, renderPageJpeg } from "./pdfEvidence";
export { paperDocumentRevision, preparePaperPageEvidence } from "./pdfEvidence";

export interface PdfPageExtraction {
  page: number;
  text: string;
  source: "embedded" | "ocr" | "empty";
}

export interface PdfExtraction {
  text: string;
  pages: PdfPageExtraction[];
  totalCharacters: number;
  extractedCharacters: number;
  truncated: boolean;
  ocrUsed: boolean;
  missingPages: number[];
  warnings: string[];
}

export interface PdfPageImage {
  page: number;
  mimeType: "image/jpeg";
  data: string;
  byteLength: number;
  fingerprint: string;
}

export interface PdfImageExtraction {
  pages: PdfPageImage[];
  totalPages: number;
  totalBytes: number;
}

const hasReadableText = (text: string) =>
  Array.from(text).filter((character) => /[\p{L}\p{N}]/u.test(character)).length >= 8;

const PDF_IMAGE_MAX_PIXELS = 16_000_000;

const renderPagePng = async (page: PDFPageProxy) => {
  const canvas = document.createElement("canvas");
  const render = renderPdfPageToCanvas(page, canvas, 2, {
    devicePixelRatio: 1,
    maxPixels: PDF_IMAGE_MAX_PIXELS,
  });
  await render.task.promise;
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) => value ? resolve(value) : reject(new Error("Could not encode OCR page image.")),
      "image/png",
    ),
  );
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
};

/**
 * Renders `pageNumbers` (or every page, when omitted) to JPEG. Callers that
 * only need a subset — e.g. the figure/table/scanned pages a text pass
 * couldn't read — pass an explicit list so pages that don't need a vision
 * model never get rendered or uploaded.
 */
export const extractPdfPageImages = async (
  relativePath: string,
  pageNumbers?: number[],
): Promise<PdfImageExtraction> => {
  const document = await openPdfDocument(await literaturePdfBytes(relativePath));
  const totalPages = document.numPages;
  const targetPages = pageNumbers && pageNumbers.length > 0
    ? pageNumbers.filter((pageNumber) => pageNumber >= 1 && pageNumber <= totalPages)
    : Array.from({ length: totalPages }, (_, index) => index + 1);
  const pages: PdfPageImage[] = [];

  try {
    for (const pageNumber of targetPages) {
      const page = await document.getPage(pageNumber);
      const image = await renderPageJpeg(page);
      pages.push({
        page: pageNumber,
        mimeType: "image/jpeg",
        data: bytesToBase64(image),
        byteLength: image.byteLength,
        fingerprint: await fingerprintBytes(image),
      });
    }
  } finally {
    await document.destroy();
  }

  if (pages.length !== targetPages.length || pages.length === 0) {
    throw new Error("Could not render every requested PDF page for visual evidence reading.");
  }
  return {
    pages,
    totalPages,
    totalBytes: pages.reduce((sum, page) => sum + page.byteLength, 0),
  };
};

export const extractPdfTextByPage = async (relativePath: string): Promise<PdfExtraction> => {
  const document = await openPdfDocument(await literaturePdfBytes(relativePath));
  const pages: PdfPageExtraction[] = [];
  const warnings: string[] = [];
  let ocrUsed = false;

  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const embedded = await pageEmbeddedText(page);
      if (hasReadableText(embedded)) {
        pages.push({ page: pageNumber, text: embedded, source: "embedded" });
        continue;
      }
      try {
        const ocrText = normalizeText(await literatureImageOcr(await renderPagePng(page)));
        if (hasReadableText(ocrText)) {
          ocrUsed = true;
          pages.push({ page: pageNumber, text: ocrText, source: "ocr" });
        } else {
          pages.push({ page: pageNumber, text: "", source: "empty" });
        }
      } catch (error) {
        const copy = LITERATURE_COPY[useStore.getState().language].pdfReader;
        warnings.push(copy.ocrFailed(pageNumber, String(error)));
        pages.push({ page: pageNumber, text: "", source: "empty" });
      }
    }
  } finally {
    await document.destroy();
  }

  const missingPages = pages.filter((page) => !hasReadableText(page.text)).map((page) => page.page);
  const text = pages
    .filter((page) => hasReadableText(page.text))
    .map((page) => `[[PAGE ${page.page}]]\n${page.text}`)
    .join("\n\n");
  if (!text) {
    const copy = LITERATURE_COPY[useStore.getState().language].pdfReader;
    throw new Error(copy.noReadableText(warnings.join(" ")));
  }
  const characters = Array.from(text).length;
  return {
    text,
    pages,
    totalCharacters: characters,
    extractedCharacters: characters,
    truncated: missingPages.length > 0,
    ocrUsed,
    missingPages,
    warnings,
  };
};
