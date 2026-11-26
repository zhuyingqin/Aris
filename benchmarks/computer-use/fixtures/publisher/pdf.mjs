// Minimal uncompressed PDF writer for the R0 publisher fixture.
//
// The text stays uncompressed so a judge can find the DOI and count pages
// with plain byte searches instead of a PDF library.

function escapeText(text) {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/**
 * @param {{ title: string, doi: string, pages: number }} paper ASCII-only fields.
 * @returns {Buffer}
 */
export function makePdf({ title, doi, pages }) {
  const objects = [];
  const pageIds = [];
  // 1: catalog, 2: pages, 3: font, then (page, content) pairs, then info.
  const fontId = 3;
  let nextId = 4;
  const pageObjects = [];
  for (let index = 1; index <= pages; index += 1) {
    const pageId = nextId++;
    const contentId = nextId++;
    pageIds.push(pageId);
    const lines = [
      title,
      `DOI: ${doi}`,
      `Page ${index} of ${pages}`,
      "SomniQ R0 publisher fixture. Not a real paper.",
    ];
    const stream = [
      "BT",
      "/F1 14 Tf",
      "72 720 Td",
      ...lines.flatMap((line, lineIndex) => (lineIndex === 0 ? [`(${escapeText(line)}) Tj`] : ["0 -22 Td", `(${escapeText(line)}) Tj`])),
      "ET",
    ].join("\n");
    pageObjects.push([
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    ]);
    pageObjects.push([contentId, `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`]);
  }
  const infoId = nextId++;
  objects.push([1, "<< /Type /Catalog /Pages 2 0 R >>"]);
  objects.push([2, `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] /Count ${pages} >>`]);
  objects.push([fontId, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]);
  objects.push(...pageObjects);
  objects.push([infoId, `<< /Title (${escapeText(title)}) /Subject (${escapeText(doi)}) /Producer (SomniQ R0 fixture) >>`]);
  objects.sort((a, b) => a[0] - b[0]);

  let body = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets = [];
  for (const [id, content] of objects) {
    offsets[id] = Buffer.byteLength(body, "latin1");
    body += `${id} 0 obj\n${content}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body, "latin1");
  const size = objects.length + 1;
  body += `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let id = 1; id < size; id += 1) {
    body += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${size} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

/** Identity facts a judge needs, read back from fixture PDF bytes. */
export function inspectPdf(bytes) {
  const text = bytes.toString("latin1");
  const doi = /DOI: (10\.\d{4,9}\/[^\s)]+)/.exec(text)?.[1] ?? null;
  const pages = (text.match(/\/Type \/Page\b(?!s)/g) || []).length;
  return { isPdf: text.startsWith("%PDF"), doi, pages, bytes: bytes.length };
}
