use super::*;
use crate::{
    compile_latex_document, latex_compile_timeout_ms, latex_repair_guidance, run_latex_process,
    LatexCompileBudget, LatexCompileRequest, LATEX_COMPILE_TIMEOUT_ENV,
};
use std::path::Path;
use std::time::Instant;

#[test]
fn latex_timeout_is_independent_of_shell_and_can_be_overridden() {
    let _lock = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let _latex_timeout = EnvGuard::unset(LATEX_COMPILE_TIMEOUT_ENV);
    let _shell_timeout = EnvGuard::set("ARIS_SHELL_DEFAULT_TIMEOUT_MS", "120000");
    assert_eq!(latex_compile_timeout_ms(None), 600_000);
    assert_eq!(latex_compile_timeout_ms(Some(1_800_000)), 1_800_000);

    let _override = EnvGuard::set(LATEX_COMPILE_TIMEOUT_ENV, "900000");
    assert_eq!(latex_compile_timeout_ms(None), 900_000);
    assert_eq!(latex_compile_timeout_ms(Some(45_000)), 45_000);
}

#[test]
fn latex_timeout_rejects_invalid_default_overrides() {
    let _lock = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    for value in ["", "0", "-1", "forever"] {
        let _override = EnvGuard::set(LATEX_COMPILE_TIMEOUT_ENV, value);
        assert_eq!(latex_compile_timeout_ms(None), 600_000, "{value}");
    }
}

#[test]
fn latex_process_uses_the_remaining_build_budget() {
    let budget = LatexCompileBudget {
        started: Instant::now() - Duration::from_secs(4),
        timeout: Duration::from_millis(4_100),
    };
    #[cfg(windows)]
    let mut command = {
        let mut command = runtime::hidden_command("cmd");
        command.args(["/d", "/c", "ping -n 11 127.0.0.1 > nul"]);
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = runtime::hidden_command("sh");
        command.args(["-c", "sleep 10"]);
        command
    };
    let workspace = std::env::temp_dir();
    let started = Instant::now();
    let output = run_latex_process(
        &mut command,
        "test-compiler",
        &workspace.join("main.tex"),
        &workspace,
        &budget,
        &|| false,
        &mut |_| {},
    )
    .expect("managed compile process");
    assert!(output.timed_out);
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "a new pass reset the time budget"
    );
    assert!(budget.remaining().is_zero());
}

#[test]
fn latex_timeout_with_only_generated_file_notices_needs_no_source_edit() {
    let diagnostics = extract_latex_diagnostics(
        "No file main.toc.\nNo file main.lof.\nNo file main.lot.\nNo file main.bbl.",
        "Latexmk: Missing input file 'main.toc'\nLaTeXCompile exceeded timeout of 120000 ms",
        false,
        Some("timeout"),
    );
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].code, "compile_timeout");
    assert_eq!(diagnostics[0].file_path, None);
    assert_eq!(diagnostics[0].line, None);
    let guidance = latex_repair_guidance(&diagnostics);
    assert!(guidance.contains("increase timeoutMs"));
    assert!(!guidance.contains("smallest source change"));
}

#[test]
fn latex_source_error_stays_primary_even_when_build_times_out() {
    let diagnostics = extract_latex_diagnostics(
        "./main.tex:70: Extra alignment tab has been changed to \\cr.",
        "LaTeXCompile exceeded timeout of 120000 ms",
        false,
        Some("timeout"),
    );
    assert_eq!(diagnostics[0].line, Some(70));
    // The code describes the error, as it does without -file-line-error, so
    // the log panel can offer the table-specific guidance.
    assert_eq!(diagnostics[0].code, "table_alignment");
    assert!(latex_repair_guidance(&diagnostics).contains("smallest source change"));
}

#[test]
fn diagnostics_come_from_the_final_pass_log_not_every_pass() {
    // latexmk's stdout carries pass 1's notices; the final .log has none.
    let stdout = "LaTeX Warning: Citation `smoke' on page 1 undefined on input line 4.\nLaTeX Warning: There were undefined references.";
    let final_log = "This is pdfTeX\n(./main.tex\nOutput written on main.pdf (1 page).\n)";
    let diagnostics = crate::extract_latex_diagnostics_from(stdout, "", Some(final_log), None, true, None);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    // Without a log (the engine never ran far enough) stdout is still read.
    assert_eq!(crate::extract_latex_diagnostics_from(stdout, "", None, None, true, None).len(), 2);
}

