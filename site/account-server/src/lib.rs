pub mod config;
pub mod crypto;
mod http;
mod newapi;
mod oidc;
pub mod store;

use config::Config;
use crypto::Vault;
use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use store::Store;

pub struct App {
    pub config: Config,
    pub store: Store,
    pub client: reqwest::Client,
    // First delivery is deliberately single-instance. A bounded set of locks
    // serializes each account's refresh/key provisioning without unbounded maps.
    locks: Vec<tokio::sync::Mutex<()>>,
}

impl App {
    pub fn new(config: Config) -> Result<Arc<Self>, String> {
        let vault = Vault::new(&config.vault_key)?;
        let store = Store::open(&config.database, vault)?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|_| "cannot create account HTTP client")?;
        Ok(Arc::new(Self {
            config,
            store,
            client,
            locks: (0..64).map(|_| tokio::sync::Mutex::new(())).collect(),
        }))
    }

    pub async fn account_lock(&self, id: &str) -> tokio::sync::MutexGuard<'_, ()> {
        let index = id
            .bytes()
            .fold(0_usize, |n, b| n.wrapping_mul(31).wrapping_add(b as usize))
            % self.locks.len();
        self.locks[index].lock().await
    }
}

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
pub use http::router;

#[cfg(test)]
mod tests;
