use super::*;

#[test]
fn latex_compile_prefers_unicode_engine_for_ctex_source() {
    let path = temp_path("ctex-report.tex");
    fs::write(
        &path,
        "\\documentclass{ctexart}\n\\begin{document}测试\\end{document}",
    )
    .expect("write source");

    assert_eq!(
        preferred_latex_engine(&path),
        LatexEnginePreference::XeLatex
    );
    let _ = fs::remove_file(path);
}

#[cfg(target_os = "windows")]
#[test]
fn latex_compile_strips_windows_extended_path_prefix_for_tex_tools() {
    let tool_path = tex_tool_path(&PathBuf::from(r"\\?\C:\Users\wt\workspace\papers"));
    assert_eq!(tool_path, PathBuf::from(r"C:\Users\wt\workspace\papers"));
}

#[test]
fn latex_diagnostics_identify_primary_table_error_and_source_line() {
    let diagnostics = extract_latex_diagnostics(
        "! Extra alignment tab has been changed to \\cr.\nl.70  2026 & evidence & conclusion & unexpected \\\\ ",
        "",
        false,
        Some("exit_code:1"),
    );

    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].code, "table_alignment");
    assert_eq!(diagnostics[0].line, Some(70));
}

#[test]
fn latex_diagnostics_preserve_warnings_and_their_source_line() {
    let diagnostics = extract_latex_diagnostics(
        "LaTeX Warning: Citation `missing' on input line 12.",
        "",
        true,
        None,
    );

    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].severity, "warning");
    assert_eq!(diagnostics[0].line, Some(12));
}

#[test]
fn latex_pdf_provenance_never_treats_an_unchanged_old_pdf_as_current() {
    let before = LatexOutputFingerprint {
        length: 100,
        modified: None,
    };
    assert_eq!(
        latex_pdf_state(
            false,
            true,
            false,
            false,
            Some(&before),
            Some(&before),
            true
        ),
        LatexPdfState::Stale
    );
    assert_eq!(
        latex_pdf_state(false, true, false, false, Some(&before), None, false),
        LatexPdfState::Missing
    );
    assert_eq!(
        latex_pdf_state(
            false,
            true,
            false,
            false,
            Some(&before),
            Some(&LatexOutputFingerprint {
                length: 101,
                modified: None,
            }),
            true,
        ),
        LatexPdfState::Partial
    );
    assert_eq!(
        latex_pdf_state(
            true,
            false,
            false,
            false,
            Some(&before),
            Some(&before),
            true
        ),
        LatexPdfState::Fresh
    );
}

#[test]
fn latex_input_changes_mark_the_pdf_stale_without_reclassifying_a_successful_compile() {
    let before = LatexOutputFingerprint {
        length: 100,
        modified: None,
    };
    let after = LatexOutputFingerprint {
        length: 101,
        modified: None,
    };

    assert_eq!(
        latex_pdf_state_after_compile(
            true,
            true,
            false,
            false,
            false,
            Some(&before),
            Some(&after),
            true,
        ),
        LatexPdfState::Stale,
    );
}

#[test]
fn latex_input_manifest_covers_transitive_sources_bibliography_and_figures() {
    let root = temp_path("latex-input-manifest");
    fs::create_dir_all(root.join("chapters")).expect("chapters");
    fs::create_dir_all(root.join("figures")).expect("figures");
    fs::write(
        root.join("main.tex"),
        "\\documentclass{article}\n\\input{chapters/intro}\n\\addbibresource{references.bib}",
    )
    .expect("main");
    fs::write(
        root.join("chapters/intro.tex"),
        "\\includegraphics{figures/chart}",
    )
    .expect("chapter");
    fs::write(root.join("references.bib"), "@article{x,title={X}}").expect("bib");
    fs::write(root.join("figures/chart.png"), b"png-bytes").expect("figure");
    let workspace = fs::canonicalize(&root).expect("workspace");
    let input = workspace.join("main.tex");

    let snapshot = latex_input_snapshot(&input, &workspace);
    assert_eq!(snapshot.len(), 4);
    let hash = latex_input_manifest_hash(&snapshot, &workspace);
    assert_eq!(hash.len(), 64);
    assert!(!latex_input_snapshot_changed(&snapshot));

    // TeX's recorder and lock files live alongside sources but are never part
    // of the dependency manifest, so compiler housekeeping cannot stale a PDF.
    fs::write(workspace.join("main.fls"), "INPUT main.tex").expect("recorder");
    fs::write(workspace.join("main.aux.lock"), "busy").expect("lock");
    assert!(!latex_input_snapshot_changed(&snapshot));

    fs::write(workspace.join("chapters/intro.tex"), "changed").expect("change input");
    assert!(latex_input_snapshot_changed(&snapshot));
    fs::remove_dir_all(root).expect("cleanup");
}

