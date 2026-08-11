const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const desktopDir = path.resolve(__dirname, "..");
const resourcesDir = process.env.SOMNIQ_RESOURCES_DIR
  ? path.resolve(process.env.SOMNIQ_RESOURCES_DIR)
  : path.join(desktopDir, "src-tauri", "resources");
const nodePath = path.join(resourcesDir, "node", "node.exe");
const memoryDir = path.join(resourcesDir, "memory", "tencentdb");
const entrypoint = process.env.SOMNIQ_MEMORY_ENTRYPOINT || "dist/server.js";

function assertBundledResources() {
  for (const required of [
    nodePath,
    path.join(memoryDir, "src", "gateway", "server.ts"),
    path.join(memoryDir, entrypoint),
  ]) {
    if (!fs.existsSync(required)) {
      throw new Error(`Missing bundled resource: ${required}`);
    }
  }
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function choosePort() {
  for (let port = 8420; port <= 8439; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error("No free TencentDB Memory port in 8420-8439");
}

async function waitForHealth(baseUrl, headers, child, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not ready";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Memory Core exited early with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`, { headers });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Memory Core did not become healthy: ${lastError}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function main() {
  assertBundledResources();
  const port = await choosePort();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "somniq-memory-smoke-"));
  const stdoutPath = path.join(tempDir, "stdout.log");
  const stderrPath = path.join(tempDir, "stderr.log");
  const stdoutFd = fs.openSync(stdoutPath, "w");
  const stderrFd = fs.openSync(stderrPath, "w");
  const dataDir = process.env.SOMNIQ_MEMORY_DATA_DIR
    ? path.resolve(process.env.SOMNIQ_MEMORY_DATA_DIR)
    : path.join(tempDir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const gatewayConfig = path.join(dataDir, "somniq-gateway.json");
  fs.writeFileSync(gatewayConfig, JSON.stringify({
    memory: { bm25: { enabled: false }, recall: { strategy: "keyword" } },
  }));
  const gatewayKey = "somniq-resource-smoke-key";
  const baseUrl = `http://127.0.0.1:${port}`;
  const headers = {
    authorization: `Bearer ${gatewayKey}`,
    "content-type": "application/json",
    "x-tdai-service-id": "default",
  };

  const child = spawn(
    nodePath,
    [entrypoint],
    {
      cwd: memoryDir,
      windowsHide: true,
      stdio: ["ignore", stdoutFd, stderrFd],
      env: {
        ...process.env,
        TDAI_DEPLOY_MODE: "standalone",
        STORE_MODE: "sqlite",
        TDAI_GATEWAY_HOST: "127.0.0.1",
        TDAI_GATEWAY_PORT: String(port),
        TDAI_GATEWAY_API_KEY: gatewayKey,
        TDAI_CORS_ORIGINS: "",
        TDAI_DATA_DIR: dataDir,
        TDAI_GATEWAY_CONFIG: gatewayConfig,
        V3_STRICT_ISOLATION: "true",
        TDAI_API_TRACE_ENABLED: "false",
        TDAI_LLM_PROVIDER: "openai",
        TDAI_LLM_API_KEY: "smoke-test-not-used",
        TDAI_LLM_BASE_URL: "http://127.0.0.1:1/v1",
        TDAI_LLM_MODEL: "smoke-test",
      },
    },
  );
  const startedAt = Date.now();

  try {
    await waitForHealth(baseUrl, headers, child);
    const response = await fetch(`${baseUrl}/v3/conversation/count`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        team_id: "somniq-local",
        agent_id: "project:smoke:executor",
        user_id: "smoke-user",
        session_id: "smoke-session",
      }),
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`V3 count failed with HTTP ${response.status}: ${body}`);
    }
    const json = JSON.parse(body);
    if (json.code !== 0) {
      throw new Error(`V3 count returned an error envelope: ${body}`);
    }
    const unauthorized = await fetch(`${baseUrl}/v3/conversation/count`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tdai-service-id": "default" },
      body: JSON.stringify({
        team_id: "somniq-local",
        agent_id: "project:smoke:executor",
        user_id: "smoke-user",
      }),
    });
    if (unauthorized.status !== 401) {
      throw new Error(`Gateway accepted an unauthenticated V3 request (HTTP ${unauthorized.status})`);
    }
    const preflight = await fetch(`${baseUrl}/v3/conversation/count`, {
      method: "OPTIONS",
      headers: {
        origin: "https://untrusted.example",
        "access-control-request-method": "POST",
      },
    });
    if (preflight.headers.has("access-control-allow-origin")) {
      throw new Error("Gateway emitted CORS allow-origin for an untrusted origin");
    }
    process.stdout.write(
      `TencentDB Memory resource smoke test passed on 127.0.0.1:${port} in ${Date.now() - startedAt} ms\n`,
    );
  } catch (error) {
    const stdout = fs.existsSync(stdoutPath)
      ? fs.readFileSync(stdoutPath, "utf8").slice(-8000)
      : "";
    const stderr = fs.existsSync(stderrPath)
      ? fs.readFileSync(stderrPath, "utf8").slice(-8000)
      : "";
    throw new Error(
      `${error.message}\nMemory Core stdout:\n${stdout}\nMemory Core stderr:\n${stderr}`,
    );
  } finally {
    await stopChild(child);
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
    const expectedPrefix = path.join(os.tmpdir(), "somniq-memory-smoke-");
    if (process.env.SOMNIQ_MEMORY_KEEP_TEMP === "1") {
      process.stdout.write(`TencentDB Memory smoke logs kept at ${tempDir}\n`);
    } else if (tempDir.startsWith(expectedPrefix)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
