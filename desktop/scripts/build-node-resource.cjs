const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { bundleTargets } = require("./bundle-targets.cjs");

// Official standalone binaries: a Homebrew node can depend on libraries that
// do not exist on the user's Mac. These hashes are from Node's release manifest.
const VERSION = "22.22.0";
const CHECKSUMS = {
  "darwin-arm64": "5ed4db0fcf1eaf84d91ad12462631d73bf4576c1377e192d222e48026a902640",
  "darwin-x64": "5ea50c9d6dea3dfa3abb66b2656f7a4e1c8cef23432b558d45fb538c7b5dedce",
};

async function vendorNode(nodeRoot) {
  const targets = bundleTargets();
  fs.mkdirSync(nodeRoot, { recursive: true });
  if (process.platform !== "darwin") {
    if (!targets.includes(`${process.platform}-${process.arch}`)) {
      throw new Error("Node resource must match the build host architecture");
    }
    const target = path.join(nodeRoot, process.platform === "win32" ? "node.exe" : "node");
    fs.copyFileSync(process.execPath, target);
    if (process.platform !== "win32") fs.chmodSync(target, 0o755);
    fs.writeFileSync(path.join(nodeRoot, "NODE_VERSION"), `${process.version}\n`);
    return;
  }
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "somniq-node-"));
  try {
    const binaries = [];
    for (const slug of targets) {
      const name = `node-v${VERSION}-${slug}`;
      const response = await fetch(`https://nodejs.org/dist/v${VERSION}/${name}.tar.gz`);
      if (!response.ok) throw new Error(`Node ${slug}: HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (crypto.createHash("sha256").update(bytes).digest("hex") !== CHECKSUMS[slug]) {
        throw new Error(`Node ${slug}: SHA-256 mismatch`);
      }
      const archive = path.join(staging, `${name}.tar.gz`);
      fs.writeFileSync(archive, bytes);
      execFileSync("/usr/bin/tar", ["-xzf", archive, "-C", staging, `${name}/bin/node`, `${name}/LICENSE`]);
      binaries.push(path.join(staging, name, "bin/node"));
      fs.copyFileSync(path.join(staging, name, "LICENSE"), path.join(nodeRoot, "LICENSE"));
    }
    const target = path.join(nodeRoot, "node");
    if (binaries.length === 2) {
      execFileSync("/usr/bin/lipo", ["-create", ...binaries, "-output", target]);
    } else {
      fs.copyFileSync(binaries[0], target);
    }
    fs.chmodSync(target, 0o755);
    // Combining Mach-O slices invalidates their original signatures. Apply an
    // ad-hoc signature for local execution; distribution signing runs later.
    execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", target]);
    execFileSync("/usr/bin/lipo", [target, "-verify_arch", ...targets.map((slug) =>
      slug === "darwin-arm64" ? "arm64" : "x86_64")]);
    fs.writeFileSync(path.join(nodeRoot, "NODE_VERSION"), `v${VERSION}\n`);
    console.log(`Vendored standalone Node ${VERSION}: ${targets.join(", ")}`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
module.exports = { vendorNode };