#[test]
fn warnings_and_bad_boxes_are_attributed_to_the_file_tex_was_reading() {
    let log = [
        "(./main.tex (c:/texlive/2025/texmf-dist/tex/latex/base/article.cls",
        "Document Class: article 2024/06/29 v1.4n Standard LaTeX document class",
        "(c:/texlive/2025/texmf-dist/tex/latex/base/size10.clo))",
        "(./chapters/intro.tex",
        "LaTeX Warning: Reference `fig:missing' on page 1 undefined on input line 7.",
        "Package hyperref Warning: Token not allowed in a PDF string (Unicode):",
        "(hyperref)                removing `math shift' on input line 9.",
        "Overfull \\hbox (12.0pt too wide) in paragraph at lines 12--14",
        ")",
        "LaTeX Warning: Label `x' multiply defined on input line 30.",
        ")",
    ]
    .join("\n");
    let diagnostics = crate::extract_latex_diagnostics_from("", "", Some(&log), None, true, None);
    let found = |needle: &str| {
        diagnostics
            .iter()
            .find(|diagnostic| diagnostic.message.contains(needle))
            .unwrap_or_else(|| panic!("{needle} missing from {diagnostics:?}"))
    };
    assert_eq!(found("fig:missing").file_path.as_deref(), Some("./chapters/intro.tex"));
    assert_eq!(found("fig:missing").line, Some(7));
    // The "on input line" of a package warning sits on its continuation line.
    assert_eq!(found("Token not allowed").line, Some(9));
    assert_eq!(found("Token not allowed").file_path.as_deref(), Some("./chapters/intro.tex"));
    let overfull = found("Overfull");
    assert_eq!((overfull.severity.as_str(), overfull.code.as_str()), ("info", "bad_box"));
    assert_eq!((overfull.file_path.as_deref(), overfull.line), (Some("./chapters/intro.tex"), Some(12)));
    // After the chapter closes, TeX is back in the root file.
    assert_eq!(found("multiply defined").file_path.as_deref(), Some("./main.tex"));
}

#[test]
fn absolute_project_paths_from_an_output_directory_build_become_relative() {
    // With an absolute -output-directory TeX names the project's own files by
    // absolute path; the TeX tree's packages stay unattributed.
    let project = Path::new("C:/Users/me/paper");
    let log = [
        "(C:\\Users\\me\\paper/main.tex (e:/texlive/2025/texmf-dist/tex/latex/base/article.cls)",
        "(C:\\Users\\me\\paper/chapters/intro.tex",
        "LaTeX Warning: Reference `fig:x' on page 1 undefined on input line 3.",
        "C:\\Users\\me\\paper/chapters/intro.tex:5: Undefined control sequence.",
        "))",
    ]
    .join("\n");
    let diagnostics = crate::extract_latex_diagnostics_from("", "", Some(&log), Some(project), false, Some("exit_code:1"));
    let error = diagnostics.iter().find(|diagnostic| diagnostic.severity == "error").expect("error");
    assert_eq!(error.file_path.as_deref(), Some("./chapters/intro.tex"));
    let warning = diagnostics.iter().find(|diagnostic| diagnostic.severity == "warning").expect("warning");
    assert_eq!(warning.file_path.as_deref(), Some("./chapters/intro.tex"));
    assert_eq!(
        crate::latex_project_relative_path("e:/texlive/2025/texmf-dist/tex/latex/base/article.cls", Some(project)),
        None
    );
}

#[test]
fn errors_inside_bibliographies_and_packages_are_kept() {
    let log = "./main.bbl:23: Undefined control sequence.\n./thesis.cls:120: LaTeX Error: Missing \\begin{document}.";
    let diagnostics = crate::extract_latex_diagnostics_from("", "", Some(log), None, false, Some("exit_code:1"));
    assert_eq!(diagnostics[0].file_path.as_deref(), Some("./main.bbl"));
    assert_eq!(diagnostics[0].code, "undefined_control_sequence");
    assert_eq!(diagnostics[1].file_path.as_deref(), Some("./thesis.cls"));
    assert!(diagnostics.iter().all(|diagnostic| diagnostic.code != "compile_failed"));
}

