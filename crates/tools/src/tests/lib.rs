use std::collections::BTreeSet;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use super::team_state;
use super::{
    agent_permission_policy, allowed_tools_for_subagent, discover_skills, execute_agent_with_spawn,
    execute_tool, execute_tool_with_cancel, execute_tool_with_context, extract_latex_diagnostics,
    final_assistant_text, latex_input_manifest_hash, latex_input_snapshot,
    latex_input_snapshot_changed, latex_pdf_state, mvp_tool_specs, persist_agent_terminal_state,
    preferred_latex_engine, render_latex_template, repl_invokes_latex_compiler,
    resolve_anthropic_compat_reviewer_model, resolve_existing_workspace_path,
    resolve_output_workspace_path, resolve_reviewer_model, route_openai_compat_model,
    run_llm_review, skill_markdown, tex_tool_path, workspace_path_candidate, AgentInput, AgentJob,
    LatexEnginePreference, LatexOutputFingerprint, LatexPdfState, LlmReviewInput,
    SubagentToolExecutor, ToolRunContext, MAX_WRITE_FILE_CONTENT_CHARS,
};
use runtime::{
    ApiRequest, AssistantEvent, ContentBlock, ConversationMessage, ConversationRuntime,
    RuntimeError, Session, TokenUsage, TurnSummary,
};
use serde_json::json;

fn env_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn temp_path(name: &str) -> PathBuf {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    std::env::temp_dir().join(format!("clawd-tools-{unique}-{name}"))
}

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

#[test]
fn exposes_mvp_tools() {
    let names = mvp_tool_specs()
        .into_iter()
        .map(|spec| spec.name)
        .collect::<Vec<_>>();
    assert!(names.contains(&"bash"));
    assert!(names.contains(&"read_file"));
    assert!(names.contains(&"WebFetch"));
    assert!(names.contains(&"WebSearch"));
    assert!(names.contains(&"TodoWrite"));
    assert!(names.contains(&"memory"));
    assert!(names.contains(&"session_search"));
    assert!(names.contains(&"Skill"));
    assert!(names.contains(&"Agent"));
    assert!(names.contains(&"SpawnTeammate"));
    assert!(names.contains(&"SendMessage"));
    assert!(names.contains(&"ClaimTask"));
    assert!(names.contains(&"CompleteTask"));
    assert!(names.contains(&"ListTeam"));
    assert!(names.contains(&"AgentSupervisor"));
    assert!(names.contains(&"Workflow"));
    assert!(names.contains(&"EnterWorktree"));
    assert!(names.contains(&"ToolSearch"));
    assert!(names.contains(&"NotebookEdit"));
    assert!(names.contains(&"Sleep"));
    assert!(names.contains(&"SendUserMessage"));
    assert!(names.contains(&"Config"));
    assert!(names.contains(&"StructuredOutput"));
    assert!(names.contains(&"REPL"));
    assert!(names.contains(&"PowerShell"));
    assert!(names.contains(&"LaTeXCompile"));
    assert!(names.contains(&"LaTeXRender"));
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

    fs::write(workspace.join("chapters/intro.tex"), "changed").expect("change input");
    assert!(latex_input_snapshot_changed(&snapshot));
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

#[test]
fn memory_and_session_search_tools_round_trip() {
    let _lock = env_lock().lock().expect("env lock");
    let root = temp_path("memory-tools");
    let workspace = root.join("workspace");
    let sessions = root.join("sessions");
    fs::create_dir_all(&workspace).expect("workspace");
    fs::create_dir_all(&sessions).expect("sessions");
    let _home = EnvGuard::set("HOME", &root);
    let _profile = EnvGuard::set("USERPROFILE", &root);
    let _workspace = EnvGuard::set("ARIS_WORKSPACE_ROOT", &workspace);
    let _sessions = EnvGuard::set("ARIS_SESSIONS_DIR", &sessions);
    let _project = EnvGuard::set("ARIS_DESKTOP_PROJECT_ID", "project-test");
    let _approval = EnvGuard::set("ARIS_MEMORY_WRITE_APPROVAL", "false");

    execute_tool(
        "memory",
        &json!({
            "action": "add",
            "target": "user",
            "content": "User prefers focused answers.",
            "scope": "global",
            "source": "test"
        }),
    )
    .expect("memory add");
    let listed = execute_tool("memory", &json!({ "action": "list" })).expect("memory list");
    assert!(listed.contains("User prefers focused answers."));

    std::env::set_var("ARIS_MEMORY_WRITE_APPROVAL", "true");
    let staged = execute_tool(
        "memory",
        &json!({
            "action": "add",
            "content": "This write requires user approval."
        }),
    )
    .expect("stage memory write");
    assert!(staged.contains("This write requires user approval."));
    let listed = execute_tool("memory", &json!({ "action": "list" })).expect("memory list");
    assert!(!listed.contains("This write requires user approval."));
    assert!(execute_tool("memory", &json!({ "action": "approve" })).is_err());

    let mut session = Session::new();
    session
        .messages
        .push(runtime::ConversationMessage::user_text(
            "Decision: use FTS5 indexing.",
        ));
    session
        .save_to_path(sessions.join("tool-session.json"))
        .expect("save session");
    let search = execute_tool(
        "session_search",
        &json!({ "query": "FTS5 indexing", "limit": 3 }),
    )
    .expect("session search");
    assert!(search.contains("tool-session"));
    assert!(search.contains("FTS5 indexing"));

    fs::remove_dir_all(root).expect("remove root");
}

#[test]
fn rejects_unknown_tool_names() {
    let error = execute_tool("nope", &json!({})).expect_err("tool should be rejected");
    assert!(error.contains("unsupported tool"));
}

#[test]
fn web_fetch_returns_prompt_aware_summary() {
    let server = TestServer::spawn(Arc::new(|request_line: &str| {
        assert!(request_line.starts_with("GET /page "));
        HttpResponse::html(
                200,
                "OK",
                "<html><head><title>Ignored</title></head><body><h1>Test Page</h1><p>Hello <b>world</b> from local server.</p></body></html>",
            )
    }));

    let result = execute_tool(
        "WebFetch",
        &json!({
            "url": format!("http://{}/page", server.addr()),
            "prompt": "Summarize this page"
        }),
    )
    .expect("WebFetch should succeed");

    let output: serde_json::Value = serde_json::from_str(&result).expect("valid json");
    assert_eq!(output["code"], 200);
    let summary = output["result"].as_str().expect("result string");
    assert!(summary.contains("Fetched"));
    assert!(summary.contains("Test Page"));
    assert!(summary.contains("Hello world from local server"));

    let titled = execute_tool(
        "WebFetch",
        &json!({
            "url": format!("http://{}/page", server.addr()),
            "prompt": "What is the page title?"
        }),
    )
    .expect("WebFetch title query should succeed");
    let titled_output: serde_json::Value = serde_json::from_str(&titled).expect("valid json");
    let titled_summary = titled_output["result"].as_str().expect("result string");
    assert!(titled_summary.contains("Title: Ignored"));
}

#[test]
fn web_fetch_supports_plain_text_and_rejects_invalid_url() {
    let server = TestServer::spawn(Arc::new(|request_line: &str| {
        assert!(request_line.starts_with("GET /plain "));
        HttpResponse::text(200, "OK", "plain text response")
    }));

    let result = execute_tool(
        "WebFetch",
        &json!({
            "url": format!("http://{}/plain", server.addr()),
            "prompt": "Show me the content"
        }),
    )
    .expect("WebFetch should succeed for text content");

    let output: serde_json::Value = serde_json::from_str(&result).expect("valid json");
    assert_eq!(output["url"], format!("http://{}/plain", server.addr()));
    assert!(output["result"]
        .as_str()
        .expect("result")
        .contains("plain text response"));

    let error = execute_tool(
        "WebFetch",
        &json!({
            "url": "not a url",
            "prompt": "Summarize"
        }),
    )
    .expect_err("invalid URL should fail");
    assert!(error.contains("relative URL without a base") || error.contains("invalid"));
}

#[test]
fn web_search_extracts_and_filters_results() {
    let server = TestServer::spawn(Arc::new(|request_line: &str| {
        assert!(request_line.contains("GET /search?q=rust+web+search "));
        HttpResponse::html(
            200,
            "OK",
            r#"
                <html><body>
                  <a class="result__a" href="https://docs.rs/reqwest">Reqwest docs</a>
                  <a class="result__a" href="https://example.com/blocked">Blocked result</a>
                </body></html>
                "#,
        )
    }));

    std::env::set_var(
        "CLAWD_WEB_SEARCH_BASE_URL",
        format!("http://{}/search", server.addr()),
    );
    let result = execute_tool(
        "WebSearch",
        &json!({
            "query": "rust web search",
            "allowed_domains": ["https://DOCS.rs/"],
            "blocked_domains": ["HTTPS://EXAMPLE.COM"]
        }),
    )
    .expect("WebSearch should succeed");
    std::env::remove_var("CLAWD_WEB_SEARCH_BASE_URL");

    let output: serde_json::Value = serde_json::from_str(&result).expect("valid json");
    assert_eq!(output["query"], "rust web search");
    let results = output["results"].as_array().expect("results array");
    let search_result = results
        .iter()
        .find(|item| item.get("content").is_some())
        .expect("search result block present");
    let content = search_result["content"].as_array().expect("content array");
    assert_eq!(content.len(), 1);
    assert_eq!(content[0]["title"], "Reqwest docs");
    assert_eq!(content[0]["url"], "https://docs.rs/reqwest");
}

#[test]
fn web_search_handles_generic_links_and_invalid_base_url() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let server = TestServer::spawn(Arc::new(|request_line: &str| {
        assert!(request_line.contains("GET /fallback?q=generic+links "));
        HttpResponse::html(
            200,
            "OK",
            r#"
                <html><body>
                  <a href="https://example.com/one">Example One</a>
                  <a href="https://example.com/one">Duplicate Example One</a>
                  <a href="https://docs.rs/tokio">Tokio Docs</a>
                </body></html>
                "#,
        )
    }));

    std::env::set_var(
        "CLAWD_WEB_SEARCH_BASE_URL",
        format!("http://{}/fallback", server.addr()),
    );
    let result = execute_tool(
        "WebSearch",
        &json!({
            "query": "generic links"
        }),
    )
    .expect("WebSearch fallback parsing should succeed");
    std::env::remove_var("CLAWD_WEB_SEARCH_BASE_URL");

    let output: serde_json::Value = serde_json::from_str(&result).expect("valid json");
    let results = output["results"].as_array().expect("results array");
    let search_result = results
        .iter()
        .find(|item| item.get("content").is_some())
        .expect("search result block present");
    let content = search_result["content"].as_array().expect("content array");
    assert_eq!(content.len(), 2);
    assert_eq!(content[0]["url"], "https://example.com/one");
    assert_eq!(content[1]["url"], "https://docs.rs/tokio");

    std::env::set_var("CLAWD_WEB_SEARCH_BASE_URL", "://bad-base-url");
    let error = execute_tool("WebSearch", &json!({ "query": "generic links" }))
        .expect_err("invalid base URL should fail");
    std::env::remove_var("CLAWD_WEB_SEARCH_BASE_URL");
    assert!(error.contains("relative URL without a base") || error.contains("empty host"));
}

