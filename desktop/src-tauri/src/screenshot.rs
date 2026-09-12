//! Global-hotkey region screenshot.
//!
//! Pressing the system-wide shortcut freezes every monitor behind a borderless
//! overlay window that shows the just-captured pixels; the user drags a
//! rectangle and the crop lands in the chat composer as an image attachment.
//!
//! The capture happens *before* the overlays appear, so what the user selects
//! is exactly what was on screen when the hotkey fired — and so the overlay
//! chrome can never end up inside its own screenshot.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde::Serialize;
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};
use xcap::image::codecs::png::{CompressionType, FilterType, PngEncoder};
use xcap::image::{ExtendedColorType, ImageEncoder, RgbaImage};
use xcap::Monitor;

/// Default binding. `CmdOrCtrl` resolves to Command on macOS and Control
/// elsewhere; `Shift+A` avoids the browser/editor `Ctrl+Alt` conflicts that
/// other screenshot tools already occupy.
pub const DEFAULT_SHORTCUT: &str = "CmdOrCtrl+Shift+A";

/// Overlay windows are labelled `screenshot-overlay-<index>`; `capabilities/
/// screenshot-overlay.json` grants this prefix its (minimal) permissions.
const OVERLAY_LABEL_PREFIX: &str = "screenshot-overlay-";

/// Emitted to the main window once a crop has been staged in the project's
/// upload directory.
const SCREENSHOT_EVENT: &str = "chat-screenshot";

/// How long an overlay gets to report that it has its capture in the DOM before
/// it is shown regardless. Only a broken frontend ever waits this long; the
/// timeout exists so a failure leaves the user an overlay they can Escape out of
/// rather than an invisible window that swallows the hotkey.
const OVERLAY_READY_TIMEOUT: Duration = Duration::from_millis(2000);

#[derive(Default)]
pub struct ScreenshotState {
    /// Per-overlay capture, consumed by `screenshot_overlay_context`. Empty
    /// whenever no selection is in flight.
    shots: Mutex<HashMap<String, MonitorShot>>,
    /// Serializes hotkey presses: a second press while the overlay is up must
    /// not start a second capture pass.
    capture: Mutex<()>,
    /// Label of the overlay that should take the keyboard once it becomes
    /// visible — the one on the monitor under the pointer.
    focused: Mutex<Option<String>>,
    /// Crops pinned to the desktop, by window label. Outlives the selection
    /// that produced them; entries are dropped when their window closes.
    pins: Mutex<HashMap<String, PinnedCrop>>,
    /// Monotonic, so a pin label is never reused by a later pin.
    pin_seq: Mutex<u64>,
    shortcut: Mutex<ShortcutStatus>,
}

/// A crop floating on the desktop: the annotated PNG plus the size it was
/// pinned at, which zooming is always measured against so repeated steps cannot
/// drift.
struct PinnedCrop {
    image: Vec<u8>,
    width: u32,
    height: u32,
}

struct MonitorShot {
    /// Encoded PNG for the overlay's frozen background. Handed to the overlay
    /// as raw bytes rather than a data URL: a full-screen capture is megabytes,
    /// and base64 in a JSON string costs an encode, an escape, a parse and a
    /// decode that the user waits through before the overlay can appear.
    image: Vec<u8>,
    /// Capture size in device pixels. The overlay divides by these to map a
    /// CSS-pixel selection back onto the captured image.
    width: u32,
    height: u32,
    /// This monitor's origin on the virtual desktop. A pinned crop is placed at
    /// `origin + selection`, so it appears exactly over the pixels it froze.
    origin_x: i32,
    origin_y: i32,
    /// Snap targets for hover-to-select-a-window, front-to-back.
    windows: Vec<WindowRegion>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutStatus {
    /// Accelerator string as registered, e.g. `CmdOrCtrl+Shift+A`.
    pub shortcut: String,
    pub registered: bool,
    /// Why registration failed — typically another application already owns
    /// the combination. Surfaced in Settings instead of failing silently.
    pub error: Option<String>,
}

impl Default for ShortcutStatus {
    fn default() -> Self {
        Self {
            shortcut: DEFAULT_SHORTCUT.to_string(),
            registered: false,
            error: None,
        }
    }
}

/// One snap target: a top-level window, clipped to the overlay's monitor and
/// expressed in that overlay's own device pixels.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowRegion {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub title: String,
}

/// Everything the overlay needs except the pixels, which travel separately as
/// raw bytes. Small enough that its JSON round-trip is free.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayContext {
    pub width: u32,
    pub height: u32,
    /// Front-to-back, so the first region containing the pointer is the window
    /// the user actually sees there.
    pub windows: Vec<WindowRegion>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScreenshotAttachment {
    /// Workspace-relative path produced by `chat_import_attachment_data`.
    path: String,
    name: String,
    /// Inline `data:` thumbnail. The composer renders attachments straight
    /// from `path`, which a webview cannot load, so the crop carries its own
    /// preview.
    preview: Option<String>,
}

