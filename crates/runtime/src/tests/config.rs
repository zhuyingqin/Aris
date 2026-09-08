use super::{
    ConfigLoader, ConfigSource, McpServerConfig, McpTransport, ResolvedPermissionMode,
    CLAUDE_CODE_SETTINGS_SCHEMA_NAME,
};
use crate::json::JsonValue;
use crate::sandbox::FilesystemIsolationMode;
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_dir() -> std::path::PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time should be after epoch")
        .as_nanos();
    std::env::temp_dir().join(format!("runtime-config-{nanos}"))
}

#[test]
fn rejects_non_object_settings_files() {
    let root = temp_dir();
    let cwd = root.join("project");
    let home = root.join("home").join(".claude");
    fs::create_dir_all(&home).expect("home config dir");
    fs::create_dir_all(&cwd).expect("project dir");
    fs::write(home.join("settings.json"), "[]").expect("write bad settings");

    let error = ConfigLoader::new(&cwd, &home)
        .load()
        .expect_err("config should fail");
    assert!(error
        .to_string()
        .contains("top-level settings value must be a JSON object"));

    fs::remove_dir_all(root).expect("cleanup temp dir");
}

#[test]
fn loads_and_merges_claude_code_config_files_by_precedence() {
    let root = temp_dir();
    let cwd = root.join("project");
    let home = root.join("home").join(".claude");
    fs::create_dir_all(cwd.join(".claude")).expect("project config dir");
    fs::create_dir_all(&home).expect("home config dir");

    fs::write(
        home.parent().expect("home parent").join(".claude.json"),
        r#"{"model":"haiku","env":{"A":"1"},"mcpServers":{"home":{"command":"uvx","args":["home"]}}}"#,
    )
    .expect("write user compat config");
    fs::write(
        home.join("settings.json"),
        r#"{"model":"sonnet","env":{"A2":"1"},"hooks":{"PreToolUse":["base"]},"permissions":{"defaultMode":"plan"}}"#,
    )
    .expect("write user settings");
    fs::write(
        cwd.join(".claude.json"),
        r#"{"model":"project-compat","env":{"B":"2"}}"#,
    )
    .expect("write project compat config");
    fs::write(
        cwd.join(".mcp.json"),
        r#"{"mcpServers":{"shared-project":{"command":"uvx","args":["shared-project"]}}}"#,
    )
    .expect("write shared project MCP config");
    fs::write(
        cwd.join(".claude").join("settings.json"),
        r#"{"env":{"C":"3"},"hooks":{"PostToolUse":["project"]},"mcpServers":{"project":{"command":"uvx","args":["project"]}}}"#,
    )
    .expect("write project settings");
    fs::write(
        cwd.join(".claude").join("settings.local.json"),
        r#"{"model":"opus","permissionMode":"acceptEdits"}"#,
    )
    .expect("write local settings");

    let loaded = ConfigLoader::new(&cwd, &home)
        .load()
        .expect("config should load");

    assert_eq!(CLAUDE_CODE_SETTINGS_SCHEMA_NAME, "SettingsSchema");
    assert_eq!(loaded.loaded_entries().len(), 6);
    assert_eq!(loaded.loaded_entries()[0].source, ConfigSource::User);
    assert_eq!(
        loaded.get("model"),
        Some(&JsonValue::String("opus".to_string()))
    );
    assert_eq!(loaded.model(), Some("opus"));
    assert_eq!(
        loaded.permission_mode(),
        Some(ResolvedPermissionMode::WorkspaceWrite)
    );
    assert_eq!(
        loaded
            .get("env")
            .and_then(JsonValue::as_object)
            .expect("env object")
            .len(),
        4
    );
    assert!(loaded
        .get("hooks")
        .and_then(JsonValue::as_object)
        .expect("hooks object")
        .contains_key("PreToolUse"));
    assert!(loaded
        .get("hooks")
        .and_then(JsonValue::as_object)
        .expect("hooks object")
        .contains_key("PostToolUse"));
    assert_eq!(loaded.hooks().pre_tool_use(), &["base".to_string()]);
    assert_eq!(loaded.hooks().post_tool_use(), &["project".to_string()]);
    assert!(loaded.mcp().get("home").is_some());
    assert!(loaded.mcp().get("shared-project").is_some());
    assert!(loaded.mcp().get("project").is_some());

    fs::remove_dir_all(root).expect("cleanup temp dir");
}

