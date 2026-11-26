//! The crate's only `unsafe` code: Win32 window queries and UI Automation
//! (COM) calls through windows-rs.
//!
//! Safety model shared by every block below:
//! - Win32 window functions accept any `HWND` value, including stale ones;
//!   they fail or return zeros rather than touching freed memory.
//! - Output buffers are Rust-owned slices or locals that outlive the call,
//!   and their lengths are passed alongside.
//! - COM interface pointers come from windows-rs wrappers, which own one
//!   reference each and release it on drop; methods are called only on
//!   wrappers that are alive for the duration of the call.
//! - COM is initialised (MTA) on the calling thread by `com_init_mta` before
//!   any UIA object is created; UIA objects never leave that thread.
#![allow(unsafe_code)]

use std::ffi::c_void;
use std::time::{Duration, Instant};

use ::windows::core::{Interface, BOOL, BSTR, HRESULT, PWSTR};
use ::windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, POINT, RECT};
use ::windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use ::windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use ::windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use ::windows::Win32::System::Variant::{VARIANT, VT_BOOL, VT_BSTR, VT_I4};
use ::windows::Win32::UI::Accessibility::{
    CUIAutomation8, IUIAutomation, IUIAutomation2, IUIAutomationCacheRequest,
    IUIAutomationElement, IUIAutomationInvokePattern, IUIAutomationTogglePattern,
    IUIAutomationTreeWalker, IUIAutomationValuePattern, TreeScope_Element, TreeScope_Subtree,
    UIA_AutomationIdPropertyId, UIA_BoundingRectanglePropertyId, UIA_ClassNamePropertyId,
    UIA_ControlTypePropertyId, UIA_ExpandCollapseExpandCollapseStatePropertyId,
    UIA_FrameworkIdPropertyId, UIA_HasKeyboardFocusPropertyId, UIA_InvokePatternId,
    UIA_IsEnabledPropertyId, UIA_IsExpandCollapsePatternAvailablePropertyId,
    UIA_IsInvokePatternAvailablePropertyId, UIA_IsKeyboardFocusablePropertyId,
    UIA_IsLegacyIAccessiblePatternAvailablePropertyId, UIA_IsOffscreenPropertyId,
    UIA_IsPasswordPropertyId, UIA_IsScrollPatternAvailablePropertyId,
    UIA_IsSelectionItemPatternAvailablePropertyId, UIA_IsTextPatternAvailablePropertyId,
    UIA_IsTogglePatternAvailablePropertyId, UIA_IsValuePatternAvailablePropertyId,
    UIA_NamePropertyId, UIA_SelectionItemIsSelectedPropertyId, UIA_TogglePatternId,
    UIA_ToggleToggleStatePropertyId, UIA_ValueIsReadOnlyPropertyId, UIA_ValuePatternId,
    UIA_NativeWindowHandlePropertyId, UIA_ValueValuePropertyId, UIA_E_ELEMENTNOTAVAILABLE,
    UIA_E_TIMEOUT, UIA_PROPERTY_ID,
};
use ::windows::Win32::UI::HiDpi::{
    GetDpiForWindow, SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use ::windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetCursorPos, GetForegroundWindow, GetWindowLongPtrW,
    GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindow,
    IsWindowVisible, GWL_EXSTYLE, GWL_STYLE, WS_EX_TOOLWINDOW,
};
use ::windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC, SelectObject,
    BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
};
use ::windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};

use super::{Action, ActReport, ProbeError, Strategy, WalkLimits, WalkOutcome};
use crate::image::Bgra;
use crate::snapshot::{control_type_name, Actions, Node, Rect};

pub(super) struct RawWindow {
    pub hwnd: isize,
    pub pid: u32,
    pub image_path: Option<String>,
    pub class_name: String,
    pub rect: Rect,
    pub minimized: bool,
    pub dpi: u32,
}

pub(super) struct Enumeration {
    pub windows: Vec<RawWindow>,
    pub skipped_invisible: usize,
    pub skipped_cloaked: usize,
    pub skipped_tool_windows: usize,
}

