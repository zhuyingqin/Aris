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
        include_builtin_memory: true,
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

/// The claim ceiling earns its place by being a typing rule rather than a
/// judgement: it caps what a given kind of evidence may assert, identically for
/// every claim. The moment it instructs the model to decide whether a premise
/// is true, it becomes the intervention arXiv:2607.08456 measured, which
/// disputes sound premises at 57% and buys resistance by destroying usefulness.
#[test]
fn the_claim_ceiling_types_evidence_without_asking_for_a_verdict_on_premises() {
    // Hermetic key: the negative assertions below would otherwise be decided by
    // whatever sits in this machine's memory and project-goal files.
    let prompt = build_system_prompt_uncached(&prompt_cache_key_for_test(true)).join("\n");

    assert!(prompt.contains("Claim ceiling"));
    assert!(prompt.contains("never evidence that its own premise holds in reality"));
    assert!(prompt.contains("treat it as the hypothesis under test"));
    // Removing completion pressure is the half that cuts undisclosed
    // fabrication (arXiv:2605.10246); without it the rule just renames the
    // pressure to produce a supportive finding.
    assert!(prompt.contains("producing a supportive conclusion is not"));
    assert!(prompt.contains("is a successful delivery"));

    for challenge_instruction in [
        "challenge the premise",
        "push back on",
        "refuse the",
        "pseudoscien",
        "decide whether the claim is true",
    ] {
        assert!(
            !prompt.to_lowercase().contains(challenge_instruction),
            "the claim ceiling must not ask the model to adjudicate premises: {challenge_instruction}"
        );
    }
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

/// The system prompt is rebuilt every turn and forms the request prefix.
/// OpenAI-compatible automatic prompt caching (the only caching path ARIS has —
/// there is no native Anthropic /v1/messages channel) only engages when that
/// prefix is byte-identical across turns. Any per-call nondeterminism — a
/// timestamp, a random id, HashMap iteration order — in a prompt section would
/// silently bust the cache and quietly inflate input token cost.
///
/// This has to assemble twice from one key. Calling `build_system_prompt_inner`
/// twice instead only proves the memo cache returns what it stored: the second
/// call never reaches the assembly, so the comparison holds however
/// nondeterministic the assembly is.
#[test]
fn desktop_prompt_is_deterministic_for_prompt_caching() {
    let workspace = tempfile::tempdir().expect("temp workspace");
    let root = workspace.path();
    std::fs::write(root.join("AGENTS.md"), "# Rules\nPrefer evidence.").expect("agents file");
    std::fs::create_dir_all(root.join("src")).expect("source dir");
    std::fs::write(root.join("src").join("main.rs"), "fn main() {}").expect("source file");
    let mut key = prompt_cache_key_for_test(true);
    key.workspace = root.to_path_buf();

    let first = build_system_prompt_uncached(&key).join("\n");
    let second = build_system_prompt_uncached(&key).join("\n");

    assert_eq!(
        first, second,
        "system prompt must be deterministic across rebuilds so prompt caching can hit"
    );
    // Without these the test could pass by comparing two identically empty
    // prompts, which is exactly the failure mode it replaces.
    assert!(first.contains("# Project context"));
    assert!(first.contains("Prefer evidence."));
    assert!(first.contains("# Available skills"));
    assert!(first.contains("# Runtime config"));
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
