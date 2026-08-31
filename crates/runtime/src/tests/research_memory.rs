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
    // Supersession is decided on occurrence time, not insertion order: two rows
    // stamped with the same moment are two halves of one turn, not a knowledge
    // update. Live capture stamps each completed turn, so a later decision
    // genuinely carries a later timestamp.
    second.occurred_at = "2026-08-11T09:30:00Z".to_string();
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

#[test]
fn recalls_chinese_queries_that_have_no_word_delimiters() {
    let temp = tempdir().expect("tempdir");
    let store = ResearchMemoryStore::new(temp.path().join("research.sqlite3"));
    store
        .enqueue_capture(&capture(
            "project-a",
            "event-1",
            "我们决定采用 SQLite 作为记忆索引的存储引擎。",
            "已经记录了这个关于记忆索引存储的决定。",
        ))
        .expect("enqueue");
    store.drain_outbox(10).expect("drain");

    // A Chinese sentence carries no spaces, and FTS5's `unicode61` tokenizer
    // indexes the whole run as one token. Before bigram matching this recalled
    // nothing at all, which left R1 and R2 unreachable for Chinese projects.
    let recall = store
        .recall("project-a", "记忆索引选择了哪个存储引擎", 5, 2)
        .expect("chinese recall");
    assert!(
        recall
            .atoms
            .iter()
            .any(|atom| atom.statement.contains("存储引擎")),
        "{recall:?}"
    );
    assert!(!recall.cards.is_empty(), "{recall:?}");
    assert!(!store
        .search_atoms("project-a", "记忆索引选择了哪个存储引擎", 10)
        .expect("chinese governance search")
        .is_empty());

    // The gate still holds: an unrelated Chinese question shares stray bigrams
    // with the stored rows but must not pull them into the prompt.
    let unrelated = store
        .recall("project-a", "上周提到的会议纪要在哪里", 5, 2)
        .expect("unrelated chinese recall");
    assert!(unrelated.atoms.is_empty(), "{unrelated:?}");
    assert!(unrelated.cards.is_empty(), "{unrelated:?}");
}

#[test]
fn recall_terms_reduce_ideograph_runs_to_bigrams() {
    let terms = recall_terms("记忆索引");
    assert_eq!(terms, vec!["记忆", "忆索", "索引"]);
    // Mixed queries keep their Latin words alongside the bigrams.
    let mixed = recall_terms("执行模型 gpt-5.6 的 p95");
    assert!(mixed.contains(&"执行".to_string()));
    assert!(mixed.contains(&"gpt-5".to_string()));
    assert!(mixed.contains(&"p95".to_string()));
}

#[test]
fn unrelated_subjects_no_longer_supersede_one_another() {
    let temp = tempdir().expect("tempdir");
    let store = ResearchMemoryStore::new(temp.path().join("research.sqlite3"));
    let mut first = capture(
        "project-a",
        "event-1",
        "我们决定采用 gpt-5.6 作为执行模型。",
        "已记录执行模型的选择。",
    );
    first.session_id = "session-1".to_string();
    let mut second = capture(
        "project-a",
        "event-2",
        "我们决定用 deepseek 作为审查模型。",
        "已记录审查模型的选择。",
    );
    second.session_id = "session-2".to_string();
    second.occurred_at = "2026-08-11T12:00:00Z".to_string();
    store.enqueue_capture(&first).expect("enqueue first");
    store.drain_outbox(10).expect("drain first");
    store.enqueue_capture(&second).expect("enqueue second");
    store.drain_outbox(10).expect("drain second");

    let snapshot = store.snapshot("project-a", 50).expect("snapshot");
    let active = snapshot
        .atoms
        .iter()
        .filter(|atom| atom.status == "derived" || atom.status == "user_confirmed")
        .collect::<Vec<_>>();
    // The executor and reviewer choices are different facts. A bare `模型`
    // subject key collapsed them onto one row and dropped the older one.
    assert!(
        active.iter().any(|atom| atom.statement.contains("gpt-5.6")),
        "{active:?}"
    );
    assert!(
        active.iter().any(|atom| atom.statement.contains("deepseek")),
        "{active:?}"
    );
}

