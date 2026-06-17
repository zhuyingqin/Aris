const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const PLAYWRIGHT_MCP_VERSION = "0.0.76";

const desktopRoot = path.resolve(__dirname, "..");
const resourcesRoot = path.join(desktopRoot, "src-tauri", "resources");
const mcpRoot = path.join(resourcesRoot, "mcp", "playwright");
const nodeRoot = path.join(resourcesRoot, "node");
const binRoot = path.join(resourcesRoot, "bin");

function assertInside(parent, child) {
  const rel = path.relative(parent, child);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Refusing to write outside ${parent}: ${child}`);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: desktopRoot,
    stdio: "inherit",
    ...options,
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

assertInside(resourcesRoot, mcpRoot);
assertInside(resourcesRoot, nodeRoot);

fs.rmSync(mcpRoot, { recursive: true, force: true });
fs.mkdirSync(mcpRoot, { recursive: true });
fs.writeFileSync(
  path.join(mcpRoot, "package.json"),
  JSON.stringify(
    {
      private: true,
      description: "Vendored Playwright MCP runtime for ARIS Studio",
      dependencies: {
        "@playwright/mcp": PLAYWRIGHT_MCP_VERSION,
      },
    },
    null,
    2,
  ) + "\n",
);

const npm = "npm";
run(
  npm,
  ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
  { cwd: mcpRoot, shell: process.platform === "win32" },
);

const cliPath = path.join(mcpRoot, "node_modules", "@playwright", "mcp", "cli.js");
if (!fs.existsSync(cliPath)) {
  throw new Error(`Playwright MCP CLI was not installed: ${cliPath}`);
}

fs.rmSync(nodeRoot, { recursive: true, force: true });
fs.mkdirSync(nodeRoot, { recursive: true });
const nodeTarget = path.join(nodeRoot, process.platform === "win32" ? "node.exe" : "node");
fs.copyFileSync(process.execPath, nodeTarget);
if (process.platform !== "win32") fs.chmodSync(nodeTarget, 0o755);
fs.writeFileSync(path.join(nodeRoot, "NODE_VERSION"), `${process.version}\n`);

for (const launcher of ["aris-playwright-mcp", "aris-playwright-mcp.cmd"]) {
  const launcherPath = path.join(binRoot, launcher);
  if (!fs.existsSync(launcherPath)) {
    throw new Error(`Missing launcher: ${launcherPath}`);
  }
  if (!launcher.endsWith(".cmd")) fs.chmodSync(launcherPath, 0o755);
}

console.log(`Vendored @playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`);
console.log(`Copied ${process.execPath} -> ${nodeTarget}`);
