//! The account gateway's model key (`sk-…`).
//!
//! The key lives in the operating-system credential store and one in-process
//! cache, never in `config.json` and never in the process environment: both are
//! readable by every command the Agent runs. `config::load_object` lays the
//! cached key over the file it reads and `config::save_object` strips it again,
//! so code that works on the config object keeps finding a key while none ever
//! reaches disk. The credential store is read once per process; after that
//! every lookup is served from memory.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ManagedKey {
    /// OpenAI-compatible base URL the key was issued for (`<account>/v1`).
    pub(crate) base_url: String,
    /// new-api token id, so a later refresh can skip the rate-limited reveal.
    #[serde(default)]
    pub(crate) token_id: Option<i64>,
    pub(crate) key: String,
}

/// `None` records "looked in the credential store, found nothing" so a missing
/// or unreadable entry is not asked for again on every config read (on macOS
/// each read can raise a Keychain prompt).
type Cache = HashMap<String, Option<ManagedKey>>;

fn cache() -> &'static Mutex<Cache> {
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Credential-store account for one signed-in gateway.
fn account_name(account_base: &str) -> String {
    let normalized = account_base.trim().trim_end_matches('/').to_ascii_lowercase();
    // Tests swap the config directory per case; scope their entries to it so
    // one test's key never overlays another test's config.
    #[cfg(test)]
    let normalized = format!("{}|{normalized}", crate::state::config_path().display());
    let digest = Sha256::digest(normalized.as_bytes());
    let fingerprint = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("model-key-{fingerprint}")
}

/// The stored key for `account_base`, from memory after the first lookup.
pub(crate) fn load(account_base: &str) -> Option<ManagedKey> {
    let account = account_name(account_base);
    let mut cache = cache().lock().ok()?;
    if let Some(entry) = cache.get(&account) {
        return entry.clone();
    }
    let loaded = match backend::read(&account) {
        Ok(Some(bytes)) => serde_json::from_slice::<ManagedKey>(&bytes)
            .ok()
            .filter(|stored| !stored.key.trim().is_empty()),
        Ok(None) => None,
        Err(error) => {
            eprintln!("SomniQ could not read the account model key: {error}");
            None
        }
    };
    cache.insert(account, loaded.clone());
    loaded
}

/// Remember `key` for `account_base`. The in-memory copy is updated even when
/// the credential store refuses the write, so this process keeps working; the
/// error tells the caller the key will have to be fetched again next launch.
pub(crate) fn store(account_base: &str, key: ManagedKey) -> Result<(), String> {
    let account = account_name(account_base);
    let bytes = serde_json::to_vec(&key).map_err(|error| format!("无法编码模型密钥: {error}"))?;
    if let Ok(mut cache) = cache().lock() {
        cache.insert(account.clone(), Some(key));
    }
    backend::write(&account, &bytes)
}

/// Forget the key for `account_base`, in memory and in the credential store.
pub(crate) fn clear(account_base: &str) {
    let account = account_name(account_base);
    if let Ok(mut cache) = cache().lock() {
        cache.insert(account.clone(), None);
    }
    if let Err(error) = backend::delete(&account) {
        eprintln!("SomniQ could not delete the account model key: {error}");
    }
}

#[cfg(not(test))]
mod backend {
    use keyring::{Entry as KeyringEntry, Error as KeyringError};

    fn entry(account: &str) -> Result<KeyringEntry, String> {
        KeyringEntry::new(crate::newapi::NEWAPI_REFRESH_KEYRING_SERVICE, account)
            .map_err(|error| format!("无法访问系统凭据存储: {error}"))
    }

    pub(super) fn read(account: &str) -> Result<Option<Vec<u8>>, String> {
        match entry(account)?.get_secret() {
            Ok(secret) => Ok(Some(secret)),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(error) => Err(format!("无法读取系统凭据: {error}")),
        }
    }

    pub(super) fn write(account: &str, secret: &[u8]) -> Result<(), String> {
        entry(account)?
            .set_secret(secret)
            .map_err(|error| format!("无法保存系统凭据: {error}"))
    }

    pub(super) fn delete(account: &str) -> Result<(), String> {
        match entry(account)?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(error) => Err(format!("无法删除系统凭据: {error}")),
        }
    }
}

/// Unit tests must never touch the developer's real credential store.
#[cfg(test)]
mod backend {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};

    fn store() -> &'static Mutex<HashMap<String, Vec<u8>>> {
        static STORE: OnceLock<Mutex<HashMap<String, Vec<u8>>>> = OnceLock::new();
        STORE.get_or_init(|| Mutex::new(HashMap::new()))
    }

    pub(super) fn read(account: &str) -> Result<Option<Vec<u8>>, String> {
        Ok(store().lock().map_err(|e| e.to_string())?.get(account).cloned())
    }

    pub(super) fn write(account: &str, secret: &[u8]) -> Result<(), String> {
        store()
            .lock()
            .map_err(|e| e.to_string())?
            .insert(account.to_string(), secret.to_vec());
        Ok(())
    }

    pub(super) fn delete(account: &str) -> Result<(), String> {
        store().lock().map_err(|e| e.to_string())?.remove(account);
        Ok(())
    }
}

/// What the test credential store holds for `account_base`, bypassing the cache.
#[cfg(test)]
pub(crate) fn stored_for_tests(account_base: &str) -> Option<ManagedKey> {
    backend::read(&account_name(account_base))
        .ok()
        .flatten()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

/// Drop the in-memory copy so the next lookup reads the (test) store again,
/// as a fresh process would.
#[cfg(test)]
pub(crate) fn forget_cache_for_tests() {
    if let Ok(mut cache) = cache().lock() {
        cache.clear();
    }
}
