use super::*;

fn sessions(ids: &[&str]) -> Vec<String> {
    ids.iter().map(|id| (*id).to_string()).collect()
}

fn grant(title: &str) -> Grant {
    Grant {
        hwnd: 42,
        pid: 7,
        exe: "notepad.exe".into(),
        title: title.into(),
    }
}

#[test]
fn control_starts_keeps_its_start_time_and_ends() {
    let mut control = Control::default();
    let mut grants = HashMap::new();
    assert!(!status_of(&control).active);

    assert!(update(&mut control, &mut grants, sessions(&["a"]), 1_000));
    assert_eq!(control.since_ms, Some(1_000));
    assert!(status_of(&control).active);

    // A second session joining does not restart the clock.
    assert!(update(&mut control, &mut grants, sessions(&["a", "b"]), 5_000));
    assert_eq!(control.since_ms, Some(1_000));
    assert_eq!(status_of(&control).session_ids, sessions(&["a", "b"]));

    // No change, no event.
    assert!(!update(&mut control, &mut grants, sessions(&["a", "b"]), 6_000));

    assert!(update(&mut control, &mut grants, Vec::new(), 7_000));
    assert_eq!(control.since_ms, None);
    assert!(!status_of(&control).active);

    // Control that starts again gets a fresh start time.
    assert!(update(&mut control, &mut grants, sessions(&["b"]), 9_000));
    assert_eq!(control.since_ms, Some(9_000));
}

#[test]
fn a_grant_is_reported_while_its_session_controls_and_dies_with_the_turn() {
    let mut control = Control::default();
    let mut grants = HashMap::new();
    assert!(update(&mut control, &mut grants, sessions(&["a"]), 1_000));
    assert!(status_of(&control).observing.is_none());

    // Granting a window changes the status even though the sessions did not.
    grants.insert("a".to_string(), grant("draft.txt - Notepad"));
    assert!(update(&mut control, &mut grants, sessions(&["a"]), 2_000));
    let observing = status_of(&control).observing.expect("observing");
    assert_eq!(observing.session_id, "a");
    assert_eq!(observing.title, "draft.txt - Notepad");
    assert_eq!(control.since_ms, Some(1_000), "the clock keeps running");

    // The turn ends: the grant is gone for good, not just hidden.
    assert!(update(&mut control, &mut grants, Vec::new(), 3_000));
    assert!(grants.is_empty());
    assert!(status_of(&control).observing.is_none());
    assert!(!update(&mut control, &mut grants, Vec::new(), 4_000));
}

#[test]
fn a_grant_of_a_session_that_is_not_running_never_shows() {
    let mut control = Control::default();
    let mut grants = HashMap::new();
    grants.insert("idle".to_string(), grant("x"));
    assert!(update(&mut control, &mut grants, sessions(&["other"]), 1_000));
    assert!(status_of(&control).observing.is_none());
    assert!(grants.is_empty(), "a stale grant is dropped, not kept for later");
}

#[test]
fn indicator_and_border_labels_match_the_capability_glob() {
    assert_eq!(indicator_label(0), "computer-control-indicator-0");
    assert!(BORDER_LABEL.starts_with(INDICATOR_LABEL_PREFIX));
    let capability: serde_json::Value = serde_json::from_str(include_str!(
        "../../capabilities/computer-control-indicator.json"
    ))
    .expect("capability file is JSON");
    let glob = capability["windows"][0].as_str().expect("one window glob");
    assert_eq!(glob, format!("{INDICATOR_LABEL_PREFIX}*"));
}
