use std::ffi::{OsStr, OsString};
use std::io::Write;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use encoding_rs::{GB18030, GBK};
use flate2::{write::ZlibEncoder, Compression};

use super::{
    append_file, display_path, edit_file, glob_search, grep_search, read_file, write_file,
    FileChange, GrepSearchInput, MAX_READ_FILE_CONTENT_CHARS, READONLY_ROOTS_ENV,
};

struct EnvGuard {
    key: &'static str,
    previous: Option<OsString>,
}

impl EnvGuard {
    fn unset(key: &'static str) -> Self {
        let previous = std::env::var_os(key);
        std::env::remove_var(key);
        Self { key, previous }
    }

    fn set(key: &'static str, value: impl AsRef<OsStr>) -> Self {
        let previous = std::env::var_os(key);
        std::env::set_var(key, value);
        Self { key, previous }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        if let Some(previous) = self.previous.as_ref() {
            std::env::set_var(self.key, previous);
        } else {
            std::env::remove_var(self.key);
        }
    }
}

fn temp_path(name: &str) -> std::path::PathBuf {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time should move forward")
        .as_nanos();
    std::env::temp_dir().join(format!("clawd-native-{name}-{unique}"))
}

fn zlib_bytes(data: &[u8]) -> Vec<u8> {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(data).expect("write compressed stream");
    encoder.finish().expect("finish compressed stream")
}

fn pdf_with_streams(streams: &[(&str, Vec<u8>)]) -> Vec<u8> {
    let mut pdf = b"%PDF-1.4\n".to_vec();
    for (index, (dict_extra, data)) in streams.iter().enumerate() {
        pdf.extend_from_slice(
            format!(
                "{} 0 obj\n<< /Length {}{} >>\nstream\n",
                index + 1,
                data.len(),
                dict_extra
            )
            .as_bytes(),
        );
        pdf.extend_from_slice(data);
        pdf.extend_from_slice(b"\nendstream\nendobj\n");
    }
    pdf.extend_from_slice(b"%%EOF\n");
    pdf
}

#[test]
fn reads_and_writes_files() {
    let _lock = crate::test_env_lock();
    let _env = EnvGuard::unset("ARIS_WORKSPACE_ROOT");
    let path = temp_path("read-write.txt");
    let write_output = write_file(path.to_string_lossy().as_ref(), "one\ntwo\nthree")
        .expect("write should succeed");
    assert_eq!(write_output.kind, "create");
    assert!(matches!(
        write_output.changes.get(&write_output.file_path),
        Some(FileChange::Add { content }) if content == "one\ntwo\nthree"
    ));

    let read_output =
        read_file(path.to_string_lossy().as_ref(), Some(1), Some(1)).expect("read should succeed");
    assert_eq!(read_output.file.content, "two");
}

#[test]
fn reads_gbk_text_files() {
    let _lock = crate::test_env_lock();
    let _env = EnvGuard::unset("ARIS_WORKSPACE_ROOT");
    let path = temp_path("gbk.txt");
    let expected = "中文 research notes";
    let (bytes, _, had_errors) = GBK.encode(expected);
    assert!(!had_errors);
    std::fs::write(&path, bytes).expect("write GBK text");

    let output = read_file(path.to_string_lossy().as_ref(), None, None).expect("read GBK text");
    assert_eq!(output.file.content, expected);
}

#[test]
fn reads_gb18030_text_files() {
    let _lock = crate::test_env_lock();
    let _env = EnvGuard::unset("ARIS_WORKSPACE_ROOT");
    let path = temp_path("gb18030.txt");
    let expected = "𠀀 research notes";
    let (bytes, _, had_errors) = GB18030.encode(expected);
    assert!(!had_errors);
    std::fs::write(&path, bytes).expect("write GB18030 text");

    let output = read_file(path.to_string_lossy().as_ref(), None, None).expect("read GB18030 text");
    assert_eq!(output.file.content, expected);
}

#[test]
fn decode_process_text_falls_back_to_gbk_for_cp936_subprocess_output() {
    let expected = "中文 REPL 输出";
    let (bytes, _, had_errors) = GBK.encode(expected);
    assert!(!had_errors);
    assert_eq!(super::decode_process_text(&bytes), expected);
}