pub fn set_shortcut_status(state: &ScreenshotState, status: ShortcutStatus) {
    if let Ok(mut slot) = state.shortcut.lock() {
        *slot = status;
    }
}

fn overlay_label(index: usize) -> String {
    format!("{OVERLAY_LABEL_PREFIX}{index}")
}

fn encode_png(image: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut png = Vec::new();
    // Full-screen captures are large and short-lived: fast compression keeps
    // the hotkey-to-overlay latency well under a frame budget that matters.
    PngEncoder::new_with_quality(&mut png, CompressionType::Fast, FilterType::NoFilter)
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            ExtendedColorType::Rgba8,
        )
        .map_err(|error| format!("could not encode the screen capture: {error}"))?;
    Ok(png)
}

/// Geometry + pixels for one monitor, in the order `Monitor::all` reports.
struct CapturedMonitor {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    shot: MonitorShot,
}

/// A top-level window in virtual-desktop device pixels, before it is clipped
/// onto any one monitor.
struct DesktopWindow {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    title: String,
}

/// Snap targets, front-to-back. Enumeration failures are not fatal: losing
/// window snapping is far better than losing the screenshot.
///
/// `xcap` deliberately skips windows owned by the calling process, so SomniQ's
/// own window would never be a snap target — clicking inside it silently
/// grabbed whatever happened to sit behind it. Our windows are enumerated
/// separately and spliced back in by z-order.
fn desktop_windows() -> Vec<DesktopWindow> {
    let depths = window_depths();
    let others = xcap::Window::all().unwrap_or_default();
    let ranked = others
        .into_iter()
        .enumerate()
        .filter_map(|(index, window)| {
            // A minimized window's bounds are off-screen garbage.
            if window.is_minimized().unwrap_or(false) {
                return None;
            }
            let width = window.width().ok()?;
            let height = window.height().ok()?;
            if width == 0 || height == 0 {
                return None;
            }
            // Without a shared enumeration to rank against (every platform but
            // Windows) `xcap`'s own order already is the z-order.
            let depth = window
                .id()
                .ok()
                .and_then(|id| depths.get(&id).copied())
                .unwrap_or(index);
            Some((
                depth,
                DesktopWindow {
                    x: window.x().ok()?,
                    y: window.y().ok()?,
                    width,
                    height,
                    title: window.title().unwrap_or_default(),
                },
            ))
        })
        .collect();
    merge_snap_targets(own_process_windows(), ranked)
}

/// Interleave our own windows with the ones `xcap` reported, using the shared
/// front-to-back depth both lists were ranked against.
fn merge_snap_targets(
    own: Vec<(usize, DesktopWindow)>,
    others: Vec<(usize, DesktopWindow)>,
) -> Vec<DesktopWindow> {
    let mut ranked = own;
    ranked.extend(others);
    ranked.sort_by_key(|(depth, _)| *depth);
    ranked.into_iter().map(|(_, window)| window).collect()
}

#[cfg(windows)]
fn window_depths() -> HashMap<u32, usize> {
    win32::window_depths()
}

#[cfg(not(windows))]
fn window_depths() -> HashMap<u32, usize> {
    HashMap::new()
}

#[cfg(windows)]
fn own_process_windows() -> Vec<(usize, DesktopWindow)> {
    win32::own_process_windows()
}

#[cfg(not(windows))]
fn own_process_windows() -> Vec<(usize, DesktopWindow)> {
    Vec::new()
}

/// Recovers the snap targets `xcap` refuses to report: its enumeration drops
/// every window owned by the calling process, guarding against `GetWindowText`
/// deadlocking when a window's own message loop is blocked. The capture runs on
/// a blocking worker while the main loop is free, so the call is safe here — and
/// SomniQ's window is precisely the one a user pressing the hotkey means to
/// capture.
#[cfg(windows)]
mod win32 {
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::mem::size_of;

    use windows_sys::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows_sys::Win32::Graphics::Dwm::{
        DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcessId;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowLongPtrW, GetWindowTextLengthW, GetWindowTextW,
        GetWindowThreadProcessId, IsIconic, IsWindowVisible, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
    };

    use super::DesktopWindow;

    unsafe extern "system" fn push_handle(hwnd: HWND, lparam: LPARAM) -> i32 {
        let handles = unsafe { &mut *(lparam as *mut Vec<HWND>) };
        handles.push(hwnd);
        // Non-zero keeps the enumeration going.
        1
    }

    /// Every top-level window, front-to-back — the order `EnumWindows`
    /// documents and the order `xcap` inherits from it.
    fn top_level_windows() -> Vec<HWND> {
        let mut handles: Vec<HWND> = Vec::new();
        unsafe {
            EnumWindows(
                Some(push_handle),
                &mut handles as *mut Vec<HWND> as LPARAM,
            );
        }
        handles
    }

    /// Keyed the way `xcap::Window::id` reports a handle, so the two
    /// enumerations can be correlated.
    fn handle_id(hwnd: HWND) -> u32 {
        hwnd as usize as u32
    }

