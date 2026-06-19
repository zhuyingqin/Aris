use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::mail;

const GMAIL_PLUGIN_JSON: &str = include_str!("../../connectors/gmail/.codex-plugin/plugin.json");
const GMAIL_APP_JSON: &str = include_str!("../../connectors/gmail/.app.json");
const OUTLOOK_PLUGIN_JSON: &str =
    include_str!("../../connectors/outlook-email/.codex-plugin/plugin.json");
const OUTLOOK_APP_JSON: &str = include_str!("../../connectors/outlook-email/.app.json");

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginManifest {
    name: String,
    version: String,
    interface: PluginInterface,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginInterface {
    display_name: String,
    short_description: String,
    long_description: String,
    developer_name: String,
    category: String,
    capabilities: Vec<String>,
    website_url: Option<String>,
    privacy_policy_url: Option<String>,
    terms_of_service_url: Option<String>,
    brand_color: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct AppManifest {
    apps: BTreeMap<String, AppConnector>,
}

#[derive(Debug, Clone, Deserialize)]
struct AppConnector {
    id: String,
    #[serde(default)]
    provider: String,
    #[serde(default)]
    required: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorPluginView {
    id: String,
    connector_id: String,
    provider: String,
    version: String,
    display_name: String,
    short_description: String,
    long_description: String,
    developer_name: String,
    category: String,
    capabilities: Vec<String>,
    website_url: Option<String>,
    privacy_policy_url: Option<String>,
    terms_of_service_url: Option<String>,
    brand_color: Option<String>,
    required: bool,
    installed: bool,
    connected: bool,
    connected_accounts: Vec<String>,
    transport: String,
    status_message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorActionResult {
    ok: bool,
    message: String,
    plugin: ConnectorPluginView,
}

struct EmbeddedConnector {
    plugin_json: &'static str,
    app_json: &'static str,
}

const EMBEDDED_CONNECTORS: &[EmbeddedConnector] = &[
    EmbeddedConnector {
        plugin_json: GMAIL_PLUGIN_JSON,
        app_json: GMAIL_APP_JSON,
    },
    EmbeddedConnector {
        plugin_json: OUTLOOK_PLUGIN_JSON,
        app_json: OUTLOOK_APP_JSON,
    },
];

fn parse_connector(bundle: &EmbeddedConnector) -> Result<ConnectorPluginView, String> {
    let plugin: PluginManifest =
        serde_json::from_str(bundle.plugin_json).map_err(|error| error.to_string())?;
    let apps: AppManifest =
        serde_json::from_str(bundle.app_json).map_err(|error| error.to_string())?;
    let (app_name, app) = apps
        .apps
        .into_iter()
        .next()
        .ok_or_else(|| format!("connector plugin `{}` has no app entry", plugin.name))?;
    let provider = if app.provider.is_empty() {
        app_name
    } else {
        app.provider
    };
    let connected_accounts = mail::connected_account_labels(&provider);
    let connected = !connected_accounts.is_empty();
    let status_message = if connected {
        format!("Connected to {} account(s)", connected_accounts.len())
    } else {
        "Ready to connect. Current implementation uses the built-in Mail OAuth fallback until the hosted connector runtime is available.".to_string()
    };
    Ok(ConnectorPluginView {
        id: plugin.name,
        connector_id: app.id,
        provider,
        version: plugin.version,
        display_name: plugin.interface.display_name,
        short_description: plugin.interface.short_description,
        long_description: plugin.interface.long_description,
        developer_name: plugin.interface.developer_name,
        category: plugin.interface.category,
        capabilities: plugin.interface.capabilities,
        website_url: plugin.interface.website_url,
        privacy_policy_url: plugin.interface.privacy_policy_url,
        terms_of_service_url: plugin.interface.terms_of_service_url,
        brand_color: plugin.interface.brand_color,
        required: app.required,
        installed: true,
        connected,
        connected_accounts,
        transport: "connector-fallback".to_string(),
        status_message,
    })
}

fn connector_plugins() -> Result<Vec<ConnectorPluginView>, String> {
    EMBEDDED_CONNECTORS
        .iter()
        .map(parse_connector)
        .collect::<Result<Vec<_>, _>>()
}

fn connector_by_id(id: &str) -> Result<ConnectorPluginView, String> {
    connector_plugins()?
        .into_iter()
        .find(|plugin| plugin.id == id)
        .ok_or_else(|| format!("unknown connector plugin: {id}"))
}

#[tauri::command]
pub fn connector_plugins_list() -> Result<Vec<ConnectorPluginView>, String> {
    connector_plugins()
}

#[tauri::command]
pub async fn connector_connect(id: String) -> Result<ConnectorActionResult, String> {
    let plugin = connector_by_id(&id)?;
    let provider = plugin.provider.clone();
    let _ = mail::mail_connect(provider).await?;
    let plugin = connector_by_id(&id)?;
    Ok(ConnectorActionResult {
        ok: true,
        message: format!("{} connected", plugin.display_name),
        plugin,
    })
}
