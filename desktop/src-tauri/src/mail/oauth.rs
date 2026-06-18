//! OAuth2 Authorization-Code-with-PKCE flow for desktop, using a loopback
//! redirect. We bind a local `127.0.0.1` port, open the system browser to
//! the provider consent screen, capture the `?code=` redirect on that port,
//! and exchange it for tokens. Refresh tokens are persisted by `store.rs`;
//! `ensure_access_token` transparently refreshes expiring tokens before any
//! API call.
//!
//! Everything here is synchronous (std TcpListener + `reqwest::blocking`) and
//! is expected to run inside `tauri::async_runtime::spawn_blocking`, mirroring
//! the literature module's offload pattern.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::distributions::Alphanumeric;
use rand::Rng;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::model::Provider;
use super::store::{self, OauthConfig, StoredAccount};

/// Fixed loopback port for Google OAuth. Keep this stable because Google
/// validates the redirect URI against the OAuth client registration.
const GOOGLE_LOOPBACK_PORT: u16 = 8765;
const GMAIL_SCOPE: &str = "https://www.googleapis.com/auth/gmail.modify";

/// Provider-specific OAuth endpoints and scope set.
struct Endpoints {
    auth_url: &'static str,
    token_url: &'static str,
    scopes: &'static str,
    /// Loopback host the provider expects in the redirect URI.
    redirect_host: &'static str,
    /// Whether the token exchange must include `client_secret` (Google's
    /// "Desktop app" clients require it; Microsoft public clients do not).
    uses_secret: bool,
    /// Fixed local callback port. Microsoft localhost redirect URIs ignore the
    /// port during matching, so Outlook can use an ephemeral port and avoid
    /// collisions with other local apps.
    fixed_port: Option<u16>,
    /// Extra query params for the authorize request.
    extra_auth_params: &'static [(&'static str, &'static str)],
}

fn endpoints(provider: Provider) -> Endpoints {
    match provider {
        Provider::Gmail => Endpoints {
            auth_url: "https://accounts.google.com/o/oauth2/v2/auth",
            token_url: "https://oauth2.googleapis.com/token",
            scopes: GMAIL_SCOPE,
            redirect_host: "127.0.0.1",
            uses_secret: true,
            fixed_port: Some(GOOGLE_LOOPBACK_PORT),
            // access_type=offline + prompt=consent guarantees a refresh token.
            extra_auth_params: &[("access_type", "offline"), ("prompt", "consent")],
        },
        Provider::Outlook => Endpoints {
            auth_url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
            token_url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
            scopes: "offline_access Mail.ReadWrite Mail.Send User.Read",
            redirect_host: "localhost",
            uses_secret: false,
            fixed_port: None,
            extra_auth_params: &[("prompt", "select_account")],
        },
        Provider::Imap => panic!("IMAP accounts do not use OAuth loopback connect"),
    }
}

fn client_credentials(provider: Provider, cfg: &OauthConfig) -> Result<(String, String), String> {
    match provider {
        Provider::Gmail => {
            if cfg.gmail_client_id.trim().is_empty() || cfg.gmail_client_secret.trim().is_empty() {
                return Err(
                    "Gmail OAuth is not configured. Add the client ID and client secret in \
                     Settings → Mail (create a Desktop app OAuth client in Google Cloud Console)."
                        .to_string(),
                );
            }
            Ok((
                cfg.gmail_client_id.trim().to_string(),
                cfg.gmail_client_secret.trim().to_string(),
            ))
        }
        Provider::Outlook => {
            let client_id = store::effective_outlook_client_id(cfg).ok_or_else(|| {
                "ARIS Outlook OAuth is not configured in this build. \
                 Set ARIS_OUTLOOK_CLIENT_ID to the Microsoft Entra application \
                 client ID when building the desktop app."
                    .to_string()
            })?;
            Ok((client_id, String::new()))
        }
        Provider::Imap => Err("IMAP accounts use mail_generic_connect, not OAuth.".to_string()),
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn random_token(len: usize) -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(len)
        .map(char::from)
        .collect()
}

fn pkce_challenge(verifier: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(hasher.finalize())
}

fn open_browser(url: &str) {
    // On Windows we must NOT use `cmd /c start <url>`: the auth URL is full of
    // `&` query separators, which cmd interprets as command separators, so the
    // browser only receives the URL up to the first `&`. `rundll32
    // FileProtocolHandler` hands the full URL to the default handler with no
    // shell re-parsing.
    let result = if cfg!(target_os = "windows") {
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", url])
            .spawn()
    } else if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(url).spawn()
    } else {
        std::process::Command::new("xdg-open").arg(url).spawn()
    };
    if let Err(error) = result {
        eprintln!("mail oauth: failed to open browser: {error}");
    }
}