    pub(super) fn window_depths() -> HashMap<u32, usize> {
        top_level_windows()
            .into_iter()
            .enumerate()
            .map(|(depth, hwnd)| (handle_id(hwnd), depth))
            .collect()
    }

    fn window_title(hwnd: HWND) -> String {
        let length = unsafe { GetWindowTextLengthW(hwnd) };
        if length <= 0 {
            return String::new();
        }
        let mut buffer = vec![0u16; length as usize + 1];
        let written = unsafe { GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
        if written <= 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buffer[..written as usize])
    }

    /// A cloaked window is composited out of sight — another virtual desktop, or
    /// a suspended UWP host. It is invisible to the capture, so offering it as a
    /// snap target would highlight a rectangle of somebody else's pixels.
    fn is_cloaked(hwnd: HWND) -> bool {
        let mut cloaked = 0u32;
        let result = unsafe {
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED as u32,
                &mut cloaked as *mut u32 as *mut c_void,
                size_of::<u32>() as u32,
            )
        };
        result >= 0 && cloaked != 0
    }

    /// The frame as drawn, without the invisible resize border `GetWindowRect`
    /// includes — and in the same virtual-desktop device pixels `xcap` reports.
    fn frame_bounds(hwnd: HWND) -> Option<RECT> {
        let mut rect = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        let result = unsafe {
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_EXTENDED_FRAME_BOUNDS as u32,
                &mut rect as *mut RECT as *mut c_void,
                size_of::<RECT>() as u32,
            )
        };
        if result < 0 || rect.right <= rect.left || rect.bottom <= rect.top {
            return None;
        }
        Some(rect)
    }

    pub(super) fn own_process_windows() -> Vec<(usize, DesktopWindow)> {
        let own_pid = unsafe { GetCurrentProcessId() };
        top_level_windows()
            .into_iter()
            .enumerate()
            .filter_map(|(depth, hwnd)| {
                let mut pid = 0u32;
                unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
                if pid != own_pid {
                    return None;
                }
                if unsafe { IsWindowVisible(hwnd) } == 0 || unsafe { IsIconic(hwnd) } != 0 {
                    return None;
                }
                let ex_style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as u32;
                if ex_style & WS_EX_TOOLWINDOW != 0 {
                    return None;
                }
                if is_cloaked(hwnd) {
                    return None;
                }
                // A captionless top-level window of ours is scaffolding (the
                // event-loop target tao keeps around), never a snap target.
                let title = window_title(hwnd);
                if title.is_empty() {
                    return None;
                }
                let rect = frame_bounds(hwnd)?;
                Some((
                    depth,
                    DesktopWindow {
                        x: rect.left,
                        y: rect.top,
                        width: (rect.right - rect.left) as u32,
                        height: (rect.bottom - rect.top) as u32,
                        title,
                    },
                ))
            })
            .collect()
    }
}

/// Smallest snap target worth offering, in device pixels on a side. Below this
/// the highlight is more likely to be a stray helper window than something the
/// user means to capture.
const MIN_SNAP_TARGET_PX: u32 = 24;

/// Intersect a window with a monitor and re-express it in that monitor's own
/// (overlay-local) device pixels. `None` when they barely overlap.
fn clip_window_to_monitor(
    window: (i32, i32, u32, u32),
    monitor: (i32, i32, u32, u32),
) -> Option<(i32, i32, u32, u32)> {
    let (wx, wy, ww, wh) = window;
    let (mx, my, mw, mh) = monitor;
    let left = wx.max(mx);
    let top = wy.max(my);
    let right = wx.saturating_add(ww as i32).min(mx.saturating_add(mw as i32));
    let bottom = wy.saturating_add(wh as i32).min(my.saturating_add(mh as i32));
    let width = u32::try_from(right - left).ok()?;
    let height = u32::try_from(bottom - top).ok()?;
    if width < MIN_SNAP_TARGET_PX || height < MIN_SNAP_TARGET_PX {
        return None;
    }
    Some((left - mx, top - my, width, height))
}

fn capture_monitors() -> Result<Vec<CapturedMonitor>, String> {
    let monitors =
        Monitor::all().map_err(|error| format!("could not enumerate monitors: {error}"))?;
    if monitors.is_empty() {
        return Err("no monitor is available to capture".to_string());
    }
    let windows = desktop_windows();
    let mut captured = Vec::with_capacity(monitors.len());
    for monitor in monitors {
        let image = monitor
            .capture_image()
            .map_err(|error| format!("could not capture the screen: {error}"))?;
        let (width, height) = (image.width(), image.height());
        if width == 0 || height == 0 {
            continue;
        }
        let x = monitor.x().map_err(|error| error.to_string())?;
        let y = monitor.y().map_err(|error| error.to_string())?;
        let regions = windows
            .iter()
            .filter_map(|window| {
                let (left, top, clipped_width, clipped_height) = clip_window_to_monitor(
                    (window.x, window.y, window.width, window.height),
                    (x, y, width, height),
                )?;
                Some(WindowRegion {
                    x: left,
                    y: top,
                    width: clipped_width,
                    height: clipped_height,
                    title: window.title.clone(),
                })
            })
            .collect();
        captured.push(CapturedMonitor {
            x,
            y,
            // The overlay must cover the monitor exactly. Trust the captured
            // bitmap's own size rather than the mode's reported size, which
            // can disagree under rotation or a stale display mode.
            width,
            height,
            shot: MonitorShot {
                image: encode_png(&image)?,
                width,
                height,
                origin_x: x,
                origin_y: y,
                windows: regions,
            },
        });
    }
    if captured.is_empty() {
        return Err("no monitor produced a usable capture".to_string());
    }
    Ok(captured)
}

