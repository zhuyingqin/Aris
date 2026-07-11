use super::{search_sessions, SessionSearchResult};
use crate::{ContentBlock, ConversationMessage, Session};
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn indexes_and_searches_persisted_sessions() {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    let sessions_dir = std::env::temp_dir().join(format!("aris-session-search-{suffix}"));
    fs::create_dir_all(&sessions_dir).expect("sessions dir");
    let mut session = Session::new();
    session.messages.push(ConversationMessage::user_text(
        "We decided to use SQLite FTS5 for conversation recall.",
    ));
    session
        .messages
        .push(ConversationMessage::assistant(vec![ContentBlock::Text {
            text: "已完成中文会话检索设计。".to_string(),
        }]));
    let path = sessions_dir.join("session-a.json");
    session.save_to_path(&path).expect("save session");

    let english =
        search_sessions(&sessions_dir, Some("SQLite FTS5"), None, 3, 2).expect("english search");
    assert!(matches!(
        english,
        SessionSearchResult::Search { ref results, .. } if results.len() == 1
    ));

    let chinese =
        search_sessions(&sessions_dir, Some("中文会话检索"), None, 3, 2).expect("cjk search");
    assert!(matches!(
        chinese,
        SessionSearchResult::Search { ref results, .. } if results.len() == 1
    ));

    let full_session =
        search_sessions(&sessions_dir, None, Some("session-a"), 3, 2).expect("session read");
    assert!(matches!(
        full_session,
        SessionSearchResult::Read { ref messages, .. } if messages.len() == 2
    ));

    fs::remove_file(path).expect("remove session");
    let browse = search_sessions(&sessions_dir, None, None, 3, 2).expect("browse after remove");
    assert!(matches!(
        browse,
        SessionSearchResult::Browse { ref sessions } if sessions.is_empty()
    ));

    fs::remove_dir_all(sessions_dir).expect("remove sessions dir");
}
