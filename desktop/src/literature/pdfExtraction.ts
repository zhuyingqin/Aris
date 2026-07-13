import { literatureImageOcr, literaturePdfBytes } from "../api/tauri";
import type { PDFPageProxy } from "pdfjs-dist";

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

const workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

const hasReadableText = (text: string) =>
  Array.from(text).filter((character) => /[\p{L}\p{N}]/u.test(character)).length >= 8;

const normalizeText = (text: string) =>
  text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const pageEmbeddedText = async (page: PDFPageProxy) => {
  const content = await page.getTextContent();
  const text = content.items
    .map((item) => {
      if (!("str" in item)) return "";
      return `${item.str}${item.hasEOL ? "\n" : " "}`;
    })
    .join("");
  return normalizeText(text);
};

const renderPagePng = async (page: PDFPageProxy) => {
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas rendering is unavailable for OCR.");
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) => value ? resolve(value) : reject(new Error("Could not encode OCR page image.")),
      "image/png",
    ),
  );
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
};

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
};

const fallbackFingerprint = (bytes: Uint8Array) => {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
};

const fingerprintBytes = async (bytes: Uint8Array) => {
  if (globalThis.crypto?.subtle) {
    const digestInput = new Uint8Array(bytes.byteLength);
    digestInput.set(bytes);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", digestInput.buffer);
    return `sha256:${Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")}`;
  }
  return fallbackFingerprint(bytes);
};

const renderPageJpeg = async (page: PDFPageProxy): Promise<Uint8Array> => {
  const baseViewport = page.getViewport({ scale: 1 });
  const edgeScale = 2200 / Math.max(baseViewport.width, baseViewport.height);
  const areaScale = Math.sqrt(8_000_000 / (baseViewport.width * baseViewport.height));
  const scale = Math.min(1.6, edgeScale, areaScale);
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error("PDF page has invalid dimensions for visual reading.");
  }
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas rendering is unavailable for visual reading.");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  const encode = (quality: number) =>
    new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) => value ? resolve(value) : reject(new Error("Could not encode PDF page image.")),
        "image/jpeg",
        quality,
      ),
    );
  let blob = await encode(0.88);
  if (blob.size > 7 * 1024 * 1024) blob = await encode(0.7);
  if (blob.size > 7 * 1024 * 1024) {
    throw new Error("Rendered PDF page image exceeds the visual-reading size limit.");
  }
  return new Uint8Array(await blob.arrayBuffer());
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
  const [bytes, pdfjs] = await Promise.all([literaturePdfBytes(relativePath), import("pdfjs-dist")]);
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
  const document = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
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
  const [bytes, pdfjs] = await Promise.all([literaturePdfBytes(relativePath), import("pdfjs-dist")]);
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
  const document = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
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
        warnings.push(`第 ${pageNumber} 页 OCR 失败：${String(error)}`);
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
  if (!text) throw new Error(`PDF 没有可读取文本。${warnings.join(" ")}`);
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
