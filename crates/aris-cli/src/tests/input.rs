use super::*;

fn make_editor() -> LineEditor {
    LineEditor::new(
        "> ",
        vec![
            ("/help".to_string(), "Show help".to_string()),
            ("/research-review".to_string(), "Deep review".to_string()),
            ("/research-lit".to_string(), "Literature search".to_string()),
            ("/status".to_string(), "Session status".to_string()),
        ],
    )
}

#[test]
fn matches_slash_prefix() {
    let ed = make_editor();
    let m = ed.compute_matches("/res");
    assert_eq!(m.len(), 2);
    assert!(m.iter().any(|&i| ed.completions[i].0 == "/research-review"));
    assert!(m.iter().any(|&i| ed.completions[i].0 == "/research-lit"));
}

#[test]
fn no_matches_for_plain_text() {
    let ed = make_editor();
    assert!(ed.compute_matches("hello").is_empty());
    assert!(ed.compute_matches("").is_empty());
}

#[test]
fn exact_match_returns_one() {
    let ed = make_editor();
    let m = ed.compute_matches("/help");
    assert_eq!(m.len(), 1);
    assert_eq!(ed.completions[m[0]].0, "/help");
}

#[test]
fn clip_truncates_long_strings() {
    assert_eq!(clip("hello world", 5), "hell…");
    assert_eq!(clip("short", 10), "short");
}

#[test]
fn layout_position_handles_cjk_non_boundary() {
    let mut buf = vec!['a'; 100];
    buf.push('你');
    assert_eq!(super::layout_position(0, &buf, buf.len(), 120), (0, 102));
    buf.push('是');
    assert_eq!(super::layout_position(0, &buf, buf.len(), 120), (0, 104));
}

#[test]
fn layout_position_keeps_cursor_out_of_wide_char_at_wrap_boundary() {
    // 118 ASCII chars fill cols 0..117 on row 0. Wide char at col 118
    // would need cols 118..119; that exactly fits, takes both cells,
    // col reaches term_w → wide char triggers row += 1, col = 0.
    // Cursor lands at (1, 0).
    let mut ends_at_boundary = vec!['a'; 118];
    ends_at_boundary.push('是');
    assert_eq!(
        super::layout_position(0, &ends_at_boundary, ends_at_boundary.len(), 120),
        (1, 0)
    );
    assert_eq!(super::layout_rows(0, &ends_at_boundary, 120), 2);

    // 119 ASCII chars: cols 0..118 ASCII, col 119 = last ASCII char,
    // col reaches term_w → pending_wrap = true. Wide char sees
    // pending_wrap → jumps to (1, 0), takes cols 0..1, cursor (1, 2).
    let mut wraps_before_wide = vec!['a'; 119];
    wraps_before_wide.push('谁');
    assert_eq!(
        super::layout_position(0, &wraps_before_wide, wraps_before_wide.len(), 120),
        (1, 2)
    );
}

#[test]
fn normalize_paste_text_flattens_newlines_and_tabs() {
    let normalized: String = super::normalize_paste_text("one\ntwo\r\nthree\rfour\tfive\x01end")
        .into_iter()
        .collect();
    assert_eq!(normalized, "one two three four five end");
}

#[test]
fn push_history_ignores_blank() {
    let mut ed = make_editor();
    ed.push_history("   ");
    ed.push_history("/help");
    assert_eq!(ed.history.len(), 1);
}
