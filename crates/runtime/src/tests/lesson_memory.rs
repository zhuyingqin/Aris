use super::*;
use crate::{ContentBlock, ConversationMessage, MessageRole};

fn tool_use(id: &str, name: &str, input: &str) -> ContentBlock {
    ContentBlock::ToolUse {
        id: id.to_string(),
        name: name.to_string(),
        input: input.to_string(),
    }
}

fn tool_result(id: &str, name: &str, output: &str, is_error: bool) -> ConversationMessage {
    ConversationMessage {
        role: MessageRole::Tool,
        blocks: vec![ContentBlock::ToolResult {
            tool_use_id: id.to_string(),
            tool_name: name.to_string(),
            output: output.to_string(),
            is_error,
        }],
        usage: None,
    }
}

fn gbk_turn() -> Vec<ConversationMessage> {
    vec![
        ConversationMessage::user_text("把第三章的公式导出成表格"),
        ConversationMessage::assistant(vec![tool_use(
            "call_fail",
            "REPL",
            r#"{"code":"print(open('ch3.tex').read())"}"#,
        )]),
        tool_result(
            "call_fail",
            "REPL",
            "Traceback (most recent call last):\n  File \"<string>\", line 1, in <module>\nUnicodeEncodeError: 'gbk' codec can't encode character '\\u2206' in position 17: illegal multibyte sequence",
            true,
        ),
        ConversationMessage::assistant(vec![tool_use(
            "call_fix",
            "REPL",
            r#"{"code":"import sys; sys.stdout.reconfigure(encoding='utf-8'); print(open('ch3.tex', encoding='utf-8').read())"}"#,
        )]),
        tool_result("call_fix", "REPL", "\\section{公式}", false),
        ConversationMessage::assistant(vec![ContentBlock::Text {
            text: "已导出。".to_string(),
        }]),
    ]
}

fn job(turn: LessonTurn) -> LessonJob {
    LessonJob {
        id: 1,
        project_id: "project-a".to_string(),
        session_id: "chat-a".to_string(),
        turn,
        created_at_ms: 0,
        attempts: 0,
    }
}

fn temp_store(label: &str) -> LessonStore {
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    LessonStore::new(std::env::temp_dir().join(format!("aris-lessons-{label}-{suffix}.sqlite3")))
}

#[test]
fn a_recovered_failure_qualifies_and_renders_with_its_fix() {
    let turn = lesson_turn_from_messages(&gbk_turn()).expect("recovered failure");
    assert_eq!(turn.calls.len(), 2);
    assert!(turn.calls[0].failed);
    assert!(turn.calls[0].error.contains("UnicodeEncodeError"));
    let rendered = render_lesson_turn("t1", &turn);
    assert!(rendered.contains("call_fail REPL("));
    assert!(rendered.contains("fixed by call_fix REPL("));
    assert!(rendered.contains("user: 把第三章的公式导出成表格"));
}