#[test]
fn todo_write_persists_and_returns_previous_state() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let path = temp_path("todos.json");
    std::env::set_var("CLAWD_TODO_STORE", &path);

    let first = execute_tool(
        "TodoWrite",
        &json!({
            "todos": [
                {"content": "Add tool", "activeForm": "Adding tool", "status": "in_progress"},
                {"content": "Run tests", "activeForm": "Running tests", "status": "pending"}
            ]
        }),
    )
    .expect("TodoWrite should succeed");
    let first_output: serde_json::Value = serde_json::from_str(&first).expect("valid json");
    assert_eq!(first_output["oldTodos"].as_array().expect("array").len(), 0);

    let second = execute_tool(
        "TodoWrite",
        &json!({
            "todos": [
                {"content": "Add tool", "activeForm": "Adding tool", "status": "completed"},
                {"content": "Run tests", "activeForm": "Running tests", "status": "completed"},
                {"content": "Verify", "activeForm": "Verifying", "status": "completed"}
            ]
        }),
    )
    .expect("TodoWrite should succeed");
    std::env::remove_var("CLAWD_TODO_STORE");
    let _ = std::fs::remove_file(path);

    let second_output: serde_json::Value = serde_json::from_str(&second).expect("valid json");
    assert_eq!(
        second_output["oldTodos"].as_array().expect("array").len(),
        2
    );
    assert_eq!(
        second_output["newTodos"].as_array().expect("array").len(),
        3
    );
    assert!(second_output["verificationNudgeNeeded"].is_null());
}

#[test]
fn todo_write_rejects_invalid_payloads_and_sets_verification_nudge() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let path = temp_path("todos-errors.json");
    std::env::set_var("CLAWD_TODO_STORE", &path);

    let empty =
        execute_tool("TodoWrite", &json!({ "todos": [] })).expect_err("empty todos should fail");
    assert!(empty.contains("todos must not be empty"));

    // Multiple in_progress items are now allowed for parallel workflows
    let _multi_active = execute_tool(
        "TodoWrite",
        &json!({
            "todos": [
                {"content": "One", "activeForm": "Doing one", "status": "in_progress"},
                {"content": "Two", "activeForm": "Doing two", "status": "in_progress"}
            ]
        }),
    )
    .expect("multiple in-progress todos should succeed");

    let blank_content = execute_tool(
        "TodoWrite",
        &json!({
            "todos": [
                {"content": "   ", "activeForm": "Doing it", "status": "pending"}
            ]
        }),
    )
    .expect_err("blank content should fail");
    assert!(blank_content.contains("todo content must not be empty"));

    let nudge = execute_tool(
        "TodoWrite",
        &json!({
            "todos": [
                {"content": "Write tests", "activeForm": "Writing tests", "status": "completed"},
                {"content": "Fix errors", "activeForm": "Fixing errors", "status": "completed"},
                {"content": "Ship branch", "activeForm": "Shipping branch", "status": "completed"}
            ]
        }),
    )
    .expect("completed todos should succeed");
    std::env::remove_var("CLAWD_TODO_STORE");
    let _ = fs::remove_file(path);

    let output: serde_json::Value = serde_json::from_str(&nudge).expect("valid json");
    assert_eq!(output["verificationNudgeNeeded"], true);
}

#[test]
fn skill_loads_local_skill_prompt() {
    // Create a temporary skill directory
    let tmp = std::env::temp_dir().join(format!("aris-skill-test-{}", std::process::id()));
    let skill_dir = tmp.join("test-skill");
    fs::create_dir_all(&skill_dir).expect("create skill dir");
    fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: test-skill\ndescription: \"A test skill\"\n---\n\n# Test Skill\n\nThis is a test skill prompt.",
        )
        .expect("write SKILL.md");

    // Point HOME/USERPROFILE to temp dir so ~/.config/SomniQ/skills resolves there.
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let aris_home = tmp.parent().unwrap().join("somniq-home");
    let aris_skills = aris_home.join(".config").join("SomniQ").join("skills");
    let _home_guard = EnvGuard::set("HOME", &aris_home);
    let _userprofile_guard = EnvGuard::set("USERPROFILE", &aris_home);
    let _claude_compat_guard = EnvGuard::unset("ARIS_ENABLE_CLAUDE_SKILLS");
    fs::create_dir_all(&aris_skills).expect("create SomniQ skills dir");

    // Copy the skill into the SomniQ skills dir.
    let target_skill = aris_skills.join("test-skill");
    fs::create_dir_all(&target_skill).expect("create target skill dir");
    fs::copy(skill_dir.join("SKILL.md"), target_skill.join("SKILL.md")).expect("copy skill");

    let result = execute_tool(
        "Skill",
        &json!({
            "skill": "test-skill",
            "args": "overview"
        }),
    )
    .expect("Skill should succeed");

    let output: serde_json::Value = serde_json::from_str(&result).expect("valid json");
    assert_eq!(output["skill"], "test-skill");
    assert!(output["path"]
        .as_str()
        .expect("path")
        .ends_with("/test-skill/SKILL.md"));
    assert!(output["prompt"]
        .as_str()
        .expect("prompt")
        .contains("This is a test skill prompt"));

    // Test $skill form
    let dollar_result = execute_tool(
        "Skill",
        &json!({
            "skill": "$test-skill"
        }),
    )
    .expect("Skill should accept $skill invocation form");
    let dollar_output: serde_json::Value =
        serde_json::from_str(&dollar_result).expect("valid json");
    assert_eq!(dollar_output["skill"], "$test-skill");
    assert!(dollar_output["path"]
        .as_str()
        .expect("path")
        .ends_with("/test-skill/SKILL.md"));

    // Cleanup
    let _ = fs::remove_dir_all(&tmp);
    let _ = fs::remove_dir_all(&aris_home);
}

#[test]
fn claude_skills_require_explicit_compat_flag() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let tmp = temp_path("legacy-claude-skills");
    let home = tmp.join("home");
    let claude_skills = home.join(".claude").join("skills");
    let _home_guard = EnvGuard::set("HOME", &home);
    let _userprofile_guard = EnvGuard::set("USERPROFILE", &home);
    let _codex_home_guard = EnvGuard::unset("CODEX_HOME");
    let _claude_compat_guard = EnvGuard::unset("ARIS_ENABLE_CLAUDE_SKILLS");
    fs::create_dir_all(&claude_skills).expect("create claude skills dir");
    let target_skill = claude_skills.join("legacy-claude-only");
    fs::create_dir_all(&target_skill).expect("create target skill dir");
    fs::write(
            target_skill.join("SKILL.md"),
            "---\nname: legacy-claude-only\ndescription: \"Legacy Claude skill\"\n---\n\n# Legacy Claude Skill\n",
        )
        .expect("write legacy skill");

    assert!(
        skill_markdown("legacy-claude-only").is_none(),
        "Claude Code skills should not be visible by default"
    );

    let _claude_compat_enabled = EnvGuard::set("ARIS_ENABLE_CLAUDE_SKILLS", "1");
    let markdown = skill_markdown("legacy-claude-only")
        .expect("legacy Claude skill should load when compat is enabled");
    assert!(markdown.contains("# Legacy Claude Skill"));

    let result = execute_tool(
        "Skill",
        &json!({
            "skill": "legacy-claude-only"
        }),
    )
    .expect("legacy Claude skill should execute when compat is enabled");
    let output: serde_json::Value = serde_json::from_str(&result).expect("valid json");
    let expected_path = target_skill
        .join("SKILL.md")
        .display()
        .to_string()
        .replace('\\', "/");
    assert_eq!(output["path"].as_str().expect("path"), expected_path);

    let _ = fs::remove_dir_all(&tmp);
}

#[test]
fn bundled_skill_is_discoverable_and_invokable() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let tmp = temp_path("bundled-skill-home");
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).expect("create isolated home");
    let _home = EnvGuard::set("HOME", &tmp);
    let _userprofile = EnvGuard::set("USERPROFILE", &tmp);
    let _codex_home = EnvGuard::unset("CODEX_HOME");

    let skills = discover_skills();
    assert!(
        skills.iter().any(|skill| skill.name == "research-lit"),
        "research-lit should be listed among bundled skills"
    );

    let markdown = skill_markdown("research-lit").expect("bundled skill markdown");
    assert!(markdown.contains("# Research Literature Review"));

    let result = execute_tool(
        "Skill",
        &json!({
            "skill": "research-lit",
            "args": "reservoir computing"
        }),
    )
    .expect("bundled Skill should load");
    let output: serde_json::Value = serde_json::from_str(&result).expect("valid json");
    assert_eq!(output["skill"], "research-lit");
    assert_eq!(output["path"], "<bundled:research-lit>");
    assert_eq!(output["args"], "reservoir computing");
    assert!(output["prompt"]
        .as_str()
        .expect("prompt")
        .contains("# Research Literature Review"));

    let _ = fs::remove_dir_all(&tmp);
}

#[test]
fn tool_search_supports_keyword_and_select_queries() {
    let keyword = execute_tool(
        "ToolSearch",
        &json!({"query": "web current", "max_results": 3}),
    )
    .expect("ToolSearch should succeed");
    let keyword_output: serde_json::Value = serde_json::from_str(&keyword).expect("valid json");
    let matches = keyword_output["matches"].as_array().expect("matches");
    assert!(matches.iter().any(|value| value == "WebSearch"));

    let selected = execute_tool("ToolSearch", &json!({"query": "select:Agent,Skill"}))
        .expect("ToolSearch should succeed");
    let selected_output: serde_json::Value = serde_json::from_str(&selected).expect("valid json");
    assert_eq!(selected_output["matches"][0], "Agent");
    assert_eq!(selected_output["matches"][1], "Skill");

    let aliased = execute_tool("ToolSearch", &json!({"query": "AgentTool"}))
        .expect("ToolSearch should support tool aliases");
    let aliased_output: serde_json::Value = serde_json::from_str(&aliased).expect("valid json");
    assert_eq!(aliased_output["matches"][0], "Agent");
    assert_eq!(aliased_output["normalized_query"], "agent");

    let selected_with_alias =
        execute_tool("ToolSearch", &json!({"query": "select:AgentTool,Skill"}))
            .expect("ToolSearch alias select should succeed");
    let selected_with_alias_output: serde_json::Value =
        serde_json::from_str(&selected_with_alias).expect("valid json");
    assert_eq!(selected_with_alias_output["matches"][0], "Agent");
    assert_eq!(selected_with_alias_output["matches"][1], "Skill");
}