fn to_hwnd(value: isize) -> HWND {
    HWND(value as *mut c_void)
}

fn from_hwnd(hwnd: HWND) -> isize {
    hwnd.0 as isize
}

pub(super) fn set_per_monitor_dpi() {
    // SAFETY: takes a constant context handle; fails harmlessly (access
    // denied) if the awareness was already set by a manifest or earlier call.
    let _ = unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
}

pub(super) fn com_init_mta() -> Result<(), ProbeError> {
    // SAFETY: called once at the start of a fresh worker thread; S_FALSE
    // (already initialised) is success. The thread never uninitialises, which
    // is fine for a thread that ends with the walk.
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
        .ok()
        .map_err(|error| ProbeError::new("HELPER_ERROR", format!("CoInitializeEx: {error}")))
}

pub(super) fn foreground_hwnd() -> isize {
    // SAFETY: no arguments; returns null when no window is in the foreground.
    from_hwnd(unsafe { GetForegroundWindow() })
}

pub(super) fn cursor_pos() -> (i32, i32) {
    let mut point = POINT::default();
    // SAFETY: `point` is a local that outlives the call.
    match unsafe { GetCursorPos(&raw mut point) } {
        Ok(()) => (point.x, point.y),
        Err(_) => (i32::MIN, i32::MIN),
    }
}

unsafe extern "system" fn collect_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
    // SAFETY: `lparam` is the address of the `Vec<HWND>` that
    // `enumerate_windows` passes to `EnumWindows`, which calls this callback
    // synchronously while that vector is alive and not otherwise borrowed.
    let handles = unsafe { &mut *(lparam.0 as *mut Vec<HWND>) };
    handles.push(hwnd);
    BOOL::from(true)
}

pub(super) fn enumerate_windows() -> Enumeration {
    let mut handles: Vec<HWND> = Vec::new();
    // SAFETY: see `collect_window`; `handles` outlives this synchronous call.
    let _ = unsafe {
        EnumWindows(
            Some(collect_window),
            LPARAM(&raw mut handles as isize),
        )
    };
    let mut enumeration = Enumeration {
        windows: Vec::new(),
        skipped_invisible: 0,
        skipped_cloaked: 0,
        skipped_tool_windows: 0,
    };
    for hwnd in handles {
        // SAFETY: any HWND value is accepted (module-level note).
        if !unsafe { IsWindowVisible(hwnd) }.as_bool() {
            enumeration.skipped_invisible += 1;
            continue;
        }
        if is_cloaked(hwnd) {
            enumeration.skipped_cloaked += 1;
            continue;
        }
        // SAFETY: as above. The extended style is a bit field; the
        // truncating cast keeps exactly the low 32 style bits.
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let ex_style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as u32;
        if ex_style & WS_EX_TOOLWINDOW.0 != 0 {
            enumeration.skipped_tool_windows += 1;
            continue;
        }
        if let Some(raw) = raw_window_from(hwnd) {
            enumeration.windows.push(raw);
        }
    }
    enumeration
}

fn is_cloaked(hwnd: HWND) -> bool {
    let mut cloaked: u32 = 0;
    // SAFETY: `cloaked` is a local u32, matching DWMWA_CLOAKED's documented
    // output type, and its size is passed.
    let result = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            (&raw mut cloaked).cast::<c_void>(),
            u32::try_from(std::mem::size_of::<u32>()).unwrap_or(4),
        )
    };
    result.is_ok() && cloaked != 0
}

pub(super) fn raw_window(hwnd: isize) -> Option<RawWindow> {
    let handle = to_hwnd(hwnd);
    // SAFETY: any HWND value is accepted.
    if !unsafe { IsWindow(Some(handle)) }.as_bool() {
        return None;
    }
    raw_window_from(handle)
}

