//! "SomniQ is controlling this computer": an always-on-top indicator on every
//! monitor while a computer-use turn runs, with a Stop button, plus a border
//! around the one window the user let the agent look at (R2).
//!
//! The indicator follows `engine::computer_controlling_sessions` (sessions in
//! computer-use mode with a live, uncancelled turn). `refresh` is called from
//! `engine::emit_desktop_chat_run_state`, which every turn start, end and stop
//! already goes through, and whenever a grant changes. Windows are created
//! and destroyed on a blocking thread: `refresh` can run inside a synchronous
//! command, i.e. on the main thread, where building a webview window
//! deadlocks on Windows.
//!
//! Grants (which window a session may read) live here too, because their
//! lifetime is the indicator's: a grant ends when its session stops
//! controlling the computer (turn ended or stopped).
//!
//! The indicator and border windows are SomniQ's own, so the computer-use
//! policy treats them as protected: an agent can never see, click or close
//! them.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

/// `capabilities/computer-control-indicator.json` grants these windows only
/// `core:default`.
pub const INDICATOR_LABEL_PREFIX: &str = "computer-control-indicator-";
pub const BORDER_LABEL: &str = "computer-control-indicator-border";
const INDICATOR_EVENT: &str = "computer-control-changed";
/// Logical size of the pill and its distance from the top of each monitor.
const INDICATOR_WIDTH: f64 = 440.0;
const INDICATOR_HEIGHT: f64 = 46.0;
const INDICATOR_TOP_MARGIN: f64 = 8.0;
/// How often the border follows its window.
const BORDER_TRACK_INTERVAL: Duration = Duration::from_millis(300);
/// Physical pixels the border extends past the window frame on each side.
const BORDER_OUTSET: i32 = 4;

/// The one window a session may read, as the user picked it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    pub hwnd: isize,
    pub pid: u32,
    pub exe: String,
    pub title: String,
}

