use tempfile::tempdir;

use super::*;

fn capture(project_id: &str, event: &str, user: &str, assistant: &str) -> ResearchMemoryCapture {
    ResearchMemoryCapture {
        project_id: project_id.to_string(),
        session_id: "session-a".to_string(),
        source_event_ids: vec![event.to_string()],
        user_text: user.to_string(),
        assistant_text: assistant.to_string(),
        occurred_at: "2026-08-10T12:00:00Z".to_string(),
    }
}

#[test]
fn batch_enqueue_is_atomic_and_idempotent() {
    let temp = tempdir().expect("tempdir");
    let store = ResearchMemoryStore::new(temp.path().join("research.sqlite3"));
    let first = capture(
        "project-a",
        "event-1",
        "We decided to retain SQLite for the memory index.",
        "The decision and its source were recorded.",
    );
    let second = capture(
        "project-a",
        "event-2",
        "The experiment result reduced p95 latency to 42 ms.",
        "The benchmark result was recorded.",
    );

    assert_eq!(
        store
            .enqueue_captures(&[first.clone(), second.clone()])
            .expect("batch enqueue"),
        2
    );
    assert_eq!(
        store
            .enqueue_captures(&[first, second])
            .expect("deduplicate batch"),
        0
    );
    assert_eq!(store.drain_outbox(10).expect("drain batch"), 2);
}