#[test]
fn agent_persists_handoff_metadata() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = temp_path("agent-store");
    let _agent_store = EnvGuard::set("CLAWD_AGENT_STORE", &dir);
    let captured = Arc::new(Mutex::new(None::<AgentJob>));
    let captured_for_spawn = Arc::clone(&captured);

    let manifest = execute_agent_with_spawn(
        AgentInput {
            description: "Audit the branch".to_string(),
            prompt: "Check tests and outstanding work.".to_string(),
            subagent_type: Some("Explore".to_string()),
            name: Some("ship-audit".to_string()),
            model: None,
        },
        move |job| {
            *captured_for_spawn
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(job);
            Ok(())
        },
    )
    .expect("Agent should succeed");

    assert_eq!(manifest.name, "ship-audit");
    assert_eq!(manifest.subagent_type.as_deref(), Some("Explore"));
    assert_eq!(manifest.status, "running");
    assert!(!manifest.created_at.is_empty());
    assert!(manifest.started_at.is_some());
    assert!(manifest.completed_at.is_none());
    let contents = std::fs::read_to_string(&manifest.output_file).expect("agent file exists");
    let manifest_contents =
        std::fs::read_to_string(&manifest.manifest_file).expect("manifest file exists");
    assert!(contents.contains("Audit the branch"));
    assert!(contents.contains("Check tests and outstanding work."));
    assert!(manifest_contents.contains("\"subagentType\": \"Explore\""));
    assert!(manifest_contents.contains("\"status\": \"running\""));
    let captured_job = captured
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
        .expect("spawn job should be captured");
    assert_eq!(captured_job.prompt, "Check tests and outstanding work.");
    assert!(captured_job.allowed_tools.contains("read_file"));
    assert!(!captured_job.allowed_tools.contains("Agent"));

    let normalized = execute_tool(
        "Agent",
        &json!({
            "description": "Verify the branch",
            "prompt": "Check tests.",
            "subagent_type": "explorer"
        }),
    )
    .expect("Agent should normalize built-in aliases");
    let normalized_output: serde_json::Value =
        serde_json::from_str(&normalized).expect("valid json");
    assert_eq!(normalized_output["subagentType"], "Explore");

    let named = execute_tool(
        "Agent",
        &json!({
            "description": "Review the branch",
            "prompt": "Inspect diff.",
            "name": "Ship Audit!!!"
        }),
    )
    .expect("Agent should normalize explicit names");
    let named_output: serde_json::Value = serde_json::from_str(&named).expect("valid json");
    assert_eq!(named_output["name"], "ship-audit");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn agent_fake_runner_can_persist_completion_and_failure() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = temp_path("agent-runner");
    std::env::set_var("CLAWD_AGENT_STORE", &dir);

    let completed = execute_agent_with_spawn(
        AgentInput {
            description: "Complete the task".to_string(),
            prompt: "Do the work".to_string(),
            subagent_type: Some("Explore".to_string()),
            name: Some("complete-task".to_string()),
            model: Some("claude-sonnet-4-6".to_string()),
        },
        |job| {
            persist_agent_terminal_state(
                &job.manifest,
                "completed",
                Some("Finished successfully"),
                None,
                None,
            )
        },
    )
    .expect("completed agent should succeed");

    let completed_manifest =
        std::fs::read_to_string(&completed.manifest_file).expect("completed manifest should exist");
    let completed_output =
        std::fs::read_to_string(&completed.output_file).expect("completed output should exist");
    assert!(completed_manifest.contains("\"status\": \"completed\""));
    assert!(completed_output.contains("Finished successfully"));

    let failed = execute_agent_with_spawn(
        AgentInput {
            description: "Fail the task".to_string(),
            prompt: "Do the failing work".to_string(),
            subagent_type: Some("Verification".to_string()),
            name: Some("fail-task".to_string()),
            model: None,
        },
        |job| {
            persist_agent_terminal_state(
                &job.manifest,
                "failed",
                None,
                Some(String::from("simulated failure")),
                None,
            )
        },
    )
    .expect("failed agent should still spawn");

    let failed_manifest =
        std::fs::read_to_string(&failed.manifest_file).expect("failed manifest should exist");
    let failed_output =
        std::fs::read_to_string(&failed.output_file).expect("failed output should exist");
    assert!(failed_manifest.contains("\"status\": \"failed\""));
    assert!(failed_manifest.contains("simulated failure"));
    assert!(failed_output.contains("simulated failure"));

    let spawn_error = execute_agent_with_spawn(
        AgentInput {
            description: "Spawn error task".to_string(),
            prompt: "Never starts".to_string(),
            subagent_type: None,
            name: Some("spawn-error".to_string()),
            model: None,
        },
        |_| Err(String::from("thread creation failed")),
    )
    .expect_err("spawn errors should surface");
    assert!(spawn_error.contains("failed to spawn sub-agent"));
    let spawn_error_manifest = std::fs::read_dir(&dir)
        .expect("agent dir should exist")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("json"))
        .find_map(|path| {
            let contents = std::fs::read_to_string(&path).ok()?;
            contents
                .contains("\"name\": \"spawn-error\"")
                .then_some(contents)
        })
        .expect("failed manifest should still be written");
    assert!(spawn_error_manifest.contains("\"status\": \"failed\""));
    assert!(spawn_error_manifest.contains("thread creation failed"));

    std::env::remove_var("CLAWD_AGENT_STORE");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn agent_tool_subset_mapping_is_expected() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let _env = EnvGuard::unset("ARIS_ALLOWED_TOOLS");
    let general = allowed_tools_for_subagent("general-purpose");
    assert!(general.contains("bash"));
    assert!(general.contains("write_file"));
    assert!(general.contains("append_file"));
    assert!(!general.contains("Agent"));
    assert!(general.contains("ListTeam"));

    let explore = allowed_tools_for_subagent("Explore");
    assert!(explore.contains("read_file"));
    assert!(explore.contains("grep_search"));
    assert!(!explore.contains("bash"));
    assert!(explore.contains("SendMessage"));

    let plan = allowed_tools_for_subagent("Plan");
    assert!(plan.contains("TodoWrite"));
    assert!(plan.contains("StructuredOutput"));
    assert!(!plan.contains("Agent"));

    let verification = allowed_tools_for_subagent("Verification");
    assert!(verification.contains("bash"));
    assert!(verification.contains("PowerShell"));
    assert!(!verification.contains("write_file"));
    assert!(!verification.contains("append_file"));
}

#[test]
fn file_tool_descriptions_preserve_existing_artifact_paths() {
    let specs = mvp_tool_specs();
    let description = |name: &str| {
        specs
            .iter()
            .find(|spec| spec.name == name)
            .unwrap_or_else(|| panic!("{name} spec should exist"))
            .description
    };

    assert!(description("write_file").contains("reuse the existing path"));
    assert!(description("write_file").contains("_v2"));
    assert!(description("write_file").contains("unless explicitly requested"));
    assert!(description("write_file").contains("read the target first"));
    assert!(description("write_file").contains("prefer edit_file"));
    assert!(description("append_file").contains("existing/current artifacts"));
    assert!(description("append_file").contains("long generated artifacts"));
    assert!(description("edit_file").contains("existing/current artifacts"));
    assert!(description("edit_file").contains("Read the target file first"));
    assert!(description("edit_file").contains("old_string should be unique"));
}

#[test]
fn shell_tool_descriptions_prefer_dedicated_tools_and_parallel_reads() {
    let specs = mvp_tool_specs();
    let description = |name: &str| {
        specs
            .iter()
            .find(|spec| spec.name == name)
            .unwrap_or_else(|| panic!("{name} spec should exist"))
            .description
    };

    for name in ["bash", "PowerShell"] {
        let desc = description(name);
        assert!(desc.contains("Prefer dedicated tools"));
        assert!(desc.contains("read_file"));
        assert!(desc.contains("glob_search"));
        assert!(desc.contains("grep_search"));
        assert!(desc.contains("edit_file"));
        assert!(desc.contains("run_in_background only for long-running services"));
        assert!(desc.contains("separate parallel tool calls"));
        assert!(desc.contains("chain commands only when they genuinely depend"));
    }
}

#[test]
fn inherited_allowed_tools_filter_subagent_and_coordination_tools() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let _env = EnvGuard::set(
        "ARIS_ALLOWED_TOOLS",
        "read_file,grep_search,ListTeam,CompleteTask",
    );

    let general = allowed_tools_for_subagent("general-purpose");

    assert!(general.contains("read_file"));
    assert!(general.contains("grep_search"));
    assert!(general.contains("ListTeam"));
    assert!(general.contains("CompleteTask"));
    assert!(!general.contains("bash"));
    assert!(!general.contains("PowerShell"));
    assert!(!general.contains("Workflow"));
    assert!(!general.contains("EnterWorktree"));
    assert!(!general.contains("AgentSupervisor"));
    assert!(!general.contains("SpawnTeammate"));
}

