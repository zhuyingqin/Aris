use super::{client_outdated_error, client_user_agent, CLIENT_OUTDATED_CODE, CLIENT_VERSION};

#[test]
fn user_agent_keeps_the_edge_matched_prefix() {
    let agent = client_user_agent();
    assert!(agent.starts_with(&format!("aris/{CLIENT_VERSION} (SomniQ Studio; ")));
    assert!(agent.contains(std::env::consts::OS));
    assert!(agent.ends_with(&format!("{})", std::env::consts::ARCH)));
    assert!(reqwest_header_safe(agent));
}

fn reqwest_header_safe(value: &str) -> bool {
    value.bytes().all(|byte| byte == b'\t' || (0x20..0x7f).contains(&byte))
}

#[test]
fn outdated_error_prefers_the_server_message() {
    let body = r#"{"success":false,"message":"请更新到 0.4.86 或更高版本","code":"client_outdated","error":{"type":"client_outdated","code":"client_outdated","message":"ignored"}}"#;
    assert_eq!(
        client_outdated_error(426, body).as_deref(),
        Some("请更新到 0.4.86 或更高版本 (client_outdated)")
    );
}

#[test]
fn outdated_error_reads_openai_shaped_bodies_and_falls_back() {
    let openai = r#"{"error":{"message":"too old","type":"client_outdated"}}"#;
    assert_eq!(
        client_outdated_error(426, openai).as_deref(),
        Some("too old (client_outdated)")
    );
    let fallback = client_outdated_error(426, "<html>426</html>").unwrap();
    assert!(fallback.ends_with(&format!("({CLIENT_OUTDATED_CODE})")));
}

#[test]
fn other_statuses_are_not_outdated() {
    assert_eq!(client_outdated_error(400, r#"{"code":"client_outdated"}"#), None);
    assert_eq!(client_outdated_error(200, ""), None);
}