#[test]
fn bibtex_and_biber_problems_become_diagnostics() {
    let stdout = [
        "This is BibTeX, Version 0.99d",
        "I was expecting a `,' or a `}'---line 5 of file refs.bib",
        "Warning--I didn't find a database entry for \"missing2020\"",
        "I couldn't open database file nothere.bib",
        "ERROR - Cannot find 'other.bib'!",
        "WARN - Duplicate entry key 'smoke' in file 'refs.bib', skipping ...",
    ]
    .join("\n");
    let diagnostics = crate::extract_latex_diagnostics_from(&stdout, "", Some(""), None, false, Some("exit_code:12"));
    let syntax = diagnostics.iter().find(|diagnostic| diagnostic.line == Some(5)).expect("syntax error");
    assert_eq!(syntax.file_path.as_deref(), Some("refs.bib"));
    assert_eq!(syntax.severity, "error");
    assert!(diagnostics.iter().any(|diagnostic| diagnostic.message.contains("missing2020") && diagnostic.severity == "warning"));
    assert!(diagnostics.iter().any(|diagnostic| diagnostic.message.contains("nothere.bib")));
    assert!(diagnostics.iter().any(|diagnostic| diagnostic.message.starts_with("biber: Cannot find")));
    assert!(diagnostics.iter().any(|diagnostic| diagnostic.message.starts_with("biber: Duplicate")));
    assert!(diagnostics.iter().all(|diagnostic| diagnostic.code != "compile_failed"));
}

#[test]
fn many_warnings_do_not_crowd_out_an_error() {
    let mut log = (0..15)
        .map(|index| format!("LaTeX Warning: Reference `r{index}' on page 1 undefined on input line {index}."))
        .collect::<Vec<_>>();
    log.push("./main.tex:40: Undefined control sequence.".to_string());
    let diagnostics = crate::extract_latex_diagnostics_from("", "", Some(&log.join("\n")), None, false, Some("exit_code:1"));
    assert_eq!(diagnostics.iter().filter(|diagnostic| diagnostic.severity == "error").count(), 1);
    assert_eq!(diagnostics.iter().filter(|diagnostic| diagnostic.severity == "warning").count(), 15);
}

#[test]
fn engine_detection_reads_gbk_roots_and_the_preamble_s_local_files() {
    let root = temp_path("latex-engine-detection");
    fs::create_dir_all(&root).expect("workspace");
    // A GBK root used to fail `read_to_string` and fall back to pdflatex,
    // magic comment and all.
    let (gbk, _, _) = encoding_rs::GBK.encode("% !TeX program = xelatex\n\\documentclass{article}\n\\begin{document}中文\\end{document}\n");
    fs::write(root.join("gbk.tex"), &gbk).expect("gbk root");
    assert_eq!(crate::preferred_latex_engine(&root.join("gbk.tex")), LatexEnginePreference::XeLatex);

    fs::write(root.join("preamble.tex"), "\\usepackage[UTF8]{ctex}\n").expect("preamble");
    fs::write(root.join("thesis.tex"), "\\documentclass{book}\n\\input{preamble}\n\\begin{document}\\end{document}\n").expect("thesis");
    assert_eq!(crate::preferred_latex_engine(&root.join("thesis.tex")), LatexEnginePreference::XeLatex);

    fs::write(root.join("uniThesis.cls"), "\\LoadClass{book}\n\\RequirePackage{fontspec}\n").expect("class");
    fs::write(root.join("main.tex"), "\\documentclass{uniThesis}\n\\begin{document}\\end{document}\n").expect("main");
    assert_eq!(crate::preferred_latex_engine(&root.join("main.tex")), LatexEnginePreference::XeLatex);

    fs::write(root.join("plain.tex"), "\\documentclass{article}\n\\begin{document}Hi\\end{document}\n").expect("plain");
    assert_eq!(crate::preferred_latex_engine(&root.join("plain.tex")), LatexEnginePreference::PdfLatex);
    fs::remove_dir_all(root).expect("cleanup fixture");
}

#[test]
fn package_refusals_of_pdflatex_ask_for_a_unicode_engine() {
    for message in [
        "! Package xeCJK Error: The xeCJK package only supports XeTeX.",
        "! Package unicode-math Error: Cannot be run with pdfLaTeX!",
        "! Fatal Package fontspec Error: The fontspec package requires either XeTeX or LuaTeX.",
    ] {
        assert!(crate::latex_text_needs_unicode_engine(&message.to_ascii_lowercase()), "{message}");
    }
    assert!(!crate::latex_text_needs_unicode_engine("! undefined control sequence."));
}

