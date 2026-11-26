use super::*;

#[test]
fn the_specs_are_exactly_the_five_read_only_tools() {
    let specs = tool_specs();
    let names: Vec<&str> = specs.iter().map(|spec| spec.name).collect();
    assert_eq!(names, TOOL_NAMES.to_vec());
    for spec in &specs {
        assert_eq!(spec.required_permission, PermissionMode::ReadOnly, "{}", spec.name);
        assert_eq!(spec.input_schema["additionalProperties"], json!(false), "{}", spec.name);
        assert!(is_computer_tool(spec.name));
    }
    assert!(!is_computer_tool("bash"));
    // Nothing here can act on a window.
    for word in ["click", "type", "set_value", "invoke"] {
        assert!(!names.iter().any(|name| name.contains(word)), "{word}");
    }
}

#[test]
fn element_refs_accept_numbers_and_e_prefixed_strings() {
    assert_eq!(element_ref(&json!(12)), Some(12));
    assert_eq!(element_ref(&json!("e12")), Some(12));
    assert_eq!(element_ref(&json!(" 7 ")), Some(7));
    assert_eq!(element_ref(&json!("button")), None);
    assert_eq!(element_ref(&Value::Null), None);
}

#[test]
fn errors_tell_the_model_what_to_do_next() {
    let denied = CuError::new("ACCESS_DENIED", "no").into_tool_error().to_string();
    assert!(denied.contains("ACCESS_DENIED") && denied.contains("any other tool"), "{denied}");
    let not_granted = CuError::new("NOT_GRANTED", "x").into_tool_error().to_string();
    assert!(not_granted.contains("computer_request_access"), "{not_granted}");
    let timeout = CuError::new("HELPER_TIMEOUT", "slow").into_tool_error().to_string();
    assert!(timeout.contains("element numbers are invalid"), "{timeout}");
}

#[test]
fn only_chat_windows_could_answer_and_unknown_requests_are_refused() {
    // The registry starts empty: an answer to a request nobody is waiting
    // for is an error, never a silent grant.
    assert!(computer_access_pending("nobody".into()).is_empty());
}
