use super::{
    activated_canonical_skill_name, registered_skill, SkillLifecycle,
    SKILL_REGISTRY,
};
use std::collections::BTreeSet;

#[test]
fn registry_has_one_canonical_owner_for_every_name() {
    let mut names = BTreeSet::new();
    for entry in SKILL_REGISTRY {
        assert!(names.insert(entry.canonical_name));
        for alias in entry.aliases {
            assert!(
                names.insert(alias),
                "duplicate registered skill name: {alias}"
            );
        }
    }
}

#[test]
fn active_search_aliases_redirect_with_their_compatibility_profile() {
    let resolution = registered_skill("comm-lit-review").expect("registry entry");
    assert_eq!(resolution.canonical_name, "literature-search");
    assert_eq!(resolution.profile, Some("communications"));
    assert_eq!(resolution.lifecycle, SkillLifecycle::Active);
    assert_eq!(
        activated_canonical_skill_name("comm-lit-review"),
        Some("literature-search")
    );
}

#[test]
fn screen_and_evidence_are_active_without_hijacking_broader_legacy_skills() {
    assert_eq!(
        registered_skill("literature-screen")
            .expect("screen workflow")
            .lifecycle,
        SkillLifecycle::Active
    );
    assert_eq!(
        registered_skill("literature-evidence")
            .expect("evidence workflow")
            .lifecycle,
        SkillLifecycle::Active
    );
    assert!(registered_skill("paper-batch-grading").is_none());
    assert!(registered_skill("survey-topic-analysis").is_none());
}

#[test]
fn web_design_is_an_active_canonical_skill() {
    let resolution = registered_skill("web-design").expect("web design skill");
    assert_eq!(resolution.canonical_name, "web-design");
    assert_eq!(resolution.lifecycle, SkillLifecycle::Active);
    assert_eq!(
        activated_canonical_skill_name("web-design"),
        Some("web-design")
    );
}

/// The nine patent stage skills were merged into two. Their directories are
/// gone, so they no longer appear in the listing — but typing the old name must
/// still land on the stage it became, not "unknown skill".
#[test]
fn merged_patent_stages_redirect_to_their_new_stage() {
    for (legacy, canonical, profile) in [
        ("prior-art-search", "patent-novelty", "search"),
        ("patent-novelty-check", "patent-novelty", "assess"),
        ("invention-structuring", "patent-draft", "structure"),
        ("claims-drafting", "patent-draft", "claims"),
        ("figure-description", "patent-draft", "figures"),
        ("embodiment-description", "patent-draft", "embodiments"),
        ("specification-writing", "patent-draft", "spec"),
        ("patent-review", "patent-draft", "review"),
        ("jurisdiction-format", "patent-draft", "format"),
    ] {
        let resolution = registered_skill(legacy).unwrap_or_else(|| panic!("{legacy} unregistered"));
        assert_eq!(resolution.canonical_name, canonical, "{legacy}");
        assert_eq!(resolution.profile, Some(profile), "{legacy}");
        assert_eq!(
            activated_canonical_skill_name(legacy),
            Some(canonical),
            "{legacy} must resolve without a directory on disk"
        );
    }

    // The orchestrator keeps its own identity — it is not an alias of anything.
    assert!(registered_skill("patent-pipeline").is_none());
}