#[test]
fn a_chapter_compile_builds_the_main_document_typeset_was_told_about() {
    let root = temp_path("latex-project-settings").canonicalize_or_create();
    fs::create_dir_all(root.join("chapters")).expect("workspace");
    fs::write(root.join("thesis.tex"), "\\documentclass{book}\n\\begin{document}\\input{chapters/ch1}\\end{document}\n").expect("root");
    fs::write(root.join("chapters/ch1.tex"), "\\chapter{One}\n").expect("chapter");
    fs::write(root.join("standalone.tex"), "\\documentclass{standalone}\n\\begin{document}x\\end{document}\n").expect("figure");

    assert_eq!(crate::read_latex_project_settings(&root), crate::LatexProjectSettings::default());
    let settings = crate::LatexProjectSettings {
        main_document: Some("thesis.tex".to_string()),
        engine: Some("xelatex".to_string()),
    };
    crate::write_latex_project_settings(&root, &settings).expect("write settings");
    assert_eq!(crate::read_latex_project_settings(&root), settings);

    let (target, note) = crate::latex_compile_target(&root.join("chapters/ch1.tex"), &root, &settings);
    assert_eq!(target, root.join("thesis.tex"));
    assert!(note.expect("note").contains("thesis.tex"));
    // A document of its own is built as asked.
    let (target, note) = crate::latex_compile_target(&root.join("standalone.tex"), &root, &settings);
    assert_eq!((target, note), (root.join("standalone.tex"), None));

    // Unknown engines in a hand-edited file are ignored, not passed to TeX.
    fs::write(crate::latex_project_settings_path(&root), r#"{"engine":"tectonic"}"#).expect("edit");
    assert_eq!(crate::read_latex_project_settings(&root).engine, None);
    fs::remove_dir_all(root).expect("cleanup fixture");
}

trait CanonicalizeOrCreate {
    fn canonicalize_or_create(self) -> PathBuf;
}

impl CanonicalizeOrCreate for PathBuf {
    fn canonicalize_or_create(self) -> PathBuf {
        fs::create_dir_all(&self).expect("create");
        runtime::canonicalize(&self).expect("canonical")
    }
}

#[test]
fn clearing_the_cache_reaches_included_chapters_and_minted() {
    let root = temp_path("latex-cache-clean");
    fs::create_dir_all(root.join("chapters")).expect("workspace");
    for (path, body) in [
        ("main.tex", "root"),
        ("main.aux", "aux"),
        ("main.auxlock", "lock"),
        ("chapters/intro.tex", "chapter"),
        ("chapters/intro.aux", "chapter aux"),
        ("notes/orphan.aux", "no source: left alone"),
        ("_minted-main/abc.pygtex", "cache"),
    ] {
        let path = root.join(path);
        fs::create_dir_all(path.parent().expect("parent")).expect("parent");
        fs::write(path, body).expect("fixture");
    }
    let removed = crate::remove_known_latex_cache_files(&root.join("main.tex"), &root).expect("clean");
    assert_eq!(removed, 4);
    assert!(!root.join("chapters/intro.aux").exists());
    assert!(!root.join("main.auxlock").exists());
    assert!(!root.join("_minted-main").exists());
    assert!(root.join("notes/orphan.aux").exists());
    assert!(root.join("chapters/intro.tex").exists());
    fs::remove_dir_all(root).expect("cleanup fixture");
}

#[test]
fn waiting_for_a_busy_output_folder_answers_cancel_and_the_budget() {
    let lock = std::sync::Mutex::new(());
    let _held = lock.lock().expect("held by another build");
    let budget = LatexCompileBudget { started: Instant::now(), timeout: Duration::from_secs(60) };
    let started = Instant::now();
    let mut progress = Vec::new();
    let cancelled = crate::wait_for_latex_output_directory(&lock, &budget, &|| true, &mut |update| progress.push(update));
    assert!(matches!(cancelled, Err(false)));
    assert!(started.elapsed() < Duration::from_secs(2));

    let spent = LatexCompileBudget { started: Instant::now() - Duration::from_secs(5), timeout: Duration::from_secs(1) };
    assert!(matches!(crate::wait_for_latex_output_directory(&lock, &spent, &|| false, &mut |_| {}), Err(true)));
}

#[test]
fn a_pdf_rewritten_by_a_build_that_later_failed_is_partial_not_stale() {
    let before = LatexOutputFingerprint { length: 100, modified: None };
    let after = LatexOutputFingerprint { length: 120, modified: None };
    // halt-on-error (continue_on_error = false): BibTeX failed after TeX wrote the PDF.
    assert_eq!(
        latex_pdf_state(false, false, false, false, Some(&before), Some(&after), true),
        LatexPdfState::Partial
    );
}

#[test]
#[ignore = "requires a local TeX Live installation"]
fn real_logs_attribute_warnings_to_included_chapters() {
    let root = temp_path("latex-log-attribution");
    fs::create_dir_all(root.join("chapters")).expect("workspace");
    fs::write(
        root.join("main.tex"),
        "\\documentclass{article}\n\\begin{document}\n\\input{chapters/intro}\n\\end{document}\n",
    )
    .expect("root");
    fs::write(
        root.join("chapters/intro.tex"),
        "See Figure~\\ref{fig:missing}.\n\n\\hbox to 10pt{Overfull overfull overfull overfull overfull}\n",
    )
    .expect("chapter");
    let output = compile_latex_document(
        LatexCompileRequest {
            input_path: root.join("main.tex"),
            output_path: root.join("main.pdf"),
            compiler: Some("pdflatex".to_string()),
            engine: None,
            timeout_ms: None,
            clean_cache: false,
            continue_on_error: false,
        },
        &root,
        &|| false,
        &mut |_| {},
    )
    .expect("compile");
    let reference = output
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.message.contains("fig:missing"))
        .unwrap_or_else(|| panic!("{:?}", output.diagnostics));
    assert_eq!(
        reference.file_path.as_deref(),
        Some("./chapters/intro.tex"),
        "{:?}\n--- log ---\n{}",
        output.diagnostics,
        fs::read_to_string(root.join("main.log")).unwrap_or_default()
    );
    assert_eq!(reference.line, Some(1));
    assert!(
        output.diagnostics.iter().any(|diagnostic| diagnostic.code == "bad_box"
            && diagnostic.file_path.as_deref() == Some("./chapters/intro.tex")),
        "{:?}",
        output.diagnostics
    );
    fs::remove_dir_all(root).expect("cleanup fixture");
}

