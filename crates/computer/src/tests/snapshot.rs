use super::*;

fn node(control_type: i32, name: &str) -> Node {
    Node {
        control_type,
        name: name.to_string(),
        enabled: true,
        ..Node::default()
    }
}

const WINDOW: i32 = 50_032;
const PANE: i32 = 50_033;
const BUTTON: i32 = 50_000;
const EDIT: i32 = 50_004;
const TEXT: i32 = 50_020;

fn button(name: &str) -> Node {
    let mut button = node(BUTTON, name);
    button.actions.invoke = true;
    button.focusable = true;
    button
}

/// Window > Pane > [Text "标签", Button "保存", Edit "密码"(password)], Button "关闭"
fn sample() -> Node {
    let mut password = node(EDIT, "密码");
    password.password = true;
    password.actions.value = true;
    password.focusable = true;
    let mut pane = node(PANE, "");
    pane.children = vec![node(TEXT, "标签"), button("保存"), password];
    let mut root = node(WINDOW, "测试窗口");
    root.children = vec![pane, button("关闭")];
    root
}

#[test]
fn control_type_names_cover_the_uia_range() {
    assert_eq!(control_type_name(50_000), "Button");
    assert_eq!(control_type_name(50_032), "Window");
    assert_eq!(control_type_name(50_040), "AppBar");
    assert_eq!(control_type_name(50_041), "Unknown");
    assert_eq!(control_type_name(0), "Unknown");
}

#[test]
fn refs_are_preorder_over_the_whole_tree_regardless_of_filter() {
    let root = sample();
    let all = render(
        &root,
        &RenderOptions {
            filter: Filter::All,
            ..RenderOptions::default()
        },
    );
    let interactive = render(&root, &RenderOptions::default());
    // Pre-order: e1 window, e2 pane, e3 text, e4 保存, e5 密码, e6 关闭.
    assert!(all.text.contains("[e4] Button \"保存\""));
    assert!(interactive.text.contains("[e4] Button \"保存\""));
    assert!(interactive.text.contains("[e6] Button \"关闭\""));
    // The interactive view drops the pane and the static text...
    assert!(!interactive.text.contains("[e2]"));
    assert!(!interactive.text.contains("[e3]"));
    assert_eq!(all.shown, 6);
    assert_eq!(interactive.shown, 4);
    // ...and indents by shown ancestors only.
    assert!(interactive.text.contains("\n  [e4] Button"));
    assert_eq!(find_by_ref(&root, 4).map(|found| found.name.as_str()), Some("保存"));
    assert_eq!(find_by_ref(&root, 7), None);
}

#[test]
fn password_values_are_never_rendered() {
    let mut root = sample();
    // Even if a value somehow reached the node, rendering must not print it.
    root.children[0].children[2].value = Some("hunter2".to_string());
    let all = render(
        &root,
        &RenderOptions {
            filter: Filter::All,
            ..RenderOptions::default()
        },
    );
    assert!(!all.text.contains("hunter2"));
    assert!(all.text.contains("password(值不读取)"));
}

#[test]
fn values_are_single_line_clipped_and_quoted() {
    let mut edit = node(EDIT, "正文");
    edit.actions.value = true;
    edit.value = Some("第一行\r\n第二行 \"引号\"".to_string());
    let mut root = node(WINDOW, "w");
    root.children = vec![edit];
    let rendered = render(&root, &RenderOptions::default());
    assert!(rendered.text.contains("value=\"第一行⏎第二行 \\\"引号\\\"\""));

    root.children[0].value = Some("x".repeat(500));
    let clipped = render(
        &root,
        &RenderOptions {
            value_max_chars: 10,
            ..RenderOptions::default()
        },
    );
    assert!(clipped.text.contains(&format!("value=\"{}…\"", "x".repeat(10))));
}

#[test]
fn budget_is_counted_in_characters_and_reports_truncation() {
    let mut root = node(WINDOW, "窗口");
    root.children = (0..50).map(|index| button(&format!("按钮{index}"))).collect();
    let full = render(&root, &RenderOptions::default());
    assert!(!full.truncated);
    assert_eq!(full.shown, 51);

    let limited = render(
        &root,
        &RenderOptions {
            max_chars: 200,
            ..RenderOptions::default()
        },
    );
    assert!(limited.truncated);
    assert!(limited.shown < 51);
    assert_eq!(limited.eligible, 51);
    assert!(limited.text.contains(&format!("还有 {} 个元素未显示", 51 - limited.shown)));
    // The note itself may exceed the budget, but the element lines may not.
    let body: usize = limited
        .text
        .lines()
        .filter(|line| line.contains("[e"))
        .map(|line| line.chars().count() + 1)
        .sum();
    assert!(body <= 200);
}

#[test]
fn offscreen_subtrees_are_hidden_without_renumbering() {
    let mut hidden = button("屏幕外");
    hidden.offscreen = true;
    hidden.children = vec![button("屏幕外的子元素")];
    let mut root = node(WINDOW, "w");
    root.children = vec![hidden, button("可见")];
    let default = render(&root, &RenderOptions::default());
    assert!(!default.text.contains("屏幕外"));
    assert!(default.text.contains("[e4] Button \"可见\""));
    assert_eq!(default.hidden_offscreen, 1);

    let with_offscreen = render(
        &root,
        &RenderOptions {
            include_offscreen: true,
            ..RenderOptions::default()
        },
    );
    assert!(with_offscreen.text.contains("[e2] Button \"屏幕外\" offscreen"));
    assert!(with_offscreen.text.contains("[e4] Button \"可见\""));
}

#[test]
fn stats_count_actions_frameworks_and_errors() {
    let mut root = sample();
    root.framework_id = "Win32".to_string();
    root.children[0].children_error = Some("UIA_E_TIMEOUT".to_string());
    let tree = stats(&root);
    assert_eq!(tree.elements, 6);
    assert_eq!(tree.max_depth, 2);
    assert_eq!(tree.password, 1);
    assert_eq!(tree.actions.invoke, 2);
    assert_eq!(tree.actions.value, 1);
    assert_eq!(tree.actions.none, 3);
    assert_eq!(tree.children_errors, 1);
    assert_eq!(tree.by_control_type.get("Button"), Some(&2));
    assert_eq!(tree.by_framework.get("Win32"), Some(&1));
    assert_eq!(tree.by_framework.get("(none)"), Some(&5));
}

#[test]
fn token_estimate_weights_cjk_as_one_token_per_character() {
    assert_eq!(estimate_tokens(""), 0);
    assert_eq!(estimate_tokens("abcd"), 1);
    assert_eq!(estimate_tokens("abcde"), 2);
    assert_eq!(estimate_tokens("保存文件"), 4);
}