#[test]
fn unrecovered_failures_and_identical_retries_do_not_qualify() {
    let mut unrecovered = gbk_turn();
    unrecovered.truncate(3);
    assert!(lesson_turn_from_messages(&unrecovered).is_none());

    let flake = vec![
        ConversationMessage::user_text("编译"),
        ConversationMessage::assistant(vec![tool_use("a", "bash", r#"{"command":"make"}"#)]),
        tool_result("a", "bash", "error: resource busy", true),
        ConversationMessage::assistant(vec![tool_use("b", "bash", r#"{"command":"make"}"#)]),
        tool_result("b", "bash", "ok", false),
    ];
    assert!(lesson_turn_from_messages(&flake).is_none());
}

#[test]
fn fixing_a_file_then_rerunning_the_identical_command_is_a_recovery() {
    // The in-app shape: json.load fails on a trailing comma, the model edits
    // settings.json, then reruns the exact same command.
    let command = r#"{"command":"python -c \"import json; json.load(open('settings.json'))\""}"#;
    let messages = vec![
        ConversationMessage::user_text("把 batch_size 改成 64 并验证"),
        ConversationMessage::assistant(vec![tool_use("run1", "PowerShell", command)]),
        tool_result(
            "run1",
            "PowerShell",
            "json.decoder.JSONDecodeError: Expecting property name enclosed in double quotes: line 4 column 1 (char 37)",
            true,
        ),
        ConversationMessage::assistant(vec![tool_use(
            "edit1",
            "edit_file",
            r#"{"path":"settings.json","old_string":"0.001,\n}","new_string":"0.001\n}"}"#,
        )]),
        tool_result("edit1", "edit_file", "ok", false),
        ConversationMessage::assistant(vec![tool_use("run2", "PowerShell", command)]),
        tool_result("run2", "PowerShell", "parsed OK", false),
    ];
    let turn = lesson_turn_from_messages(&messages).expect("edit then rerun is a fix");
    let reply = "- [lesson] Python json 模块不接受尾随逗号，JSONDecodeError Expecting property name 时先删掉最后一个键后的逗号 @t1 tool:run1";
    let (accepted, rejected) = parse_lesson_reply(reply, &[job(turn)]);
    assert!(rejected.is_empty(), "{rejected:?}");
    assert_eq!(accepted[0].fix_tool_use_id.as_deref(), Some("run2"));
}

#[test]
fn last_turn_starts_at_the_last_user_text_not_at_a_tool_result() {
    let mut messages = vec![
        ConversationMessage::user_text("first"),
        ConversationMessage::assistant(vec![ContentBlock::Text {
            text: "ok".to_string(),
        }]),
    ];
    messages.extend(gbk_turn());
    let turn = last_turn_messages(&messages);
    assert_eq!(turn.len(), gbk_turn().len());
}

#[test]
fn reply_parsing_keeps_grounded_lessons_and_names_the_reason_for_each_rejection() {
    let jobs = vec![job(lesson_turn_from_messages(&gbk_turn()).expect("turn"))];
    let reply = "- [lesson] 本机 Python 默认 GBK 输出，打印含 \\u2206 的文本报 'gbk' codec can't encode：先 sys.stdout.reconfigure(encoding='utf-8') @t1 tool:call_fail\n\
                 - [lesson] 太短 @t1 tool:call_fail\n\
                 - [lesson] 引用了不存在的回合，所以应当被丢弃 @t2 tool:call_fail\n\
                 - [decision] 用户决定使用 UTF-8 @t1\n\
                 - [lesson] 成功的那次调用不是失败，不能当教训来源 @t1 tool:call_fix";
    let (accepted, rejected) = parse_lesson_reply(reply, &jobs);
    assert_eq!(accepted.len(), 1);
    assert_eq!(accepted[0].tool_use_id, "call_fail");
    assert_eq!(accepted[0].fix_tool_use_id.as_deref(), Some("call_fix"));
    let reasons: Vec<&str> = rejected.iter().map(|(_, why)| *why).collect();
    assert_eq!(reasons, vec!["too_short", "turn_ref", "format", "not_a_failure"]);
    assert!(parse_lesson_reply("NONE", &jobs).0.is_empty());
}

#[test]
fn network_failures_of_fetch_tools_are_not_lessons() {
    let messages = vec![
        ConversationMessage::user_text("下载这篇论文"),
        ConversationMessage::assistant(vec![tool_use("f1", "WebFetch", r#"{"url":"https://a.example/x"}"#)]),
        tool_result("f1", "WebFetch", "error sending request: connection reset by peer", true),
        ConversationMessage::assistant(vec![tool_use("f2", "WebFetch", r#"{"url":"https://b.example/x"}"#)]),
        tool_result("f2", "WebFetch", "ok", false),
    ];
    let jobs = vec![job(lesson_turn_from_messages(&messages).expect("turn"))];
    let (accepted, rejected) =
        parse_lesson_reply("- [lesson] a.example 连接被重置时换用 b.example 镜像下载 @t1 tool:f1", &jobs);
    assert!(accepted.is_empty());
    assert_eq!(rejected[0].1, "external");
}

#[test]
fn same_cause_merges_and_recall_finds_lessons_from_other_projects() {
    let store = temp_store("recall");
    let turn = lesson_turn_from_messages(&gbk_turn()).expect("turn");
    let first = job(turn.clone());
    let reply = "- [lesson] 本机 Python 默认 GBK 输出，打印 Unicode 字符报 'gbk' codec can't encode：先 sys.stdout.reconfigure(encoding='utf-8') @t1 tool:call_fail";
    let (drafts, _) = parse_lesson_reply(reply, std::slice::from_ref(&first));
    assert_eq!(store.insert_lessons(std::slice::from_ref(&first), &drafts).expect("insert"), 1);
    // The same cause again in the same project bumps the count.
    assert_eq!(store.insert_lessons(std::slice::from_ref(&first), &drafts).expect("insert"), 0);
    let listed = store.list(10).expect("list");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].2, 2);

    // A later failure with the same error, in another project, recalls it.
    let recalled = store
        .recall_for_failure(
            "REPL",
            r#"{"code":"print(data)"}"#,
            "Traceback (most recent call last):\nUnicodeEncodeError: 'gbk' codec can't encode character '\\u03b1' in position 3: illegal multibyte sequence",
        )
        .expect("recall");
    assert_eq!(recalled.len(), 1);
    assert_eq!(recalled[0].project_id, "project-a");
    let block = render_recalled_lessons(&recalled, "project-b");
    assert!(block.contains("another project"));
    assert!(block.contains("seen 2×"));

    // An unrelated failure, and a bare exit code, recall nothing.
    assert!(store
        .recall_for_failure("bash", r#"{"command":"latexmk main.tex"}"#, "! Undefined control sequence \\foo on line 12")
        .expect("recall")
        .is_empty());
    assert!(store
        .recall_for_failure("bash", r#"{"command":"grep x y"}"#, "exit_code:1")
        .expect("recall")
        .is_empty());
    let _ = std::fs::remove_file(store.path());
}

#[test]
fn jobs_batch_by_session_once_enough_turns_wait_or_the_oldest_is_old() {
    let store = temp_store("jobs");
    let turn = lesson_turn_from_messages(&gbk_turn()).expect("turn");
    for key in ["k1", "k2"] {
        assert!(store.enqueue_job("project-a", "chat-a", key, &turn).expect("enqueue"));
    }
    assert!(!store.enqueue_job("project-a", "chat-a", "k1", &turn).expect("dedupe"));
    let now = super::now_ms();
    assert!(store.due_batches(now, 3, 4, 15 * 60_000).expect("due").is_empty());
    assert_eq!(store.due_batches(now + 16 * 60_000, 3, 4, 15 * 60_000).expect("due")[0].len(), 2);
    store.enqueue_job("project-a", "chat-a", "k3", &turn).expect("enqueue");
    let batches = store.due_batches(now, 3, 4, 15 * 60_000).expect("due");
    assert_eq!(batches.len(), 1);
    let ids: Vec<i64> = batches[0].iter().map(|job| job.id).collect();
    store.fail_jobs(&ids, "timeout", 2).expect("fail");
    assert_eq!(store.due_batches(now, 3, 4, 15 * 60_000).expect("due").len(), 1);
    store.fail_jobs(&ids, "timeout", 2).expect("fail");
    assert!(store.due_batches(now + 99 * 60_000, 1, 4, 0).expect("due").is_empty());
    let _ = std::fs::remove_file(store.path());
}

#[test]
fn cause_keys_ignore_paths_and_numbers() {
    assert_eq!(
        cause_key("bash", "ls: cannot access 'G:/a/b/c.tex': No such file or directory"),
        cause_key("bash", "ls: cannot access 'F:/x/y.tex': No such file or directory")
    );
    assert_eq!(
        cause_key("REPL", "UnicodeEncodeError: 'gbk' codec can't encode character '\\u2206' in position 17"),
        cause_key("REPL", "UnicodeEncodeError: 'gbk' codec can't encode character '\\u2206' in position 940")
    );
}

fn call(id: &str, name: &str, input: &str, failed: bool, error: &str) -> LessonCall {
    LessonCall {
        id: id.to_string(),
        name: name.to_string(),
        input: input.to_string(),
        failed,
        error: error.to_string(),
    }
}

fn gbk_csv_turn() -> LessonTurn {
    // The in-app shape: fail, dump bytes (a probe), edit the script, rerun.
    LessonTurn {
        user: "统计 data/report.csv 每个类别的平均分".to_string(),
        assistant: "统计完成。".to_string(),
        calls: vec![
            call("run1", "PowerShell", "python -m src.report_stats", true,
                 "UnicodeDecodeError: 'utf-8' codec can't decode byte 0xb1 in position 0"),
            call("probe", "PowerShell", "[System.IO.File]::ReadAllBytes('data/report.csv')[0..3]", false, ""),
            call("edit", "edit_file", "src/report_stats.py | open(path, encoding='gbk')", false, ""),
            call("run2", "PowerShell", "python -m src.report_stats", false, ""),
        ],
    }
}

#[test]
fn the_fix_is_the_rerun_after_the_edit_not_the_probe_and_the_edit_is_shown() {
    let turn = gbk_csv_turn();
    let rendered = render_lesson_turn("t1", &turn);
    assert!(rendered.contains("then edit edit_file(src/report_stats.py | open(path, encoding='gbk'))"), "{rendered}");
    assert!(rendered.contains("fixed by run2 PowerShell(python -m src.report_stats)"), "{rendered}");
    let reply = "- [lesson] 本机中文 CSV 多为 GBK，读取报 UnicodeDecodeError 'utf-8' codec can't decode 时用 encoding='gbk' 打开 @t1 tool:run1";
    let (accepted, rejected) = parse_lesson_reply(reply, &[job(turn)]);
    assert!(rejected.is_empty(), "{rejected:?}");
    assert_eq!(accepted[0].fix_tool_use_id.as_deref(), Some("run2"));
}

#[test]
fn among_different_inputs_the_closest_to_the_failed_call_is_the_fix() {
    let turn = LessonTurn {
        user: "跑一下评估".to_string(),
        assistant: String::new(),
        calls: vec![
            call("run1", "bash", "python src/run_eval.py", true, "ModuleNotFoundError: No module named 'src'"),
            call("probe", "bash", "ls src", false, ""),
            call("run2", "bash", "python -m src.run_eval", false, ""),
        ],
    };
    let rendered = render_lesson_turn("t1", &turn);
    assert!(rendered.contains("fixed by run2 bash(python -m src.run_eval)"), "{rendered}");
}

#[test]
fn generic_advice_that_names_neither_the_error_nor_the_fix_is_rejected() {
    let reply = "- [lesson] 遇到报错时先仔细检查脚本再重新运行一次即可解决问题 @t1 tool:run1";
    let (accepted, rejected) = parse_lesson_reply(reply, &[job(gbk_csv_turn())]);
    assert!(accepted.is_empty());
    assert_eq!(rejected[0].1, "ungrounded");
}

#[test]
fn a_small_store_needs_more_overlap_before_attaching_a_lesson() {
    let store = temp_store("small-floor");
    let turn = gbk_csv_turn();
    let drafts = vec![
        LessonDraft {
            job_index: 0,
            statement: "读 CSV 报 UnicodeDecodeError 'utf-8' codec can't decode：文件是 GBK，用 encoding='gbk' 打开".to_string(),
            tool: "PowerShell".to_string(),
            tool_use_id: "run1".to_string(),
            fix_tool_use_id: Some("run2".to_string()),
            cause_key: "gbk".to_string(),
        },
        LessonDraft {
            job_index: 0,
            statement: "json.load 报 Expecting property name enclosed in double quotes：删掉最后一个键后的逗号".to_string(),
            tool: "PowerShell".to_string(),
            tool_use_id: "run1".to_string(),
            fix_tool_use_id: Some("run2".to_string()),
            cause_key: "json".to_string(),
        },
    ];
    store.insert_lessons(&[job(turn)], &drafts).expect("insert");
    // A traceback that shares only generic words ("line", "file") with the
    // JSON lesson must not drag it in.
    let output = "Traceback (most recent call last):\n  File \"<string>\", line 1, in <module>\nUnicodeDecodeError: 'utf-8' codec can't decode byte 0xb1 in position 0: invalid start byte";
    let recalled = store
        .recall_for_failure("PowerShell", r#"{"command":"python stats.py"}"#, output)
        .expect("recall");
    assert_eq!(recalled.len(), 1, "{recalled:?}");
    assert!(recalled[0].statement.contains("GBK"));
    let _ = std::fs::remove_file(store.path());
}

fn lesson_draft(statement: &str, cause: &str) -> LessonDraft {
    LessonDraft {
        job_index: 0,
        statement: statement.to_string(),
        tool: "PowerShell".to_string(),
        tool_use_id: "run1".to_string(),
        fix_tool_use_id: Some("run2".to_string()),
        cause_key: cause.to_string(),
    }
}

fn job_in(session_id: &str) -> LessonJob {
    LessonJob {
        session_id: session_id.to_string(),
        ..job(gbk_csv_turn())
    }
}

const GBK_LESSON: &str = "读 CSV 报 UnicodeDecodeError 'utf-8' codec can't decode：文件是 GBK，用 encoding='gbk' 打开";
const GBK_OUTPUT: &str = "UnicodeDecodeError: 'utf-8' codec can't decode byte 0xb1 in position 0: invalid start byte";

#[test]
fn an_older_store_gains_the_new_columns_and_its_lessons_get_a_source() {
    let store = temp_store("migrate");
    {
        let connection = Connection::open(store.path()).expect("open");
        connection
            .execute_batch(
                "CREATE TABLE lessons(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL,
                   tool TEXT NOT NULL, tool_use_id TEXT NOT NULL, fix_tool_use_id TEXT, statement TEXT NOT NULL,
                   cause_key TEXT NOT NULL, seen INTEGER NOT NULL DEFAULT 1, first_seen_at INTEGER NOT NULL,
                   last_seen_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active');
                 CREATE TABLE lesson_jobs(id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL,
                   session_id TEXT NOT NULL, turn_key TEXT NOT NULL UNIQUE, turn_json TEXT NOT NULL,
                   created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
                   last_error TEXT);
                 INSERT INTO lessons VALUES ('lesson_old', 'p', 'chat-old', 'bash', 't', NULL, 'old lesson text', 'k', 1, 1, 1, 'active');",
            )
            .expect("v1 schema");
    }
    let views = store.list_views(10).expect("list");
    assert_eq!(views.len(), 1);
    assert_eq!((views[0].recalled, views[0].sources), (0, 1));
    let _ = std::fs::remove_file(store.path());
}

#[test]
fn deleting_every_chat_that_taught_a_lesson_deletes_it_and_one_of_two_keeps_it() {
    let store = temp_store("forget");
    store
        .insert_lessons(&[job_in("chat-a")], &[lesson_draft(GBK_LESSON, "gbk")])
        .expect("first");
    // The same cause learned again in another chat merges as a second source.
    store
        .insert_lessons(&[job_in("chat-b")], &[lesson_draft(GBK_LESSON, "gbk")])
        .expect("second");
    store.enqueue_job("project-a", "chat-a", "chat-a:t9", &gbk_csv_turn()).expect("job");

    assert_eq!(store.forget_session("chat-a").expect("forget a"), 0);
    let views = store.list_views(10).expect("list");
    assert_eq!((views.len(), views[0].sources), (1, 1));
    assert!(store.due_batches(i64::MAX, 1, 4, 0).expect("jobs").is_empty(), "chat-a's queued turn is gone");

    assert_eq!(store.forget_session("chat-b").expect("forget b"), 1);
    assert!(store.list_views(10).expect("list").is_empty());
    assert!(store.recall_for_failure("PowerShell", "{}", GBK_OUTPUT).expect("recall").is_empty());

    let missing = LessonStore::new(std::env::temp_dir().join("aris-lessons-never-created.sqlite3"));
    assert_eq!(missing.forget_session("chat-x").expect("no store"), 0);
    assert!(!missing.path().exists());
    let _ = std::fs::remove_file(store.path());
}

#[test]
fn two_unhelpful_deliveries_in_a_row_make_a_lesson_stale_and_a_fix_resets_the_streak() {
    let store = temp_store("stale");
    store
        .insert_lessons(&[job_in("chat-a")], &[lesson_draft(GBK_LESSON, "gbk")])
        .expect("insert");
    let id = store.list_views(1).expect("list")[0].id.clone();
    let ids = vec![id.clone()];

    store.record_recalled(&ids).expect("recalled");
    store.record_outcome(&ids, false).expect("unhelpful once");
    store.record_outcome(&ids, true).expect("then it helped");
    store.record_outcome(&ids, false).expect("unhelpful again");
    assert_eq!(store.list_views(1).expect("list")[0].status, "active");
    assert_eq!(store.list_views(1).expect("list")[0].recalled, 1);

    store.record_outcome(&ids, false).expect("second in a row");
    assert_eq!(store.list_views(1).expect("list")[0].status, "stale");
    assert!(store.recall_for_failure("PowerShell", "{}", GBK_OUTPUT).expect("recall").is_empty());

    // Turning it back on in Settings makes it recallable again.
    assert!(store.set_status(&id, true).expect("reactivate"));
    assert_eq!(store.recall_for_failure("PowerShell", "{}", GBK_OUTPUT).expect("recall").len(), 1);
    let _ = std::fs::remove_file(store.path());
}

#[test]
fn cleanup_applies_the_retention_rules() {
    let store = temp_store("cleanup");
    store
        .insert_lessons(
            &[job_in("chat-a")],
            &[
                lesson_draft(GBK_LESSON, "gbk"),
                lesson_draft("json.load 报 Expecting property name：删掉最后一个键后的逗号", "json"),
                lesson_draft("ModuleNotFoundError: No module named 'src'：用 python -m src.x 运行", "module"),
            ],
        )
        .expect("insert");
    store.enqueue_job("project-a", "chat-a", "chat-a:done", &gbk_csv_turn()).expect("job");
    let now = now_ms();
    let day = DAY_MS;
    {
        let connection = store.open().expect("open");
        connection.execute("UPDATE lesson_jobs SET status = 'done', finished_at = ?1", [now - 8 * day]).expect("old job");
        connection
            .execute("UPDATE lessons SET status = 'stale', status_changed_at = ?1 WHERE cause_key = 'json'", [now - 91 * day])
            .expect("old stale");
        connection
            .execute(
                "UPDATE lessons SET last_seen_at = ?1, last_recalled_at = ?1 WHERE cause_key = 'module'",
                [now - 181 * day],
            )
            .expect("unused");
    }
    let report = store.cleanup(now).expect("cleanup");
    assert_eq!(
        report,
        LessonCleanup { jobs_deleted: 1, stale_deleted: 1, archived_unused: 1, archived_over_cap: 0 }
    );
    let views = store.list_views(10).expect("list");
    let status = |needle: &str| views.iter().find(|view| view.statement.contains(needle)).map(|view| view.status.clone());
    assert_eq!(status("GBK").as_deref(), Some("active"));
    assert_eq!(status("ModuleNotFoundError").as_deref(), Some("archived"));
    assert_eq!(status("json.load"), None);
    // A second pass changes nothing.
    assert_eq!(store.cleanup(now).expect("again"), LessonCleanup::default());
    let _ = std::fs::remove_file(store.path());
}

#[test]
fn only_failures_fixed_in_the_turn_count_as_fixed() {
    let mut messages = gbk_turn();
    let fixed = fixed_failure_ids(&messages);
    assert_eq!(fixed.into_iter().collect::<Vec<_>>(), vec!["call_fail".to_string()]);
    messages.truncate(3);
    assert!(fixed_failure_ids(&messages).is_empty());
}

#[test]
fn error_classes_group_failures_by_kind() {
    assert_eq!(error_class("/usr/bin/bash: line 1: rg: command not found\nexit_code:127"), "command_missing");
    assert_eq!(error_class("ls: cannot access 'target': No such file or directory"), "path_missing");
    assert_eq!(error_class("UnicodeDecodeError: 'utf-8' codec can't decode byte 0xb1"), "encoding");
    assert_eq!(error_class("edit 3: old_string not found in file"), "edit_mismatch");
    assert_eq!(error_class("ValueError: too many values to unpack (expected 2)"), "python_exception");
    assert_eq!(error_class("exit_code:1"), "");
}

#[test]
fn the_desktop_recovery_hint_is_not_part_of_the_error() {
    let output = "old_string not found in file\n\nRecovery hint: Use the error message to adjust the next step.";
    assert_eq!(key_error_lines(output, 3), vec!["old_string not found in file".to_string()]);
}

#[test]
fn paths_and_stock_wording_are_not_evidence() {
    assert_eq!(
        without_paths("python: can't open file 'G:/2-博士期间资料/0- 毕业材料/x.py': [Errno 2]"),
        "python: can't open file [Errno 2]"
    );
    let stripped = without_stock_wording("FileNotFoundError: No such file or directory; ls failed");
    assert!(stripped.contains("filenotfounderror"), "{stripped}");
    assert!(!stripped.contains("no such file"), "{stripped}");
    assert!(!stripped.contains("failed"), "{stripped}");
}

fn insert_lesson(store: &LessonStore, statement: &str, tool: &str, error: &str) {
    let draft = LessonDraft {
        job_index: 0,
        statement: statement.to_string(),
        tool: tool.to_string(),
        tool_use_id: format!("src-{}", statement.len()),
        fix_tool_use_id: None,
        cause_key: cause_key(tool, error),
    };
    store.insert_lessons(&[job(gbk_csv_turn())], &[draft]).expect("insert");
}

#[test]
fn a_shared_path_alone_does_not_attach_a_lesson_but_one_specific_word_can() {
    let store = temp_store("evidence");
    insert_lesson(
        &store,
        "本机 bash 没有 ripgrep：`rg` 报 command not found，改用 grep -rn",
        "bash",
        "/usr/bin/bash: line 1: rg: command not found",
    );
    insert_lesson(
        &store,
        "项目根是 G:/2-博士期间资料/0- 毕业材料（0- 后有空格），cd 前先 pwd 确认",
        "bash",
        "cd: G:/2-博士期间资料/0-毕业材料: No such file or directory",
    );
    insert_lesson(
        &store,
        "PowerShell 读 GBK 文件乱码：Get-Content 加 -Encoding UTF8",
        "PowerShell",
        "UnicodeDecodeError: 'gbk' codec can't decode",
    );

    // Only `rg` is left once the bash prefix and the stock wording go; it is shared.
    let found = store
        .recall_for_failure("bash", r#"{"command":"rg -n foo src"}"#, "/usr/bin/bash: line 1: rg: command not found\nexit_code:127")
        .expect("recall");
    assert_eq!(found.len(), 1, "{found:?}");
    assert!(found[0].statement.contains("ripgrep"));
    // Another missing program shares only the stock wording.
    assert!(store
        .recall_for_failure("bash", r#"{"command":"head -5 x"}"#, "/usr/bin/bash: line 1: head: command not found\nexit_code:127")
        .expect("recall")
        .is_empty());

    // A failure under the same project root shares only path pieces.
    let output = "python: can't open file 'G:/2-博士期间资料/0- 毕业材料/x.py': [Errno 2] No such file or directory";
    let input = r#"{"command":"python x.py"}"#;
    assert!(store.recall_for_failure("bash", input, output).expect("recall").is_empty());
    let off = LessonGates {
        error_class: false,
        ignore_paths: false,
        ignore_stock_wording: false,
        min_shared: LESSON_RECALL_MIN_SHARED,
    };
    let unguarded = store.recall_for_failure_gated("bash", input, output, off).expect("recall");
    assert!(unguarded.iter().any(|lesson| lesson.statement.contains("项目根")), "{unguarded:?}");
    let _ = std::fs::remove_file(store.path());
}

#[test]
fn a_v2_store_gets_the_error_kind_of_its_lessons_from_their_cause_keys() {
    let store = temp_store("migrate-v3");
    {
        let connection = Connection::open(store.path()).expect("open");
        connection
            .execute_batch(
                "CREATE TABLE lessons(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL,
                   tool TEXT NOT NULL, tool_use_id TEXT NOT NULL, fix_tool_use_id TEXT, statement TEXT NOT NULL,
                   cause_key TEXT NOT NULL, seen INTEGER NOT NULL DEFAULT 1, first_seen_at INTEGER NOT NULL,
                   last_seen_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active',
                   recalled INTEGER NOT NULL DEFAULT 0, last_recalled_at INTEGER NOT NULL DEFAULT 0,
                   unhelpful INTEGER NOT NULL DEFAULT 0, status_changed_at INTEGER NOT NULL DEFAULT 0);
                 CREATE TABLE lesson_jobs(id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL,
                   session_id TEXT NOT NULL, turn_key TEXT NOT NULL UNIQUE, turn_json TEXT NOT NULL,
                   created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
                   last_error TEXT, finished_at INTEGER NOT NULL DEFAULT 0);
                 CREATE TABLE lesson_sources(lesson_id TEXT NOT NULL, session_id TEXT NOT NULL,
                   PRIMARY KEY(lesson_id, session_id));
                 INSERT INTO lessons(id, project_id, session_id, tool, tool_use_id, statement, cause_key,
                   first_seen_at, last_seen_at)
                   VALUES ('lesson_v2', 'p', 'chat-old', 'bash', 't', 'old', 'bash | rg: command not found', 1, 1);
                 PRAGMA user_version = 2;",
            )
            .expect("v2 schema");
    }
    assert_eq!(store.list_views(10).expect("list").len(), 1);
    let connection = Connection::open(store.path()).expect("open");
    let (kind, version): (String, i64) = connection
        .query_row(
            "SELECT error_class, (SELECT user_version FROM pragma_user_version) FROM lessons WHERE id = 'lesson_v2'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("row");
    assert_eq!((kind.as_str(), version), ("command_missing", 3));
    drop(connection);
    let _ = std::fs::remove_file(store.path());
}
