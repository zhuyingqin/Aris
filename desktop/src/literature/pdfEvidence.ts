import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { renderPdfPageToCanvas } from "../pdf/canvas";

export const normalizeText = (text: string) =>
  text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export const pageEmbeddedText = async (page: PDFPageProxy) => {
  const content = await page.getTextContent();
  const text = content.items
    .map((item) => {
      if (!("str" in item)) return "";
      return `${item.str}${item.hasEOL ? "\n" : " "}`;
    })
    .join("");
  return normalizeText(text);
};

export const bytesToBase64 = (bytes: Uint8Array) => {
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

export const fingerprintBytes = async (bytes: Uint8Array) => {
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

export const renderPageJpeg = async (page: PDFPageProxy): Promise<Uint8Array> => {
  const baseViewport = page.getViewport({ scale: 1 });
  const edgeScale = 2200 / Math.max(baseViewport.width, baseViewport.height);
  const areaScale = Math.sqrt(8_000_000 / (baseViewport.width * baseViewport.height));
  const scale = Math.min(1.6, edgeScale, areaScale);
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error("PDF page has invalid dimensions for visual reading.");
  }
  const canvas = document.createElement("canvas");
  const render = renderPdfPageToCanvas(page, canvas, scale, { devicePixelRatio: 1 });
  await render.task.promise;
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

/** Source preparation only: no OCR model, LLM call or task scheduling here. */
export const paperDocumentRevision = async (document: PDFDocumentProxy): Promise<string> => {
  const fingerprint = await fingerprintBytes(await document.getData());
  if (!fingerprint.startsWith("sha256:")) {
    throw new Error("SHA-256 is required to bind analysis to the original PDF.");
  }
  return fingerprint.slice("sha256:".length);
};

export const preparePaperPageEvidence = async (
  document: PDFDocumentProxy,
  pageIndex: number,
  signal: AbortSignal,
) => {
  signal.throwIfAborted();
  const page = await document.getPage(pageIndex + 1);
  // A damaged text layer must not prevent visual reading of the original page.
  const embeddedText = Array.from(await pageEmbeddedText(page).catch(() => ""));
  signal.throwIfAborted();
  const image = await renderPageJpeg(page);
  signal.throwIfAborted();
  return {
    imageBase64: bytesToBase64(image),
    embeddedText: embeddedText.slice(0, 30_000).join(""),
    textTruncated: embeddedText.length > 30_000,
  };
};
