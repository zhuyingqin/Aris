//! Platform-independent control-tree model and the text a text-only model
//! would see.
//!
//! The probe walks a window's UI Automation tree into [`Node`]s; this module
//! numbers them, renders them as indented lines, and measures the result. The
//! numbering is the R0 version of the design's element references: every
//! node gets `e<N>` in pre-order over the *whole* walked tree, so filtering
//! what is shown never renumbers anything, and a later walk of an unchanged
//! window yields the same numbers.

use std::collections::BTreeMap;
use std::fmt::Write as _;

use serde::Serialize;

/// Screen rectangle in physical pixels (the probe is per-monitor DPI aware).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub width: i32,
    pub height: i32,
}

/// Which UI Automation control patterns an element reports as available.
/// `invoke`..`scroll` are direct (background) actions; `text` means the
/// element exposes readable document text; `legacy` is the MSAA bridge.
#[allow(clippy::struct_excessive_bools)] // one flag per UIA pattern, mirrors the API
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Actions {
    pub invoke: bool,
    pub value: bool,
    pub toggle: bool,
    pub select: bool,
    pub expand: bool,
    pub scroll: bool,
    pub text: bool,
    pub legacy: bool,
}

impl Actions {
    /// True when at least one pattern can act on the element without the
    /// real mouse or keyboard.
    #[must_use]
    pub fn any_direct(&self) -> bool {
        self.invoke || self.value || self.toggle || self.select || self.expand || self.scroll
    }

    fn labels(self) -> Vec<&'static str> {
        let mut labels = Vec::new();
        for (on, label) in [
            (self.invoke, "invoke"),
            (self.value, "value"),
            (self.toggle, "toggle"),
            (self.select, "select"),
            (self.expand, "expand"),
            (self.scroll, "scroll"),
            (self.text, "text"),
        ] {
            if on {
                labels.push(label);
            }
        }
        labels
    }
}

/// One element of a walked control tree.
#[allow(clippy::struct_excessive_bools)] // one flag per UIA boolean property
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Node {
    /// Raw `UIA_*ControlTypeId`; see [`control_type_name`].
    pub control_type: i32,
    pub name: String,
    pub automation_id: String,
    pub class_name: String,
    pub framework_id: String,
    pub rect: Option<Rect>,
    pub enabled: bool,
    pub offscreen: bool,
    pub focusable: bool,
    pub focused: bool,
    pub password: bool,
    /// `ValuePattern.Value`. Always `None` for password elements: the walker
    /// never reads it, and [`render`] never prints it.
    pub value: Option<String>,
    pub value_read_only: Option<bool>,
    /// `ToggleState`: 0 off, 1 on, 2 indeterminate.
    pub toggle_state: Option<i32>,
    pub selected: Option<bool>,
    /// `ExpandCollapseState`: 0 collapsed, 1 expanded, 2 partial, 3 leaf.
    pub expand_state: Option<i32>,
    pub actions: Actions,
    pub children: Vec<Node>,
    /// Why the walker stopped listing this node's children, if it did
    /// (an HRESULT label such as `UIA_E_TIMEOUT`, or a limit name).
    pub children_error: Option<String>,
}

/// Human-readable name for a `UIA_*ControlTypeId`.
#[must_use]
pub fn control_type_name(id: i32) -> &'static str {
    const NAMES: [&str; 41] = [
        "Button",
        "Calendar",
        "CheckBox",
        "ComboBox",
        "Edit",
        "Hyperlink",
        "Image",
        "ListItem",
        "List",
        "Menu",
        "MenuBar",
        "MenuItem",
        "ProgressBar",
        "RadioButton",
        "ScrollBar",
        "Slider",
        "Spinner",
        "StatusBar",
        "Tab",
        "TabItem",
        "Text",
        "ToolBar",
        "ToolTip",
        "Tree",
        "TreeItem",
        "Custom",
        "Group",
        "Thumb",
        "DataGrid",
        "DataItem",
        "Document",
        "SplitButton",
        "Window",
        "Pane",
        "Header",
        "HeaderItem",
        "Table",
        "TitleBar",
        "Separator",
        "SemanticZoom",
        "AppBar",
    ];
    usize::try_from(id - 50_000)
        .ok()
        .and_then(|index| NAMES.get(index).copied())
        .unwrap_or("Unknown")
}

