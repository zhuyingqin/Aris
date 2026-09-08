const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { bundleTargets } = require("../bundle-targets.cjs");
const { prepareResources } = require("../prepare-resources.cjs");

test("universal bundles both architectures even on an arm64 host", () => {
  assert.deepEqual(bundleTargets("darwin", "arm64", "universal-apple-darwin"),
    ["darwin-arm64", "darwin-x64"]);
  assert.deepEqual(bundleTargets("darwin", "arm64", "x86_64-apple-darwin"), ["darwin-x64"]);
  assert.deepEqual(bundleTargets("win32", "x64", ""), ["win32-x64"]);
  assert.throws(() => bundleTargets("darwin", "arm64", "x86_64-pc-windows-msvc"));
  assert.throws(() => bundleTargets("darwin", "arm64", "unknown"));
});

test("retired Tectonic payload is removed without touching MCP launchers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "somniq-resource-cleanup-"));
  try {
    fs.mkdirSync(path.join(root, "bin"));
    for (const name of ["tectonic", "tectonic.exe", "TECTONIC_VERSION", "aris-playwright-mcp"]) {
      fs.writeFileSync(path.join(root, "bin", name), "fixture");
    }
    prepareResources(root);
    assert.deepEqual(fs.readdirSync(path.join(root, "bin")), ["aris-playwright-mcp"]);
    prepareResources(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
