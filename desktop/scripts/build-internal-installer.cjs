const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const desktopRoot = path.resolve(__dirname, "..");
const resourcesRoot = path.join(desktopRoot, "src-tauri", "resources");
const internalConfigTarget = path.join(resourcesRoot, "internal-config.json");

function env(name) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : "";
}

function boolEnv(name, fallback = false) {
  const value = env(name).toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: desktopRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function readJsonObject(file) {
  const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file} must contain a JSON object`);
  }
  return parsed;
}

function inferExecutorProvider(baseUrl) {
  const lower = baseUrl.toLowerCase();
  if (lower.includes("/anthropic") || lower.includes("anthropic.com")) {
    return "anthropic-compat";
  }
  return "openai";
}

function defaultModel(provider) {
  if (provider === "anthropic") return "claude-opus-4-7";
  if (provider === "anthropic-compat") return "claude-sonnet-4-6";
  if (provider === "gemini") return "gemini-2.5-pro";
  if (provider === "glm") return "GLM-5";
  if (provider === "minimax") return "MiniMax-M2.7";
  if (provider === "kimi") return "kimi-k2.5";
  if (provider === "deepseek") return "deepseek-v4-pro";
  return "gpt-5.5";
}

function buildConfigFromEnv() {
  const executorKey = env("ARIS_INTERNAL_EXECUTOR_API_KEY");
  if (!executorKey) {
    fail(
      "Missing ARIS_INTERNAL_EXECUTOR_API_KEY. Set it in your shell or pass ARIS_INTERNAL_CONFIG=<path-to-json>.",
    );
  }

  const executorBaseUrl = env("ARIS_INTERNAL_EXECUTOR_BASE_URL");
  const executorProvider =
    env("ARIS_INTERNAL_EXECUTOR_PROVIDER") || inferExecutorProvider(executorBaseUrl);
  const config = {
    _internal: {
      overwriteExisting: boolEnv("ARIS_INTERNAL_OVERWRITE_EXISTING", false),
    },
    executor_provider: executorProvider,
    executor_model: env("ARIS_INTERNAL_EXECUTOR_MODEL") || defaultModel(executorProvider),
    executor_api_key: executorKey,
    language: env("ARIS_INTERNAL_LANGUAGE") || "cn",
  };

  if (executorBaseUrl) {
    config.executor_base_url = executorBaseUrl;
  } else if (executorProvider === "openai") {
    config.executor_base_url = "https://api.openai.com/v1";
  } else if (executorProvider === "anthropic-compat") {
    config.executor_base_url = "https://api.anthropic.com";
  }

  const reviewerProvider = env("ARIS_INTERNAL_REVIEWER_PROVIDER");
  const reviewerKey = env("ARIS_INTERNAL_REVIEWER_API_KEY");
  if (reviewerProvider || reviewerKey) {
    config.reviewer_provider = reviewerProvider || "openai";
    config.reviewer_model =
      env("ARIS_INTERNAL_REVIEWER_MODEL") || defaultModel(config.reviewer_provider);
    config.reviewer_api_key = reviewerKey || executorKey;
    const reviewerBaseUrl = env("ARIS_INTERNAL_REVIEWER_BASE_URL");
    if (reviewerBaseUrl) config.reviewer_base_url = reviewerBaseUrl;
  }

  const scopusKey = env("ARIS_INTERNAL_SCOPUS_API_KEY");
  if (scopusKey) config.scopus_api_key = scopusKey;

  if (env("ARIS_INTERNAL_MEMORY_WRITE_APPROVAL")) {
    config.memory_write_approval = boolEnv("ARIS_INTERNAL_MEMORY_WRITE_APPROVAL");
  }

  return config;
}

function internalConfig() {
  const source = env("ARIS_INTERNAL_CONFIG");
  if (source) {
    return readJsonObject(path.resolve(source));
  }
  return buildConfigFromEnv();
}

function validateConfig(config) {
  const meta = config._internal && typeof config._internal === "object" ? config._internal : {};
  if (!config.executor_api_key && !meta.allowMissingExecutorKey) {
    fail(
      [
        "Internal config is missing executor_api_key.",
        "The installer would not be ready to use after installation.",
      ].join(" "),
    );
  }
  if (!config.executor_provider) {
    fail("Internal config is missing executor_provider.");
  }
  if (!config.executor_model) {
    fail("Internal config is missing executor_model.");
  }
}

function latestInstaller() {
  const nsisDir = path.join(desktopRoot, "src-tauri", "target", "release", "bundle", "nsis");
  if (!fs.existsSync(nsisDir)) return null;
  const installers = fs
    .readdirSync(nsisDir)
    .filter((name) => name.toLowerCase().endsWith("-setup.exe"))
    .map((name) => {
      const file = path.join(nsisDir, name);
      return { file, mtimeMs: fs.statSync(file).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return installers[0]?.file ?? null;
}

const productName = env("ARIS_INTERNAL_PRODUCT_NAME") || "ARIS Studio Internal";
const identifier = env("ARIS_INTERNAL_IDENTIFIER") || "com.aris.studio.internal";
const tauriConfigPath = path.join(
  os.tmpdir(),
  `aris-internal-tauri-${process.pid}-${Date.now()}.json`,
);
const previousInternalConfig = fs.existsSync(internalConfigTarget)
  ? fs.readFileSync(internalConfigTarget)
  : null;

try {
  fs.mkdirSync(resourcesRoot, { recursive: true });
  const config = internalConfig();
  validateConfig(config);
  fs.writeFileSync(internalConfigTarget, JSON.stringify(config, null, 2) + "\n");
  fs.writeFileSync(
    tauriConfigPath,
    JSON.stringify(
      {
        productName,
        identifier,
        bundle: {
          createUpdaterArtifacts: false,
          publisher: "ARIS Internal",
          shortDescription: "Internal ARIS Studio build with bundled LLM settings.",
        },
      },
      null,
      2,
    ) + "\n",
  );

  console.log(`Building ${productName} installer with bundled internal LLM config.`);
  run("npx", ["tauri", "build", "--bundles", "nsis", "--ci", "--config", tauriConfigPath]);

  const installer = latestInstaller();
  if (installer) {
    console.log(`Internal installer: ${installer}`);
  }
} finally {
  if (previousInternalConfig) {
    fs.writeFileSync(internalConfigTarget, previousInternalConfig);
  } else {
    fs.rmSync(internalConfigTarget, { force: true });
  }
  fs.rmSync(tauriConfigPath, { force: true });
}
