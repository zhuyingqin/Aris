use super::*;
use crate::{FileChangeRevertInput, FileMutationContext, ProjectExecutionContext};

fn workspace(action: impl FnOnce(&Path)) {
    let directory = tempfile::tempdir().unwrap();
    let context = ProjectExecutionContext::new(directory.path())
        .with_env("ARIS_WORKSPACE_ROOT", directory.path());
    crate::with_project_execution_context(&context, || action(directory.path()));
}

fn mutation() -> FileMutationContext {
    FileMutationContext {
        session_id: Some("docx-export-tests".into()),
        tool_name: "export_docx".into(),
        ..Default::default()
    }
}

#[test]
fn source_and_destination_versions_are_checked_before_any_engine_runs() {
    workspace(|root| {
        fs::write(
            root.join("source.md"),
            "# Report\n\nKeep 16 classes and 480 participants.",
        )
        .unwrap();
        fs::write(root.join("existing.docx"), b"approved version").unwrap();
        let mut input = DocxExportInput {
            source_path: "source.md".into(),
            expected_source_revision: "stale".into(),
            output_path: "existing.docx".into(),
            expected_revision: None,
            reference_doc: None,
            render_pdf: false,
        };
        assert!(export_docx(&input, &mutation(), &|| false)
            .unwrap_err()
            .to_string()
            .contains("revision_conflict"));
        input.expected_source_revision = revision(&fs::read(root.join("source.md")).unwrap());
        assert!(export_docx(&input, &mutation(), &|| false)
            .unwrap_err()
            .to_string()
            .contains("revision_conflict"));
        assert_eq!(
            fs::read(root.join("existing.docx")).unwrap(),
            b"approved version"
        );
        let large = vec![0; crate::change_ledger::MAX_REVERT_BLOB_BYTES + 1];
        fs::write(root.join("large.docx"), &large).unwrap();
        input.output_path = "large.docx".into();
        input.expected_revision = Some(revision(&large));
        assert!(export_docx(&input, &mutation(), &|| false)
            .unwrap_err()
            .to_string()
            .contains("candidate_required"));
        assert_eq!(
            fs::metadata(root.join("large.docx")).unwrap().len(),
            large.len() as u64
        );
        input.output_path = "../escape.docx".into();
        assert!(export_docx(&input, &mutation(), &|| false).is_err());
    });
}

#[test]
fn generated_binary_creation_and_replacement_are_reversible() {
    workspace(|root| {
        let path = root.join("new.docx");
        let original = include_bytes!("fixtures/docx-native-math.docx");
        let created = commit(&path, None, original, &mutation(), "test creation".into())
            .unwrap()
            .unwrap();
        let reverted = crate::revert_file_change(
            FileChangeRevertInput {
                change_id: created,
                session_id: Some("docx-export-tests".into()),
            },
            &mutation(),
        )
        .unwrap();
        assert!(reverted.reverted);
        assert!(!path.exists());
        let path = root.join("existing.docx");
        fs::write(&path, original).unwrap();
        let updated = commit(
            &path,
            Some(original),
            REFERENCE,
            &mutation(),
            "test replacement".into(),
        )
        .unwrap()
        .unwrap();
        let reverted = crate::revert_file_change(
            FileChangeRevertInput {
                change_id: updated,
                session_id: Some("docx-export-tests".into()),
            },
            &mutation(),
        )
        .unwrap();
        assert!(reverted.reverted);
        assert_eq!(fs::read(path).unwrap(), original);
    });
}

