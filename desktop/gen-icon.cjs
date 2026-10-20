// Keep native application icons aligned with the SomniQ logo used in the UI.
// Run `npm run generate:icons` to regenerate the complete Tauri icon set.
const fs = require("node:fs");
const path = require("node:path");

const source = path.join(__dirname, "src", "assets", "app-logo.png");
const output = path.join(__dirname, "src-tauri", "icon-src.png");
const png = fs.readFileSync(source);
const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
if (png.length < 24 || !png.subarray(0, 8).equals(signature)
    || png.readUInt32BE(16) !== png.readUInt32BE(20)) {
  throw new Error("SomniQ app-logo.png must be a square PNG.");
}
fs.writeFileSync(output, png);
console.log("SomniQ icon source:", output);
