//! The signed-in SomniQ account, as the shared research gateway sees it.
//!
//! Account-billed tools (DeepSeek search, the school's Scopus route) present
//! the account's downstream API token to the account gateway, which checks the
//! tier and charges credits. The token lives in the desktop's credential
//! store, so `tools` cannot read it directly: the desktop registers a provider
//! at startup. Without one (tests, headless callers) nobody is signed in. The
//! dashboard session is never handed to tools.

use std::sync::{Arc, OnceLock, RwLock};

/// The account's downstream API token, used for account-billed tools. It is
/// only ever presented to a gateway on the same host as `issuer`.
#[derive(Clone)]
pub struct ResearchApiCredential {
    pub issuer: String,
    pub api_key: String,
}

impl std::fmt::Debug for ResearchApiCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResearchApiCredential")
            .field("issuer", &self.issuer)
            .field("api_key", &"<redacted>")
            .finish()
    }
}

pub trait ResearchAccountProvider: Send + Sync {
    /// Issuer of the stored session, read from local state only: no network
    /// request and no renewal. `None` when this desktop is signed out.
    fn session_issuer(&self) -> Option<String>;

    /// The signed-in account's model API token. Never substitute a dashboard
    /// JWT or refresh cookie. Headless callers without an account return None.
    fn api_credential(&self) -> Result<Option<ResearchApiCredential>, String> {
        Ok(None)
    }
}

fn provider_slot() -> &'static RwLock<Option<Arc<dyn ResearchAccountProvider>>> {
    static PROVIDER: OnceLock<RwLock<Option<Arc<dyn ResearchAccountProvider>>>> = OnceLock::new();
    PROVIDER.get_or_init(|| RwLock::new(None))
}

/// Register the process-wide account provider. A later call replaces it.
pub fn set_research_account_provider(provider: Arc<dyn ResearchAccountProvider>) {
    if let Ok(mut slot) = provider_slot().write() {
        *slot = Some(provider);
    }
}

pub(crate) fn current_provider() -> Option<Arc<dyn ResearchAccountProvider>> {
    provider_slot().read().ok().and_then(|slot| slot.clone())
}

/// Whether two URLs name the same scheme and host. A credential issued by one
/// account service must not be presented to a gateway on another host.
pub(crate) fn same_origin(left: &str, right: &str) -> bool {
    let host = |value: &str| {
        reqwest::Url::parse(value.trim()).ok().and_then(|url| {
            url.host_str().map(|host| {
                (
                    url.scheme().to_ascii_lowercase(),
                    host.to_ascii_lowercase(),
                    url.port_or_known_default(),
                )
            })
        })
    };
    matches!((host(left), host(right)), (Some(left), Some(right)) if left == right)
}
