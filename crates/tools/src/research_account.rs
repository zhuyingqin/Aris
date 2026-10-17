//! The signed-in SomniQ account, as the shared research gateway sees it.
//!
//! Gateway routes that spend a shared institutional allowance (the school's
//! Scopus route) identify the caller by this desktop's account session. The
//! session lives in the desktop's credential store and renews asynchronously,
//! so `tools` cannot read it directly: the desktop registers a provider at
//! startup. Without one (tests, headless callers) nobody is signed in.

use std::sync::{Arc, OnceLock, RwLock};

/// A currently valid account credential.
#[derive(Clone)]
pub struct ResearchAccountCredential {
    /// Base URL of the account service that issued `access_token`. The token
    /// is only ever presented to a gateway on this same host.
    pub issuer: String,
    pub user_id: i64,
    pub access_token: String,
}

impl std::fmt::Debug for ResearchAccountCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResearchAccountCredential")
            .field("issuer", &self.issuer)
            .field("user_id", &self.user_id)
            .field("access_token", &"<redacted>")
            .finish()
    }
}

pub trait ResearchAccountProvider: Send + Sync {
    /// Issuer of the stored session, read from local state only: no network
    /// request and no renewal. `None` when this desktop is signed out.
    fn session_issuer(&self) -> Option<String>;

    /// A currently valid credential, renewing it when needed. Blocks; call it
    /// from a blocking context. `Ok(None)` means signed out.
    fn credential(&self) -> Result<Option<ResearchAccountCredential>, String>;
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
