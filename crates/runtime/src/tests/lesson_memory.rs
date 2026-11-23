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