fn raw_window_from(hwnd: HWND) -> Option<RawWindow> {
    let mut pid = 0u32;
    // SAFETY: `pid` is a local that outlives the call.
    let thread = unsafe { GetWindowThreadProcessId(hwnd, Some(&raw mut pid)) };
    if thread == 0 {
        return None;
    }
    let mut class = [0u16; 256];
    // SAFETY: `class` is a local buffer; the wrapper passes its length.
    let class_len = unsafe { GetClassNameW(hwnd, &mut class) };
    let mut rect = RECT::default();
    // SAFETY: `rect` is a local that outlives the call.
    let _ = unsafe { GetWindowRect(hwnd, &raw mut rect) };
    // SAFETY: any HWND value is accepted.
    let minimized = unsafe { IsIconic(hwnd) }.as_bool();
    // SAFETY: as above; returns 0 for an invalid window.
    let dpi = unsafe { GetDpiForWindow(hwnd) };
    Some(RawWindow {
        hwnd: from_hwnd(hwnd),
        pid,
        image_path: process_image(pid),
        class_name: utf16(&class, class_len),
        rect: to_rect(rect).unwrap_or_default(),
        minimized,
        dpi,
    })
}

pub(super) fn window_title(hwnd: isize) -> String {
    let mut title = [0u16; 512];
    // SAFETY: `title` is a local buffer; the wrapper passes its length.
    let len = unsafe { GetWindowTextW(to_hwnd(hwnd), &mut title) };
    utf16(&title, len)
}

fn process_image(pid: u32) -> Option<String> {
    // SAFETY: plain handle request; a failure (e.g. an elevated process) is
    // returned as an error, not a bad handle.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
    let mut buffer = [0u16; 1024];
    let mut size = u32::try_from(buffer.len()).unwrap_or(1024);
    // SAFETY: `buffer` outlives the call and `size` holds its capacity in
    // UTF-16 units; on success `size` is the written length.
    let result = unsafe {
        QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &raw mut size,
        )
    };
    // SAFETY: `process` was opened above and is closed exactly once here.
    let _ = unsafe { CloseHandle(process) };
    result.ok()?;
    Some(String::from_utf16_lossy(
        &buffer[..usize::try_from(size).unwrap_or(0).min(buffer.len())],
    ))
}

fn utf16(buffer: &[u16], len: i32) -> String {
    let len = usize::try_from(len).unwrap_or(0).min(buffer.len());
    String::from_utf16_lossy(&buffer[..len])
}

fn to_rect(rect: RECT) -> Option<Rect> {
    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;
    (width > 0 || height > 0).then_some(Rect {
        left: rect.left,
        top: rect.top,
        width,
        height,
    })
}

fn hresult_label(code: HRESULT) -> String {
    let raw = code.0.cast_unsigned();
    let name = match raw {
        UIA_E_TIMEOUT => "UIA_E_TIMEOUT",
        UIA_E_ELEMENTNOTAVAILABLE => "UIA_E_ELEMENTNOTAVAILABLE",
        0x8007_0005 => "E_ACCESSDENIED",
        0x8001_010A => "RPC_E_SERVERCALL_RETRYLATER",
        0x8001_0108 => "RPC_E_DISCONNECTED",
        0x8000_4005 => "E_FAIL",
        _ => return format!("0x{raw:08X}"),
    };
    format!("{name} (0x{raw:08X})")
}

fn uia_error(context: &str, error: &::windows::core::Error) -> ProbeError {
    let code = if error.code().0.cast_unsigned() == UIA_E_TIMEOUT {
        "HELPER_TIMEOUT"
    } else {
        "UIA_ERROR"
    };
    ProbeError::new(code, format!("{context}: {}", hresult_label(error.code())))
}