#[test]
fn decode_process_text_never_errors_on_arbitrary_bytes() {
    let garbage = [0xff_u8, 0xfe, 0x00, 0x01, 0x80, 0x81];
    // Must not panic; a lossy decode is an acceptable last resort for bytes
    // that are neither UTF-8 nor a recognized Windows codepage.
    let _ = super::decode_process_text(&garbage);
}

#[test]
fn rejects_binary_files_with_an_actionable_error() {
    let _lock = crate::test_env_lock();
    let _env = EnvGuard::unset("ARIS_WORKSPACE_ROOT");
    let path = temp_path("binary.txt");
    std::fs::write(&path, b"\0\x01\x02").expect("write binary content");

    let error = read_file(path.to_string_lossy().as_ref(), None, None)
        .expect_err("binary content should not be decoded as text");
    assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    assert!(error.to_string().contains("NUL bytes"));
}

#[test]
fn append_file_returns_summary_without_full_content() {
    let _lock = crate::test_env_lock();
    let _env = EnvGuard::unset("ARIS_WORKSPACE_ROOT");
    let path = temp_path("append.txt");
    write_file(path.to_string_lossy().as_ref(), "one\n").expect("initial write should succeed");

    let output = append_file(path.to_string_lossy().as_ref(), "two\nthree\n", false)
        .expect("append should succeed");

    assert_eq!(output.kind, "append");
    assert!(!output.created);
    assert_eq!(output.appended_chars, "two\nthree\n".chars().count());
    assert_eq!(output.total_lines, 3);
    assert_eq!(
        std::fs::read_to_string(&path).expect("read appended file"),
        "one\ntwo\nthree\n"
    );
}

#[test]
fn append_file_can_create_missing_file_when_allowed() {
    let _lock = crate::test_env_lock();
    let _env = EnvGuard::unset("ARIS_WORKSPACE_ROOT");
    let path = temp_path("append-create.txt");

    let missing_error = append_file(path.to_string_lossy().as_ref(), "first\n", false)
        .expect_err("missing append without create should fail");
    assert_eq!(missing_error.kind(), std::io::ErrorKind::NotFound);

    let output = append_file(path.to_string_lossy().as_ref(), "first\n", true)
        .expect("append should create file");
    assert!(output.created);
    assert_eq!(output.total_lines, 1);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "first\n");
}

#[test]
fn reads_large_file_with_line_window() {
    let _lock = crate::test_env_lock();
    let _env = EnvGuard::unset("ARIS_WORKSPACE_ROOT");
    let path = temp_path("large-window.txt");
    let content = (1..=6_000)
        .map(|line| format!("line-{line}"))
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(&path, content).expect("large file should be written");

    let output = read_file(path.to_string_lossy().as_ref(), Some(4_999), Some(3))
        .expect("large file window should read");

    assert_eq!(output.file.content, "line-5000\nline-5001\nline-5002");
    assert_eq!(output.file.start_line, 5_000);
    assert_eq!(output.file.total_lines, 6_000);
    assert!(!output.file.truncated);
}

#[test]
fn implicit_read_of_long_markdown_returns_outline_preview() {
    let _lock = crate::test_env_lock();
    let _env = EnvGuard::unset("ARIS_WORKSPACE_ROOT");
    let path = temp_path("long-book-chapter.md");
    let mut lines = vec!["# Chapter 2".to_string()];
    for index in 1..=1_000 {
        if index == 500 {
            lines.push("## Section 2.3 Important Topic".to_string());
        } else {
            lines.push(format!("body line {index} {}", "x".repeat(80)));
        }
    }
    std::fs::write(&path, lines.join("\n")).expect("long markdown file should be written");

    let output = read_file(path.to_string_lossy().as_ref(), None, None)
        .expect("long markdown file should read as preview");

    assert!(output.file.truncated);
    assert_eq!(output.file.total_lines, 1_001);
    assert!(output
        .file
        .content
        .contains("[read_file long-file preview:"));
    assert!(output.file.content.contains("L1: # Chapter 2"));
    assert!(output
        .file
        .content
        .contains("L501: ## Section 2.3 Important Topic"));
    assert!(output.file.content.contains("[head: lines 1-120]"));
    assert!(output.file.content.contains("[tail: lines 962-1001]"));
    assert!(!output.file.content.contains("L300: body line 300"));
}