#[test]
fn candidate_commit_rejects_intervening_edits_and_rolls_back_failed_audit() {
    workspace(|root| {
        let path = root.join("result.docx");
        fs::write(&path, b"external edit").unwrap();
        assert!(commit(
            &path,
            Some(b"previous"),
            REFERENCE,
            &mutation(),
            "conflict".into()
        )
        .unwrap_err()
        .to_string()
        .contains("revision_conflict"));
        assert_eq!(fs::read(&path).unwrap(), b"external edit");
        let ledger = crate::change_ledger::change_ledger_root_for_path(&path);
        fs::create_dir_all(ledger.parent().unwrap()).unwrap();
        fs::write(ledger, b"ledger unavailable").unwrap();
        assert!(commit(
            &path,
            Some(b"external edit"),
            REFERENCE,
            &mutation(),
            "failed audit".into()
        )
        .unwrap_err()
        .to_string()
        .contains("audit_failed"));
        assert_eq!(fs::read(&path).unwrap(), b"external edit");
        let new = root.join("new.docx");
        assert!(commit(&new, None, REFERENCE, &mutation(), "failed audit".into()).is_err());
        assert!(!new.exists());
    });
}

#[test]
fn upstream_ast_math_is_counted_without_parsing_tex_ourselves() {
    let ast = serde_json::json!({"blocks":[{"t":"Para","c":[
        {"t":"Math","c":[{"t":"InlineMath"},"a+b"]},
        {"t":"Str","c":"Math"}]},{"t":"Para","c":[{"t":"Math","c":[{"t":"DisplayMath"},"x"]}]}]});
    assert_eq!(math_count(&ast), 2);
}

#[test]
fn cancellation_never_launches_an_engine_or_publishes_an_output() {
    workspace(|root| {
        let input: DocxExportInput = serde_json::from_value(serde_json::json!({
            "source_path":"missing.md", "expected_source_revision":"not-read", "output_path":"missing.docx"
        })).unwrap();
        assert!(export_docx(&input, &mutation(), &|| true)
            .unwrap_err()
            .to_string()
            .contains("cancelled"));
        let input: DocxFormatInput = serde_json::from_value(serde_json::json!({
            "path":"missing.docx", "expected_source_revision":"not-read", "output_path":"formatted.docx", "operations":[]
        })).unwrap();
        assert!(format_docx(&input, &mutation(), &|| true)
            .unwrap_err()
            .to_string()
            .contains("cancelled"));
        let input: DocxDeleteParagraphsInput = serde_json::from_value(serde_json::json!({
            "path":"missing.docx", "expected_source_revision":"not-read", "output_path":"deleted.docx", "deletions":[]
        })).unwrap();
        assert!(delete_docx_paragraphs(&input, &mutation(), &|| true)
            .unwrap_err()
            .to_string()
            .contains("cancelled"));
        let input: DocxPdfExportInput = serde_json::from_value(serde_json::json!({
            "path":"missing.docx", "expected_source_revision":"not-read"
        }))
        .unwrap();
        assert!(export_docx_pdf(&input, &mutation(), &|| true)
            .unwrap_err()
            .to_string()
            .contains("cancelled"));
        assert!(render_docx(
            &DocxRenderInput {
                path: "missing.docx".into(),
                expected_revision: "not-read".into()
            },
            &|| true
        )
        .unwrap_err()
        .to_string()
        .contains("cancelled"));
        assert!(!root.join("formatted.docx").exists());
        assert!(!root.join("deleted.docx").exists());
        assert!(!root.join("missing.pdf").exists());
        assert!(!root.join(".somniq/artifacts").exists());
        let input: DocxStructureInput = serde_json::from_value(serde_json::json!({
            "path":"missing.docx","expected_source_revision":"stale","output_path":"out.docx","operations":[]
        })).unwrap();
        assert!(edit_docx_structure(&input, &mutation(), &|| true)
            .unwrap_err()
            .to_string()
            .contains("cancelled"));
        let input: OdtHighlightInput = serde_json::from_value(serde_json::json!({
            "path":"missing.odt","expected_source_revision":"stale","output_path":"out.odt"
        }))
        .unwrap();
        assert!(remove_odt_highlight(&input, &mutation(), &|| true)
            .unwrap_err()
            .to_string()
            .contains("cancelled"));
    });
}

