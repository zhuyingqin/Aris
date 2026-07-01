use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use std::time::{Duration, Instant};

use api::AuthSource;
use runtime::{
    is_interrupted, scoped_mcp_config_hash, ManagedMcpTool, McpServerManager, PermissionMode,
    PermissionPolicy, PromptBuildError, Session, ToolError, ToolExecutor, TurnSummary,
};
use serde_json::{Map, Value};

pub const DEFAULT_MODEL: &str = "claude-opus-4-7";
pub const DEFAULT_OPENAI_BASE_URL: &str = "https://api.openai.com/v1";

#[derive(Debug, Clone)]
pub struct CommonSystemPromptOptions {
    pub workspace: PathBuf,
    pub current_date: String,
    pub os_name: String,
    pub os_version: String,
    pub model_id: Option<String>,
    pub product_surface: String,
    pub language: String,
    pub include_language_preference: bool,
    pub include_team_orchestration: bool,
    pub extra_sections: Vec<String>,
}

impl CommonSystemPromptOptions {
    #[must_use]
    pub fn new(workspace: PathBuf, model_id: Option<String>) -> Self {
        Self {
            workspace,
            current_date: runtime::today_iso(),
            os_name: std::env::consts::OS.to_string(),
            os_version: "unknown".to_string(),
            model_id,
            product_surface: "research automation runtime".to_string(),
            language: std::env::var("ARIS_LANGUAGE").unwrap_or_else(|_| "cn".to_string()),
            include_language_preference: true,
            include_team_orchestration: true,
            extra_sections: Vec::new(),
        }
    }
}

pub fn build_common_system_prompt(
    options: CommonSystemPromptOptions,
) -> Result<Vec<String>, PromptBuildError> {
    let mut prompt = runtime::load_system_prompt(
        options.workspace,
        options.current_date,
        options.os_name,
        options.os_version,
        options.model_id.as_deref(),
    )?;
    prompt.push(model_identity_section(
        options.model_id.as_deref(),
        &options.product_surface,
    ));
    if options.include_language_preference {
        prompt.push(language_preference_section(&options.language));
    }
    prompt.push(llm_review_override_section());
    if options.include_team_orchestration {
        prompt.push(runtime::team_orchestration_section());
    }
    prompt.extend(options.extra_sections);
    Ok(prompt)
}

#[must_use]
pub fn model_identity_section(model_id: Option<&str>, product_surface: &str) -> String {
    let model_name = model_id.unwrap_or("unknown");
    let friendly_name = friendly_model_name(model_name);
    let developer = model_developer(model_name);
    format!(
        "You are running inside SomniQ, a {product_surface}. \
         Your exact model is {model_name} ({friendly_name}), developed by {developer}. \
         When users ask what model you are, answer: \"{friendly_name}\" (model ID: {model_name}). \
         Do NOT guess or hallucinate a different version number."
    )
}

#[must_use]
pub fn language_preference_section(language: &str) -> String {
    if language == "cn" || language.eq_ignore_ascii_case("zh") {
        "User language preference is Chinese. Always respond in Chinese unless the user explicitly writes in another language.".to_string()
    } else {
        "User language preference is English. Always respond in English unless the user explicitly writes in another language.".to_string()
    }
}

#[must_use]
pub fn llm_review_override_section() -> String {
    "IMPORTANT: When a skill instructs you to use `mcp__codex__codex` or `mcp__codex__codex-reply` \
     for external LLM review, call that MCP tool when it is available. Otherwise use the \
     `LlmReview` tool, which uses the user's configured reviewer from SomniQ settings. Pass the \
     full review prompt as the `prompt` parameter and omit the optional `model` field unless \
     the user explicitly asks for a reviewer override."
        .to_string()
}

#[must_use]
pub fn friendly_model_name(model_name: &str) -> &str {
    match model_name {
        "claude-opus-4-7" => "Claude Opus 4.7",
        "claude-sonnet-4-6" => "Claude Sonnet 4.6",
        "claude-haiku-4-5-20251001" => "Claude Haiku 4.5",
        "deepseek-v4-pro" => "DeepSeek V4 Pro",
        "mimo-v2.5-pro" => "Xiaomi MiMo v2.5 Pro",
        "mimo-v2.5" => "Xiaomi MiMo v2.5",
        "mimo-v2-pro" => "Xiaomi MiMo v2 Pro",
        "mimo-v2-omni" => "Xiaomi MiMo v2 Omni",
        "qwen3.6-plus" => "Qwen 3.6 Plus",
        "qwen3.6-flash" => "Qwen 3.6 Flash",
        "qwen3.6-max-preview" => "Qwen 3.6 Max Preview",
        "doubao-pro-4k" => "Doubao Pro 4K",
        "doubao-lite-4k" => "Doubao Lite 4K",
        other => other,
    }
}

#[must_use]
pub fn model_developer(model_name: &str) -> &'static str {
    if model_name.starts_with("mimo-") {
        "Xiaomi"
    } else if model_name.starts_with("deepseek-") {
        "DeepSeek"
    } else if model_name.starts_with("qwen-") || model_name.starts_with("qwen3.") {
        "Alibaba"
    } else if model_name.starts_with("doubao-") {
        "ByteDance"
    } else if model_name.starts_with("gpt-")
        || model_name.starts_with("o1")
        || model_name.starts_with("o3")
        || model_name.starts_with("o4")
    {
        "OpenAI"
    } else if model_name.starts_with("gemini-") {
        "Google"
    } else if model_name.starts_with("GLM") || model_name.starts_with("glm") {
        "Zhipu"
    } else if model_name.starts_with("MiniMax") || model_name.starts_with("minimax") {
        "MiniMax"
    } else if model_name.starts_with("kimi-") || model_name.starts_with("moonshot-") {
        "Moonshot"
    } else {
        "Anthropic"
    }
}

