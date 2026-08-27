const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

/**
 * Vendor the VSCodium `reh-web` runtime into the app's resources for the
 * Windows installer.
 *
 * The generated archive is intentionally ignored by Git: it is a build input,
 * not source. The Windows release runs this before `tauri build`, so end users
 * get the editor runtime in the signed installer and never need a first-use
 * network fetch. Development builds on non-Windows hosts skip this resource.
 *
 * The runtime is stored as a *plain* tar. VSCodium publishes a gzip tarball,
 * but the installer compresses its payload with LZMA anyway: re-compressing an
 * already-gzipped file gains nothing, while the same bytes as a plain tar
 * compress from 336 MB to ~56 MB.
 *
 * Version and checksum are pinned, and `codeserver.rs` holds the same two
 * values; `pinned_runtime_matches_the_offline_build_script` in its test module
 * fails if these drift apart.
 */
const RUNTIME_VERSION = "1.126.04524";
const SLUG = "win32-x64";
const SHA256 = "43f15c8e5c95b795d6eb72a62095498d901ee633938cb3f8297256192062b333";

const ASSET = `vscodium-reh-web-${SLUG}-${RUNTIME_VERSION}.tar.gz`;
const DOWNLOAD_URLS = [
  `https://somni.chat/runtime/vscodium/${RUNTIME_VERSION}/${ASSET}`,
  `https://github.com/VSCodium/vscodium/releases/download/${RUNTIME_VERSION}/${ASSET}`,
];

const desktopRoot = path.resolve(__dirname, "..");
const resourcesRoot = path.join(desktopRoot, "src-tauri", "resources");
const targetDir = path.join(resourcesRoot, "code", RUNTIME_VERSION);
const target = path.join(targetDir, `vscodium-reh-web-${SLUG}-${RUNTIME_VERSION}.tar`);

function assertInside(parent, child) {
  const rel = path.relative(parent, child);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Refusing to write outside ${parent}: ${child}`);
  }
}

assertInside(resourcesRoot, target);

// Windows-only runtime: VSCodium publishes no `reh-web` build for other hosts
// (checked against their releases, see docs/development-logic/vscode-code-tab.md).
if (process.platform !== "win32") {
  console.log(`Skipping VSCodium bundle on ${process.platform} (Windows-only resource).`);
  process.exit(0);
}

if (fs.existsSync(target)) {
  const sizeMb = (fs.statSync(target).size / (1024 * 1024)).toFixed(1);
  console.log(`VSCodium ${RUNTIME_VERSION} already vendored at ${target} (${sizeMb} MB)`);
  process.exit(0);
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  // The mirror is served by a site that answers unknown paths with its SPA
  // shell at HTTP 200, so a "successful" response proves nothing until the
  // checksum is in. Verify per source, then fall through to the next one.
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  if (digest !== SHA256) {
    throw new Error(`${url} -> sha256 ${digest}, expected ${SHA256}`);
  }
  fs.writeFileSync(destination, bytes);
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aris-vscodium-"));
  const archive = path.join(tmpDir, ASSET);
  try {
    let lastError = null;
    for (const url of DOWNLOAD_URLS) {
      try {
        console.log(`Downloading ${url}`);
        await download(url, archive);
        lastError = null;
        break;
      } catch (error) {
        console.warn(`  ${error.message}`);
        lastError = error;
      }
    }
    if (lastError) throw lastError;

    console.log("Decompressing to a plain tar (the installer's LZMA does the rest)");
    const staged = `${archive}.tar`;
    fs.writeFileSync(staged, zlib.gunzipSync(fs.readFileSync(archive)));

    fs.mkdirSync(targetDir, { recursive: true });
    fs.copyFileSync(staged, target);

    const sizeMb = (fs.statSync(target).size / (1024 * 1024)).toFixed(1);
    console.log(`Vendored VSCodium ${RUNTIME_VERSION} -> ${target} (${sizeMb} MB)`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
