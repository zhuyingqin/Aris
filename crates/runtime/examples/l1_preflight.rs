//! L1 preflight: check the memory-L1 design's assumptions against the real
//! runtime code before any L1 code exists.
//!
//! Usage: l1_preflight <sessions_copy_dir> <scratch_dir>
//!
//! `sessions_copy_dir` must be a *copy* of a project's sessions directory:
//! loading takes path locks next to the files. Nothing outside the two
//! directories is touched.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use rusqlite::Connection;
use runtime::{compact_session_event_log, Session};
use serde_json::{json, Value};

fn main() {
    let arguments = env::args().collect::<Vec<_>>();
    if arguments.len() != 3 {
        eprintln!("Usage: l1_preflight <sessions_copy_dir> <scratch_dir>");
        std::process::exit(2);
    }
    let sessions_dir = PathBuf::from(&arguments[1]);
    let scratch_dir = PathBuf::from(&arguments[2]);
    fs::create_dir_all(&scratch_dir).expect("create scratch dir");

    println!("== sqlite ==");
    if let Err(error) = sqlite_checks() {
        println!("FAILED: {error}");
    }
    println!("\n== replay baseline ==");
    let probe_candidate = replay_baseline(&sessions_dir);
    println!("\n== downgrade probe ==");
    match probe_candidate {
        Some(manifest) => {
            if let Err(error) = downgrade_probe(&manifest, &scratch_dir) {
                println!("FAILED: {error}");
            }
        }
        None => println!("no session with compactions to probe"),
    }
}

fn check(label: &str, ok: bool, detail: impl std::fmt::Display) {
    println!("[{}] {label}: {detail}", if ok { "ok" } else { "MISMATCH" });
}

fn count(conn: &Connection, sql: &str) -> Result<i64, String> {
    conn.query_row(sql, [], |row| row.get::<_, i64>(0))
        .map_err(|error| error.to_string())
}

fn sqlite_checks() -> Result<(), String> {
    let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
    let version: String = conn
        .query_row("SELECT sqlite_version()", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    check("bundled SQLite version", version.as_str() >= "3.43.0", &version);

    conn.execute_batch(
        "CREATE VIRTUAL TABLE t USING fts5(content, tokenize='trigram');
         INSERT INTO t(rowid, content) VALUES (1, '项目采用 SQLite'), (2, 'Final/main.aux 损坏后重编'), (3, '第五章标题从 ESN 上抬为 RC');",
    )
    .map_err(|e| e.to_string())?;

    let bare = count(&conn, "SELECT count(*) FROM t WHERE t MATCH '项目采用什么数据库'")?;
    check("trigram: bare CJK phrase is a whole-phrase match (design expects 0 hits)", bare == 0, bare);
    let or_trigrams = count(
        &conn,
        "SELECT count(*) FROM t WHERE t MATCH '\"项目采\" OR \"目采用\" OR \"数据库\"'",
    )?;
    check("trigram: quoted trigram OR finds it (expects 1)", or_trigrams == 1, or_trigrams);
    let unquoted = conn.query_row("SELECT count(*) FROM t WHERE t MATCH 'main.aux'", [], |row| {
        row.get::<_, i64>(0)
    });
    check(
        "trigram: unquoted main.aux is a syntax error (design expects error)",
        unquoted.is_err(),
        match &unquoted {
            Ok(n) => format!("returned {n}"),
            Err(error) => error.to_string(),
        },
    );
    let quoted = count(&conn, "SELECT count(*) FROM t WHERE t MATCH '\"main.aux\"'")?;
    check("trigram: quoted main.aux matches (expects 1)", quoted == 1, quoted);
    let two_char = count(&conn, "SELECT count(*) FROM t WHERE t MATCH '\"上抬\"'")?;
    check("trigram: two-character term cannot match (expects 0)", two_char == 0, two_char);

    // Bigram shadow table as designed in §6.1.
    conn.execute_batch(
        "CREATE VIRTUAL TABLE b USING fts5(content, content='', contentless_delete=1, tokenize='unicode61');
         INSERT INTO b(rowid, content) VALUES (3, ' 第五 五章 章标 标题 题从 ESN 上抬 抬为 RC ');",
    )
    .map_err(|e| format!("contentless_delete=1 table: {e}"))?;
    let bigram = count(&conn, "SELECT count(*) FROM b WHERE b MATCH '\"上抬\"'")?;
    check("bigram: two-character CJK term matches (expects 1)", bigram == 1, bigram);
    let ascii_prefix = count(&conn, "SELECT count(*) FROM b WHERE b MATCH '\"rc\"*'")?;
    check("bigram: short ASCII prefix query matches (expects 1)", ascii_prefix == 1, ascii_prefix);
    conn.execute("DELETE FROM b WHERE rowid = 3", [])
        .map_err(|e| format!("delete from contentless_delete table: {e}"))?;
    let after_delete = count(&conn, "SELECT count(*) FROM b WHERE b MATCH '\"上抬\"'")?;
    check("bigram: delete by rowid removes the row (expects 0)", after_delete == 0, after_delete);

    conn.execute_batch(
        "CREATE VIRTUAL TABLE plain USING fts5(content, content='', tokenize='unicode61');
         INSERT INTO plain(rowid, content) VALUES (1, ' 上抬 ');",
    )
    .map_err(|e| e.to_string())?;
    let plain_delete = conn.execute("DELETE FROM plain WHERE rowid = 1", []);
    check(
        "plain contentless table rejects DELETE (so contentless_delete=1 is required)",
        plain_delete.is_err(),
        match plain_delete {
            Ok(n) => format!("deleted {n}"),
            Err(error) => error.to_string(),
        },
    );
    Ok(())
}

/// Load every session in the copy with today's loader. Returns the session
/// with the most compactions as the downgrade-probe subject.
fn replay_baseline(sessions_dir: &Path) -> Option<PathBuf> {
    let mut manifests = fs::read_dir(sessions_dir)
        .expect("read sessions dir")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension().is_some_and(|ext| ext == "json")
                && path.with_extension("events.jsonl").exists()
        })
        .collect::<Vec<_>>();
    manifests.sort();
    let started = Instant::now();
    let (mut ok, mut failed) = (0usize, 0usize);
    let (mut messages, mut logical, mut compactions) = (0usize, 0usize, 0usize);
    let mut slowest = (0u128, String::new());
    let mut best: Option<(usize, usize, PathBuf)> = None;
    for manifest in &manifests {
        let one = Instant::now();
        match Session::load_from_path(manifest) {
            Ok(session) => {
                ok += 1;
                messages += session.messages.len();
                logical += session.logical_message_count();
                compactions += session.compactions.len();
                let size = fs::metadata(manifest.with_extension("events.jsonl"))
                    .map(|meta| meta.len() as usize)
                    .unwrap_or(usize::MAX);
                // Prefer a session that has compactions and a modest log, so
                // the probe exercises archives without a 100 MB rewrite.
                if !session.compactions.is_empty() && size < 20_000_000 {
                    let better = best
                        .as_ref()
                        .is_none_or(|(c, s, _)| session.compactions.len() > *c || (session.compactions.len() == *c && size < *s));
                    if better {
                        best = Some((session.compactions.len(), size, manifest.clone()));
                    }
                }
            }
            Err(error) => {
                failed += 1;
                println!("load failed: {} ({error})", manifest.display());
            }
        }
        let elapsed = one.elapsed().as_millis();
        if elapsed > slowest.0 {
            slowest = (elapsed, manifest.file_name().unwrap().to_string_lossy().into_owned());
        }
    }
    println!(
        "sessions loaded: {ok} ok, {failed} failed; active messages {messages}, logical messages {logical}, compaction records {compactions}"
    );
    println!(
        "total {} ms, slowest {} ms ({})",
        started.elapsed().as_millis(),
        slowest.0,
        slowest.1
    );
    best.map(|(_, _, path)| path)
}