#[test]
fn team_state_tracks_members_tasks_mailbox_and_completion() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = temp_path("team-state");
    std::env::set_var("ARIS_RUN_STATE_DIR", &dir);
    std::env::set_var("ARIS_SESSION_ID", "lead-session");
    std::env::set_var("ARIS_PERMISSION_MODE", "workspace-write");
    std::env::set_var("ARIS_ALLOWED_TOOLS", "read_file,grep_search,ListTeam");

    let prepared = team_state::prepare_teammate(&team_state::SpawnTeammateInput {
        team_id: None,
        team_name: Some("Ship Team".to_string()),
        team_design: Some(team_state::TeamDesignContract {
            rationale: "The audit needs a bounded teammate plus lead-side verification."
                .to_string(),
            coordination_pattern: "lead-coordinator-with-specialized-teammate".to_string(),
            coordinator: "lead-session".to_string(),
            context_policy:
                "The lead passes only the relevant files and expects structured handoff notes."
                    .to_string(),
            verification_plan:
                "The lead checks the audit result against persisted team state and events."
                    .to_string(),
            stop_condition:
                "Stop when the audit deliverable satisfies all criteria and is recorded."
                    .to_string(),
            max_teammates: Some(4),
        }),
        lead_session: None,
        description: "Audit implementation".to_string(),
        prompt: "Inspect the code and report findings.".to_string(),
        subagent_type: Some("Explore".to_string()),
        role: Some("implementation-auditor".to_string()),
        responsibility: Some(
            "Inspect the requested implementation surface and report concrete findings."
                .to_string(),
        ),
        context_scope: Some(
            "Use only files and run-state records relevant to this team-state smoke test."
                .to_string(),
        ),
        deliverable: Some(
            "A concise implementation audit report for the lead session.".to_string(),
        ),
        success_criteria: Some(vec![
            "The report names the inspected coordination state artifacts.".to_string(),
            "The report avoids modifying unrelated workspace files.".to_string(),
        ]),
        stop_condition: Some(
            "Stop after the implementation audit result is complete and recorded.".to_string(),
        ),
        name: Some("audit".to_string()),
        model: None,
        task_id: None,
        task_title: None,
        dependencies: None,
        worktree: None,
        worktree_branch: None,
        worktree_path: None,
    })
    .expect("teammate should prepare");

    let snapshot = team_state::register_spawned_agent(
        &prepared,
        team_state::AgentRecord {
            agent_id: "agent-1".to_string(),
            name: "audit".to_string(),
            description: "Audit implementation".to_string(),
            subagent_type: Some("Explore".to_string()),
            model: Some("claude-sonnet-4-6".to_string()),
            status: "running".to_string(),
            output_file: dir.join("agent-1.md").display().to_string(),
            manifest_file: dir.join("agent-1.json").display().to_string(),
        },
    )
    .expect("agent should register");
    assert_eq!(snapshot.team.name, "Ship Team");
    assert_eq!(snapshot.team.members.len(), 1);
    assert_eq!(
        snapshot
            .team
            .design
            .as_ref()
            .map(|design| design.coordinator.as_str()),
        Some("lead-session")
    );
    assert_eq!(
        snapshot.team.members[0].role.as_deref(),
        Some("implementation-auditor")
    );
    assert_eq!(
        snapshot.tasks[0].status,
        team_state::TeamTaskStatus::InProgress
    );
    let premature_dependent = team_state::prepare_teammate(&team_state::SpawnTeammateInput {
        team_id: Some(prepared.team_id.clone()),
        team_name: Some("Ship Team".to_string()),
        team_design: None,
        lead_session: None,
        description: "Verify audit result".to_string(),
        prompt: "Verify the audit result after the audit task completes.".to_string(),
        subagent_type: Some("Verification".to_string()),
        role: Some("audit-verifier".to_string()),
        responsibility: Some(
            "Verify the completed audit result against the persisted run-state records."
                .to_string(),
        ),
        context_scope: Some(
            "Use only the completed audit output and this team-state smoke test run-state."
                .to_string(),
        ),
        deliverable: Some("A concise verification report for the completed audit.".to_string()),
        success_criteria: Some(vec![
            "The verifier waits until the prerequisite audit task is complete.".to_string(),
            "The report names any mismatch between the audit result and run-state.".to_string(),
        ]),
        stop_condition: Some(
            "Stop after verification is complete and the report is handed back.".to_string(),
        ),
        name: Some("verify-audit".to_string()),
        model: None,
        task_id: Some("verify-audit".to_string()),
        task_title: Some("Verify audit result".to_string()),
        dependencies: Some(vec![prepared.task_id.clone()]),
        worktree: None,
        worktree_branch: None,
        worktree_path: None,
    })
    .expect_err("dependent teammate should not spawn before prerequisites complete");
    assert!(
        premature_dependent.contains("unmet dependencies"),
        "unexpected dependency error: {premature_dependent}"
    );

    let message = team_state::send_message(team_state::SendMessageInput {
        team_id: Some(prepared.team_id.clone()),
        from: prepared.member_id.clone(),
        to: "lead".to_string(),
        subject: Some("status".to_string()),
        body: "audit started".to_string(),
        task_id: Some(prepared.task_id.clone()),
    })
    .expect("message should send");
    assert_eq!(message.team_id, prepared.team_id);

    let claimed = team_state::claim_task(team_state::ClaimTaskInput {
        team_id: Some(prepared.team_id.clone()),
        task_id: Some(prepared.task_id.clone()),
        claimant: prepared.member_id.clone(),
        lease_seconds: Some(30),
    })
    .expect("same member should renew lease");
    assert_eq!(
        claimed.claimed_by.as_deref(),
        Some(prepared.member_id.as_str())
    );

    let completed = team_state::complete_task(team_state::CompleteTaskInput {
        team_id: Some(prepared.team_id.clone()),
        task_id: prepared.task_id.clone(),
        actor: prepared.member_id.clone(),
        result: "no issues".to_string(),
        status: Some(team_state::TaskCompletionStatus::Completed),
    })
    .expect("task should complete");
    assert_eq!(
        completed.tasks[0].status,
        team_state::TeamTaskStatus::Completed
    );
    assert_eq!(completed.mailbox.len(), 1);
    let duplicate = team_state::complete_task(team_state::CompleteTaskInput {
        team_id: Some(prepared.team_id.clone()),
        task_id: prepared.task_id.clone(),
        actor: "lead".to_string(),
        result: "overwrite attempt".to_string(),
        status: Some(team_state::TaskCompletionStatus::Completed),
    })
    .expect_err("terminal task result must not be overwritten");
    assert!(
        duplicate.contains("refusing to overwrite"),
        "unexpected duplicate completion error: {duplicate}"
    );
    let snapshot = team_state::list_team(team_state::ListTeamInput {
        team_id: Some(prepared.team_id.clone()),
        include_messages: Some(true),
        include_events: Some(true),
    })
    .expect("snapshot should load");
    assert_eq!(snapshot.tasks[0].result.as_deref(), Some("no issues"));
    assert_eq!(
        snapshot.tasks[0]
            .events
            .iter()
            .filter(|event| event.kind == "TaskCompleted")
            .count(),
        1
    );

    // step 3: record an independent verification verdict and confirm it
    // round-trips through persisted task state and logs an event.
    let verified = team_state::record_verification(
        &prepared.team_id,
        &prepared.task_id,
        team_state::TaskVerification {
            status: team_state::VerificationStatus::Passed,
            reviewer: Some("gpt-5.5".to_string()),
            summary: "GO".to_string(),
            verified_at: 0,
        },
    )
    .expect("verification should record");
    assert_eq!(
        verified.verification.as_ref().map(|v| v.status),
        Some(team_state::VerificationStatus::Passed)
    );
    let snapshot = team_state::list_team(team_state::ListTeamInput {
        team_id: Some(prepared.team_id.clone()),
        include_messages: Some(false),
        include_events: Some(true),
    })
    .expect("snapshot should reload");
    assert_eq!(
        snapshot.tasks[0].verification.as_ref().map(|v| v.status),
        Some(team_state::VerificationStatus::Passed)
    );
    assert_eq!(
        snapshot.tasks[0]
            .events
            .iter()
            .filter(|event| event.kind == "TaskVerified")
            .count(),
        1
    );

    // step 4: the /team view renders the live team state.
    let view =
        team_state::render_team_view(Some(&prepared.team_id)).expect("team view should render");
    assert!(view.contains("Ship Team"), "view missing team name: {view}");
    assert!(
        view.contains("verified \u{2713}"),
        "view missing verification glyph: {view}"
    );

    std::env::remove_var("ARIS_RUN_STATE_DIR");
    std::env::remove_var("ARIS_SESSION_ID");
    std::env::remove_var("ARIS_PERMISSION_MODE");
    std::env::remove_var("ARIS_ALLOWED_TOOLS");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn wait_for_teammates_settles_and_times_out() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = temp_path("wait-team");
    std::env::set_var("ARIS_RUN_STATE_DIR", &dir);
    std::env::set_var("ARIS_SESSION_ID", "lead-session");

    let prepared = team_state::prepare_teammate(&team_state::SpawnTeammateInput {
        team_id: None,
        team_name: Some("Wait Team".to_string()),
        team_design: Some(team_state::TeamDesignContract {
            rationale: "Need one bounded teammate plus lead-side verification.".to_string(),
            coordination_pattern: "lead-fan-out".to_string(),
            coordinator: "lead-session".to_string(),
            context_policy: "Lead passes only the relevant slice.".to_string(),
            verification_plan: "Lead checks the result against run-state.".to_string(),
            stop_condition: "Stop when the deliverable meets all criteria.".to_string(),
            max_teammates: Some(4),
        }),
        lead_session: None,
        description: "Do the thing".to_string(),
        prompt: "Do the thing and report.".to_string(),
        subagent_type: Some("Explore".to_string()),
        role: Some("worker".to_string()),
        responsibility: Some("Do the one delegated thing and report findings.".to_string()),
        context_scope: Some("Only the files relevant to this wait smoke test.".to_string()),
        deliverable: Some("A concise report for the lead.".to_string()),
        success_criteria: Some(vec![
            "The report states what was done.".to_string(),
            "The report avoids touching unrelated files.".to_string(),
        ]),
        stop_condition: Some("Stop after the report is recorded.".to_string()),
        name: Some("worker".to_string()),
        model: None,
        task_id: None,
        task_title: None,
        dependencies: None,
        worktree: None,
        worktree_branch: None,
        worktree_path: None,
    })
    .expect("teammate should prepare");

    // While the task is in progress, a short wait returns timed-out and unsettled.
    let timed = team_state::wait_for_teammates(team_state::WaitForTeammatesInput {
        team_id: Some(prepared.team_id.clone()),
        task_ids: None,
        timeout_seconds: Some(1),
        poll_interval_seconds: Some(1),
    })
    .expect("wait should return");
    assert!(!timed.all_settled, "in-progress task must not be settled");
    assert!(timed.timed_out, "short wait should time out");
    assert_eq!(timed.pending, 1);

    // Once the task completes, the wait returns immediately with the result.
    team_state::complete_task(team_state::CompleteTaskInput {
        team_id: Some(prepared.team_id.clone()),
        task_id: prepared.task_id.clone(),
        actor: prepared.member_id.clone(),
        result: "done".to_string(),
        status: Some(team_state::TaskCompletionStatus::Completed),
    })
    .expect("task should complete");

    let settled = team_state::wait_for_teammates(team_state::WaitForTeammatesInput {
        team_id: Some(prepared.team_id.clone()),
        task_ids: None,
        timeout_seconds: Some(30),
        poll_interval_seconds: Some(1),
    })
    .expect("wait should return");
    assert!(settled.all_settled, "completed task should be settled");
    assert!(!settled.timed_out);
    assert_eq!(settled.pending, 0);
    assert_eq!(settled.tasks.len(), 1);
    assert_eq!(settled.tasks[0].result.as_deref(), Some("done"));
    assert_eq!(
        settled.tasks[0].status,
        team_state::TeamTaskStatus::Completed
    );

    std::env::remove_var("ARIS_RUN_STATE_DIR");
    std::env::remove_var("ARIS_SESSION_ID");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn parse_review_verdict_classifies_go_and_no_go() {
    use team_state::VerificationStatus;
    assert_eq!(
        team_state::parse_review_verdict("Looks solid overall. Verdict: GO"),
        VerificationStatus::Passed
    );
    assert_eq!(
        team_state::parse_review_verdict("Acceptable with caveats. GO-WITH-NITS"),
        VerificationStatus::Passed
    );
    assert_eq!(
        team_state::parse_review_verdict("Criteria not met. NO-GO."),
        VerificationStatus::Failed
    );
    assert_eq!(
        team_state::parse_review_verdict("This NEEDS-REWORK before it can land."),
        VerificationStatus::Failed
    );
    // "NO-GO" contains "GO" but must classify as Failed, not Passed.
    assert_eq!(
        team_state::parse_review_verdict("Strong NO-GO from me."),
        VerificationStatus::Failed
    );
    // No recognizable verdict token -> defer to the lead.
    assert_eq!(
        team_state::parse_review_verdict("Some thoughts, but no clear verdict here."),
        VerificationStatus::NeedsJudgment
    );
}

