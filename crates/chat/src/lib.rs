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
    PermissionPolicy, PromptBuildError, Session, ToolError, ToolExecution, ToolExecutor,
    ToolInvocation, ToolMedia, ToolOutput, TurnSummary,
};
use serde_json::{Map, Value};

pub const DEFAULT_MODEL: &str = "claude-opus-4-7";
pub const DEFAULT_OPENAI_BASE_URL: &str = "https://api.openai.com/v1";

const DEFAULT_BROWSER_TOOL_TIMEOUT_SECS: u64 = 120;
const DEFAULT_BROWSER_TOOL_MAX_RUNTIME_SECS: u64 = 600;
const MIN_BROWSER_TOOL_TIMEOUT_SECS: u64 = 30;
const MAX_BROWSER_TOOL_TIMEOUT_SECS: u64 = 1_800;
const BROWSER_WAIT_COMPLETION_GRACE_SECS: u64 = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct McpToolTimeoutPolicy {
    idle_timeout: Duration,
    hard_timeout: Duration,
}

/// Return the renewable idle lease for an interactive MCP browser call.
///
/// Long-running shell, compute, image-generation, and agent-style MCP tools
/// deliberately return `None`: they keep their own progress-aware or
/// transport-level limits. An explicit browser wait is given enough time to
/// finish the requested wait plus a small protocol/serialization allowance.
#[must_use]
pub fn mcp_tool_timeout(tool_name: &str, input: &str) -> Option<Duration> {
    mcp_tool_timeout_policy(tool_name, input).map(|policy| policy.idle_timeout)
}

/// Return the non-renewable maximum runtime shown by desktop heartbeats.
#[must_use]
pub fn mcp_tool_max_runtime(tool_name: &str, input: &str) -> Option<Duration> {
    mcp_tool_timeout_policy(tool_name, input).map(|policy| policy.hard_timeout)
}

