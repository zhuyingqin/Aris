// Creates a fresh Windows temp-folder fixture for the R0 desktop tasks and
// records a manifest (expected outcomes + hashes of every starting file) so
// the judge can detect both success and unexpected side effects.
//
//   node setup.mjs [--run-id <id>] [--root <dir>]
//
// Default root: %TEMP%\somniq-cu-r0. Prints the manifest path as JSON.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { makePdf } from "../publisher/pdf.mjs";

export const MARKERS = {
  note: "R0-NOTE-MARKER-3C9D",
  comment: "R0-COMMENT-7F3A",
  insert: "R0-INSERT-91C2",
  delete: "R0-DELETE-55E0",
};

// ---- store-only ZIP writer (enough for a .docx) ----------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  // Fixed DOS timestamp (2026-11-25 00:00) keeps the bytes reproducible.
  const dosTime = 0;
  const dosDate = ((2026 - 1980) << 9) | (11 << 5) | 25;
  for (const [name, text] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.from(text, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

// ---- review copy: one comment, one tracked insertion, one tracked deletion --

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

export function makeReviewDocx() {
  const author = 'w:author="R0 Reviewer" w:date="2026-11-25T00:00:00Z"';
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>
<w:p><w:r><w:t>R0 审阅副本：这是一份只读检查用的测试文档。</w:t></w:r></w:p>
<w:p><w:commentRangeStart w:id="0"/><w:r><w:t>实验部分只给了结论，没有给出参数设置。</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">修订示例：</w:t></w:r><w:ins w:id="1" ${author}><w:r><w:t>${MARKERS.insert} 这句是追踪修订中新增的。</w:t></w:r></w:ins><w:del w:id="2" ${author}><w:r><w:delText>${MARKERS.delete} 这句是追踪修订中删除的。</w:delText></w:r></w:del></w:p>
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>
</w:body></w:document>`;
  const comments = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments ${W}><w:comment w:id="0" w:author="R0 Reviewer" w:initials="RR" w:date="2026-11-25T00:00:00Z"><w:p><w:r><w:t>${MARKERS.comment} 请补充实验参数。</w:t></w:r></w:p></w:comment></w:comments>`;
  return zip([
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`],
    ["word/document.xml", document],
    ["word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/></Relationships>`],
    ["word/comments.xml", comments],
  ]);
}

// ---- fixture tree ------------------------------------------------------------

export function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function snapshotTree(root) {
  const files = {};
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (entry.isDirectory()) {
        files[`${rel}/`] = "dir";
        walk(full);
      } else {
        files[rel] = sha256(fs.readFileSync(full));
      }
    }
  };
  walk(root);
  return files;
}

export function setupDesktopFixture({ runId = `r0-${Date.now().toString(36)}`, root = path.join(os.tmpdir(), "somniq-cu-r0") } = {}) {
  const runDir = path.join(root, runId);
  const work = path.join(runDir, "work");
  if (fs.existsSync(runDir)) throw new Error(`fixture run already exists: ${runDir}`);
  const notes = path.join(work, `notes-${runId}`);
  const pdfs = path.join(work, `pdfs-${runId}`);
  const review = path.join(work, `review-${runId}`);
  const explorer = path.join(work, `explorer-${runId}`);
  for (const dir of [notes, pdfs, review, explorer, path.join(runDir, "out")]) fs.mkdirSync(dir, { recursive: true });

  const draft = path.join(notes, "draft.txt");
  fs.writeFileSync(draft, `R0 记事本测试文件\r\n${MARKERS.note}\r\n第三行：用于确认文本模型能否读到正文。\r\n`, "utf8");

  // Alphabetical order and date order disagree on purpose (C3).
  const pdfSpecs = [
    ["a-latest-looking-name.pdf", "2026-11-01T09:00:00Z", "10.5555/somniq.r0.c3a"],
    ["m-actually-newest.pdf", "2026-11-20T09:00:00Z", "10.5555/somniq.r0.c3b"],
    ["z-middle.pdf", "2026-11-10T09:00:00Z", "10.5555/somniq.r0.c3c"],
  ];
  for (const [name, mtime, doi] of pdfSpecs) {
    const file = path.join(pdfs, name);
    fs.writeFileSync(file, makePdf({ title: `C3 fixture ${name}`, doi, pages: 1 }));
    const time = new Date(mtime);
    fs.utimesSync(file, time, time);
  }

  const docx = path.join(review, `manuscript-review-${runId}.docx`);
  fs.writeFileSync(docx, makeReviewDocx());

  const manifest = {
    runId,
    runDir,
    createdAt: new Date().toISOString(),
    markers: MARKERS,
    paths: { work, notes, draft, pdfs, review, docx, explorer, out: path.join(runDir, "out") },
    expected: {
      C2: { path: path.join(runDir, "out", "c2-saved.txt"), text: `SomniQ R0 C2 ${runId}` },
      C3: { dir: pdfs, newest: "m-actually-newest.pdf", renameTo: "newest-paper.pdf" },
      C4: { docx, mustMention: [MARKERS.comment, MARKERS.insert, MARKERS.delete] },
      R3_MKDIR: { parent: explorer, name: `R0-folder-${runId}` },
    },
    startTree: null,
  };
  manifest.startTree = snapshotTree(work);
  const manifestPath = path.join(runDir, "manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, manifestPath };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = name => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  const { manifestPath, manifest } = setupDesktopFixture({ runId: arg("--run-id"), root: arg("--root") });
  process.stdout.write(`${JSON.stringify({ manifest: manifestPath, runDir: manifest.runDir })}\n`);
}