#[derive(Default)]
pub struct ComputerControlState {
    current: Mutex<Control>,
    grants: Mutex<HashMap<String, Grant>>,
    /// Serializes window reconciliation; each pass reads the latest `current`.
    windows: Mutex<()>,
    border_tracking: AtomicBool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Control {
    sessions: Vec<String>,
    since_ms: Option<u64>,
    /// The first controlling session that holds a grant, and that grant.
    observing: Option<(String, Grant)>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Observing {
    pub session_id: String,
    pub exe: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ControlStatus {
    pub active: bool,
    pub session_ids: Vec<String>,
    /// When control started (Unix ms), for the elapsed-time readout.
    pub since_ms: Option<u64>,
    /// The window being read, if a grant is active.
    pub observing: Option<Observing>,
    /// `cn` | `en` | `es`: the indicator page has no access to the
    /// workspace's language store.
    pub language: &'static str,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| u64::try_from(since.as_millis()).unwrap_or(u64::MAX))
}

fn language_code() -> &'static str {
    match runtime::ui_lang::ui_language() {
        runtime::ui_lang::UiLanguage::Cn => "cn",
        runtime::ui_lang::UiLanguage::En => "en",
        runtime::ui_lang::UiLanguage::Es => "es",
    }
}

/// Apply a new controlling-session list. Grants of sessions that no longer
/// control the computer are dropped from `grants`. Returns true when the
/// visible state changed.
fn update(
    control: &mut Control,
    grants: &mut HashMap<String, Grant>,
    sessions: Vec<String>,
    now: u64,
) -> bool {
    grants.retain(|session, _| sessions.contains(session));
    let observing = sessions
        .iter()
        .find_map(|session| grants.get(session).map(|grant| (session.clone(), grant.clone())));
    if control.sessions == sessions && control.observing == observing {
        return false;
    }
    let was_active = !control.sessions.is_empty();
    let active = !sessions.is_empty();
    control.since_ms = match (was_active, active) {
        (_, false) => None,
        (false, true) => Some(now),
        (true, true) => control.since_ms,
    };
    control.sessions = sessions;
    control.observing = observing;
    true
}

fn status_of(control: &Control) -> ControlStatus {
    ControlStatus {
        active: !control.sessions.is_empty(),
        session_ids: control.sessions.clone(),
        since_ms: control.since_ms,
        observing: control.observing.as_ref().map(|(session_id, grant)| Observing {
            session_id: session_id.clone(),
            exe: grant.exe.clone(),
            title: grant.title.clone(),
        }),
        language: language_code(),
    }
}

pub(crate) fn status(app: &AppHandle) -> ControlStatus {
    app.try_state::<ComputerControlState>()
        .and_then(|state| state.current.lock().ok().map(|control| status_of(&control)))
        .unwrap_or_else(|| status_of(&Control::default()))
}

pub(crate) fn is_active(app: &AppHandle) -> bool {
    status(app).active
}

pub(crate) fn grant_for(app: &AppHandle, session_id: &str) -> Option<Grant> {
    app.try_state::<ComputerControlState>()?
        .grants
        .lock()
        .ok()?
        .get(session_id)
        .cloned()
}

pub(crate) fn set_grant(app: &AppHandle, session_id: &str, grant: Grant) {
    if let Some(state) = app.try_state::<ComputerControlState>() {
        if let Ok(mut grants) = state.grants.lock() {
            grants.insert(session_id.to_string(), grant);
        }
    }
    refresh(app);
}

pub(crate) fn clear_grant(app: &AppHandle, session_id: &str) {
    if let Some(state) = app.try_state::<ComputerControlState>() {
        if let Ok(mut grants) = state.grants.lock() {
            grants.remove(session_id);
        }
    }
    refresh(app);
}

/// Recompute who is controlling the computer and, if that changed, tell every
/// window and show or hide the indicators and the border.
pub(crate) fn refresh(app: &AppHandle) {
    let Some(state) = app.try_state::<ComputerControlState>() else {
        return;
    };
    let Some(chat) = app.try_state::<crate::engine::ChatState>() else {
        return;
    };
    let sessions = crate::engine::computer_controlling_sessions(chat.inner());
    let changed_status = match (state.current.lock(), state.grants.lock()) {
        (Ok(mut control), Ok(mut grants)) => {
            update(&mut control, &mut grants, sessions, now_ms()).then(|| status_of(&control))
        }
        _ => None,
    };
    let Some(status) = changed_status else {
        return;
    };
    let _ = app.emit(INDICATOR_EVENT, &status);
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || reconcile_windows(&app));
}

fn indicator_label(index: usize) -> String {
    format!("{INDICATOR_LABEL_PREFIX}{index}")
}

fn reconcile_windows(app: &AppHandle) {
    let Some(state) = app.try_state::<ComputerControlState>() else {
        return;
    };
    let Ok(_serialized) = state.windows.lock() else {
        return;
    };
    let (active, observed) = state.current.lock().map_or((false, None), |control| {
        (
            !control.sessions.is_empty(),
            control.observing.as_ref().map(|(_, grant)| grant.hwnd),
        )
    });
    let monitors = if active { monitors(app) } else { Vec::new() };
    let mut wanted: Vec<String> = (0..monitors.len()).map(indicator_label).collect();
    if observed.is_some() {
        wanted.push(BORDER_LABEL.to_string());
    }
    for (label, window) in app.webview_windows() {
        if label.starts_with(INDICATOR_LABEL_PREFIX) && !wanted.contains(&label) {
            let _ = window.destroy();
        }
    }
    for (index, monitor) in monitors.iter().enumerate() {
        let label = indicator_label(index);
        if app.get_webview_window(&label).is_some() {
            continue;
        }
        if let Err(error) = open_indicator(app, &label, monitor) {
            eprintln!("SomniQ desktop: could not show the computer-control indicator: {error}");
        }
    }
    if observed.is_some() {
        if app.get_webview_window(BORDER_LABEL).is_none() {
            if let Err(error) = open_border(app) {
                eprintln!("SomniQ desktop: could not show the observed-window border: {error}");
            }
        }
        start_border_tracking(app);
    }
}

fn monitors(app: &AppHandle) -> Vec<tauri::Monitor> {
    let listed = app
        .available_monitors()
        .ok()
        .filter(|monitors| !monitors.is_empty());
    listed
        .or_else(|| app.primary_monitor().ok().flatten().map(|monitor| vec![monitor]))
        .unwrap_or_default()
}

fn overlay_builder<'a>(
    app: &'a AppHandle,
    label: &'a str,
    url: &str,
) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title("SomniQ")
        .decorations(false)
        .transparent(true)
        .resizable(false)
        .shadow(false)
        .skip_taskbar(true)
        .always_on_top(true)
        // Appearing must not take the keyboard from whatever the user (or the
        // agent's target app) is typing into.
        .focused(false)
        .focusable(false)
        // Positioned in physical pixels after building, then shown: building
        // it visible would flash it at the default position first.
        .visible(false)
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn open_indicator(app: &AppHandle, label: &str, monitor: &tauri::Monitor) -> Result<(), String> {
    let scale = monitor.scale_factor();
    let width = (INDICATOR_WIDTH * scale).round() as u32;
    let height = (INDICATOR_HEIGHT * scale).round() as u32;
    let origin = monitor.position();
    let size = monitor.size();
    let x = origin.x + (i64::from(size.width) - i64::from(width)).max(0) as i32 / 2;
    let y = origin.y + (INDICATOR_TOP_MARGIN * scale).round() as i32;
    // Its own small entry: the indicator must not load the workspace bundle.
    let window = overlay_builder(app, label, "control-indicator.html")
        .build()
        .map_err(|error| error.to_string())?;
    let _ = window.set_position(PhysicalPosition::new(x, y));
    let _ = window.set_size(PhysicalSize::new(width, height));
    window.show().map_err(|error| error.to_string())
}

