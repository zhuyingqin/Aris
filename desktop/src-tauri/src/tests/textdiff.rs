use super::*;

fn git_available() -> bool {
    text_diff("a\n", "b\n", "x.tex", 3).is_ok()
}

/// The hunk header is what makes a LaTeX diff readable: Git's built-in `tex`
/// userdiff driver names the sectioning command a change falls under, so a
/// reviewer sees "inside \section{Related Work}" instead of "line 412".
#[test]
fn tex_hunks_are_labelled_with_their_enclosing_section() {
    if !git_available() {
        return;
    }
    let before = "\\section{Related Work}\nalpha\nbeta\ngamma\n";
    let after = "\\section{Related Work}\nalpha\nBETA\ngamma\n";

    let diff = text_diff(before, after, "ch2_foundations.tex", 1).expect("diff");
    assert_eq!(diff.added, 1);
    assert_eq!(diff.removed, 1);
    let hunk = diff.hunks.first().expect("one hunk");
    assert!(
        hunk.header.contains("\\section{Related Work}"),
        "hunk header was {:?}",
        hunk.header
    );
}

/// The defect this module exists to remove. The previous implementation gave up
/// past an edit distance of 800 and reported every old line removed and every
/// new line added — a shape indistinguishable from a real rewrite, which made
/// the three-way merge collapse unrelated local edits into one all-or-nothing
/// conflict. A large edit must still produce localized hunks.
#[test]
fn a_large_edit_still_produces_localized_hunks() {
    if !git_available() {
        return;
    }
    let mut before = String::new();
    let mut after = String::new();
    for index in 0..4_000 {
        before.push_str(&format!("line {index}\n"));
        // Rewrite a contiguous band in the middle: far more than 800 changed
        // lines, but the surrounding 3,000 lines are untouched.
        if (1_000..2_400).contains(&index) {
            after.push_str(&format!("rewritten {index}\n"));
        } else {
            after.push_str(&format!("line {index}\n"));
        }
    }

    let diff = text_diff(&before, &after, "big.tex", 3).expect("diff");
    assert!(
        !diff.too_large_to_chunk,
        "1,400 changed lines is reviewable"
    );
    assert_eq!(diff.added, 1_400);
    assert_eq!(diff.removed, 1_400);
    // The untouched 2,600 lines must not appear as changes.
    assert!(
        diff.hunks.len() <= 4,
        "expected a couple of localized hunks, got {}",
        diff.hunks.len()
    );
}

/// Past the point where hunks stop being review material, say so instead of
/// synthesising a whole-file replacement. A reviewer shown tens of thousands of
/// fake hunks learns to click Accept without reading.
#[test]
fn a_rewrite_beyond_review_scale_is_reported_rather_than_faked() {
    if !git_available() {
        return;
    }
    let before = (0..12_000).map(|i| format!("a {i}\n")).collect::<String>();
    let after = (0..12_000).map(|i| format!("b {i}\n")).collect::<String>();

    let diff = text_diff(&before, &after, "huge.tex", 3).expect("diff");
    assert!(diff.too_large_to_chunk);
    assert!(diff.hunks.is_empty(), "no synthetic hunks are offered");
    assert_eq!(diff.added, 12_000);
    assert_eq!(diff.removed, 12_000);
}

/// Non-overlapping edits on both sides are exactly what the old merge lost.
#[test]
fn independent_edits_on_both_sides_survive_the_merge() {
    if !git_available() {
        return;
    }
    let base = (0..40).map(|i| format!("line {i}\n")).collect::<String>();
    let local = base.replace("line 3\n", "MY EDIT\n");
    let incoming = base.replace("line 30\n", "THEIR EDIT\n");

    let merged = three_way_merge(&base, &local, &incoming, "ch2.tex").expect("merge");
    assert!(merged.clean, "distant edits do not conflict");
    assert_eq!(merged.conflicts, 0);
    assert!(merged.content.contains("MY EDIT"), "local edit was kept");
    assert!(
        merged.content.contains("THEIR EDIT"),
        "incoming was applied"
    );
    assert!(!merged.content.contains("<<<<<<<"));
}

/// A genuine conflict is reported as one, with both sides present, rather than
/// being resolved silently in either direction.
#[test]
fn a_real_conflict_keeps_both_sides_and_is_counted() {
    if !git_available() {
        return;
    }
    let base = "alpha\nbeta\ngamma\n";
    let local = "alpha\nMINE\ngamma\n";
    let incoming = "alpha\nTHEIRS\ngamma\n";

    let merged = three_way_merge(base, local, incoming, "ch2.tex").expect("merge");
    assert!(!merged.clean);
    assert_eq!(merged.conflicts, 1);
    assert!(merged.content.contains("MINE"));
    assert!(merged.content.contains("THEIRS"));
    assert!(merged.content.contains("<<<<<<<"));
}

/// Line numbers must survive the round trip, because the review UI anchors its
/// accept/reject controls on them.
#[test]
fn line_numbers_track_both_sides() {
    if !git_available() {
        return;
    }
    let diff = text_diff("a\nb\nc\n", "a\nB1\nB2\nc\n", "x.tex", 1).expect("diff");
    let hunk = diff.hunks.first().expect("one hunk");
    let removed = hunk
        .lines
        .iter()
        .find(|line| line.kind == DiffLineKind::Removed)
        .expect("a removal");
    assert_eq!(removed.text, "b");
    assert_eq!(removed.old_line, Some(2));
    assert_eq!(removed.new_line, None);

    let added = hunk
        .lines
        .iter()
        .filter(|line| line.kind == DiffLineKind::Added)
        .map(|line| (line.text.as_str(), line.new_line))
        .collect::<Vec<_>>();
    assert_eq!(added, vec![("B1", Some(2)), ("B2", Some(3))]);
}

#[test]
fn identical_text_needs_no_git_at_all() {
    let diff = text_diff("same\n", "same\n", "x.tex", 3).expect("identical");
    assert_eq!(diff.added, 0);
    assert_eq!(diff.removed, 0);
    assert!(diff.hunks.is_empty());
}