fn close_overlays(app: &tauri::AppHandle) {
    for (label, window) in app.webview_windows() {
        if label.starts_with(OVERLAY_LABEL_PREFIX) {
            let _ = window.destroy();
        }
    }
}

fn clear_shots(state: &ScreenshotState) {
    if let Ok(mut shots) = state.shots.lock() {
        shots.clear();
    }
    if let Ok(mut focused) = state.focused.lock() {
        *focused = None;
    }
}

/// Index of the monitor under the pointer — the one whose overlay must take
/// keyboard focus, so Escape reaches the window the user is looking at.
fn focused_overlay_index(app: &tauri::AppHandle, captured: &[CapturedMonitor]) -> usize {
    let Ok(cursor) = app.cursor_position() else {
        return 0;
    };
    let bounds: Vec<(i32, i32, u32, u32)> = captured
        .iter()
        .map(|monitor| (monitor.x, monitor.y, monitor.width, monitor.height))
        .collect();
    index_containing_point(&bounds, cursor.x as i32, cursor.y as i32)
}

fn index_containing_point(bounds: &[(i32, i32, u32, u32)], x: i32, y: i32) -> usize {
    bounds
        .iter()
        .position(|&(left, top, width, height)| {
            x >= left
                && y >= top
                && x < left.saturating_add(width as i32)
                && y < top.saturating_add(height as i32)
        })
        .unwrap_or(0)
}

fn open_overlays(app: &tauri::AppHandle, captured: Vec<CapturedMonitor>) -> Result<(), String> {
    let state = app.state::<ScreenshotState>();
    {
        let mut shots = state
            .shots
            .lock()
            .map_err(|_| "screenshot state lock is poisoned".to_string())?;
        shots.clear();
        for (index, monitor) in captured.iter().enumerate() {
            shots.insert(
                overlay_label(index),
                MonitorShot {
                    image: monitor.shot.image.clone(),
                    width: monitor.shot.width,
                    height: monitor.shot.height,
                    origin_x: monitor.shot.origin_x,
                    origin_y: monitor.shot.origin_y,
                    windows: monitor.shot.windows.clone(),
                },
            );
        }
    }

    let focused = focused_overlay_index(app, &captured);
    if let Ok(mut slot) = state.focused.lock() {
        *slot = Some(overlay_label(focused));
    }
    for (index, monitor) in captured.iter().enumerate() {
        let label = overlay_label(index);
        let window = WebviewWindowBuilder::new(
            app,
            &label,
            // Its own Vite entry rather than `index.html`: the overlay must
            // paint a frozen capture the moment WebView2 is up, and sharing the
            // workspace entry made it evaluate the entire SomniQ bundle first.
            WebviewUrl::App("overlay.html".into()),
        )
        .title("SomniQ Screenshot")
        .decorations(false)
        .resizable(false)
        .shadow(false)
        .skip_taskbar(true)
        .always_on_top(true)
        // Stays hidden until `screenshot_overlay_ready`: positioning happens in
        // physical pixels below, and a freshly built WebView2 paints the app's
        // own background before React has the capture — which is what flashed
        // grey across the whole screen on every hotkey press.
        .visible(false)
        .build()
        .map_err(|error| {
            clear_shots(&state);
            format!("could not open the screenshot overlay: {error}")
        })?;

        let _ = window.set_position(PhysicalPosition::new(monitor.x, monitor.y));
        let _ = window.set_size(PhysicalSize::new(monitor.width, monitor.height));
        disable_show_animation(&window);
    }

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(OVERLAY_READY_TIMEOUT).await;
        reveal_overlays(&app);
    });
    Ok(())
}

/// Windows plays its default show transition the first time a window becomes
/// visible. On a full-screen overlay that reads as the capture sliding or
/// fading into place; the selection UI has to appear the instant it is ready.
#[cfg(windows)]
fn disable_show_animation(window: &tauri::WebviewWindow) {
    use std::ffi::c_void;
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED,
    };

    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let disabled: i32 = 1;
    unsafe {
        DwmSetWindowAttribute(
            hwnd.0 as *mut c_void,
            DWMWA_TRANSITIONS_FORCEDISABLED as u32,
            &disabled as *const i32 as *const c_void,
            std::mem::size_of::<i32>() as u32,
        );
    }
}