#[test]
fn a_same_turn_assistant_echo_does_not_supersede_the_user_statement() {
    let temp = tempdir().expect("tempdir");
    let store = ResearchMemoryStore::new(temp.path().join("research.sqlite3"));
    store
        .enqueue_capture(&capture(
            "project-a",
            "event-1",
            "我们决定采用 gpt-5.6 作为执行模型。",
            "已记录执行模型的选择。",
        ))
        .expect("enqueue");
    store.drain_outbox(10).expect("drain");

    let snapshot = store.snapshot("project-a", 50).expect("snapshot");
    let decision = snapshot
        .atoms
        .iter()
        .find(|atom| atom.statement.contains("gpt-5.6"))
        .expect("user decision atom");
    // Both halves of one turn share `occurred_at`; the acknowledgement must not
    // bury the statement it is acknowledging.
    assert_eq!(decision.status, "derived", "{snapshot:?}");
}

#[test]
fn dead_letters_can_be_returned_to_the_queue() {
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
    for attempts in 0..OUTBOX_MAX_ATTEMPTS {
        mark_outbox_failed(&connection, &id, attempts, "persistent extraction failure")
            .expect("advance retry");
    }
    assert_eq!(store.dead_letters("project-a", 10).expect("dead").len(), 1);

    assert_eq!(store.retry_dead_letters("project-a").expect("retry"), 1);
    assert!(store
        .dead_letters("project-a", 10)
        .expect("cleared")
        .is_empty());
    assert_eq!(store.drain_outbox(10).expect("drain restored"), 1);
    assert!(store.snapshot("project-a", 50).expect("snapshot").stats.atom_count > 0);
}

#[test]
fn project_scoped_drain_leaves_other_projects_alone() {
    let temp = tempdir().expect("tempdir");
    let store = ResearchMemoryStore::new(temp.path().join("research.sqlite3"));
    store
        .enqueue_capture(&capture(
            "project-a",
            "event-a",
            "We decided to retain SQLite for the memory index.",
            "The decision was recorded for project a.",
        ))
        .expect("enqueue a");
    store
        .enqueue_capture(&capture(
            "project-b",
            "event-b",
            "We decided to adopt DuckDB for the analytics index.",
            "The decision was recorded for project b.",
        ))
        .expect("enqueue b");

    assert_eq!(
        store
            .drain_project_outbox("project-a", 50)
            .expect("scoped drain"),
        1
    );
    assert_eq!(store.stats("project-a").expect("a").pending_count, 0);
    assert_eq!(store.stats("project-b").expect("b").pending_count, 1);
}

/// R3 is injected into every prompt with no relevance test, so a sentence the
/// assistant wrote while narrating its own work must not become a standing
/// project rule. The live database that motivated this had 12 of 18 injected
/// lines authored by the assistant, including one project's LaTeX section
/// heading and a raw tool-result JSON blob.
#[test]
fn assistant_authored_rules_stay_in_r1_and_out_of_the_profile() {
    let temp = tempdir().expect("tempdir");
    let store = ResearchMemoryStore::new(temp.path().join("research.sqlite3"));
    store
        .enqueue_capture(&capture(
            "project-a",
            "event-1",
            "帮我看看当前的编译流程。",
            "必须先编译再提交，不能直接删除旧的构建目录。",
        ))
        .expect("enqueue");
    store.drain_outbox(10).expect("drain");

    let snapshot = store.snapshot("project-a", 50).expect("snapshot");
    // The statement is still memory, and still recallable on topic overlap.
    assert!(
        snapshot
            .atoms
            .iter()
            .any(|atom| atom.kind == "constraint" && atom.statement.contains("必须先编译")),
        "{snapshot:?}"
    );
    assert!(snapshot.profile.is_none(), "{snapshot:?}");
}

/// A human correction outranks provenance: the Explorer is the one path that
/// can put an assistant-authored statement into the constitution.
#[test]
fn a_human_confirmation_promotes_an_assistant_statement() {
    let temp = tempdir().expect("tempdir");
    let store = ResearchMemoryStore::new(temp.path().join("research.sqlite3"));
    store
        .enqueue_capture(&capture(
            "project-a",
            "event-1",
            "帮我看看当前的编译流程。",
            "必须先编译再提交，不能直接删除旧的构建目录。",
        ))
        .expect("enqueue");
    store.drain_outbox(10).expect("drain");
    let atom = store
        .snapshot("project-a", 50)
        .expect("snapshot")
        .atoms
        .into_iter()
        .find(|atom| atom.kind == "constraint")
        .expect("constraint atom");

    store
        .update_atom("project-a", &atom.id, "提交前必须先本地编译通过。")
        .expect("confirm");

    let confirmed = store.snapshot("project-a", 50).expect("confirmed snapshot");
    assert!(
        confirmed
            .profile
            .as_ref()
            .is_some_and(|profile| profile.content.contains("提交前必须先本地编译通过")),
        "{confirmed:?}"
    );
}