/// Every property a snapshot needs, fetched with the element in one call.
const CACHED_PROPERTIES: [UIA_PROPERTY_ID; 24] = [
    UIA_ControlTypePropertyId,
    UIA_NamePropertyId,
    UIA_AutomationIdPropertyId,
    UIA_ClassNamePropertyId,
    UIA_FrameworkIdPropertyId,
    UIA_BoundingRectanglePropertyId,
    UIA_IsEnabledPropertyId,
    UIA_IsOffscreenPropertyId,
    UIA_IsKeyboardFocusablePropertyId,
    UIA_HasKeyboardFocusPropertyId,
    UIA_IsPasswordPropertyId,
    UIA_IsInvokePatternAvailablePropertyId,
    UIA_IsValuePatternAvailablePropertyId,
    UIA_IsTogglePatternAvailablePropertyId,
    UIA_IsSelectionItemPatternAvailablePropertyId,
    UIA_IsExpandCollapsePatternAvailablePropertyId,
    UIA_IsScrollPatternAvailablePropertyId,
    UIA_IsTextPatternAvailablePropertyId,
    UIA_IsLegacyIAccessiblePatternAvailablePropertyId,
    // Not `ValueValue`: values are read one by one in `read_node`, after the
    // element is known not to be a password field, so a password never
    // crosses into this process.
    UIA_NativeWindowHandlePropertyId,
    UIA_ValueIsReadOnlyPropertyId,
    UIA_ToggleToggleStatePropertyId,
    UIA_SelectionItemIsSelectedPropertyId,
    UIA_ExpandCollapseExpandCollapseStatePropertyId,
];

struct Uia {
    automation: IUIAutomation,
    cache: IUIAutomationCacheRequest,
    walker: IUIAutomationTreeWalker,
}

impl Uia {
    fn new(strategy: Strategy, limits: &WalkLimits) -> Result<Self, ProbeError> {
        // SAFETY: COM is initialised on this thread (module-level note); the
        // created objects are owned wrappers used only on this thread.
        unsafe {
            let automation: IUIAutomation =
                CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)
                    .map_err(|error| uia_error("CoCreateInstance(CUIAutomation8)", &error))?;
            if let Ok(automation2) = automation.cast::<IUIAutomation2>() {
                let _ = automation2.SetConnectionTimeout(2_000);
                let _ = automation2.SetTransactionTimeout(limits.transaction_timeout_ms);
            }
            let cache = automation
                .CreateCacheRequest()
                .map_err(|error| uia_error("CreateCacheRequest", &error))?;
            for property in CACHED_PROPERTIES {
                cache
                    .AddProperty(property)
                    .map_err(|error| uia_error("AddProperty", &error))?;
            }
            let scope = match strategy {
                Strategy::Walker => TreeScope_Element,
                Strategy::Subtree => TreeScope_Subtree,
            };
            cache
                .SetTreeScope(scope)
                .map_err(|error| uia_error("SetTreeScope", &error))?;
            let control_view = automation
                .ControlViewCondition()
                .map_err(|error| uia_error("ControlViewCondition", &error))?;
            cache
                .SetTreeFilter(&control_view)
                .map_err(|error| uia_error("SetTreeFilter", &error))?;
            let walker = automation
                .ControlViewWalker()
                .map_err(|error| uia_error("ControlViewWalker", &error))?;
            Ok(Self {
                automation,
                cache,
                walker,
            })
        }
    }

    fn root(&self, hwnd: isize) -> Result<IUIAutomationElement, ProbeError> {
        // SAFETY: owned wrappers on this thread; a stale HWND fails with an
        // HRESULT.
        unsafe {
            self.automation
                .ElementFromHandleBuildCache(to_hwnd(hwnd), &self.cache)
                .map_err(|error| uia_error("ElementFromHandle", &error))
        }
    }
}

struct WalkState {
    limits: WalkLimits,
    started: Instant,
    elements: usize,
    calls: usize,
    stopped_by: Option<String>,
    /// Live elements in pre-order, when the caller needs to act on one.
    collected: Option<Vec<IUIAutomationElement>>,
    /// Values still allowed to be read this walk (each is a cross-process
    /// call; a Qt app reports a value pattern on every element).
    value_budget: usize,
}

impl WalkState {
    fn new(limits: WalkLimits, collect: bool) -> Self {
        Self {
            limits,
            started: Instant::now(),
            elements: 0,
            calls: 0,
            stopped_by: None,
            collected: collect.then(Vec::new),
            value_budget: limits.max_values,
        }
    }

    /// Records a newly visited element; returns false once a limit is hit.
    fn admit(&mut self) -> bool {
        if self.stopped_by.is_some() {
            return false;
        }
        if self.elements >= self.limits.max_elements {
            self.stopped_by = Some("max_elements".to_string());
            return false;
        }
        if self.started.elapsed() >= self.limits.deadline {
            self.stopped_by = Some("deadline".to_string());
            return false;
        }
        self.elements += 1;
        true
    }
}

