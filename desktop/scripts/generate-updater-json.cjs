const fs = require("node:fs");
const path = require("node:path");

const desktopRoot = path.resolve(__dirname, "..");
const packageJson = require(path.join(desktopRoot, "package.json"));

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

function firstPositional() {
  return process.argv.slice(2).find((arg, index, args) => {
    if (arg.startsWith("-")) return false;
    return index === 0 || !args[index - 1].startsWith("-");
  });
}

function encodeReleaseAssetName(name) {
  return encodeURIComponent(name).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function githubReleaseAssetName(name) {
  return name.replace(/\s+/g, ".");
}

const bundleDir = path.resolve(
  desktopRoot,
  argValue(
    "--bundle-dir",
    firstPositional() || path.join("src-tauri", "target", "release", "bundle", "nsis"),
  ),
);
const outputPath = path.resolve(bundleDir, argValue("--out", "latest.json"));
const platform = argValue("--platform", "windows");
const version = argValue("--version", packageJson.version);
const repository = process.env.GITHUB_REPOSITORY || "zhuyingqin/Aris";
const tag = process.env.GITHUB_REF_NAME || `v${version}`;
const releaseBaseUrl =
  process.env.ARIS_UPDATE_BASE_URL || `https://github.com/${repository}/releases/download/${tag}`;
const requestedPubDate =
  argValue("--pub-date", process.env.ARIS_RELEASE_TIMESTAMP) || new Date().toISOString();
const parsedPubDate = Date.parse(requestedPubDate);

if (!Number.isFinite(parsedPubDate)) {
  throw new Error(`Invalid updater publish timestamp: ${requestedPubDate}`);
}

const pubDate = new Date(parsedPubDate).toISOString();

if (!fs.existsSync(bundleDir)) {
  throw new Error(`Bundle directory does not exist: ${bundleDir}`);
}

const files = fs.readdirSync(bundleDir);
const updaterBundleName =
  platform === "windows"
    ? files.find((name) => name === `SomniQ Studio_${version}_x64-setup.exe`) ||
      files.find((name) => name === `ARIS Studio_${version}_x64-setup.exe`) ||
      files.find((name) => name.endsWith("_x64-setup.exe"))
    : platform === "macos"
      ? files.find((name) => name.endsWith(".app.tar.gz"))
      : null;

if (!updaterBundleName) {
  throw new Error(`Could not find a ${platform} updater bundle in ${bundleDir}`);
}

const signaturePath = path.join(bundleDir, `${updaterBundleName}.sig`);
if (!fs.existsSync(signaturePath)) {
  throw new Error(`Missing updater signature: ${signaturePath}`);
}

const signature = fs.readFileSync(signaturePath, "utf8").trim();
const updaterAssetName =
  argValue("--asset-name", process.env.ARIS_UPDATE_ASSET_NAME) ||
  githubReleaseAssetName(updaterBundleName);
const updaterUrl = `${releaseBaseUrl.replace(/\/+$/, "")}/${encodeReleaseAssetName(updaterAssetName)}`;
const notes = process.env.RELEASE_NOTES || `SomniQ Studio ${version}`;

const updaterEntry = {
  signature,
  url: updaterUrl,
};

const platforms =
  platform === "windows"
    ? {
        "windows-x86_64": updaterEntry,
        "windows-x86_64-msvc": updaterEntry,
      }
    : platform === "macos"
      ? {
          // The universal bundle works on both CPU architectures. The `-app`
          // variants are requested by macOS app bundles before the standard
          // Tauri updater target is tried.
          "darwin-aarch64-app": updaterEntry,
          "darwin-aarch64": updaterEntry,
          "darwin-x86_64-app": updaterEntry,
          "darwin-x86_64": updaterEntry,
        }
      : (() => {
          throw new Error(`Unsupported updater platform: ${platform}`);
        })();

const manifest = {
  version,
  notes,
  pub_date: pubDate,
  platforms,
};

fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Wrote updater manifest: ${outputPath}`);
