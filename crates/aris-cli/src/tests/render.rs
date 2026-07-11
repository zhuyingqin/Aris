use super::{strip_ansi, MarkdownStreamState, Spinner, TerminalRenderer};

#[test]
fn renders_markdown_with_styling_and_lists() {
    let terminal_renderer = TerminalRenderer::new();
    let markdown_output = terminal_renderer
        .render_markdown("# Heading\n\nThis is **bold** and *italic*.\n\n- item\n\n`code`");

    assert!(markdown_output.contains("Heading"));
    assert!(markdown_output.contains("• item"));
    assert!(markdown_output.contains("code"));
    assert!(markdown_output.contains('\u{1b}'));
}

#[test]
fn renders_links_as_colored_markdown_labels() {
    let terminal_renderer = TerminalRenderer::new();
    let markdown_output =
        terminal_renderer.render_markdown("See [Claw](https://example.com/docs) now.");
    let plain_text = strip_ansi(&markdown_output);

    assert!(plain_text.contains("[Claw](https://example.com/docs)"));
    assert!(markdown_output.contains('\u{1b}'));
}

#[test]
fn highlights_fenced_code_blocks() {
    let terminal_renderer = TerminalRenderer::new();
    let markdown_output =
        terminal_renderer.markdown_to_ansi("```rust\nfn hi() { println!(\"hi\"); }\n```");
    let plain_text = strip_ansi(&markdown_output);

    assert!(plain_text.contains("╭─ rust"));
    assert!(plain_text.contains("fn hi"));
    assert!(markdown_output.contains('\u{1b}'));
    assert!(markdown_output.contains("[48;5;236m"));
}

#[test]
fn renders_ordered_and_nested_lists() {
    let terminal_renderer = TerminalRenderer::new();
    let markdown_output =
        terminal_renderer.render_markdown("1. first\n2. second\n   - nested\n   - child");
    let plain_text = strip_ansi(&markdown_output);

    assert!(plain_text.contains("1. first"));
    assert!(plain_text.contains("2. second"));
    assert!(plain_text.contains("  • nested"));
    assert!(plain_text.contains("  • child"));
}

#[test]
fn renders_tables_with_alignment() {
    let terminal_renderer = TerminalRenderer::new();
    let markdown_output = terminal_renderer
        .render_markdown("| Name | Value |\n| ---- | ----- |\n| alpha | 1 |\n| beta | 22 |");
    let plain_text = strip_ansi(&markdown_output);
    let lines = plain_text.lines().collect::<Vec<_>>();

    assert_eq!(lines[0], "│ Name  │ Value │");
    assert_eq!(lines[1], "│───────┼───────│");
    assert_eq!(lines[2], "│ alpha │ 1     │");
    assert_eq!(lines[3], "│ beta  │ 22    │");
    assert!(markdown_output.contains('\u{1b}'));
}

#[test]
fn streaming_state_waits_for_complete_blocks() {
    let renderer = TerminalRenderer::new();
    let mut state = MarkdownStreamState::default();

    assert_eq!(state.push(&renderer, "# Heading"), None);
    let flushed = state
        .push(&renderer, "\n\nParagraph\n\n")
        .expect("completed block");
    let plain_text = strip_ansi(&flushed);
    assert!(plain_text.contains("Heading"));
    assert!(plain_text.contains("Paragraph"));

    assert_eq!(state.push(&renderer, "```rust\nfn main() {}\n"), None);
    let code = state
        .push(&renderer, "```\n")
        .expect("closed code fence flushes");
    assert!(strip_ansi(&code).contains("fn main()"));
}

#[test]
fn spinner_advances_frames() {
    let terminal_renderer = TerminalRenderer::new();
    let mut spinner = Spinner::new();
    let mut out = Vec::new();
    spinner
        .tick("Working", terminal_renderer.color_theme(), &mut out)
        .expect("tick succeeds");
    spinner
        .tick("Working", terminal_renderer.color_theme(), &mut out)
        .expect("tick succeeds");

    let output = String::from_utf8_lossy(&out);
    assert!(output.contains("Working"));
}