fn read_node(element: &IUIAutomationElement, value_cap: usize, value_budget: &mut usize) -> Node {
    let password =
        cached_bool(element, UIA_IsPasswordPropertyId).unwrap_or(false) || is_password_edit(element);
    let actions = Actions {
        invoke: flag(element, UIA_IsInvokePatternAvailablePropertyId),
        value: flag(element, UIA_IsValuePatternAvailablePropertyId),
        toggle: flag(element, UIA_IsTogglePatternAvailablePropertyId),
        select: flag(element, UIA_IsSelectionItemPatternAvailablePropertyId),
        expand: flag(element, UIA_IsExpandCollapsePatternAvailablePropertyId),
        scroll: flag(element, UIA_IsScrollPatternAvailablePropertyId),
        text: flag(element, UIA_IsTextPatternAvailablePropertyId),
        legacy: flag(element, UIA_IsLegacyIAccessiblePatternAvailablePropertyId),
    };
    // The second, password-aware step: a value is fetched only once the
    // element is known not to be a password field, so no password ever
    // reaches this process.
    let value = if password || !actions.value || *value_budget == 0 {
        None
    } else {
        *value_budget -= 1;
        current_string(element, UIA_ValueValuePropertyId)
            .map(|value| value.chars().take(value_cap).collect())
    };
    // SAFETY: `element` is a live wrapper built with this thread's cache
    // request; `Cached*` accessors only read that local cache.
    let (control_type, name, automation_id, class_name, framework_id, rect) = unsafe {
        (
            element.CachedControlType().map_or(0, |id| id.0),
            element.CachedName().map(|text| text.to_string()).unwrap_or_default(),
            element
                .CachedAutomationId()
                .map(|text| text.to_string())
                .unwrap_or_default(),
            element
                .CachedClassName()
                .map(|text| text.to_string())
                .unwrap_or_default(),
            element
                .CachedFrameworkId()
                .map(|text| text.to_string())
                .unwrap_or_default(),
            element.CachedBoundingRectangle().ok().and_then(to_rect),
        )
    };
    Node {
        control_type,
        name,
        automation_id,
        class_name,
        framework_id,
        rect,
        enabled: cached_bool(element, UIA_IsEnabledPropertyId).unwrap_or(true),
        offscreen: cached_bool(element, UIA_IsOffscreenPropertyId).unwrap_or(false),
        focusable: cached_bool(element, UIA_IsKeyboardFocusablePropertyId).unwrap_or(false),
        focused: cached_bool(element, UIA_HasKeyboardFocusPropertyId).unwrap_or(false),
        password,
        value,
        value_read_only: if actions.value {
            cached_bool(element, UIA_ValueIsReadOnlyPropertyId)
        } else {
            None
        },
        toggle_state: if actions.toggle {
            cached_i32(element, UIA_ToggleToggleStatePropertyId)
        } else {
            None
        },
        selected: if actions.select {
            cached_bool(element, UIA_SelectionItemIsSelectedPropertyId)
        } else {
            None
        },
        expand_state: if actions.expand {
            cached_i32(element, UIA_ExpandCollapseExpandCollapseStatePropertyId)
        } else {
            None
        },
        actions,
        children: Vec::new(),
        children_error: None,
    }
}

fn cached_variant(element: &IUIAutomationElement, property: UIA_PROPERTY_ID) -> Option<VARIANT> {
    // SAFETY: reads this thread's local cache for a property that was added
    // to the cache request; an absent property is an error, not UB.
    unsafe { element.GetCachedPropertyValue(property) }.ok()
}

