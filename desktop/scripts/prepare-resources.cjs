const fs = require("node:fs");
const path = require("node:path");

// Older build trees may still contain the retired bundled compiler. Tauri's
// resource glob would otherwise silently keep shipping it on either platform.
function prepareResources(root) {
  for (const name of ["tectonic", "tectonic.exe", "TECTONIC_VERSION"]) {
    fs.rmSync(path.join(root, "bin", name), { force: true });
  }
}
if (require.main === module) {
  prepareResources(path.resolve(__dirname, "../src-tauri/resources"));
}
module.exports = { prepareResources };
