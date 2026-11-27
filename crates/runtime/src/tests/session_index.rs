use super::{
    bigram_index_text, bigram_query_terms, forget_indexed_session, index_session, recency_weight,
    session_start_from_id, BIGRAM_READY_FLAG,
    open_index, pending_session_embedding_inputs, recent_session_messages, search_sessions,
    search_sessions_filtered, search_sessions_hybrid, session_index_reindex_state,
    session_index_stats, set_metadata_flag, sync_sessions_dir, upsert_session_message_embeddings,
    SessionMessageEmbedding, SessionSearchFilter, SessionSearchResult,
};
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

    let chinese_natural_language =
        search_sessions(&sessions_dir, Some("如何完成中文会话检索"), None, 3, 2)
            .expect("natural-language chinese search");
    assert!(matches!(
        chinese_natural_language,
        SessionSearchResult::Search { ref results, .. } if results.len() == 1
    ));

    let english_relaxed = search_sessions(&sessions_dir, Some("SQLite indexing"), None, 3, 2)
        .expect("relaxed english search");
    assert!(matches!(
        english_relaxed,
        SessionSearchResult::Search { ref results, .. } if results.len() == 1
    ));

    let full_session =
        search_sessions(&sessions_dir, None, Some("session-a"), 3, 2).expect("session read");
    assert!(matches!(
        full_session,
        SessionSearchResult::Read { ref messages, .. } if messages.len() == 2
    ));
    let recent = recent_session_messages(&sessions_dir, 10, &[]).expect("recent messages");
    assert_eq!(recent.len(), 2);
    assert_eq!(recent[0].session_id, "session-a");
    let stats = session_index_stats(&sessions_dir, &[]).expect("index stats");
    assert_eq!(stats.session_count, 1);
    assert_eq!(stats.message_count, 2);

    // Prefix exclusion is what keeps memory governance from counting Sessions
    // it will never recall from.
    let scoped = session_index_stats(&sessions_dir, &["session-"]).expect("scoped stats");
    assert_eq!(scoped.session_count, 0);
    assert_eq!(scoped.message_count, 0);
    assert!(recent_session_messages(&sessions_dir, 10, &["session-"])
        .expect("scoped recent")
        .is_empty());

    fs::remove_file(path).expect("remove session");
    // Querying is intentionally projection-only. Directory reconciliation is
    // an explicit startup/idle repair operation, never part of the hot path.
    sync_sessions_dir(&sessions_dir).expect("repair index after removal");
    let browse = search_sessions(&sessions_dir, None, None, 3, 2).expect("browse after remove");
    assert!(matches!(
        browse,
        SessionSearchResult::Browse { ref sessions } if sessions.is_empty()
    ));

    fs::remove_dir_all(sessions_dir).expect("remove sessions dir");
}

