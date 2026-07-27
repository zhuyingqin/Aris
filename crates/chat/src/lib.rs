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
        "Default to the user's current language. If the user's language is unclear, use Chinese. Keep code, commands, identifiers, file paths, and technical terms in their original form.".to_string()
    } else {
        "Default to the user's current language. If the user's language is unclear, use English. Keep code, commands, identifiers, file paths, and technical terms in their original form.".to_string()
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
    if m.contains("minimax-m3") || m.contains("minimax_m3") {
        // MiniMax M3 exposes a 1M-token context window. Keep a generous
        // 200k reserve for the system prompt, tool schemas, reasoning, and
        // output while allowing long-running research sessions to stay live.
        return 800_000;
    }
    if m.contains("minimax-m2") || m.contains("minimax_m2") {
        // MiniMax M2.x API routes expose a much smaller ~204.8k window.
        return 160_000;
    }
    if m.contains("minimax") {
        // Keep long research sessions intact while compacting before repeated
        // tool diagnostics turn a repair loop into multi-minute model calls.
        return 320_000;
    }
    if m.contains("gemini") || m.contains("deepseek-v4") {
        // ~1M window → compact near the top, reserving ~150k for prompt+output.
        850_000
    } else if m.contains("gpt-5") || m.contains("gpt-4.1") {
        // Measured against the new-api gateway with gpt-5.6-luna (needle test,
        // 2026-07-25): 329,863 and 358,708 prompt tokens are accepted with the
        // needle at the head of the conversation still recalled verbatim, while
        // ~395k and ~450k are rejected — consistent with a 400k total window
        // shared by input, reasoning, and output. The wall is on tokens, not
        // request bytes: the 450k rejection carried a *smaller* body (1.34 MB)
        // than the 330k request that passed (1.4 MB). Budget sits below the
        // measured pass point, leaving room for `max_tokens_for_model` (16,384),
        // reasoning tokens, and the ~4.4k prefix this route injects per request.
        350_000
    } else if m.contains("kimi-k3") {
        // Kimi K3 exposes a 1M-token window. Reserve sufficient room for the
        // system prompt, tool schemas, and a long completion.
        850_000
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

/// The nominal context window advertised for a model family, used only for
/// gauge/telemetry display and the context-warning payload — never for gating
/// (compaction and warning thresholds run off
/// [`context_compaction_threshold_for_model`]). Kept next to the budget, in the
/// same family order and matching semantics (`contains` on a lowercased name),
/// so the advertised window and the budget share one source of truth; a unit
/// test asserts `budget <= window` for every family so an inversion like the
/// former qwen/glm "budget above window" cannot reappear. Callers that need a
/// `u64` (e.g. the desktop engine) wrap this rather than maintaining a second
/// table.
#[must_use]
pub fn context_window_for_model(model: &str) -> usize {
    let m = model.to_ascii_lowercase();
    if m.contains("minimax-m3") || m.contains("minimax_m3") {
        // MiniMax M3 supports a 1M-token context window.
        1_000_000
    } else if m.contains("minimax-m2") || m.contains("minimax_m2") {
        // MiniMax M2.x hosted API context window.
        204_800
    } else if m.contains("minimax") || m.contains("gemini") || m.contains("deepseek-v4") {
        // ~1M window.
        1_000_000
    } else if m.contains("gpt-5") || m.contains("gpt-4.1") {
        // 400k total window, measured (see the budget above) rather than
        // assumed from the proxy route.
        400_000
    } else if m.contains("kimi-k3") {
        // Kimi K3 exposes a 1M-token window.
        1_000_000
    } else if m.contains("kimi") || m.contains("moonshot") || m.contains("qwen") {
        // ~256k window (non-K3 Kimi/Moonshot and Qwen).
        256_000
    } else if m.contains("deepseek") {
        // ~64k window.
        64_000
    } else if m.contains("claude") {
        // Opus negotiates the 1M beta; Haiku is 200k.
        if m.contains("haiku") {
            200_000
        } else {
            1_000_000
        }
    } else if m.contains("glm") {
        // GLM is ~200k.
        200_000
    } else if m.contains("gpt") || m.contains("o1") || m.contains("o3") || m.contains("o4") {
        // Older GPT / o-series ~128–200k; advertise the upper bound.
        200_000
    } else {
        128_000
    }
}

#[derive(Debug, Clone)]
pub struct ChatToolSpec {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    pub required_permission: PermissionMode,
}

fn tool_schema_context_overhead_tokens(tool_specs: &[ChatToolSpec], enable_tools: bool) -> usize {
    if !enable_tools || tool_specs.is_empty() {
        return 0;
    }
    let schema = tool_specs
        .iter()
        .map(|tool| {
            serde_json::json!({
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.input_schema,
                }
            })
        })
        .collect::<Vec<_>>();
    let serialized = serde_json::to_string(&schema).unwrap_or_default();
    // Account for the provider's tool wrapper and tool-choice directive in
    // addition to the serialized schemas. This is deliberately small and is
    // not a context-budget change; it closes the request material that used to
    // be invisible to the session-only estimator.
    runtime::estimate_text_tokens(&serialized).saturating_add(128)
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
    let cwd = std::env::var_os("ARIS_WORKSPACE_ROOT")
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok())
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
        /// Which endpoint to use. `Auto` keeps the historical base-URL-derived
        /// choice; an explicit `Responses` preference still falls back to
        /// chat/completions at runtime when the gateway rejects the endpoint.
        transport: aris_executor::OpenAiTransport,
    },
}