fn bind_loopback_listener(
    provider: Provider,
    fixed_port: Option<u16>,
) -> Result<TcpListener, String> {
    let port = fixed_port.unwrap_or(0);
    TcpListener::bind(("127.0.0.1", port)).map_err(|error| {
        let target = if let Some(port) = fixed_port {
            format!("port {port}")
        } else {
            "an available local port".to_string()
        };
        let provider_hint = match provider {
            Provider::Gmail => format!(
                "The Google OAuth client must register this exact redirect URI: http://127.0.0.1:{GOOGLE_LOOPBACK_PORT}"
            ),
            Provider::Outlook => {
                "The Microsoft app registration should use a Mobile & desktop redirect URI on http://localhost.".to_string()
            }
            Provider::Imap => "IMAP accounts do not use OAuth redirect URIs.".to_string(),
        };
        format!(
            "Could not bind {target} for the OAuth redirect ({error}). \
             Another ARIS instance or local app may be using it. Close it and try again. \
             {provider_hint}"
        )
    })
}

/// Block until the loopback redirect arrives, returning the parsed query
/// parameters. Times out after ~3 minutes so a cancelled consent doesn't hang
/// the command forever.
fn await_redirect(
    listener: &TcpListener,
) -> Result<std::collections::HashMap<String, String>, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(180);
    loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                // The accepted stream can inherit the listener's non-blocking
                // flag on Windows; force blocking + a read timeout so
                // `read_line` actually waits for the request instead of
                // returning WouldBlock and losing the `code`.
                let _ = stream.set_nonblocking(false);
                let _ = stream.set_read_timeout(Some(Duration::from_secs(15)));
                let mut reader = BufReader::new(&stream);
                let mut request_line = String::new();
                reader
                    .read_line(&mut request_line)
                    .map_err(|e| e.to_string())?;
                let query = parse_request_target(&request_line);
                let body = "<html><body style=\"font-family:sans-serif;padding:2rem\">\
                    <h3>ARIS — authorization complete</h3>\
                    <p>You can close this tab and return to ARIS.</p></body></html>";
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
                     Content-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
                return Ok(query);
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err("Timed out waiting for the authorization redirect.".to_string());
                }
                std::thread::sleep(Duration::from_millis(120));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

fn oauth_troubleshooting_hint(provider: Provider, redirect_uri: &str, scopes: &str) -> String {
    match provider {
        Provider::Gmail => format!(
            "Google did not complete the OAuth redirect. Check Google Cloud Console: \
             Gmail API enabled, OAuth consent screen configured, Data Access includes `{scopes}`, \
             your Gmail address is added under Audience/Test users while the app is in Testing, \
             and this exact authorized redirect URI is registered on the OAuth client: \
             `{redirect_uri}`."
        ),
        Provider::Outlook => format!(
            "Microsoft did not complete the OAuth redirect. Check the app registration redirect URI \
             and requested scopes: `{scopes}`."
        ),
        Provider::Imap => "IMAP accounts do not use OAuth redirect URIs.".to_string(),
    }
}