#[test]
fn application_global_mcp_scope_ignores_project_mcp_and_preserves_other_project_settings() {
    let root = temp_dir();
    let cwd = root.join("project");
    let home = root.join("home").join(".claude");
    let global_mcp = root.join("somniq").join("mcp.json");
    fs::create_dir_all(cwd.join(".claude")).expect("project config dir");
    fs::create_dir_all(&home).expect("home config dir");
    fs::create_dir_all(global_mcp.parent().expect("global config parent"))
        .expect("global config dir");

    fs::write(
        home.join("settings.json"),
        r#"{"mcpServers":{"user":{"command":"user-mcp"},"shared":{"command":"user-shared"}}}"#,
    )
    .expect("write user settings");
    fs::write(
        cwd.join(".mcp.json"),
        r#"{"mcpServers":{"project":{"command":"project-mcp"},"shared":{"command":"project-shared"}}}"#,
    )
    .expect("write project mcp");
    fs::write(
        cwd.join(".claude").join("settings.local.json"),
        r#"{"permissionMode":"acceptEdits","mcpServers":{"local":{"command":"local-mcp"}}}"#,
    )
    .expect("write project-local settings");
    fs::write(
        &global_mcp,
        r#"{"permissionMode":"bypassPermissions","mcpServers":{"global":{"command":"global-mcp"},"shared":{"command":"global-shared"}}}"#,
    )
    .expect("write global mcp");

    let loaded = ConfigLoader::new(&cwd, &home)
        .with_global_mcp_config(&global_mcp)
        .load()
        .expect("global MCP config should load");

    assert!(loaded.mcp().get("user").is_some());
    assert!(loaded.mcp().get("global").is_some());
    assert!(loaded.mcp().get("project").is_none());
    assert!(loaded.mcp().get("local").is_none());
    let shared = loaded.mcp().get("shared").expect("global override");
    match &shared.config {
        McpServerConfig::Stdio(config) => assert_eq!(config.command, "global-shared"),
        other => panic!("expected stdio config, got {other:?}"),
    }
    assert_eq!(shared.scope, ConfigSource::User);
    assert_eq!(
        loaded.permission_mode(),
        Some(ResolvedPermissionMode::WorkspaceWrite),
        "the MCP-only global file must not override project runtime policy"
    );

    fs::remove_dir_all(root).expect("cleanup temp dir");
}

#[test]
fn parses_sandbox_config() {
    let root = temp_dir();
    let cwd = root.join("project");
    let home = root.join("home").join(".claude");
    fs::create_dir_all(cwd.join(".claude")).expect("project config dir");
    fs::create_dir_all(&home).expect("home config dir");

    fs::write(
        cwd.join(".claude").join("settings.local.json"),
        r#"{
          "sandbox": {
            "enabled": true,
            "namespaceRestrictions": false,
            "networkIsolation": true,
            "filesystemMode": "allow-list",
            "allowedMounts": ["logs", "tmp/cache"]
          }
        }"#,
    )
    .expect("write local settings");

    let loaded = ConfigLoader::new(&cwd, &home)
        .load()
        .expect("config should load");

    assert_eq!(loaded.sandbox().enabled, Some(true));
    assert_eq!(loaded.sandbox().namespace_restrictions, Some(false));
    assert_eq!(loaded.sandbox().network_isolation, Some(true));
    assert_eq!(
        loaded.sandbox().filesystem_mode,
        Some(FilesystemIsolationMode::AllowList)
    );
    assert_eq!(loaded.sandbox().allowed_mounts, vec!["logs", "tmp/cache"]);

    fs::remove_dir_all(root).expect("cleanup temp dir");
}