impl ChatExecutorConfig {
    /// Same credentials and endpoint, with any explicit endpoint preference
    /// reset to [`aris_executor::OpenAiTransport::Auto`].
    ///
    /// Transport is a per-model capability, so reusing one model's connection
    /// for another model (the compaction summarizer) must not carry the
    /// original model's probed verdict along with it.
    #[must_use]
    pub fn with_inferred_transport(self) -> Self {
        match self {
            Self::OpenAiCompatible {
                api_key, base_url, ..
            } => Self::OpenAiCompatible {
                api_key,
                base_url,
                transport: aris_executor::OpenAiTransport::Auto,
            },
            other => other,
        }
    }
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
            transport: std::env::var("EXECUTOR_TRANSPORT")
                .map(|raw| aris_executor::OpenAiTransport::from_config_value(&raw))
                .unwrap_or_default(),
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
            // Absent/unknown → `Auto`, i.e. the historical behaviour. A
            // per-model override lives on the verified-executor entry and is
            // merged into this object before it reaches here.
            let transport = get("executor_transport")
                .map(|raw| aris_executor::OpenAiTransport::from_config_value(&raw))
                .unwrap_or_default();
            Ok((
                model,
                provider,
                ChatExecutorConfig::OpenAiCompatible {
                    api_key,
                    base_url,
                    transport,
                },
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
    build_executor_client_with_trace(config, model, enable_tools, tool_specs, observer, None)
}

pub fn build_executor_client_with_trace(
    config: ChatExecutorConfig,
    model: String,
    enable_tools: bool,
    tool_specs: Vec<aris_executor::ExecutorToolSpec>,
    observer: Box<dyn aris_executor::StreamObserver>,
    trace_sink: Option<Arc<dyn aris_executor::ExecutorTraceSink>>,
) -> Result<aris_executor::ExecutorClient, String> {
    match config {
        ChatExecutorConfig::Anthropic {
            auth,
            base_url,
            send_betas,
        } => {
            let mut client = aris_executor::AnthropicRuntimeClient::new(
                auth,
                base_url,
                send_betas,
                model.clone(),
                enable_tools,
                tool_specs,
                max_tokens_for_model(&model),
                observer,
            )?;
            if let Some(trace_sink) = trace_sink {
                client = client.with_trace_sink(trace_sink);
            }
            Ok(aris_executor::ExecutorClient::Anthropic(client))
        }
        ChatExecutorConfig::OpenAiCompatible {
            api_key,
            base_url,
            transport,
        } => {
            let mut client = aris_executor::OpenAIRuntimeClient::new(
                aris_executor::OpenAIExecutorConfig { api_key, base_url },
                model,
                enable_tools,
                tool_specs,
                observer,
            )?
            .with_transport(transport);
            if let Some(trace_sink) = trace_sink {
                client = client.with_trace_sink(trace_sink);
            }
            Ok(aris_executor::ExecutorClient::OpenAI(client))
        }
    }
}

/// Pick the model used to generate compaction summaries, or `None` to fall
/// back to the deterministic text-assembly summary. Precedence:
/// 1. `configured` — the explicit Settings value (`summarizer_model`).
/// 2. `ARIS_SUMMARIZER_MODEL` env var.
/// 3. a per-provider default (Haiku for larger Anthropic chats; a known small
///    sibling for OpenAI models, otherwise deterministic fallback).
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
    resolve_summarizer_client_with_trace(
        chat_config,
        chat_model,
        configured_model,
        configured_provider,
        None,
    )
}

pub fn resolve_summarizer_client_with_trace(
    chat_config: &ChatExecutorConfig,
    chat_model: &str,
    configured_model: Option<&str>,
    configured_provider: Option<SummarizerConfig>,
    trace_sink: Option<Arc<dyn aris_executor::ExecutorTraceSink>>,
) -> Option<aris_executor::ExecutorClient> {
    if let Some(configured_provider) = configured_provider {
        let model = resolve_summarizer_model(
            &configured_provider.executor_config,
            configured_provider.model.as_deref().unwrap_or(chat_model),
            configured_model
                .or(configured_provider.model.as_deref())
                .or(Some("auto")),
        )?;
        return build_executor_client_with_trace(
            configured_provider.executor_config,
            model,
            false,
            Vec::new(),
            Box::new(aris_executor::NoopStreamObserver),
            trace_sink,
        )
        .ok();
    }

    resolve_summarizer_model(chat_config, chat_model, configured_model).and_then(|summary_model| {
        build_executor_client_with_trace(
            // Reuses the executor's credentials and endpoint, but the summary
            // runs a *different* model whose endpoint capability was never
            // probed — so the executor's explicit transport preference must not
            // carry over. `Auto` infers it for the summary model instead.
            chat_config.clone().with_inferred_transport(),
            summary_model,
            false,
            Vec::new(),
            Box::new(aris_executor::NoopStreamObserver),
            trace_sink,
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
        ChatExecutorConfig::OpenAiCompatible { .. } => {
            // There is no portable "small model" name across arbitrary
            // OpenAI-compatible gateways. Use a cheap sibling only where the
            // model family makes the name unambiguous; unknown providers use
            // the deterministic compact summary instead of accidentally
            // spending the main model on a 120k-character summarization call.
            if model_lower_starts_with(model, "gpt-5") {
                Some("gpt-5-mini".to_string())
            } else if model_lower_starts_with(model, "gpt-4o") {
                Some("gpt-4o-mini".to_string())
            } else if model_lower_starts_with(model, "gpt-4.1") {
                Some("gpt-4.1-mini".to_string())
            } else {
                None
            }
        }
    }
}

fn model_lower_starts_with(model: &str, prefix: &str) -> bool {
    model.to_ascii_lowercase().starts_with(prefix)
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
    build_conversation_runtime_with_trace(
        session,
        executor_config,
        model,
        enable_tools,
        tool_specs,
        observer,
        tool_executor,
        permission_policy,
        system_prompt,
        feature_config,
        summarizer_model,
        summarizer_config,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn build_conversation_runtime_with_trace<T>(
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
    trace_sink: Option<Arc<dyn aris_executor::ExecutorTraceSink>>,
) -> Result<runtime::ConversationRuntime<aris_executor::ExecutorClient, T>, String>
where
    T: ToolExecutor,
{
    let tool_schema_overhead_tokens =
        tool_schema_context_overhead_tokens(&tool_specs, enable_tools);
    let executor_tool_specs = executor_tool_specs_for_tools(tool_specs);
    let context_compaction_threshold = context_compaction_threshold_for_model(&model);
    // Best-effort cheap-model summarizer for compaction. Built before the main
    // client consumes `executor_config`/`model`; it reuses the same provider
    // auth with a small model and no tools. Any construction failure is
    // swallowed so compaction falls back to the text-assembly summary.
    let summarizer = resolve_summarizer_client_with_trace(
        &executor_config,
        &model,
        summarizer_model.as_deref(),
        summarizer_config,
        trace_sink.clone(),
    );
    let client = build_executor_client_with_trace(
        executor_config,
        model,
        enable_tools,
        executor_tool_specs,
        observer,
        trace_sink,
    )?;
    let mut runtime = runtime::ConversationRuntime::new_with_features(
        session,
        client,
        tool_executor,
        permission_policy,
        system_prompt,
        feature_config,
    )
    .with_additional_context_overhead_estimated_tokens(tool_schema_overhead_tokens)
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
#[path = "tests/lib.rs"]
mod tests;
