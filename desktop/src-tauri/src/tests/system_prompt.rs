use super::*;
use crate::engine::tests::workflow_runtime_context;
use std::path::PathBuf;

/// A fully-specified prompt key, so prompt-content assertions do not depend on
/// the machine's config, workspace, or memory files.
fn prompt_cache_key_for_test(review_enabled: bool) -> SystemPromptCacheKey {
    SystemPromptCacheKey {
        model: "test-model".to_string(),
        full_tool_registry: true,
        workspace: PathBuf::from("/tmp/project"),
        current_date: "2026-08-07".to_string(),
        language: "cn".to_string(),
        texlive: None,
        hot_memory: String::new(),
        knowledge_memory: String::new(),
        project_goal: String::new(),
        instruction_fingerprint: String::new(),
        review_enabled,
    }
}

/// Independent review is opt-in and off by default. Describing a Reviewer that
/// will never run both misstates the runtime and leaves only the pressure never
/// to call anything finished, with nothing that would actually catch a mistake.
#[test]
fn the_completion_contract_only_promises_a_reviewer_that_will_run() {
    let mut with_review_key = prompt_cache_key_for_test(true);
    with_review_key.project_goal =
        "# Project continuity\nLong-term project intent: Preserve evidence.".to_string();
    let with_review = build_system_prompt_uncached(&with_review_key).join("\n");
    assert!(with_review.contains("independent Reviewer"));
    assert!(with_review.contains("review-eligible"));
    assert!(with_review.contains("not automatically reviewed"));
    assert!(with_review.contains("one-step edit"));
    assert!(
        with_review
            .find("# Project continuity")
            .expect("project context")
            < with_review
                .find("Complex task contract")
                .expect("planning contract")
    );

    let without_review = build_system_prompt_uncached(&prompt_cache_key_for_test(false)).join("\n");
    assert!(!without_review.contains("independent Reviewer"));
    assert!(without_review.contains("Nothing reviews your result after this turn"));
    // The rest of the contract is unchanged either way.
    assert!(without_review.contains("Complex task contract"));
    assert!(without_review.contains("TodoWrite"));
}

#[test]
fn desktop_prompt_requests_links_for_generated_files() {
    let prompt = build_system_prompt_inner("test-model", true).join("\n");

    assert!(prompt.contains("desktop tool registry"));
    assert!(prompt.contains("include Markdown links"));
    assert!(prompt.contains("Existing artifact edits"));
    assert!(prompt.contains("Do not create sibling version files"));
    assert!(prompt.contains("fenced `mermaid` code block"));
    assert!(prompt.contains("Long file generation"));
    assert!(prompt.contains("24000 characters"));
    assert!(prompt.contains("append_file"));
    assert!(prompt.contains("MUST call `ProjectEvidenceSearch`"));
    assert!(prompt.contains("Do not silently substitute web or external metadata search"));
}

#[test]
fn desktop_prompt_is_deterministic_for_prompt_caching() {
    // The system prompt is rebuilt every turn and forms the request prefix.
    // OpenAI-compatible automatic prompt caching (the only caching path ARIS
    // has — there is no native Anthropic /v1/messages channel) only engages
    // when that prefix is byte-identical across turns. Any per-call
    // nondeterminism — a timestamp, a random id, HashMap iteration order — in
    // a prompt section would silently bust the cache and quietly inflate input
    // token cost. Guard the invariant so such a regression fails loudly here.
    let first = build_system_prompt_inner("test-model", true).join("\n");
    let second = build_system_prompt_inner("test-model", true).join("\n");
    assert_eq!(
        first, second,
        "system prompt must be deterministic across rebuilds so prompt caching can hit"
    );
}

#[test]
fn latex_toolchain_prompt_prefers_texlive_over_tectonic() {
    let prompt = latex_toolchain_prompt_section(Some(r"C:\texlive\2026\bin\windows\latexmk.exe"));

    assert!(prompt.contains("TeX Live"));
    assert!(prompt.contains("latexmk"));
    assert!(prompt.contains("pdflatex"));
    assert!(prompt.contains("Do not use Tectonic"));
    assert!(prompt.contains("latexmk.exe"));
}

#[test]
fn workflow_system_prompt_states_the_right_tool_boundary_per_lane() {
    let binding = workflow_runtime_context("matrix-strategy", true).binding;
    let autonomous = build_workflow_system_prompt(&binding, true).join("\n");
    let discussion = build_workflow_system_prompt(&binding, false).join("\n");

    assert!(autonomous.contains("fixed explicit allow-list"));
    assert!(autonomous.contains("WorkflowScopusProbe"));
    // Telling a discussion turn the registry is a fixed allow-list would be
    // false and would suppress the tool use the user opened Chat for.
    assert!(!discussion.contains("fixed explicit allow-list"));
    assert!(discussion.contains("ordinary desktop tool registry"));
    assert!(discussion.contains("Shared-context notice"));
}