/// Whoever phrased a fact first must not decide forever whether it can reach
/// R3. The assistant routinely says a thing one turn before the user adopts it.
#[test]
fn a_user_restatement_upgrades_an_assistant_origin() {
    let temp = tempdir().expect("tempdir");
    let store = ResearchMemoryStore::new(temp.path().join("research.sqlite3"));
    store
        .enqueue_capture(&capture(
            "project-a",
            "event-1",
            "帮我看看这批实验的记录方式。",
            "实验必须保留完整来源。",
        ))
        .expect("enqueue assistant origin");
    store.drain_outbox(10).expect("drain assistant origin");
    assert!(
        store
            .snapshot("project-a", 50)
            .expect("snapshot")
            .profile
            .is_none(),
        "assistant origin must not seed the constitution"
    );

    store
        .enqueue_capture(&capture(
            "project-a",
            "event-2",
            "实验必须保留完整来源。",
            "该约束已经记录在案。",
        ))
        .expect("enqueue user restatement");
    store.drain_outbox(10).expect("drain user restatement");

    let adopted = store.snapshot("project-a", 50).expect("adopted snapshot");
    assert!(
        adopted
            .profile
            .as_ref()
            .is_some_and(|profile| profile.content.contains("实验必须保留完整来源")),
        "{adopted:?}"
    );
}

/// Profiles are only refreshed when a project receives a turn, so the upgrade
/// has to reclassify and rebuild what is already on disk — otherwise an idle
/// project keeps injecting its old assistant-authored rules forever.
#[test]
fn the_upgrade_classifies_legacy_rows_and_rebuilds_stale_profiles() {
    let temp = tempdir().expect("tempdir");
    let path = temp.path().join("research.sqlite3");
    {
        let legacy = Connection::open(&path).expect("open legacy");
        legacy
            .execute_batch(
                "CREATE TABLE research_memory_atoms(
                   id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL,
                   statement TEXT NOT NULL, normalized_key TEXT NOT NULL, scope TEXT NOT NULL,
                   confidence_millis INTEGER NOT NULL, status TEXT NOT NULL,
                   source_session_id TEXT NOT NULL, source_event_ids TEXT NOT NULL,
                   artifact_paths TEXT NOT NULL, extractor TEXT NOT NULL,
                   created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                   valid_from TEXT, valid_until TEXT, supersedes_id TEXT,
                   deleted INTEGER NOT NULL DEFAULT 0
                 );
                 CREATE TABLE research_memory_profiles(
                   project_id TEXT PRIMARY KEY, content TEXT NOT NULL,
                   atom_ids TEXT NOT NULL, updated_at INTEGER NOT NULL
                 );
                 -- 760 is what the extractor gave assistant sentences, 860 the user's.
                 INSERT INTO research_memory_atoms VALUES(
                   'atom-assistant','project-a','constraint','助手写的：必须先编译再提交。',
                   'text:assistant','project',760,'derived','session-a','[\"event-1\"]','[]',
                   'builtin_rules_v1',1,1,'2026-08-01T00:00:00Z',NULL,NULL,0);
                 INSERT INTO research_memory_atoms VALUES(
                   'atom-user','project-a','constraint','用户说的：实验必须保留完整来源。',
                   'text:user','project',860,'derived','session-a','[\"event-2\"]','[]',
                   'builtin_rules_v1',1,1,'2026-08-01T00:00:00Z',NULL,NULL,0);
                 INSERT INTO research_memory_profiles VALUES(
                   'project-a',
                   '# Project research constitution\n\n- [constraint] 助手写的：必须先编译再提交。\n- [constraint] 用户说的：实验必须保留完整来源。',
                   '[\"atom-assistant\",\"atom-user\"]', 1);",
            )
            .expect("seed legacy rows");
    }

    let store = ResearchMemoryStore::new(&path);
    let snapshot = store.snapshot("project-a", 50).expect("snapshot");

    let profile = snapshot.profile.as_ref().expect("rebuilt profile");
    assert!(
        !profile.content.contains("助手写的"),
        "legacy assistant rule survived the rebuild: {profile:?}"
    );
    assert!(profile.content.contains("用户说的"), "{profile:?}");
    // Both rows keep their place in R1; only promotion changed.
    assert_eq!(snapshot.atoms.len(), 2, "{snapshot:?}");

    let connection = store.open().expect("open");
    let classes = connection
        .prepare("SELECT id, source_class FROM research_memory_atoms ORDER BY id")
        .expect("prepare")
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .expect("query")
        .collect::<Result<Vec<_>, _>>()
        .expect("rows");
    assert_eq!(
        classes,
        vec![
            ("atom-assistant".to_string(), "assistant_synthesis".to_string()),
            ("atom-user".to_string(), "user_asserted".to_string()),
        ]
    );
}

