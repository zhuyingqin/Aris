const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const desktopRoot = path.resolve(__dirname, "..");
const manifestRoot = path.join(desktopRoot, "resources", "tencentdb-memory");
const resourcesRoot = path.join(desktopRoot, "src-tauri", "resources");
const targetRoot = path.join(resourcesRoot, "memory", "tencentdb");
const nodeRoot = path.join(resourcesRoot, "node");
const lock = JSON.parse(fs.readFileSync(path.join(manifestRoot, "source.lock.json"), "utf8"));

function assertInside(parent, child) {
  const rel = path.relative(parent, child);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Refusing to write outside ${parent}: ${child}`);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? desktopRoot,
    stdio: options.capture ? "pipe" : "inherit",
    shell: process.platform === "win32" && (command === "npm" || command.toLowerCase().endsWith(".cmd")),
    encoding: options.capture ? "utf8" : undefined,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status}${result.stderr ? `: ${result.stderr}` : ""}`);
  }
  return result.stdout ?? "";
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destination, bytes);
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function verify(file, expected, label) {
  const actual = sha256(file);
  if (actual !== expected) throw new Error(`${label} SHA-256 mismatch: expected ${expected}, got ${actual}`);
}

function copyTree(source, destination) {
  fs.cpSync(source, destination, { recursive: true, force: true });
}

function packageInventory(nodeModules) {
  const packages = [];
  const visit = (directory) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === ".bin") continue;
      const item = path.join(directory, entry.name);
      if (entry.name.startsWith("@")) {
        visit(item);
        continue;
      }
      const packageFile = path.join(item, "package.json");
      if (!fs.existsSync(packageFile)) continue;
      try {
        const pkg = JSON.parse(fs.readFileSync(packageFile, "utf8"));
        packages.push({
          name: pkg.name ?? entry.name,
          version: pkg.version ?? "unknown",
          license: typeof pkg.license === "string" ? pkg.license : "UNKNOWN",
        });
      } catch {
        // A malformed transitive package is still caught by npm ci itself.
      }
    }
  };
  visit(nodeModules);
  packages.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
  return packages;
}

