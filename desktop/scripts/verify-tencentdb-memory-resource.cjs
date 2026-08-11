const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const desktopDir = path.resolve(__dirname, "..");
const manifestDir = path.join(desktopDir, "resources", "tencentdb-memory");
const resourcesDir = path.join(desktopDir, "src-tauri", "resources");
const coreDir = path.join(resourcesDir, "memory", "tencentdb");
const nodePath = path.join(resourcesDir, "node", "node.exe");

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function required(file) {
  if (!fs.existsSync(file)) throw new Error(`Required release resource is missing: ${file}`);
}

function main() {
  const lock = JSON.parse(fs.readFileSync(path.join(manifestDir, "source.lock.json"), "utf8"));
  const requiredRelative = [
    "BUILD_INFO.json",
    "LICENSE",
    "SBOM.cdx.json",
    "THIRD_PARTY_NOTICES",
    "VERSION",
    "dist/server.js",
    "package.json",
    "package-lock.json",
    "src/gateway/server.ts",
  ];
  required(nodePath);
  for (const relative of requiredRelative) required(path.join(coreDir, relative));

  const buildInfo = JSON.parse(fs.readFileSync(path.join(coreDir, "BUILD_INFO.json"), "utf8"));
  if (buildInfo.sourceTag !== lock.tag || buildInfo.sourceCommit !== lock.commit) {
    throw new Error("BUILD_INFO does not match the pinned TencentDB source lock");
  }
  if (buildInfo.nodeVersion !== lock.nodeVersion) {
    throw new Error("BUILD_INFO does not match the pinned Node runtime");
  }
  const version = fs.readFileSync(path.join(coreDir, "VERSION"), "utf8").trim().split(/\r?\n/);
  if (version[0] !== lock.tag || version[1] !== lock.commit) {
    throw new Error("VERSION does not match the pinned TencentDB tag and commit");
  }
  const entrypoint = path.join(coreDir, buildInfo.entrypoint);
  if (sha256(entrypoint) !== buildInfo.entrypointSha256) {
    throw new Error("Precompiled Memory Core entrypoint SHA-256 mismatch");
  }
  if (sha256(path.join(coreDir, "package-lock.json")) !== buildInfo.packageLockSha256) {
    throw new Error("Bundled Memory Core package-lock SHA-256 mismatch");
  }
  if (
    sha256(path.join(coreDir, "package-lock.json"))
    !== sha256(path.join(manifestDir, "package-lock.json"))
  ) {
    throw new Error("Bundled package-lock differs from SomniQ's committed lock file");
  }

  const nodeVersion = spawnSync(nodePath, ["--version"], { encoding: "utf8", windowsHide: true });
  if (nodeVersion.status !== 0 || nodeVersion.stdout.trim() !== `v${lock.nodeVersion}`) {
    throw new Error(`Bundled Node version mismatch: ${nodeVersion.stdout || nodeVersion.stderr}`);
  }
  const sbom = JSON.parse(fs.readFileSync(path.join(coreDir, "SBOM.cdx.json"), "utf8"));
  if (sbom.bomFormat !== "CycloneDX" || !Array.isArray(sbom.components) || sbom.components.length === 0) {
    throw new Error("Memory Core CycloneDX SBOM is empty or invalid");
  }
  const notices = fs.readFileSync(path.join(coreDir, "THIRD_PARTY_NOTICES"), "utf8");
  if (!notices.includes("TencentDB Agent Memory") || notices.length < 1000) {
    throw new Error("Memory Core third-party notices are incomplete");
  }
  process.stdout.write(
    `TencentDB Memory release resources verified: ${lock.tag} ${lock.commit.slice(0, 8)}, Node ${lock.nodeVersion}, ${sbom.components.length} SBOM components\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
}
