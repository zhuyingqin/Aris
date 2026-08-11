const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const desktopDir = path.resolve(__dirname, "..");
const resourcesDir = path.join(desktopDir, "src-tauri", "resources");
const nodePath = path.join(resourcesDir, "node", "node.exe");
const memoryDir = path.join(resourcesDir, "memory", "tencentdb");
const entrypoint = path.join(memoryDir, "dist", "server.js");
const gatewayKey = "somniq-memory-e2e-gateway-key";
const headers = {
  authorization: `Bearer ${gatewayKey}`,
  "content-type": "application/json",
  "x-tdai-service-id": "default",
};

function assertResources() {
  for (const required of [nodePath, entrypoint, path.join(memoryDir, "VERSION")]) {
    if (!fs.existsSync(required)) throw new Error(`Missing bundled resource: ${required}`);
  }
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function chooseGatewayPort() {
  for (let port = 8420; port <= 8439; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error("No free TencentDB Memory port in 8420-8439");
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function chatResponse(message, finishReason = "stop") {
  return {
    id: `chatcmpl-somniq-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "somniq-memory-e2e",
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
  };
}

async function startFakeOpenAi() {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }
    try {
      const body = await readJson(req);
      calls.push(body);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const hasToolResult = messages.some((message) => message.role === "tool");
      const prompt = messages
        .map((message) => typeof message.content === "string" ? message.content : "")
        .join("\n");
      const toolNames = new Set(
        (Array.isArray(body.tools) ? body.tools : [])
          .map((tool) => tool?.function?.name)
          .filter(Boolean),
      );

      let response;
      if (toolNames.has("write") && !hasToolResult) {
        const persona = /persona\.md|persona generation|用户画像|operating doctrine/i.test(prompt);
        const toolArguments = persona
          ? {
              path: "persona.md",
              content: "# SomniQ E2E Profile\n\nThe user values reproducible research, independent review, and traceable evidence.",
            }
          : {
              path: "somniq-research.md",
              content: [
                "-----META-START-----",
                "created: 2026-08-10T00:00:00.000Z",
                "updated: 2026-08-10T00:00:00.000Z",
                "summary: SomniQ reproducible research workflow",
                "heat: 10",
                "-----META-END-----",
                "# SomniQ research workflow",
                "The project uses an Executor, an independent Reviewer, and evidence-backed revisions.",
              ].join("\n"),
            };
        response = chatResponse({
          role: "assistant",
          content: null,
          tool_calls: [{
            id: `call-${calls.length}`,
            type: "function",
            function: { name: "write", arguments: JSON.stringify(toolArguments) },
          }],
        }, "tool_calls");
      } else if (hasToolResult) {
        response = chatResponse({ role: "assistant", content: "Memory artifact written successfully." });
      } else {
        response = chatResponse({
          role: "assistant",
          content: JSON.stringify([{
            scene_name: "SomniQ reproducible research",
            message_ids: [],
            memories: [{
              content: "The user requires a reproducible SomniQ workflow with independent review and traceable evidence.",
              type: "work_method",
              priority: 90,
              source_message_ids: [],
              metadata: { source: "somniq-e2e" },
            }],
          }]),
        });
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(response));
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    calls,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

function startCore(port, dataDir, modelHarness, stdoutPath, stderrPath) {
  const stdoutFd = fs.openSync(stdoutPath, "a");
  const stderrFd = fs.openSync(stderrPath, "a");
  const child = spawn(nodePath, ["dist/server.js"], {
    cwd: memoryDir,
    windowsHide: true,
    stdio: ["ignore", stdoutFd, stderrFd],
    env: {
      ...process.env,
      TDAI_DEPLOY_MODE: "standalone",
      STORE_MODE: "sqlite",
      STATE_BACKEND: "local",
      TDAI_GATEWAY_HOST: "127.0.0.1",
      TDAI_GATEWAY_PORT: String(port),
      TDAI_GATEWAY_API_KEY: gatewayKey,
      TDAI_CORS_ORIGINS: "",
      TDAI_DATA_DIR: dataDir,
      TDAI_GATEWAY_CONFIG: path.join(dataDir, "tdai-gateway.json"),
      V3_STRICT_ISOLATION: "true",
      TDAI_API_TRACE_ENABLED: "false",
      TDAI_LLM_PROVIDER: "openai",
      TDAI_LLM_API_KEY: modelHarness.apiKey,
      TDAI_LLM_BASE_URL: modelHarness.baseUrl,
      TDAI_LLM_MODEL: modelHarness.model,
      TDAI_LLM_TIMEOUT_MS: modelHarness.live ? "120000" : "10000",
    },
  });
  child.once("exit", () => {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  });
  return child;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function waitForHealth(baseUrl, child, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not ready";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Memory Core exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Memory Core health timeout: ${lastError}`);
}

async function post(baseUrl, route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new Error(`${route} returned non-JSON HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  if (!response.ok || envelope.code !== 0) {
    throw new Error(`${route} failed HTTP ${response.status}: ${text.slice(0, 1000)}`);
  }
  return envelope.data ?? {};
}

function scope(agentId, sessionId) {
  return {
    team_id: "somniq-local",
    agent_id: agentId,
    user_id: "somniq-e2e-user",
    session_id: sessionId,
  };
}

async function waitForPipeline(baseUrl, projectScope, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let counts = { l1: 0, l2: 0, l3: 0 };
  while (Date.now() < deadline) {
    const [l1, l2, l3] = await Promise.all([
      post(baseUrl, "/v3/atomic/count", projectScope),
      post(baseUrl, "/v3/scenario/count", projectScope),
      post(baseUrl, "/v3/core/count", projectScope),
    ]);
    counts = { l1: l1.total ?? 0, l2: l2.total ?? 0, l3: l3.total ?? 0 };
    if (counts.l1 > 0 && counts.l2 > 0 && counts.l3 > 0) return counts;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`L1/L2/L3 pipeline timeout: ${JSON.stringify(counts)}`);
}

function writeFastPipelineConfig(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "tdai-gateway.json"), JSON.stringify({
    memory: {
      extraction: { enabled: true, enableDedup: false, maxMemoriesPerSession: 20 },
      persona: { triggerEveryN: 1, maxScenes: 15 },
      pipeline: {
        everyNConversations: 1,
        enableWarmup: false,
        l1IdleTimeoutSeconds: 1,
        l2DelayAfterL1Seconds: 1,
        l2MinIntervalSeconds: 1,
        l2MaxIntervalSeconds: 2,
        sessionActiveWindowHours: 24,
      },
      recall: { strategy: "keyword", scoreThreshold: 0 },
      embedding: { enabled: false },
      bm25: { enabled: false },
    },
  }, null, 2));
}

async function main() {
  assertResources();
  const live = process.argv.includes("--live");
  const liveModel = {
    baseUrl: process.env.SOMNIQ_MEMORY_LIVE_BASE_URL?.trim(),
    apiKey: process.env.SOMNIQ_MEMORY_LIVE_API_KEY?.trim(),
    model: process.env.SOMNIQ_MEMORY_LIVE_MODEL?.trim(),
  };
  if (live && (!liveModel.baseUrl || !liveModel.apiKey || !liveModel.model)) {
    throw new Error(
      "Live Memory E2E requires SOMNIQ_MEMORY_LIVE_BASE_URL, SOMNIQ_MEMORY_LIVE_API_KEY, and SOMNIQ_MEMORY_LIVE_MODEL",
    );
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "somniq-memory-e2e-"));
  const dataDir = path.join(tempDir, "data");
  const stdoutPath = path.join(tempDir, "core.stdout.log");
  const stderrPath = path.join(tempDir, "core.stderr.log");
  const modelHarness = live
    ? {
        live: true,
        ...liveModel,
        calls: null,
        stop: async () => {},
      }
    : { live: false, ...(await startFakeOpenAi()), apiKey: "somniq-memory-e2e-key", model: "somniq-memory-e2e" };
  const port = await chooseGatewayPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const projectA = scope("project:e2e-a:executor", "session-a");
  const projectB = scope("project:e2e-b:executor", "session-b");
  let child;

  writeFastPipelineConfig(dataDir);
  try {
    child = startCore(port, dataDir, modelHarness, stdoutPath, stderrPath);
    await waitForHealth(baseUrl, child);

    for (let turn = 1; turn <= 5; turn += 1) {
      await post(baseUrl, "/v3/conversation/add", {
        ...projectA,
        messages: [
          {
            role: "user",
            content: `Turn ${turn}: preserve reproducible SomniQ research decisions and independent review evidence.`,
            timestamp: `2026-08-10T00:00:0${turn}Z`,
          },
          {
            role: "assistant",
            content: `Turn ${turn}: the Executor result is recorded and will be checked by the independent Reviewer.`,
            timestamp: `2026-08-10T00:00:0${turn}Z`,
          },
        ],
      });
    }
    await post(baseUrl, "/v3/conversation/add", {
      ...projectB,
      messages: [
        { role: "user", content: "Project B private marker is ORCHID-B-ONLY and must remain isolated.", timestamp: "2026-08-10T00:01:00Z" },
        { role: "assistant", content: "The ORCHID-B-ONLY marker belongs exclusively to project B.", timestamp: "2026-08-10T00:01:00Z" },
      ],
    });

    const l0 = await post(baseUrl, "/v3/conversation/count", projectA);
    if ((l0.total ?? 0) !== 10) throw new Error(`Expected 10 project-A L0 messages, received ${l0.total}`);
    const pipelineTimeout = live
      ? Number.parseInt(process.env.SOMNIQ_MEMORY_LIVE_PIPELINE_TIMEOUT_MS || "300000", 10)
      : 90000;
    const counts = await waitForPipeline(baseUrl, projectA, pipelineTimeout);
    if (modelHarness.calls && modelHarness.calls.length === 0) {
      throw new Error("Memory pipeline never called the configured model");
    }

    const l1Search = await post(baseUrl, "/v3/atomic/search", {
      ...projectA,
      query: "reproducible independent review evidence",
      limit: 5,
    });
    if (!Array.isArray(l1Search.items) || l1Search.items.length === 0) {
      throw new Error("L1 search returned no memories after extraction");
    }
    const scenes = await post(baseUrl, "/v3/scenario/ls", projectA);
    if (!Array.isArray(scenes.entries) || scenes.entries.length === 0) {
      throw new Error("L2 scenario index is empty after pipeline completion");
    }
    const core = await post(baseUrl, "/v3/core/read", projectA);
    if (!String(core.content ?? "").trim()) {
      throw new Error("L3 core profile was not generated by the model tool loop");
    }

    const leaked = await post(baseUrl, "/v3/conversation/search", {
      ...projectA,
      query: "ORCHID-B-ONLY",
      limit: 10,
    });
    if (JSON.stringify(leaked).includes("ORCHID-B-ONLY")) {
      throw new Error("Project B L0 content leaked into project A search");
    }

    await stopChild(child);
    child = startCore(port, dataDir, modelHarness, stdoutPath, stderrPath);
    await waitForHealth(baseUrl, child);
    const restartedL0 = await post(baseUrl, "/v3/conversation/count", projectA);
    const restartedL1 = await post(baseUrl, "/v3/atomic/count", projectA);
    if ((restartedL0.total ?? 0) !== 10 || (restartedL1.total ?? 0) < counts.l1) {
      throw new Error(`Restart lost memory state: L0=${restartedL0.total}, L1=${restartedL1.total}`);
    }

    process.stdout.write(
      `TencentDB Memory E2E passed: L0=${restartedL0.total}, L1=${restartedL1.total}, `
      + `L2=${counts.l2}, L3=${counts.l3}, model=${live ? "live" : `fake(${modelHarness.calls.length} calls)`}\n`,
    );
  } catch (error) {
    const stdout = fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath, "utf8").slice(-16000) : "";
    const stderr = fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, "utf8").slice(-16000) : "";
    throw new Error(`${error.message}\nMemory Core stdout:\n${stdout}\nMemory Core stderr:\n${stderr}`);
  } finally {
    await stopChild(child);
    await modelHarness.stop();
    if (tempDir.startsWith(path.join(os.tmpdir(), "somniq-memory-e2e-"))) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
