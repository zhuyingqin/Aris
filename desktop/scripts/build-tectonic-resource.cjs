const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Pinned Tectonic release. Bump this to upgrade the bundled LaTeX engine.
const TECTONIC_VERSION = "0.16.9";
const ASSET = `tectonic-${TECTONIC_VERSION}-x86_64-pc-windows-msvc.zip`;
const DOWNLOAD_URL = `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/${ASSET}`;

const desktopRoot = path.resolve(__dirname, "..");
const resourcesRoot = path.join(desktopRoot, "src-tauri", "resources");
const binRoot = path.join(resourcesRoot, "bin");
const exeTarget = path.join(binRoot, "tectonic.exe");
const versionMarker = path.join(binRoot, "TECTONIC_VERSION");

function assertInside(parent, child) {
  const rel = path.relative(parent, child);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Refusing to write outside ${parent}: ${child}`);
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: desktopRoot, stdio: "inherit" });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

assertInside(resourcesRoot, exeTarget);

// Windows-only engine. On other build hosts, skip silently so the desktop
// build still succeeds (the LaTeX feature is gated to Windows anyway).
if (process.platform !== "win32") {
  console.log(`Skipping Tectonic bundle on ${process.platform} (Windows-only resource).`);
  process.exit(0);
}

// Idempotent: skip the download when the pinned version is already vendored.
if (fs.existsSync(exeTarget) && fs.existsSync(versionMarker)) {
  const have = fs.readFileSync(versionMarker, "utf8").trim();
  if (have === TECTONIC_VERSION) {
    console.log(`Tectonic ${TECTONIC_VERSION} already vendored at ${exeTarget}`);
    process.exit(0);
  }
}

fs.mkdirSync(binRoot, { recursive: true });

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aris-tectonic-"));
const zipPath = path.join(tmpDir, ASSET);

console.log(`Downloading ${DOWNLOAD_URL}`);
// curl.exe ships with Windows 10+; -L follows GitHub's redirect to the CDN.
run("curl", ["-fSL", "--retry", "3", "-o", zipPath, DOWNLOAD_URL]);

console.log(`Extracting ${ASSET}`);
// Expand-Archive ships with Windows PowerShell; extracts the single tectonic.exe.
run("powershell", [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${tmpDir}' -Force`,
]);

const extracted = path.join(tmpDir, "tectonic.exe");
if (!fs.existsSync(extracted)) {
  throw new Error(`tectonic.exe not found after extracting ${ASSET}`);
}

fs.rmSync(exeTarget, { force: true });
fs.copyFileSync(extracted, exeTarget);
fs.writeFileSync(versionMarker, `${TECTONIC_VERSION}\n`);
fs.rmSync(tmpDir, { recursive: true, force: true });

const sizeMb = (fs.statSync(exeTarget).size / (1024 * 1024)).toFixed(1);
console.log(`Vendored Tectonic ${TECTONIC_VERSION} -> ${exeTarget} (${sizeMb} MB)`);
