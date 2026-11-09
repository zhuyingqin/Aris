// PDF.js needs Adobe CMaps even for embedded CID fonts (for example XeLaTeX
// Chinese slides). Ship the matching package's maps locally for offline use.
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "node_modules/pdfjs-dist/cmaps");
const output = path.join(root, "public/pdfjs/cmaps");

fs.mkdirSync(output, { recursive: true });
fs.cpSync(source, output, { recursive: true });