#[test]
fn workflow_requires_approval_and_can_complete_without_agents() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = temp_path("workflow-state");
    std::env::set_var("ARIS_RUN_STATE_DIR", &dir);
    std::env::set_var("ARIS_SESSION_ID", "lead-session");
    let script = "emitPhase(\"synthesis\")\nsaveResult(\"final report\")";

    let plan = execute_tool(
        "Workflow",
        &json!({
            "action": "plan",
            "script": script
        }),
    )
    .expect("plan should succeed");
    let plan_json: serde_json::Value = serde_json::from_str(&plan).expect("valid plan json");
    assert_eq!(plan_json["plan"]["phases"][0], "synthesis");

    let approval_required = execute_tool(
        "Workflow",
        &json!({
            "action": "start",
            "script": script
        }),
    )
    .expect("unapproved start should persist approval-required run");
    let approval_json: serde_json::Value =
        serde_json::from_str(&approval_required).expect("valid approval json");
    assert_eq!(approval_json["action"], "approval_required");

    let started = execute_tool(
        "Workflow",
        &json!({
            "action": "start",
            "name": "quick-check",
            "script": script,
            "approval": "allow_once"
        }),
    )
    .expect("approved start should succeed");
    let started_json: serde_json::Value = serde_json::from_str(&started).expect("valid json");
    assert_eq!(started_json["run"]["status"], "completed");
    assert_eq!(started_json["run"]["result"], "final report");
    assert_eq!(
        started_json["run"]["completedCache"]
            .as_array()
            .map(Vec::len),
        Some(1)
    );

    std::env::remove_var("ARIS_RUN_STATE_DIR");
    std::env::remove_var("ARIS_SESSION_ID");
    let _ = std::fs::remove_dir_all(dir);
}

#[derive(Debug)]
struct MockSubagentApiClient {
    calls: usize,
    input_path: String,
}

impl runtime::ApiClient for MockSubagentApiClient {
    fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
        self.calls += 1;
        match self.calls {
            1 => {
                assert_eq!(request.messages.len(), 1);
                Ok(vec![
                    AssistantEvent::ToolUse {
                        id: "tool-1".to_string(),
                        name: "read_file".to_string(),
                        input: json!({ "path": self.input_path }).to_string(),
                    },
                    AssistantEvent::MessageStop,
                ])
            }
            2 => {
                assert!(request.messages.len() >= 3);
                Ok(vec![
                    AssistantEvent::TextDelta("Scope: completed mock review".to_string()),
                    AssistantEvent::MessageStop,
                ])
            }
            _ => panic!("unexpected mock stream call"),
        }
    }
}

#[test]
fn subagent_runtime_executes_tool_loop_with_isolated_session() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let path = temp_path("subagent-input.txt");
    std::fs::write(&path, "hello from child").expect("write input file");

    let mut runtime = ConversationRuntime::new(
        Session::new(),
        MockSubagentApiClient {
            calls: 0,
            input_path: path.display().to_string(),
        },
        SubagentToolExecutor::new(BTreeSet::from([String::from("read_file")])),
        agent_permission_policy(),
        vec![String::from("system prompt")],
    );

    let summary = runtime
        .run_turn("Inspect the delegated file", None)
        .expect("subagent loop should succeed");

    assert_eq!(
        final_assistant_text(&summary),
        "Scope: completed mock review"
    );
    assert!(runtime
        .session()
        .messages
        .iter()
        .flat_map(|message| message.blocks.iter())
        .any(|block| matches!(
            block,
            runtime::ContentBlock::ToolResult { output, .. }
                if output.contains("hello from child")
        )));

    let _ = std::fs::remove_file(path);
}

#[test]
fn final_assistant_text_keeps_all_nonempty_text_iterations() {
    let summary = TurnSummary {
        assistant_messages: vec![
            ConversationMessage::assistant(vec![
                ContentBlock::Text {
                    text: "Preparing review.".to_string(),
                },
                ContentBlock::ToolUse {
                    id: "tool-1".to_string(),
                    name: "read_file".to_string(),
                    input: "{}".to_string(),
                },
            ]),
            ConversationMessage::assistant(vec![ContentBlock::Text {
                text: "Review complete.".to_string(),
            }]),
        ],
        tool_results: Vec::new(),
        iterations: 2,
        usage: TokenUsage::default(),
        auto_compaction: None,
    };

    assert_eq!(
        final_assistant_text(&summary),
        "Preparing review.\n\nReview complete."
    );
}

#[test]
fn agent_rejects_blank_required_fields() {
    let missing_description = execute_tool(
        "Agent",
        &json!({
            "description": "  ",
            "prompt": "Inspect"
        }),
    )
    .expect_err("blank description should fail");
    assert!(missing_description.contains("description must not be empty"));

    let missing_prompt = execute_tool(
        "Agent",
        &json!({
            "description": "Inspect branch",
            "prompt": " "
        }),
    )
    .expect_err("blank prompt should fail");
    assert!(missing_prompt.contains("prompt must not be empty"));
}

#[test]
fn notebook_edit_replaces_inserts_and_deletes_cells() {
    let path = temp_path("notebook.ipynb");
    std::fs::write(
            &path,
            r#"{
  "cells": [
    {"cell_type": "code", "id": "cell-a", "metadata": {}, "source": ["print(1)\n"], "outputs": [], "execution_count": null}
  ],
  "metadata": {"kernelspec": {"language": "python"}},
  "nbformat": 4,
  "nbformat_minor": 5
}"#,
        )
        .expect("write notebook");

    let replaced = execute_tool(
        "NotebookEdit",
        &json!({
            "notebook_path": path.display().to_string(),
            "cell_id": "cell-a",
            "new_source": "print(2)\n",
            "edit_mode": "replace"
        }),
    )
    .expect("NotebookEdit replace should succeed");
    let replaced_output: serde_json::Value = serde_json::from_str(&replaced).expect("json");
    assert_eq!(replaced_output["cell_id"], "cell-a");
    assert_eq!(replaced_output["cell_type"], "code");

    let inserted = execute_tool(
        "NotebookEdit",
        &json!({
            "notebook_path": path.display().to_string(),
            "cell_id": "cell-a",
            "new_source": "# heading\n",
            "cell_type": "markdown",
            "edit_mode": "insert"
        }),
    )
    .expect("NotebookEdit insert should succeed");
    let inserted_output: serde_json::Value = serde_json::from_str(&inserted).expect("json");
    assert_eq!(inserted_output["cell_type"], "markdown");
    let appended = execute_tool(
        "NotebookEdit",
        &json!({
            "notebook_path": path.display().to_string(),
            "new_source": "print(3)\n",
            "edit_mode": "insert"
        }),
    )
    .expect("NotebookEdit append should succeed");
    let appended_output: serde_json::Value = serde_json::from_str(&appended).expect("json");
    assert_eq!(appended_output["cell_type"], "code");

    let deleted = execute_tool(
        "NotebookEdit",
        &json!({
            "notebook_path": path.display().to_string(),
            "cell_id": "cell-a",
            "edit_mode": "delete"
        }),
    )
    .expect("NotebookEdit delete should succeed without new_source");
    let deleted_output: serde_json::Value = serde_json::from_str(&deleted).expect("json");
    assert!(deleted_output["cell_type"].is_null());
    assert_eq!(deleted_output["new_source"], "");

    let final_notebook: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).expect("read notebook"))
            .expect("valid notebook json");
    let cells = final_notebook["cells"].as_array().expect("cells array");
    assert_eq!(cells.len(), 2);
    assert_eq!(cells[0]["cell_type"], "markdown");
    assert!(cells[0].get("outputs").is_none());
    assert_eq!(cells[1]["cell_type"], "code");
    assert_eq!(cells[1]["source"][0], "print(3)\n");
    let _ = std::fs::remove_file(path);
}

#[test]
fn notebook_edit_rejects_invalid_inputs() {
    let text_path = temp_path("notebook.txt");
    fs::write(&text_path, "not a notebook").expect("write text file");
    let wrong_extension = execute_tool(
        "NotebookEdit",
        &json!({
            "notebook_path": text_path.display().to_string(),
            "new_source": "print(1)\n"
        }),
    )
    .expect_err("non-ipynb file should fail");
    assert!(wrong_extension.contains("Jupyter notebook"));
    let _ = fs::remove_file(&text_path);

    let empty_notebook = temp_path("empty.ipynb");
    fs::write(
            &empty_notebook,
            r#"{"cells":[],"metadata":{"kernelspec":{"language":"python"}},"nbformat":4,"nbformat_minor":5}"#,
        )
        .expect("write empty notebook");

    let missing_source = execute_tool(
        "NotebookEdit",
        &json!({
            "notebook_path": empty_notebook.display().to_string(),
            "edit_mode": "insert"
        }),
    )
    .expect_err("insert without source should fail");
    assert!(missing_source.contains("new_source is required"));

    let missing_cell = execute_tool(
        "NotebookEdit",
        &json!({
            "notebook_path": empty_notebook.display().to_string(),
            "edit_mode": "delete"
        }),
    )
    .expect_err("delete on empty notebook should fail");
    assert!(missing_cell.contains("Notebook has no cells to edit"));
    let _ = fs::remove_file(empty_notebook);
}

#[test]
fn bash_tool_reports_success_exit_failure_timeout_and_background() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let success =
        execute_tool("bash", &json!({ "command": "printf 'hello'" })).expect("bash should succeed");
    let success_output: serde_json::Value = serde_json::from_str(&success).expect("json");
    assert_eq!(success_output["stdout"], "hello");
    assert_eq!(success_output["interrupted"], false);

    let failure = execute_tool("bash", &json!({ "command": "printf 'oops' >&2; exit 7" }))
        .expect("bash failure should still return structured output");
    let failure_output: serde_json::Value = serde_json::from_str(&failure).expect("json");
    assert_eq!(failure_output["returnCodeInterpretation"], "exit_code:7");
    assert!(failure_output["stderr"]
        .as_str()
        .expect("stderr")
        .contains("oops"));

    let timeout = execute_tool("bash", &json!({ "command": "sleep 1", "timeout": 10 }))
        .expect("bash timeout should return output");
    let timeout_output: serde_json::Value = serde_json::from_str(&timeout).expect("json");
    assert_eq!(timeout_output["interrupted"], true);
    assert_eq!(timeout_output["returnCodeInterpretation"], "timeout");
    assert!(timeout_output["stderr"]
        .as_str()
        .expect("stderr")
        .contains("Command exceeded timeout"));

    let background = execute_tool(
        "bash",
        &json!({ "command": "sleep 1", "run_in_background": true }),
    )
    .expect("bash background should succeed");
    let background_output: serde_json::Value = serde_json::from_str(&background).expect("json");
    assert!(background_output["backgroundTaskId"].as_str().is_some());
    assert_eq!(background_output["noOutputExpected"], true);
}