#[must_use]
pub fn max_tokens_for_model(model: &str) -> u32 {
    if model.contains("opus") {
        32_000
    } else if model.contains("gpt") || model.contains("o3") || model.contains("o4") {
        16_384
    } else {
        64_000
    }
}

/// Token budget at which the conversation should start compacting, per model
/// family. This must sit comfortably below the model's *guaranteed* usable
/// context window, leaving headroom for the system prompt + tool schemas
/// (which `estimate_session_tokens` does not count) and for output.
///
/// The previous flat ~100k starved large-window models: MiniMax and Gemini
/// expose ~1M-token windows, so compacting at 100k discarded ~90% of usable
/// context. Budgets are intentionally explicit per family (like
/// `max_tokens_for_model`) so the safety margin is easy to reason about.
#[must_use]
pub fn context_compaction_threshold_for_model(model: &str) -> usize {
    let m = model.to_ascii_lowercase();
    if m.contains("minimax") || m.contains("gemini") || m.contains("deepseek-v4") {
        // ~1M window → compact near the top, reserving ~150k for prompt+output.
        850_000
    } else if m.contains("gpt-5") || m.contains("gpt-4.1") {
        // ~400k window.
        340_000
    } else if m.contains("kimi") || m.contains("moonshot") || m.contains("qwen") {
        // ~256k window.
        200_000
    } else if m.contains("deepseek") {
        // ~64k window — small, so the fixed prompt/output reserve bites harder.
        40_000
    } else if m.contains("claude") || m.contains("glm") {
        // Claude Opus negotiates the 1M beta, but Sonnet / API-key paths are
        // 200k; stay safe against that 200k floor. GLM is ~200k.
        160_000
    } else if m.contains("gpt") || m.contains("o1") || m.contains("o3") || m.contains("o4") {
        // Older GPT / o-series ~128–200k.
        160_000
    } else {
        100_000
    }
}

#[derive(Debug, Clone)]
pub struct ChatToolSpec {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    pub required_permission: PermissionMode,
}

impl From<tools::ToolSpec> for ChatToolSpec {
    fn from(spec: tools::ToolSpec) -> Self {
        Self {
            name: spec.name.to_string(),
            description: spec.description.to_string(),
            input_schema: spec.input_schema,
            required_permission: spec.required_permission,
        }
    }
}

#[derive(Debug)]
pub struct McpToolExecutor<T> {
    inner: T,
    runtime: Option<tokio::runtime::Runtime>,
    manager: Option<McpServerManager>,
    tool_names: BTreeSet<String>,
    cancel_flag: Option<Arc<AtomicBool>>,
}

impl<T> ToolExecutor for McpToolExecutor<T>
where
    T: ToolExecutor,
{
    fn execute(&mut self, tool_name: &str, input: &str) -> Result<String, ToolError> {
        self.execute_with_id("", tool_name, input)
    }

    fn execute_with_id(
        &mut self,
        tool_use_id: &str,
        tool_name: &str,
        input: &str,
    ) -> Result<String, ToolError> {
        if tool_name == "ToolSearch" {
            let output = self.inner.execute_with_id(tool_use_id, tool_name, input)?;
            return Ok(merge_mcp_tool_search_results(
                output,
                input,
                &self.tool_names,
            ));
        }
        if !self.tool_names.contains(tool_name) {
            return self.inner.execute_with_id(tool_use_id, tool_name, input);
        }

        // Respect the process-wide interrupt (CLI Ctrl+C) and, in desktop Chat,
        // the per-session cancellation flag before committing to a long MCP call.
        if self.cancel_requested() {
            return Err(ToolError::interrupted_by_user());
        }

        let arguments = serde_json::from_str(input)
            .map_err(|error| ToolError::new(format!("invalid MCP tool input JSON: {error}")))?;
        let runtime = self
            .runtime
            .as_ref()
            .ok_or_else(|| ToolError::new("MCP runtime is not available"))?;
        let manager = self
            .manager
            .as_mut()
            .ok_or_else(|| ToolError::new("MCP manager is not available"))?;
        // Use select! so Stop/Ctrl+C cancels a hanging MCP call quickly rather
        // than waiting for the full per-server request timeout (default 300 s).
        enum McpCallOutcome<T> {
            Response(Result<T, ToolError>),
            Cancelled,
        }
        let cancel_flag = self.cancel_flag.clone();
        let outcome = runtime.block_on(async {
            tokio::select! {
                result = manager.call_tool(tool_name, Some(arguments)) => {
                    McpCallOutcome::Response(result.map_err(|error| ToolError::new(error.to_string())))
                }
                () = wait_for_mcp_cancel(cancel_flag) => McpCallOutcome::Cancelled,
            }
        });
        let response = match outcome {
            McpCallOutcome::Response(result) => result?,
            McpCallOutcome::Cancelled => {
                if let (Some(runtime), Some(manager)) =
                    (self.runtime.as_ref(), self.manager.as_mut())
                {
                    let _ = runtime.block_on(manager.shutdown());
                }
                return Err(ToolError::interrupted_by_user());
            }
        };

        if let Some(error) = response.error {
            return Err(ToolError::new(format!(
                "MCP tool `{tool_name}` failed: {} ({})",
                error.message, error.code
            )));
        }
        let result = response
            .result
            .ok_or_else(|| ToolError::new(format!("MCP tool `{tool_name}` returned no result")))?;
        let output = serde_json::to_string(&result)
            .map_err(|error| ToolError::new(format!("failed to encode MCP result: {error}")))?;
        if result.is_error == Some(true) {
            Err(ToolError::new(output))
        } else {
            Ok(output)
        }
    }

    fn is_cancelled(&self) -> bool {
        self.cancel_requested() || self.inner.is_cancelled()
    }
}