#[test]
fn drain_due_outbox_is_not_capped_by_a_fixed_number_of_batches() {
    let temp = tempdir().expect("tempdir");
    let store = ResearchMemoryStore::new(temp.path().join("research.sqlite3"));
    let captures = (0..25)
        .map(|index| {
            capture(
                "project-a",
                &format!("event-{index}"),
                "This ordinary message is long enough for durable capture.",
                "This ordinary response is also long enough for durable capture.",
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        store.enqueue_captures(&captures).expect("enqueue backlog"),
        25
    );
    assert_eq!(store.drain_due_outbox(3).expect("drain entire backlog"), 25);
    assert_eq!(store.stats("project-a").expect("stats").pending_count, 0);
}

#[test]
fn builtin_outbox_persists_backoff_and_exposes_dead_letters() {
    let temp = tempdir().expect("tempdir");
    let store = ResearchMemoryStore::new(temp.path().join("research.sqlite3"));
    let item = capture(
        "project-a",
        "event-retry",
        "We decided to retain SQLite for the durable memory index.",
        "The durable memory decision was recorded.",
    );
    store.enqueue_capture(&item).expect("enqueue");
    let id = capture_id(&item);
    let connection = store.open().expect("open");
    mark_outbox_failed(&connection, &id, 0, "synthetic extraction failure")
        .expect("schedule retry");

    assert_eq!(store.drain_outbox(10).expect("not due"), 0);
    assert!(store
        .next_outbox_delay()
        .expect("next delay")
        .is_some_and(|delay| !delay.is_zero()));
    assert!(store
        .dead_letters("project-a", 10)
        .expect("dead letters")
        .is_empty());

    for attempts in 1..OUTBOX_MAX_ATTEMPTS {
        mark_outbox_failed(&connection, &id, attempts, "persistent extraction failure")
            .expect("advance retry");
    }
    let dead = store.dead_letters("project-a", 10).expect("dead letters");
    assert_eq!(dead.len(), 1);
    assert_eq!(dead[0].attempts, OUTBOX_MAX_ATTEMPTS);
    assert!(dead[0].last_error.contains("persistent extraction failure"));
    assert!(store
        .next_outbox_delay()
        .expect("no pending retry")
        .is_none());
}

#[test]
fn schema_upgrade_adds_next_attempt_to_existing_outboxes() {
    let temp = tempdir().expect("tempdir");
    let path = temp.path().join("research.sqlite3");
    let connection = Connection::open(&path).expect("legacy database");
    connection
        .execute_batch(
            "CREATE TABLE research_memory_outbox(
               id TEXT PRIMARY KEY,
               project_id TEXT NOT NULL,
               session_id TEXT NOT NULL,
               source_event_ids TEXT NOT NULL,
               user_text TEXT NOT NULL,
               assistant_text TEXT NOT NULL,
               occurred_at TEXT NOT NULL,
               status TEXT NOT NULL,
               attempts INTEGER NOT NULL,
               last_error TEXT,
               created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL
             );",
        )
        .expect("legacy schema");
    drop(connection);

    let store = ResearchMemoryStore::new(&path);
    store.stats("project-a").expect("upgrade schema");
    let connection = Connection::open(path).expect("reopen upgraded database");
    let has_column = connection
        .prepare("PRAGMA table_info(research_memory_outbox)")
        .expect("table info")
        .query_map([], |row| row.get::<_, String>(1))
        .expect("columns")
        .filter_map(Result::ok)
        .any(|column| column == "next_attempt_at");
    assert!(has_column);
}

#[test]
fn extracts_research_atoms_and_builds_cards_and_profile() {
    let temp = tempdir().expect("tempdir");
    let store = ResearchMemoryStore::new(temp.path().join("research.sqlite3"));
    let item = capture(
        "project-a",
        "event-1",
        "我偏好简洁的中文回答，并且实验必须保留完整来源。",
        "我们决定使用 SQLite FTS5。实验结果 p95 延迟降低到 42 ms。报告保存在 ./reports/result.json。",
    );
    assert!(store.enqueue_capture(&item).expect("enqueue"));
    assert!(!store.enqueue_capture(&item).expect("deduplicate"));
    assert_eq!(store.drain_outbox(10).expect("drain"), 1);

    let snapshot = store.snapshot("project-a", 50).expect("snapshot");
    assert!(snapshot.stats.atom_count >= 4, "{snapshot:?}");
    assert_eq!(snapshot.stats.card_count, 1, "{snapshot:?}");
    assert!(snapshot.cards[0].summary.contains("p95"));
    assert!(snapshot.profile.is_some());
    assert!(snapshot
        .atoms
        .iter()
        .any(|atom| atom.kind == "artifact_pointer" && !atom.artifact_paths.is_empty()));

    let duplicate = capture(
        "project-a",
        "event-2",
        "我偏好简洁的中文回答，并且实验必须保留完整来源。",
        "该偏好已经再次确认并保留来源。",
    );
    assert!(store
        .enqueue_capture(&duplicate)
        .expect("enqueue duplicate source"));
    store.drain_outbox(10).expect("drain duplicate source");
    let merged = store.snapshot("project-a", 50).expect("merged snapshot");
    assert!(merged.atoms.iter().any(|atom| {
        atom.kind == "user_preference"
            && atom.source_event_ids.contains(&"event-1".to_string())
            && atom.source_event_ids.contains(&"event-2".to_string())
    }));

    let recall = store
        .recall("project-a", "SQLite latency", 5, 2)
        .expect("recall");
    assert!(!recall.atoms.is_empty());
    assert!(recall.latency_ms < 1_000);
}

#[test]
fn keeps_projects_isolated_and_tracks_knowledge_updates() {
    let temp = tempdir().expect("tempdir");
    let store = ResearchMemoryStore::new(temp.path().join("research.sqlite3"));
    let mut first = capture(
        "project-a",
        "event-1",
        "我们决定 embedding model 使用 model-a。",
        "当前配置已经记录。",
    );
    first.session_id = "session-old".to_string();
    let mut second = capture(
        "project-a",
        "event-2",
        "最新决定：embedding model 改为 model-b。",
        "配置已更新为 model-b。",
    );
    second.session_id = "session-new".to_string();
    let other = capture(
        "project-b",
        "event-3",
        "我们决定 embedding model 使用 secret-model。",
        "当前配置已经记录。",
    );
    for item in [&first, &second, &other] {
        assert!(store.enqueue_capture(item).expect("enqueue"));
    }
    assert_eq!(store.drain_outbox(10).expect("drain"), 3);

    let project_a = store.snapshot("project-a", 50).expect("project a");
    assert!(project_a
        .atoms
        .iter()
        .any(|atom| atom.statement.contains("model-b") && atom.supersedes_id.is_some()));
    assert!(project_a
        .atoms
        .iter()
        .any(|atom| atom.status == "superseded"));
    assert!(!project_a
        .cards
        .iter()
        .any(|card| card.summary.contains("model-a")));
    assert!(!project_a
        .atoms
        .iter()
        .any(|atom| atom.statement.contains("secret-model")));
}

#[test]
fn recall_uses_validity_windows_and_occurrence_time_for_historical_questions() {
    let temp = tempdir().expect("tempdir");
    let store = ResearchMemoryStore::new(temp.path().join("research.sqlite3"));
    let mut old = capture(
        "project-a",
        "event-old",
        "We decided the embedding model will use model-a.",
        "The embedding model decision was recorded.",
    );
    old.session_id = "session-old".to_string();
    old.occurred_at = "2000-06-01T12:00:00Z".to_string();
    let mut latest = capture(
        "project-a",
        "event-latest",
        "We decided to replace the embedding model with model-b.",
        "The current embedding model is model-b.",
    );
    latest.session_id = "session-latest".to_string();
    latest.occurred_at = "2000-07-10T12:00:00Z".to_string();
    store.enqueue_capture(&latest).expect("enqueue latest");
    assert_eq!(store.drain_outbox(10).expect("drain latest"), 1);
    // Historical imports are not guaranteed to arrive chronologically. An
    // older capture processed later must not replace the current version.
    store.enqueue_capture(&old).expect("enqueue old");
    assert_eq!(store.drain_outbox(10).expect("drain old"), 1);

    let current = store
        .recall("project-a", "current embedding model decision", 10, 2)
        .expect("current recall");
    assert!(current
        .atoms
        .iter()
        .any(|atom| atom.statement.contains("model-b")));
    assert!(!current
        .atoms
        .iter()
        .any(|atom| atom.statement.contains("model-a")));

    let historical = store
        .recall(
            "project-a",
            "Which embedding model decision applied on 2000-06-15?",
            10,
            2,
        )
        .expect("historical recall");
    assert!(historical
        .atoms
        .iter()
        .any(|atom| atom.statement.contains("model-a")));
    assert!(!historical
        .atoms
        .iter()
        .any(|atom| atom.statement.contains("model-b")));
}

#[test]
fn expired_preferences_remain_auditable_but_leave_normal_recall_and_profile() {
    let temp = tempdir().expect("tempdir");
    let store = ResearchMemoryStore::new(temp.path().join("research.sqlite3"));
    let item = capture(
        "project-a",
        "event-expired",
        "I prefer concise English answers for research summaries.",
        "The answer-style preference was recorded.",
    );
    store.enqueue_capture(&item).expect("enqueue");
    store.drain_outbox(10).expect("drain");
    store
        .open()
        .expect("open")
        .execute(
            "UPDATE research_memory_atoms SET valid_until='2020-01-01T00:00:00Z'
             WHERE project_id='project-a' AND kind='user_preference'",
            [],
        )
        .expect("expire preference");

    let recall = store
        .recall("project-a", "concise English answer preference", 10, 2)
        .expect("recall");
    assert!(recall.atoms.is_empty(), "{recall:?}");
    assert!(recall.cards.is_empty(), "{recall:?}");
    assert!(recall.profile.is_none(), "{recall:?}");
    assert!(store
        .search_atoms("project-a", "concise English", 10)
        .expect("governance search")
        .iter()
        .any(|atom| atom.kind == "user_preference"));
}

#[test]
fn corrections_are_user_confirmed_and_deletions_refresh_derived_layers() {
    let temp = tempdir().expect("tempdir");
    let store = ResearchMemoryStore::new(temp.path().join("research.sqlite3"));
    let item = capture(
        "project-a",
        "event-1",
        "我偏好英文回答。",
        "已经记录该写作偏好。",
    );
    store.enqueue_capture(&item).expect("enqueue");
    store.drain_outbox(10).expect("drain");
    let atom = store
        .snapshot("project-a", 10)
        .expect("snapshot")
        .atoms
        .into_iter()
        .find(|atom| atom.kind == "user_preference")
        .expect("preference atom");

    store
        .update_atom("project-a", &atom.id, "用户确认：默认使用中文回答。")
        .expect("update");
    let updated = store.snapshot("project-a", 10).expect("updated snapshot");
    let updated_atom = updated
        .atoms
        .iter()
        .find(|candidate| candidate.id == atom.id)
        .expect("updated atom");
    assert_eq!(updated_atom.status, "user_confirmed");
    assert_eq!(updated_atom.confidence_millis, 1000);
    assert_ne!(updated_atom.normalized_key, atom.normalized_key);
    assert!(updated
        .profile
        .as_ref()
        .is_some_and(|profile| profile.content.contains("中文回答")));

    store
        .delete_atom("project-a", &atom.id)
        .expect("delete atom");
    let deleted = store.snapshot("project-a", 10).expect("deleted snapshot");
    assert!(!deleted
        .atoms
        .iter()
        .any(|candidate| candidate.id == atom.id));
}

#[test]
fn recall_returns_nothing_when_the_query_has_no_lexical_anchor() {
    let temp = tempdir().expect("tempdir");
    let store = ResearchMemoryStore::new(temp.path().join("research.sqlite3"));
    let item = capture(
        "project-a",
        "event-1",
        "We decided to retain SQLite FTS5 for the session index.",
        "The experiment result reduced p95 latency to 42 ms.",
    );
    store.enqueue_capture(&item).expect("enqueue");
    store.drain_outbox(10).expect("drain");
    assert!(
        store
            .snapshot("project-a", 50)
            .expect("snapshot")
            .stats
            .atom_count
            > 0
    );

    // A question about an unrelated subject must not pull the stored rows in
    // merely because it shares function words with them.
    let unrelated = store
        .recall(
            "project-a",
            "What did the user say about their favourite hiking trail?",
            5,
            2,
        )
        .expect("unrelated recall");
    assert!(unrelated.atoms.is_empty(), "{unrelated:?}");
    assert!(unrelated.cards.is_empty(), "{unrelated:?}");

    let related = store
        .recall("project-a", "sqlite fts5 session index latency", 5, 2)
        .expect("related recall");
    assert!(!related.atoms.is_empty(), "{related:?}");

    // The inspection surface keeps listing rows for an empty query; only the
    // prompt-injection path is gated.
    assert!(!store
        .search_atoms("project-a", "", 5)
        .expect("governance listing")
        .is_empty());
}

#[test]
fn recall_terms_drop_function_words() {
    let terms = recall_terms("What did I say about the p95 latency of the SQLite index?");
    assert!(terms.contains(&"p95".to_string()));
    assert!(terms.contains(&"sqlite".to_string()));
    assert!(!terms.contains(&"what".to_string()));
    assert!(!terms.contains(&"the".to_string()));
    assert!(!terms.iter().any(|term| term.chars().count() < 2));
    assert!(recall_terms("的 了 吗").is_empty());
}

#[test]
fn unresolved_conflicts_remain_governable_but_are_not_recalled() {
    let temp = tempdir().expect("tempdir");
    let store = ResearchMemoryStore::new(temp.path().join("research.sqlite3"));
    let first = capture(
        "project-a",
        "event-1",
        "记录本轮 embedding model 基准实验。",
        "实验结果：embedding model 的 p95 延迟为 42 ms。",
    );
    let second = capture(
        "project-a",
        "event-2",
        "记录另一轮 embedding model 基准实验。",
        "实验结果：embedding model 的 p95 延迟为 55 ms。",
    );
    store.enqueue_capture(&first).expect("enqueue first");
    store.enqueue_capture(&second).expect("enqueue second");
    assert_eq!(store.drain_outbox(10).expect("drain"), 2);

    let snapshot = store.snapshot("project-a", 50).expect("snapshot");
    assert!(snapshot.stats.conflict_count >= 2, "{snapshot:?}");
    let recall = store
        .recall("project-a", "embedding model p95", 10, 2)
        .expect("recall");
    assert!(!recall.atoms.iter().any(|atom| atom.status == "conflict"));
    assert!(
        recall.cards.is_empty(),
        "conflict-derived R2 must not be recalled"
    );
    let governance = store
        .search_atoms("project-a", "embedding model p95", 10)
        .expect("governance search");
    assert!(governance.iter().any(|atom| atom.status == "conflict"));
}
