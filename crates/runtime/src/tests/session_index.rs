use super::{search_sessions, SessionSearchResult};
use crate::session::SessionCompactionRecord;
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

#[test]
fn search_finds_content_compacted_into_the_archive() {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    let sessions_dir = std::env::temp_dir().join(format!("aris-archive-search-{suffix}"));
    fs::create_dir_all(&sessions_dir).expect("sessions dir");

    let mut session = Session::new();
    // A live message that does NOT mention the archived term.
    session.messages.push(ConversationMessage::user_text(
        "Continuing the current task.",
    ));
    // A compaction archive holding the removed original request.
    session.compactions.push(SessionCompactionRecord {
        summary: "<summary>earlier work</summary>".to_string(),
        messages: vec![ConversationMessage::user_text(
            "ARCHIVEDUNIQUETERM the original decision was to shard by tenant",
        )],
        removed_message_count: 1,
        preserved_message_count: 1,
        tokens_before: 100,
        tokens_after: 40,
        summary_source: "fallback".to_string(),
    });
    let path = sessions_dir.join("session-arch.json");
    session.save_to_path(&path).expect("save session");

    // The archived term is only in the compaction record, not the live list.
    let hit = search_sessions(&sessions_dir, Some("ARCHIVEDUNIQUETERM"), None, 3, 2)
        .expect("archive search");
    assert!(
        matches!(hit, SessionSearchResult::Search { ref results, .. } if results.len() == 1),
        "content compacted into the archive must be recoverable via session search"
    );
    let browse = search_sessions(&sessions_dir, None, None, 3, 2).expect("browse sessions");
    assert!(
        matches!(
            browse,
            SessionSearchResult::Browse { ref sessions }
                if sessions.len() == 1 && sessions[0].message_count == 2
        ),
        "session summaries must count archived originals as part of the visible history"
    );

    fs::remove_dir_all(sessions_dir).expect("remove sessions dir");
}
