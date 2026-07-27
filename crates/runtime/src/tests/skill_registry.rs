use super::{
    activated_canonical_skill_name, registered_literature_skill, SkillLifecycle,
    LITERATURE_SKILL_REGISTRY,
};
use std::collections::BTreeSet;

#[test]
fn registry_has_one_canonical_owner_for_every_name() {
    let mut names = BTreeSet::new();
    for entry in LITERATURE_SKILL_REGISTRY {
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
    let resolution = registered_literature_skill("comm-lit-review").expect("registry entry");
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
        registered_literature_skill("literature-screen")
            .expect("screen workflow")
            .lifecycle,
        SkillLifecycle::Active
    );
    assert_eq!(
        registered_literature_skill("literature-evidence")
            .expect("evidence workflow")
            .lifecycle,
        SkillLifecycle::Active
    );
    assert!(registered_literature_skill("paper-batch-grading").is_none());
    assert!(registered_literature_skill("survey-topic-analysis").is_none());
}
