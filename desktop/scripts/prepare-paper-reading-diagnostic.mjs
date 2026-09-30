// Prepare real PDF inputs with the reader's production page/hash helpers.
// This script performs no model calls and requires no API credentials.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import { build } from "esbuild";

const [inputPath, outputPath, title, sourceUrl, imageOnlyArgument = ""] = process.argv.slice(2);
if (!inputPath || !outputPath || !title || !sourceUrl) {
  throw new Error("Usage: node scripts/prepare-paper-reading-diagnostic.mjs PDF OUTPUT_DIR TITLE SOURCE_URL [image-only page numbers]");
}
const root = fileURLToPath(new URL("..", import.meta.url));
const output = path.resolve(outputPath);
const imageOnly = new Set(imageOnlyArgument.split(",").filter(Boolean).map(Number));
Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
globalThis.document = {
  documentElement: { dataset: {}, lang: "" },
  createElement(kind) {
    if (kind !== "canvas") throw new Error(`Unsupported diagnostic element: ${kind}`);
    const canvas = createCanvas(1, 1);
    canvas.style = {};
    canvas.toBlob = (callback, mime, quality = 0.88) => {
      if (mime !== "image/jpeg") throw new Error("Expected the production JPEG path");
      canvas.encode("jpeg", Math.round(quality * 100)).then(bytes => callback(new Blob([bytes], { type: mime })));
    };
    return canvas;
  },
};
let document;
try {
  console.log("Loading production PDF helpers");
  const compiled = await build({ entryPoints: [path.join(root, "src/literature/pdfEvidence.ts")], bundle: true, platform: "node", format: "esm", write: false });
  const { paperDocumentRevision, preparePaperPageEvidence } = await import("data:text/javascript;base64," + Buffer.from(compiled.outputFiles[0].text).toString("base64"));
  console.log("Loading PDF.js");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  console.log("Opening PDF");
  document = await pdfjs.getDocument({ data: new Uint8Array(await fs.readFile(inputPath)), useSystemFonts: true }).promise;
  console.log(`Hashing ${document.numPages} original pages`);
  const documentRevision = await paperDocumentRevision(document);
  await fs.mkdir(output, { recursive: true });
  const pages = [];
  const dimensions = [];
  for (let pageIndex = 0; pageIndex < document.numPages; pageIndex += 1) {
    const evidence = await preparePaperPageEvidence(document, pageIndex, new AbortController().signal);
    const imageFile = path.join(output, `page-${pageIndex}.jpg`);
    await fs.writeFile(imageFile, Buffer.from(evidence.imageBase64, "base64"));
    await fs.writeFile(path.join(output, `page-${pageIndex}.txt`), evidence.embeddedText, "utf8");
    const viewport = (await document.getPage(pageIndex + 1)).getViewport({ scale: 1.6 });
    dimensions.push({ page: pageIndex + 1, width: Math.ceil(viewport.width), height: Math.ceil(viewport.height), imageOnly: imageOnly.has(pageIndex + 1) });
    pages.push({
      pageIndex, imageFile,
      embeddedText: imageOnly.has(pageIndex + 1) ? "" : evidence.embeddedText,
      textTruncated: evidence.textTruncated,
    });
    process.stdout.write(`Prepared ${pageIndex + 1}/${document.numPages}\n`);
  }
  const manifest = {
    paperId: `diagnostic-${documentRevision.slice(0, 16)}`, title,
    relativePath: `papers/${path.basename(inputPath)}`, documentRevision, sourceUrl, pages,
  };
  await fs.writeFile(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2));
  await fs.writeFile(path.join(output, "preparation.json"), JSON.stringify({
    sourcePdf: path.resolve(inputPath), documentRevision, totalPages: document.numPages,
    renderer: "production preparePaperPageEvidence + PDF.js legacy + @napi-rs/canvas", dimensions,
  }, null, 2));
  console.log(`Manifest: ${path.join(output, "manifest.json")}`);
} finally {
  await document?.destroy();
}
