//! Windows backend (R0): window enumeration, read-only UI Automation
//! snapshots, and an action probe that only accepts the fixture window.
//!
//! Every UIA operation runs on a dedicated MTA worker thread with a hard
//! deadline, because a provider whose UI thread is hung blocks the calling
//! thread inside COM. On timeout the caller gets `HELPER_TIMEOUT` and the
//! worker is abandoned (the probe is a short-lived CLI; the real helper will
//! be a separate process the host can kill, per the design).

mod ffi;

use std::sync::mpsc;
use std::time::Duration;

use serde::Serialize;

use crate::policy::{self, Classification, Tier};
use crate::snapshot::{Node, Rect};

#[derive(Debug, Clone, Serialize)]
pub struct ProbeError {
    pub code: &'static str,
    pub message: String,
}

impl ProbeError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ProbeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ProbeError {}

/// A top-level window. `title` is empty for protected windows: their titles
/// are never read.
#[derive(Debug, Clone, Serialize)]
pub struct WindowInfo {
    pub hwnd: isize,
    pub pid: u32,
    pub image_path: Option<String>,
    pub exe_name: String,
    pub class_name: String,
    pub title: String,
    pub rect: Rect,
    pub minimized: bool,
    pub dpi: u32,
    pub foreground: bool,
    pub classification: Classification,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct WindowList {
    pub windows: Vec<WindowInfo>,
    /// Protected windows: counted, never described.
    pub hidden_by_policy: usize,
    pub skipped_invisible: usize,
    pub skipped_cloaked: usize,
    pub skipped_tool_windows: usize,
}

/// How the tree is fetched.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Strategy {
    /// `IUIAutomationTreeWalker` with a per-element cache: about two
    /// cross-process calls per element, but each one is small and the walk
    /// can stop at any depth, count, or deadline.
    Walker,
    /// One `TreeScope_Subtree` cache request for the whole control view: a
    /// single cross-process call, then local reads. Cannot be bounded while
    /// it runs.
    Subtree,
}

#[derive(Debug, Clone, Copy)]
pub struct WalkLimits {
    pub max_depth: usize,
    pub max_elements: usize,
    /// Wall-clock budget for one walk; also the worker-thread deadline.
    pub deadline: Duration,
    /// `IUIAutomation2::TransactionTimeout`, per cross-process call.
    pub transaction_timeout_ms: u32,
    /// Values longer than this are clipped when read (document text can be
    /// megabytes).
    pub value_cap_chars: usize,
    /// Most values read per walk; each is a separate cross-process call.
    pub max_values: usize,
}