#[test]
fn latex_cancelled_and_unlocated_failures_do_not_request_source_edits() {
    for status in ["interrupted", "exit_code:1"] {
        let diagnostics = extract_latex_diagnostics("", "", false, Some(status));
        assert!(!latex_repair_guidance(&diagnostics).contains("smallest source change"));
    }
}

#[test]
#[ignore = "requires a local TeX Live installation"]
fn latex_local_texlive_smoke_builds_generated_auxiliaries() {
    let root = temp_path("latex-multipass-smoke");
    fs::create_dir_all(&root).expect("workspace");
    fs::write(
        root.join("main.tex"),
        concat!(
            "\\documentclass{article}\n\\begin{document}\n",
            "\\tableofcontents\n\\listoffigures\n\\listoftables\n",
            "\\section{Smoke test}\nCompiler fixture~\\cite{smoke}.\n",
            "\\bibliographystyle{plain}\n\\bibliography{references}\n\\end{document}\n",
        ),
    )
    .expect("source");
    fs::write(
        root.join("references.bib"),
        "@misc{smoke, title={Compiler fixture}, author={Test}, year={2026}}\n",
    )
    .expect("bibliography");
    let output = compile_latex_document(
        LatexCompileRequest {
            input_path: root.join("main.tex"),
            output_path: root.join("main.pdf"),
            compiler: Some("latexmk".to_string()),
            engine: None,
            timeout_ms: None,
            clean_cache: false,
            continue_on_error: false,
        },
        &root,
        &|| false,
        &mut |_| {},
    )
    .expect("compile");
    assert!(output.success, "{}\n{}", output.stdout, output.stderr);
    assert_eq!(output.pdf_state, LatexPdfState::Fresh);
    for extension in ["pdf", "toc", "lof", "lot", "bbl"] {
        assert!(
            root.join(format!("main.{extension}")).is_file(),
            "{extension}"
        );
    }
    fs::remove_dir_all(root).expect("cleanup fixture");
}

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
fn latex_diagnostics_keep_failed_builds_visible_when_warnings_are_present() {
    let diagnostics = extract_latex_diagnostics(
        "LaTeX Warning: Citation missing on input line 12.",
        "",
        false,
        Some("exit_code:1"),
    );

    assert_eq!(diagnostics[0].severity, "error");
    assert_eq!(diagnostics[0].code, "compile_failed");
    assert!(diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == "warning"));
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
    // This rejection is the first thing a model sees when it asks to compile a
    // file outside the workspace, and it used to name both paths in Windows'
    // `\\?\` form. A model that copies one into a shell command loses a
    // backslash to the quoting rules and gets exit 127 from `\?\...`.
    assert!(
        !error.contains(r"\\?\"),
        "rejection leaked a path no shell can quote: {error}"
    );

    let _ = fs::remove_dir_all(workspace);
    let _ = fs::remove_file(absolute_outside);
}