// Unsupported properties come back as UIA's "not supported" sentinel (a
// VT_UNKNOWN). These readers accept exactly one variant type each and
// return `None` for anything else, instead of the coercing conversions
// (`VariantToBoolean` etc.) windows-rs offers.
fn cached_bool(element: &IUIAutomationElement, property: UIA_PROPERTY_ID) -> Option<bool> {
    let value = cached_variant(element, property)?;
    // SAFETY: the union field is read only after checking its discriminant.
    unsafe {
        let inner = &value.Anonymous.Anonymous;
        (inner.vt == VT_BOOL).then(|| inner.Anonymous.boolVal.0 != 0)
    }
}

fn cached_i32(element: &IUIAutomationElement, property: UIA_PROPERTY_ID) -> Option<i32> {
    let value = cached_variant(element, property)?;
    // SAFETY: the union field is read only after checking its discriminant.
    unsafe {
        let inner = &value.Anonymous.Anonymous;
        (inner.vt == VT_I4).then(|| inner.Anonymous.lVal)
    }
}

fn current_string(element: &IUIAutomationElement, property: UIA_PROPERTY_ID) -> Option<String> {
    // SAFETY: a live element on this thread; one cross-process property read
    // bounded by the transaction timeout.
    let value = unsafe { element.GetCurrentPropertyValue(property) }.ok()?;
    // SAFETY: the union field is read only after checking its discriminant.
    unsafe {
        let inner = &value.Anonymous.Anonymous;
        (inner.vt == VT_BSTR).then(|| inner.Anonymous.bstrVal.to_string())
    }
}

/// A classic Win32 edit with `ES_PASSWORD`, whatever its provider reports
/// for `IsPassword` (the managed client in Windows PowerShell 5.1 reports
/// false for `WinForms` password boxes).
fn is_password_edit(element: &IUIAutomationElement) -> bool {
    const ES_PASSWORD: isize = 0x20;
    let Some(handle) = cached_i32(element, UIA_NativeWindowHandlePropertyId).filter(|h| *h != 0) else {
        return false;
    };
    // SAFETY: reads this thread's local cache.
    let class = unsafe { element.CachedClassName() }
        .map(|text| text.to_string().to_ascii_uppercase())
        .unwrap_or_default();
    if !class.contains("EDIT") {
        return false;
    }
    // SAFETY: any HWND value is accepted; a stale one yields 0.
    let style = unsafe { GetWindowLongPtrW(to_hwnd(handle as isize), GWL_STYLE) };
    style & ES_PASSWORD != 0
}

fn flag(element: &IUIAutomationElement, property: UIA_PROPERTY_ID) -> bool {
    cached_bool(element, property).unwrap_or(false)
}

/// `GetFirstChild`/`GetNextSibling` signal "none" with a null element,
/// which windows-rs surfaces as an error whose code is `S_OK`.
fn next_element(
    result: ::windows::core::Result<IUIAutomationElement>,
) -> Result<Option<IUIAutomationElement>, String> {
    match result {
        Ok(element) => Ok(Some(element)),
        Err(error) if error.code().is_ok() => Ok(None),
        Err(error) => Err(hresult_label(error.code())),
    }
}

fn walk_children(
    uia: &Uia,
    parent: &IUIAutomationElement,
    depth: usize,
    state: &mut WalkState,
) -> (Vec<Node>, Option<String>) {
    let mut nodes = Vec::new();
    if depth > state.limits.max_depth {
        return (nodes, Some("max_depth".to_string()));
    }
    state.calls += 1;
    // SAFETY: owned walker and cache on this thread; `parent` is live.
    let mut next = unsafe { uia.walker.GetFirstChildElementBuildCache(parent, &uia.cache) };
    loop {
        let child = match next_element(next) {
            Ok(Some(child)) => child,
            Ok(None) => return (nodes, None),
            Err(label) => return (nodes, Some(label)),
        };
        if !state.admit() {
            // Only the node where the limit hit is marked; ancestors unwind.
            return (nodes, state.stopped_by.clone());
        }
        let cap = state.limits.value_cap_chars;
        let mut node = read_node(&child, cap, &mut state.value_budget);
        if let Some(collected) = state.collected.as_mut() {
            collected.push(child.clone());
        }
        let (children, error) = walk_children(uia, &child, depth + 1, state);
        node.children = children;
        node.children_error = error;
        nodes.push(node);
        if state.stopped_by.is_some() {
            return (nodes, None);
        }
        state.calls += 1;
        // SAFETY: as above; `child` is live.
        next = unsafe { uia.walker.GetNextSiblingElementBuildCache(&child, &uia.cache) };
    }
}

