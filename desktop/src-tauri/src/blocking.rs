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
    typed_off_main_thread(work, |error| error).await
}

/// [`off_main_thread`] for a command whose error is a structured type rather
/// than a `String`.
///
/// The join failure (the blocking task panicked or was cancelled) is not
/// expressible in the command's own error vocabulary, so the caller supplies
/// `on_join_failure` to lift that one message into its type. Everything else
/// passes through untouched.
pub(crate) async fn typed_off_main_thread<T, E, F, J>(work: F, on_join_failure: J) -> Result<T, E>
where
    F: FnOnce() -> Result<T, E> + Send + 'static,
    T: Send + 'static,
    E: Send + 'static,
    J: FnOnce(String) -> E,
{
    match tauri::async_runtime::spawn_blocking(work).await {
        Ok(result) => result,
        Err(error) => Err(on_join_failure(error.to_string())),
    }
}
