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

const bundleDir = path.resolve(
  desktopRoot,
  argValue(
    "--bundle-dir",
    firstPositional() || path.join("src-tauri", "target", "release", "bundle", "nsis"),
  ),
);
const outputPath = path.resolve(bundleDir, argValue("--out", "latest.json"));
const version = argValue("--version", packageJson.version);
const repository = process.env.GITHUB_REPOSITORY || "zhuyingqin/Aris";
const tag = process.env.GITHUB_REF_NAME || `v${version}`;
const releaseBaseUrl =
  process.env.ARIS_UPDATE_BASE_URL || `https://github.com/${repository}/releases/download/${tag}`;

if (!fs.existsSync(bundleDir)) {
  throw new Error(`Bundle directory does not exist: ${bundleDir}`);
}

const files = fs.readdirSync(bundleDir);
const installerName =
  files.find((name) => name === `ARIS Studio_${version}_x64-setup.exe`) ||
  files.find((name) => name.endsWith("_x64-setup.exe"));

if (!installerName) {
  throw new Error(`Could not find ARIS Studio NSIS installer in ${bundleDir}`);
}

const signaturePath = path.join(bundleDir, `${installerName}.sig`);
if (!fs.existsSync(signaturePath)) {
  throw new Error(`Missing updater signature: ${signaturePath}`);
}

const signature = fs.readFileSync(signaturePath, "utf8").trim();
const installerUrl = `${releaseBaseUrl.replace(/\/+$/, "")}/${encodeReleaseAssetName(installerName)}`;
const notes = process.env.RELEASE_NOTES || `ARIS Studio ${version}`;

const windowsEntry = {
  signature,
  url: installerUrl,
};

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": windowsEntry,
    "windows-x86_64-msvc": windowsEntry,
  },
};

fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Wrote updater manifest: ${outputPath}`);
