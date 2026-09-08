//! Moving command work off the main thread.
//!
//! A `#[tauri::command]` declared as a plain `fn` is dispatched with
//! `ExecutionContext::Blocking`, which runs it on the main thread; only an
//! `async fn` reaches the pool. Any command that reads a whole store — the
//! literature library, the Typeset revision ledger — can be seconds of work on
//! a real project, and on the main thread that is a window the OS marks as not
//! responding rather than merely a slow load.

/// Run store work on Tauri's blocking pool.
pub(crate) async fn off_main_thread<T, F>(work: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())?
}
