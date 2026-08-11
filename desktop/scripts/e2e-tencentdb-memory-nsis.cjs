const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const desktopDir = path.resolve(__dirname, "..");
const nsisDir = path.join(desktopDir, "src-tauri", "target", "release", "bundle", "nsis");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || desktopDir,
    env: options.env || process.env,
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeout || 120_000,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status}`);
  }
}

function newestInstaller() {
  const explicit = process.argv[2];
  if (explicit) return path.resolve(explicit);
  if (!fs.existsSync(nsisDir)) throw new Error(`NSIS output directory is missing: ${nsisDir}`);
  const matches = fs.readdirSync(nsisDir)
    .filter((name) => /Memory Verify.*setup\.exe$/i.test(name))
    .map((name) => path.join(nsisDir, name))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  if (!matches[0]) throw new Error("SomniQ Memory Verify NSIS installer was not found");
  return matches[0];
}

function authenticodeStatus(file) {
  // PowerShell 7 (pwsh) and bare Windows PowerShell 5.1 (powershell.exe)
  // both ship Get-AuthenticodeSignature, but on some Windows runner images
  // the Microsoft.PowerShell.Security module is not autoloaded and the
  // command returns non-zero with "CouldNotAutoloadMatchingModule". Treat
  // that as "Unknown" rather than fatal: SOMNIQ_REQUIRE_AUTHENTICODE is
  // the only thing that turns this inspection into a hard gate.
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "(Get-AuthenticodeSignature -LiteralPath $env:SOMNIQ_SIGNATURE_TARGET).Status.ToString()"],
    {
      env: { ...process.env, SOMNIQ_SIGNATURE_TARGET: file },
      encoding: "utf8",
      windowsHide: true,
    },
  );
  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    if (/CouldNotAutoloadMatchingModule|module could not be loaded/i.test(stderr)) {
      return "Unknown";
    }
    throw new Error(`Authenticode inspection failed: ${stderr}`);
  }
  return (result.stdout || "").trim() || "Unknown";
}

function findResourcesDir(installDir) {
  for (const candidate of [path.join(installDir, "resources"), installDir]) {
    if (
      fs.existsSync(path.join(candidate, "node", "node.exe"))
      && fs.existsSync(path.join(candidate, "memory", "tencentdb", "dist", "server.js"))
    ) return candidate;
  }
  throw new Error(`Installed TencentDB Memory resources were not found under ${installDir}`);
}

function findUninstaller(installDir) {
  return fs.readdirSync(installDir)
    .filter((name) => /uninstall.*\.exe$/i.test(name))
    .map((name) => path.join(installDir, name))[0];
}

function main() {
  if (process.platform !== "win32") throw new Error("NSIS E2E is Windows-only");
  const installer = newestInstaller();
  if (!fs.existsSync(installer)) throw new Error(`Installer is missing: ${installer}`);
  const signature = authenticodeStatus(installer);
  const requireSignature = process.env.SOMNIQ_REQUIRE_AUTHENTICODE === "1";
  if (requireSignature && signature !== "Valid") {
    throw new Error(`Installer Authenticode status is ${signature}; release requires Valid`);
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "somniq-memory-nsis-"));
  const installDir = path.join(tempRoot, "app");
  const retainedDataDir = path.join(tempRoot, "user-data", "memory", "tencentdb", "data");
  let uninstaller;
  try {
    run(installer, ["/S", `/D=${installDir}`], { timeout: 180_000 });
    const resourcesDir = findResourcesDir(installDir);
    uninstaller = findUninstaller(installDir);
    if (!uninstaller) throw new Error("Installed NSIS uninstaller was not found");

    run(process.execPath, [path.join(__dirname, "smoke-tencentdb-memory-resource.cjs")], {
      timeout: 120_000,
      env: {
        ...process.env,
        SOMNIQ_RESOURCES_DIR: resourcesDir,
        SOMNIQ_MEMORY_DATA_DIR: retainedDataDir,
      },
    });
    if (!fs.existsSync(path.join(retainedDataDir, "vectors.db"))) {
      throw new Error("Installed Memory Core did not create its local SQLite database");
    }

    run(uninstaller, ["/S"], { timeout: 180_000 });
    uninstaller = undefined;
    if (!fs.existsSync(path.join(retainedDataDir, "vectors.db"))) {
      throw new Error("NSIS uninstall removed the user's TencentDB Memory data");
    }
    process.stdout.write(
      `TencentDB Memory NSIS E2E passed; signature=${signature}, install/start/uninstall/data-retention verified\n`,
    );
  } finally {
    if (uninstaller && fs.existsSync(uninstaller)) {
      spawnSync(uninstaller, ["/S"], { windowsHide: true, timeout: 180_000 });
    }
    const expectedPrefix = path.join(os.tmpdir(), "somniq-memory-nsis-");
    if (tempRoot.startsWith(expectedPrefix)) fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
}