fn open_border(app: &AppHandle) -> Result<(), String> {
    let window = overlay_builder(app, BORDER_LABEL, "control-indicator.html?border=1")
        .build()
        .map_err(|error| error.to_string())?;
    // A frame around someone else's window: every click goes through it.
    window
        .set_ignore_cursor_events(true)
        .map_err(|error| error.to_string())
}

/// One thread at a time moves the border onto its window's current frame,
/// hides it while the window is minimized, and ends (destroying the border)
/// once nothing is observed any more.
fn start_border_tracking(app: &AppHandle) {
    let Some(state) = app.try_state::<ComputerControlState>() else {
        return;
    };
    if state.border_tracking.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("computer-control-border".into())
        .spawn(move || {
            let mut shown_at: Option<(i32, i32, i32, i32)> = None;
            loop {
                let Some(state) = app.try_state::<ComputerControlState>() else {
                    break;
                };
                let observed = state
                    .current
                    .lock()
                    .ok()
                    .and_then(|control| control.observing.as_ref().map(|(_, grant)| grant.hwnd));
                let Some(window) = app.get_webview_window(BORDER_LABEL) else {
                    if observed.is_none() {
                        break;
                    }
                    std::thread::sleep(BORDER_TRACK_INTERVAL);
                    continue;
                };
                let Some(hwnd) = observed else {
                    let _ = window.destroy();
                    break;
                };
                match frame::visible_frame(hwnd) {
                    Some(rect) if Some(rect) != shown_at => {
                        let (left, top, right, bottom) = rect;
                        let _ = window.set_position(PhysicalPosition::new(
                            left - BORDER_OUTSET,
                            top - BORDER_OUTSET,
                        ));
                        let _ = window.set_size(PhysicalSize::new(
                            (right - left + 2 * BORDER_OUTSET).unsigned_abs(),
                            (bottom - top + 2 * BORDER_OUTSET).unsigned_abs(),
                        ));
                        let _ = window.show();
                        shown_at = Some(rect);
                    }
                    Some(_) => {}
                    None => {
                        if shown_at.take().is_some() {
                            let _ = window.hide();
                        }
                    }
                }
                std::thread::sleep(BORDER_TRACK_INTERVAL);
            }
            if let Some(state) = app.try_state::<ComputerControlState>() {
                state.border_tracking.store(false, Ordering::SeqCst);
            }
        });
    if spawned.is_err() {
        state.border_tracking.store(false, Ordering::SeqCst);
    }
}

#[cfg(windows)]
mod frame {
    use std::ffi::c_void;
    use std::mem::size_of;

    use windows_sys::Win32::Foundation::{HWND, RECT};
    use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
    use windows_sys::Win32::UI::WindowsAndMessaging::{IsIconic, IsWindow, IsWindowVisible};

    /// The window's frame as drawn (no invisible resize border), in physical
    /// pixels; `None` when it is gone, hidden or minimized.
    pub(super) fn visible_frame(hwnd: isize) -> Option<(i32, i32, i32, i32)> {
        let handle = hwnd as HWND;
        // SAFETY: these accept any HWND value, including stale ones.
        let usable = unsafe {
            IsWindow(handle) != 0 && IsWindowVisible(handle) != 0 && IsIconic(handle) == 0
        };
        if !usable {
            return None;
        }
        let mut rect = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        // SAFETY: `rect` is a local of the size passed.
        let result = unsafe {
            DwmGetWindowAttribute(
                handle,
                DWMWA_EXTENDED_FRAME_BOUNDS as u32,
                (&raw mut rect).cast::<c_void>(),
                size_of::<RECT>() as u32,
            )
        };
        (result >= 0 && rect.right > rect.left && rect.bottom > rect.top)
            .then_some((rect.left, rect.top, rect.right, rect.bottom))
    }
}

#[cfg(not(windows))]
mod frame {
    pub(super) fn visible_frame(_hwnd: isize) -> Option<(i32, i32, i32, i32)> {
        None
    }
}

#[tauri::command]
pub fn computer_control_status(app: AppHandle) -> ControlStatus {
    status(&app)
}

/// The indicator's Stop button: cancel every turn that is controlling the
/// computer. Returns how many were asked to stop.
#[tauri::command]
pub fn computer_control_stop(app: AppHandle) -> Result<usize, String> {
    let sessions = status(&app).session_ids;
    let chat = app.state::<crate::engine::ChatState>();
    let mut stopped = 0;
    for session_id in &sessions {
        if crate::engine::cancel_chat_turn(chat.inner(), session_id).is_ok() {
            stopped += 1;
        }
    }
    crate::engine::emit_desktop_chat_run_state(&app);
    Ok(stopped)
}

#[cfg(test)]
#[path = "tests/computer_control.rs"]
mod tests;