#[test]
fn file_tools_cover_read_write_and_edit_behaviors() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let root = temp_path("fs-suite");
    fs::create_dir_all(&root).expect("create root");
    let original_dir = std::env::current_dir().expect("cwd");
    std::env::set_current_dir(&root).expect("set cwd");

    let write_create = execute_tool(
        "write_file",
        &json!({ "path": "nested/demo.txt", "content": "alpha\nbeta\nalpha\n" }),
    )
    .expect("write create should succeed");
    let write_create_output: serde_json::Value = serde_json::from_str(&write_create).expect("json");
    assert_eq!(write_create_output["type"], "create");
    let write_create_path = write_create_output["filePath"].as_str().expect("file path");
    assert_eq!(
        write_create_output["changes"][write_create_path]["type"],
        "add"
    );
    assert!(root.join("nested/demo.txt").exists());

    let write_update = execute_tool(
        "write_file",
        &json!({ "path": "nested/demo.txt", "content": "alpha\nbeta\ngamma\n" }),
    )
    .expect("write update should succeed");
    let write_update_output: serde_json::Value = serde_json::from_str(&write_update).expect("json");
    assert_eq!(write_update_output["type"], "update");
    assert_eq!(write_update_output["originalFile"], "alpha\nbeta\nalpha\n");
    let write_update_path = write_update_output["filePath"].as_str().expect("file path");
    assert_eq!(
        write_update_output["changes"][write_update_path]["type"],
        "update"
    );
    assert!(
        write_update_output["changes"][write_update_path]["unified_diff"]
            .as_str()
            .expect("unified diff")
            .contains("+gamma")
    );

    let read_full = execute_tool("read_file", &json!({ "path": "nested/demo.txt" }))
        .expect("read full should succeed");
    let read_full_output: serde_json::Value = serde_json::from_str(&read_full).expect("json");
    assert_eq!(read_full_output["file"]["content"], "alpha\nbeta\ngamma");
    assert_eq!(read_full_output["file"]["startLine"], 1);

    let read_slice = execute_tool(
        "read_file",
        &json!({ "path": "nested/demo.txt", "offset": 1, "limit": 1 }),
    )
    .expect("read slice should succeed");
    let read_slice_output: serde_json::Value = serde_json::from_str(&read_slice).expect("json");
    assert_eq!(read_slice_output["file"]["content"], "beta");
    assert_eq!(read_slice_output["file"]["startLine"], 2);

    let read_past_end = execute_tool(
        "read_file",
        &json!({ "path": "nested/demo.txt", "offset": 50 }),
    )
    .expect("read past EOF should succeed");
    let read_past_end_output: serde_json::Value =
        serde_json::from_str(&read_past_end).expect("json");
    assert_eq!(read_past_end_output["file"]["content"], "");
    assert_eq!(read_past_end_output["file"]["startLine"], 4);

    let read_error = execute_tool("read_file", &json!({ "path": "missing.txt" }))
        .expect_err("missing file should fail");
    assert!(!read_error.is_empty());

    let long_write = execute_tool(
            "write_file",
            &json!({ "path": "nested/too-long.txt", "content": "x".repeat(MAX_WRITE_FILE_CONTENT_CHARS + 1) }),
        )
        .expect_err("oversized single-call writes should fail explicitly");
    assert!(long_write.contains("single-call limit"));
    assert!(!root.join("nested/too-long.txt").exists());

    let append_output = execute_tool(
        "append_file",
        &json!({ "path": "nested/demo.txt", "content": "delta\n", "create_if_missing": false }),
    )
    .expect("append should succeed");
    let append_output: serde_json::Value = serde_json::from_str(&append_output).expect("json");
    assert_eq!(append_output["type"], "append");
    assert_eq!(append_output["created"], false);
    assert_eq!(append_output["appendedChars"], 6);
    assert!(append_output.get("content").is_none());
    assert_eq!(
        fs::read_to_string(root.join("nested/demo.txt")).expect("read file"),
        "alpha\nbeta\ngamma\ndelta\n"
    );

    let long_append = execute_tool(
            "append_file",
            &json!({ "path": "nested/demo.txt", "content": "x".repeat(MAX_WRITE_FILE_CONTENT_CHARS + 1) }),
        )
        .expect_err("oversized append writes should fail explicitly");
    assert!(long_append.contains("single-call limit"));

    execute_tool(
        "write_file",
        &json!({ "path": "nested/demo.txt", "content": "alpha\nbeta\ngamma\n" }),
    )
    .expect("reset appended file before edit checks");

    let edit_once = execute_tool(
        "edit_file",
        &json!({ "path": "nested/demo.txt", "old_string": "alpha", "new_string": "omega" }),
    )
    .expect("single edit should succeed");
    let edit_once_output: serde_json::Value = serde_json::from_str(&edit_once).expect("json");
    assert_eq!(edit_once_output["replaceAll"], false);
    let edit_once_path = edit_once_output["filePath"].as_str().expect("file path");
    assert_eq!(
        edit_once_output["changes"][edit_once_path]["type"],
        "update"
    );
    assert_eq!(
        fs::read_to_string(root.join("nested/demo.txt")).expect("read file"),
        "omega\nbeta\ngamma\n"
    );

    execute_tool(
        "write_file",
        &json!({ "path": "nested/demo.txt", "content": "alpha\nbeta\nalpha\n" }),
    )
    .expect("reset file");
    let edit_all = execute_tool(
        "edit_file",
        &json!({
            "path": "nested/demo.txt",
            "old_string": "alpha",
            "new_string": "omega",
            "replace_all": true
        }),
    )
    .expect("replace all should succeed");
    let edit_all_output: serde_json::Value = serde_json::from_str(&edit_all).expect("json");
    assert_eq!(edit_all_output["replaceAll"], true);
    assert_eq!(
        fs::read_to_string(root.join("nested/demo.txt")).expect("read file"),
        "omega\nbeta\nomega\n"
    );

    let edit_same = execute_tool(
        "edit_file",
        &json!({ "path": "nested/demo.txt", "old_string": "omega", "new_string": "omega" }),
    )
    .expect_err("identical old/new should fail");
    assert!(edit_same.contains("must differ"));

    let edit_missing = execute_tool(
        "edit_file",
        &json!({ "path": "nested/demo.txt", "old_string": "missing", "new_string": "omega" }),
    )
    .expect_err("missing substring should fail");
    assert!(edit_missing.contains("old_string not found"));

    std::env::set_current_dir(&original_dir).expect("restore cwd");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn change_tools_list_and_revert_audited_file_writes() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let root = temp_path("change-tools");
    fs::create_dir_all(&root).expect("create root");
    let original_dir = std::env::current_dir().expect("cwd");
    let _workspace = EnvGuard::set("ARIS_WORKSPACE_ROOT", &root);
    let _session = EnvGuard::set("ARIS_SESSION_ID", "tool-ledger-session");
    std::env::set_current_dir(&root).expect("set cwd");

    let output = execute_tool_with_context(
        "write_file",
        &json!({ "path": "tracked.txt", "content": "hello\n" }),
        ToolRunContext {
            tool_use_id: Some("toolu-ledger-1".to_string()),
            session_id: None,
            turn_id: None,
        },
    )
    .expect("write should succeed");
    let output: serde_json::Value = serde_json::from_str(&output).expect("json");
    let change_id = output["changeId"].as_str().expect("change id").to_string();

    let listed = execute_tool(
        "change_list",
        &json!({ "session_id": "tool-ledger-session" }),
    )
    .expect("list changes");
    let listed: serde_json::Value = serde_json::from_str(&listed).expect("json");
    let records = listed["records"].as_array().expect("records");
    assert!(records.iter().any(|record| {
        record["changeId"] == change_id && record["toolUseId"] == "toolu-ledger-1"
    }));

    let reverted = execute_tool(
        "change_revert",
        &json!({ "change_id": change_id, "session_id": "tool-ledger-session" }),
    )
    .expect("revert change");
    let reverted: serde_json::Value = serde_json::from_str(&reverted).expect("json");
    assert_eq!(reverted["reverted"], true);
    assert!(!root.join("tracked.txt").exists());

    std::env::set_current_dir(&original_dir).expect("restore cwd");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn repl_file_writes_are_audited_and_revertible() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let root = temp_path("repl-change-audit");
    fs::create_dir_all(&root).expect("create root");
    let original_dir = std::env::current_dir().expect("cwd");
    let _workspace = EnvGuard::set("ARIS_WORKSPACE_ROOT", &root);
    let _session = EnvGuard::set("ARIS_SESSION_ID", "tool-repl-session");
    std::env::set_current_dir(&root).expect("set cwd");
    fs::write(root.join("tracked.txt"), "before\n").expect("write initial file");

    let file_literal =
        serde_json::to_string(&root.join("tracked.txt").display().to_string()).expect("path json");
    let output = execute_tool_with_context(
        "REPL",
        &json!({
            "language": "python",
            "code": format!(
                "from pathlib import Path\nPath({file_literal}).write_text('after\\n', encoding='utf-8')\n"
            )
        }),
        ToolRunContext {
            tool_use_id: Some("toolu-repl-1".to_string()),
            session_id: Some("tool-repl-session".to_string()),
            turn_id: None,
        },
    );
    let output = match output {
        Ok(output) => output,
        Err(error) if error.contains("python runtime not found") => {
            std::env::set_current_dir(&original_dir).expect("restore cwd");
            let _ = fs::remove_dir_all(root);
            return;
        }
        Err(error) => panic!("REPL write should succeed: {error}"),
    };
    let output: serde_json::Value = serde_json::from_str(&output).expect("json");
    let change_id = output["changeId"].as_str().expect("change id").to_string();
    let changes = output["changes"].as_object().expect("changes");
    assert_eq!(changes.len(), 1);
    assert_eq!(
        fs::read_to_string(root.join("tracked.txt"))
            .unwrap()
            .replace("\r\n", "\n"),
        "after\n"
    );

    let reverted = execute_tool(
        "change_revert",
        &json!({ "change_id": change_id, "session_id": "tool-repl-session" }),
    )
    .expect("revert change");
    let reverted: serde_json::Value = serde_json::from_str(&reverted).expect("json");
    assert_eq!(reverted["reverted"], true);
    assert_eq!(
        fs::read_to_string(root.join("tracked.txt"))
            .unwrap()
            .replace("\r\n", "\n"),
        "before\n"
    );

    std::env::set_current_dir(&original_dir).expect("restore cwd");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn read_file_tool_repeatedly_returns_long_text_preview_without_error() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let root = temp_path("repeat-read-tool-suite");
    fs::create_dir_all(root.join("book")).expect("create root");
    let original_dir = std::env::current_dir().expect("cwd");
    std::env::set_current_dir(&root).expect("set cwd");

    let mut lines = vec!["# Chapter 7".to_string()];
    for index in 1..=1_800 {
        if index % 450 == 0 {
            lines.push(format!("## Section {}", index / 450));
        } else {
            lines.push(format!("line {index} {}", "x".repeat(100)));
        }
    }
    fs::write(root.join("book/chapter7.md"), lines.join("\n")).expect("write long chapter");

    let mut previous: Option<serde_json::Value> = None;
    for attempt in 1..=3 {
        let output = execute_tool("read_file", &json!({ "path": "book/chapter7.md" }))
            .unwrap_or_else(|error| panic!("read attempt {attempt} should not fail: {error}"));
        let output: serde_json::Value = serde_json::from_str(&output).expect("json");
        assert_eq!(output["file"]["truncated"], true);
        assert_eq!(output["file"]["totalLines"], 1_801);
        let content = output["file"]["content"].as_str().expect("content");
        assert!(content.contains("[read_file long-file preview:"));
        assert!(content.contains("L1: # Chapter 7"));
        assert!(content.contains("L451: ## Section 1"));
        assert!(!content.contains("L200: line 200"));
        assert!(
            content.chars().count() <= 64_000,
            "attempt {attempt} returned an oversized preview"
        );

        if let Some(previous) = previous.as_ref() {
            assert_eq!(previous, &output, "attempt {attempt} should be stable");
        }
        previous = Some(output);
    }

    let window = execute_tool(
        "read_file",
        &json!({ "path": "book/chapter7.md", "offset": 449, "limit": 4 }),
    )
    .expect("explicit line window should succeed after repeated previews");
    let window: serde_json::Value = serde_json::from_str(&window).expect("json");
    assert_eq!(window["file"]["startLine"], 450);
    assert_eq!(window["file"]["truncated"], false);
    assert!(window["file"]["content"]
        .as_str()
        .expect("window content")
        .contains("## Section 1"));

    let missing = execute_tool("read_file", &json!({ "path": "book/missing.md" }))
        .expect_err("missing file should still produce a visible tool error");
    assert!(
        missing.contains("missing.md") || missing.contains("No such file"),
        "missing read should include a useful error message: {missing}"
    );

    std::env::set_current_dir(&original_dir).expect("restore cwd");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn glob_and_grep_tools_cover_success_and_errors() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let root = temp_path("search-suite");
    fs::create_dir_all(root.join("nested")).expect("create root");
    let original_dir = std::env::current_dir().expect("cwd");
    std::env::set_current_dir(&root).expect("set cwd");

    fs::write(
        root.join("nested/lib.rs"),
        "fn main() {}\nlet alpha = 1;\nlet alpha = 2;\n",
    )
    .expect("write rust file");
    fs::write(root.join("nested/notes.txt"), "alpha\nbeta\n").expect("write txt file");

    let globbed = execute_tool("glob_search", &json!({ "pattern": "nested/*.rs" }))
        .expect("glob should succeed");
    let globbed_output: serde_json::Value = serde_json::from_str(&globbed).expect("json");
    assert_eq!(globbed_output["numFiles"], 1);
    assert!(globbed_output["filenames"][0]
        .as_str()
        .expect("filename")
        .ends_with("nested/lib.rs"));

    let glob_error = execute_tool("glob_search", &json!({ "pattern": "[" }))
        .expect_err("invalid glob should fail");
    assert!(!glob_error.is_empty());

    let grep_content = execute_tool(
        "grep_search",
        &json!({
            "pattern": "alpha",
            "path": "nested",
            "glob": "*.rs",
            "output_mode": "content",
            "-n": true,
            "head_limit": 1,
            "offset": 1
        }),
    )
    .expect("grep content should succeed");
    let grep_content_output: serde_json::Value = serde_json::from_str(&grep_content).expect("json");
    assert_eq!(grep_content_output["numFiles"], 0);
    assert!(grep_content_output["appliedLimit"].is_null());
    assert_eq!(grep_content_output["appliedOffset"], 1);
    assert!(grep_content_output["content"]
        .as_str()
        .expect("content")
        .contains("let alpha = 2;"));

    let grep_count = execute_tool(
        "grep_search",
        &json!({ "pattern": "alpha", "path": "nested", "output_mode": "count" }),
    )
    .expect("grep count should succeed");
    let grep_count_output: serde_json::Value = serde_json::from_str(&grep_count).expect("json");
    assert_eq!(grep_count_output["numMatches"], 3);

    let grep_error = execute_tool(
        "grep_search",
        &json!({ "pattern": "(alpha", "path": "nested" }),
    )
    .expect_err("invalid regex should fail");
    assert!(!grep_error.is_empty());

    std::env::set_current_dir(&original_dir).expect("restore cwd");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn sleep_waits_and_reports_duration() {
    let started = std::time::Instant::now();
    let result = execute_tool("Sleep", &json!({"duration_ms": 20})).expect("Sleep should succeed");
    let elapsed = started.elapsed();
    let output: serde_json::Value = serde_json::from_str(&result).expect("json");
    assert_eq!(output["duration_ms"], 20);
    assert!(output["message"]
        .as_str()
        .expect("message")
        .contains("Slept for 20ms"));
    assert!(elapsed >= Duration::from_millis(15));
}