#[test]
fn latex_compile_rejection_hands_back_a_path_a_shell_can_actually_run() {
    let _lock = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let workspace = temp_path("latex-reject-workspace");
    fs::create_dir_all(&workspace).expect("workspace");
    let _workspace_root = EnvGuard::set(ARIS_WORKSPACE_ROOT_ENV, &workspace);

    // The reported failure: a paper outside the workspace, whose rejection the
    // model then worked around by shelling out to the path the rejection named.
    let outside = temp_path("latex-reject-outside");
    fs::create_dir_all(&outside).expect("outside");
    let paper = outside.join("Response_to_Reviewers.tex");
    fs::write(&paper, b"\\documentclass{article}").expect("paper");

    let error = execute_tool("LaTeXCompile", &json!({ "inputPath": paper }))
        .expect_err("a paper outside the workspace must be rejected");

    assert!(error.contains("outside the current workspace"), "{error}");
    // Both real paths are named, so the check below is about their spelling
    // rather than an empty message that trivially contains no prefix.
    assert!(error.contains("Response_to_Reviewers.tex"), "{error}");
    assert!(error.contains("latex-reject-workspace"), "{error}");
    assert!(
        !error.contains(r"\\?\") && !error.contains("//?/"),
        "rejection named a path that dies in a shell as `\\?\\...`: {error}"
    );

    let _ = fs::remove_dir_all(workspace);
    let _ = fs::remove_dir_all(outside);
}

#[cfg(windows)]
#[test]
fn latex_workspace_boundary_ignores_which_path_spelling_the_caller_holds() {
    let workspace = temp_path("latex-verbatim-workspace");
    fs::create_dir_all(workspace.join("papers")).expect("workspace");
    let paper = workspace.join("papers").join("main.tex");
    fs::write(&paper, b"\\documentclass{article}").expect("paper");
    let canonical = runtime::canonicalize(&workspace).expect("canonical workspace");

    // A caller holding the verbatim spelling of the root must still recognize
    // its own children; comparing mixed forms would reject every one of them.
    let verbatim_root = PathBuf::from(format!(r"\\?\{}", canonical.display()));
    let resolved = resolve_existing_workspace_path(&paper.display().to_string(), &verbatim_root)
        .expect("a file inside the workspace must resolve whichever spelling the root uses");
    assert!(resolved.ends_with("main.tex"));
    assert!(!resolved.to_string_lossy().starts_with(r"\\?\"));

    let _ = fs::remove_dir_all(workspace);
}

#[test]
fn latex_output_parent_traversal_is_rejected_before_create() {
    let root = temp_path("latex-output-root");
    let workspace = root.join("workspace");
    let outside = root.join("outside");
    fs::create_dir_all(workspace.join("papers")).expect("workspace");
    let workspace = runtime::canonicalize(&workspace).expect("canonical workspace");

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

#[test]
fn direct_engine_path_picks_the_bibliography_tool_the_first_pass_asked_for() {
    let root = temp_path("latex-aux-tools");
    let source = root.join("paper");
    let output = root.join("build");
    fs::create_dir_all(&source).expect("source dir");
    fs::create_dir_all(&output).expect("output dir");
    let input = source.join("main.tex");
    let programs = |tools: &[crate::LatexAuxiliaryTool]| tools.iter().map(|tool| tool.program).collect::<Vec<_>>();

    assert!(crate::latex_auxiliary_tools(&input, &source, &output).is_empty(), "no .aux yet");

    fs::write(output.join("main.aux"), "\\relax\n\\citation{smoke}\n\\bibstyle{plain}\n\\bibdata{refs}\n").expect("aux");
    let tools = crate::latex_auxiliary_tools(&input, &source, &output);
    assert_eq!(programs(&tools), vec!["bibtex"]);
    // BibTeX runs beside the .aux and finds the author's .bib via BIBINPUTS.
    assert_eq!(tools[0].current_dir, output);
    let bibinputs = tools[0].env.iter().find(|(name, _)| *name == "BIBINPUTS").expect("BIBINPUTS");
    assert!(bibinputs.1.to_string_lossy().starts_with(&*source.to_string_lossy()));

    // A .bcf left behind by an earlier biblatex build must not trigger biber.
    fs::write(output.join("main.bcf"), "<bcf/>").expect("bcf");
    fs::write(output.join("main.aux"), "\\relax\n").expect("aux");
    assert!(crate::latex_auxiliary_tools(&input, &source, &output).is_empty());

    fs::write(output.join("main.aux"), "\\relax\n\\abx@aux@refcontext{nty/global//global/global}\n\\abx@aux@cite{0}{smoke}\n").expect("aux");
    fs::write(output.join("main.idx"), "\\indexentry{term}{1}\n").expect("idx");
    let tools = crate::latex_auxiliary_tools(&input, &source, &output);
    assert_eq!(programs(&tools), vec!["biber", "makeindex"]);
    assert_eq!(tools[0].current_dir, source, "biber resolves \\addbibresource from the source folder");

    let _ = fs::remove_dir_all(root);
}

#[test]
fn rerun_notices_ask_for_another_engine_pass() {
    assert!(crate::latex_output_requests_rerun(
        b"LaTeX Warning: Label(s) may have changed. Rerun to get cross-references right."
    ));
    assert!(crate::latex_output_requests_rerun(b"Package biblatex Warning: Please rerun LaTeX."));
    assert!(!crate::latex_output_requests_rerun(b"Output written on main.pdf (1 page)."));
}

fn direct_engine_bibliography_smoke(label: &str, preamble: &str, bibliography: &str) {
    let root = temp_path(label);
    fs::create_dir_all(&root).expect("workspace");
    fs::write(
        root.join("main.tex"),
        format!(
            "\\documentclass{{article}}\n{preamble}\\begin{{document}}\nSee~\\cite{{smoke}}.\n{bibliography}\\end{{document}}\n"
        ),
    )
    .expect("source");
    fs::write(
        root.join("references.bib"),
        "@misc{smoke, title={Compiler fixture}, author={Test Author}, year={2026}}\n",
    )
    .expect("bibliography");
    let output = compile_latex_document(
        LatexCompileRequest {
            input_path: root.join("main.tex"),
            output_path: root.join("main.pdf"),
            compiler: Some("pdflatex".to_string()),
            engine: None,
            timeout_ms: None,
            clean_cache: false,
            continue_on_error: false,
        },
        &root,
        &|| false,
        &mut |_| {},
    )
    .expect("compile");
    assert!(output.success, "{}\n{}", output.stdout, output.stderr);
    assert!(root.join("main.bbl").is_file(), "bibliography was not built\n{}", output.stdout);
    assert!(
        !output.stdout.contains("undefined"),
        "the final pass still reports undefined citations\n{}",
        output.stdout
    );
    fs::remove_dir_all(root).expect("cleanup fixture");
}

#[test]
#[ignore = "requires a local TeX Live installation"]
fn direct_engine_runs_bibtex_without_latexmk() {
    direct_engine_bibliography_smoke(
        "latex-direct-bibtex",
        "",
        "\\bibliographystyle{plain}\n\\bibliography{references}\n",
    );
}

#[test]
#[ignore = "requires a local TeX Live installation"]
fn direct_engine_runs_biber_without_latexmk() {
    direct_engine_bibliography_smoke(
        "latex-direct-biber",
        "\\usepackage{biblatex}\n\\addbibresource{references.bib}\n",
        "\\printbibliography\n",
    );
}