impl Default for WalkLimits {
    fn default() -> Self {
        Self {
            max_depth: 40,
            max_elements: 5_000,
            deadline: Duration::from_secs(20),
            transaction_timeout_ms: 5_000,
            value_cap_chars: 4_000,
            max_values: 300,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct WalkOutcome {
    pub strategy: Strategy,
    #[serde(skip)]
    pub root: Node,
    pub elements: usize,
    pub cross_process_calls: usize,
    /// Time spent fetching from the provider (for `walker` this is the whole
    /// walk, since reads are interleaved).
    pub fetch_ms: f64,
    /// Time spent turning cached elements into [`Node`]s (`subtree` only).
    pub convert_ms: f64,
    /// Set when a limit stopped the walk early.
    pub stopped_by: Option<String>,
}

/// Foreground window and cursor position, to check whether reading or a
/// background action moved either.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct InputState {
    pub foreground_hwnd: isize,
    pub cursor: (i32, i32),
}

#[derive(Debug, Clone)]
pub enum Action {
    Invoke,
    SetValue(String),
    Toggle,
}

impl Action {
    #[must_use]
    pub fn label(&self) -> &'static str {
        match self {
            Self::Invoke => "invoke",
            Self::SetValue(_) => "set_value",
            Self::Toggle => "toggle",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ActReport {
    pub reference: usize,
    pub action: &'static str,
    pub target_control_type: &'static str,
    pub target_name: String,
    pub walk_ms: f64,
    pub action_ms: f64,
}

/// Opts the process into per-monitor DPI awareness so UIA rectangles are
/// physical pixels. Harmless if a manifest already set it.
pub fn enable_per_monitor_dpi() {
    ffi::set_per_monitor_dpi();
}

#[must_use]
pub fn input_state() -> InputState {
    InputState {
        foreground_hwnd: ffi::foreground_hwnd(),
        cursor: ffi::cursor_pos(),
    }
}

/// Lists visible top-level windows. Protected windows are only counted.
#[must_use]
pub fn list_windows() -> WindowList {
    let enumeration = ffi::enumerate_windows();
    let foreground = ffi::foreground_hwnd();
    let mut list = WindowList {
        skipped_invisible: enumeration.skipped_invisible,
        skipped_cloaked: enumeration.skipped_cloaked,
        skipped_tool_windows: enumeration.skipped_tool_windows,
        ..WindowList::default()
    };
    for raw in enumeration.windows {
        let info = describe(raw, foreground);
        if info.classification.tier == Tier::Protected {
            list.hidden_by_policy += 1;
        } else {
            list.windows.push(info);
        }
    }
    list
}

/// Describes one window, or `None` if the handle no longer names a window.
#[must_use]
pub fn window_info(hwnd: isize) -> Option<WindowInfo> {
    ffi::raw_window(hwnd).map(|raw| describe(raw, ffi::foreground_hwnd()))
}

fn describe(raw: ffi::RawWindow, foreground: isize) -> WindowInfo {
    let image = raw.image_path.clone().unwrap_or_default();
    let classification = policy::classify(&image);
    let title = if classification.tier == Tier::Protected {
        String::new()
    } else {
        ffi::window_title(raw.hwnd)
    };
    WindowInfo {
        hwnd: raw.hwnd,
        pid: raw.pid,
        exe_name: policy::exe_file_name(&image),
        image_path: raw.image_path,
        class_name: raw.class_name,
        title,
        rect: raw.rect,
        minimized: raw.minimized,
        dpi: raw.dpi,
        foreground: raw.hwnd == foreground,
        classification,
    }
}

/// Reads the control tree of a non-protected window.
pub fn snapshot(
    hwnd: isize,
    strategy: Strategy,
    limits: WalkLimits,
) -> Result<WalkOutcome, ProbeError> {
    let info = window_info(hwnd).ok_or_else(|| gone(hwnd))?;
    if info.classification.tier == Tier::Protected {
        return Err(ProbeError::new(
            "PROTECTED_TARGET",
            info.classification.reason.to_string(),
        ));
    }
    run_on_worker(limits.deadline, move || ffi::walk(hwnd, strategy, limits))
}

/// Performs one background UIA action on element `e<reference>` of the R0
/// fixture window, after re-walking the tree and checking that the element
/// still has the expected name. Refuses every other window, and refuses to
/// write into password fields.
pub fn act_on_fixture(
    hwnd: isize,
    reference: usize,
    expected_name: &str,
    action: Action,
    limits: WalkLimits,
) -> Result<ActReport, ProbeError> {
    let info = window_info(hwnd).ok_or_else(|| gone(hwnd))?;
    let image = info.image_path.clone().unwrap_or_default();
    if !policy::is_fixture_window(&info.title, &image) {
        return Err(ProbeError::new(
            "NOT_FIXTURE",
            format!(
                "R0 只允许操作标题以“{}”开头、由 PowerShell 承载的测试窗口",
                policy::FIXTURE_TITLE_PREFIX
            ),
        ));
    }
    let expected = expected_name.to_string();
    run_on_worker(limits.deadline, move || {
        ffi::act(hwnd, reference, limits, &action, &|node: &Node| {
            if node.name != expected {
                return Err(ProbeError::new(
                    "STALE_SNAPSHOT",
                    format!(
                        "e{reference} 现在是 {:?}，不是预期的 {expected:?}；请重新快照",
                        node.name
                    ),
                ));
            }
            let writes = matches!(action, Action::SetValue(_));
            if writes && node.password {
                return Err(ProbeError::new(
                    "PROTECTED_TARGET",
                    "密码框不接受写入".to_string(),
                ));
            }
            Ok(())
        })
    })
}

/// Renders a non-protected, non-minimized window into BGRA pixels. Runs on a
/// worker with a deadline: `PrintWindow` waits on the target's UI thread.
pub fn capture(hwnd: isize, deadline: Duration) -> Result<crate::image::Bgra, ProbeError> {
    let info = window_info(hwnd).ok_or_else(|| gone(hwnd))?;
    if info.classification.tier == Tier::Protected {
        return Err(ProbeError::new(
            "PROTECTED_TARGET",
            info.classification.reason.to_string(),
        ));
    }
    if info.minimized {
        return Err(ProbeError::new(
            "WINDOW_MINIMIZED",
            "窗口已最小化，没有可截取的内容；请让用户还原窗口".to_string(),
        ));
    }
    run_on_worker(deadline, move || ffi::capture_window(hwnd))
}

fn gone(hwnd: isize) -> ProbeError {
    ProbeError::new("WINDOW_GONE", format!("窗口 {hwnd:#x} 已不存在"))
}

fn run_on_worker<T, F>(deadline: Duration, work: F) -> Result<T, ProbeError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, ProbeError> + Send + 'static,
{
    let (sender, receiver) = mpsc::channel();
    std::thread::Builder::new()
        .name("uia-probe".to_string())
        .spawn(move || {
            let result = ffi::com_init_mta().and_then(|()| work());
            let _ = sender.send(result);
        })
        .map_err(|error| ProbeError::new("HELPER_ERROR", error.to_string()))?;
    // A little slack over the walk's own deadline, so a walk that stops
    // itself on time still reports its partial tree.
    receiver
        .recv_timeout(deadline + Duration::from_secs(2))
        .unwrap_or_else(|_| {
            Err(ProbeError::new(
                "HELPER_TIMEOUT",
                format!(
                    "UIA 调用超过 {} 毫秒未返回（目标窗口可能无响应）",
                    deadline.as_millis()
                ),
            ))
        })
}