#[test]
fn repeated_implicit_reads_of_long_markdown_return_stable_preview() {
    let _lock = crate::test_env_lock();
    let _env = EnvGuard::unset("ARIS_WORKSPACE_ROOT");
    let path = temp_path("repeat-long-book-chapter.md");
    let mut lines = vec!["# Repeated Chapter".to_string()];
    for index in 1..=1_500 {
        if index % 300 == 0 {
            lines.push(format!("## Section {}", index / 300));
        } else {
            lines.push(format!("paragraph {index} {}", "x".repeat(90)));
        }
    }
    std::fs::write(&path, lines.join("\n")).expect("long markdown file should be written");

    let first = read_file(path.to_string_lossy().as_ref(), None, None)
        .expect("first implicit long read should return a preview");
    let second = read_file(path.to_string_lossy().as_ref(), None, None)
        .expect("second implicit long read should return a preview");
    let third = read_file(path.to_string_lossy().as_ref(), None, None)
        .expect("third implicit long read should return a preview");

    for output in [&first, &second, &third] {
        assert!(output.file.truncated);
        assert_eq!(output.file.total_lines, 1_501);
        assert!(output
            .file
            .content
            .contains("[read_file long-file preview:"));
        assert!(output.file.content.contains("L1: # Repeated Chapter"));
        assert!(output.file.content.contains("L301: ## Section 1"));
        assert!(output.file.content.chars().count() <= MAX_READ_FILE_CONTENT_CHARS);
        assert!(!output.file.content.contains("L200: paragraph 200"));
    }
    assert_eq!(first, second);
    assert_eq!(second, third);
}

#[test]
fn read_file_truncates_very_long_single_line() {
    let _lock = crate::test_env_lock();
    let _env = EnvGuard::unset("ARIS_WORKSPACE_ROOT");
    let path = temp_path("long-single-line.json");
    let content = "x".repeat(MAX_READ_FILE_CONTENT_CHARS + 128);
    std::fs::write(&path, &content).expect("long line file should be written");

    let output = read_file(path.to_string_lossy().as_ref(), None, Some(1))
        .expect("long single-line file should read with truncation");

    assert_eq!(output.file.total_lines, 1);
    assert_eq!(output.file.total_chars, MAX_READ_FILE_CONTENT_CHARS + 128);
    assert!(output.file.truncated);
    assert!(output.file.content.len() < content.len());
    assert!(output.file.content.contains("[read_file truncated:"));
}

#[test]
fn reads_pdf_text_from_flate_stream() {
    let _lock = crate::test_env_lock();
    let _env = EnvGuard::unset("ARIS_WORKSPACE_ROOT");
    let path = temp_path("paper").with_extension("pdf");
    let content_stream = b"BT /F1 12 Tf 72 720 Td (Hello PDF) Tj T* (Second line) Tj ET";
    let pdf = pdf_with_streams(&[(" /Filter /FlateDecode", zlib_bytes(content_stream))]);
    std::fs::write(&path, pdf).expect("pdf should be written");

    let output =
        read_file(path.to_string_lossy().as_ref(), None, None).expect("pdf read should succeed");

    assert_eq!(output.file.content, "Hello PDF\nSecond line");
}

#[test]
fn reads_pdf_text_with_to_unicode_cmap() {
    let _lock = crate::test_env_lock();
    let _env = EnvGuard::unset("ARIS_WORKSPACE_ROOT");
    let path = temp_path("unicode-paper").with_extension("pdf");
    let cmap = br#"
/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
1 beginbfchar
<0001> <0041>
<0002> <0042>
<0003> <0020>
<0004> <03A9>
endbfchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end
"#;
    let content_stream = b"BT /F1 12 Tf 72 720 Td <0001000200030004> Tj ET";
    let pdf = pdf_with_streams(&[("", cmap.to_vec()), ("", content_stream.to_vec())]);
    std::fs::write(&path, pdf).expect("pdf should be written");

    let output =
        read_file(path.to_string_lossy().as_ref(), None, None).expect("pdf read should succeed");

    assert_eq!(output.file.content, "AB \u{03A9}");
}