impl<T> McpToolExecutor<T> {
    fn cancel_requested(&self) -> bool {
        is_interrupted()
            || self
                .cancel_flag
                .as_ref()
                .is_some_and(|flag| flag.load(Ordering::SeqCst))
    }
}

async fn wait_for_mcp_cancel(cancel_flag: Option<Arc<AtomicBool>>) {
    loop {
        if is_interrupted()
            || cancel_flag
                .as_ref()
                .is_some_and(|flag| flag.load(Ordering::SeqCst))
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn merge_mcp_tool_search_results(
    output: String,
    input: &str,
    tool_names: &BTreeSet<String>,
) -> String {
    let Ok(input) = serde_json::from_str::<Value>(input) else {
        return output;
    };
    let query = input
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    let max_results = input
        .get("max_results")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or(5)
        .max(1);
    let mut matches = if let Some(selection) = query.strip_prefix("select:") {
        let selected = selection
            .split(',')
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .collect::<BTreeSet<_>>();
        tool_names
            .iter()
            .filter(|name| selected.contains(name.to_lowercase().as_str()))
            .cloned()
            .collect::<Vec<_>>()
    } else {
        let terms = query
            .split_whitespace()
            .map(|term| term.trim_start_matches('+'))
            .filter(|term| !term.is_empty())
            .collect::<Vec<_>>();
        tool_names
            .iter()
            .filter(|name| {
                let lowered = name.to_lowercase();
                terms.is_empty() || terms.iter().all(|term| lowered.contains(term))
            })
            .cloned()
            .collect::<Vec<_>>()
    };

    if matches.is_empty() {
        return output;
    }

    let Ok(mut value) = serde_json::from_str::<Value>(&output) else {
        return output;
    };
    let Some(object) = value.as_object_mut() else {
        return output;
    };
    let existing = object
        .entry("matches".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    let Some(existing) = existing.as_array_mut() else {
        return output;
    };
    matches.retain(|name| !existing.iter().any(|item| item.as_str() == Some(name)));
    existing.extend(matches.into_iter().map(Value::String));
    existing.truncate(max_results);
    let total = object
        .get("total_deferred_tools")
        .and_then(Value::as_u64)
        .unwrap_or_default()
        .saturating_add(tool_names.len() as u64);
    object.insert(
        "total_deferred_tools".to_string(),
        Value::Number(total.into()),
    );
    serde_json::to_string_pretty(&value).unwrap_or(output)
}

impl<T> Drop for McpToolExecutor<T> {
    fn drop(&mut self) {
        if let (Some(runtime), Some(manager)) = (self.runtime.as_ref(), self.manager.as_mut()) {
            let _ = runtime.block_on(manager.shutdown());
        }
    }
}

#[derive(Debug)]
pub struct McpToolBundle<T> {
    pub executor: McpToolExecutor<T>,
    pub tool_specs: Vec<ChatToolSpec>,
    pub warnings: Vec<String>,
}

#[derive(Clone)]
struct CachedMcpDiscovery {
    discovered_at: Instant,
    tools: Vec<ManagedMcpTool>,
    failures: Vec<(String, String)>,
}

const MCP_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(45);
const MCP_DISCOVERY_CACHE_TTL: Duration = Duration::from_secs(300);

fn mcp_discovery_cache() -> &'static Mutex<BTreeMap<String, CachedMcpDiscovery>> {
    static CACHE: OnceLock<Mutex<BTreeMap<String, CachedMcpDiscovery>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn mcp_discovery_cache_key(feature_config: &runtime::RuntimeFeatureConfig) -> String {
    let cwd = std::env::current_dir()
        .map(|path| path.display().to_string())
        .unwrap_or_default();
    let servers = feature_config
        .mcp()
        .servers()
        .iter()
        .map(|(name, config)| format!("{name}:{}", scoped_mcp_config_hash(config)))
        .collect::<Vec<_>>()
        .join("|");
    format!("{cwd}|{servers}")
}

fn discover_mcp_tools_cached(
    manager: &mut McpServerManager,
    feature_config: &runtime::RuntimeFeatureConfig,
    mcp_runtime: &tokio::runtime::Runtime,
) -> (Vec<ManagedMcpTool>, Vec<(String, String)>) {
    let cache_key = mcp_discovery_cache_key(feature_config);
    let cached = mcp_discovery_cache()
        .lock()
        .ok()
        .and_then(|cache| cache.get(&cache_key).cloned())
        .filter(|entry| entry.discovered_at.elapsed() < MCP_DISCOVERY_CACHE_TTL);
    if let Some(cached) = cached {
        manager.preload_discovered_tools(&cached.tools);
        return (cached.tools, cached.failures);
    }

    let discovery = mcp_runtime.block_on(async {
        tokio::time::timeout(MCP_DISCOVERY_TIMEOUT, manager.discover_tools_resilient()).await
    });
    let (tools, failures) = match discovery {
        Ok(result) => result,
        Err(_) => {
            let _ = mcp_runtime.block_on(manager.shutdown());
            let failures = feature_config
                .mcp()
                .servers()
                .keys()
                .map(|name| {
                    (
                        name.clone(),
                        format!(
                            "tool discovery exceeded {}s; use the MCP page to test this server",
                            MCP_DISCOVERY_TIMEOUT.as_secs()
                        ),
                    )
                })
                .collect();
            (Vec::new(), failures)
        }
    };
    if let Ok(mut cache) = mcp_discovery_cache().lock() {
        cache.insert(
            cache_key,
            CachedMcpDiscovery {
                discovered_at: Instant::now(),
                tools: tools.clone(),
                failures: failures.clone(),
            },
        );
    }
    (tools, failures)
}

pub fn clear_mcp_discovery_cache() {
    if let Ok(mut cache) = mcp_discovery_cache().lock() {
        cache.clear();
    }
}

#[must_use]
pub fn chat_tool_specs<S>(tool_specs: Vec<S>) -> Vec<ChatToolSpec>
where
    S: Into<ChatToolSpec>,
{
    tool_specs.into_iter().map(Into::into).collect()
}

pub fn attach_mcp_tools<T>(
    inner: T,
    tool_specs: Vec<ChatToolSpec>,
    feature_config: &runtime::RuntimeFeatureConfig,
    allowed_tools: Option<&BTreeSet<String>>,
) -> McpToolBundle<T> {
    attach_mcp_tools_with_cancel(inner, tool_specs, feature_config, allowed_tools, None)
}

pub fn attach_mcp_tools_with_cancel<T>(
    inner: T,
    mut tool_specs: Vec<ChatToolSpec>,
    feature_config: &runtime::RuntimeFeatureConfig,
    allowed_tools: Option<&BTreeSet<String>>,
    cancel_flag: Option<Arc<AtomicBool>>,
) -> McpToolBundle<T> {
    let mut manager = McpServerManager::from_servers(feature_config.mcp().servers());
    let mut warnings = manager
        .unsupported_servers()
        .iter()
        .map(|server| {
            format!(
                "MCP server `{}` is unavailable: {}",
                server.server_name, server.reason
            )
        })
        .collect::<Vec<_>>();
    let mut tool_names = BTreeSet::new();

    if feature_config.mcp().servers().is_empty() {
        return McpToolBundle {
            executor: McpToolExecutor {
                inner,
                runtime: None,
                manager: None,
                tool_names,
                cancel_flag,
            },
            tool_specs,
            warnings,
        };
    }

    let mcp_runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            warnings.push(format!("could not start MCP runtime: {error}"));
            return McpToolBundle {
                executor: McpToolExecutor {
                    inner,
                    runtime: None,
                    manager: None,
                    tool_names,
                    cancel_flag,
                },
                tool_specs,
                warnings,
            };
        }
    };

    let (discovered, failures) =
        discover_mcp_tools_cached(&mut manager, feature_config, &mcp_runtime);
    warnings.extend(
        failures
            .into_iter()
            .map(|(server, error)| format!("could not discover MCP server `{server}`: {error}")),
    );
    for managed in discovered {
        if allowed_tools.is_some_and(|allowed| !allowed.contains(&managed.qualified_name)) {
            continue;
        }
        let description = managed.tool.description.unwrap_or_else(|| {
            format!(
                "MCP tool `{}` from server `{}`.",
                managed.raw_name, managed.server_name
            )
        });
        let input_schema = managed.tool.input_schema.unwrap_or_else(|| {
            serde_json::json!({
                "type": "object",
                "additionalProperties": true
            })
        });
        tool_names.insert(managed.qualified_name.clone());
        tool_specs.push(ChatToolSpec {
            name: managed.qualified_name,
            description,
            input_schema,
            required_permission: PermissionMode::DangerFullAccess,
        });
    }

    McpToolBundle {
        executor: McpToolExecutor {
            inner,
            runtime: Some(mcp_runtime),
            manager: Some(manager),
            tool_names,
            cancel_flag,
        },
        tool_specs,
        warnings,
    }
}

#[must_use]
pub fn executor_tool_specs_for_tools(
    tool_specs: Vec<ChatToolSpec>,
) -> Vec<aris_executor::ExecutorToolSpec> {
    tool_specs
        .into_iter()
        .map(|spec| {
            aris_executor::ExecutorToolSpec::new(spec.name, spec.description, spec.input_schema)
        })
        .collect()
}

#[must_use]
pub fn permission_policy_for_tools(
    tool_specs: Vec<ChatToolSpec>,
    active_mode: PermissionMode,
) -> PermissionPolicy {
    permission_policy_for_tools_with(tool_specs, active_mode, |spec| spec.required_permission)
}

#[must_use]
pub fn permission_policy_for_tools_with<F>(
    tool_specs: Vec<ChatToolSpec>,
    active_mode: PermissionMode,
    mut required_mode: F,
) -> PermissionPolicy
where
    F: FnMut(&ChatToolSpec) -> PermissionMode,
{
    tool_specs
        .into_iter()
        .fold(PermissionPolicy::new(active_mode), |policy, spec| {
            let required = required_mode(&spec);
            policy.with_tool_requirement(spec.name, required)
        })
}

#[derive(Debug, Clone)]
pub enum ChatExecutorConfig {
    Anthropic {
        auth: AuthSource,
        base_url: String,
        send_betas: bool,
    },
    OpenAiCompatible {
        api_key: String,
        base_url: String,
    },
}

#[derive(Debug, Clone)]
pub struct SummarizerConfig {
    pub provider: String,
    pub model: Option<String>,
    pub executor_config: ChatExecutorConfig,
}

pub fn resolve_env_executor_config<F>(load_anthropic_auth: F) -> Result<ChatExecutorConfig, String>
where
    F: FnOnce() -> Result<AuthSource, String>,
{
    if let Some(config) = aris_executor::resolve_openai_executor_config() {
        return Ok(ChatExecutorConfig::OpenAiCompatible {
            api_key: config.api_key,
            base_url: config.base_url,
        });
    }
    Ok(ChatExecutorConfig::Anthropic {
        auth: load_anthropic_auth()?,
        base_url: api::read_base_url(),
        send_betas: api::read_send_betas(),
    })
}

pub fn resolve_settings_executor_config(
    obj: &Map<String, Value>,
) -> Result<(String, String, ChatExecutorConfig), String> {
    let get = |key: &str| {
        obj.get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(ToString::to_string)
    };

    let stored_provider = get("executor_provider").unwrap_or_else(|| "anthropic".to_string());
    let model = get("executor_model").unwrap_or_else(|| DEFAULT_MODEL.to_string());
    let configured_base_url = get("executor_base_url");
    let provider =
        normalize_settings_executor_provider(stored_provider, configured_base_url.as_deref());

    match provider.as_str() {
        "anthropic" | "anthropic-compat" => {
            let base_url = configured_base_url
                .clone()
                .unwrap_or_else(api::read_base_url);
            let send_betas = configured_base_url.is_none() && api::read_send_betas();
            let auth = match get("executor_api_key") {
                Some(key) if provider == "anthropic-compat" => AuthSource::BearerToken(key),
                Some(key) => AuthSource::ApiKey(key),
                None => api::resolve_startup_auth_source(|| Ok(None)).map_err(|_| {
                    "No Anthropic API key configured. Add it on the Settings page.".to_string()
                })?,
            };
            Ok((
                model,
                provider,
                ChatExecutorConfig::Anthropic {
                    auth,
                    base_url,
                    send_betas,
                },
            ))
        }
        _ => {
            let api_key = get("executor_api_key").ok_or_else(|| {
                format!(
                    "No API key configured for provider '{provider}'. Add it on the Settings page."
                )
            })?;
            let base_url =
                get("executor_base_url").unwrap_or_else(|| DEFAULT_OPENAI_BASE_URL.to_string());
            Ok((
                model,
                provider,
                ChatExecutorConfig::OpenAiCompatible { api_key, base_url },
            ))
        }
    }
}

fn normalize_settings_executor_provider(provider: String, base_url: Option<&str>) -> String {
    if provider != "anthropic" {
        return provider;
    }
    let Some(base_url) = base_url.map(|value| value.trim().to_lowercase()) else {
        return provider;
    };
    if base_url.contains("minimaxi.com/anthropic") || base_url.contains("deepseek.com/anthropic") {
        "anthropic-compat".to_string()
    } else {
        provider
    }
}

pub fn build_executor_client(
    config: ChatExecutorConfig,
    model: String,
    enable_tools: bool,
    tool_specs: Vec<aris_executor::ExecutorToolSpec>,
    observer: Box<dyn aris_executor::StreamObserver>,
) -> Result<aris_executor::ExecutorClient, String> {
    match config {
        ChatExecutorConfig::Anthropic {
            auth,
            base_url,
            send_betas,
        } => Ok(aris_executor::ExecutorClient::Anthropic(
            aris_executor::AnthropicRuntimeClient::new(
                auth,
                base_url,
                send_betas,
                model.clone(),
                enable_tools,
                tool_specs,
                max_tokens_for_model(&model),
                observer,
            )?,
        )),
        ChatExecutorConfig::OpenAiCompatible { api_key, base_url } => Ok(
            aris_executor::ExecutorClient::OpenAI(aris_executor::OpenAIRuntimeClient::new(
                aris_executor::OpenAIExecutorConfig { api_key, base_url },
                model,
                enable_tools,
                tool_specs,
                observer,
            )?),
        ),
    }
}

/// Pick the model used to generate compaction summaries, or `None` to fall
/// back to the deterministic text-assembly summary. Precedence:
/// 1. `configured` — the explicit Settings value (`summarizer_model`).
/// 2. `ARIS_SUMMARIZER_MODEL` env var.
/// 3. a per-provider default (Haiku for larger Anthropic chats; otherwise the
///    active chat model).
///
/// At any layer, a value of `off`/`none`/`disabled` turns the LLM summary off,
/// and `auto`/`default` forces the per-provider default. A specific model id is
/// used as-is against the same provider auth. Empty/absent falls through.
#[must_use]
pub fn resolve_summarizer_model(
    config: &ChatExecutorConfig,
    model: &str,
    configured: Option<&str>,
) -> Option<String> {
    if let Some(value) = configured.map(str::trim).filter(|s| !s.is_empty()) {
        return summarizer_choice(config, model, value);
    }
    if let Ok(env_model) = std::env::var("ARIS_SUMMARIZER_MODEL") {
        let trimmed = env_model.trim();
        if trimmed.is_empty() {
            return None;
        }
        return summarizer_choice(config, model, trimmed);
    }
    default_summarizer_model(config, model)
}

pub fn resolve_summarizer_client(
    chat_config: &ChatExecutorConfig,
    chat_model: &str,
    configured_model: Option<&str>,
    configured_provider: Option<SummarizerConfig>,
) -> Option<aris_executor::ExecutorClient> {
    if let Some(configured_provider) = configured_provider {
        let model = resolve_summarizer_model(
            &configured_provider.executor_config,
            configured_provider.model.as_deref().unwrap_or(chat_model),
            configured_model
                .or(configured_provider.model.as_deref())
                .or(Some("auto")),
        )?;
        return build_executor_client(
            configured_provider.executor_config,
            model,
            false,
            Vec::new(),
            Box::new(aris_executor::NoopStreamObserver),
        )
        .ok();
    }

    resolve_summarizer_model(chat_config, chat_model, configured_model).and_then(|summary_model| {
        build_executor_client(
            chat_config.clone(),
            summary_model,
            false,
            Vec::new(),
            Box::new(aris_executor::NoopStreamObserver),
        )
        .ok()
    })
}

fn summarizer_choice(config: &ChatExecutorConfig, model: &str, value: &str) -> Option<String> {
    match value.to_ascii_lowercase().as_str() {
        "off" | "none" | "disabled" => None,
        "auto" | "default" => default_summarizer_model(config, model),
        _ => Some(value.to_string()),
    }
}

fn default_summarizer_model(config: &ChatExecutorConfig, model: &str) -> Option<String> {
    let model = model.trim();
    if model.is_empty() {
        return None;
    }
    match config {
        ChatExecutorConfig::Anthropic { .. } => {
            if model.contains("haiku") {
                Some(model.to_string())
            } else {
                Some("claude-haiku-4-5-20251001".to_string())
            }
        }
        ChatExecutorConfig::OpenAiCompatible { .. } => Some(model.to_string()),
    }
}

pub fn build_conversation_runtime<T>(
    session: Session,
    executor_config: ChatExecutorConfig,
    model: String,
    enable_tools: bool,
    tool_specs: Vec<ChatToolSpec>,
    observer: Box<dyn aris_executor::StreamObserver>,
    tool_executor: T,
    permission_policy: PermissionPolicy,
    system_prompt: Vec<String>,
    feature_config: runtime::RuntimeFeatureConfig,
    summarizer_model: Option<String>,
    summarizer_config: Option<SummarizerConfig>,
) -> Result<runtime::ConversationRuntime<aris_executor::ExecutorClient, T>, String>
where
    T: ToolExecutor,
{
    let executor_tool_specs = executor_tool_specs_for_tools(tool_specs);
    let context_compaction_threshold = context_compaction_threshold_for_model(&model);
    // Best-effort cheap-model summarizer for compaction. Built before the main
    // client consumes `executor_config`/`model`; it reuses the same provider
    // auth with a small model and no tools. Any construction failure is
    // swallowed so compaction falls back to the text-assembly summary.
    let summarizer = resolve_summarizer_client(
        &executor_config,
        &model,
        summarizer_model.as_deref(),
        summarizer_config,
    );
    let client = build_executor_client(
        executor_config,
        model,
        enable_tools,
        executor_tool_specs,
        observer,
    )?;
    let mut runtime = runtime::ConversationRuntime::new_with_features(
        session,
        client,
        tool_executor,
        permission_policy,
        system_prompt,
        feature_config,
    )
    .with_context_compaction_estimated_tokens_threshold(context_compaction_threshold)
    // Use the same model-derived budget for the real-token (API usage) signal
    // so both triggers agree; clamp to u32 for the threshold field.
    .with_auto_compaction_input_tokens_threshold(
        u32::try_from(context_compaction_threshold).unwrap_or(u32::MAX),
    );
    if let Some(summarizer) = summarizer {
        runtime = runtime.with_summarizer(summarizer);
    }
    Ok(runtime)
}

#[must_use]
pub fn final_assistant_text(summary: &TurnSummary) -> String {
    runtime::assistant_text_from_turn_summary(summary)
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, BTreeSet};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{
        attach_mcp_tools, chat_tool_specs, clear_mcp_discovery_cache,
        context_compaction_threshold_for_model, final_assistant_text,
        merge_mcp_tool_search_results, model_developer, permission_policy_for_tools,
        resolve_settings_executor_config, resolve_summarizer_model, ChatExecutorConfig,
    };
    use api::AuthSource;
    use runtime::{
        ConfigSource, ContentBlock, ConversationMessage, McpServerConfig, McpStdioServerConfig,
        PermissionMode, RuntimeFeatureConfig, ScopedMcpServerConfig, StaticToolExecutor,
        TokenUsage, ToolExecutor, TurnSummary,
    };
    use serde_json::{json, Value};

    #[test]
    fn summarizer_model_honors_explicit_setting_over_defaults() {
        let anthropic = ChatExecutorConfig::Anthropic {
            auth: AuthSource::ApiKey("k".into()),
            base_url: "https://api.anthropic.com".into(),
            send_betas: false,
        };
        let openai = ChatExecutorConfig::OpenAiCompatible {
            api_key: "k".into(),
            base_url: "https://example.test/v1".into(),
        };

        // Explicit setting wins regardless of provider/model. (These paths
        // short-circuit before the env var, so they are deterministic.)
        assert_eq!(
            resolve_summarizer_model(&anthropic, "claude-opus-4-8", Some("off")),
            None
        );
        assert_eq!(
            resolve_summarizer_model(&openai, "MiniMax-M3", Some("MiniMax-Cheap")),
            Some("MiniMax-Cheap".to_string())
        );
        // "auto" forces the per-provider default.
        assert_eq!(
            resolve_summarizer_model(&anthropic, "claude-opus-4-8", Some("auto")),
            Some("claude-haiku-4-5-20251001".to_string())
        );
        // Haiku still uses an LLM summary; it just reuses the active model.
        assert_eq!(
            resolve_summarizer_model(&anthropic, "claude-haiku-4-5-20251001", Some("auto")),
            Some("claude-haiku-4-5-20251001".to_string())
        );
        // OpenAI-compatible "auto" uses the active model rather than the
        // deterministic text-assembly fallback.
        assert_eq!(
            resolve_summarizer_model(&openai, "MiniMax-M3", Some("default")),
            Some("MiniMax-M3".to_string())
        );
    }

    #[test]
    fn context_budget_scales_with_model_window() {
        // Large-window models get large budgets — the whole point of the fix.
        assert_eq!(
            context_compaction_threshold_for_model("MiniMax-Text-01"),
            850_000
        );
        assert_eq!(
            context_compaction_threshold_for_model("gemini-2.5-pro"),
            850_000
        );
        assert_eq!(context_compaction_threshold_for_model("gpt-5"), 340_000);
        assert_eq!(
            context_compaction_threshold_for_model("deepseek-v4-pro"),
            850_000
        );
        // Small-window models stay conservative.
        assert_eq!(
            context_compaction_threshold_for_model("deepseek-chat"),
            40_000
        );
        // Claude stays safe against the 200k floor (Opus 1M beta notwithstanding).
        assert_eq!(
            context_compaction_threshold_for_model("claude-opus-4-8"),
            160_000
        );
    }

    fn temp_dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time should be after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("somniq-chat-mcp-{nanos}"))
    }

    fn write_mcp_server_script(root: &Path) -> PathBuf {
        fs::create_dir_all(root).expect("temp dir");
        let script_path = root.join("fake-mcp.py");
        let script = r#"import json, sys

def read_message():
    header = b''
    while not header.endswith(b'\r\n\r\n'):
        chunk = sys.stdin.buffer.read(1)
        if not chunk:
            return None
        header += chunk
    length = 0
    for line in header.decode().split('\r\n'):
        if line.lower().startswith('content-length:'):
            length = int(line.split(':', 1)[1].strip())
    return json.loads(sys.stdin.buffer.read(length).decode())

def send(message):
    payload = json.dumps(message).encode()
    sys.stdout.buffer.write(f'Content-Length: {len(payload)}\r\n\r\n'.encode() + payload)
    sys.stdout.buffer.flush()

while True:
    request = read_message()
    if request is None:
        break
    if request['method'] == 'initialize':
        send({'jsonrpc': '2.0', 'id': request['id'], 'result': {
            'protocolVersion': request['params']['protocolVersion'],
            'capabilities': {'tools': {}},
            'serverInfo': {'name': 'chat-test', 'version': '1.0.0'}}})
    elif request['method'] == 'tools/list':
        send({'jsonrpc': '2.0', 'id': request['id'], 'result': {'tools': [{
            'name': 'echo', 'description': 'Echo text',
            'inputSchema': {'type': 'object', 'properties': {'text': {'type': 'string'}}}}]}})
    elif request['method'] == 'tools/call':
        text = (request['params'].get('arguments') or {}).get('text', '')
        send({'jsonrpc': '2.0', 'id': request['id'], 'result': {
            'content': [{'type': 'text', 'text': 'echo:' + text}],
            'structuredContent': {'echoed': text}, 'isError': False}})
"#;
        fs::write(&script_path, script).expect("write fake MCP server");
        script_path
    }

    #[test]
    fn model_developer_routes_openai_compatible_names() {
        assert_eq!(model_developer("gpt-5.5"), "OpenAI");
        assert_eq!(model_developer("deepseek-v4-pro"), "DeepSeek");
        assert_eq!(model_developer("gemini-2.5-pro"), "Google");
        assert_eq!(model_developer("moonshot-v1"), "Moonshot");
    }

    #[test]
    fn final_assistant_text_keeps_text_from_all_model_iterations() {
        let summary = TurnSummary {
            assistant_messages: vec![
                ConversationMessage::assistant(vec![
                    ContentBlock::Text {
                        text: "Checking files.".to_string(),
                    },
                    ContentBlock::ToolUse {
                        id: "tool-1".to_string(),
                        name: "read_file".to_string(),
                        input: "{}".to_string(),
                    },
                ]),
                ConversationMessage::assistant(vec![
                    ContentBlock::Thinking {
                        thinking: "private reasoning".to_string(),
                        signature: String::new(),
                    },
                    ContentBlock::Text {
                        text: "Fix complete.".to_string(),
                    },
                ]),
            ],
            tool_results: Vec::new(),
            iterations: 2,
            usage: TokenUsage::default(),
            auto_compaction: None,
        };

        assert_eq!(
            final_assistant_text(&summary),
            "Checking files.\n\nFix complete."
        );
    }

    #[test]
    fn resolves_openai_compatible_settings() {
        let obj = json!({
            "executor_provider": "openai",
            "executor_model": "gpt-5.5",
            "executor_api_key": "sk-test",
            "executor_base_url": "https://example.test/v1"
        })
        .as_object()
        .cloned()
        .expect("object");

        let (model, provider, config) = resolve_settings_executor_config(&obj).expect("config");
        assert_eq!(model, "gpt-5.5");
        assert_eq!(provider, "openai");
        match config {
            ChatExecutorConfig::OpenAiCompatible { api_key, base_url } => {
                assert_eq!(api_key, "sk-test");
                assert_eq!(base_url, "https://example.test/v1");
            }
            ChatExecutorConfig::Anthropic { .. } => panic!("expected OpenAI-compatible config"),
        }
    }

    #[test]
    fn resolves_anthropic_settings_key_without_env() {
        let obj = json!({
            "executor_provider": "anthropic",
            "executor_model": "claude-sonnet-4-6",
            "executor_api_key": "anthropic-key",
            "executor_base_url": "https://anthropic.example"
        })
        .as_object()
        .cloned()
        .expect("object");

        let (model, provider, config) = resolve_settings_executor_config(&obj).expect("config");
        assert_eq!(model, "claude-sonnet-4-6");
        assert_eq!(provider, "anthropic");
        match config {
            ChatExecutorConfig::Anthropic {
                auth,
                base_url,
                send_betas,
            } => {
                assert_eq!(auth, AuthSource::ApiKey("anthropic-key".to_string()));
                assert_eq!(base_url, "https://anthropic.example");
                assert!(!send_betas);
            }
            ChatExecutorConfig::OpenAiCompatible { .. } => panic!("expected Anthropic config"),
        }
    }

    #[test]
    fn resolves_anthropic_compat_proxy_even_when_old_provider_is_anthropic() {
        let obj = json!({
            "executor_provider": "anthropic",
            "executor_model": "MiniMax-M3",
            "executor_api_key": "minimax-key",
            "executor_base_url": "https://api.minimaxi.com/anthropic"
        })
        .as_object()
        .cloned()
        .expect("object");

        let (model, provider, config) = resolve_settings_executor_config(&obj).expect("config");
        assert_eq!(model, "MiniMax-M3");
        assert_eq!(provider, "anthropic-compat");
        match config {
            ChatExecutorConfig::Anthropic {
                auth,
                base_url,
                send_betas,
            } => {
                assert_eq!(auth, AuthSource::BearerToken("minimax-key".to_string()));
                assert_eq!(base_url, "https://api.minimaxi.com/anthropic");
                assert!(!send_betas);
            }
            ChatExecutorConfig::OpenAiCompatible { .. } => panic!("expected Anthropic config"),
        }
    }

    #[test]
    fn permission_policy_uses_tool_requirements() {
        let spec = tools::ToolSpec {
            name: "write_file",
            description: "write",
            input_schema: Value::Null,
            required_permission: PermissionMode::WorkspaceWrite,
        };
        let policy =
            permission_policy_for_tools(chat_tool_specs(vec![spec]), PermissionMode::ReadOnly);
        assert_eq!(
            policy.required_mode_for("write_file"),
            PermissionMode::WorkspaceWrite
        );
    }

    #[test]
    fn attaches_discovers_and_executes_mcp_tools() {
        clear_mcp_discovery_cache();
        let root = temp_dir();
        let script = write_mcp_server_script(&root);
        let python = if cfg!(windows) { "python" } else { "python3" };
        let feature_config = RuntimeFeatureConfig::default().with_mcp_servers(BTreeMap::from([(
            "test".to_string(),
            ScopedMcpServerConfig {
                scope: ConfigSource::Local,
                config: McpServerConfig::Stdio(McpStdioServerConfig {
                    command: python.to_string(),
                    args: vec![script.to_string_lossy().into_owned()],
                    env: BTreeMap::from([(
                        "ARIS_MCP_STDIO_FRAMING".to_string(),
                        "content-length".to_string(),
                    )]),
                    request_timeout_secs: Some(10),
                }),
            },
        )]));

        let inner = StaticToolExecutor::new().register("ToolSearch", |_| {
            Ok(json!({
                "matches": [],
                "query": "test echo",
                "normalized_query": "test echo",
                "total_deferred_tools": 10,
                "pending_mcp_servers": null
            })
            .to_string())
        });
        let mut bundle = attach_mcp_tools(inner, Vec::new(), &feature_config, None);
        assert!(bundle.warnings.is_empty(), "{:?}", bundle.warnings);
        assert_eq!(bundle.tool_specs.len(), 1);
        assert_eq!(bundle.tool_specs[0].name, "mcp__test__echo");
        assert_eq!(
            bundle.tool_specs[0].required_permission,
            PermissionMode::DangerFullAccess
        );

        let output = bundle
            .executor
            .execute("mcp__test__echo", r#"{"text":"hello"}"#)
            .expect("execute MCP tool");
        assert!(output.contains(r#""echoed":"hello""#), "{output}");
        let search = bundle
            .executor
            .execute("ToolSearch", r#"{"query":"test echo","max_results":5}"#)
            .expect("search MCP tools");
        assert!(search.contains("mcp__test__echo"), "{search}");

        drop(bundle);
        fs::remove_file(&script).expect("remove MCP script after first discovery");

        let cached = attach_mcp_tools(StaticToolExecutor::new(), Vec::new(), &feature_config, None);
        assert!(cached.warnings.is_empty(), "{:?}", cached.warnings);
        assert_eq!(cached.tool_specs[0].name, "mcp__test__echo");
        drop(cached);

        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn tool_search_results_include_discovered_mcp_tools() {
        let names = BTreeSet::from([
            "mcp__playwright__browser_navigate".to_string(),
            "mcp__playwright__browser_click".to_string(),
        ]);
        let output = json!({
            "matches": [],
            "query": "playwright navigate",
            "normalized_query": "playwright navigate",
            "total_deferred_tools": 10,
            "pending_mcp_servers": null
        })
        .to_string();

        let merged = merge_mcp_tool_search_results(
            output,
            r#"{"query":"playwright navigate","max_results":5}"#,
            &names,
        );
        let merged: Value = serde_json::from_str(&merged).expect("merged search output");

        assert_eq!(
            merged["matches"],
            json!(["mcp__playwright__browser_navigate"])
        );
        assert_eq!(merged["total_deferred_tools"], 12);
    }
}
