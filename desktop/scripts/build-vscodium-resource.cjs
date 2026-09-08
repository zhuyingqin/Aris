const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const { bundleTargets } = require("./bundle-targets.cjs");

// Official reh-web archives, verified against the release's SHA-256 sidecars.
const RUNTIME_VERSION = "1.126.04524";
const CHECKSUMS = {
  "win32-x64": "43f15c8e5c95b795d6eb72a62095498d901ee633938cb3f8297256192062b333",
  "darwin-x64": "c3cbece13b47c748be8ac64c773471a20fcb809ae8de0188abcd949cb0ef49c4",
  "darwin-arm64": "bd587280e1d29113ff73f67438571853536b88f6af5bc58e59a16010ce1c9734",
  "linux-x64": "9964a8b66431dced583a820d60a852a7995c86607c4c983152adc7a5c876d60d",
  "linux-arm64": "c6181d32dda122df3bba7ad6e9194ded2dc3dd1204c1f8b142f4440f4e4e2ce4",
};

const desktopRoot = path.resolve(__dirname, "..");
const resourcesRoot = path.join(desktopRoot, "src-tauri", "resources");
const targetDir = path.join(resourcesRoot, "code", RUNTIME_VERSION);


function assertInside(parent, child) {
  const rel = path.relative(parent, child);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Refusing to write outside ${parent}: ${child}`);
  }
}

async function download(url, destination, expected) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  // The mirror is served by a site that answers unknown paths with its SPA
  // shell at HTTP 200, so a "successful" response proves nothing until the
  // checksum is in. Verify per source, then fall through to the next one.
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  if (digest !== expected) {
    throw new Error(`${url} -> sha256 ${digest}, expected ${expected}`);
  }
  fs.writeFileSync(destination, bytes);
}

async function vendor(slug) {
  const asset = `vscodium-reh-web-${slug}-${RUNTIME_VERSION}.tar.gz`;
  const target = path.join(targetDir, asset.replace(/\.gz$/, ""));
  assertInside(resourcesRoot, target);
  const expected = CHECKSUMS[slug];
  if (!expected) throw new Error(`No pinned checksum for ${slug}`);
  const marker = `${target}.sha256`;
  if (fs.existsSync(target) && fs.existsSync(marker)) {
    const digest = crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
    if (fs.readFileSync(marker, "utf8").trim() === `${expected} ${digest}`) {
      console.log(`Verified cached VSCodium ${slug}`);
      return;
    }
  }
  const urls = [
    `https://somni.chat/runtime/vscodium/${RUNTIME_VERSION}/${asset}`,
    `https://github.com/VSCodium/vscodium/releases/download/${RUNTIME_VERSION}/${asset}`,
  ];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aris-vscodium-"));
  const archive = path.join(tmpDir, asset);
  try {
    let lastError = null;
    for (const url of urls) {
      try {
        console.log(`Downloading ${url}`);
        await download(url, archive, expected);
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
    fs.copyFileSync(staged, `${target}.staging`);
    fs.renameSync(`${target}.staging`, target);
    const digest = crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
    fs.writeFileSync(marker, `${expected} ${digest}\n`);

    const sizeMb = (fs.statSync(target).size / (1024 * 1024)).toFixed(1);
    console.log(`Vendored VSCodium ${RUNTIME_VERSION} -> ${target} (${sizeMb} MB)`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  const slugs = bundleTargets();
  // Avoid including stale resources for another OS or architecture.
  if (fs.existsSync(targetDir)) {
    for (const name of fs.readdirSync(targetDir)) {
      if (name.startsWith("vscodium-reh-web-") && !slugs.some((slug) =>
        name.startsWith(`vscodium-reh-web-${slug}-${RUNTIME_VERSION}.tar`))) {
        fs.rmSync(path.join(targetDir, name), { force: true });
      }
    }
  }
  for (const slug of slugs) await vendor(slug);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
