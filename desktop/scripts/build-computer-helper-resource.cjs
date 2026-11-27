// Builds the read-only computer-use helper (crates/computer, bin
// `somniq-computer`) and places it in src-tauri/resources/bin, which the
// bundle ships and `computer_tools::helper_path` finds through
// ARIS_RESOURCE_DIR. Windows only: elsewhere the helper is a stub, so any
// stale copy is removed and nothing is built.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const desktopRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const binRoot = path.join(desktopRoot, "src-tauri", "resources", "bin");
const target = path.join(binRoot, "somniq-computer.exe");

function main() {
  if (process.platform !== "win32") {
    fs.rmSync(target, { force: true });
    console.log("computer helper: skipped (Windows only)");
    return;
  }
  const result = spawnSync(
    "cargo",
    ["build", "--release", "-p", "computer", "--bin", "somniq-computer", "--manifest-path", path.join(repoRoot, "Cargo.toml")],
    { cwd: repoRoot, stdio: "inherit", shell: false },
  );
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
  const targetDir = process.env.CARGO_TARGET_DIR
    ? path.resolve(repoRoot, process.env.CARGO_TARGET_DIR)
    : path.join(repoRoot, "target");
  const built = path.join(targetDir, "release", "somniq-computer.exe");
  if (!fs.existsSync(built)) {
    console.error(`computer helper: build finished but ${built} is missing`);
    process.exit(1);
  }
  fs.mkdirSync(binRoot, { recursive: true });
  fs.copyFileSync(built, target);
  console.log(`computer helper: ${path.relative(desktopRoot, target)}`);
}

main();
