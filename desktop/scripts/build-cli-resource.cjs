const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const desktopRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const exeName = process.platform === "win32" ? "aris.exe" : "aris";

const cargo = spawnSync(
  "cargo",
  [
    "build",
    "--release",
    "--manifest-path",
    path.join(repoRoot, "Cargo.toml"),
    "-p",
    "aris-cli",
    "--bin",
    "aris",
  ],
  { cwd: repoRoot, stdio: "inherit" },
);

if (cargo.status !== 0) {
  process.exit(cargo.status ?? 1);
}

const source = path.join(repoRoot, "target", "release", exeName);
const target = path.join(desktopRoot, "src-tauri", "resources", "bin", exeName);
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.copyFileSync(source, target);
console.log(`Copied ${source} -> ${target}`);