/// Which nodes [`render`] prints.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Filter {
    /// Elements that can be acted on, focused, or read as document text,
    /// plus the root window. The design's default view.
    Interactive,
    /// Every element.
    All,
}

#[derive(Debug, Clone, Copy)]
#[allow(clippy::struct_excessive_bools)]
pub struct RenderOptions {
    pub filter: Filter,
    /// Hard cap on the rendered text, in characters (not bytes: a Chinese
    /// UI would otherwise get a third of the budget an English one gets).
    pub max_chars: usize,
    /// Per-element cap on printed values, in characters.
    pub value_max_chars: usize,
    pub include_rects: bool,
    pub include_offscreen: bool,
}

impl Default for RenderOptions {
    fn default() -> Self {
        Self {
            filter: Filter::Interactive,
            max_chars: 12_000,
            value_max_chars: 200,
            include_rects: false,
            include_offscreen: false,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Rendered {
    pub text: String,
    /// Elements printed.
    pub shown: usize,
    /// Elements the filter would print with an unlimited budget.
    pub eligible: usize,
    /// Offscreen elements skipped because `include_offscreen` was false.
    pub hidden_offscreen: usize,
    pub truncated: bool,
    pub chars: usize,
    pub approx_tokens: usize,
}

/// Renders `root` as one line per shown element, indented by the number of
/// shown ancestors. Password values are never printed.
#[must_use]
pub fn render(root: &Node, options: &RenderOptions) -> Rendered {
    let mut state = RenderState {
        options,
        out: String::new(),
        chars: 0,
        next_ref: 1,
        rendered: Rendered::default(),
    };
    state.visit(root, 0, true);
    if state.rendered.truncated {
        let remaining = state.rendered.eligible - state.rendered.shown;
        let note = format!(
            "…（已截断：还有 {remaining} 个元素未显示，上限 {} 字符；可缩小 filter 或从某个 ref 往下读）\n",
            options.max_chars
        );
        state.chars += note.chars().count();
        state.out.push_str(&note);
    }
    let mut rendered = state.rendered;
    rendered.chars = state.chars;
    rendered.approx_tokens = estimate_tokens(&state.out);
    rendered.text = state.out;
    rendered
}

struct RenderState<'a> {
    options: &'a RenderOptions,
    out: String,
    chars: usize,
    next_ref: usize,
    rendered: Rendered,
}

impl RenderState<'_> {
    fn visit(&mut self, node: &Node, depth: usize, is_root: bool) {
        let reference = self.next_ref;
        self.next_ref += 1;
        let mut child_depth = depth;
        if node.offscreen && !self.options.include_offscreen && !is_root {
            self.rendered.hidden_offscreen += 1;
            // Skip the node itself but keep numbering its subtree so refs
            // stay identical across filters.
            self.skip_subtree(&node.children);
            return;
        }
        if is_root || self.shows(node) {
            self.rendered.eligible += 1;
            if !self.rendered.truncated {
                let line = format_line(node, reference, depth, self.options);
                let line_chars = line.chars().count();
                if self.chars + line_chars > self.options.max_chars {
                    self.rendered.truncated = true;
                } else {
                    self.chars += line_chars;
                    self.out.push_str(&line);
                    self.rendered.shown += 1;
                }
            }
            child_depth = depth + 1;
        }
        for child in &node.children {
            self.visit(child, child_depth, false);
        }
    }

    fn skip_subtree(&mut self, children: &[Node]) {
        for child in children {
            self.next_ref += 1;
            self.skip_subtree(&child.children);
        }
    }

    fn shows(&self, node: &Node) -> bool {
        match self.options.filter {
            Filter::All => true,
            Filter::Interactive => {
                node.actions.any_direct() || node.actions.text || node.focusable || node.password
            }
        }
    }
}

fn format_line(node: &Node, reference: usize, depth: usize, options: &RenderOptions) -> String {
    let mut line = String::new();
    for _ in 0..depth {
        line.push_str("  ");
    }
    let _ = write!(
        line,
        "[e{reference}] {} \"{}\"",
        control_type_name(node.control_type),
        clip(&one_line(&node.name), 120)
    );
    if node.password {
        line.push_str(" password(值不读取)");
    } else if let Some(value) = &node.value {
        if !value.is_empty() && value != &node.name {
            let _ = write!(
                line,
                " value=\"{}\"",
                clip(&one_line(value), options.value_max_chars)
            );
        }
    }
    if node.value_read_only == Some(true) {
        line.push_str(" readonly");
    }
    match node.toggle_state {
        Some(0) => line.push_str(" toggle=off"),
        Some(1) => line.push_str(" toggle=on"),
        Some(2) => line.push_str(" toggle=mixed"),
        _ => {}
    }
    if node.selected == Some(true) {
        line.push_str(" selected");
    }
    match node.expand_state {
        Some(0) => line.push_str(" collapsed"),
        Some(1 | 2) => line.push_str(" expanded"),
        _ => {}
    }
    if !node.enabled {
        line.push_str(" disabled");
    }
    if node.focused {
        line.push_str(" focused");
    }
    if node.offscreen {
        line.push_str(" offscreen");
    }
    let labels = node.actions.labels();
    if !labels.is_empty() {
        let _ = write!(line, " [{}]", labels.join(","));
    }
    if options.include_rects {
        if let Some(rect) = node.rect {
            let _ = write!(
                line,
                " @{},{},{}x{}",
                rect.left, rect.top, rect.width, rect.height
            );
        }
    }
    if let Some(error) = &node.children_error {
        let _ = write!(line, " (子元素读取中断: {error})");
    }
    line.push('\n');
    line
}

fn one_line(text: &str) -> String {
    text.split(['\r', '\n', '\t'])
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("⏎")
        .replace('"', "\\\"")
}

fn clip(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut clipped: String = text.chars().take(max_chars).collect();
    clipped.push('…');
    clipped
}

/// Rough token estimate: ASCII at ~4 characters per token, every other
/// character (CJK, symbols) as one token. Deliberately conservative for
/// Chinese UIs; for comparing views, not for billing.
#[must_use]
pub fn estimate_tokens(text: &str) -> usize {
    let mut ascii = 0usize;
    let mut other = 0usize;
    for ch in text.chars() {
        if ch.is_ascii() {
            ascii += 1;
        } else {
            other += 1;
        }
    }
    ascii.div_ceil(4) + other
}

/// Renders only the subtree under `e<reference>`, keeping the numbers it has
/// in the whole tree. `None` when the tree has no such element.
#[must_use]
pub fn render_at(root: &Node, reference: usize, options: &RenderOptions) -> Option<Rendered> {
    let node = find_by_ref(root, reference)?;
    let mut state = RenderState {
        options,
        out: String::new(),
        chars: 0,
        next_ref: reference,
        rendered: Rendered::default(),
    };
    // The start node is always shown, like a root.
    state.visit(node, 0, true);
    if state.rendered.truncated {
        let left_out = state.rendered.eligible - state.rendered.shown;
        let notice = format!(
            "…（已截断：还有 {left_out} 个元素未显示，上限 {} 字符）\n",
            options.max_chars
        );
        state.chars += notice.chars().count();
        state.out.push_str(&notice);
    }
    let mut rendered = state.rendered;
    rendered.chars = state.chars;
    rendered.approx_tokens = estimate_tokens(&state.out);
    rendered.text = state.out;
    Some(rendered)
}

/// One element that matched [`find`]: its number and its rendered line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Found {
    pub reference: usize,
    pub line: String,
}

