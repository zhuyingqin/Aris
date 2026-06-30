//! Event-driven mailbox notifications.
//!
//! The first supported local transport is IMAP IDLE. Gmail and Outlook need
//! provider-side push/webhook infrastructure, so this module intentionally does
//! not fall back to scheduled polling for those providers.

use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter};

use super::model::{MailAccount, MailMessageSummary, Provider};
use super::{imap, store};
use crate::state;

static WATCHERS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailNewMessageEvent {
    pub account_id: String,
    pub provider: Provider,
    pub folder: String,
    pub message: MailMessageSummary,
    pub detected_at: i64,
}

fn registry() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    WATCHERS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default()
}

fn account_is_connected_imap(account_id: &str) -> bool {
    store::get_account(account_id).is_some_and(|account| {
        account.provider == Provider::Imap && !account.incoming_server_id.is_empty()
    })
}

fn append_run_event(event: &MailNewMessageEvent) -> Result<(), String> {
    let path = state::events_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let record = json!({
        "ts": event.detected_at,
        "kind": "mail.new_message",
        "payload": event,
    });
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| error.to_string())?;
    writeln!(file, "{record}").map_err(|error| error.to_string())
}

fn emit_new_message(app: &AppHandle, event: MailNewMessageEvent) {
    if let Err(error) = append_run_event(&event) {
        eprintln!("mail events: could not append mail event: {error}");
    }
    let _ = app.emit("mail-new-message", event);
}

fn handle_new_message(app: &AppHandle, event: MailNewMessageEvent) {
    emit_new_message(app, event.clone());
    // The mailbox no longer hardcodes literature handling. New mail instead
    // fires any user-defined `mail`-trigger scheduled task that matches, so the
    // behaviour is fully configurable from the Scheduled Tasks page.
    crate::scheduled::on_new_mail(
        app.clone(),
        crate::scheduled::MailTriggerContext {
            account_id: event.account_id.clone(),
            from: event.message.from.clone(),
            from_name: event.message.from_name.clone(),
            subject: event.message.subject.clone(),
            snippet: event.message.snippet.clone(),
            message_id: event.message.id.clone(),
        },
    );
}

pub fn start_connected_account_watchers(app: AppHandle) {
    for account in store::list_accounts() {
        start_for_account(app.clone(), &account);
    }
}

pub fn start_for_account(app: AppHandle, account: &MailAccount) {
    if !account.connected || account.provider != Provider::Imap {
        return;
    }

    let account_id = account.id.clone();
    let flag = Arc::new(AtomicBool::new(true));
    {
        let Ok(mut watchers) = registry().lock() else {
            eprintln!("mail events: watcher registry is unavailable");
            return;
        };
        if watchers.contains_key(&account_id) {
            return;
        }
        watchers.insert(account_id.clone(), flag.clone());
    }

    thread::spawn(move || {
        let mut last_seen_uid = None;
        while flag.load(Ordering::SeqCst) && account_is_connected_imap(&account_id) {
            let continue_flag = flag.clone();
            let continue_account_id = account_id.clone();
            let app_for_event = app.clone();
            let result = imap::idle_watch_inbox(
                &account_id,
                last_seen_uid,
                move || {
                    continue_flag.load(Ordering::SeqCst)
                        && account_is_connected_imap(&continue_account_id)
                },
                |folder, uid, message| {
                    last_seen_uid = Some(last_seen_uid.unwrap_or(0).max(uid));
                    handle_new_message(
                        &app_for_event,
                        MailNewMessageEvent {
                            account_id: account_id.clone(),
                            provider: Provider::Imap,
                            folder,
                            message,
                            detected_at: now_millis(),
                        },
                    );
                },
            );

            match result {
                Ok(uid) => {
                    last_seen_uid = Some(last_seen_uid.unwrap_or(0).max(uid));
                }
                Err(error) => {
                    if flag.load(Ordering::SeqCst) && account_is_connected_imap(&account_id) {
                        if error.contains("IMAP IDLE was not accepted") {
                            eprintln!(
                                "mail events: IMAP IDLE is not supported for {account_id}: {error}"
                            );
                            break;
                        }
                        eprintln!("mail events: IMAP IDLE failed for {account_id}: {error}");
                        thread::sleep(Duration::from_secs(5));
                    }
                }
            }
        }

        if let Ok(mut watchers) = registry().lock() {
            if watchers
                .get(&account_id)
                .is_some_and(|current| Arc::ptr_eq(current, &flag))
            {
                watchers.remove(&account_id);
            }
        }
    });
}

pub fn stop_for_account(account_id: &str) {
    let Ok(mut watchers) = registry().lock() else {
        return;
    };
    if let Some(flag) = watchers.remove(account_id) {
        flag.store(false, Ordering::SeqCst);
    }
}
