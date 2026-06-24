// Bundled ARIS skills compiled in from assets/skills/ via build.rs
include!(concat!(env!("OUT_DIR"), "/bundled_skills.rs"));

mod bash;
mod bootstrap;
mod cache;
mod compact;
mod config;
mod conversation;
pub mod event_sink;
mod file_ops;
mod hooks;
mod hot_memory;
mod json;
mod knowledge_memory;
mod mcp;
mod mcp_client;
mod mcp_stdio;
mod memory_provider;
mod oauth;
mod permissions;
mod process;
mod process_registry;
mod prompt;
mod remote;
pub mod sandbox;
mod session;
mod session_index;
mod usage;

pub use bash::{execute_bash, execute_bash_with_cancel, BashCommandInput, BashCommandOutput};
pub use bootstrap::{BootstrapPhase, BootstrapPlan};
pub use cache::{extract_bundle, extraction_report, ExtractionError, ExtractionReport};
pub use compact::{
    estimate_session_tokens, format_compact_summary, get_compact_continuation_message,
    should_compact, CompactionConfig, CompactionResult, CompactionSource, CompactionSummarySource,
};
pub use config::{
    ConfigEntry, ConfigError, ConfigLoader, ConfigSource, McpClaudeAiProxyServerConfig,
    McpConfigCollection, McpOAuthConfig, McpRemoteServerConfig, McpSdkServerConfig,
    McpServerConfig, McpStdioServerConfig, McpTransport, McpWebSocketServerConfig, OAuthConfig,
    ResolvedPermissionMode, RuntimeConfig, RuntimeFeatureConfig, RuntimeHookConfig,
    ScopedMcpServerConfig, CLAUDE_CODE_SETTINGS_SCHEMA_NAME,
};
pub use conversation::{
    assistant_text_from_turn_summary, auto_compaction_threshold_from_env, ApiClient, ApiRequest,
    AssistantEvent, AutoCompactionEvent, ConversationRuntime, RuntimeError, StaticToolExecutor,
    ToolError, ToolExecutor, TurnSummary,
};
pub use event_sink::{
    now_iso8601, today_iso, EventSink, EventType, JsonlEventSink, MetaLoggingLevel, NoopEventSink,
    RuntimeEvent,
};
pub use file_ops::{
    append_file, edit_file, glob_search, grep_search, read_file, write_file, AppendFileOutput,
    EditFileOutput, FileChange, GlobSearchOutput, GrepSearchInput, GrepSearchOutput,
    ReadFileOutput, StructuredPatchHunk, TextFilePayload, WriteFileOutput,
};
pub use hooks::{HookEvent, HookRunResult, HookRunner};
pub use hot_memory::{
    add_hot_memory, approve_pending, hot_memory_dir, knowledge_memory_dir, list_pending,
    list_pending_for_scope, load_hot_memory, memory_write_approval_enabled, new_pending_write,
    project_scope, reject_pending, remove_hot_memory, render_hot_memory_prompt, replace_hot_memory,
    stage_memory_write, HotMemoryEntry, HotMemorySnapshot, HotMemoryTarget, PendingMemoryWrite,
};
pub use knowledge_memory::{
    load_knowledge_memory_catalog, migrate_legacy_knowledge_memory, render_knowledge_memory_prompt,
    KnowledgeMemoryEntry,
};
pub use mcp::{
    mcp_server_signature, mcp_tool_name, mcp_tool_prefix, normalize_name_for_mcp,
    scoped_mcp_config_hash, unwrap_ccr_proxy_url,
};
pub use mcp_client::{
    McpClaudeAiProxyTransport, McpClientAuth, McpClientBootstrap, McpClientTransport,
    McpRemoteTransport, McpSdkTransport, McpStdioTransport,
};
pub use mcp_stdio::{
    spawn_mcp_stdio_process, JsonRpcError, JsonRpcId, JsonRpcRequest, JsonRpcResponse,
    ManagedMcpTool, McpInitializeClientInfo, McpInitializeParams, McpInitializeResult,
    McpInitializeServerInfo, McpListResourcesParams, McpListResourcesResult, McpListToolsParams,
    McpListToolsResult, McpReadResourceParams, McpReadResourceResult, McpResource,
    McpResourceContents, McpServerManager, McpServerManagerError, McpStdioProcess, McpTool,
    McpToolCallContent, McpToolCallParams, McpToolCallResult, UnsupportedMcpServer,
};
pub use memory_provider::{MemoryProvider, MemoryProviderContext, MemoryProviderManager};
pub use oauth::{
    clear_oauth_credentials, code_challenge_s256, credentials_path, generate_pkce_pair,
    generate_state, load_oauth_credentials, loopback_redirect_uri, parse_oauth_callback_query,
    parse_oauth_callback_request_target, save_oauth_credentials, OAuthAuthorizationRequest,
    OAuthCallbackParams, OAuthRefreshRequest, OAuthTokenExchangeRequest, OAuthTokenSet,
    PkceChallengeMethod, PkceCodePair,
};
pub use permissions::{
    PermissionMode, PermissionOutcome, PermissionPolicy, PermissionPromptDecision,
    PermissionPrompter, PermissionRequest,
};
pub use process::{hidden_command, hidden_tokio_command, hide_window};
pub use process_registry::{
    configure_managed_tokio_command, managed_processes_snapshot, register_managed_process,
    run_managed_command, run_managed_command_with_cancel, spawn_managed_background,
    terminate_all_managed_processes, terminate_managed_process_tree, unregister_managed_process,
    ManagedCommandOutput, ManagedProcessGuard, ManagedProcessInfo, ManagedProcessKind,
};
pub use prompt::{
    load_system_prompt, prepend_bullets, team_orchestration_section, ContextFile, ProjectContext,
    PromptBuildError, SystemPromptBuilder, SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
};
pub use remote::{
    inherited_upstream_proxy_env, no_proxy_list, read_token, upstream_proxy_ws_url,
    RemoteSessionContext, UpstreamProxyBootstrap, UpstreamProxyState, DEFAULT_REMOTE_BASE_URL,
    DEFAULT_SESSION_TOKEN_PATH, DEFAULT_SYSTEM_CA_BUNDLE, NO_PROXY_HOSTS, UPSTREAM_PROXY_ENV_KEYS,
};
pub use session::{
    ContentBlock, ConversationMessage, MessageRole, Session, SessionCompactionRecord, SessionError,
};
pub use session_index::{
    index_session, search_sessions, sessions_dir_from_env, sync_sessions_dir, SessionBrowseEntry,
    SessionSearchHit, SessionSearchMessage, SessionSearchResult,
};
pub use usage::{
    format_usd, pricing_for_model, ModelPricing, TokenUsage, UsageCostEstimate, UsageTracker,
};