/// Elements whose name, automation id, value (never a password's) or control
/// type contains `query`, case-insensitively, in tree order. At most `limit`.
#[must_use]
pub fn find(root: &Node, query: &str, limit: usize, options: &RenderOptions) -> Vec<Found> {
    fn walk(
        node: &Node,
        query: &str,
        limit: usize,
        options: &RenderOptions,
        next: &mut usize,
        out: &mut Vec<Found>,
    ) {
        let reference = *next;
        *next += 1;
        if out.len() < limit && matches(node, query) {
            out.push(Found {
                reference,
                line: format_line(node, reference, 0, options).trim_end().to_string(),
            });
        }
        for child in &node.children {
            walk(child, query, limit, options, next, out);
        }
    }
    fn matches(node: &Node, query: &str) -> bool {
        let contains = |text: &str| text.to_lowercase().contains(query);
        contains(&node.name)
            || contains(&node.automation_id)
            || contains(control_type_name(node.control_type))
            || (!node.password && node.value.as_deref().is_some_and(contains))
    }
    let query = query.trim().to_lowercase();
    let mut out = Vec::new();
    if query.is_empty() || limit == 0 {
        return out;
    }
    let mut next = 1;
    walk(root, &query, limit, options, &mut next, &mut out);
    out
}

/// Whether `e<reference>` names the same element in two snapshots: same
/// control type and name. The check behind `STALE_SNAPSHOT`.
#[must_use]
pub fn same_element(before: &Node, after: &Node, reference: usize) -> bool {
    match (find_by_ref(before, reference), find_by_ref(after, reference)) {
        (Some(a), Some(b)) => a.control_type == b.control_type && a.name == b.name,
        _ => false,
    }
}

