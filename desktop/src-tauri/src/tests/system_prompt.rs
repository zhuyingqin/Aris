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
        tectonic: None,
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
    // A complete CJK payload must not be rejected by an after-the-fact token
    // estimate. Oversized generation uses a staged atomic transaction.
    assert!(prompt.contains("exceeds 9000"));
    assert!(prompt.contains("do not reject it merely because an estimated token count"));
    assert!(prompt.contains("begin_large_write"));
    assert!(prompt.contains("append_write_chunk"));
    assert!(prompt.contains("commit_large_write"));
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
    // Prompt assembly reads user-level skills and config, which resolve through
    // HOME/USERPROFILE. Other desktop tests temporarily override those process
    // globals, so serialize this check with the shared environment lock.
    let _guard = crate::test_env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
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

/// TeX Live wins when it is there, but as a preference rather than a ban: the
/// section must not tell the model that the compiler the installer shipped is
/// off limits.
#[test]
fn latex_toolchain_prompt_prefers_texlive_when_it_is_installed() {
    let prompt = latex_toolchain_prompt_section(
        Some(r"C:\texlive\2026\bin\windows\latexmk.exe"),
        Some(r"C:\Program Files\SomniQ\bin\tectonic.exe"),
    );

    assert!(prompt.contains("TeX Live"));
    assert!(prompt.contains("latexmk"));
    assert!(prompt.contains("pdflatex"));
    assert!(prompt.contains("latexmk.exe"));
    assert!(prompt.contains("Prefer TeX Live over Tectonic"));
    assert!(!prompt.contains("Do not use Tectonic"));
}

/// The regression this section was rewritten for: with no TeX Live on PATH, the
/// old wording forbade Tectonic while the installer had just bundled one and
/// exported its path, so every `.tex` build dead-ended on a working compiler the
/// model had been told not to run.
#[test]
fn latex_toolchain_prompt_falls_back_to_the_bundled_tectonic() {
    let prompt =
        latex_toolchain_prompt_section(None, Some(r"C:\Program Files\SomniQ\bin\tectonic.exe"));

    assert!(prompt.contains("tectonic.exe"));
    assert!(prompt.contains("ARIS_TECTONIC"));
    assert!(!prompt.contains("Do not use Tectonic"));
    // Installing TeX Live is the last resort, not the first answer.
    assert!(prompt.contains("Only after Tectonic itself fails"));
}

/// With neither engine present there is nothing to route to, so the section has
/// to say so instead of naming a command that will not run.
#[test]
fn latex_toolchain_prompt_reports_no_engine_when_there_is_none() {
    let prompt = latex_toolchain_prompt_section(None, None);

    assert!(prompt.contains("no LaTeX engine has been detected"));
    assert!(prompt.contains("install TeX Live"));
    assert!(prompt.contains("Do not guess a compile command"));
}

/// `.somniq/` is hidden and git-ignored, so a source file routed there never
/// reaches the project's build. The layout section has to state the boundary,
/// not just the destinations.
#[test]
fn artifact_layout_excludes_project_build_sources() {
    let prompt = build_system_prompt_uncached(&prompt_cache_key_for_test(true)).join("\n");

    assert!(prompt.contains("Project artifact layout"));
    assert!(prompt.contains("covers generated research artifacts only"));
    assert!(prompt.contains("goes in the project source tree at its conventional path"));
    // The tie-breaker matters more than the rule: an ambiguous request is the
    // case that actually misroutes.
    assert!(prompt.contains("write to the project source tree and say where you put it"));
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