#[test]
fn sleep_respects_cancel_check() {
    let started = std::time::Instant::now();
    let error = execute_tool_with_cancel("Sleep", &json!({"duration_ms": 5_000}), &|| true)
        .expect_err("cancelled Sleep should fail");

    assert_eq!(error, "interrupted by user");
    assert!(started.elapsed() < Duration::from_millis(500));
}

#[test]
fn brief_returns_sent_message_and_attachment_metadata() {
    let attachment = std::env::temp_dir().join(format!(
        "clawd-brief-{}.png",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos()
    ));
    std::fs::write(&attachment, b"png-data").expect("write attachment");

    let result = execute_tool(
        "SendUserMessage",
        &json!({
            "message": "hello user",
            "attachments": [attachment.display().to_string()],
            "status": "normal"
        }),
    )
    .expect("SendUserMessage should succeed");

    let output: serde_json::Value = serde_json::from_str(&result).expect("json");
    assert_eq!(output["message"], "hello user");
    assert!(output["sentAt"].as_str().is_some());
    assert_eq!(output["attachments"][0]["isImage"], true);
    let _ = std::fs::remove_file(attachment);
}

#[test]
fn config_reads_and_writes_supported_values() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let root = std::env::temp_dir().join(format!(
        "clawd-config-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos()
    ));
    let home = root.join("home");
    let cwd = root.join("cwd");
    std::fs::create_dir_all(home.join(".claude")).expect("home dir");
    std::fs::create_dir_all(cwd.join(".claude")).expect("cwd dir");
    std::fs::write(
        home.join(".claude").join("settings.json"),
        r#"{"verbose":false}"#,
    )
    .expect("write global settings");

    let original_home = std::env::var("HOME").ok();
    let original_claude_home = std::env::var("CLAUDE_CONFIG_HOME").ok();
    let original_dir = std::env::current_dir().expect("cwd");
    std::env::set_var("HOME", &home);
    std::env::remove_var("CLAUDE_CONFIG_HOME");
    std::env::set_current_dir(&cwd).expect("set cwd");

    let get = execute_tool("Config", &json!({"setting": "verbose"})).expect("get config");
    let get_output: serde_json::Value = serde_json::from_str(&get).expect("json");
    assert_eq!(get_output["value"], false);

    let set = execute_tool(
        "Config",
        &json!({"setting": "permissions.defaultMode", "value": "plan"}),
    )
    .expect("set config");
    let set_output: serde_json::Value = serde_json::from_str(&set).expect("json");
    assert_eq!(set_output["operation"], "set");
    assert_eq!(set_output["newValue"], "plan");

    let invalid = execute_tool(
        "Config",
        &json!({"setting": "permissions.defaultMode", "value": "bogus"}),
    )
    .expect_err("invalid config value should error");
    assert!(invalid.contains("Invalid value"));

    let unknown =
        execute_tool("Config", &json!({"setting": "nope"})).expect("unknown setting result");
    let unknown_output: serde_json::Value = serde_json::from_str(&unknown).expect("json");
    assert_eq!(unknown_output["success"], false);

    std::env::set_current_dir(&original_dir).expect("restore cwd");
    match original_home {
        Some(value) => std::env::set_var("HOME", value),
        None => std::env::remove_var("HOME"),
    }
    match original_claude_home {
        Some(value) => std::env::set_var("CLAUDE_CONFIG_HOME", value),
        None => std::env::remove_var("CLAUDE_CONFIG_HOME"),
    }
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn structured_output_echoes_input_payload() {
    let result = execute_tool("StructuredOutput", &json!({"ok": true, "items": [1, 2, 3]}))
        .expect("StructuredOutput should succeed");
    let output: serde_json::Value = serde_json::from_str(&result).expect("json");
    assert_eq!(output["data"], "Structured output provided successfully");
    assert_eq!(output["structured_output"]["ok"], true);
    assert_eq!(output["structured_output"]["items"][1], 2);
}

#[test]
fn repl_executes_python_code() {
    let result = execute_tool(
        "REPL",
        &json!({"language": "python", "code": "print(1 + 1)", "timeout_ms": 500}),
    )
    .expect("REPL should succeed");
    let output: serde_json::Value = serde_json::from_str(&result).expect("json");
    assert_eq!(output["language"], "python");
    assert_eq!(output["exitCode"], 0);
    assert!(output["stdout"].as_str().expect("stdout").contains('2'));
}

#[cfg(not(windows))]
#[test]
fn powershell_runs_via_stub_shell() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = std::env::temp_dir().join(format!(
        "clawd-pwsh-bin-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).expect("create dir");
    let script = dir.join("pwsh");
    std::fs::write(
        &script,
        r#"#!/bin/sh
while [ "$1" != "-Command" ] && [ $# -gt 0 ]; do shift; done
shift
printf 'pwsh:%s' "$1"
"#,
    )
    .expect("write script");
    std::process::Command::new("/bin/chmod")
        .arg("+x")
        .arg(&script)
        .status()
        .expect("chmod");
    let original_path = std::env::var("PATH").unwrap_or_default();
    std::env::set_var("PATH", format!("{}:{}", dir.display(), original_path));

    let result = execute_tool(
        "PowerShell",
        &json!({"command": "Write-Output hello", "timeout": 10_000}),
    )
    .expect("PowerShell should succeed");

    let background = execute_tool(
        "PowerShell",
        &json!({"command": "Write-Output hello", "run_in_background": true}),
    )
    .expect("PowerShell background should succeed");

    std::env::set_var("PATH", original_path);
    let _ = std::fs::remove_dir_all(dir);

    let output: serde_json::Value = serde_json::from_str(&result).expect("json");
    assert_eq!(output["stdout"], "pwsh:Write-Output hello");
    assert!(output["stderr"].as_str().expect("stderr").is_empty());

    let background_output: serde_json::Value = serde_json::from_str(&background).expect("json");
    assert!(background_output["backgroundTaskId"].as_str().is_some());
    assert_eq!(background_output["backgroundedByUser"], true);
    assert_eq!(background_output["assistantAutoBackgrounded"], false);
}

#[cfg(windows)]
#[test]
fn powershell_runs_via_system_shell() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let result = execute_tool(
        "PowerShell",
        &json!({"command": "Write-Output hello", "timeout": 10_000}),
    )
    .expect("PowerShell should succeed");

    let background = execute_tool(
        "PowerShell",
        &json!({"command": "Write-Output hello", "run_in_background": true}),
    )
    .expect("PowerShell background should succeed");

    let output: serde_json::Value = serde_json::from_str(&result).expect("json");
    assert!(output["stdout"].as_str().expect("stdout").contains("hello"));
    assert_eq!(output["returnCodeInterpretation"], serde_json::Value::Null);

    let background_output: serde_json::Value = serde_json::from_str(&background).expect("json");
    assert!(background_output["backgroundTaskId"].as_str().is_some());
    assert_eq!(background_output["backgroundedByUser"], true);
    assert_eq!(background_output["assistantAutoBackgrounded"], false);
}

#[test]
fn powershell_errors_when_shell_is_missing() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let original_path = std::env::var("PATH").unwrap_or_default();
    let empty_dir = std::env::temp_dir().join(format!(
        "clawd-empty-bin-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos()
    ));
    std::fs::create_dir_all(&empty_dir).expect("create empty dir");
    std::env::set_var("PATH", empty_dir.display().to_string());

    let err = execute_tool("PowerShell", &json!({"command": "Write-Output hello"}))
        .expect_err("PowerShell should fail when shell is missing");

    std::env::set_var("PATH", original_path);
    let _ = std::fs::remove_dir_all(empty_dir);

    assert!(err.contains("PowerShell executable not found"));
}

