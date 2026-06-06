use std::path::PathBuf;

use api::AuthSource;
use runtime::{
    ContentBlock, PermissionMode, PermissionPolicy, PromptBuildError, Session, ToolExecutor,
    TurnSummary,
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
        "You are running inside ARIS (Auto Research in Sleep), a {product_surface}. \
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
     for external LLM review, use the `LlmReview` tool instead. The LlmReview tool calls \
     Gemini or OpenAI directly (via GEMINI_API_KEY or OPENAI_API_KEY) without needing MCP. \
     Pass the full review prompt as the `prompt` parameter to LlmReview."
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

#[must_use]
pub fn executor_tool_specs_for_tools(
    tool_specs: Vec<tools::ToolSpec>,
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
    tool_specs: Vec<tools::ToolSpec>,
    active_mode: PermissionMode,
) -> PermissionPolicy {
    permission_policy_for_tools_with(tool_specs, active_mode, |spec| spec.required_permission)
}

#[must_use]
pub fn permission_policy_for_tools_with<F>(
    tool_specs: Vec<tools::ToolSpec>,
    active_mode: PermissionMode,
    mut required_mode: F,
) -> PermissionPolicy
where
    F: FnMut(&tools::ToolSpec) -> PermissionMode,
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

    let provider = get("executor_provider").unwrap_or_else(|| "anthropic".to_string());
    let model = get("executor_model").unwrap_or_else(|| DEFAULT_MODEL.to_string());

    match provider.as_str() {
        "anthropic" | "anthropic-compat" => {
            let configured_base_url = get("executor_base_url");
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

pub fn build_conversation_runtime<T>(
    session: Session,
    executor_config: ChatExecutorConfig,
    model: String,
    enable_tools: bool,
    tool_specs: Vec<tools::ToolSpec>,
    observer: Box<dyn aris_executor::StreamObserver>,
    tool_executor: T,
    permission_policy: PermissionPolicy,
    system_prompt: Vec<String>,
    feature_config: runtime::RuntimeFeatureConfig,
) -> Result<runtime::ConversationRuntime<aris_executor::ExecutorClient, T>, String>
where
    T: ToolExecutor,
{
    let executor_tool_specs = executor_tool_specs_for_tools(tool_specs);
    let client = build_executor_client(
        executor_config,
        model,
        enable_tools,
        executor_tool_specs,
        observer,
    )?;
    Ok(runtime::ConversationRuntime::new_with_features(
        session,
        client,
        tool_executor,
        permission_policy,
        system_prompt,
        feature_config,
    ))
}

#[must_use]
pub fn final_assistant_text(summary: &TurnSummary) -> String {
    summary
        .assistant_messages
        .last()
        .map(|message| {
            message
                .blocks
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{
        model_developer, permission_policy_for_tools, resolve_settings_executor_config,
        ChatExecutorConfig,
    };
    use api::AuthSource;
    use runtime::PermissionMode;
    use serde_json::{json, Value};

    #[test]
    fn model_developer_routes_openai_compatible_names() {
        assert_eq!(model_developer("gpt-5.5"), "OpenAI");
        assert_eq!(model_developer("deepseek-v4-pro"), "DeepSeek");
        assert_eq!(model_developer("gemini-2.5-pro"), "Google");
        assert_eq!(model_developer("moonshot-v1"), "Moonshot");
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
    fn permission_policy_uses_tool_requirements() {
        let spec = tools::ToolSpec {
            name: "write_file",
            description: "write",
            input_schema: Value::Null,
            required_permission: PermissionMode::WorkspaceWrite,
        };
        let policy = permission_policy_for_tools(vec![spec], PermissionMode::ReadOnly);
        assert_eq!(
            policy.required_mode_for("write_file"),
            PermissionMode::WorkspaceWrite
        );
    }
}