#[cfg(not(windows))]
fn disable_show_animation(_window: &tauri::WebviewWindow) {}

/// Show one overlay that has its capture in the DOM, and hand it the keyboard
/// if it is the one under the pointer. Idempotent: the ready report and the
/// timeout both land here and only the first one does anything.
fn reveal_overlay(app: &tauri::AppHandle, label: &str) {
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        return;
    }
    let _ = window.show();
    let focused = app
        .state::<ScreenshotState>()
        .focused
        .lock()
        .ok()
        .and_then(|slot| slot.clone());
    if focused.as_deref() == Some(label) {
        let _ = window.set_focus();
    }
}

fn reveal_overlays(app: &tauri::AppHandle) {
    let labels: Vec<String> = app
        .webview_windows()
        .into_keys()
        .filter(|label| label.starts_with(OVERLAY_LABEL_PREFIX))
        .collect();
    for label in labels {
        reveal_overlay(app, &label);
    }
}

fn begin(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<ScreenshotState>();
    let _guard = state
        .capture
        .lock()
        .map_err(|_| "screenshot capture lock is poisoned".to_string())?;
    // A repeated hotkey press while the overlay is up is a no-op, not a second
    // capture pass stacked on top of the first.
    if app
        .webview_windows()
        .keys()
        .any(|label| label.starts_with(OVERLAY_LABEL_PREFIX))
    {
        return Ok(());
    }
    let captured = capture_monitors()?;
    open_overlays(&app, captured)
}

/// Capture every monitor and raise the selection overlay. Invoked by the
/// global shortcut handler and by the composer's camera button.
#[tauri::command]
pub async fn screenshot_capture_begin(app: tauri::AppHandle) -> Result<(), String> {
    // Window creation has to drive the main event loop on Windows; running it
    // from the synchronous IPC path would deadlock WebView2 creation.
    tauri::async_runtime::spawn_blocking(move || begin(app))
        .await
        .map_err(|error| error.to_string())?
}

/// Geometry and snap targets for this overlay window.
#[tauri::command]
pub fn screenshot_overlay_context(
    window: tauri::Window,
    state: tauri::State<'_, ScreenshotState>,
) -> Result<OverlayContext, String> {
    let shots = state
        .shots
        .lock()
        .map_err(|_| "screenshot state lock is poisoned".to_string())?;
    let shot = shots
        .get(window.label())
        .ok_or_else(|| "this screenshot overlay has no capture".to_string())?;
    Ok(OverlayContext {
        width: shot.width,
        height: shot.height,
        windows: shot.windows.clone(),
    })
}

/// The frozen pixels this overlay window should paint, as a PNG the frontend
/// wraps in a blob URL. Raw bytes rather than a field on `OverlayContext`: at
/// full-screen sizes the base64-in-JSON detour was a visible part of the delay
/// between pressing the hotkey and seeing the selection UI.
#[tauri::command]
pub fn screenshot_overlay_image(
    window: tauri::Window,
    state: tauri::State<'_, ScreenshotState>,
) -> Result<tauri::ipc::Response, String> {
    let shots = state
        .shots
        .lock()
        .map_err(|_| "screenshot state lock is poisoned".to_string())?;
    let shot = shots
        .get(window.label())
        .ok_or_else(|| "this screenshot overlay has no capture".to_string())?;
    Ok(tauri::ipc::Response::new(shot.image.clone()))
}

/// The overlay has decoded its capture and committed it to the DOM, so it can
/// be revealed without showing a frame of anything else.
#[tauri::command]
pub fn screenshot_overlay_ready(app: tauri::AppHandle, window: tauri::Window) -> Result<(), String> {
    let label = window.label().to_string();
    if label.starts_with(OVERLAY_LABEL_PREFIX) {
        reveal_overlay(&app, &label);
    }
    Ok(())
}

/// Dismiss the overlay without producing an attachment (Escape, right-click,
/// or a zero-area drag).
#[tauri::command]
pub fn screenshot_cancel(app: tauri::AppHandle) -> Result<(), String> {
    close_overlays(&app);
    clear_shots(&app.state::<ScreenshotState>());
    Ok(())
}

/// Hand a staged crop to the main window's chat composer.
#[tauri::command]
pub fn screenshot_attach(
    app: tauri::AppHandle,
    path: String,
    name: String,
    preview: Option<String>,
) -> Result<(), String> {
    // Deliver first: destroying the calling overlay tears down the webview
    // waiting on this response, so anything that can fail has to happen while
    // the overlay is still alive to show the error.
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "the main window is not available".to_string())?;
    window
        .emit(
            SCREENSHOT_EVENT,
            ScreenshotAttachment {
                path,
                name,
                preview,
            },
        )
        .map_err(|error| error.to_string())?;
    close_overlays(&app);
    clear_shots(&app.state::<ScreenshotState>());
    // The hotkey works from other applications, so the window that receives
    // the crop is usually behind them.
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    Ok(())
}