#[test]
fn one_sentence_becomes_one_atom_under_its_highest_standing_kind() {
    let temp = tempdir().expect("tempdir");
    let store = ResearchMemoryStore::new(temp.path().join("research.sqlite3"));
    // Trips user_preference, constraint, research_decision and experiment_result
    // at once. Storing a row per matched kind duplicated the statement and let
    // the copies compete for the same handful of R1 recall slots.
    store
        .enqueue_capture(&capture(
            "project-a",
            "event-1",
            "我偏好简洁回答，实验必须保留完整来源，所以决定采用这个结果。",
            "分析完成，指标已经列在上面。",
        ))
        .expect("enqueue");
    store.drain_outbox(10).expect("drain");

    let snapshot = store.snapshot("project-a", 50).expect("snapshot");
    let copies = snapshot
        .atoms
        .iter()
        .filter(|atom| atom.statement.contains("我偏好简洁回答"))
        .collect::<Vec<_>>();
    assert_eq!(copies.len(), 1, "{snapshot:?}");
    // The R3-eligible label has to win, because the profile query filters on
    // `kind`: losing it would silently drop the rule out of the constitution.
    assert_eq!(copies[0].kind, "user_preference", "{snapshot:?}");
}

#[test]
fn assistant_acknowledgements_never_become_atoms() {
    let temp = tempdir().expect("tempdir");
    let store = ResearchMemoryStore::new(temp.path().join("research.sqlite3"));
    store
        .enqueue_capture(&capture(
            "project-a",
            "event-1",
            "我们决定采用 gpt-5.6 作为执行模型。",
            "已记录执行模型的选择，配置也已保存。",
        ))
        .expect("enqueue");
    store.drain_outbox(10).expect("drain");

    let snapshot = store.snapshot("project-a", 50).expect("snapshot");
    assert!(
        !snapshot
            .atoms
            .iter()
            .any(|atom| atom.statement.contains("已记录")),
        "{snapshot:?}"
    );
    assert!(
        snapshot
            .atoms
            .iter()
            .any(|atom| atom.statement.contains("gpt-5.6")),
        "{snapshot:?}"
    );
}

#[test]
fn a_finding_that_ends_with_an_acknowledgement_is_still_a_finding() {
    let temp = tempdir().expect("tempdir");
    let store = ResearchMemoryStore::new(temp.path().join("research.sqlite3"));
    store
        .enqueue_capture(&capture(
            "project-a",
            "event-1",
            "跑一下这轮检索实验并汇报延迟。",
            "实验结果 p95 延迟降低到 42 ms，来源已经记录。",
        ))
        .expect("enqueue");
    store.drain_outbox(10).expect("drain");

    // The bookkeeping clause is at the end; the sentence still leads with the
    // measurement, so dropping it would lose the only evidence in the turn.
    let snapshot = store.snapshot("project-a", 50).expect("snapshot");
    assert!(
        snapshot
            .atoms
            .iter()
            .any(|atom| atom.kind == "experiment_result" && atom.statement.contains("42 ms")),
        "{snapshot:?}"
    );
}