// v0.4.13 regression — issue #238. parse_optional_sandbox_config must
// round-trip the `strictMode` field (camelCase per the merged settings
// schema) into the new SandboxConfig::strict_mode option, in all three
// states: true (hard-lock policy), false (explicit non-strict), and
// missing (default permissive / pre-v0.4.12 behaviour). Each state is
// exercised in an isolated temp dir to avoid cross-fixture state.
#[test]
fn parses_sandbox_strict_mode() {
    fn load_with(local_json: &str) -> crate::sandbox::SandboxConfig {
        let root = temp_dir();
        let cwd = root.join("project");
        let home = root.join("home").join(".claude");
        fs::create_dir_all(cwd.join(".claude")).expect("project config dir");
        fs::create_dir_all(&home).expect("home config dir");
        fs::write(cwd.join(".claude").join("settings.local.json"), local_json)
            .expect("write local settings");
        let loaded = ConfigLoader::new(&cwd, &home)
            .load()
            .expect("config should load");
        let sandbox = loaded.sandbox().clone();
        fs::remove_dir_all(root).expect("cleanup temp dir");
        sandbox
    }

    let strict_true = load_with(r#"{"sandbox":{"enabled":true,"strictMode":true}}"#);
    assert_eq!(strict_true.strict_mode, Some(true));
    assert!(strict_true.is_strict());

    let strict_false = load_with(r#"{"sandbox":{"enabled":true,"strictMode":false}}"#);
    assert_eq!(strict_false.strict_mode, Some(false));
    assert!(!strict_false.is_strict());

    let strict_missing = load_with(r#"{"sandbox":{"enabled":true}}"#);
    assert_eq!(strict_missing.strict_mode, None);
    assert!(!strict_missing.is_strict());
}

#[test]
fn parses_typed_mcp_and_oauth_config() {
    let root = temp_dir();
    let cwd = root.join("project");
    let home = root.join("home").join(".claude");
    fs::create_dir_all(cwd.join(".claude")).expect("project config dir");
    fs::create_dir_all(&home).expect("home config dir");

    fs::write(
        home.join("settings.json"),
        r#"{
          "mcpServers": {
            "stdio-server": {
              "command": "uvx",
              "args": ["mcp-server"],
              "env": {"TOKEN": "secret"}
            },
            "remote-server": {
              "type": "http",
              "url": "https://example.test/mcp",
              "headers": {"Authorization": "Bearer token"},
              "headersHelper": "helper.sh",
              "oauth": {
                "clientId": "mcp-client",
                "callbackPort": 7777,
                "authServerMetadataUrl": "https://issuer.test/.well-known/oauth-authorization-server",
                "xaa": true
              }
            }
          },
          "oauth": {
            "clientId": "runtime-client",
            "authorizeUrl": "https://console.test/oauth/authorize",
            "tokenUrl": "https://console.test/oauth/token",
            "callbackPort": 54545,
            "manualRedirectUrl": "https://console.test/oauth/callback",
            "scopes": ["org:read", "user:write"]
          }
        }"#,
    )
    .expect("write user settings");
    fs::write(
        cwd.join(".claude").join("settings.local.json"),
        r#"{
          "mcpServers": {
            "remote-server": {
              "type": "ws",
              "url": "wss://override.test/mcp",
              "headers": {"X-Env": "local"}
            }
          }
        }"#,
    )
    .expect("write local settings");

    let loaded = ConfigLoader::new(&cwd, &home)
        .load()
        .expect("config should load");

    let stdio_server = loaded
        .mcp()
        .get("stdio-server")
        .expect("stdio server should exist");
    assert_eq!(stdio_server.scope, ConfigSource::User);
    assert_eq!(stdio_server.transport(), McpTransport::Stdio);

    let remote_server = loaded
        .mcp()
        .get("remote-server")
        .expect("remote server should exist");
    assert_eq!(remote_server.scope, ConfigSource::Local);
    assert_eq!(remote_server.transport(), McpTransport::Ws);
    match &remote_server.config {
        McpServerConfig::Ws(config) => {
            assert_eq!(config.url, "wss://override.test/mcp");
            assert_eq!(
                config.headers.get("X-Env").map(String::as_str),
                Some("local")
            );
        }
        other => panic!("expected ws config, got {other:?}"),
    }

    let oauth = loaded.oauth().expect("oauth config should exist");
    assert_eq!(oauth.client_id, "runtime-client");
    assert_eq!(oauth.callback_port, Some(54_545));
    assert_eq!(oauth.scopes, vec!["org:read", "user:write"]);

    fs::remove_dir_all(root).expect("cleanup temp dir");
}

#[test]
fn rejects_invalid_mcp_server_shapes() {
    let root = temp_dir();
    let cwd = root.join("project");
    let home = root.join("home").join(".claude");
    fs::create_dir_all(&home).expect("home config dir");
    fs::create_dir_all(&cwd).expect("project dir");
    fs::write(
        home.join("settings.json"),
        r#"{"mcpServers":{"broken":{"type":"http","url":123}}}"#,
    )
    .expect("write broken settings");

    let error = ConfigLoader::new(&cwd, &home)
        .load()
        .expect_err("config should fail");
    assert!(error
        .to_string()
        .contains("mcpServers.broken: missing string field url"));

    fs::remove_dir_all(root).expect("cleanup temp dir");
}

#[test]
fn loads_object_style_claude_code_hooks_as_commands() {
    let root = temp_dir();
    let cwd = root.join("project");
    let home = root.join("home").join(".claude");
    fs::create_dir_all(cwd.join(".claude")).expect("project config dir");
    fs::create_dir_all(&home).expect("home config dir");

    fs::write(
        cwd.join(".claude").join("settings.json"),
        r#"{
          "hooks": {
            "PreToolUse": [
              {
                "matcher": "Bash",
                "hooks": [
                  {
                    "type": "command",
                    "command": "echo pre",
                    "timeout": 5,
                    "async": true
                  }
                ]
              }
            ],
            "PostToolUse": [
              {
                "matcher": "",
                "hooks": [
                  {
                    "type": "command",
                    "command": "echo post"
                  }
                ]
              }
            ]
          }
        }"#,
    )
    .expect("write object-style hooks settings");

    let loaded = ConfigLoader::new(&cwd, &home)
        .load()
        .expect("object-style hooks should load");

    assert_eq!(loaded.hooks().pre_tool_use(), &["echo pre".to_string()]);
    assert_eq!(loaded.hooks().post_tool_use(), &["echo post".to_string()]);

    fs::remove_dir_all(root).expect("cleanup temp dir");
}