struct TestServer {
    addr: SocketAddr,
    shutdown: Option<std::sync::mpsc::Sender<()>>,
    handle: Option<thread::JoinHandle<()>>,
}

impl TestServer {
    fn spawn(handler: Arc<dyn Fn(&str) -> HttpResponse + Send + Sync + 'static>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        listener
            .set_nonblocking(true)
            .expect("set nonblocking listener");
        let addr = listener.local_addr().expect("local addr");
        let (tx, rx) = std::sync::mpsc::channel::<()>();

        let handle = thread::spawn(move || loop {
            if rx.try_recv().is_ok() {
                break;
            }

            match listener.accept() {
                Ok((mut stream, _)) => {
                    let mut buffer = [0_u8; 4096];
                    let size = stream.read(&mut buffer).expect("read request");
                    let request = String::from_utf8_lossy(&buffer[..size]).into_owned();
                    let request_line = request.lines().next().unwrap_or_default().to_string();
                    let response = handler(&request_line);
                    stream
                        .write_all(response.to_bytes().as_slice())
                        .expect("write response");
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("server accept failed: {error}"),
            }
        });

        Self {
            addr,
            shutdown: Some(tx),
            handle: Some(handle),
        }
    }

    fn addr(&self) -> SocketAddr {
        self.addr
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(handle) = self.handle.take() {
            handle.join().expect("join test server");
        }
    }
}

struct HttpResponse {
    status: u16,
    reason: &'static str,
    content_type: &'static str,
    body: String,
}

impl HttpResponse {
    fn html(status: u16, reason: &'static str, body: &str) -> Self {
        Self {
            status,
            reason,
            content_type: "text/html; charset=utf-8",
            body: body.to_string(),
        }
    }

    fn text(status: u16, reason: &'static str, body: &str) -> Self {
        Self {
            status,
            reason,
            content_type: "text/plain; charset=utf-8",
            body: body.to_string(),
        }
    }

    fn to_bytes(&self) -> Vec<u8> {
        format!(
                "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                self.status,
                self.reason,
                self.content_type,
                self.body.len(),
                self.body
            )
            .into_bytes()
    }
}

// ─── LlmReview routing + fallback tests ──────────────────────────────
//
// These tests serialize around ENV_LOCK_REVIEWER because resolve_reviewer_model
// reads real env vars (to check whether the requested model's key is set).

fn env_lock_reviewer() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

const REVIEWER_KEY_ENVS: &[&str] = &[
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GLM_API_KEY",
    "MINIMAX_API_KEY",
    "ARIS_MINIMAX_BASE_URL",
    "MINIMAX_BASE_URL",
    "KIMI_API_KEY",
];

struct ReviewerEnvSnapshot {
    vars: Vec<(&'static str, Option<String>)>,
}

impl ReviewerEnvSnapshot {
    fn capture_and_clear() -> Self {
        let vars = REVIEWER_KEY_ENVS
            .iter()
            .map(|n| (*n, std::env::var(n).ok()))
            .collect();
        for n in REVIEWER_KEY_ENVS {
            std::env::remove_var(n);
        }
        Self { vars }
    }
}

impl Drop for ReviewerEnvSnapshot {
    fn drop(&mut self) {
        for (name, prior) in &self.vars {
            match prior {
                Some(v) => std::env::set_var(name, v),
                None => std::env::remove_var(name),
            }
        }
    }
}

#[test]
fn route_openai_compat_model_picks_provider_from_name() {
    let _g = env_lock_reviewer().lock().unwrap();
    let _snap = ReviewerEnvSnapshot::capture_and_clear();

    assert_eq!(route_openai_compat_model("gpt-5.5").0, "OPENAI_API_KEY");
    assert_eq!(
        route_openai_compat_model("gemini-2.5-pro").0,
        "GEMINI_API_KEY"
    );
    assert_eq!(route_openai_compat_model("GLM-5").0, "GLM_API_KEY");
    assert_eq!(
        route_openai_compat_model("MiniMax-M2.7").0,
        "MINIMAX_API_KEY"
    );
    assert_eq!(
        route_openai_compat_model("MiniMax-M2.7").1,
        "https://api.minimaxi.com/v1/chat/completions"
    );
    std::env::set_var(
        "ARIS_MINIMAX_BASE_URL",
        "https://minimax-proxy.example.com/openai",
    );
    assert_eq!(
        route_openai_compat_model("MiniMax-M2.7").1,
        "https://minimax-proxy.example.com/openai/v1/chat/completions"
    );
    assert_eq!(route_openai_compat_model("kimi-k2.5").0, "KIMI_API_KEY");
    assert_eq!(route_openai_compat_model("moonshot-v1").0, "KIMI_API_KEY");
    // DeepSeek models route to their own API key.
    assert_eq!(
        route_openai_compat_model("deepseek-chat").0,
        "DEEPSEEK_API_KEY"
    );
}

#[test]
fn resolve_reviewer_model_returns_configured_when_input_absent() {
    let _g = env_lock_reviewer().lock().unwrap();
    let _snap = ReviewerEnvSnapshot::capture_and_clear();

    let model = resolve_reviewer_model(None, "kimi-k2.5");
    assert_eq!(model, "kimi-k2.5");
}

#[test]
fn resolve_reviewer_model_returns_configured_when_input_empty_string() {
    let _g = env_lock_reviewer().lock().unwrap();
    let _snap = ReviewerEnvSnapshot::capture_and_clear();

    let model = resolve_reviewer_model(Some(""), "kimi-k2.5");
    assert_eq!(model, "kimi-k2.5");
}

#[test]
fn resolve_reviewer_model_falls_back_when_requested_key_missing() {
    let _g = env_lock_reviewer().lock().unwrap();
    let _snap = ReviewerEnvSnapshot::capture_and_clear();
    std::env::set_var("KIMI_API_KEY", "sk-kimi");
    // Executor requested gpt-4o but only KIMI_API_KEY is set — fall back.
    let model = resolve_reviewer_model(Some("gpt-4o"), "kimi-k2.5");
    assert_eq!(model, "kimi-k2.5");
}

#[test]
fn resolve_reviewer_model_falls_back_on_provider_mismatch() {
    let _g = env_lock_reviewer().lock().unwrap();
    let _snap = ReviewerEnvSnapshot::capture_and_clear();
    // Both keys set, but configured reviewer is MiniMax — executor asking
    // for gpt-4o must NOT silently route to the stray OPENAI_API_KEY.
    std::env::set_var("MINIMAX_API_KEY", "mx-token");
    std::env::set_var("OPENAI_API_KEY", "sk-openai");
    let model = resolve_reviewer_model(Some("gpt-4o"), "MiniMax-M2.7");
    assert_eq!(
        model, "MiniMax-M2.7",
        "configured reviewer should win over coincidentally-present OpenAI key"
    );
}

#[test]
fn resolve_reviewer_model_honors_matching_override() {
    let _g = env_lock_reviewer().lock().unwrap();
    let _snap = ReviewerEnvSnapshot::capture_and_clear();
    // Configured reviewer is OpenAI (gpt-5.5); executor asks for gpt-5.5-mini.
    std::env::set_var("OPENAI_API_KEY", "sk-openai");
    let model = resolve_reviewer_model(Some("gpt-5.5-mini"), "gpt-5.5");
    assert_eq!(
        model, "gpt-5.5-mini",
        "same-provider override should be honored when the key is set"
    );
}

#[test]
fn resolve_anthropic_compat_reviewer_model_keeps_deepseek_configured() {
    let model = resolve_anthropic_compat_reviewer_model(
        Some("gpt-5.5"),
        "deepseek-v4-pro",
        Some("deepseek"),
    );
    assert_eq!(
        model, "deepseek-v4-pro",
        "skill-level GPT overrides must not replace a configured DeepSeek reviewer"
    );
}

#[test]
fn resolve_anthropic_compat_reviewer_model_honors_deepseek_override() {
    let model = resolve_anthropic_compat_reviewer_model(
        Some("deepseek-chat"),
        "deepseek-v4-pro",
        Some("deepseek"),
    );
    assert_eq!(model, "deepseek-chat");
}

#[test]
fn llm_review_disabled_reviewer_does_not_fall_back_to_gpt() {
    let _g = env_lock_reviewer().lock().unwrap();
    let _snap = ReviewerEnvSnapshot::capture_and_clear();
    std::env::set_var("ARIS_REVIEWER_PROVIDER", "none");

    let error = run_llm_review(LlmReviewInput {
        prompt: "ping".to_string(),
        model: None,
    })
    .expect_err("disabled reviewer should stop before default model routing");

    assert!(error.contains("reviewer is disabled"));
    assert!(!error.contains("gpt-5.5"));
}

#[test]
fn resolve_reviewer_model_after_slash_reviewer_switch() {
    // Regression test: `/setup` Gemini → `/reviewer gpt-5.5` updates
    // ARIS_REVIEWER_MODEL but leaves ARIS_REVIEWER_PROVIDER stale as "gemini".
    // Executor now asks for gpt-5.5-mini — this MUST be honored since the
    // user's real intent (per ARIS_REVIEWER_MODEL) is OpenAI.
    let _g = env_lock_reviewer().lock().unwrap();
    let _snap = ReviewerEnvSnapshot::capture_and_clear();
    std::env::set_var("OPENAI_API_KEY", "sk-openai");
    // Stale provider env var from earlier /setup — deliberately wrong.
    std::env::set_var("ARIS_REVIEWER_PROVIDER", "gemini");

    let model = resolve_reviewer_model(Some("gpt-5.5-mini"), "gpt-5.5");
    assert_eq!(
        model, "gpt-5.5-mini",
        "provider consistency must come from configured_model, not stale ARIS_REVIEWER_PROVIDER"
    );

    std::env::remove_var("ARIS_REVIEWER_PROVIDER");
}

#[test]
fn llm_review_openai_urls_are_normalized_for_shared_executor() {
    assert_eq!(
        super::openai_executor_base_url("https://api.openai.com/v1/chat/completions"),
        "https://api.openai.com/v1"
    );
    assert_eq!(
        super::openai_executor_base_url("https://proxy.example.com/openai"),
        "https://proxy.example.com/openai"
    );
    assert_eq!(
        super::openai_executor_base_url("https://proxy.example.com"),
        "https://proxy.example.com/v1"
    );
}

#[test]
fn llm_review_anthropic_urls_are_normalized_for_shared_executor() {
    assert_eq!(
        super::anthropic_executor_base_url("https://api.anthropic.com/v1/messages"),
        "https://api.anthropic.com"
    );
    assert_eq!(
        super::anthropic_executor_base_url("https://api.anthropic.com/v1"),
        "https://api.anthropic.com"
    );
    assert_eq!(
        super::anthropic_executor_base_url("https://api.deepseek.com/anthropic"),
        "https://api.deepseek.com/anthropic"
    );
}
