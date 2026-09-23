use std::{env, path::PathBuf};
use url::Url;

#[derive(Clone)]
pub struct Config {
    pub bind: String,
    pub public_url: Url,
    pub issuer: Url,
    pub client_id: String,
    pub client_secret: String,
    pub newapi_url: Url,
    pub newapi_client_id: String,
    pub newapi_instance: String,
    pub database: PathBuf,
    pub vault_key: String,
    pub agreement_version: String,
    pub agreement_text: String,
    pub secure: bool,
    pub home_path: String,
    pub admin_subjects: Vec<String>,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        fn required(name: &str) -> Result<String, String> {
            env::var(name)
                .ok()
                .filter(|v| !v.trim().is_empty())
                .ok_or_else(|| format!("{name} is required"))
        }
        let public_url = parse_url(&required("SOMNIQ_ACCOUNT_PUBLIC_URL")?)?;
        let issuer = parse_url(&required("SOMNIQ_OIDC_ISSUER")?)?;
        let newapi_url = parse_url(&required("SOMNIQ_NEWAPI_URL")?)?;
        let secure = public_url.scheme() == "https";
        let home_path = env::var("SOMNIQ_ACCOUNT_HOME_PATH").unwrap_or_else(|_| "/account/".into());
        if !matches!(home_path.as_str(), "/account/" | "/account.html") {
            return Err("account home path must be /account/ or /account.html".into());
        }
        if !secure
            && !matches!(
                public_url.host_str(),
                Some("127.0.0.1" | "localhost" | "[::1]")
            )
        {
            return Err("public HTTP is permitted only on loopback".into());
        }
        if secure && issuer.scheme() != "https" {
            return Err("production OIDC issuer requires HTTPS".into());
        }
        if public_url.path() != "/" {
            return Err("public URL must be an origin without a path".into());
        }
        let agreement_text = std::fs::read_to_string(required("SOMNIQ_AGREEMENT_FILE")?)
            .map_err(|_| "cannot read agreement snapshot")?;
        if agreement_text.trim().is_empty() || agreement_text.len() > 1_000_000 {
            return Err("invalid agreement snapshot".into());
        }
        Ok(Self {
            bind: env::var("SOMNIQ_ACCOUNT_BIND").unwrap_or_else(|_| "127.0.0.1:8800".into()),
            public_url,
            issuer,
            secure,
            home_path,
            admin_subjects: env::var("SOMNIQ_ACCOUNT_ADMIN_SUBJECTS")
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect(),
            client_id: required("SOMNIQ_OIDC_CLIENT_ID")?,
            client_secret: required("SOMNIQ_OIDC_CLIENT_SECRET")?,
            newapi_url,
            newapi_client_id: required("SOMNIQ_NEWAPI_OIDC_CLIENT_ID")?,
            newapi_instance: required("SOMNIQ_NEWAPI_INSTANCE_ID")?,
            database: env::var("SOMNIQ_ACCOUNT_DATABASE")
                .unwrap_or_else(|_| "data/accounts.sqlite3".into())
                .into(),
            vault_key: required("SOMNIQ_ACCOUNT_KEY")?,
            agreement_version: required("SOMNIQ_AGREEMENT_VERSION")?,
            agreement_text,
        })
    }

    pub fn origin(&self) -> String {
        self.public_url.origin().ascii_serialization()
    }
    pub fn session_cookie(&self) -> &'static str {
        if self.secure {
            "__Host-somniq_session"
        } else {
            "somniq_session"
        }
    }
    pub fn flow_cookie(&self) -> &'static str {
        if self.secure {
            "__Host-somniq_flow"
        } else {
            "somniq_flow"
        }
    }
}

fn parse_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "invalid configured URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("configured URL must be HTTP(S) without credentials, query or fragment".into());
    }
    Ok(url)
}