#[test]
fn artifact_paths_are_not_classified_as_prose() {
    let temp = tempdir().expect("tempdir");
    let store = ResearchMemoryStore::new(temp.path().join("research.sqlite3"));
    store
        .enqueue_capture(&capture(
            "project-a",
            "event-1",
            "把这一轮的产物记下来供后续引用。",
            "报告保存在 ./reports/result.json。",
        ))
        .expect("enqueue");
    store.drain_outbox(10).expect("drain");

    let snapshot = store.snapshot("project-a", 50).expect("snapshot");
    let atom = snapshot
        .atoms
        .iter()
        .find(|atom| atom.statement.contains("reports/result.json"))
        .expect("artifact atom");
    // `result.json` contains the English keyword "result"; a file name is not a
    // claim about an experiment.
    assert_eq!(atom.kind, "artifact_pointer", "{snapshot:?}");
    assert_eq!(atom.artifact_paths, vec!["./reports/result.json".to_string()]);
}

#[test]
fn the_recalled_profile_carries_only_standing_user_asserted_lines() {
    let temp = tempdir().expect("tempdir");
    let store = ResearchMemoryStore::new(temp.path().join("research.sqlite3"));
    store
        .enqueue_capture(&capture(
            "project-a",
            "event-1",
            "我偏好简洁的中文回答。",
            "这一轮的分析结论已经写在上面了。",
        ))
        .expect("enqueue");
    let mut decision = capture(
        "project-a",
        "event-2",
        "我们决定采用 SQLite 作为记忆索引的存储引擎。",
        "这个选择的取舍写在上面的对比里。",
    );
    decision.occurred_at = "2026-08-11T12:00:00Z".to_string();
    store.enqueue_capture(&decision).expect("enqueue decision");
    store.drain_outbox(10).expect("drain");

    let profile = store
        .recall("project-a", "记忆索引的存储引擎", 5, 2)
        .expect("recall")
        .profile
        .expect("profile");
    assert!(profile.content.contains("user_preference"), "{profile:?}");
    // A research_decision is not standing policy: it reaches the prompt through
    // R1 when the query calls for it, and must not be injected on every turn.
    assert!(
        !profile.content.contains("research_decision"),
        "{profile:?}"
    );
}

#[test]
fn rebuild_replays_captures_but_keeps_human_decisions() {
    let temp = tempdir().expect("tempdir");
    let store = ResearchMemoryStore::new(temp.path().join("research.sqlite3"));
    store
        .enqueue_capture(&capture(
            "project-a",
            "event-1",
            "我们决定采用 SQLite 作为记忆索引的存储引擎。",
            "这个取舍写在上面的对比表里。",
        ))
        .expect("enqueue");
    let mut second = capture(
        "project-a",
        "event-2",
        "实验结果显示 p95 延迟降低到 42 ms。",
        "这一轮的曲线也一并附上了。",
    );
    second.occurred_at = "2026-08-11T12:00:00Z".to_string();
    store.enqueue_capture(&second).expect("enqueue second");
    // A plain machine-derived row that no human touches, so the replay has
    // something to actually rewrite.
    let mut third = capture(
        "project-a",
        "event-3",
        "运行环境是 Windows 11，显卡是 RTX 4090。",
        "这些参数会影响后面的批大小选择。",
    );
    third.occurred_at = "2026-08-12T12:00:00Z".to_string();
    store.enqueue_capture(&third).expect("enqueue third");
    store.drain_outbox(10).expect("drain");

    let snapshot = store.snapshot("project-a", 50).expect("snapshot");
    let corrected = snapshot
        .atoms
        .iter()
        .find(|atom| atom.statement.contains("SQLite"))
        .expect("decision atom");
    let removed = snapshot
        .atoms
        .iter()
        .find(|atom| atom.statement.contains("p95"))
        .expect("result atom");
    store
        .update_atom("project-a", &corrected.id, "决定采用 SQLite，且不再评估替代方案。")
        .expect("user correction");
    store
        .delete_atom("project-a", &removed.id)
        .expect("user deletion");

    // Pretend the surviving machine rows came from the previous rule set.
    let connection = store.open().expect("open");
    connection
        .execute(
            "UPDATE research_memory_atoms SET extractor='builtin_rules_v1'
             WHERE project_id='project-a' AND extractor<>'user'",
            [],
        )
        .expect("age the rows");
    drop(connection);
    assert!(store.stale_extractor_atoms("project-a").expect("stale") > 0);

    let outcome = store.rebuild_derived("project-a").expect("rebuild");
    assert_eq!(outcome.captures_replayed, 3, "{outcome:?}");
    assert!(outcome.atoms_preserved >= 1, "{outcome:?}");
    assert_eq!(
        store.stale_extractor_atoms("project-a").expect("stale"),
        0,
        "a replay must leave nothing on the old rule set"
    );

    let rebuilt = store.snapshot("project-a", 50).expect("rebuilt snapshot");
    // The correction the user typed is not reproducible by any extractor.
    assert!(
        rebuilt
            .atoms
            .iter()
            .any(|atom| atom.statement.contains("不再评估替代方案")
                && atom.status == "user_confirmed"),
        "{rebuilt:?}"
    );
    // A deleted atom stays deleted: the tombstone keeps the id the replay reuses.
    assert!(
        !rebuilt
            .atoms
            .iter()
            .any(|atom| atom.statement.contains("p95") && atom.status != "deleted"),
        "{rebuilt:?}"
    );
    assert!(
        store
            .search_atoms("project-a", "p95 延迟", 10)
            .expect("search")
            .iter()
            .all(|atom| !atom.statement.contains("p95")),
        "a resurrected atom must not come back through search either"
    );
}

