//! Membership features the desktop enforces itself.
//!
//! Tiers are New API user groups defined in SomniQ-Site `deploy/newapi/tiers.json`
//! (applied to the gateway by `deploy/newapi/configure-tiers.mjs`). Model credits are
//! metered by New API on every call; features that run on this machine are
//! gated here from the account group the last bootstrap reported.
//!
//! Literature has one gate: reaching external scholarly sources. Systematic
//! search used to be a separate, higher tier, but every paid tier now includes
//! it, and since `LiteratureSearch` carries a full protocol there is no longer a
//! separate systematic route to gate. Planning a search (`LiteratureSearchPreview`,
//! the protocol-create alias) opens no connection and is never gated.

use serde::Deserialize;
use std::sync::OnceLock;

/// A copy of the catalog the gateway and the website use (SomniQ-Site
/// `deploy/newapi/tiers.json`), compiled in. Update both together.
const CATALOG_JSON: &str = include_str!("membership_tiers.json");

/// Tools that send a request to an external scholarly source. The review
/// workflow's retrieval stages run through them too, so gating them gates it.
const EXTERNAL_LITERATURE_TOOLS: &[&str] = &[
    "LiteratureSearch",
    "LiteratureCitations",
    "LiteratureSearchExecute",
];

#[derive(Deserialize)]
struct Catalog {
    #[serde(rename = "operatorGroups", default)]
    operator_groups: Vec<String>,
    #[serde(rename = "freeGroup")]
    free_group: String,
    tiers: Vec<Tier>,
}

#[derive(Deserialize)]
struct Tier {
    group: String,
    name: TierName,
}

#[derive(Deserialize)]
struct TierName {
    zh: String,
}

fn catalog() -> &'static Catalog {
    static CATALOG: OnceLock<Catalog> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(CATALOG_JSON)
            .expect("membership_tiers.json is a copy of the validated SomniQ-Site catalog")
    })
}

/// Operator groups (the owner's own routing) get the top tier. Any other group
/// that is not a tier's — a retired group, or none reported yet — gets the free
/// tier, never a paid one.
fn tier_for_group(group: &str) -> &'static Tier {
    let catalog = catalog();
    if catalog.operator_groups.iter().any(|operator| operator == group) {
        return catalog.tiers.last().expect("tiers.json declares its tiers");
    }
    catalog
        .tiers
        .iter()
        .find(|tier| tier.group == group)
        .or_else(|| catalog.tiers.iter().find(|tier| tier.group == catalog.free_group))
        .expect("tiers.json declares its free group")
}

fn external_literature_denial_for(group: &str) -> Option<String> {
    let catalog = catalog();
    let tier = tier_for_group(group);
    if tier.group != catalog.free_group {
        return None;
    }
    let lowest_paid = catalog
        .tiers
        .iter()
        .find(|tier| tier.group != catalog.free_group)
        .map_or("Go", |tier| tier.name.zh.as_str());
    Some(format!(
        "外部文献检索（含系统检索与综述工作流）需要 {lowest_paid} 及以上会员，当前是{}；免费版可使用本地文献库。",
        tier.name.zh
    ))
}

/// Why the signed-in account may not reach external scholarly sources. A
/// desktop without a managed account (development builds, the devserver,
/// tests) is never gated.
pub(crate) fn external_literature_denial() -> Option<String> {
    crate::newapi::managed_account_group().and_then(|group| external_literature_denial_for(&group))
}

/// Refusal for a tool the account's tier does not include, if any.
pub(crate) fn denied_tool_message(tool_name: &str) -> Option<String> {
    if EXTERNAL_LITERATURE_TOOLS.contains(&tool_name) {
        external_literature_denial()
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::{catalog, external_literature_denial_for, tier_for_group, EXTERNAL_LITERATURE_TOOLS};

    #[test]
    fn the_shared_catalog_parses_and_declares_every_tier() {
        let groups: Vec<_> = catalog().tiers.iter().map(|tier| tier.group.as_str()).collect();
        assert_eq!(groups, ["default", "go", "plus", "pro"]);
    }

    #[test]
    fn unknown_or_retired_groups_never_count_as_paid() {
        assert_eq!(tier_for_group("vip").group, "default");
        assert_eq!(tier_for_group("").group, "default");
        assert!(external_literature_denial_for("vip").is_some());
    }

    #[test]
    fn operator_groups_get_the_top_tier() {
        assert_eq!(tier_for_group("千研").group, "pro");
        assert!(external_literature_denial_for("千研").is_none());
    }

    #[test]
    fn external_literature_search_starts_at_go() {
        let refusal = external_literature_denial_for("default").expect("Free is refused");
        assert!(refusal.contains("Go"), "{refusal}");
        assert!(refusal.contains("免费版"), "{refusal}");
        for group in ["go", "plus", "pro"] {
            assert!(external_literature_denial_for(group).is_none(), "{group}");
        }
    }

    #[test]
    fn planning_a_search_is_never_gated() {
        // Preview and the protocol-create alias open no connection.
        for tool in ["LiteratureSearchPreview", "LiteratureSearchProtocolCreate"] {
            assert!(!EXTERNAL_LITERATURE_TOOLS.contains(&tool), "{tool}");
        }
        assert!(EXTERNAL_LITERATURE_TOOLS.contains(&"LiteratureSearchExecute"));
    }
}