fn mcp_tool_timeout_policy(tool_name: &str, input: &str) -> Option<McpToolTimeoutPolicy> {
    let idle_secs = std::env::var("ARIS_BROWSER_TOOL_TIMEOUT_SECS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(DEFAULT_BROWSER_TOOL_TIMEOUT_SECS)
        .clamp(MIN_BROWSER_TOOL_TIMEOUT_SECS, MAX_BROWSER_TOOL_TIMEOUT_SECS);
    let hard_secs = std::env::var("ARIS_BROWSER_TOOL_MAX_RUNTIME_SECS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(DEFAULT_BROWSER_TOOL_MAX_RUNTIME_SECS)
        .clamp(MIN_BROWSER_TOOL_TIMEOUT_SECS, MAX_BROWSER_TOOL_TIMEOUT_SECS);
    mcp_tool_timeout_policy_with_defaults(tool_name, input, idle_secs, hard_secs)
}

#[cfg(test)]
fn mcp_tool_timeout_with_default(
    tool_name: &str,
    input: &str,
    default_secs: u64,
) -> Option<Duration> {
    mcp_tool_timeout_policy_with_defaults(
        tool_name,
        input,
        default_secs,
        DEFAULT_BROWSER_TOOL_MAX_RUNTIME_SECS,
    )
    .map(|policy| policy.idle_timeout)
}

fn mcp_tool_timeout_policy_with_defaults(
    tool_name: &str,
    input: &str,
    default_idle_secs: u64,
    default_hard_secs: u64,
) -> Option<McpToolTimeoutPolicy> {
    let mut segments = tool_name.split("__");
    let is_browser_tool = segments.next() == Some("mcp")
        && segments.next().is_some()
        && segments
            .next()
            .is_some_and(|raw_name| raw_name.starts_with("browser_"));
    if !is_browser_tool {
        return None;
    }

    let mut idle_secs =
        default_idle_secs.clamp(MIN_BROWSER_TOOL_TIMEOUT_SECS, MAX_BROWSER_TOOL_TIMEOUT_SECS);
    let mut hard_secs = default_hard_secs
        .clamp(MIN_BROWSER_TOOL_TIMEOUT_SECS, MAX_BROWSER_TOOL_TIMEOUT_SECS)
        .max(idle_secs);
    if tool_name.ends_with("__browser_wait_for") {
        let explicit_wait_secs = serde_json::from_str::<Value>(input)
            .ok()
            .and_then(|value| value.get("time").and_then(Value::as_f64))
            .filter(|seconds| seconds.is_finite() && *seconds > 0.0)
            .map(|seconds| seconds.ceil() as u64);
        if let Some(wait_secs) = explicit_wait_secs {
            idle_secs = idle_secs.max(
                wait_secs
                    .saturating_add(BROWSER_WAIT_COMPLETION_GRACE_SECS)
                    .min(MAX_BROWSER_TOOL_TIMEOUT_SECS),
            );
            hard_secs = hard_secs.max(idle_secs);
        }
    }
    Some(McpToolTimeoutPolicy {
        idle_timeout: Duration::from_secs(idle_secs),
        hard_timeout: Duration::from_secs(hard_secs),
    })
}

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
    prompt.extend(options.extra_sections);
    Ok(prompt)
}

#[must_use]
fn model_identity_section(model_id: Option<&str>, product_surface: &str) -> String {
    let model_name = model_id.unwrap_or("unknown");
    let friendly_name = friendly_model_name(model_name);
    let developer = model_developer(model_name);
    let underlying_identity = if model_name == "unknown" {
        "The current underlying model ID and developer are unknown; do not infer them from the host product or tools.".to_string()
    } else {
        format!(
            "The current underlying model is {friendly_name} (model ID: {model_name}), developed by {developer}."
        )
    };
    format!(
        "You are SomniQ, the AI research assistant in a {product_surface}. \
         SomniQ is your assistant and product identity; the configured model below is the underlying inference model, not the name you should lead with in ordinary introductions. \
         {underlying_identity} \
         When users ask who or what you are, what SomniQ is, or what you can do, introduce yourself as SomniQ and explain that you are a local-first autonomous research assistant that helps with idea discovery, literature, experiments, evidence, writing, and submission-ready artifacts. \
         Do not answer such general identity questions with only a model name or developer. \
         When users explicitly ask for your underlying model, model ID, provider, or developer, answer accurately from the configured identity. \
         Only describe the underlying model as Claude when the exact model ID is a Claude model; never claim a Claude model merely because SomniQ or a tool mentions Claude. \
         Never present SomniQ as the model ID or model developer. \
         If asked what Claude Code is, describe it as Anthropic's separate coding product without claiming to be it. \
         When the model ID or developer is unknown, say so rather than guessing. Do NOT guess or hallucinate a different version number."
    )
}

#[must_use]
fn language_preference_section(language: &str) -> String {
    if language == "cn" || language.eq_ignore_ascii_case("zh") {
        "Default to the user's current language. If the user's language is unclear, use Chinese. Keep code, commands, identifiers, file paths, and technical terms in their original form.".to_string()
    } else {
        "Default to the user's current language. If the user's language is unclear, use English. Keep code, commands, identifiers, file paths, and technical terms in their original form.".to_string()
    }
}

#[must_use]
fn llm_review_override_section() -> String {
    "IMPORTANT: `LlmReview` is SomniQ's reviewer backend. Whenever a skill, workflow, or user asks for an independent / external / cross-model review, use `LlmReview`. It routes to the reviewer the user configured in SomniQ settings, so it works without any external MCP server. Pass the full review prompt as the `prompt` parameter and omit the optional `model` field unless the user explicitly asks for a reviewer override. `LlmReview` is single-shot with no conversation continuation: make every call self-contained, and for multi-round reviews send a fresh prompt that restates the context and what changed since the previous round. Legacy skill text may still name `mcp__codex__codex` or `mcp__codex__codex-reply`; treat those as referring to the reviewer backend and call `LlmReview` instead. Only use a Codex MCP tool when it is actually present in the current tool list AND the user explicitly asked for that backend in this conversation."
        .to_string()
}

#[must_use]
fn friendly_model_name(model_name: &str) -> &str {
    match model_name {
        "claude-opus-4-7" => "Claude Opus 4.7",
        "claude-sonnet-4-6" => "Claude Sonnet 4.6",
        "claude-fable-5.1" => "Claude Fable 5.1",
        "claude-fable-5" => "Claude Fable 5",
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
fn model_developer(model_name: &str) -> &'static str {
    if model_name.starts_with("claude-") {
        "Anthropic"
    } else if model_name.starts_with("mimo-") {
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
        "unknown provider"
    }
}

#[must_use]
fn max_tokens_for_model(model: &str) -> u32 {
    if model.contains("sonnet") || model.contains("opus") || model.contains("fable") {
        // Anthropic documents a 128k maximum completion for its current
        // 1M-context Sonnet, Opus, and Fable models.
        128_000
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
    } else if m.contains("gpt-5") || m.contains("gpt-6") || m.contains("gpt-4.1") {
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
    } else if m.contains("claude-sonnet") || m.contains("claude-opus") || m.contains("claude-fable")
    {
        // Sonnet 4.6, Opus 4.6+ and Fable 5 have a 1M context window by
        // default. Preserve room for the 128k maximum completion, system
        // prompt and tools while avoiding prematurely discarding research
        // continuity.
        850_000
    } else if m.contains("claude") || m.contains("glm") {
        // Older Claude and GLM models have a ~200k context floor. Keep a
        // stable reserve for prompt and output.
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
    } else if m.contains("gpt-5") || m.contains("gpt-6") || m.contains("gpt-4.1") {
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
        // Sonnet, Opus and Fable use the Claude Code 1M-context route; Haiku
        // retains its guaranteed 200k context window.
        if m.contains("opus") || m.contains("sonnet") || m.contains("fable") {
            1_000_000
        } else {
            200_000
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

/// Schema slots sent with the first provider request of a turn.
pub const MAX_ROUTED_TOOLS: usize = 20;

/// Hard ceiling on the live active set, including everything `ToolSearch`
/// activates later in the same turn. The headroom over [`MAX_ROUTED_TOOLS`]
/// lets one search land a whole capability family before the bounded LRU in the
/// conversation runtime has to evict anything.
pub const MAX_ACTIVE_TOOLS: usize = 24;

/// Always visible, never evicted: without `ToolSearch` the model cannot recover
/// anything, and the read/search set is what every task starts from.
const PINNED_CORE_TOOLS: &[&str] = &[
    "ToolSearch",
    "read_file",
    "read_files",
    "glob_search",
    "grep_search",
    "bash",
];

/// Visible from the first request but evictable once the turn's real shape is
/// known.
const SECONDARY_CORE_TOOLS: &[&str] = &[
    "AskUserQuestion",
    "session_search",
    "memory",
    "TodoWrite",
];

/// Upper bound on pins, so the LRU always keeps rotating slots for whatever the
/// turn turns out to need.
const MAX_PINNED_TOOLS: usize = MAX_ACTIVE_TOOLS - 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolRoutingMode {
    Off,
    Shadow,
    Active,
}

impl ToolRoutingMode {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Shadow => "shadow",
            Self::Active => "active",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolRoutingPlan {
    pub mode: ToolRoutingMode,
    pub profile: String,
    pub catalog_names: BTreeSet<String>,
    pub active_names: BTreeSet<String>,
    /// Subset of `active_names` the runtime's bounded LRU may never evict.
    pub pinned_names: BTreeSet<String>,
    pub deferred_names: BTreeSet<String>,
    pub reasons: Vec<String>,
}

impl ToolRoutingPlan {
    /// The routing decision as the conversation runtime consumes it.
    #[must_use]
    pub fn runtime_routing(&self) -> runtime::DynamicToolRouting {
        runtime::DynamicToolRouting {
            catalog: self.catalog_names.clone(),
            active: self.active_names.clone(),
            pinned: self.pinned_names.clone(),
            max_active: MAX_ACTIVE_TOOLS,
        }
    }
}

/// One intent's tool bundle. `required` is what the intent cannot be executed
/// without and is allocated before any group's `optional` extras, so a prompt
/// that triggers several intents does not let the first one exhaust the budget.
struct ToolGroup {
    profile: &'static str,
    reason: &'static str,
    required: Vec<String>,
    optional: Vec<String>,
}

/// Resolve the rollout mode once per process. Dynamic routing is enabled by
/// default for ordinary desktop chat; operators can use `shadow` to audit the
/// proposed subset without changing requests, or `off` for immediate rollback.
#[must_use]
pub fn dynamic_tool_routing_mode() -> ToolRoutingMode {
    static MODE: OnceLock<ToolRoutingMode> = OnceLock::new();
    *MODE.get_or_init(|| {
        match std::env::var("ARIS_DYNAMIC_TOOL_ROUTING")
            .unwrap_or_else(|_| "on".to_string())
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "off" | "0" | "false" => ToolRoutingMode::Off,
            "shadow" | "audit" => ToolRoutingMode::Shadow,
            _ => ToolRoutingMode::Active,
        }
    })
}

/// Choose a conservative initial model-visible subset. This is only a schema
/// projection: every name still remains in the executable permission catalog,
/// and ToolSearch can activate deferred names before the next model request.
#[must_use]
pub fn route_chat_tools(
    user_text: &str,
    tool_specs: &[ChatToolSpec],
    mode: ToolRoutingMode,
) -> ToolRoutingPlan {
    let catalog_names = tool_specs
        .iter()
        .map(|spec| spec.name.clone())
        .collect::<BTreeSet<_>>();
    if mode == ToolRoutingMode::Off
        || catalog_names.len() <= MAX_ROUTED_TOOLS
        || !catalog_names.contains("ToolSearch")
    {
        let (profile, reason) = if mode == ToolRoutingMode::Off {
            ("off", "routing disabled")
        } else if !catalog_names.contains("ToolSearch") {
            (
                "fallback-no-tool-search",
                "safe fallback without ToolSearch",
            )
        } else {
            ("small-catalog", "full catalog retained")
        };
        return ToolRoutingPlan {
            mode,
            profile: profile.to_string(),
            catalog_names: catalog_names.clone(),
            active_names: catalog_names.clone(),
            // Nothing was routed away, so nothing may be evicted either.
            pinned_names: catalog_names,
            deferred_names: BTreeSet::new(),
            reasons: vec![reason.to_string()],
        };
    }

    let lowered = user_text.to_lowercase();
    let mut profiles = vec!["core"];
    let mut reasons = Vec::new();
    let mut active_names = BTreeSet::new();
    let mut pinned_names = BTreeSet::new();

    for name in resolve_named(&catalog_names, PINNED_CORE_TOOLS) {
        pinned_names.insert(name.clone());
        active_names.insert(name);
    }

    // A tool the user named outright is the strongest signal there is, so it is
    // pinned rather than merely activated.
    let mentioned = catalog_names
        .iter()
        .filter(|name| mentions_tool(&lowered, name))
        .cloned()
        .collect::<Vec<_>>();
    if !mentioned.is_empty() {
        reasons.push(format!("named tools: {}", mentioned.join(", ")));
        for name in mentioned {
            // The cap holds even against a prompt that lists more tool names
            // than the whole budget.
            if active_names.len() >= MAX_ROUTED_TOOLS && !active_names.contains(&name) {
                break;
            }
            if pinned_names.len() < MAX_PINNED_TOOLS {
                pinned_names.insert(name.clone());
            }
            active_names.insert(name);
        }
    }

    let groups = intent_tool_groups(&lowered, &catalog_names);
    for group in &groups {
        if !profiles.contains(&group.profile) {
            profiles.push(group.profile);
        }
        reasons.push(group.reason.to_string());
    }

    // Every matched intent gets its must-have tools before any intent gets its
    // extras. Otherwise the first intent in the list drains the budget and a
    // mixed request ("fix the UI, then verify in the browser") arrives without
    // the tools for its second half.
    for group in &groups {
        for name in &group.required {
            if active_names.len() >= MAX_ROUTED_TOOLS && !active_names.contains(name) {
                break;
            }
            active_names.insert(name.clone());
            if pinned_names.len() < MAX_PINNED_TOOLS {
                pinned_names.insert(name.clone());
            }
        }
    }
    for name in resolve_named(&catalog_names, SECONDARY_CORE_TOOLS) {
        if active_names.len() >= MAX_ROUTED_TOOLS {
            break;
        }
        active_names.insert(name);
    }
    let widest_group = groups
        .iter()
        .map(|group| group.optional.len())
        .max()
        .unwrap_or_default();
    'extras: for index in 0..widest_group {
        for group in &groups {
            let Some(name) = group.optional.get(index) else {
                continue;
            };
            if active_names.len() >= MAX_ROUTED_TOOLS && !active_names.contains(name) {
                break 'extras;
            }
            active_names.insert(name.clone());
        }
    }

    let deferred_names = catalog_names
        .difference(&active_names)
        .cloned()
        .collect::<BTreeSet<_>>();
    ToolRoutingPlan {
        mode,
        profile: profiles.join("+"),
        catalog_names,
        active_names,
        pinned_names,
        deferred_names,
        reasons,
    }
}

/// Tool bundles for every intent the prompt matches, in allocation priority
/// order.
fn intent_tool_groups(lowered: &str, catalog: &BTreeSet<String>) -> Vec<ToolGroup> {
    let mut groups = Vec::new();
    if contains_any(
        lowered,
        &[
            "create", "new file", "generate", "scaffold", "draft", "新建", "创建", "生成", "新增",
            "写一个", "写个",
        ],
    ) {
        groups.push(ToolGroup {
            profile: "code",
            reason: "create-file intent",
            required: resolve_named(catalog, &["write_file", "write_files"]),
            optional: resolve_named(
                catalog,
                &[
                    "append_file",
                    "begin_large_write",
                    "append_write_chunk",
                    "commit_large_write",
                ],
            ),
        });
    }
    if contains_any(
        lowered,
        &[
            "fix", "implement", "edit", "change", "refactor", "build", "update", "modify", "rename",
            "修改", "修复", "实现", "添加", "重构", "更新", "调整", "优化",
        ],
    ) {
        groups.push(ToolGroup {
            profile: "code",
            reason: "modify-file intent",
            // Editing an existing file is read-then-edit; `multi_edit` is the
            // form two or more known replacements must take.
            required: resolve_named(catalog, &["read_file", "edit_file", "multi_edit"]),
            optional: resolve_named(
                catalog,
                &[
                    "write_file",
                    "write_files",
                    "append_file",
                    "change_list",
                    "change_get",
                    "change_revert",
                ],
            ),
        });
    }
    if contains_any(
        lowered,
        &[
            "investigate",
            "audit",
            "trace",
            "review",
            "where",
            "why",
            "which file",
            "调查",
            "排查",
            "审计",
            "为什么",
            "在哪",
            "查找",
            "定位",
            "梳理",
        ],
    ) {
        groups.push(ToolGroup {
            profile: "investigate",
            reason: "multi-file investigation intent",
            required: resolve_named(catalog, &["read_files", "glob_search", "grep_search"]),
            optional: resolve_named(catalog, &["session_search", "WorkspaceLayout", "bash"]),
        });
    }
    if contains_any(
        lowered,
        &[
            "browser",
            "webpage",
            "page",
            "frontend",
            "react",
            "css",
            "ui",
            "playwright",
            "e2e",
            "acceptance",
            "浏览器",
            "网页",
            "页面",
            "界面",
            "验收",
        ],
    ) {
        // Observe, act, verify: navigate and snapshot are useless without a way
        // to act, and clicking is unverifiable without a way to read state back.
        let required = resolve_suffixes(
            catalog,
            &[
                "browser_navigate",
                "browser_snapshot",
                "browser_click",
                "browser_evaluate",
            ],
        );
        let reason = if required.is_empty() {
            // Visible in the `tool.routing` trace: the intent was recognized but
            // MCP discovery produced no browser backend for this turn.
            "browser or UI intent without any discovered browser tool"
        } else {
            "browser or UI intent"
        };
        groups.push(ToolGroup {
            profile: "browser",
            reason,
            required,
            optional: resolve_suffixes(
                catalog,
                &[
                    "browser_type",
                    "browser_fill_form",
                    "browser_fill",
                    "browser_take_screenshot",
                    "browser_wait_for",
                    "browser_press_key",
                    "browser_select_option",
                    "browser_console_messages",
                    "browser_network_requests",
                    "browser_resize",
                    "browser_drag",
                ],
            ),
        });
    }
    if contains_any(
        lowered,
        &[
            "research",
            "literature",
            "paper",
            "citation",
            "evidence",
            "search",
            "研究",
            "文献",
            "论文",
            "引用",
            "证据",
            "检索",
        ],
    ) {
        groups.push(ToolGroup {
            profile: "research",
            reason: "research intent",
            required: resolve_named(catalog, &["LiteratureSearch"]),
            optional: resolve_contains(
                catalog,
                &[
                    "literature",
                    "arxiv",
                    "scopus",
                    "evidence",
                    "retrieval",
                    "zotero",
                ],
            ),
        });
    }
    if contains_any(
        lowered,
        &[
            "http://",
            "https://",
            "website",
            "online",
            "latest",
            "news",
            "current",
            "web search",
            "网站",
            "网上",
            "联网",
            "最新",
            "新闻",
            "搜索",
        ],
    ) {
        groups.push(ToolGroup {
            profile: "web",
            reason: "web intent",
            required: resolve_named(catalog, &["WebSearch", "WebFetch"]),
            optional: Vec::new(),
        });
    }
    if contains_any(
        lowered,
        &[
            "data",
            "analysis",
            "compute",
            "python",
            "notebook",
            "experiment",
            "数据",
            "分析",
            "计算",
            "实验",
        ],
    ) {
        groups.push(ToolGroup {
            profile: "compute",
            reason: "compute intent",
            required: Vec::new(),
            optional: resolve_contains(catalog, &["compute", "repl", "notebook", "experiment"]),
        });
    }
    if contains_any(
        lowered,
        &[
            "image", "audio", "video", "pdf", "图片", "图像", "音频", "视频",
        ],
    ) {
        groups.push(ToolGroup {
            profile: "media",
            reason: "media intent",
            required: Vec::new(),
            optional: resolve_contains(catalog, &["image", "media", "audio", "video", "pdf"]),
        });
    }
    if contains_any(
        lowered,
        &["skill", "agent", "delegate", "智能体", "技能", "委派"],
    ) {
        groups.push(ToolGroup {
            profile: "delegation",
            reason: "skill or agent intent",
            required: Vec::new(),
            optional: resolve_named(catalog, &["Skill", "Agent"]),
        });
    }
    if contains_any(
        lowered,
        &["email", "mail", "inbox", "邮件", "邮箱", "收件箱"],
    ) {
        groups.push(ToolGroup {
            profile: "mail",
            reason: "mail intent",
            required: Vec::new(),
            optional: catalog
                .iter()
                .filter(|name| name.to_lowercase().starts_with("mail_"))
                .cloned()
                .collect(),
        });
    }
    if contains_any(lowered, &["chatgpt", "oracle", "咨询", "网页账号"]) {
        groups.push(ToolGroup {
            profile: "oracle",
            reason: "configured consultation intent",
            required: Vec::new(),
            optional: catalog
                .iter()
                .filter(|name| name.to_lowercase().starts_with("chatgptweb"))
                .cloned()
                .collect(),
        });
    }
    groups
}

/// Catalog names for an ordered wish list, spelling-insensitively and skipping
/// anything this turn's catalog does not actually contain.
fn resolve_named(catalog: &BTreeSet<String>, names: &[&str]) -> Vec<String> {
    names
        .iter()
        .filter_map(|wanted| {
            let wanted = tools::canonical_tool_token(wanted);
            catalog
                .iter()
                .find(|name| tools::canonical_tool_token(name) == wanted)
                .cloned()
        })
        .collect()
}

/// Catalog names ending in each suffix, in suffix order. MCP tools arrive as
/// `mcp__<server>__browser_click`, so the suffix is the stable part.
fn resolve_suffixes(catalog: &BTreeSet<String>, suffixes: &[&str]) -> Vec<String> {
    let mut resolved: Vec<String> = Vec::new();
    for suffix in suffixes {
        for name in catalog {
            if name.ends_with(suffix) && !resolved.contains(name) {
                resolved.push(name.clone());
            }
        }
    }
    resolved
}

fn resolve_contains(catalog: &BTreeSet<String>, terms: &[&str]) -> Vec<String> {
    catalog
        .iter()
        .filter(|name| {
            let lowered = name.to_lowercase();
            terms.iter().any(|term| lowered.contains(term))
        })
        .cloned()
        .collect()
}

/// Whether the prompt names this tool outright, in any of the spellings a
/// person actually types. Deliberately literal: canonicalizing the whole prompt
/// would drop CJK characters and fuse unrelated ASCII runs into false hits.
fn mentions_tool(lowered_text: &str, name: &str) -> bool {
    let candidates = [name, name.rsplit("__").next().unwrap_or(name)];
    candidates.iter().any(|candidate| {
        let candidate = candidate.to_lowercase();
        if candidate.len() < 4 {
            return false;
        }
        lowered_text.contains(&candidate)
            || (candidate.contains('_')
                && (lowered_text.contains(&candidate.replace('_', " "))
                    || lowered_text.contains(&candidate.replace('_', "-"))))
    })
}

fn contains_any(text: &str, terms: &[&str]) -> bool {
    terms.iter().any(|term| text.contains(term))
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
    /// Every tool name this Chat turn can reach, with its description, so
    /// `ToolSearch` ranks the real catalog instead of the kernel's subset.
    search_tools: BTreeMap<String, String>,
    /// Configured MCP servers that produced no tools this turn.
    unavailable_servers: Vec<String>,
    cancel_flag: Option<Arc<AtomicBool>>,
    timeout_policy_override: Option<McpToolTimeoutPolicy>,
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
        match self.execute_output_with_id(tool_use_id, tool_name, input) {
            Ok(output) if output.reported_error => Err(ToolError::new(output.text)),
            Ok(output) => Ok(output.text),
            Err(error) => Err(error),
        }
    }

    fn execute_output_with_id(
        &mut self,
        tool_use_id: &str,
        tool_name: &str,
        input: &str,
    ) -> Result<ToolOutput, ToolError> {
        if tool_name == "ToolSearch" {
            let mut output = self
                .inner
                .execute_output_with_id(tool_use_id, tool_name, input)?;
            output.text = merge_mcp_tool_search_results(
                output.text,
                input,
                &self.search_tools,
                &self.unavailable_servers,
            );
            return Ok(output);
        }
        if !self.tool_names.contains(tool_name) {
            return self
                .inner
                .execute_output_with_id(tool_use_id, tool_name, input);
        }

        if self.cancel_requested() {
            return Err(ToolError::interrupted_by_user());
        }

        let arguments = serde_json::from_str(input)
            .map_err(|error| ToolError::new(format!("invalid MCP tool input JSON: {error}")))?;
        let browser_acceptance_tool = browser_acceptance_snapshot_name(tool_name, &self.tool_names);
        let runtime = self
            .runtime
            .as_ref()
            .ok_or_else(|| ToolError::new("MCP runtime is not available"))?;
        let manager = self
            .manager
            .as_mut()
            .ok_or_else(|| ToolError::new("MCP manager is not available"))?;
        enum McpCallOutcome<T> {
            Response(Result<T, ToolError>),
            Cancelled,
            IdleTimedOut(Duration),
            HardTimedOut(Duration),
        }
        let cancel_flag = self.cancel_flag.clone();
        let timeout_policy = self
            .timeout_policy_override
            .or_else(|| mcp_tool_timeout_policy(tool_name, input));
        let outcome = runtime.block_on(async {
            if let Some(policy) = timeout_policy {
                // The idle lease starts after the MCP server is initialized
                // and tools/call is about to be sent. Bootstrap time is still
                // covered by the absolute ceiling, but cannot consume the
                // entire no-progress allowance before the tool even starts.
                let last_progress = Arc::new(Mutex::new(None::<Instant>));
                let call_progress = last_progress.clone();
                tokio::select! {
                    result = manager.call_tool_with_progress(tool_name, Some(arguments), move || {
                        if let Ok(mut progress_at) = call_progress.lock() {
                            *progress_at = Some(Instant::now());
                        }
                    }) => {
                        McpCallOutcome::Response(result.map_err(|error| ToolError::new(error.to_string())))
                    }
                    () = wait_for_mcp_cancel(cancel_flag) => McpCallOutcome::Cancelled,
                    () = wait_for_mcp_idle_timeout(last_progress, policy.idle_timeout) => {
                        McpCallOutcome::IdleTimedOut(policy.idle_timeout)
                    }
                    () = tokio::time::sleep(policy.hard_timeout) => {
                        McpCallOutcome::HardTimedOut(policy.hard_timeout)
                    }
                }
            } else {
                tokio::select! {
                    result = manager.call_tool(tool_name, Some(arguments)) => {
                        McpCallOutcome::Response(result.map_err(|error| ToolError::new(error.to_string())))
                    }
                    () = wait_for_mcp_cancel(cancel_flag) => McpCallOutcome::Cancelled,
                }
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
            McpCallOutcome::IdleTimedOut(timeout) => {
                if let (Some(runtime), Some(manager)) =
                    (self.runtime.as_ref(), self.manager.as_mut())
                {
                    let _ = runtime.block_on(manager.shutdown());
                }
                return Err(ToolError::timed_out_after(
                    format!(
                        "MCP browser tool `{tool_name}` produced no progress for {}s. The MCP server was restarted so the conversation can recover. For an intentional long wait, use `browser_wait_for` with its `time` argument; for long-running computation, use a background-capable tool.",
                        timeout.as_secs()
                    ),
                    timeout,
                ));
            }
            McpCallOutcome::HardTimedOut(timeout) => {
                if let (Some(runtime), Some(manager)) =
                    (self.runtime.as_ref(), self.manager.as_mut())
                {
                    let _ = runtime.block_on(manager.shutdown());
                }
                return Err(ToolError::timed_out_after(
                    format!(
                        "MCP browser tool `{tool_name}` exceeded its {}s maximum runtime despite progress signals. The MCP server was restarted so the conversation can recover.",
                        timeout.as_secs()
                    ),
                    timeout,
                ));
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
        let mut output = mcp_result_to_tool_output(result)?;
        if let Some(snapshot_tool) = browser_acceptance_tool {
            attach_browser_acceptance(
                &mut output,
                tool_name,
                &snapshot_tool,
                runtime,
                manager,
                self.cancel_flag.clone(),
            );
        }
        Ok(output)
    }

    fn execution(&self, tool_name: &str) -> ToolExecution {
        if tool_name == "ToolSearch" || self.tool_names.contains(tool_name) {
            ToolExecution::Serial
        } else {
            self.inner.execution(tool_name)
        }
    }

    fn execute_batch(&mut self, invocations: &[ToolInvocation]) -> Vec<Result<String, ToolError>> {
        if invocations.iter().all(|invocation| {
            invocation.tool_name != "ToolSearch" && !self.tool_names.contains(&invocation.tool_name)
        }) {
            return self.inner.execute_batch(invocations);
        }
        // An MCP call is stateful and stays serial, but its presence should
        // not turn independent local read-only calls into a serial batch.
        let parallel_local = invocations
            .iter()
            .enumerate()
            .filter(|(_, invocation)| {
                invocation.tool_name != "ToolSearch"
                    && !self.tool_names.contains(&invocation.tool_name)
                    && self.inner.execution(&invocation.tool_name) == ToolExecution::Parallel
            })
            .map(|(index, invocation)| (index, invocation.clone()))
            .collect::<Vec<_>>();
        let mut results = (0..invocations.len()).map(|_| None).collect::<Vec<_>>();
        if !parallel_local.is_empty() {
            let batch = parallel_local
                .iter()
                .map(|(_, invocation)| invocation.clone())
                .collect::<Vec<_>>();
            for ((index, _), result) in parallel_local
                .into_iter()
                .zip(self.inner.execute_batch(&batch))
            {
                results[index] = Some(result);
            }
        }
        for (index, invocation) in invocations.iter().enumerate() {
            if results[index].is_none() {
                results[index] = Some(self.execute_with_id(
                    &invocation.tool_use_id,
                    &invocation.tool_name,
                    &invocation.input,
                ));
            }
        }
        results
            .into_iter()
            .map(|result| result.expect("every tool invocation must produce a result"))
            .collect()
    }

    fn execute_output_batch(
        &mut self,
        invocations: &[ToolInvocation],
    ) -> Vec<Result<ToolOutput, ToolError>> {
        if invocations.iter().all(|invocation| {
            invocation.tool_name != "ToolSearch" && !self.tool_names.contains(&invocation.tool_name)
        }) {
            return self.inner.execute_output_batch(invocations);
        }
        invocations
            .iter()
            .map(|invocation| {
                self.execute_output_with_id(
                    &invocation.tool_use_id,
                    &invocation.tool_name,
                    &invocation.input,
                )
            })
            .collect()
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

const BROWSER_ACCEPTANCE_TIMEOUT: Duration = Duration::from_secs(30);

fn browser_acceptance_snapshot_name(
    tool_name: &str,
    tool_names: &BTreeSet<String>,
) -> Option<String> {
    const MUTATIONS: &[&str] = &[
        "browser_click",
        "browser_drag",
        "browser_file_upload",
        "browser_fill",
        "browser_fill_form",
        "browser_go_back",
        "browser_handle_dialog",
        "browser_navigate",
        "browser_press_key",
        "browser_select_option",
        "browser_type",
    ];
    let mutation = MUTATIONS
        .iter()
        .find(|suffix| tool_name.ends_with(**suffix))?;
    let prefix = tool_name.strip_suffix(mutation)?;
    let snapshot = format!("{prefix}browser_snapshot");
    tool_names.contains(&snapshot).then_some(snapshot)
}

fn browser_output_has_state_evidence(output: &ToolOutput) -> bool {
    if !output.media.is_empty() {
        return true;
    }
    let lowered = output.text.to_ascii_lowercase();
    [
        "page url:",
        "page state",
        "accessibility snapshot",
        "browser snapshot",
    ]
    .iter()
    .any(|marker| lowered.contains(marker))
}

fn attach_browser_acceptance(
    output: &mut ToolOutput,
    action_tool: &str,
    snapshot_tool: &str,
    runtime: &tokio::runtime::Runtime,
    manager: &mut McpServerManager,
    cancel_flag: Option<Arc<AtomicBool>>,
) {
    if output.reported_error {
        return;
    }
    if browser_output_has_state_evidence(output) {
        output.text.push_str(&format!(
            "\n\nBrowser acceptance: action `{action_tool}` is verified by the page-state evidence returned with the action."
        ));
        return;
    }

    enum AcceptanceOutcome {
        Response(
            Result<
                runtime::JsonRpcResponse<runtime::McpToolCallResult>,
                runtime::McpServerManagerError,
            >,
        ),
        Cancelled,
        TimedOut,
    }
    let outcome = runtime.block_on(async {
        tokio::select! {
            result = manager.call_tool(snapshot_tool, Some(serde_json::json!({}))) => AcceptanceOutcome::Response(result),
            () = wait_for_mcp_cancel(cancel_flag) => AcceptanceOutcome::Cancelled,
            () = tokio::time::sleep(BROWSER_ACCEPTANCE_TIMEOUT) => AcceptanceOutcome::TimedOut,
        }
    });
    let acceptance = match outcome {
        AcceptanceOutcome::Response(Ok(response)) => {
            if let Some(error) = response.error {
                format!(
                    "acceptance snapshot failed: {} ({})",
                    error.message, error.code
                )
            } else if let Some(result) = response.result {
                match mcp_result_to_tool_output(result) {
                    Ok(snapshot) if !snapshot.reported_error && browser_output_has_state_evidence(&snapshot) => {
                        output.media.extend(snapshot.media);
                        format!("verified by automatic `{snapshot_tool}` after the action.\n\n{}", snapshot.text)
                    }
                    Ok(snapshot) => format!(
                        "automatic `{snapshot_tool}` returned without recognizable page-state evidence.\n\n{}",
                        snapshot.text
                    ),
                    Err(error) => format!("acceptance snapshot could not be decoded: {error}"),
                }
            } else {
                "acceptance snapshot returned no result".to_string()
            }
        }
        AcceptanceOutcome::Response(Err(error)) => {
            format!("acceptance snapshot failed: {error}")
        }
        AcceptanceOutcome::Cancelled => "acceptance snapshot was cancelled".to_string(),
        AcceptanceOutcome::TimedOut => format!(
            "acceptance snapshot timed out after {}s",
            BROWSER_ACCEPTANCE_TIMEOUT.as_secs()
        ),
    };
    output.text.push_str(&format!(
        "\n\n## Browser acceptance\nAction `{action_tool}` completed; {acceptance}"
    ));
}

async fn wait_for_mcp_idle_timeout(last_progress: Arc<Mutex<Option<Instant>>>, timeout: Duration) {
    loop {
        let elapsed = last_progress
            .lock()
            .ok()
            .and_then(|progress_at| progress_at.as_ref().map(Instant::elapsed));
        let Some(elapsed) = elapsed else {
            tokio::time::sleep(Duration::from_millis(25)).await;
            continue;
        };
        let Some(remaining) = timeout.checked_sub(elapsed) else {
            return;
        };
        tokio::time::sleep(remaining).await;
    }
}

/// Convert MCP's heterogeneous content blocks into the runtime's transport
/// neutral representation. Image bytes stay in `ToolMedia`; only textual
/// blocks and structured JSON are rendered into the context string.
fn mcp_result_to_tool_output(result: runtime::McpToolCallResult) -> Result<ToolOutput, ToolError> {
    let mut text_parts = Vec::new();
    let mut media = Vec::new();

    for content in result.content {
        match content.kind.as_str() {
            "text" => {
                if let Some(text) = content.data.get("text").and_then(Value::as_str) {
                    text_parts.push(text.to_string());
                }
            }
            "image" => {
                let media_type = content
                    .data
                    .get("mimeType")
                    .and_then(Value::as_str)
                    .unwrap_or("image/png")
                    .to_string();
                let data = content
                    .data
                    .get("data")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                if let Some(data) = data.filter(|data| !data.trim().is_empty()) {
                    media.push(ToolMedia::Image { media_type, data });
                }
            }
            "resource" => {
                let Some(resource) = content.data.get("resource").and_then(Value::as_object) else {
                    continue;
                };
                if let Some(text) = resource.get("text").and_then(Value::as_str) {
                    text_parts.push(text.to_string());
                }
                let media_type = resource
                    .get("mimeType")
                    .and_then(Value::as_str)
                    .unwrap_or("image/png")
                    .to_string();
                if media_type.starts_with("image/") {
                    if let Some(data) = resource
                        .get("blob")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .filter(|data| !data.trim().is_empty())
                    {
                        media.push(ToolMedia::Image { media_type, data });
                    }
                }
            }
            other => {
                text_parts.push(format!("[MCP content: {other}]"));
            }
        }
    }

    if let Some(structured) = result.structured_content {
        text_parts.push(format!("Structured content:\n{}", structured));
    }
    if text_parts.is_empty() && !media.is_empty() {
        text_parts.push("MCP tool returned image content attached to this result.".to_string());
    }

    Ok(ToolOutput {
        text: text_parts.join("\n\n"),
        media,
        reported_error: result.is_error.unwrap_or(false),
        evidence_text: None,
    })
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

/// Re-rank a kernel `ToolSearch` result against the catalog this Chat turn
/// actually has.
///
/// The kernel searches its own tool list; Chat additionally holds every
/// discovered MCP tool. Ranking the union in one pass — rather than appending
/// MCP hits after kernel hits and truncating — is what lets a single call for
/// `browser` return the whole family instead of one tool per call.
fn merge_mcp_tool_search_results(
    output: String,
    input: &str,
    search_tools: &BTreeMap<String, String>,
    unavailable_servers: &[String],
) -> String {
    let Ok(input) = serde_json::from_str::<Value>(input) else {
        return output;
    };
    let query = input
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let max_results = tools::tool_search_result_limit(
        &query,
        input
            .get("max_results")
            .and_then(Value::as_u64)
            .and_then(|value| usize::try_from(value).ok())
            .unwrap_or(tools::DEFAULT_TOOL_SEARCH_RESULTS),
    );
    let candidates = search_tools
        .iter()
        .map(|(name, description)| tools::ToolSearchCandidate {
            name,
            description,
        })
        .collect::<Vec<_>>();
    let mut matches = tools::rank_tool_search_candidates(&query, &candidates, max_results);

    if matches.is_empty() && unavailable_servers.is_empty() {
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
    // This turn's catalog is authoritative once it is known: the kernel searches
    // its whole tool list, which still contains names this turn blocked, and
    // those must not be advertised back to the model.
    if !search_tools.is_empty() {
        matches.truncate(max_results);
        *existing = matches.into_iter().map(Value::String).collect();
    }
    let total = object
        .get("total_deferred_tools")
        .and_then(Value::as_u64)
        .unwrap_or_default()
        .max(search_tools.len() as u64);
    object.insert(
        "total_deferred_tools".to_string(),
        Value::Number(total.into()),
    );
    if unavailable_servers.is_empty() {
        object.remove("pending_mcp_servers");
    } else {
        // Naming the servers that failed to start stops the model from
        // searching repeatedly for a tool that cannot appear this turn.
        object.insert(
            "pending_mcp_servers".to_string(),
            Value::Array(
                unavailable_servers
                    .iter()
                    .map(|server| Value::String(server.clone()))
                    .collect(),
            ),
        );
    }
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
    let cwd = runtime::execution_env_var_os("ARIS_WORKSPACE_ROOT")
        .map(PathBuf::from)
        .or_else(|| runtime::execution_current_dir().ok())
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

    let (tools, failures) =
        mcp_runtime.block_on(manager.discover_tools_resilient_with_timeout(MCP_DISCOVERY_TIMEOUT));
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
    let mut unavailable_servers = manager
        .unsupported_servers()
        .iter()
        .map(|server| server.server_name.clone())
        .collect::<Vec<_>>();
    let mut search_tools = tool_specs
        .iter()
        .map(|spec| (spec.name.clone(), spec.description.clone()))
        .collect::<BTreeMap<_, _>>();

    if feature_config.mcp().servers().is_empty() {
        return McpToolBundle {
            executor: McpToolExecutor {
                inner,
                runtime: None,
                manager: None,
                tool_names,
                search_tools,
                unavailable_servers,
                cancel_flag,
                timeout_policy_override: None,
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
            unavailable_servers.extend(
                feature_config
                    .mcp()
                    .servers()
                    .iter()
                    .map(|(name, _)| name.clone()),
            );
            return McpToolBundle {
                executor: McpToolExecutor {
                    inner,
                    runtime: None,
                    manager: None,
                    tool_names,
                    search_tools,
                    unavailable_servers,
                    cancel_flag,
                    timeout_policy_override: None,
                },
                tool_specs,
                warnings,
            };
        }
    };

    let (discovered, failures) =
        discover_mcp_tools_cached(&mut manager, feature_config, &mcp_runtime);
    warnings.extend(failures.into_iter().map(|(server, error)| {
        unavailable_servers.push(server.clone());
        format!("could not discover MCP server `{server}`: {error}")
    }));
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
        search_tools.insert(managed.qualified_name.clone(), description.clone());
        tool_specs.push(ChatToolSpec {
            name: managed.qualified_name,
            description,
            input_schema,
            required_permission: PermissionMode::DangerFullAccess,
        });
    }
    unavailable_servers.sort();
    unavailable_servers.dedup();

    McpToolBundle {
        executor: McpToolExecutor {
            inner,
            runtime: Some(mcp_runtime),
            manager: Some(manager),
            tool_names,
            search_tools,
            unavailable_servers,
            cancel_flag,
            timeout_policy_override: None,
        },
        tool_specs,
        warnings,
    }
}

#[must_use]
fn executor_tool_specs_for_tools(
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
fn permission_policy_for_tools_with<F>(
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
        /// Send the conversation-scoped routing header from the first request.
        /// Managed NewAPI gateways need this so a channel passthrough rule can
        /// forward it to an OpenCode Go upstream without an initial 400 probe.
        send_routing_session_header: bool,
        /// Which endpoint to use. `Auto` keeps the historical base-URL-derived
        /// choice; an explicit `Responses` preference still falls back to
        /// chat/completions at runtime when the gateway rejects the endpoint.
        transport: aris_executor::OpenAiTransport,
        /// Model ids this gateway is known to serve, when the caller knows
        /// them. Empty means *unknown*, not *none*: only a non-empty list is
        /// treated as authoritative, so a directly configured provider keeps
        /// working without one.
        known_models: Vec<String>,
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
                api_key,
                base_url,
                send_routing_session_header,
                transport: _,
                known_models,
            } => Self::OpenAiCompatible {
                api_key,
                base_url,
                send_routing_session_header,
                transport: aris_executor::OpenAiTransport::Auto,
                known_models,
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

/// The gateway's own model list, but only when this executor points at that
/// gateway.
///
/// The managed sign-in records the models it is entitled to; a directly
/// configured OpenAI-compatible provider in the same settings file must not
/// inherit them, or the summarizer would judge its model names against a
/// completely different service.
fn managed_models_for_gateway(obj: &Map<String, Value>, base_url: &str) -> Vec<String> {
    if !is_managed_newapi_gateway(obj, base_url) {
        return Vec::new();
    }
    obj.get("managed_models")
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|model| !model.is_empty())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn is_managed_newapi_gateway(obj: &Map<String, Value>, base_url: &str) -> bool {
    obj.get("newapi_executor_base_url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some_and(|managed| {
            managed
                .trim_end_matches('/')
                .eq_ignore_ascii_case(base_url.trim().trim_end_matches('/'))
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
            let send_routing_session_header = is_managed_newapi_gateway(obj, &base_url);
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
                    base_url: base_url.clone(),
                    send_routing_session_header,
                    transport,
                    known_models: managed_models_for_gateway(obj, &base_url),
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

fn build_executor_client_with_trace(
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
            send_routing_session_header,
            transport,
            known_models: _,
        } => {
            let mut client = aris_executor::OpenAIRuntimeClient::new(
                aris_executor::OpenAIExecutorConfig { api_key, base_url },
                model,
                enable_tools,
                tool_specs,
                observer,
            )?
            .with_transport(transport)
            .with_routing_session_header(send_routing_session_header);
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

fn resolve_summarizer_client_with_trace(
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
        ChatExecutorConfig::OpenAiCompatible { known_models, .. } => {
            // There is no portable "small model" name across arbitrary
            // OpenAI-compatible gateways. Use a cheap sibling only where the
            // model family makes the name unambiguous; unknown providers use
            // the deterministic compact summary instead of accidentally
            // spending the main model on a 120k-character summarization call.
            let sibling = if model_lower_starts_with(model, "gpt-5") {
                "gpt-5-mini"
            } else if model_lower_starts_with(model, "gpt-4o") {
                "gpt-4o-mini"
            } else if model_lower_starts_with(model, "gpt-4.1") {
                "gpt-4.1-mini"
            } else {
                return None;
            };
            // A family name is not a promise that the gateway carries the whole
            // family. The managed gateway serves gpt-5.x without any `-mini`,
            // so guessing there cost three retries and a degraded summary on
            // *every* compaction. Where the served models are known, the
            // sibling has to be among them.
            if known_models.is_empty()
                || known_models
                    .iter()
                    .any(|candidate| candidate.trim().eq_ignore_ascii_case(sibling))
            {
                Some(sibling.to_string())
            } else {
                None
            }
        }
    }
}

fn model_lower_starts_with(model: &str, prefix: &str) -> bool {
    model.to_ascii_lowercase().starts_with(prefix)
}

/// The interactive turn budgets, resolved once per process.
///
/// Chat is where a runaway turn actually costs the user something, so this is
/// where the operator override is honoured. Cached rather than read per turn:
/// `std::env::var` racing another thread's `set_var` is undefined behaviour, and
/// the budget is not meant to change mid-session anyway.
fn turn_iteration_budget() -> usize {
    static VALUE: OnceLock<usize> = OnceLock::new();
    *VALUE.get_or_init(runtime::max_turn_iterations_from_env)
}

fn turn_duration_budget() -> Option<std::time::Duration> {
    static VALUE: OnceLock<Option<std::time::Duration>> = OnceLock::new();
    *VALUE.get_or_init(runtime::max_turn_duration_from_env)
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
    .with_max_iterations(turn_iteration_budget())
    .with_max_turn_duration(turn_duration_budget())
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