fn read_lines(path: &Path) -> Vec<String> {
    fs::read_to_string(path)
        .expect("read event log")
        .lines()
        .map(str::to_owned)
        .collect()
}

fn kind_count(lines: &[String], kind: &str) -> usize {
    let needle = format!("\"kind\":\"{kind}\"");
    lines.iter().filter(|line| line.contains(&needle)).count()
}

/// Simulate: the L1 build wrote turn ids and the two new event kinds, then an
/// older build (today's code) loads, saves, and checkpoints the session.
fn downgrade_probe(manifest: &Path, scratch_dir: &Path) -> Result<(), String> {
    let name = manifest.file_name().unwrap().to_string_lossy().into_owned();
    let probe_manifest = scratch_dir.join(&name);
    let probe_log = probe_manifest.with_extension("events.jsonl");
    fs::copy(manifest, &probe_manifest).map_err(|e| e.to_string())?;
    fs::copy(manifest.with_extension("events.jsonl"), &probe_log).map_err(|e| e.to_string())?;
    println!("subject: {name}");

    let baseline = Session::load_from_path(&probe_manifest).map_err(|e| e.to_string())?;

    // 1. Write what the L1 build would add.
    let mut max_seq = 0u64;
    let mut tagged = 0usize;
    let mut rewritten = Vec::new();
    for line in read_lines(&probe_log) {
        let Ok(mut entry) = serde_json::from_str::<Value>(&line) else {
            rewritten.push(line);
            continue;
        };
        max_seq = max_seq.max(entry.get("seq").and_then(Value::as_u64).unwrap_or(0));
        if entry.get("kind").and_then(Value::as_str) == Some("session_message") {
            if let Some(message) = entry.pointer_mut("/payload/message").and_then(Value::as_object_mut) {
                message.insert("turn_id".into(), json!(format!("turn-probe-{tagged}")));
                tagged += 1;
            }
        }
        rewritten.push(entry.to_string());
    }
    let session_id = name.trim_end_matches(".json");
    let event = |seq: u64, kind: &str, payload: Value| {
        json!({"version": 1, "seq": seq, "ts": 0, "sessionId": session_id, "kind": kind, "payload": payload})
            .to_string()
    };
    rewritten.push(event(max_seq + 1, "session_turn", json!({"turn_id": "turn-probe-x", "state": "completed"})));
    rewritten.push(event(max_seq + 2, "session_memory_state", json!({"memory_flush": {"cursor_turn_id": "turn-probe-x"}})));
    rewritten.push(event(max_seq + 3, "agent.memory_state", json!({"memory_flush": {"cursor_turn_id": "turn-probe-x"}})));
    rewritten.push(event(max_seq + 4, "assistant_delta", json!({"text": "streaming row"})));
    fs::write(&probe_log, rewritten.join("\n") + "\n").map_err(|e| e.to_string())?;
    println!("tagged {tagged} session_message rows with turn_id; appended session_turn, session_memory_state, agent.memory_state, assistant_delta");

    // 2. Today's loader must still restore the same conversation.
    let loaded = Session::load_from_path(&probe_manifest).map_err(|e| e.to_string())?;
    check(
        "old loader ignores turn_id and new kinds (same logical messages)",
        loaded.logical_message_count() == baseline.logical_message_count() && loaded.messages == baseline.messages,
        format!("{} vs {}", loaded.logical_message_count(), baseline.logical_message_count()),
    );

    // 3. Today's save: append-only or a full rewrite that drops turn_id?
    loaded.save_to_path(&probe_manifest).map_err(|e| e.to_string())?;
    let after_save = read_lines(&probe_log);
    let turn_ids_after_save = after_save.iter().filter(|line| line.contains("\"turn_id\":\"turn-probe-")).count();
    check(
        "old save keeps turn_id on messages",
        turn_ids_after_save >= tagged,
        format!("{turn_ids_after_save} rows still carry turn_id (tagged {tagged}); session_reset rows: {}", kind_count(&after_save, "session_reset")),
    );

    // 4. Today's end-of-turn checkpoint followed by log cleanup.
    let mut lines = after_save;
    lines.push(event(max_seq + 50, "session_checkpoint", json!({"storage": "event_log"})));
    fs::write(&probe_log, lines.join("\n") + "\n").map_err(|e| e.to_string())?;
    let compaction = compact_session_event_log(&probe_log).map_err(|e| e.to_string())?;
    let after_cleanup = read_lines(&probe_log);
    println!("cleanup: {compaction:?}");
    let survived = |kind: &str| kind_count(&after_cleanup, kind);
    check(
        "session_turn survives old checkpoint cleanup",
        survived("session_turn") == 1,
        format!("{} row(s) left", survived("session_turn")),
    );
    check(
        "session_memory_state survives old checkpoint cleanup",
        survived("session_memory_state") == 1,
        format!("{} row(s) left", survived("session_memory_state")),
    );
    check(
        "agent.* kinds survive old checkpoint cleanup",
        survived("agent.memory_state") == 1,
        format!("{} row(s) left", survived("agent.memory_state")),
    );
    check(
        "streaming rows before the checkpoint are removed (control)",
        survived("assistant_delta") == 0,
        format!("{} row(s) left", survived("assistant_delta")),
    );
    let turn_ids_after_cleanup = after_cleanup.iter().filter(|line| line.contains("\"turn_id\":\"turn-probe-")).count();
    check(
        "turn_id on canonical message rows survives cleanup",
        turn_ids_after_cleanup >= tagged,
        format!("{turn_ids_after_cleanup} rows"),
    );
    let live_message_rows = kind_count(&after_cleanup, "session_message");
    let live_tagged = after_cleanup
        .iter()
        .filter(|line| line.contains("\"kind\":\"session_message\"") && line.contains("\"turn_id\":\"turn-probe-"))
        .count();
    check(
        "every surviving session_message row still carries turn_id",
        live_message_rows == live_tagged,
        format!("{live_tagged}/{live_message_rows} rows"),
    );
    let reloaded = Session::load_from_path(&probe_manifest).map_err(|e| e.to_string())?;
    check(
        "session still loads after cleanup",
        reloaded.logical_message_count() == baseline.logical_message_count(),
        reloaded.logical_message_count(),
    );

    // 5. An old build that must rewrite the log (a rewind here) re-serialises
    // messages from its own type, which has no turn_id.
    let mut rewound = reloaded;
    rewound.messages.pop();
    rewound.save_to_path(&probe_manifest).map_err(|e| e.to_string())?;
    let after_rewrite = read_lines(&probe_log);
    let last_reset = after_rewrite
        .iter()
        .rposition(|line| line.contains("\"kind\":\"session_reset\""))
        .unwrap_or(0);
    let new_generation = &after_rewrite[last_reset..];
    let gen_rows = kind_count(new_generation, "session_message");
    let gen_tagged = new_generation
        .iter()
        .filter(|line| line.contains("\"kind\":\"session_message\"") && line.contains("\"turn_id\":\"turn-probe-"))
        .count();
    check(
        "turn_id survives an old-build rewrite",
        gen_rows > 0 && gen_tagged == gen_rows,
        format!("{gen_tagged}/{gen_rows} message rows in the new generation keep turn_id"),
    );
    Ok(())
}
