use std::collections::BTreeMap;

use crate::config::{
    ConfigSource, McpRemoteServerConfig, McpServerConfig, McpStdioServerConfig,
    McpWebSocketServerConfig, ScopedMcpServerConfig,
};

use super::{
    mcp_server_signature, mcp_tool_name, normalize_name_for_mcp, scoped_mcp_config_hash,
    unwrap_ccr_proxy_url,
};

#[test]
fn normalizes_server_names_for_mcp_tooling() {
    assert_eq!(normalize_name_for_mcp("github.com"), "github_com");
    assert_eq!(normalize_name_for_mcp("tool name!"), "tool_name_");
    assert_eq!(
        normalize_name_for_mcp("claude.ai Example   Server!!"),
        "claude_ai_Example_Server"
    );
    assert_eq!(
        mcp_tool_name("claude.ai Example Server", "weather tool"),
        "mcp__claude_ai_Example_Server__weather_tool"
    );
}

#[test]
fn unwraps_ccr_proxy_urls_for_signature_matching() {
    let wrapped = "https://api.anthropic.com/v2/session_ingress/shttp/mcp/123?mcp_url=https%3A%2F%2Fvendor.example%2Fmcp&other=1";
    assert_eq!(unwrap_ccr_proxy_url(wrapped), "https://vendor.example/mcp");
    assert_eq!(
        unwrap_ccr_proxy_url("https://vendor.example/mcp"),
        "https://vendor.example/mcp"
    );
}

#[test]
fn computes_signatures_for_stdio_and_remote_servers() {
    let stdio = McpServerConfig::Stdio(McpStdioServerConfig {
        command: "uvx".to_string(),
        args: vec!["mcp-server".to_string()],
        env: BTreeMap::from([("TOKEN".to_string(), "secret".to_string())]),
        request_timeout_secs: None,
    });
    assert_eq!(
        mcp_server_signature(&stdio),
        Some("stdio:[uvx|mcp-server]".to_string())
    );

    let remote = McpServerConfig::Ws(McpWebSocketServerConfig {
        url: "https://api.anthropic.com/v2/ccr-sessions/1?mcp_url=wss%3A%2F%2Fvendor.example%2Fmcp"
            .to_string(),
        headers: BTreeMap::new(),
        headers_helper: None,
    });
    assert_eq!(
        mcp_server_signature(&remote),
        Some("url:wss://vendor.example/mcp".to_string())
    );
}

#[test]
fn scoped_hash_ignores_scope_but_tracks_config_content() {
    let base_config = McpServerConfig::Http(McpRemoteServerConfig {
        url: "https://vendor.example/mcp".to_string(),
        headers: BTreeMap::from([("Authorization".to_string(), "Bearer token".to_string())]),
        headers_helper: Some("helper.sh".to_string()),
        oauth: None,
    });
    let user = ScopedMcpServerConfig {
        scope: ConfigSource::User,
        config: base_config.clone(),
    };
    let local = ScopedMcpServerConfig {
        scope: ConfigSource::Local,
        config: base_config,
    };
    assert_eq!(
        scoped_mcp_config_hash(&user),
        scoped_mcp_config_hash(&local)
    );

    let changed = ScopedMcpServerConfig {
        scope: ConfigSource::Local,
        config: McpServerConfig::Http(McpRemoteServerConfig {
            url: "https://vendor.example/v2/mcp".to_string(),
            headers: BTreeMap::new(),
            headers_helper: None,
            oauth: None,
        }),
    };
    assert_ne!(
        scoped_mcp_config_hash(&user),
        scoped_mcp_config_hash(&changed)
    );
}