/// The PNG bytes behind a `data:image/png;base64,...` URL, which is how the
/// overlay hands over its *edited* crop rather than whatever is on disk.
fn decode_png_data_url(png: &str) -> Result<Vec<u8>, String> {
    let encoded = png.split_once("base64,").map(|(_, data)| data).unwrap_or(png);
    BASE64_STANDARD
        .decode(encoded)
        .map_err(|error| format!("could not decode the screenshot: {error}"))
}

fn write_png_to_clipboard(app: &tauri::AppHandle, png: &str) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;

    let bytes = decode_png_data_url(png)?;
    let image = tauri::image::Image::from_bytes(&bytes)
        .map_err(|error| format!("could not read the screenshot: {error}"))?;
    app.clipboard()
        .write_image(&image)
        .map_err(|error| format!("could not write to the clipboard: {error}"))
}

/// Put the annotated crop on the system clipboard and dismiss the overlay.
#[tauri::command]
pub fn screenshot_copy(app: tauri::AppHandle, png: String) -> Result<(), String> {
    // Same ordering rule as `screenshot_attach`: fail before the overlay dies.
    write_png_to_clipboard(&app, &png)?;
    close_overlays(&app);
    clear_shots(&app.state::<ScreenshotState>());
    Ok(())
}

// ---------------------------------------------------------------------------
// Pinning a crop to the desktop
// ---------------------------------------------------------------------------

/// Pinned crops are labelled `screenshot-pin-<n>`; `capabilities/
/// screenshot-pin.json` grants that prefix the little it needs.
const PIN_LABEL_PREFIX: &str = "screenshot-pin-";

/// A pin below this is impossible to grab or close by mouse. Enforced on the
/// zoom path, where repeated shrinking would otherwise reach zero.
const MIN_PIN_SIDE_PX: u32 = 24;

/// Runaway zoom on a large crop can allocate a window bigger than any display;
/// well past "readable" is the useful ceiling.
const MAX_PIN_SIDE_PX: u32 = 20_000;

/// The selection, in the capture's device pixels, that the overlay wants pinned.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Float the annotated crop over the desktop as a borderless always-on-top
/// window, placed exactly over the pixels it froze so it looks like the
/// selection simply stayed behind.
#[tauri::command]
pub async fn screenshot_pin(
    app: tauri::AppHandle,
    window: tauri::Window,
    png: String,
    rect: PinRect,
) -> Result<(), String> {
    // Same constraint as `screenshot_capture_begin`: building a webview has to
    // drive the main event loop, which a synchronous command would be holding.
    tauri::async_runtime::spawn_blocking(move || pin(app, window, png, rect))
        .await
        .map_err(|error| error.to_string())?
}

fn pin(
    app: tauri::AppHandle,
    window: tauri::Window,
    png: String,
    rect: PinRect,
) -> Result<(), String> {
    if rect.width == 0 || rect.height == 0 {
        return Err("the pinned region is empty".to_string());
    }
    let bytes = decode_png_data_url(&png)?;
    let state = app.state::<ScreenshotState>();

    // Where the crop sits on the virtual desktop, from the monitor its overlay
    // covers. Read before anything is torn down.
    let (origin_x, origin_y) = {
        let shots = state
            .shots
            .lock()
            .map_err(|_| "screenshot state lock is poisoned".to_string())?;
        let shot = shots
            .get(window.label())
            .ok_or_else(|| "this screenshot overlay has no capture".to_string())?;
        (shot.origin_x, shot.origin_y)
    };

    let label = {
        let mut seq = state
            .pin_seq
            .lock()
            .map_err(|_| "screenshot pin counter is poisoned".to_string())?;
        *seq += 1;
        format!("{PIN_LABEL_PREFIX}{seq}")
    };

    // Registered before the window exists: its webview asks for these bytes as
    // soon as it boots, which can happen before `build` returns.
    {
        let mut pins = state
            .pins
            .lock()
            .map_err(|_| "screenshot pin state is poisoned".to_string())?;
        pins.insert(
            label.clone(),
            PinnedCrop {
                image: bytes,
                width: rect.width,
                height: rect.height,
            },
        );
    }

    let pin = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("overlay.html".into()))
        .title("SomniQ Pin")
        .decorations(false)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        // Same reasoning as the overlay: revealed by `screenshot_pin_ready`
        // once it has pixels, never while it is still the app's background.
        .visible(false)
        .build()
        .map_err(|error| {
            forget_pin(&app, &label);
            format!("could not pin the screenshot: {error}")
        })?;

    let _ = pin.set_position(PhysicalPosition::new(
        origin_x.saturating_add(rect.x),
        origin_y.saturating_add(rect.y),
    ));
    let _ = pin.set_size(PhysicalSize::new(rect.width, rect.height));
    disable_show_animation(&pin);

    let timeout_app = app.clone();
    let timeout_label = label.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(OVERLAY_READY_TIMEOUT).await;
        reveal_pin(&timeout_app, &timeout_label);
    });

    // The selection is now a window of its own, so the overlay's work is done.
    close_overlays(&app);
    clear_shots(&state);
    Ok(())
}