fn cached_tree(element: &IUIAutomationElement, depth: usize, state: &mut WalkState) -> Node {
    let cap = state.limits.value_cap_chars;
    let mut node = read_node(element, cap, &mut state.value_budget);
    if depth >= state.limits.max_depth {
        return node;
    }
    // SAFETY: local cache reads on a live element built with a subtree
    // cache request; a leaf yields a null array (error with S_OK code).
    let children = unsafe { element.GetCachedChildren() };
    let array = match children {
        Ok(array) => array,
        Err(error) if error.code().is_ok() => return node,
        Err(error) => {
            node.children_error = Some(hresult_label(error.code()));
            return node;
        }
    };
    // SAFETY: as above.
    let length = unsafe { array.Length() }.unwrap_or(0);
    for index in 0..length {
        if !state.admit() {
            node.children_error.clone_from(&state.stopped_by);
            break;
        }
        // SAFETY: `index` is within `0..Length()` of this live array.
        let Ok(child) = (unsafe { array.GetElement(index) }) else {
            continue;
        };
        node.children.push(cached_tree(&child, depth + 1, state));
    }
    node
}

fn millis(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1_000.0
}

pub(super) fn walk(
    hwnd: isize,
    strategy: Strategy,
    limits: WalkLimits,
) -> Result<WalkOutcome, ProbeError> {
    let uia = Uia::new(strategy, &limits)?;
    let mut state = WalkState::new(limits, false);
    walk_with(&uia, hwnd, strategy, &mut state)
}

fn walk_with(
    uia: &Uia,
    hwnd: isize,
    strategy: Strategy,
    state: &mut WalkState,
) -> Result<WalkOutcome, ProbeError> {
    let started = Instant::now();
    let root_element = uia.root(hwnd)?;
    state.calls += 1;
    state.elements = 1;
    if let Some(collected) = state.collected.as_mut() {
        collected.push(root_element.clone());
    }
    match strategy {
        Strategy::Walker => {
            let cap = state.limits.value_cap_chars;
            let mut root = read_node(&root_element, cap, &mut state.value_budget);
            let (children, error) = walk_children(uia, &root_element, 1, state);
            root.children = children;
            root.children_error = error;
            Ok(WalkOutcome {
                strategy,
                root,
                elements: state.elements,
                cross_process_calls: state.calls,
                fetch_ms: millis(started.elapsed()),
                convert_ms: 0.0,
                stopped_by: state.stopped_by.clone(),
            })
        }
        Strategy::Subtree => {
            let fetched = started.elapsed();
            let converting = Instant::now();
            let root = cached_tree(&root_element, 0, state);
            Ok(WalkOutcome {
                strategy,
                root,
                elements: state.elements,
                cross_process_calls: state.calls,
                fetch_ms: millis(fetched),
                convert_ms: millis(converting.elapsed()),
                stopped_by: state.stopped_by.clone(),
            })
        }
    }
}