/// Returns the node numbered `e<reference>` (1-based pre-order), if any.
#[must_use]
pub fn find_by_ref(root: &Node, reference: usize) -> Option<&Node> {
    fn walk<'a>(node: &'a Node, target: usize, next: &mut usize) -> Option<&'a Node> {
        let mine = *next;
        *next += 1;
        if mine == target {
            return Some(node);
        }
        node.children
            .iter()
            .find_map(|child| walk(child, target, next))
    }
    let mut next = 1;
    walk(root, reference, &mut next)
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct ActionCounts {
    pub invoke: usize,
    pub value: usize,
    pub toggle: usize,
    pub select: usize,
    pub expand: usize,
    pub scroll: usize,
    pub text: usize,
    pub legacy_only: usize,
    pub none: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct TreeStats {
    pub elements: usize,
    pub max_depth: usize,
    pub named: usize,
    pub offscreen: usize,
    pub disabled: usize,
    pub password: usize,
    pub focusable: usize,
    pub children_errors: usize,
    pub actions: ActionCounts,
    pub by_control_type: BTreeMap<String, usize>,
    pub by_framework: BTreeMap<String, usize>,
}

#[must_use]
pub fn stats(root: &Node) -> TreeStats {
    fn walk(node: &Node, depth: usize, stats: &mut TreeStats) {
        stats.elements += 1;
        stats.max_depth = stats.max_depth.max(depth);
        if !node.name.trim().is_empty() {
            stats.named += 1;
        }
        stats.offscreen += usize::from(node.offscreen);
        stats.disabled += usize::from(!node.enabled);
        stats.password += usize::from(node.password);
        stats.focusable += usize::from(node.focusable);
        stats.children_errors += usize::from(node.children_error.is_some());
        let actions = node.actions;
        let counts = &mut stats.actions;
        counts.invoke += usize::from(actions.invoke);
        counts.value += usize::from(actions.value);
        counts.toggle += usize::from(actions.toggle);
        counts.select += usize::from(actions.select);
        counts.expand += usize::from(actions.expand);
        counts.scroll += usize::from(actions.scroll);
        counts.text += usize::from(actions.text);
        if !actions.any_direct() && !actions.text {
            if actions.legacy {
                counts.legacy_only += 1;
            } else {
                counts.none += 1;
            }
        }
        *stats
            .by_control_type
            .entry(control_type_name(node.control_type).to_string())
            .or_default() += 1;
        let framework = if node.framework_id.is_empty() {
            "(none)".to_string()
        } else {
            node.framework_id.clone()
        };
        *stats.by_framework.entry(framework).or_default() += 1;
        for child in &node.children {
            walk(child, depth + 1, stats);
        }
    }
    let mut stats = TreeStats::default();
    walk(root, 0, &mut stats);
    stats
}

#[cfg(test)]
#[path = "tests/snapshot.rs"]
mod tests;