#[test]
fn extractor_rejects_structure_requests_and_conditional_assistant_plans() {
    let temp = tempdir().expect("tempdir");
    let store = ResearchMemoryStore::new(temp.path().join("research.sqlite3"));
    store
        .enqueue_capture(&capture(
            "project-a",
            "event-1",
            "能不能先说如何修改 Physical Constraints 这一节",
            "## 编译失败的真正原因\n| 项目 | 结果 |\n|---|---|\n{\"result\":\"failed\"}\n如果需要，我可以改用另一种方案。\nmain.tex 编译失败：日志报 Undefined control sequence。",
        ))
        .expect("enqueue");
    store.drain_outbox(10).expect("drain");

    let snapshot = store.snapshot("project-a", 50).expect("snapshot");
    assert_eq!(snapshot.atoms.len(), 1, "{snapshot:?}");
    assert_eq!(snapshot.atoms[0].kind, "negative_result");
    assert!(snapshot.atoms[0]
        .statement
        .contains("Undefined control sequence"));
}

#[test]
fn artifact_parser_preserves_relative_and_spaced_paths_but_rejects_urls() {
    let paths = extract_artifact_paths(
        "See `chapters/ch2_foundations.tex`, [chapter](<G:/2-博士期间资料/0- 毕业材料/Final/ch5_sparse_extremes.tex:99>), and https://proceedings.example/paper.pdf.",
    );
    assert_eq!(
        paths,
        vec![
            "chapters/ch2_foundations.tex".to_string(),
            "G:/2-博士期间资料/0- 毕业材料/Final/ch5_sparse_extremes.tex".to_string(),
        ]
    );
}

#[test]
fn recall_indexes_the_source_question_without_polluting_the_atom_statement() {
    let temp = tempdir().expect("tempdir");
    let store = ResearchMemoryStore::new(temp.path().join("research.sqlite3"));
    store
        .enqueue_capture(&capture(
            "project-a",
            "event-1",
            "第五章 main.tex 编译失败的原因是什么？",
            "日志确认 Final/ch5_sparse_extremes.tex 报 Undefined control sequence。",
        ))
        .expect("enqueue");
    store.drain_outbox(10).expect("drain");

    let recall = store
        .recall("project-a", "第五章 main.tex 编译失败原因", 5, 2)
        .expect("recall");
    assert!(
        recall
            .atoms
            .iter()
            .any(|atom| atom.statement.contains("Undefined control sequence")),
        "{recall:?}"
    );
    assert!(recall
        .atoms
        .iter()
        .all(|atom| !atom.statement.contains("原因是什么")));
}

#[test]
fn episode_cards_are_bounded_and_exclude_assistant_process_narration() {
    let temp = tempdir().expect("tempdir");
    let store = ResearchMemoryStore::new(temp.path().join("research.sqlite3"));
    store
        .enqueue_capture(&capture(
            "project-a",
            "event-1",
            "记录这轮可复现实验的结论。",
            "我会先检查日志。实验结果 p95 延迟降低到 42 ms。报告保存在 ./reports/result.json。",
        ))
        .expect("enqueue");
    store.drain_outbox(10).expect("drain");

    let snapshot = store.snapshot("project-a", 50).expect("snapshot");
    assert_eq!(snapshot.cards.len(), 1, "{snapshot:?}");
    assert!(!snapshot.cards[0].summary.contains("我会先检查"));
    assert!(snapshot.cards[0].summary.chars().count() <= EPISODE_SUMMARY_CHAR_LIMIT);
}

