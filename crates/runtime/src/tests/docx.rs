use super::*;
use crate::{FileMutationContext, ProjectExecutionContext, ARIS_WORKSPACE_ROOT_ENV};

#[test]
fn real_generated_document_preserves_native_equations_and_all_unedited_parts() {
    fixture(|dir| {
        let original = include_bytes!("fixtures/docx-native-math.docx");
        fs::write(dir.join("sample.docx"), original).unwrap();
        let read = read_docx("sample.docx", None, Some(100)).unwrap();
        assert_eq!(read.native_equation_count, 9);
        let paragraph = read
            .paragraphs
            .iter()
            .find(|p| p.text.starts_with("跨格式文本"))
            .unwrap();
        edit_docx(
            "sample.docx",
            &read.revision,
            &[edit(&paragraph.id, "跨格式文本", "精确修改")],
            &context(),
        )
        .unwrap();
        let before = files(original);
        let after = files(&fs::read(dir.join("sample.docx")).unwrap());
        assert_eq!(
            before.keys().collect::<Vec<_>>(),
            after.keys().collect::<Vec<_>>()
        );
        for (name, bytes) in &before {
            if name != "word/document.xml" {
                assert_eq!(bytes, &after[name], "{name}");
            }
        }
        let native = |bytes: &[u8]| {
            let xml = std::str::from_utf8(bytes).unwrap();
            let doc = Document::parse(xml).unwrap();
            doc.descendants()
                .filter(|n| is(*n, MATH, "oMath"))
                .map(|n| xml[n.range()].to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            native(&before["word/document.xml"]),
            native(&after["word/document.xml"])
        );
        assert_eq!(
            read_docx("sample.docx", None, Some(100))
                .unwrap()
                .native_equation_count,
            9
        );
    });
}

#[test]
fn failed_audit_rolls_back_the_docx_write() {
    fixture(|dir| {
        let original = package(BODY);
        fs::write(dir.join("sample.docx"), &original).unwrap();
        let read = read_docx("sample.docx", None, None).unwrap();
        let ledger = crate::change_ledger::change_ledger_root_for_path(&dir.join("sample.docx"));
        fs::create_dir_all(ledger.parent().unwrap()).unwrap();
        fs::write(&ledger, "block ledger directory creation").unwrap();
        let error = edit_docx(
            "sample.docx",
            &read.revision,
            &[edit(&read.paragraphs[0].id, "foo", "changed")],
            &context(),
        )
        .unwrap_err();
        assert!(error.to_string().contains("rollback: Ok"));
        assert_eq!(fs::read(dir.join("sample.docx")).unwrap(), original);
    });
}

#[test]
fn docx_edit_and_revert_complete_when_document_and_ledger_share_a_lock_stripe() {
    fixture(|dir| {
        let original = package(BODY);
        let ledger = crate::change_ledger::change_ledger_root_for_path(&dir.join("sample.docx"))
            .join("docx-test")
            .join("ledger.jsonl");
        let path = (0..4096)
            .find_map(|index| {
                let path = dir.join(format!("collision-{index}.docx"));
                fs::write(&path, &original).unwrap();
                let canonical = crate::file_ops::normalize_path(path.to_str().unwrap()).unwrap();
                crate::atomic_file::path_locks_collide(&canonical, &ledger).then_some(path)
            })
            .expect("find a deterministic lock collision");
        let path_string = path.to_str().unwrap();
        let read = read_docx(path_string, None, None).unwrap();
        let id = edit_docx(
            path_string,
            &read.revision,
            &[edit(&read.paragraphs[0].id, "foo", "changed")],
            &context(),
        )
        .unwrap()
        .change_id
        .unwrap();
        let result = crate::revert_file_change(
            crate::FileChangeRevertInput {
                change_id: id,
                session_id: Some("docx-test".into()),
            },
            &context(),
        )
        .unwrap();
        assert!(result.reverted);
        assert_eq!(fs::read(&path).unwrap(), original);
    });
}

#[test]
fn binary_revert_reports_external_changes_and_missing_files_as_conflicts() {
    fixture(|dir| {
        fs::write(dir.join("sample.docx"), package(BODY)).unwrap();
        let read = read_docx("sample.docx", None, None).unwrap();
        let id = edit_docx(
            "sample.docx",
            &read.revision,
            &[edit(&read.paragraphs[0].id, "foo", "changed")],
            &context(),
        )
        .unwrap()
        .change_id
        .unwrap();
        let input = crate::FileChangeRevertInput {
            change_id: id,
            session_id: Some("docx-test".into()),
        };
        fs::write(dir.join("sample.docx"), b"external edit").unwrap();
        let result = crate::revert_file_change(input.clone(), &context()).unwrap();
        assert!(!result.reverted && result.conflict.is_some());
        assert_eq!(fs::read(dir.join("sample.docx")).unwrap(), b"external edit");
        fs::remove_file(dir.join("sample.docx")).unwrap();
        let result = crate::revert_file_change(input, &context()).unwrap();
        assert!(!result.reverted && result.conflict.unwrap().contains("missing"));
        assert!(!dir.join("sample.docx").exists());
    });
}

fn package(body: &str) -> Vec<u8> {
    let document = format!(
        r#"<w:document xmlns:w="{WORD}" xmlns:m="{MATH}"><w:body>{body}</w:body></w:document>"#
    );
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in [
        ("[Content_Types].xml", "<Types/>".as_bytes()),
        ("word/document.xml", document.as_bytes()),
        ("word/header1.xml", br#"<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Header title</w:t></w:r></w:p></w:hdr>"#.as_slice()),
        ("word/styles.xml", b"<styles>keep unchanged</styles>".as_slice()),
        ("word/media/preserved.bin", b"\0\xffimage".as_slice()),
    ] {
        zip.start_file(name, SimpleFileOptions::default()).unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

fn fixture(action: impl FnOnce(&Path)) {
    let dir = tempfile::tempdir().unwrap();
    let context =
        ProjectExecutionContext::new(dir.path()).with_env(ARIS_WORKSPACE_ROOT_ENV, dir.path());
    crate::with_project_execution_context(&context, || action(dir.path()));
}

fn edit(id: &str, old: &str, new: &str) -> DocxTextEdit {
    DocxTextEdit {
        paragraph_id: id.into(),
        old_string: old.into(),
        new_string: new.into(),
    }
}
fn context() -> FileMutationContext {
    let mut context = FileMutationContext::from_env("edit_docx");
    context.session_id = Some("docx-test".into());
    context
}
fn files(bytes: &[u8]) -> BTreeMap<String, Vec<u8>> {
    let mut zip = archive(bytes).unwrap();
    (0..zip.len())
        .map(|i| {
            let mut file = zip.by_index(i).unwrap();
            let mut data = Vec::new();
            file.read_to_end(&mut data).unwrap();
            (file.name().to_string(), data)
        })
        .collect()
}

const BODY: &str = r#"<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>中文 foo &amp; </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>bar tail</w:t></w:r><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath><w:r><w:t>after math</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell content</w:t></w:r></w:p></w:tc></w:tr></w:tbl>"#;

#[test]
fn reading_preserves_equation_boundaries_and_indexes_stories_and_tables() {
    fixture(|dir| {
        fs::write(dir.join("sample.docx"), package(BODY)).unwrap();
        let read = read_docx("sample.docx", None, Some(1)).unwrap();
        assert_eq!(read.total_paragraphs, 3);
        assert_eq!(read.native_equation_count, 1);
        assert_eq!(read.next_offset, Some(1));
        assert_eq!(
            read.paragraphs[0].editable_segments,
            ["中文 foo & bar tail", "after math"]
        );
        assert!(read.paragraphs[0].text.contains("[native equation 1]"));
        let page = read_docx("sample.docx", Some(1), Some(2)).unwrap();
        assert_eq!(page.paragraphs[0].text, "Cell content");
        assert_eq!(page.paragraphs[1].text, "Header title");
        assert_eq!(page.revision, read.revision);
    });
}

#[test]
fn replacement_spans_runs_without_removing_math_formatting_or_other_parts() {
    fixture(|dir| {
        let original = package(BODY);
        fs::write(dir.join("sample.docx"), &original).unwrap();
        let read = read_docx("sample.docx", None, None).unwrap();
        let output = edit_docx(
            "sample.docx",
            &read.revision,
            &[edit(
                &read.paragraphs[0].id,
                "foo & bar",
                "new <value> & result",
            )],
            &context(),
        )
        .unwrap();
        assert_eq!(output.preserved_native_equations, 1);
        let updated = fs::read(dir.join("sample.docx")).unwrap();
        let before = files(&original);
        let after = files(&updated);
        for (name, bytes) in &before {
            if name != "word/document.xml" {
                assert_eq!(bytes, &after[name], "{name}");
            }
        }
        let xml = std::str::from_utf8(&after["word/document.xml"]).unwrap();
        assert!(xml.contains("<w:b/>") && xml.contains("<w:i/>"));
        assert!(xml.contains("<m:oMath><m:r><m:t>x</m:t></m:r></m:oMath>"));
        assert!(xml.contains("new &lt;value&gt; &amp; result"));
        let reread = read_docx("sample.docx", None, None).unwrap();
        assert!(reread.paragraphs[0]
            .text
            .starts_with("中文 new <value> & result tail"));
        assert_eq!(reread.revision, output.revision);
    });
}

#[test]
fn stale_revision_and_ambiguous_matches_do_not_change_the_package() {
    fixture(|dir| {
        let original = package(r#"<w:p><w:r><w:t>same same</w:t></w:r></w:p>"#);
        fs::write(dir.join("sample.docx"), &original).unwrap();
        let read = read_docx("sample.docx", None, None).unwrap();
        assert!(edit_docx(
            "sample.docx",
            "stale",
            &[edit(&read.paragraphs[0].id, "same", "new")],
            &context()
        )
        .unwrap_err()
        .to_string()
        .contains("revision_conflict"));
        assert!(edit_docx(
            "sample.docx",
            &read.revision,
            &[edit(&read.paragraphs[0].id, "same", "new")],
            &context()
        )
        .unwrap_err()
        .to_string()
        .contains("2 matches"));
        assert_eq!(fs::read(dir.join("sample.docx")).unwrap(), original);
    });
}

#[test]
fn overlapping_occurrences_are_ambiguous_in_ascii_and_chinese_text() {
    fixture(|dir| {
        for (text, old) in [("aaa", "aa"), ("中文中文中文", "中文中文")] {
            let original = package(&format!("<w:p><w:r><w:t>{text}</w:t></w:r></w:p>"));
            fs::write(dir.join("sample.docx"), &original).unwrap();
            let read = read_docx("sample.docx", None, None).unwrap();
            assert!(edit_docx(
                "sample.docx",
                &read.revision,
                &[edit(&read.paragraphs[0].id, old, "changed")],
                &context()
            )
            .unwrap_err()
            .to_string()
            .contains("2 matches"));
            assert_eq!(fs::read(dir.join("sample.docx")).unwrap(), original);
        }
    });
}

#[test]
fn signed_packages_and_alternate_content_are_not_silently_modified() {
    fixture(|dir| {
        let body = r#"<w:p xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:AlternateContent><mc:Choice Requires="w"><w:r><w:t>today</w:t></w:r></mc:Choice><mc:Fallback><w:r><w:t>today</w:t></w:r></mc:Fallback></mc:AlternateContent></w:p>"#;
        let original = package(body);
        fs::write(dir.join("sample.docx"), &original).unwrap();
        let read = read_docx("sample.docx", None, None).unwrap();
        assert!(read.paragraphs[0].read_only_reason.is_some());
        assert!(edit_docx(
            "sample.docx",
            &read.revision,
            &[edit(&read.paragraphs[0].id, "today", "tomorrow")],
            &context()
        )
        .is_err());
        assert_eq!(fs::read(dir.join("sample.docx")).unwrap(), original);
        let mut writer = ZipWriter::new_append(Cursor::new(package(BODY))).unwrap();
        writer
            .start_file("_xmlsignatures/sig1.xml", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"<Signature/>").unwrap();
        let signed = writer.finish().unwrap().into_inner();
        fs::write(dir.join("sample.docx"), &signed).unwrap();
        let read = read_docx("sample.docx", None, None).unwrap();
        assert!(edit_docx(
            "sample.docx",
            &read.revision,
            &[edit(&read.paragraphs[0].id, "foo", "changed")],
            &context()
        )
        .unwrap_err()
        .to_string()
        .contains("signed_document"));
        assert_eq!(fs::read(dir.join("sample.docx")).unwrap(), signed);
    });
}

#[test]
fn failing_second_edit_leaves_first_edit_unpublished() {
    fixture(|dir| {
        let original = package(BODY);
        fs::write(dir.join("sample.docx"), &original).unwrap();
        let read = read_docx("sample.docx", None, None).unwrap();
        let id = &read.paragraphs[0].id;
        assert!(edit_docx(
            "sample.docx",
            &read.revision,
            &[edit(id, "foo", "changed"), edit(id, "not present", "bad")],
            &context()
        )
        .is_err());
        assert_eq!(fs::read(dir.join("sample.docx")).unwrap(), original);
    });
}

#[test]
fn equations_links_and_bookmarks_cannot_be_crossed_by_text_replacement() {
    fixture(|dir| {
        for body in [
            r#"<w:p><w:r><w:t>before</w:t></w:r><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath><w:r><w:t>after</w:t></w:r></w:p>"#,
            r#"<w:p><w:r><w:t>before</w:t></w:r><w:hyperlink><w:r><w:t>after</w:t></w:r></w:hyperlink></w:p>"#,
            r#"<w:p><w:r><w:t>before</w:t></w:r><w:bookmarkStart w:id="1" w:name="keep"/><w:r><w:t>after</w:t></w:r></w:p>"#,
        ] {
            let original = package(body);
            fs::write(dir.join("sample.docx"), &original).unwrap();
            let read = read_docx("sample.docx", None, None).unwrap();
            assert!(edit_docx(
                "sample.docx",
                &read.revision,
                &[edit(&read.paragraphs[0].id, "beforeafter", "changed")],
                &context()
            )
            .is_err());
            assert_eq!(fs::read(dir.join("sample.docx")).unwrap(), original);
        }
    });
}

#[test]
fn fields_tracked_changes_and_content_controls_are_explicitly_protected() {
    fixture(|dir| {
        for body in [
            r#"<w:p><w:fldSimple w:instr="DATE"><w:r><w:t>today</w:t></w:r></w:fldSimple></w:p>"#,
            r#"<w:ins><w:p><w:r><w:t>today</w:t></w:r></w:p></w:ins>"#,
            r#"<w:p><w:sdt><w:sdtContent><w:r><w:t>today</w:t></w:r></w:sdtContent></w:sdt></w:p>"#,
        ] {
            fs::write(dir.join("sample.docx"), package(body)).unwrap();
            let read = read_docx("sample.docx", None, None).unwrap();
            assert!(read.paragraphs[0].read_only_reason.is_some());
            assert!(edit_docx(
                "sample.docx",
                &read.revision,
                &[edit(&read.paragraphs[0].id, "today", "tomorrow")],
                &context()
            )
            .unwrap_err()
            .to_string()
            .contains("protected_paragraph"));
        }
    });
}

#[test]
fn ordered_batch_can_edit_table_header_and_previously_replaced_text() {
    fixture(|dir| {
        fs::write(dir.join("sample.docx"), package(BODY)).unwrap();
        let read = read_docx("sample.docx", None, None).unwrap();
        edit_docx(
            "sample.docx",
            &read.revision,
            &[
                edit(&read.paragraphs[0].id, "foo", "first"),
                edit(&read.paragraphs[0].id, "first", "second"),
                edit(&read.paragraphs[1].id, "Cell content", "New cell"),
                edit(&read.paragraphs[2].id, "Header title", "New header"),
            ],
            &context(),
        )
        .unwrap();
        let read = read_docx("sample.docx", None, None).unwrap();
        assert!(read.paragraphs[0].text.contains("second"));
        assert_eq!(read.paragraphs[1].text, "New cell");
        assert_eq!(read.paragraphs[2].text, "New header");
    });
}

#[test]
fn binary_audit_preview_and_revert_restore_the_exact_original_zip() {
    fixture(|dir| {
        let original = package(BODY);
        fs::write(dir.join("sample.docx"), &original).unwrap();
        let read = read_docx("sample.docx", None, None).unwrap();
        let output = edit_docx(
            "sample.docx",
            &read.revision,
            &[edit(&read.paragraphs[0].id, "foo", "new")],
            &context(),
        )
        .unwrap();
        let change_id = output.change_id.unwrap();
        let record = crate::get_file_change(crate::FileChangeGetInput {
            change_id: change_id.clone(),
            session_id: Some("docx-test".into()),
        })
        .unwrap()
        .record;
        assert!(record.reversible);
        assert_eq!(record.before.content_kind.as_deref(), Some("binary"));
        let preview = crate::file_snapshot_content_for_workspace(dir, "docx-test", &record.before)
            .unwrap()
            .unwrap();
        assert!(preview.contains("foo") && preview.contains("[native equation 1]"));
        let reverted = crate::revert_file_change(
            crate::FileChangeRevertInput {
                change_id,
                session_id: Some("docx-test".into()),
            },
            &context(),
        )
        .unwrap();
        assert!(reverted.reverted);
        assert_eq!(fs::read(dir.join("sample.docx")).unwrap(), original);
    });
}

#[test]
fn generic_text_tools_cannot_create_or_corrupt_a_word_package() {
    fixture(|dir| {
        assert!(crate::write_file("new.docx", "plain text")
            .unwrap_err()
            .to_string()
            .contains("binary packages"));
        assert!(!dir.join("new.docx").exists());
        let original = package(BODY);
        fs::write(dir.join("sample.docx"), &original).unwrap();
        assert!(crate::edit_file("sample.docx", "foo", "bad", false).is_err());
        assert_eq!(fs::read(dir.join("sample.docx")).unwrap(), original);
    });
}

#[test]
fn xml_space_attribute_with_whitespace_and_invalid_controls_are_handled_safely() {
    fixture(|dir| {
        fs::write(
            dir.join("sample.docx"),
            package(r#"<w:p><w:r><w:t xml:space = 'default'>text</w:t></w:r></w:p>"#),
        )
        .unwrap();
        let read = read_docx("sample.docx", None, None).unwrap();
        let id = &read.paragraphs[0].id;
        assert!(edit_docx(
            "sample.docx",
            &read.revision,
            &[edit(id, "text", "bad\u{0001}")],
            &context()
        )
        .is_err());
        edit_docx(
            "sample.docx",
            &read.revision,
            &[edit(id, "text", " padded ")],
            &context(),
        )
        .unwrap();
        let read = read_docx("sample.docx", None, None).unwrap();
        assert_eq!(read.paragraphs[0].text, " padded ");
    });
}