#[test]
fn append_only_save_preserves_existing_fts_rows() {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    let base = std::env::temp_dir().join(format!("aris-session-incremental-{suffix}"));
    let sessions_dir = base.join("sessions");
    fs::create_dir_all(&sessions_dir).expect("sessions dir");
    let path = sessions_dir.join("session-incremental.json");
    let mut session = Session::new();
    session
        .messages
        .push(ConversationMessage::user_text("alpha stable message"));
    session.save_to_path(&path).expect("initial save");

    let first_rowid = open_index(&sessions_dir)
        .expect("open index")
        .query_row(
            "SELECT rowid FROM messages_fts WHERE session_id='session-incremental' AND message_index=0",
            [],
            |row| row.get::<_, i64>(0),
        )
        .expect("first rowid");

    session
        .messages
        .push(ConversationMessage::assistant(vec![ContentBlock::Text {
            text: "beta appended response".to_string(),
        }]));
    session.save_to_path(&path).expect("append save");

    let connection = open_index(&sessions_dir).expect("open updated index");
    let preserved_rowid = connection
        .query_row(
            "SELECT rowid FROM messages_fts WHERE session_id='session-incremental' AND message_index=0",
            [],
            |row| row.get::<_, i64>(0),
        )
        .expect("preserved rowid");
    let row_count = connection
        .query_row(
            "SELECT COUNT(*) FROM messages WHERE session_id='session-incremental'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .expect("row count");
    assert_eq!(preserved_rowid, first_rowid);
    assert_eq!(row_count, 2);

    drop(connection);
    fs::remove_dir_all(base).expect("remove sessions dir");
}

#[test]
fn preference_search_keeps_session_order_but_moves_the_window_anchor() {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    let base = std::env::temp_dir().join(format!("aris-session-profile-{suffix}"));
    let sessions_dir = base.join("sessions");
    fs::create_dir_all(&sessions_dir).expect("sessions dir");
    let mut session = Session::new();
    session.messages.push(ConversationMessage::user_text(
        "I need help finding a hotel for an upcoming trip.",
    ));
    for index in 0..7 {
        session
            .messages
            .push(ConversationMessage::assistant(vec![ContentBlock::Text {
                text: format!("generic travel planning turn {index}"),
            }]));
    }
    session.messages.push(ConversationMessage::user_text(
        "I prefer a quiet hotel with a rooftop pool and a city view.",
    ));
    session
        .save_to_path(sessions_dir.join("profile-session.json"))
        .expect("save profile session");

    let result = search_sessions(
        &sessions_dir,
        Some("Can you recommend a hotel for my trip?"),
        None,
        5,
        2,
    )
    .expect("preference search");
    assert!(
        matches!(
            &result,
            SessionSearchResult::Search { ref results, .. }
                if results.first().is_some_and(|hit| {
                    hit.match_message_index == 0
                        && hit.messages.iter().any(|message| message.index == 8)
                })
        ),
        "unexpected profile result: {result:?}"
    );
    fs::remove_dir_all(base).expect("remove sessions dir");
}

#[test]
fn optional_embeddings_use_rrf_and_are_invalidated_when_content_changes() {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    let base = std::env::temp_dir().join(format!("aris-session-hybrid-{suffix}"));
    let sessions_dir = base.join("sessions");
    fs::create_dir_all(&sessions_dir).expect("sessions dir");
    let apple_path = sessions_dir.join("apple.json");
    let mut apple = Session::new();
    apple
        .messages
        .push(ConversationMessage::user_text("The orchard grows apples."));
    apple.save_to_path(&apple_path).expect("save apple session");
    let mut banana = Session::new();
    banana
        .messages
        .push(ConversationMessage::user_text("The market sells bananas."));
    banana
        .save_to_path(sessions_dir.join("banana.json"))
        .expect("save banana session");

    let pending =
        pending_session_embedding_inputs(&sessions_dir, "test-model", 10).expect("pending vectors");
    assert_eq!(pending.len(), 2);
    let stored = upsert_session_message_embeddings(
        &sessions_dir,
        "test-model",
        &[
            SessionMessageEmbedding {
                session_id: "apple".to_string(),
                message_index: 0,
                vector: vec![1.0, 0.0],
            },
            SessionMessageEmbedding {
                session_id: "banana".to_string(),
                message_index: 0,
                vector: vec![0.0, 1.0],
            },
        ],
    )
    .expect("store vectors");
    assert_eq!(stored, 2);

    let result = search_sessions_hybrid(
        &sessions_dir,
        Some("semantic-only-query"),
        None,
        5,
        2,
        "test-model",
        &[1.0, 0.0],
    )
    .expect("hybrid search");
    assert!(matches!(
        result,
        SessionSearchResult::Search { ref results, .. }
            if results.first().is_some_and(|hit| hit.session_id == "apple")
    ));

    apple.messages[0] = ConversationMessage::user_text("The orchard now grows pears.");
    apple
        .save_to_path(&apple_path)
        .expect("update apple session");
    let pending = pending_session_embedding_inputs(&sessions_dir, "test-model", 10)
        .expect("pending vectors after content change");
    assert!(pending
        .iter()
        .any(|input| input.session_id == "apple" && input.message_index == 0));
    fs::remove_dir_all(base).expect("remove sessions dir");
}

#[test]
fn time_filter_and_update_query_prefer_the_newer_matching_fact() {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    let base = std::env::temp_dir().join(format!("aris-session-time-{suffix}"));
    let sessions_dir = base.join("sessions");
    fs::create_dir_all(&sessions_dir).expect("sessions dir");
    let mut old = Session::new();
    old.messages.push(ConversationMessage::user_text(
        "[LongMemEval session_id=old date=2023/05/01 (Mon) 08:00]\nThe project status uses the old database.",
    ));
    old.save_to_path(sessions_dir.join("old.json"))
        .expect("save old session");
    let mut recent = Session::new();
    recent.messages.push(ConversationMessage::user_text(
        "[LongMemEval session_id=recent date=2023/05/30 (Tue) 08:00]\nThe project status uses the new database.",
    ));
    recent
        .save_to_path(sessions_dir.join("recent.json"))
        .expect("save recent session");

    let filtered = search_sessions_filtered(
        &sessions_dir,
        Some("project status database"),
        None,
        5,
        2,
        SessionSearchFilter {
            time_start_ms: super::embedded_date_millis("date=2023/05/20"),
            time_end_ms: super::embedded_date_millis("date=2023/06/01"),
            prefer_recent: false,
        },
    )
    .expect("filtered search");
    assert!(
        matches!(
            &filtered,
            SessionSearchResult::Search { ref results, .. }
                if results.len() == 1 && results[0].session_id == "recent"
        ),
        "unexpected filtered result: {filtered:?}"
    );

    let latest = search_sessions(
        &sessions_dir,
        Some("What is the latest project status database?"),
        None,
        5,
        2,
    )
    .expect("latest search");
    assert!(matches!(
        latest,
        SessionSearchResult::Search { ref results, .. }
            if results.first().is_some_and(|hit| hit.session_id == "recent")
    ));
    fs::remove_dir_all(base).expect("remove sessions dir");
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

#[test]
fn status_reads_never_trigger_a_rebuild() {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    let base = std::env::temp_dir().join(format!("aris-session-status-{suffix}"));
    // Incremental save-time indexing only applies under a `sessions` directory,
    // so this mirrors the real per-project layout.
    let sessions_dir = base.join("sessions");
    fs::create_dir_all(&sessions_dir).expect("sessions dir");
    let mut session = Session::new();
    session.messages.push(ConversationMessage::user_text(
        "status surfaces must stay cheap",
    ));
    session
        .save_to_path(&sessions_dir.join("session-status.json"))
        .expect("save session");

    // A schema upgrade (or a repair killed halfway) leaves this flag set. The
    // rebuild it asks for costs a full re-parse of every Session, so a status
    // read must report it rather than run it — that stall is what froze the
    // memory settings page when it ran on the UI thread.
    let connection = open_index(&sessions_dir).expect("open index");
    set_metadata_flag(&connection, "reindex_required", true).expect("flag stale projection");
    drop(connection);

    let state = session_index_reindex_state(&sessions_dir).expect("reindex state");
    assert!(state.pending, "a flagged projection must report as pending");
    assert!(!state.running, "no rebuild is running yet");

    let stats = session_index_stats(&sessions_dir, &[]).expect("index stats");
    assert_eq!(stats.session_count, 1, "counts come from the projection");
    let recent = recent_session_messages(&sessions_dir, 10, &[]).expect("recent messages");
    assert_eq!(recent.len(), 1);
    assert!(
        session_index_reindex_state(&sessions_dir)
            .expect("reindex state")
            .pending,
        "reads must leave the rebuild to the background repair thread"
    );

    sync_sessions_dir(&sessions_dir).expect("background repair");
    assert!(
        !session_index_reindex_state(&sessions_dir)
            .expect("reindex state")
            .pending,
        "an explicit repair is what clears the flag"
    );

    fs::remove_dir_all(base).expect("remove sessions dir");
}

fn temp_sessions_dir(label: &str) -> std::path::PathBuf {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("aris-{label}-{suffix}"));
    fs::create_dir_all(&dir).expect("sessions dir");
    dir
}

fn save_text_session(dir: &std::path::Path, name: &str, user: &str, assistant: &str) {
    let mut session = Session::new();
    session.messages.push(ConversationMessage::user_text(user));
    session
        .messages
        .push(ConversationMessage::assistant(vec![ContentBlock::Text {
            text: assistant.to_string(),
        }]));
    session
        .save_to_path(&dir.join(format!("{name}.json")))
        .expect("save session");
}

fn search_session_ids(dir: &std::path::Path, query: &str, limit: usize) -> Vec<String> {
    match search_sessions(dir, Some(query), None, limit, 0).expect("search") {
        SessionSearchResult::Search { results, .. } => {
            results.into_iter().map(|hit| hit.session_id).collect()
        }
        other => panic!("unexpected result: {other:?}"),
    }
}

#[test]
fn bigram_projection_splits_cjk_runs_and_keeps_words() {
    assert_eq!(
        bigram_index_text("第三章用ESN模型，main.tex 编译"),
        "第三 三章 章用 esn 模型 main.tex 编译"
    );
    assert_eq!(bigram_index_text("图"), "图");
    assert_eq!(
        bigram_query_terms("数据集 数据集 dataset"),
        vec!["数据".to_string(), "据集".to_string(), "dataset".to_string()]
    );
    assert!(bigram_query_terms("？！ 。").is_empty());
}

#[test]
fn recency_weight_halves_the_bonus_every_half_life() {
    assert!((recency_weight(0, 30.0) - 1.0).abs() < 1e-9);
    assert!((recency_weight(30 * 86_400_000, 30.0) - 0.75).abs() < 1e-9);
    let old = recency_weight(3650 * 86_400_000, 30.0);
    assert!((0.5..0.51).contains(&old), "a decade-old hit keeps half its relevance");
    assert!((recency_weight(-5, 30.0) - 1.0).abs() < 1e-9);
}

#[test]
fn two_character_chinese_words_are_found_and_rare_terms_outrank_common_ones() {
    let dir = temp_sessions_dir("bigram-rank");
    // The common session repeats words that also appear in the query; the
    // answer session shares the rare word 期刊 (journal) and the venue name.
    save_text_session(
        &dir,
        "chat-common",
        "我们讨论一下论文论文论文的写作安排，论文先写引言。",
        "好的，论文写作按章节推进。",
    );
    save_text_session(
        &dir,
        "chat-answer",
        "投稿目标定为 TNNLS 期刊。",
        "已记录：目标期刊 TNNLS。",
    );
    let ids = search_session_ids(&dir, "这篇论文最后定的投稿期刊是哪个？", 2);
    assert_eq!(ids.first().map(String::as_str), Some("chat-answer"));
    let ids = search_session_ids(&dir, "期刊", 2);
    assert_eq!(ids, vec!["chat-answer".to_string()]);
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn an_older_index_uses_like_until_the_repair_backfills_bigrams() {
    let dir = temp_sessions_dir("bigram-backfill");
    save_text_session(&dir, "chat-a", "章节目录改成 Final/Ch1 到 Ch6。", "收到。");
    // First search builds a fresh index, which is born bigram-ready.
    assert_eq!(search_session_ids(&dir, "章节目录", 3), vec!["chat-a".to_string()]);
    // Simulate an index written by an older build: no bigram rows, flag off.
    {
        let connection = open_index(&dir).expect("open");
        connection
            .execute(
                "INSERT INTO messages_bigram_fts(messages_bigram_fts) VALUES('delete-all')",
                [],
            )
            .expect("clear bigrams");
        set_metadata_flag(&connection, BIGRAM_READY_FLAG, false).expect("flag");
    }
    assert!(session_index_reindex_state(&dir).expect("state").pending);
    // LIKE still answers while the backfill is owed.
    assert_eq!(search_session_ids(&dir, "章节目录", 3), vec!["chat-a".to_string()]);
    sync_sessions_dir(&dir).expect("repair");
    assert!(!session_index_reindex_state(&dir).expect("state").pending);
    let connection = open_index(&dir).expect("open");
    let rows: i64 = connection
        .query_row(
            "SELECT count(*) FROM messages_bigram_fts WHERE messages_bigram_fts MATCH '\"目录\"'",
            [],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(rows, 1);
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn removed_sessions_and_rewritten_messages_leave_no_stale_bigram_rows() {
    let dir = temp_sessions_dir("bigram-prune");
    save_text_session(&dir, "chat-a", "数据集用 SCADA 风机数据。", "好的。");
    save_text_session(&dir, "chat-b", "图表统一用 matplotlib。", "好的。");
    sync_sessions_dir(&dir).expect("index");
    assert_eq!(search_session_ids(&dir, "风机数据", 3), vec!["chat-a".to_string()]);
    // Rewriting a message replaces its bigram row instead of adding one.
    save_text_session(&dir, "chat-a", "数据集改为光伏数据。", "好的。");
    sync_sessions_dir(&dir).expect("reindex");
    assert!(search_session_ids(&dir, "风机", 3).is_empty());
    assert_eq!(search_session_ids(&dir, "光伏", 3), vec!["chat-a".to_string()]);
    fs::remove_file(dir.join("chat-a.json")).expect("remove");
    sync_sessions_dir(&dir).expect("prune");
    assert!(search_session_ids(&dir, "光伏", 3).is_empty());
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn a_deleted_chat_leaves_search_at_once_and_a_missing_index_is_not_created() {
    let dir = temp_sessions_dir("forget-session");
    save_text_session(&dir, "chat-a", "数据集用 SCADA 风机数据。", "好的。");
    save_text_session(&dir, "chat-b", "风机数据要先清洗。", "好的。");
    sync_sessions_dir(&dir).expect("index");
    assert_eq!(search_session_ids(&dir, "风机数据", 3).len(), 2);
    // chat_delete removes the files and then the rows, with no repair pass.
    fs::remove_file(dir.join("chat-a.json")).expect("remove");
    forget_indexed_session(&dir, "chat-a").expect("forget");
    assert_eq!(search_session_ids(&dir, "风机数据", 3), vec!["chat-b".to_string()]);
    let connection = open_index(&dir).expect("open");
    let bigram_rows: i64 = connection
        .query_row("SELECT count(*) FROM messages_bigram_fts WHERE messages_bigram_fts MATCH 'scada'", [], |row| row.get(0))
        .expect("count");
    assert_eq!(bigram_rows, 0);

    let empty = temp_sessions_dir("forget-no-index");
    forget_indexed_session(&empty, "chat-x").expect("no index is fine");
    assert!(!empty.join("session-index.sqlite3").exists());
    let _ = fs::remove_dir_all(dir);
    let _ = fs::remove_dir_all(empty);
}

fn indexed_times(dir: &std::path::Path, session_id: &str) -> Vec<(usize, i64)> {
    let connection = open_index(dir).expect("open");
    let mut statement = connection
        .prepare("SELECT message_index, recorded_at FROM messages WHERE session_id = ?1 ORDER BY message_index")
        .expect("prepare");
    let rows = statement
        .query_map([session_id], |row| Ok((row.get::<_, i64>(0)? as usize, row.get(1)?)))
        .expect("query");
    rows.filter_map(Result::ok).collect()
}

#[test]
fn a_rewritten_session_keeps_the_time_each_message_was_first_seen() {
    let dir = temp_sessions_dir("first-seen");
    let path = dir.join("chat-a.json");
    let mut session = Session::new();
    session.messages.push(ConversationMessage::user_text("四月定下用 SCADA 风机数据。"));
    session.save_to_path(&path).expect("save");
    index_session(&path, &session).expect("index");
    let original = indexed_times(&dir, "chat-a");
    assert!(original[0].1 > 0, "{original:?}");

    // A compaction or rewind appends the whole Session again behind a reset,
    // stamped with the time of the rewrite (here: a year later).
    let later = original[0].1 + 365 * 24 * 3_600_000;
    let events = path.with_extension("events.jsonl");
    let mut log = fs::read_to_string(&events).expect("log");
    log.push_str(&format!("{{\"kind\":\"session_reset\",\"ts\":{later},\"payload\":{{}}}}\n"));
    log.push_str(&format!("{{\"kind\":\"session_message\",\"ts\":{later},\"payload\":{{\"index\":0}}}}\n"));
    log.push_str(&format!("{{\"kind\":\"session_message\",\"ts\":{later},\"payload\":{{\"index\":1}}}}\n"));
    fs::write(&events, log).expect("rewrite log");
    session.messages.push(ConversationMessage::user_text("十一月继续讨论。"));
    index_session(&path, &session).expect("reindex");

    let times = indexed_times(&dir, "chat-a");
    assert_eq!(times[0].1, original[0].1, "the old message moved to the rewrite time: {times:?}");
    assert_eq!(times[1].1, later, "the new message takes its own time: {times:?}");
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn messages_without_any_time_take_the_session_start_not_the_file_mtime() {
    assert_eq!(session_start_from_id("chat-1795406255665-3zf9ga"), Some(1_795_406_255_665));
    assert_eq!(session_start_from_id("wf-review-42"), None);
    assert_eq!(session_start_from_id("chat-0000000000001-x"), None);

    let dir = temp_sessions_dir("no-time");
    let path = dir.join("chat-1700000000000-abc.json");
    let mut session = Session::new();
    session.messages.push(ConversationMessage::user_text("旧会话里定下的模板。"));
    session.save_to_path(&path).expect("save");
    // No event log at all: the history predates it.
    let _ = fs::remove_file(path.with_extension("events.jsonl"));
    index_session(&path, &session).expect("index");
    let times = indexed_times(&dir, "chat-1700000000000-abc");
    assert_eq!(times, vec![(0, 1_700_000_000_000)]);
    let _ = fs::remove_dir_all(dir);
}