#[test]
fn edits_file_contents() {
    let _lock = crate::test_env_lock();
    let _env = EnvGuard::unset("ARIS_WORKSPACE_ROOT");
    let path = temp_path("edit.txt");
    write_file(path.to_string_lossy().as_ref(), "alpha beta alpha")
        .expect("initial write should succeed");
    let output = edit_file(path.to_string_lossy().as_ref(), "alpha", "omega", true)
        .expect("edit should succeed");
    assert!(output.replace_all);
}

#[test]
fn edit_file_reports_only_changed_patch_window() {
    let _lock = crate::test_env_lock();
    let _env = EnvGuard::unset("ARIS_WORKSPACE_ROOT");
    let path = temp_path("compact-patch.txt");
    write_file(
        path.to_string_lossy().as_ref(),
        "one\ntwo\nthree\nfour\nfive\nsix\n",
    )
    .expect("initial write should succeed");

    let output = edit_file(path.to_string_lossy().as_ref(), "three", "THREE", false)
        .expect("edit should succeed");

    assert_eq!(output.structured_patch.len(), 1);
    assert_eq!(output.structured_patch[0].old_start, 3);
    assert_eq!(output.structured_patch[0].old_lines, 1);
    assert_eq!(output.structured_patch[0].new_start, 3);
    assert_eq!(output.structured_patch[0].new_lines, 1);
    assert_eq!(output.structured_patch[0].lines, vec!["-three", "+THREE"]);
    assert!(matches!(
        output.changes.get(&output.file_path),
        Some(FileChange::Update { unified_diff, move_path: None })
            if unified_diff.contains("@@ -3 +3 @@")
                && unified_diff.contains("-three")
                && unified_diff.contains("+THREE")
    ));
}

#[test]
fn globs_and_greps_directory() {
    let _lock = crate::test_env_lock();
    let _env = EnvGuard::unset("ARIS_WORKSPACE_ROOT");
    let dir = temp_path("search-dir");
    std::fs::create_dir_all(&dir).expect("directory should be created");
    let file = dir.join("demo.rs");
    write_file(
        file.to_string_lossy().as_ref(),
        "fn main() {\n println!(\"hello\");\n}\n",
    )
    .expect("file write should succeed");

    let globbed =
        glob_search("**/*.rs", Some(dir.to_string_lossy().as_ref())).expect("glob should succeed");
    assert_eq!(globbed.num_files, 1);

    let grep_output = grep_search(&GrepSearchInput {
        pattern: String::from("hello"),
        path: Some(dir.to_string_lossy().into_owned()),
        glob: Some(String::from("**/*.rs")),
        output_mode: Some(String::from("content")),
        before: None,
        after: None,
        context_short: None,
        context: None,
        line_numbers: Some(true),
        case_insensitive: Some(false),
        file_type: None,
        head_limit: Some(10),
        offset: Some(0),
        multiline: Some(false),
    })
    .expect("grep should succeed");
    assert!(grep_output.content.unwrap_or_default().contains("hello"));
}

#[test]
fn glob_and_grep_fast_paths_respect_gitignore() {
    let _lock = crate::test_env_lock();
    let _env = EnvGuard::unset("ARIS_WORKSPACE_ROOT");
    let dir = temp_path("search-gitignore");
    std::fs::create_dir_all(dir.join("src")).expect("src dir");
    std::fs::create_dir_all(dir.join("ignored")).expect("ignored dir");
    std::fs::write(dir.join(".gitignore"), "ignored/\n").expect("gitignore");
    std::fs::write(dir.join("src").join("lib.rs"), "fn visible() {}\n").expect("visible file");
    std::fs::write(dir.join("ignored").join("skip.rs"), "fn hidden() {}\n").expect("ignored file");

    let init = Command::new("git")
        .arg("init")
        .arg("--quiet")
        .current_dir(&dir)
        .status();
    if !init.is_ok_and(|status| status.success()) {
        std::fs::remove_dir_all(dir).expect("cleanup temp dir");
        return;
    }

    let globbed =
        glob_search("**/*.rs", Some(dir.to_string_lossy().as_ref())).expect("glob should succeed");
    assert_eq!(globbed.num_files, 1);
    assert!(globbed.filenames[0].ends_with("src/lib.rs"));

    let grep_output = grep_search(&GrepSearchInput {
        pattern: String::from("fn "),
        path: Some(dir.to_string_lossy().into_owned()),
        glob: Some(String::from("**/*.rs")),
        output_mode: Some(String::from("files_with_matches")),
        before: None,
        after: None,
        context_short: None,
        context: None,
        line_numbers: Some(true),
        case_insensitive: Some(false),
        file_type: None,
        head_limit: None,
        offset: None,
        multiline: Some(false),
    })
    .expect("grep should succeed");
    assert_eq!(grep_output.num_files, 1);
    assert!(grep_output.filenames[0].ends_with("src/lib.rs"));

    std::fs::remove_dir_all(dir).expect("cleanup temp dir");
}