fn oauth_error_hint(provider: Provider, error: &str, redirect_uri: &str, scopes: &str) -> String {
    match (provider, error) {
        (Provider::Gmail, "access_denied") => {
            "The Google account denied consent, is not listed as a test user, or is blocked by the OAuth consent configuration.".to_string()
        }
        (Provider::Gmail, "admin_policy_enforced") => {
            "A Google Workspace admin policy blocked this OAuth client or scope. The Workspace admin must allow the OAuth client for Gmail access.".to_string()
        }
        (Provider::Gmail, "org_internal") => {
            "The OAuth app is marked Internal, so only accounts in that Google Workspace organization can authorize it. Use an account in the organization or publish the app as External.".to_string()
        }
        (Provider::Gmail, "redirect_uri_mismatch") => format!(
            "The redirect URI does not match the OAuth client. Use a Desktop app client, or add this exact URI to a Web application client: `{redirect_uri}`."
        ),
        (Provider::Gmail, "invalid_scope") => format!(
            "The Gmail OAuth scope is not allowed by the consent screen. Add `{scopes}` under Google Auth Platform / Data Access."
        ),
        _ => oauth_troubleshooting_hint(provider, redirect_uri, scopes),
    }
}

/// Extract the query string from a raw HTTP request line
/// (`GET /?code=...&state=... HTTP/1.1`) into a key/value map.
fn parse_request_target(request_line: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    let Some(target) = request_line.split_whitespace().nth(1) else {
        return map;
    };
    let Some(query) = target.split_once('?').map(|(_, q)| q) else {
        return map;
    };
    for pair in query.split('&') {
        if let Some((key, value)) = pair.split_once('=') {
            let decoded = urlencoding::decode(value)
                .map(|v| v.into_owned())
                .unwrap_or_else(|_| value.to_string());
            map.insert(key.to_string(), decoded);
        }
    }
    map
}

/// Run the full interactive consent flow and persist the resulting account.
/// Returns the connected [`StoredAccount`] (caller turns it into a view).
pub fn connect(provider: Provider) -> Result<StoredAccount, String> {
    let cfg = store::oauth_config();
    let (client_id, client_secret) = client_credentials(provider, &cfg)?;
    let ep = endpoints(provider);

    // Google requires a stable localhost callback; Microsoft localhost
    // redirect URIs ignore the port, so use an ephemeral callback for Outlook.
    let listener = bind_loopback_listener(provider, ep.fixed_port)?;
    let callback_port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://{}:{callback_port}", ep.redirect_host);

    let verifier = random_token(64);
    let challenge = pkce_challenge(&verifier);
    let state = random_token(24);

    let mut auth_url = format!(
        "{}?response_type=code&client_id={}&redirect_uri={}&scope={}&state={}\
         &code_challenge={}&code_challenge_method=S256",
        ep.auth_url,
        urlencoding::encode(&client_id),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(ep.scopes),
        urlencoding::encode(&state),
        urlencoding::encode(&challenge),
    );
    for (key, value) in ep.extra_auth_params {
        auth_url.push_str(&format!("&{key}={}", urlencoding::encode(value)));
    }

    eprintln!(
        "mail oauth[{}]: redirect_uri = {redirect_uri}",
        provider.as_str()
    );
    eprintln!("mail oauth[{}]: auth_url = {auth_url}", provider.as_str());

    open_browser(&auth_url);
    let params = await_redirect(&listener).map_err(|e| {
        format!(
            "{e}\n{}",
            oauth_troubleshooting_hint(provider, &redirect_uri, ep.scopes)
        )
    })?;

    if let Some(err) = params.get("error") {
        let desc = params.get("error_description").cloned().unwrap_or_default();
        return Err(format!(
            "Authorization failed: {err} {desc}\n{}",
            oauth_error_hint(provider, err, &redirect_uri, ep.scopes)
        ));
    }
    if params.get("state").map(String::as_str) != Some(state.as_str()) {
        return Err("Authorization state mismatch (possible CSRF); aborting.".to_string());
    }
    let code = params
        .get("code")
        .ok_or_else(|| "Authorization response did not include a code.".to_string())?;

    let mut form = vec![
        ("grant_type", "authorization_code".to_string()),
        ("code", code.clone()),
        ("redirect_uri", redirect_uri.clone()),
        ("client_id", client_id.clone()),
        ("code_verifier", verifier),
    ];
    if ep.uses_secret {
        form.push(("client_secret", client_secret.clone()));
    }

    let client = reqwest::blocking::Client::new();
    let token: Value = client
        .post(ep.token_url)
        .form(&form)
        .send()
        .map_err(|e| e.to_string())?
        .json()
        .map_err(|e| e.to_string())?;

    if let Some(err) = token.get("error").and_then(Value::as_str) {
        let desc = token
            .get("error_description")
            .and_then(Value::as_str)
            .unwrap_or("");
        return Err(format!(
            "Token exchange failed: {err} {desc}\n{}",
            oauth_error_hint(provider, err, &redirect_uri, ep.scopes)
        ));
    }

    let access_token = token
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| "Token response missing access_token.".to_string())?
        .to_string();
    let refresh_token = token
        .get("refresh_token")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let expires_in = token
        .get("expires_in")
        .and_then(Value::as_i64)
        .unwrap_or(3600);

    let (email, display_name) = super::provider::fetch_identity(provider, &access_token)?;

    let account = StoredAccount {
        provider,
        email,
        display_name,
        incoming_server_id: String::new(),
        identity_id: String::new(),
        access_token,
        refresh_token,
        expires_at: now_secs() + expires_in - 60,
    };
    store::upsert_account(account.clone())?;
    Ok(account)
}

