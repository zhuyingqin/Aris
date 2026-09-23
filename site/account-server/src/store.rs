use crate::crypto::{hash, random, Vault};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    sync::{Mutex, MutexGuard},
};

#[derive(Clone, Serialize, Deserialize)]
pub struct User {
    pub id: String,
    pub issuer: String,
    pub subject: String,
    pub email: String,
    pub display_name: String,
}

#[derive(Serialize, Deserialize)]
pub struct Flow {
    pub kind: String,
    pub verifier: String,
    pub nonce: String,
    pub session_hash: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ComputeAccount {
    pub user_id: i64,
    pub oidc_id: String,
    pub access_token: String,
    pub refresh_cookie: String,
    pub session_id: String,
    pub expires_at: i64,
    pub model_key: Option<String>,
}

pub struct Store {
    connection: Mutex<Connection>,
    vault: Vault,
}

impl Store {
    pub fn open(path: &Path, vault: Vault) -> Result<Self, String> {
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent).map_err(|_| "cannot create database directory")?;
        }
        let connection = Connection::open(path).map_err(|_| "cannot open account database")?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| "database initialization failed")?;
        connection
            .execute_batch(include_str!("../schema.sql"))
            .map_err(|_| "database migration failed")?;
        let probe: Option<String> = connection
            .query_row(
                "SELECT value FROM metadata WHERE key='vault_probe'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_error)?;
        if let Some(probe) = probe {
            if vault.open("store-key-check", &probe)? != "somniq-account-v1" {
                return Err("incorrect account vault key".into());
            }
        } else {
            connection
                .execute(
                    "INSERT INTO metadata(key,value) VALUES('vault_probe',?1)",
                    [vault.seal("store-key-check", "somniq-account-v1")?],
                )
                .map_err(db_error)?;
        }
        Ok(Self {
            connection: Mutex::new(connection),
            vault,
        })
    }

    fn db(&self) -> Result<MutexGuard<'_, Connection>, String> {
        self.connection
            .lock()
            .map_err(|_| "account database unavailable".into())
    }

    pub fn login(
        &self,
        issuer: &str,
        subject: &str,
        email: &str,
        name: &str,
        now: i64,
    ) -> Result<(User, String), String> {
        let mut db = self.db()?;
        let tx = db.transaction().map_err(db_error)?;
        tx.execute("INSERT INTO users(id,issuer,subject,email,display_name) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(issuer,subject) DO UPDATE SET email=excluded.email, display_name=excluded.display_name", params![uuid::Uuid::new_v4().to_string(), issuer, subject, email, name]).map_err(db_error)?;
        let (id, active): (String, bool) = tx
            .query_row(
                "SELECT id,active FROM users WHERE issuer=?1 AND subject=?2",
                params![issuer, subject],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(db_error)?;
        if !active {
            return Err("account disabled".into());
        }
        tx.execute("DELETE FROM sessions WHERE expires_at<=?1", [now])
            .map_err(db_error)?;
        let count: i64 = tx
            .query_row(
                "SELECT count(*) FROM sessions WHERE user_id=?1",
                [&id],
                |r| r.get(0),
            )
            .map_err(db_error)?;
        if count >= 20 {
            return Err("session limit reached".into());
        }
        let token = random();
        tx.execute(
            "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?1,?2,?3)",
            params![hash(&token), id, now + 86400],
        )
        .map_err(db_error)?;
        tx.commit().map_err(db_error)?;
        Ok((
            User {
                id,
                issuer: issuer.into(),
                subject: subject.into(),
                email: email.into(),
                display_name: name.into(),
            },
            token,
        ))
    }

    pub fn session(&self, token: &str, now: i64) -> Result<Option<User>, String> {
        self.db()?.query_row("SELECT u.id,u.issuer,u.subject,u.email,u.display_name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?1 AND s.expires_at>?2 AND u.active=1", params![hash(token), now], |r| Ok(User { id:r.get(0)?,issuer:r.get(1)?,subject:r.get(2)?,email:r.get(3)?,display_name:r.get(4)? })).optional().map_err(db_error)
    }

    pub fn logout(&self, token: &str) -> Result<(), String> {
        self.db()?
            .execute("DELETE FROM sessions WHERE token_hash=?1", [hash(token)])
            .map_err(db_error)?;
        Ok(())
    }

    pub fn save_flow(
        &self,
        state: &str,
        browser: &str,
        flow: &Flow,
        now: i64,
    ) -> Result<(), String> {
        let key = hash(state);
        let sealed = self.vault.seal(
            &format!("flow:{key}"),
            &serde_json::to_string(flow).map_err(|_| "invalid flow")?,
        )?;
        let mut db = self.db()?;
        let tx = db.transaction().map_err(db_error)?;
        tx.execute("DELETE FROM flows WHERE expires_at<=?1", [now])
            .map_err(db_error)?;
        let count: i64 = tx
            .query_row("SELECT count(*) FROM flows", [], |r| r.get(0))
            .map_err(db_error)?;
        if count >= 1024 {
            return Err("pending login limit reached".into());
        }
        tx.execute(
            "INSERT INTO flows(state_hash,browser_hash,sealed,expires_at) VALUES(?1,?2,?3,?4)",
            params![key, hash(browser), sealed, now + 600],
        )
        .map_err(db_error)?;
        tx.commit().map_err(db_error)
    }

    pub fn consume_flow(
        &self,
        state: &str,
        browser: &str,
        now: i64,
    ) -> Result<Option<Flow>, String> {
        let key = hash(state);
        let sealed: Option<String> = self.db()?.query_row("DELETE FROM flows WHERE state_hash=?1 AND browser_hash=?2 AND expires_at>?3 RETURNING sealed", params![key,hash(browser),now], |r|r.get(0)).optional().map_err(db_error)?;
        sealed
            .map(|s| {
                self.vault.open(&format!("flow:{key}"), &s).and_then(|v| {
                    serde_json::from_str(&v).map_err(|_| "invalid stored flow".into())
                })
            })
            .transpose()
    }

    pub fn consent(&self, user: &str, version: &str, text: &str, now: i64) -> Result<(), String> {
        self.db()?.execute("INSERT OR IGNORE INTO consents(user_id,version,content_hash,snapshot,accepted_at) VALUES(?1,?2,?3,?4,?5)", params![user,version,hash(text),text,now]).map_err(db_error)?;
        Ok(())
    }

    pub fn has_consent(&self, user: &str, version: &str, text: &str) -> Result<bool, String> {
        self.db()?.query_row("SELECT EXISTS(SELECT 1 FROM consents WHERE user_id=?1 AND version=?2 AND content_hash=?3)", params![user,version,hash(text)], |r|r.get(0)).map_err(db_error)
    }

    pub fn save_compute(
        &self,
        user: &str,
        instance: &str,
        account: &ComputeAccount,
    ) -> Result<(), String> {
        let context = format!("compute:{instance}:{user}");
        let sealed = self.vault.seal(
            &context,
            &serde_json::to_string(account).map_err(|_| "invalid compute account")?,
        )?;
        let mut db = self.db()?;
        let tx = db.transaction().map_err(db_error)?;
        let existing: Option<i64> = tx
            .query_row(
                "SELECT newapi_user_id FROM compute_accounts WHERE user_id=?1 AND instance=?2",
                params![user, instance],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_error)?;
        if existing.is_some_and(|id| id != account.user_id) {
            return Err("compute identity changed; recovery required".into());
        }
        tx.execute("INSERT INTO compute_accounts(user_id,instance,newapi_user_id,sealed) VALUES(?1,?2,?3,?4) ON CONFLICT(user_id,instance) DO UPDATE SET sealed=excluded.sealed", params![user,instance,account.user_id,sealed]).map_err(db_error)?;
        tx.commit().map_err(db_error)
    }

    pub fn compute(&self, user: &str, instance: &str) -> Result<Option<ComputeAccount>, String> {
        let sealed: Option<String> = self
            .db()?
            .query_row(
                "SELECT sealed FROM compute_accounts WHERE user_id=?1 AND instance=?2",
                params![user, instance],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_error)?;
        sealed
            .map(|s| {
                self.vault
                    .open(&format!("compute:{instance}:{user}"), &s)
                    .and_then(|v| {
                        serde_json::from_str(&v).map_err(|_| "invalid stored account".into())
                    })
            })
            .transpose()
    }
}

fn db_error(_: rusqlite::Error) -> String {
    "account database operation failed".into()
}