#[test]
fn structure_resources_require_current_revisions_and_workspace_paths_before_python() {
    workspace(|root| {
        fs::write(root.join("source.docx"), REFERENCE).unwrap();
        fs::write(root.join("image.png"), b"image bytes").unwrap();
        let mut input: DocxStructureInput = serde_json::from_value(serde_json::json!({
            "path":"source.docx","expected_source_revision":revision(REFERENCE),"output_path":"out.docx",
            "operations":[{"action":"insert_image","paragraph_id":"word/document.xml:p1","expected_text":"",
                "offset":0,"image_path":"image.png","image_revision":"stale","width_pt":240}]
        })).unwrap();
        assert!(edit_docx_structure(&input, &mutation(), &|| false)
            .unwrap_err()
            .to_string()
            .contains("revision_conflict"));
        if let DocxStructureOperation::InsertImage { image_path, .. } = &mut input.operations[0] {
            *image_path = "../outside.png".into();
        }
        assert!(edit_docx_structure(&input, &mutation(), &|| false).is_err());
        assert!(!root.join("out.docx").exists());
        assert!(!root.join(".somniq/artifacts").exists());
        assert_eq!(fs::read(root.join("source.docx")).unwrap(), REFERENCE);
    });
}

#[test]
fn odt_preflight_blocks_active_or_linked_embeds_but_allows_inert_links() {
    use std::io::{Cursor, Write};
    let package = |content: &str| {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in [
            (
                "mimetype",
                b"application/vnd.oasis.opendocument.text".as_slice(),
            ),
            ("content.xml", content.as_bytes()),
        ] {
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap().into_inner()
    };
    for (node, allowed) in [
        ("<scripts/>", true),
        ("<scripts><macro/></scripts>", false),
        (
            "<image x:href='https://example.invalid/picture.png'/>",
            false,
        ),
        ("<image x:href='../picture.png'/>", false),
        ("<image x:href='Pictures/local.png'/>", true),
        ("<a x:href='https://example.invalid/'>citation</a>", true),
        ("<encryption-data/>", false),
    ] {
        let xml = format!("<doc xmlns:x='http://www.w3.org/1999/xlink'>{node}</doc>");
        assert_eq!(ensure_local_odt(&package(&xml)).is_ok(), allowed, "{node}");
    }
    workspace(|root| {
        let bytes=package("<doc xmlns:t='urn:oasis:names:tc:opendocument:xmlns:text:1.0'><t:p>Keep <t:span>中文</t:span></t:p></doc>");
        fs::write(root.join("source.odt"), &bytes).unwrap();
        let read = read_odt("source.odt").unwrap();
        assert_eq!(read["revision"], revision(&bytes));
        assert_eq!(read["paragraphs"][0], "Keep 中文");
        let input: OdtHighlightInput = serde_json::from_value(serde_json::json!({
            "path":"source.odt","expected_source_revision":"stale","output_path":"out.odt"
        }))
        .unwrap();
        assert!(remove_odt_highlight(&input, &mutation(), &|| false)
            .unwrap_err()
            .to_string()
            .contains("revision_conflict"));
        assert!(!root.join("out.odt").exists());
    });
}

#[test]
fn structural_deletion_checks_versions_limits_and_workspace_before_running_python() {
    workspace(|root| {
        fs::write(root.join("source.docx"), REFERENCE).unwrap();
        fs::write(root.join("existing.docx"), b"approved output").unwrap();
        let mut input: DocxDeleteParagraphsInput = serde_json::from_value(serde_json::json!({
            "path":"source.docx", "expected_source_revision":"stale", "output_path":"existing.docx",
            "deletions":[{"paragraph_id":"word/document.xml:p1", "expected_text":"verify exactly"}]
        }))
        .unwrap();
        assert!(delete_docx_paragraphs(&input, &mutation(), &|| false)
            .unwrap_err()
            .to_string()
            .contains("revision_conflict"));
        input.expected_source_revision = revision(REFERENCE);
        assert!(delete_docx_paragraphs(&input, &mutation(), &|| false)
            .unwrap_err()
            .to_string()
            .contains("revision_conflict"));
        input.output_path = "../escape.docx".into();
        assert!(delete_docx_paragraphs(&input, &mutation(), &|| false).is_err());
        input.output_path = "new.docx".into();
        input.deletions = (0..129)
            .map(|_| DocxParagraphDeletion {
                paragraph_id: "word/document.xml:p1".into(),
                expected_text: "verify exactly".into(),
            })
            .collect();
        assert!(delete_docx_paragraphs(&input, &mutation(), &|| false)
            .unwrap_err()
            .to_string()
            .contains("delete_limit"));
        input.deletions.clear();
        assert!(delete_docx_paragraphs(&input, &mutation(), &|| false)
            .unwrap_err()
            .to_string()
            .contains("delete_limit"));
        assert!(!root.join("new.docx").exists());
        assert!(!root.join(".somniq/artifacts").exists());
        assert_eq!(
            fs::read(root.join("existing.docx")).unwrap(),
            b"approved output"
        );
        assert_eq!(fs::read(root.join("source.docx")).unwrap(), REFERENCE);
    });
}

#[test]
fn pdf_export_checks_default_destination_and_keeps_existing_output_when_engine_fails() {
    workspace(|root| {
        fs::write(root.join("Original Name.docx"), REFERENCE).unwrap();
        fs::write(root.join("Original Name.pdf"), b"approved PDF").unwrap();
        let mut input: DocxPdfExportInput = serde_json::from_value(serde_json::json!({
            "path":"Original Name.docx", "expected_source_revision":"stale"
        }))
        .unwrap();
        assert!(export_docx_pdf(&input, &mutation(), &|| false)
            .unwrap_err()
            .to_string()
            .contains("revision_conflict"));
        input.expected_source_revision = revision(REFERENCE);
        assert!(export_docx_pdf(&input, &mutation(), &|| false)
            .unwrap_err()
            .to_string()
            .contains("revision_conflict"));
        input.output_path = Some("../escape.pdf".into());
        assert!(export_docx_pdf(&input, &mutation(), &|| false).is_err());
        input.output_path = Some("bad-extension.docx".into());
        assert!(export_docx_pdf(&input, &mutation(), &|| false)
            .unwrap_err()
            .to_string()
            .contains("invalid_format"));
        input.output_path = None;
        input.expected_revision = Some(revision(b"approved PDF"));
        let context = ProjectExecutionContext::new(root)
            .with_env("ARIS_WORKSPACE_ROOT", root)
            .with_env("SOMNIQ_LIBREOFFICE", root.join("missing-engine"));
        crate::with_project_execution_context(&context, || {
            assert!(export_docx_pdf(&input, &mutation(), &|| false)
                .unwrap_err()
                .to_string()
                .contains("engine_unavailable"));
        });
        assert_eq!(
            fs::read(root.join("Original Name.pdf")).unwrap(),
            b"approved PDF"
        );
        assert_eq!(
            fs::read(root.join("Original Name.docx")).unwrap(),
            REFERENCE
        );
    });
}

#[test]
fn render_failures_do_not_claim_an_engine_is_missing_when_it_failed() {
    for (kind, expected) in [
        ("cancelled", "cancelled"),
        ("engine_unavailable", "unavailable"),
        ("engine_failed", "failed"),
    ] {
        let evidence = render_failure("sha256:document".into(), failure(kind, "test failure"));
        assert_eq!(evidence.state, expected);
        assert_eq!(evidence.visual_review, "pending");
        assert!(evidence.pdf_path.is_none());
    }
}

#[test]
fn local_images_use_the_upstream_ast_and_cannot_escape_allowed_read_paths() {
    workspace(|root| {
        fs::write(root.join("figure one.png"), b"local snapshot").unwrap();
        let mut ast = serde_json::json!({"t":"Image","c":[["",[],[]],[],["figure%20one.png", ""]]});
        let mut resources = Vec::new();
        embed_local_images(&mut ast, root, &mut resources).unwrap();
        assert!(ast
            .pointer("/c/2/0")
            .unwrap()
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,"));
        assert_eq!(resources.len(), 1);
        assert_eq!(resources[0].revision, revision(b"local snapshot"));
        for target in [
            "https://example.invalid/figure.png",
            "//example.invalid/figure.png",
            "../outside.png",
        ] {
            let mut ast = serde_json::json!({"t":"Image","c":[["",[],[]],[],[target, ""]]});
            assert!(
                embed_local_images(&mut ast, root, &mut Vec::new()).is_err(),
                "{target}"
            );
        }
    });
}

#[test]
fn automatic_rendering_rejects_linked_images_and_active_parts_but_allows_hyperlinks() {
    use std::io::{Cursor, Write};
    fn package(part: &str, bytes: &[u8]) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in [("[Content_Types].xml", b"<Types/>".as_slice()),
            ("word/document.xml", b"<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body/></w:document>".as_slice()),
            (part, bytes)] {
            zip.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }
    for (kind, allowed) in [
        ("image", false),
        ("attachedTemplate", false),
        ("hyperlink", true),
    ] {
        let rel = format!(
            r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/{kind}" TargetMode="External" Target="https://example.invalid/asset"/></Relationships>"#
        );
        assert_eq!(
            crate::docx::ensure_local_render(&package(
                "word/_rels/document.xml.rels",
                rel.as_bytes()
            ))
            .is_ok(),
            allowed,
            "{kind}"
        );
    }
    assert!(crate::docx::ensure_local_render(&package("word/vbaProject.bin", b"macro")).is_err());
    assert!(crate::docx::ensure_local_render(REFERENCE).is_ok());
}

#[test]
#[ignore = "requires configured local Pandoc, LibreOffice and Python/python-docx; run in document acceptance"]
fn upstream_engines_export_native_math_format_and_render_the_exact_revision() {
    workspace(|root| {
        let text = "---\ntitle: 研究报告\n---\n\n# 验收内容\n\n保留 16 个班级和 480 名参与者。行内公式 $x_1^2+\\hat{y}$。\n\n$$\\frac{a}{b}+\\sqrt{x}$$\n\n| 项目 | 数量 |\n|:--|--:|\n| 班级 | 16 |\n";
        fs::write(root.join("source.md"), text).unwrap();
        let input = DocxExportInput {
            source_path: "source.md".into(),
            expected_source_revision: revision(text.as_bytes()),
            output_path: "result.docx".into(),
            reference_doc: None,
            expected_revision: None,
            render_pdf: true,
        };
        let result = export_docx(&input, &mutation(), &|| false).unwrap();
        assert_eq!(result.native_equation_count, 2);
        assert_eq!(result.evidence.state, "rendered", "{:?}", result.evidence);
        assert_eq!(result.evidence.visual_review, "pending");
        assert_eq!(result.evidence.document_revision, result.revision);
        assert!(result.evidence.page_count.unwrap() > 0);
        let original = fs::read(root.join("result.docx")).unwrap();
        let plan: DocxFormatInput = serde_json::from_value(serde_json::json!({
            "path":"result.docx","expected_source_revision":result.revision,"output_path":"formatted.docx","render_pdf":true,
            "operations":[{"paragraph_id":"word/document.xml:p1","alignment":"center","font_size_pt":18,"east_asia_font":"黑体"}]
        })).unwrap();
        let formatted = format_docx(&plan, &mutation(), &|| false).unwrap();
        assert_eq!(formatted.preserved_native_equations, 2);
        assert_eq!(formatted.evidence.state, "rendered");
        assert_eq!(fs::read(root.join("result.docx")).unwrap(), original);
        let bad = "Unconvertible $\\somniqUnknownCommand{x}$.";
        fs::write(root.join("bad.md"), bad).unwrap();
        let input = DocxExportInput {
            source_path: "bad.md".into(),
            expected_source_revision: revision(bad.as_bytes()),
            output_path: "result.docx".into(),
            expected_revision: Some(result.revision),
            reference_doc: None,
            render_pdf: false,
        };
        assert!(export_docx(&input, &mutation(), &|| false).is_err());
        assert_eq!(fs::read(root.join("result.docx")).unwrap(), original);
    });
}