pub(super) fn act(
    hwnd: isize,
    reference: usize,
    limits: WalkLimits,
    action: &Action,
    verify: &dyn Fn(&Node) -> Result<(), ProbeError>,
) -> Result<ActReport, ProbeError> {
    let uia = Uia::new(Strategy::Walker, &limits)?;
    let mut state = WalkState::new(limits, true);
    let walked = walk_with(&uia, hwnd, Strategy::Walker, &mut state)?;
    let collected = state.collected.take().unwrap_or_default();
    let element = reference
        .checked_sub(1)
        .and_then(|index| collected.get(index))
        .ok_or_else(|| {
            ProbeError::new(
                "STALE_SNAPSHOT",
                format!("当前树里没有 e{reference}（共 {} 个元素）", collected.len()),
            )
        })?;
    let mut one_value = 1;
    let target = read_node(element, limits.value_cap_chars, &mut one_value);
    verify(&target)?;
    let started = Instant::now();
    // SAFETY: `element` is a live wrapper on this thread; pattern objects
    // are owned wrappers released on drop. A provider that does not support
    // the pattern returns an error (or a null pattern, also an error).
    let result = unsafe {
        match action {
            Action::Invoke => element
                .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
                .and_then(|pattern| pattern.Invoke()),
            Action::SetValue(text) => element
                .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                .and_then(|pattern| pattern.SetValue(&BSTR::from(text.as_str()))),
            Action::Toggle => element
                .GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
                .and_then(|pattern| pattern.Toggle()),
        }
    };
    let action_ms = millis(started.elapsed());
    result.map_err(|error| {
        if error.code().is_ok() {
            ProbeError::new(
                "UNSUPPORTED_ACTION",
                format!("e{reference} 不支持 {}", action.label()),
            )
        } else {
            uia_error(action.label(), &error)
        }
    })?;
    Ok(ActReport {
        reference,
        action: action.label(),
        target_control_type: control_type_name(target.control_type),
        target_name: target.name,
        walk_ms: walked.fetch_ms,
        action_ms,
    })
}

/// Renders one window into top-down BGRA with `PrintWindow`. The window
/// draws itself into our bitmap, so whatever overlaps it on screen is never
/// in the picture. Physical pixels (the process is per-monitor DPI aware).
pub(super) fn capture_window(hwnd: isize) -> Result<Bgra, ProbeError> {
    /// `PW_RENDERFULLCONTENT`: needed for `DirectComposition` content
    /// (Chromium, XAML); windows-rs does not name it.
    const RENDER_FULL_CONTENT: PRINT_WINDOW_FLAGS = PRINT_WINDOW_FLAGS(2);
    let handle = to_hwnd(hwnd);
    let mut rect = RECT::default();
    // SAFETY: `rect` is a local that outlives the call.
    unsafe { GetWindowRect(handle, &raw mut rect) }
        .map_err(|error| ProbeError::new("WINDOW_GONE", error.to_string()))?;
    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;
    if width <= 0 || height <= 0 || width > 16_384 || height > 16_384 {
        return Err(ProbeError::new("CAPTURE_FAILED", format!("窗口尺寸异常：{width}×{height}")));
    }
    let info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: u32::try_from(std::mem::size_of::<BITMAPINFOHEADER>()).unwrap_or(40),
            biWidth: width,
            // Negative height: top-down rows.
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    // SAFETY: every GDI object created here is released below on all paths;
    // `bits` points into the DIB section, valid until `DeleteObject(dib)`,
    // and is read only for `width * height * 4` bytes, the size requested.
    unsafe {
        let screen = GetDC(None);
        let memory = CreateCompatibleDC(Some(screen));
        let mut bits: *mut c_void = std::ptr::null_mut();
        let dib = CreateDIBSection(Some(memory), &raw const info, DIB_RGB_COLORS, &raw mut bits, None, 0);
        let result = match dib {
            Ok(dib) if !bits.is_null() => {
                let previous = SelectObject(memory, dib.into());
                let printed = PrintWindow(handle, memory, RENDER_FULL_CONTENT).as_bool();
                let length = usize::try_from(width).unwrap_or(0) * usize::try_from(height).unwrap_or(0) * 4;
                let pixels = std::slice::from_raw_parts(bits.cast::<u8>(), length).to_vec();
                SelectObject(memory, previous);
                let _ = DeleteObject(dib.into());
                if printed {
                    Ok(Bgra {
                        width: width.cast_unsigned(),
                        height: height.cast_unsigned(),
                        pixels,
                    })
                } else {
                    Err(ProbeError::new("CAPTURE_FAILED", "PrintWindow 失败"))
                }
            }
            Ok(dib) => {
                let _ = DeleteObject(dib.into());
                Err(ProbeError::new("CAPTURE_FAILED", "无法分配截图缓冲区"))
            }
            Err(error) => Err(ProbeError::new("CAPTURE_FAILED", error.to_string())),
        };
        let _ = DeleteDC(memory);
        ReleaseDC(None, screen);
        result
    }
}