async function main() {
  if (process.platform !== "win32") {
    console.log("Skipping TencentDB Memory Core resource: the first release supports Windows x64 only");
    return;
  }
  if (process.arch !== "x64") {
    throw new Error("TencentDB Memory Core is currently packaged only for Windows x64");
  }
  assertInside(resourcesRoot, targetRoot);
  assertInside(resourcesRoot, nodeRoot);
  if (process.argv.includes("--clean")) {
    fs.rmSync(targetRoot, { recursive: true, force: true });
    console.log(`Removed generated TencentDB Memory resource: ${targetRoot}`);
    return;
  }
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "somniq-memory-build-"));
  try {
    const nodeArchive = path.join(tempRoot, "node.zip");
    await download(lock.nodeWindowsX64Url, nodeArchive);
    verify(nodeArchive, lock.nodeWindowsX64Sha256, "Node.js runtime");
    const extractedNode = path.join(tempRoot, "node");
    fs.mkdirSync(extractedNode, { recursive: true });
    run("tar", ["-xf", nodeArchive, "-C", extractedNode]);
    const pinnedNodeRoot = path.join(extractedNode, `node-v${lock.nodeVersion}-win-x64`);
    const nodeExe = path.join(pinnedNodeRoot, "node.exe");
    const pinnedNpm = path.join(pinnedNodeRoot, "npm.cmd");
    if (!fs.existsSync(nodeExe) || !fs.existsSync(pinnedNpm)) {
      throw new Error("Pinned Node archive does not contain node.exe and npm.cmd");
    }
    fs.mkdirSync(nodeRoot, { recursive: true });
    fs.copyFileSync(nodeExe, path.join(nodeRoot, "node.exe"));
    fs.writeFileSync(path.join(nodeRoot, "NODE_VERSION"), `v${lock.nodeVersion}\n`);

    const sourceArchive = path.join(tempRoot, "source.tar.gz");
    await download(lock.archiveUrl, sourceArchive);
    verify(sourceArchive, lock.archiveSha256, "TencentDB Agent Memory source");
    const extracted = path.join(tempRoot, "source");
    fs.mkdirSync(extracted, { recursive: true });
    run("tar", ["-xzf", sourceArchive, "-C", extracted]);
    const repositoryRoot = fs.readdirSync(extracted, { withFileTypes: true })
      .find((entry) => entry.isDirectory());
    if (!repositoryRoot) throw new Error("TencentDB source archive has no root directory");
    const memoryCore = path.join(extracted, repositoryRoot.name, "MemoryCore");
    if (!fs.existsSync(path.join(memoryCore, "src", "gateway", "server.ts"))) {
      throw new Error("Pinned archive does not contain MemoryCore gateway");
    }

    fs.rmSync(targetRoot, { recursive: true, force: true });
    fs.mkdirSync(targetRoot, { recursive: true });
    copyTree(path.join(memoryCore, "src"), path.join(targetRoot, "src"));
    fs.copyFileSync(path.join(manifestRoot, "package.json"), path.join(targetRoot, "package.json"));
    fs.copyFileSync(path.join(manifestRoot, "package-lock.json"), path.join(targetRoot, "package-lock.json"));
    fs.copyFileSync(path.join(extracted, repositoryRoot.name, "LICENSE"), path.join(targetRoot, "LICENSE"));
    fs.writeFileSync(path.join(targetRoot, "VERSION"), `${lock.tag}\n${lock.commit}\n`);
    // SomniQ embeds only standalone SQLite Memory Core. Upstream optional
    // dependencies are service backends (MongoDB/Redis/Kafka/ClickHouse/COS)
    // and Opik context-offload instrumentation, all outside the first-release
    // boundary and otherwise add hundreds of megabytes to NSIS.
    run(pinnedNpm, ["ci", "--omit=dev", "--omit=optional", "--no-audit", "--no-fund"], { cwd: targetRoot });

    // Compile the pinned official TypeScript entrypoint during SomniQ's
    // trusted release build. Runtime loading through tsx adds several seconds
    // to every cold start and makes startup highly sensitive to antivirus file
    // scanning across hundreds of source modules. We retain src/ for audit and
    // fallback, while the sidecar executes this deterministic ESM bundle.
    const esbuildEntrypoint = path.join(targetRoot, "node_modules", "esbuild", "bin", "esbuild");
    if (!fs.existsSync(esbuildEntrypoint)) {
      throw new Error("Pinned tsx dependency did not install the expected esbuild compiler");
    }
    const compiledEntrypoint = path.join(targetRoot, "dist", "server.js");
    const clickhouseShim = path.join(manifestRoot, "shims", "clickhouse-client.mjs");
    const tcvdbTextShim = path.join(manifestRoot, "shims", "tcvdb-text.mjs");
    const tiktokenShim = path.join(manifestRoot, "shims", "js-tiktoken.mjs");
    for (const shim of [clickhouseShim, tcvdbTextShim, tiktokenShim]) {
      if (!fs.existsSync(shim)) {
        throw new Error(`SomniQ excluded-component shim is missing: ${shim}`);
      }
    }
    fs.mkdirSync(path.dirname(compiledEntrypoint), { recursive: true });
    run(nodeExe, [
      esbuildEntrypoint,
      "src/gateway/server.ts",
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--target=node22",
      // Bundle JavaScript dependencies as well as the official local source.
      // This avoids a first-install antivirus scan across hundreds of modules.
      // Native/resource-backed packages remain external so their binaries and
      // dictionaries continue to resolve from node_modules at runtime.
      "--external:@node-rs/jieba",
      "--external:@node-rs/jieba/*",
      "--external:sqlite-vec",
      "--external:node-llama-cpp",
      // Opik is an optional dynamic import and is disabled in SomniQ.
      "--external:opik",
      // Service-only optional backends are not reachable in standalone SQLite.
      "--external:ioredis",
      "--external:mongodb",
      "--external:@opentelemetry/context-async-hooks",
      `--alias:@clickhouse/client=${clickhouseShim}`,
      `--alias:@tencentdb-agent-memory/tcvdb-text=${tcvdbTextShim}`,
      `--alias:js-tiktoken=${tiktokenShim}`,
      // The official standalone source contains guarded dynamic imports for
      // optional COS integrations that are not shipped in MemoryCore/src.
      // Keep those unreachable standalone branches unresolved, matching tsx.
      "--external:../integrations/*",
      "--external:../../integrations/*",
      "--banner:js=import { createRequire as __somniqCreateRequire } from 'node:module'; const require = __somniqCreateRequire(import.meta.url);",
      "--minify",
      "--legal-comments=none",
      "--outfile=dist/server.js",
    ], { cwd: targetRoot });
    fs.writeFileSync(
      path.join(targetRoot, "BUILD_INFO.json"),
      `${JSON.stringify({
        sourceTag: lock.tag,
        sourceCommit: lock.commit,
        nodeVersion: lock.nodeVersion,
        entrypoint: "dist/server.js",
        entrypointSha256: sha256(compiledEntrypoint),
        sourceEntrypoint: "src/gateway/server.ts",
        packageLockSha256: sha256(path.join(targetRoot, "package-lock.json")),
      }, null, 2)}\n`,
    );

    const inventory = packageInventory(path.join(targetRoot, "node_modules"));
    fs.writeFileSync(
      path.join(targetRoot, "THIRD_PARTY_NOTICES"),
      [
        "TencentDB Agent Memory is bundled under the MIT license (see LICENSE).",
        "Third-party production packages:",
        ...inventory.map((pkg) => `${pkg.name}@${pkg.version} — ${pkg.license}`),
        "",
      ].join("\n"),
    );
    const sbom = run(pinnedNpm, ["sbom", "--omit=dev", "--omit=optional", "--sbom-format", "cyclonedx"], {
      cwd: targetRoot,
      capture: true,
    });
    fs.writeFileSync(path.join(targetRoot, "SBOM.cdx.json"), sbom);

    console.log(`Vendored TencentDB Memory Core ${lock.tag} (${lock.commit})`);
    console.log(`Vendored Node.js v${lock.nodeVersion} for Windows x64`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
