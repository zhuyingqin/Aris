// SVG-Edit is pinned in package-lock.json and served entirely from local files.
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const source = path.join(root, "node_modules/svgedit/dist/editor");
const output = path.join(root, "public/figure-editor");
fs.mkdirSync(output, { recursive: true });
fs.cpSync(source, output, {
  recursive: true,
  filter: (file) => !file.includes(`${path.sep}tests`) && !file.endsWith(".map") && !file.endsWith(".html"),
});
for (const file of ["index.html", "bridge.js", "NOTICE.md"]) {
  fs.copyFileSync(path.join(root, "figure-editor", file), path.join(output, file));
}
fs.copyFileSync(path.join(root, "node_modules/svgedit/LICENSE-MIT.txt"), path.join(output, "LICENSE-MIT.txt"));
fs.copyFileSync(path.join(root, "node_modules/svgedit/licenseInfo.json"), path.join(output, "licenseInfo.json"));
fs.cpSync(path.join(root, "figure-editor/licenses"), path.join(output, "licenses"), { recursive: true });
// Tauri's asset resolver reads frontendDist during dev. Keep this narrow local
// editor protocol usable before a full Vite build as well.
fs.cpSync(output, path.join(root, "dist/figure-editor"), { recursive: true });
