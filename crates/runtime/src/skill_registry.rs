//! Canonical names and staged aliases for user-facing research skills.
//!
//! The registry is intentionally separate from filesystem discovery. Discovery
//! answers "what exists on disk"; this module answers "which implementation is
//! authoritative" and makes a compatibility cut-over explicit and testable.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkillLifecycle {
    /// The canonical workflow is user-visible and aliases may resolve to it.
    Active,
    /// The mapping is documented, but the old implementation remains active
    /// until feature parity and migration checks have passed.
    Staged,
    /// The workflow is planned but has no implementation yet.
    Planned,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SkillRegistryEntry {
    pub canonical_name: &'static str,
    pub aliases: &'static [&'static str],
    pub profiles: &'static [&'static str],
    pub lifecycle: SkillLifecycle,
}

/// The four user-facing literature workflows. Search aliases have completed
/// their cut-over. Screening/evidence are active product workflows, while
/// their broader legacy batch-analysis skills remain independently available.
pub const LITERATURE_SKILL_REGISTRY: &[SkillRegistryEntry] = &[
    SkillRegistryEntry {
        canonical_name: "literature-search",
        aliases: &["research-lit", "arxiv", "scopus-search", "comm-lit-review"],
        profiles: &["default", "communications", "arxiv", "scopus"],
        lifecycle: SkillLifecycle::Active,
    },
    SkillRegistryEntry {
        canonical_name: "literature-screen",
        aliases: &[],
        profiles: &["title-abstract", "full-text"],
        lifecycle: SkillLifecycle::Active,
    },
    SkillRegistryEntry {
        canonical_name: "literature-evidence",
        aliases: &[],
        profiles: &["review", "domain-map", "wiki"],
        lifecycle: SkillLifecycle::Active,
    },
    SkillRegistryEntry {
        canonical_name: "novelty-audit",
        aliases: &["novelty-check"],
        profiles: &["research"],
        lifecycle: SkillLifecycle::Planned,
    },
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RegisteredSkillResolution {
    pub requested_name: &'static str,
    pub canonical_name: &'static str,
    pub profile: Option<&'static str>,
    pub lifecycle: SkillLifecycle,
}

/// Look up a registered literature workflow without changing its activation
/// state. Callers must only redirect an alias when its lifecycle is `Active`.
#[must_use]
pub fn registered_literature_skill(name: &str) -> Option<RegisteredSkillResolution> {
    let requested = name.trim().trim_start_matches('/').trim_start_matches('$');
    LITERATURE_SKILL_REGISTRY.iter().find_map(|entry| {
        if entry.canonical_name.eq_ignore_ascii_case(requested) {
            return Some(RegisteredSkillResolution {
                requested_name: entry.canonical_name,
                canonical_name: entry.canonical_name,
                profile: Some("default"),
                lifecycle: entry.lifecycle,
            });
        }
        entry.aliases.iter().find_map(|alias| {
            alias
                .eq_ignore_ascii_case(requested)
                .then_some(RegisteredSkillResolution {
                    requested_name: alias,
                    canonical_name: entry.canonical_name,
                    profile: profile_for_alias(entry.canonical_name, alias),
                    lifecycle: entry.lifecycle,
                })
        })
    })
}

/// Resolve only activated aliases. This is the function the tools crate uses
/// so a registry entry cannot silently interrupt a legacy user workflow.
#[must_use]
pub fn activated_canonical_skill_name(name: &str) -> Option<&'static str> {
    let resolution = registered_literature_skill(name)?;
    (resolution.lifecycle == SkillLifecycle::Active).then_some(resolution.canonical_name)
}

fn profile_for_alias(canonical_name: &str, alias: &str) -> Option<&'static str> {
    match (canonical_name, alias) {
        ("literature-search", "comm-lit-review") => Some("communications"),
        ("literature-search", "arxiv") => Some("arxiv"),
        ("literature-search", "scopus-search") => Some("scopus"),
        _ => Some("default"),
    }
}

#[cfg(test)]
#[path = "tests/skill_registry.rs"]
mod tests;