#[test]
fn an_explicit_research_finding_in_an_emphasis_quote_is_recallable() {
    let temp = tempdir().expect("tempdir");
    let store = ResearchMemoryStore::new(temp.path().join("research.sqlite3"));
    store
        .enqueue_capture(&capture(
            "project-a",
            "event-1",
            "第五章最应该保留的唯一创新是什么？",
            "> Ch5 真正能立住的创新是 regime-gating 框架与 retrospective/prospective 二分。\n我先继续检查其他章节。",
        ))
        .expect("enqueue");
    store.drain_outbox(10).expect("drain");

    let recall = store
        .recall("project-a", "第五章唯一创新", 5, 2)
        .expect("recall");
    assert_eq!(recall.atoms.len(), 1, "{recall:?}");
    assert_eq!(recall.atoms[0].kind, "research_finding");
    assert!(recall.atoms[0].statement.contains("regime-gating"));
}

#[test]
fn v4_rejects_questions_placeholders_plans_drafts_and_prose_paths() {
    let temp = tempdir().expect("tempdir");
    let store = ResearchMemoryStore::new(temp.path().join("research.sqlite3"));
    store
        .enqueue_capture(&capture(
            "project-a",
            "event-noise",
            "请审查下面这些候选是否应该进入记忆？",
            "需要我把文档里的占位符补上吗？
             **落地清单**：cas-sc-new.tex 的具体修改位置（7项）
             （如果你确实没用 softplus，我们决定改用 ReLU。）
             回复前必须确认的3件事
             建议回复草稿：
             “Experimental results across 45 simulation runs show projection inactive at 0 activations.”
             实验结果：minimum UA=[x]，Qr=[a-f]。
             经验证据与理论分析一致。",
        ))
        .expect("enqueue noise");
    store.drain_outbox(10).expect("drain noise");

    let rejected = store.snapshot("project-a", 50).expect("noise snapshot");
    assert!(rejected.atoms.is_empty(), "{rejected:?}");
    assert!(rejected.cards.is_empty(), "{rejected:?}");
    assert!(rejected.profile.is_none(), "{rejected:?}");
    assert!(!contains_keyword("经验证据与理论分析一致", "经验"));
    assert!(contains_keyword("这次的经验教训是先固定随机种子", "经验"));
    assert!(
        extract_artifact_paths("落地清单**：cas-sc-new.tex 的具体修改位置（7项）").is_empty()
    );

    let mut verified = capture(
        "project-a",
        "event-verified",
        "请记录已经实际运行并落盘的结果。",
        "实测召回率提升到 92%。报告保存在 ./reports/verified.json。",
    );
    verified.occurred_at = "2026-08-11T12:00:00Z".to_string();
    store.enqueue_capture(&verified).expect("enqueue verified");
    store.drain_outbox(10).expect("drain verified");
    let accepted = store.snapshot("project-a", 50).expect("accepted snapshot");
    assert!(
        accepted
            .atoms
            .iter()
            .any(|atom| atom.kind == "experiment_result" && atom.statement.contains("92%")),
        "{accepted:?}"
    );
    assert!(
        accepted.atoms.iter().any(|atom| {
            atom.kind == "artifact_pointer"
                && atom.artifact_paths == vec!["./reports/verified.json".to_string()]
        }),
        "{accepted:?}"
    );
}

#[test]
fn runtime_rejects_workflow_sessions_before_the_outbox() {
    let temp = tempdir().expect("tempdir");
    let store = ResearchMemoryStore::new(temp.path().join("research.sqlite3"));
    let ordinary = capture(
        "project-a",
        "event-chat",
        "实验必须保留完整来源。",
        "该约束已经记录。",
    );
    let mut workflow = ordinary.clone();
    workflow.session_id = "wf-review-run-a".to_string();
    workflow.source_event_ids = vec!["event-workflow".to_string()];
    let mut bounded = ordinary.clone();
    bounded.session_id = "somni-deepseek-v4-flash-free-bounded".to_string();
    bounded.source_event_ids = vec!["event-bounded".to_string()];

    assert!(is_research_memory_session_id(&ordinary.session_id));
    assert!(!is_research_memory_session_id(&workflow.session_id));
    assert!(!is_research_memory_session_id(&bounded.session_id));
    assert_eq!(
        store
            .enqueue_captures(&[ordinary, workflow.clone(), bounded.clone()])
            .expect("enqueue mixed sessions"),
        1
    );
    assert!(!store.enqueue_capture(&workflow).expect("reject workflow"));
    assert!(!store.enqueue_capture(&bounded).expect("reject bounded"));
    assert_eq!(store.stats("project-a").expect("stats").pending_count, 1);
}

