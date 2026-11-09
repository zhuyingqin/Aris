//! Refresh credentials use the OS store in production and an isolated store in tests.

#[cfg(not(test))]
mod backend {
    use keyring::{Entry, Error};

    fn entry(account: &str) -> Result<Entry, String> {
        Entry::new(super::super::NEWAPI_REFRESH_KEYRING_SERVICE, account)
            .map_err(|error| format!("无法访问系统登录凭据存储: {error}"))
    }

    pub(super) fn read(account: &str) -> Result<Option<Vec<u8>>, String> {
        match entry(account)?.get_secret() {
            Ok(secret) => Ok(Some(secret)),
            Err(Error::NoEntry) => Ok(None),
            Err(error) => Err(format!("无法读取系统登录凭据: {error}")),
        }
    }

    pub(super) fn write(account: &str, secret: &[u8]) -> Result<(), String> {
        entry(account)?
            .set_secret(secret)
            .map_err(|error| format!("无法保存系统登录凭据: {error}"))
    }

    pub(super) fn delete(account: &str) -> Result<(), String> {
        match entry(account)?.delete_credential() {
            Ok(()) | Err(Error::NoEntry) => Ok(()),
            Err(error) => Err(format!("无法删除系统登录凭据: {error}")),
        }
    }
}

#[cfg(test)]
mod backend {
    use std::{
        collections::{HashMap, HashSet},
        sync::{Mutex, OnceLock},
    };

    #[derive(Default)]
    struct Store {
        values: HashMap<String, Vec<u8>>,
        denied_writes: HashSet<String>,
    }

    fn store() -> &'static Mutex<Store> {
        static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
        STORE.get_or_init(|| Mutex::new(Store::default()))
    }

    pub(super) fn read(account: &str) -> Result<Option<Vec<u8>>, String> {
        Ok(store().lock().unwrap().values.get(account).cloned())
    }

    pub(super) fn write(account: &str, secret: &[u8]) -> Result<(), String> {
        let mut store = store().lock().unwrap();
        if store.denied_writes.contains(account) {
            return Err("无法保存系统登录凭据: test store unavailable".to_string());
        }
        store.values.insert(account.to_string(), secret.to_vec());
        Ok(())
    }

    pub(super) fn delete(account: &str) -> Result<(), String> {
        let mut store = store().lock().unwrap();
        store.values.remove(account);
        store.denied_writes.remove(account);
        Ok(())
    }

    pub(super) fn deny_writes(account: &str, denied: bool) {
        let mut store = store().lock().unwrap();
        if denied {
            store.denied_writes.insert(account.to_string());
        } else {
            store.denied_writes.remove(account);
        }
    }
}

pub(super) fn read(account: &str) -> Result<Option<Vec<u8>>, String> {
    backend::read(account)
}
pub(super) fn write(account: &str, secret: &[u8]) -> Result<(), String> {
    backend::write(account, secret)
}
pub(super) fn delete(account: &str) -> Result<(), String> {
    backend::delete(account)
}

#[cfg(test)]
pub(super) fn deny_writes(account: &str, denied: bool) {
    backend::deny_writes(account, denied);
}