#[test]
fn workspace_root_allows_relative_paths_inside_root() {
    let _lock = crate::test_env_lock();
    let root = temp_path("workspace-root");
    std::fs::create_dir_all(&root).expect("workspace should be created");
    let _env = EnvGuard::set("ARIS_WORKSPACE_ROOT", &root);

    write_file("notes/demo.txt", "inside").expect("write inside workspace should succeed");
    let output =
        read_file("notes/demo.txt", None, None).expect("read inside workspace should succeed");

    assert_eq!(output.file.content, "inside");
    let canonical_root = display_path(&root.canonicalize().unwrap());
    assert!(output.file.file_path.starts_with(&canonical_root));
}

#[test]
fn workspace_root_blocks_absolute_reads_outside_root() {
    let _lock = crate::test_env_lock();
    let root = temp_path("workspace-root");
    let outside = temp_path("outside.txt");
    std::fs::create_dir_all(&root).expect("workspace should be created");
    std::fs::write(&outside, "outside").expect("outside file should be created");
    let _env = EnvGuard::set("ARIS_WORKSPACE_ROOT", &root);

    let err = read_file(outside.to_string_lossy().as_ref(), None, None)
        .expect_err("outside read should be blocked");

    assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied);
}

#[test]
fn workspace_root_allows_readonly_root_reads_but_not_writes() {
    let _lock = crate::test_env_lock();
    let root = temp_path("workspace-root");
    let readonly = temp_path("readonly-root");
    let helper = readonly.join("skills").join("demo").join("helper.py");
    std::fs::create_dir_all(&root).expect("workspace should be created");
    std::fs::create_dir_all(helper.parent().unwrap()).expect("readonly helper dir");
    std::fs::write(&helper, "print('ok')").expect("helper should be created");
    let _workspace = EnvGuard::set("ARIS_WORKSPACE_ROOT", &root);
    let _readonly = EnvGuard::set(READONLY_ROOTS_ENV, readonly.join("skills"));

    let output = read_file(helper.to_string_lossy().as_ref(), None, None)
        .expect("readonly root read should succeed");
    assert_eq!(output.file.content, "print('ok')");

    let err = write_file(helper.to_string_lossy().as_ref(), "print('edit')")
        .expect_err("readonly root write should be blocked");
    assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied);
}

#[test]
fn workspace_root_blocks_parent_traversal_writes() {
    let _lock = crate::test_env_lock();
    let root = temp_path("workspace-root");
    std::fs::create_dir_all(&root).expect("workspace should be created");
    let _env = EnvGuard::set("ARIS_WORKSPACE_ROOT", &root);

    let err = write_file("../outside.txt", "outside")
        .expect_err("parent traversal write should be blocked");

    assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied);
}

#[test]
fn workspace_root_blocks_absolute_globs_outside_root() {
    let _lock = crate::test_env_lock();
    let root = temp_path("workspace-root");
    let outside = temp_path("outside-dir");
    std::fs::create_dir_all(&root).expect("workspace should be created");
    std::fs::create_dir_all(&outside).expect("outside dir should be created");
    std::fs::write(outside.join("secret.rs"), "fn main() {}")
        .expect("outside file should be created");
    let _env = EnvGuard::set("ARIS_WORKSPACE_ROOT", &root);

    let err = glob_search(&format!("{}/*.rs", outside.display()), None)
        .expect_err("outside glob should be blocked");

    assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied);
}