/// The pixels this pin window should paint.
#[tauri::command]
pub fn screenshot_pin_image(
    window: tauri::Window,
    state: tauri::State<'_, ScreenshotState>,
) -> Result<tauri::ipc::Response, String> {
    let pins = state
        .pins
        .lock()
        .map_err(|_| "screenshot pin state is poisoned".to_string())?;
    let pin = pins
        .get(window.label())
        .ok_or_else(|| "this pin has no image".to_string())?;
    Ok(tauri::ipc::Response::new(pin.image.clone()))
}

fn reveal_pin(app: &tauri::AppHandle, label: &str) {
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        return;
    }
    let _ = window.show();
}

/// The pin has its image in the DOM and can be revealed.
#[tauri::command]
pub fn screenshot_pin_ready(app: tauri::AppHandle, window: tauri::Window) -> Result<(), String> {
    let label = window.label().to_string();
    if label.starts_with(PIN_LABEL_PREFIX) {
        reveal_pin(&app, &label);
    }
    Ok(())
}

/// One side of a zoomed pin, held inside the range where the window is still
/// both grabbable and allocatable.
fn scaled_pin_side(base: u32, scale: f64) -> u32 {
    ((base as f64 * scale).round() as i64).clamp(MIN_PIN_SIDE_PX as i64, MAX_PIN_SIDE_PX as i64)
        as u32
}

/// Resize a pin around its top-left corner. The factor is always applied to the
/// size it was pinned at, so a sequence of zoom steps cannot accumulate
/// rounding error.
#[tauri::command]
pub fn screenshot_pin_scale(
    window: tauri::Window,
    state: tauri::State<'_, ScreenshotState>,
    scale: f64,
) -> Result<(), String> {
    if !scale.is_finite() || scale <= 0.0 {
        return Err("a pin cannot be scaled by that factor".to_string());
    }
    let pins = state
        .pins
        .lock()
        .map_err(|_| "screenshot pin state is poisoned".to_string())?;
    let pin = pins
        .get(window.label())
        .ok_or_else(|| "this pin has no image".to_string())?;
    window
        .set_size(PhysicalSize::new(
            scaled_pin_side(pin.width, scale),
            scaled_pin_side(pin.height, scale),
        ))
        .map_err(|error| format!("could not resize the pin: {error}"))
}

/// Put a pin's image back on the clipboard without disturbing the pin.
#[tauri::command]
pub fn screenshot_pin_copy(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: tauri::State<'_, ScreenshotState>,
) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;

    let bytes = {
        let pins = state
            .pins
            .lock()
            .map_err(|_| "screenshot pin state is poisoned".to_string())?;
        pins.get(window.label())
            .ok_or_else(|| "this pin has no image".to_string())?
            .image
            .clone()
    };
    let image = tauri::image::Image::from_bytes(&bytes)
        .map_err(|error| format!("could not read the pinned image: {error}"))?;
    app.clipboard()
        .write_image(&image)
        .map_err(|error| format!("could not write to the clipboard: {error}"))
}

fn forget_pin(app: &tauri::AppHandle, label: &str) {
    if let Ok(mut pins) = app.state::<ScreenshotState>().pins.lock() {
        pins.remove(label);
    }
}

/// Take a pin off the desktop. Drops its pixels first: `destroy` tears down the
/// webview that is waiting on this response, so nothing may fail after it.
#[tauri::command]
pub fn screenshot_pin_close(app: tauri::AppHandle, window: tauri::Window) -> Result<(), String> {
    let label = window.label().to_string();
    if !label.starts_with(PIN_LABEL_PREFIX) {
        return Ok(());
    }
    forget_pin(&app, &label);
    if let Some(pin) = app.get_webview_window(&label) {
        let _ = pin.destroy();
    }
    Ok(())
}

