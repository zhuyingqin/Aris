pub mod config;
pub mod crypto;
mod http;
mod membership;
mod membership_http;
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
    // Mutations wait for already-authorized requests to receive upstream
    // headers. Streams then finish independently; new requests see new policy.
    policy_lock: tokio::sync::RwLock<()>,
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
            policy_lock: tokio::sync::RwLock::new(()),
        }))
    }

    pub fn start_membership_sync(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let app = self.clone();
        tokio::spawn(async move {
            loop {
                if let Ok(users) = app.store.pending_sync(&app.config.newapi_instance, now()) {
                    for user in users {
                        let _policy = app.policy_lock.read().await;
                        let result = newapi::model_account(&app, &user, true).await;
                        let error = result.err().map(|_| "upstream_sync_failed");
                        let _ = app.store.finish_sync(&user.id, now() + 30, error);
                    }
                }
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            }
        })
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