#[test]
fn legacy_pending_workflow_capture_drains_without_extraction() {
    let temp = tempdir().expect("tempdir");
    let store = ResearchMemoryStore::new(temp.path().join("research.sqlite3"));
    let mut legacy = capture(
        "project-a",
        "event-pending-workflow",
        "实验必须保留完整来源。",
        "实验结果 p95 延迟降低到 42 ms。",
    );
    legacy.session_id = "wf-review-run-pending".to_string();
    let id = capture_id(&legacy);
    let connection = store.open().expect("open");
    connection
        .execute(
            "INSERT INTO research_memory_outbox(
               id, project_id, session_id, source_event_ids, user_text,
               assistant_text, occurred_at, status, attempts, next_attempt_at,
               created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', 0, 0, ?8, ?8)",
            rusqlite::params![
                id,
                legacy.project_id,
                legacy.session_id,
                json_string(&legacy.source_event_ids).expect("events"),
                legacy.user_text,
                legacy.assistant_text,
                legacy.occurred_at,
                now_millis(),
            ],
        )
        .expect("seed legacy workflow outbox");
    drop(connection);

    assert_eq!(store.drain_outbox(10).expect("drain legacy workflow"), 1);
    let snapshot = store.snapshot("project-a", 50).expect("snapshot");
    assert!(snapshot.atoms.is_empty(), "{snapshot:?}");
    assert!(snapshot.cards.is_empty(), "{snapshot:?}");
    assert!(snapshot.profile.is_none(), "{snapshot:?}");
    assert_eq!(snapshot.stats.pending_count, 0);
}

#[test]
fn legacy_workflow_atoms_are_not_recalled_or_replayed() {
    let temp = tempdir().expect("tempdir");
    let store = ResearchMemoryStore::new(temp.path().join("research.sqlite3"));
    store
        .enqueue_capture(&capture(
            "project-a",
            "event-legacy",
            "实验必须保留完整来源。",
            "实验结果 p95 延迟降低到 42 ms。",
        ))
        .expect("enqueue legacy seed");
    store.drain_outbox(10).expect("drain legacy seed");

    let connection = store.open().expect("open");
    connection
        .execute(
            "UPDATE research_memory_outbox
             SET session_id='wf-review-run-legacy'
             WHERE project_id='project-a'",
            [],
        )
        .expect("age outbox session");
    connection
        .execute(
            "UPDATE research_memory_atoms
             SET source_session_id='wf-review-run-legacy'
             WHERE project_id='project-a'",
            [],
        )
        .expect("age atom session");
    drop(connection);

    // Governance remains able to show the legacy rows before migration.
    assert!(
        !store
            .snapshot("project-a", 50)
            .expect("governance snapshot")
            .atoms
            .is_empty()
    );
    let recall = store
        .recall("project-a", "实验完整来源 p95 延迟", 10, 5)
        .expect("isolated recall");
    assert!(recall.atoms.is_empty(), "{recall:?}");
    assert!(recall.cards.is_empty(), "{recall:?}");
    assert!(recall.profile.is_none(), "{recall:?}");

    let rebuilt = store.rebuild_derived("project-a").expect("isolated rebuild");
    assert_eq!(rebuilt.captures_replayed, 0, "{rebuilt:?}");
    assert!(rebuilt.atoms_removed > 0, "{rebuilt:?}");
    assert_eq!(rebuilt.atoms_written, 0, "{rebuilt:?}");
    let snapshot = store.snapshot("project-a", 50).expect("rebuilt snapshot");
    assert!(snapshot.atoms.is_empty(), "{snapshot:?}");
    assert!(snapshot.cards.is_empty(), "{snapshot:?}");
    assert!(snapshot.profile.is_none(), "{snapshot:?}");
}