#[test]
fn workspace_root_allows_glob_from_readonly_root_ancestor() {
    let _lock = crate::test_env_lock();
    let root = temp_path("workspace-root");
    let config_root = temp_path("aris-config");
    let skills_root = config_root.join("skills");
    let script = skills_root
        .join("scopus-search")
        .join("scripts")
        .join("scopus_search.py");
    std::fs::create_dir_all(&root).expect("workspace should be created");
    std::fs::create_dir_all(script.parent().unwrap()).expect("script dir");
    std::fs::write(&script, "print('ok')").expect("script should be created");
    std::fs::write(config_root.join("config.json"), "{\"secret\":true}")
        .expect("config file should be created");
    let _workspace = EnvGuard::set("ARIS_WORKSPACE_ROOT", &root);
    let _readonly = EnvGuard::set(READONLY_ROOTS_ENV, &skills_root);

    let globbed = glob_search(
        "**/scopus_search.py",
        Some(config_root.to_string_lossy().as_ref()),
    )
    .expect("glob from readonly ancestor should succeed");

    assert_eq!(globbed.num_files, 1);
    assert!(globbed.filenames[0].ends_with("skills/scopus-search/scripts/scopus_search.py"));
}

fn assert_uniform_crlf(text: &str) {
    let crlf = text.matches("\r\n").count();
    let lf = text.matches('\n').count();
    assert_eq!(crlf, lf, "file should contain no bare LF endings: {text:?}");
}

#[test]
fn edit_file_matches_lf_old_string_in_crlf_file() {
    let _lock = crate::test_env_lock();
    let _env = EnvGuard::unset("ARIS_WORKSPACE_ROOT");
    let path = temp_path("edit-crlf.css");
    std::fs::write(
        &path,
        b".a {\r\n  color: red;\r\n}\r\n\r\n.b {\r\n  color: blue;\r\n}\r\n",
    )
    .expect("write CRLF file");

    edit_file(
        path.to_string_lossy().as_ref(),
        ".a {\n  color: red;\n}",
        ".a {\n  color: green;\n}",
        false,
    )
    .expect("LF old_string should match the CRLF file");

    let text = std::fs::read_to_string(&path).expect("read back");
    assert!(text.contains(".a {\r\n  color: green;\r\n}"));
    assert!(text.contains(".b {\r\n  color: blue;\r\n}"));
    assert_uniform_crlf(&text);
}

#[test]
fn edit_file_converts_multiline_new_string_to_region_eol() {
    let _lock = crate::test_env_lock();
    let _env = EnvGuard::unset("ARIS_WORKSPACE_ROOT");
    let path = temp_path("edit-crlf-island.txt");
    std::fs::write(&path, b"alpha\r\nbeta\r\ngamma\r\n").expect("write CRLF file");

    edit_file(
        path.to_string_lossy().as_ref(),
        "beta",
        "beta\nbeta-extra",
        false,
    )
    .expect("single-line anchor should still match");

    let text = std::fs::read_to_string(&path).expect("read back");
    assert_eq!(text, "alpha\r\nbeta\r\nbeta-extra\r\ngamma\r\n");
    assert_uniform_crlf(&text);
}

#[test]
fn edit_file_keeps_lf_island_style_in_mixed_file() {
    let _lock = crate::test_env_lock();
    let _env = EnvGuard::unset("ARIS_WORKSPACE_ROOT");
    let path = temp_path("edit-mixed.txt");
    std::fs::write(
        &path,
        b"one\r\ntwo\r\nisland-a\nisland-b\nisland-c\nthree\r\n",
    )
    .expect("write mixed file");

    edit_file(
        path.to_string_lossy().as_ref(),
        "island-a\nisland-b",
        "island-a\nISLAND-B",
        false,
    )
    .expect("edit inside the LF island should match");

    let text = std::fs::read_to_string(&path).expect("read back");
    assert_eq!(
        text,
        "one\r\ntwo\r\nisland-a\nISLAND-B\nisland-c\nthree\r\n"
    );
}

#[test]
fn edit_file_replace_all_preserves_crlf() {
    let _lock = crate::test_env_lock();
    let _env = EnvGuard::unset("ARIS_WORKSPACE_ROOT");
    let path = temp_path("edit-crlf-all.txt");
    std::fs::write(&path, b"item\r\nkeep\r\nitem\r\n").expect("write CRLF file");

    edit_file(path.to_string_lossy().as_ref(), "item", "entry", true)
        .expect("replace_all should succeed");

    let text = std::fs::read_to_string(&path).expect("read back");
    assert_eq!(text, "entry\r\nkeep\r\nentry\r\n");
}