/// Cross-platform home directory. Uses HOME on Unix, USERPROFILE on Windows.
#[must_use]
pub fn home_dir() -> String {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".into())
}

pub const ARIS_ENABLE_CLAUDE_SKILLS_ENV: &str = "ARIS_ENABLE_CLAUDE_SKILLS";

/// ARIS user-level skills directory.
#[must_use]
pub fn aris_user_skills_dir() -> std::path::PathBuf {
    std::path::PathBuf::from(home_dir())
        .join(".config")
        .join("aris")
        .join("skills")
}

/// ARIS project-level skills directory.
#[must_use]
pub fn aris_project_skills_dir(cwd: impl AsRef<std::path::Path>) -> std::path::PathBuf {
    cwd.as_ref().join(".aris").join("skills")
}

/// Legacy Claude Code user-level skills directory.
#[must_use]
pub fn claude_user_skills_dir() -> std::path::PathBuf {
    std::path::PathBuf::from(home_dir())
        .join(".claude")
        .join("skills")
}

/// Legacy Claude Code project-level skills directory.
#[must_use]
pub fn claude_project_skills_dir(cwd: impl AsRef<std::path::Path>) -> std::path::PathBuf {
    cwd.as_ref().join(".claude").join("skills")
}

/// Whether ARIS should include legacy Claude Code skills in discovery.
///
/// ARIS keeps this as an explicit compatibility bridge so Claude Code skills do
/// not silently become part of the default ARIS skill namespace.
#[must_use]
pub fn legacy_claude_skills_enabled() -> bool {
    std::env::var(ARIS_ENABLE_CLAUDE_SKILLS_ENV)
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

/// Global interrupt flag set by SIGINT handler. Streaming loops check this
/// between chunks/iterations to allow Ctrl+C to interrupt long operations.
pub static INTERRUPTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[must_use]
pub fn is_interrupted() -> bool {
    INTERRUPTED.load(std::sync::atomic::Ordering::SeqCst)
}

pub fn clear_interrupt() {
    INTERRUPTED.store(false, std::sync::atomic::Ordering::SeqCst);
}

pub fn set_interrupt() {
    INTERRUPTED.store(true, std::sync::atomic::Ordering::SeqCst);
}

#[cfg(test)]
pub(crate) fn test_env_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