/// Which accelerator is live, and why it is not if it failed to register.
#[tauri::command]
pub fn screenshot_shortcut_status(
    state: tauri::State<'_, ScreenshotState>,
) -> Result<ShortcutStatus, String> {
    state
        .shortcut
        .lock()
        .map(|status| status.clone())
        .map_err(|_| "screenshot shortcut lock is poisoned".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlay_labels_carry_the_capability_prefix() {
        assert_eq!(overlay_label(0), "screenshot-overlay-0");
        assert!(overlay_label(3).starts_with(OVERLAY_LABEL_PREFIX));
    }

    #[test]
    fn a_window_is_clipped_into_its_monitors_local_pixels() {
        let monitor = (1920, 0, 1920, 1080);
        // Straddles the seam between the primary and the right-hand monitor.
        assert_eq!(
            clip_window_to_monitor((1720, 100, 400, 300), monitor),
            Some((0, 100, 200, 300)),
        );
        // Fully inside: only the origin shifts.
        assert_eq!(
            clip_window_to_monitor((2000, 50, 800, 600), monitor),
            Some((80, 50, 800, 600)),
        );
    }

    #[test]
    fn slivers_and_windows_on_other_monitors_are_not_snap_targets() {
        let monitor = (0, 0, 1920, 1080);
        // Entirely on the neighbouring display.
        assert_eq!(clip_window_to_monitor((2000, 0, 800, 600), monitor), None);
        // One pixel of overlap is a rendering artifact, not a target.
        assert_eq!(clip_window_to_monitor((-799, 0, 800, 600), monitor), None);
    }

    #[test]
    fn the_monitor_under_the_cursor_takes_focus() {
        // A primary 1920x1080 with a second display to its left, as Windows
        // reports it: negative origin, different size.
        let bounds = [(0, 0, 1920, 1080), (-2560, -200, 2560, 1440)];
        assert_eq!(index_containing_point(&bounds, 10, 10), 0);
        assert_eq!(index_containing_point(&bounds, -100, -100), 1);
        // A right/bottom edge belongs to the next monitor, not this one.
        assert_eq!(index_containing_point(&bounds, 1920, 500), 0);
        // A pointer nowhere at all still yields a real overlay.
        assert_eq!(index_containing_point(&bounds, 99_999, 99_999), 0);
    }

    fn target(title: &str) -> DesktopWindow {
        DesktopWindow {
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            title: title.to_string(),
        }
    }

    #[test]
    fn our_own_windows_are_spliced_in_by_z_order() {
        // `xcap` never reports SomniQ's own window, so a click inside it used
        // to select whatever was behind it. Depth 1 puts it back in front of
        // the folder it covers.
        let merged = merge_snap_targets(
            vec![(1, target("SomniQ"))],
            vec![(0, target("Always on top")), (2, target("Explorer"))],
        );
        let titles: Vec<&str> = merged.iter().map(|window| window.title.as_str()).collect();
        assert_eq!(titles, ["Always on top", "SomniQ", "Explorer"]);
    }

    #[test]
    fn without_our_own_windows_the_reported_order_survives() {
        let merged = merge_snap_targets(
            Vec::new(),
            vec![(0, target("front")), (1, target("back"))],
        );
        let titles: Vec<&str> = merged.iter().map(|window| window.title.as_str()).collect();
        assert_eq!(titles, ["front", "back"]);
    }

    #[test]
    fn a_zoomed_pin_stays_grabbable_and_allocatable() {
        assert_eq!(scaled_pin_side(200, 1.0), 200);
        assert_eq!(scaled_pin_side(200, 2.5), 500);
        // Zooming all the way out still leaves something to click and drag.
        assert_eq!(scaled_pin_side(200, 0.01), MIN_PIN_SIDE_PX);
        // And all the way in stops short of a window no display can hold.
        assert_eq!(scaled_pin_side(9_000, 8.0), MAX_PIN_SIDE_PX);
    }

    #[test]
    fn pin_labels_carry_their_own_capability_prefix() {
        // Distinct from the overlay prefix, so `close_overlays` never takes a
        // pinned crop down with the selection that produced it.
        assert!(!PIN_LABEL_PREFIX.starts_with(OVERLAY_LABEL_PREFIX));
        assert!(!OVERLAY_LABEL_PREFIX.starts_with(PIN_LABEL_PREFIX));
    }

    #[test]
    fn a_data_url_and_a_bare_payload_decode_alike() {
        let bytes = encode_png(&RgbaImage::from_pixel(
            2,
            2,
            xcap::image::Rgba([9, 9, 9, 255]),
        ))
        .expect("encode");
        let encoded = BASE64_STANDARD.encode(&bytes);
        assert_eq!(
            decode_png_data_url(&format!("data:image/png;base64,{encoded}")).expect("data url"),
            bytes,
        );
        assert_eq!(decode_png_data_url(&encoded).expect("bare"), bytes);
    }

    #[test]
    fn encode_png_produces_a_decodable_png() {
        let image = RgbaImage::from_pixel(4, 3, xcap::image::Rgba([12, 34, 56, 255]));
        let bytes = encode_png(&image).expect("encode");
        let decoded = xcap::image::load_from_memory(&bytes).expect("png");
        assert_eq!((decoded.width(), decoded.height()), (4, 3));
    }

    #[test]
    fn shortcut_status_defaults_to_unregistered_default_binding() {
        let status = ShortcutStatus::default();
        assert_eq!(status.shortcut, DEFAULT_SHORTCUT);
        assert!(!status.registered);
        assert!(status.error.is_none());
    }

    #[test]
    fn set_shortcut_status_replaces_the_stored_value() {
        let state = ScreenshotState::default();
        set_shortcut_status(
            &state,
            ShortcutStatus {
                shortcut: "CmdOrCtrl+Shift+A".to_string(),
                registered: false,
                error: Some("already taken".to_string()),
            },
        );
        let stored = state.shortcut.lock().expect("lock").clone();
        assert!(!stored.registered);
        assert_eq!(stored.error.as_deref(), Some("already taken"));
    }
}