#[test]
fn edit_file_rejects_ambiguous_old_string() {
    let _lock = crate::test_env_lock();
    let _env = EnvGuard::unset("ARIS_WORKSPACE_ROOT");
    let path = temp_path("edit-ambiguous.txt");
    std::fs::write(&path, "alpha\nbeta\nalpha\n").expect("write file");

    let error = edit_file(path.to_string_lossy().as_ref(), "alpha", "omega", false)
        .expect_err("ambiguous old_string should fail");

    assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
    let message = error.to_string();
    assert!(message.contains("matches 2 locations"), "{message}");
    assert!(message.contains("replace_all"), "{message}");
    assert_eq!(
        std::fs::read_to_string(&path).expect("read back"),
        "alpha\nbeta\nalpha\n",
        "file should be untouched"
    );
}

#[test]
fn edit_file_rejects_empty_old_string() {
    let _lock = crate::test_env_lock();
    let _env = EnvGuard::unset("ARIS_WORKSPACE_ROOT");
    let path = temp_path("edit-empty-old.txt");
    std::fs::write(&path, "alpha\n").expect("write file");

    let error = edit_file(path.to_string_lossy().as_ref(), "", "omega", false)
        .expect_err("empty old_string should fail");

    assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
    assert!(error.to_string().contains("must not be empty"));
}

#[test]
fn edit_file_not_found_reports_whitespace_near_miss() {
    let _lock = crate::test_env_lock();
    let _env = EnvGuard::unset("ARIS_WORKSPACE_ROOT");
    let path = temp_path("edit-near-miss.rs");
    std::fs::write(&path, "fn main() {\n    let value = 1;\n}\n").expect("write file");

    let error = edit_file(
        path.to_string_lossy().as_ref(),
        "fn main() {\n  let value = 1;\n}",
        "fn main() {\n  let value = 2;\n}",
        false,
    )
    .expect_err("indentation drift should not match");

    let message = error.to_string();
    assert!(message.contains("lines 1-3"), "{message}");
    assert!(message.contains("re-read the file"), "{message}");
}

#[test]
fn edit_file_matches_through_leading_bom() {
    let _lock = crate::test_env_lock();
    let _env = EnvGuard::unset("ARIS_WORKSPACE_ROOT");
    let path = temp_path("edit-bom.txt");
    std::fs::write(&path, b"\xEF\xBB\xBFalpha\r\nbeta\r\n").expect("write BOM file");

    edit_file(
        path.to_string_lossy().as_ref(),
        "alpha\nbeta",
        "ALPHA\nbeta",
        false,
    )
    .expect("match should skip the BOM");

    let text = std::fs::read_to_string(&path).expect("read back");
    assert!(text.starts_with('\u{feff}'), "BOM should be preserved");
    assert!(text.contains("ALPHA\r\nbeta"));
}

#[test]
fn write_file_preserves_existing_crlf_style() {
    let _lock = crate::test_env_lock();
    let _env = EnvGuard::unset("ARIS_WORKSPACE_ROOT");
    let path = temp_path("write-crlf.txt");
    std::fs::write(&path, b"old\r\ncontent\r\n").expect("write CRLF file");

    write_file(path.to_string_lossy().as_ref(), "new\ncontent\nhere\n")
        .expect("overwrite should succeed");

    let text = std::fs::read_to_string(&path).expect("read back");
    assert_eq!(text, "new\r\ncontent\r\nhere\r\n");
}

#[test]
fn append_file_matches_existing_eol() {
    let _lock = crate::test_env_lock();
    let _env = EnvGuard::unset("ARIS_WORKSPACE_ROOT");
    let path = temp_path("append-crlf.txt");
    std::fs::write(&path, b"head\r\n").expect("write CRLF file");

    append_file(path.to_string_lossy().as_ref(), "tail\nmore\n", false)
        .expect("append should succeed");

    let text = std::fs::read_to_string(&path).expect("read back");
    assert_eq!(text, "head\r\ntail\r\nmore\r\n");
}