#[test]
fn latex_input_manifest_accepts_windows_style_input_paths() {
    let root = temp_path("latex-windows-input-path");
    fs::create_dir_all(root.join("chapters")).expect("chapters");
    fs::write(root.join("main.tex"), r"\input{chapters\intro}").expect("main");
    fs::write(root.join("chapters/intro.tex"), "Chapter body").expect("chapter");
    let workspace = fs::canonicalize(&root).expect("workspace");

    let snapshot = latex_input_snapshot(&workspace.join("main.tex"), &workspace);

    assert_eq!(snapshot.len(), 2);
    fs::remove_dir_all(root).expect("cleanup");
}

#[test]
fn repl_rejects_tex_compiler_workarounds() {
    assert!(repl_invokes_latex_compiler(
        "subprocess.run(['lualatex', '-halt-on-error', 'report.tex'])"
    ));
    assert!(!repl_invokes_latex_compiler(
        "print('analyse a UTF-8 text file')"
    ));
    assert!(!repl_invokes_latex_compiler(
        "print('lualatex appeared in an existing compiler log')"
    ));
}

#[test]
fn latex_renderer_escapes_data_and_keeps_table_shape_in_template() {
    let data = json!({
        "title": "A&B_2026",
        "rows": [{ "label": "Revenue%", "value": "10#" }]
    });
    let template = "\\section*{ {{title}} }\n\\begin{tabular}{ll}\n{{#each rows}}{{this.label}} & {{this.value}} \\\\n{{/each}}\\end{tabular}\n";
    let rendered = render_latex_template(template, &data, None, None).expect("render");

    assert!(rendered.contains("A\\&B\\_2026"));
    assert!(rendered.contains("Revenue\\% & 10\\#"));
    assert!(rendered.contains("\\begin{tabular}{ll}"));
}

#[test]
fn latex_workspace_paths_cannot_escape_workspace() {
    let workspace = temp_path("latex-workspace");
    fs::create_dir_all(&workspace).expect("workspace");

    let inside = workspace_path_candidate("papers/main.tex", &workspace)
        .expect("relative path inside workspace");
    assert!(inside.ends_with("papers/main.tex"));

    let escaped = workspace_path_candidate("../outside.tex", &workspace)
        .expect_err("parent traversal should be rejected");
    assert!(escaped.contains("escapes"));

    let absolute_outside = temp_path("outside.tex");
    fs::write(&absolute_outside, b"\\documentclass{article}").expect("outside file");
    let error =
        resolve_existing_workspace_path(&absolute_outside.display().to_string(), &workspace)
            .expect_err("absolute path outside workspace should be rejected");
    assert!(error.contains("outside the current workspace"));

    let _ = fs::remove_dir_all(workspace);
    let _ = fs::remove_file(absolute_outside);
}

#[test]
fn latex_output_parent_traversal_is_rejected_before_create() {
    let root = temp_path("latex-output-root");
    let workspace = root.join("workspace");
    let outside = root.join("outside");
    fs::create_dir_all(workspace.join("papers")).expect("workspace");
    let workspace = fs::canonicalize(&workspace).expect("canonical workspace");

    let escaped = workspace
        .join("papers")
        .join("..")
        .join("..")
        .join("outside")
        .join("out.pdf");
    let error = resolve_output_workspace_path(&escaped.display().to_string(), &workspace)
        .expect_err("escaped output path should be rejected");
    assert!(error.contains("outside the current workspace"));
    assert!(
        !outside.exists(),
        "escaped output directory must not be created before rejection"
    );

    let _ = fs::remove_dir_all(root);
}