/// Return a currently-valid access token for `account_id`, refreshing it via
/// the stored refresh token when it is within 60s of expiry.
pub fn ensure_access_token(account_id: &str) -> Result<String, String> {
    let account = store::get_account(account_id)
        .ok_or_else(|| format!("mail account not found: {account_id}"))?;
    if !account.access_token.is_empty() && account.expires_at - 60 > now_secs() {
        return Ok(account.access_token);
    }
    if account.refresh_token.is_empty() {
        return Err("This account is not connected. Reconnect it in Settings → Mail.".to_string());
    }

    let cfg = store::oauth_config();
    let (client_id, client_secret) = client_credentials(account.provider, &cfg)?;
    let ep = endpoints(account.provider);

    let mut form = vec![
        ("grant_type", "refresh_token".to_string()),
        ("refresh_token", account.refresh_token.clone()),
        ("client_id", client_id),
    ];
    if ep.uses_secret {
        form.push(("client_secret", client_secret));
    }
    if !ep.uses_secret {
        // Microsoft requires the scope on refresh for public clients.
        form.push(("scope", ep.scopes.to_string()));
    }

    let client = reqwest::blocking::Client::new();
    let token: Value = client
        .post(ep.token_url)
        .form(&form)
        .send()
        .map_err(|e| e.to_string())?
        .json()
        .map_err(|e| e.to_string())?;

    if let Some(err) = token.get("error").and_then(Value::as_str) {
        let desc = token
            .get("error_description")
            .and_then(Value::as_str)
            .unwrap_or("");
        return Err(format!("Token refresh failed: {err} {desc}"));
    }

    let access_token = token
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| "Refresh response missing access_token.".to_string())?
        .to_string();
    let expires_in = token
        .get("expires_in")
        .and_then(Value::as_i64)
        .unwrap_or(3600);
    let new_refresh = token.get("refresh_token").and_then(Value::as_str);

    store::update_tokens(
        account_id,
        &access_token,
        now_secs() + expires_in - 60,
        new_refresh,
    )?;
    Ok(access_token)
}