#[test]
fn parses_per_server_mcp_request_timeout() {
    // v0.4.13 P1.D: `requestTimeoutSecs` on a stdio MCP server
    // entry should round-trip into
    // `McpStdioServerConfig.request_timeout_secs`. Entries
    // without it must leave the field `None` so the global env /
    // 300s default still applies.
    let root = temp_dir();
    let cwd = root.join("project");
    let home = root.join("home").join(".claude");
    fs::create_dir_all(cwd.join(".claude")).expect("project config dir");
    fs::create_dir_all(&home).expect("home config dir");

    fs::write(
        home.join("settings.json"),
        r#"{
          "mcpServers": {
            "fast": {
              "command": "uvx",
              "args": ["fast-mcp"]
            },
            "slow-agent": {
              "command": "codex",
              "args": ["mcp-server"],
              "requestTimeoutSecs": 900
            }
          }
        }"#,
    )
    .expect("write settings");

    let loaded = ConfigLoader::new(&cwd, &home)
        .load()
        .expect("config should load");

    let fast = loaded.mcp().get("fast").expect("fast server");
    match &fast.config {
        McpServerConfig::Stdio(stdio) => {
            assert_eq!(
                stdio.request_timeout_secs, None,
                "absent requestTimeoutSecs should round-trip to None"
            );
        }
        other => panic!("expected stdio config, got {other:?}"),
    }

    let slow = loaded.mcp().get("slow-agent").expect("slow-agent server");
    match &slow.config {
        McpServerConfig::Stdio(stdio) => {
            assert_eq!(stdio.request_timeout_secs, Some(900));
        }
        other => panic!("expected stdio config, got {other:?}"),
    }

    fs::remove_dir_all(root).expect("cleanup temp dir");
}
