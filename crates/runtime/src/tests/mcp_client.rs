use std::collections::BTreeMap;

use crate::config::{
    ConfigSource, McpOAuthConfig, McpRemoteServerConfig, McpSdkServerConfig, McpServerConfig,
    McpStdioServerConfig, McpWebSocketServerConfig, ScopedMcpServerConfig,
};

use super::{McpClientAuth, McpClientBootstrap, McpClientTransport};

#[test]
fn bootstraps_stdio_servers_into_transport_targets() {
    let config = ScopedMcpServerConfig {
        scope: ConfigSource::User,
        config: McpServerConfig::Stdio(McpStdioServerConfig {
            command: "uvx".to_string(),
            args: vec!["mcp-server".to_string()],
            env: BTreeMap::from([("TOKEN".to_string(), "secret".to_string())]),
            request_timeout_secs: None,
        }),
    };

    let bootstrap = McpClientBootstrap::from_scoped_config("stdio-server", &config);
    assert_eq!(bootstrap.normalized_name, "stdio-server");
    assert_eq!(bootstrap.tool_prefix, "mcp__stdio-server__");
    assert_eq!(
        bootstrap.signature.as_deref(),
        Some("stdio:[uvx|mcp-server]")
    );
    match bootstrap.transport {
        McpClientTransport::Stdio(transport) => {
            assert_eq!(transport.command, "uvx");
            assert_eq!(transport.args, vec!["mcp-server"]);
            assert_eq!(
                transport.env.get("TOKEN").map(String::as_str),
                Some("secret")
            );
        }
        other => panic!("expected stdio transport, got {other:?}"),
    }
}

#[test]
fn bootstraps_remote_servers_with_oauth_auth() {
    let config = ScopedMcpServerConfig {
        scope: ConfigSource::Project,
        config: McpServerConfig::Http(McpRemoteServerConfig {
            url: "https://vendor.example/mcp".to_string(),
            headers: BTreeMap::from([("X-Test".to_string(), "1".to_string())]),
            headers_helper: Some("helper.sh".to_string()),
            oauth: Some(McpOAuthConfig {
                client_id: Some("client-id".to_string()),
                callback_port: Some(7777),
                auth_server_metadata_url: Some(
                    "https://issuer.example/.well-known/oauth-authorization-server".to_string(),
                ),
                xaa: Some(true),
            }),
        }),
    };

    let bootstrap = McpClientBootstrap::from_scoped_config("remote server", &config);
    assert_eq!(bootstrap.normalized_name, "remote_server");
    match bootstrap.transport {
        McpClientTransport::Http(transport) => {
            assert_eq!(transport.url, "https://vendor.example/mcp");
            assert_eq!(transport.headers_helper.as_deref(), Some("helper.sh"));
            assert!(transport.auth.requires_user_auth());
            match transport.auth {
                McpClientAuth::OAuth(oauth) => {
                    assert_eq!(oauth.client_id.as_deref(), Some("client-id"));
                }
                other @ McpClientAuth::None => panic!("expected oauth auth, got {other:?}"),
            }
        }
        other => panic!("expected http transport, got {other:?}"),
    }
}

#[test]
fn bootstraps_websocket_and_sdk_transports_without_oauth() {
    let ws = ScopedMcpServerConfig {
        scope: ConfigSource::Local,
        config: McpServerConfig::Ws(McpWebSocketServerConfig {
            url: "wss://vendor.example/mcp".to_string(),
            headers: BTreeMap::new(),
            headers_helper: None,
        }),
    };
    let sdk = ScopedMcpServerConfig {
        scope: ConfigSource::Local,
        config: McpServerConfig::Sdk(McpSdkServerConfig {
            name: "sdk-server".to_string(),
        }),
    };

    let ws_bootstrap = McpClientBootstrap::from_scoped_config("ws server", &ws);
    match ws_bootstrap.transport {
        McpClientTransport::WebSocket(transport) => {
            assert_eq!(transport.url, "wss://vendor.example/mcp");
            assert!(!transport.auth.requires_user_auth());
        }
        other => panic!("expected websocket transport, got {other:?}"),
    }

    let sdk_bootstrap = McpClientBootstrap::from_scoped_config("sdk server", &sdk);
    assert_eq!(sdk_bootstrap.signature, None);
    match sdk_bootstrap.transport {
        McpClientTransport::Sdk(transport) => {
            assert_eq!(transport.name, "sdk-server");
        }
        other => panic!("expected sdk transport, got {other:?}"),
    }
}
