//! Membership features the desktop enforces itself.
//!
//! Tiers are New API user groups defined in SomniQ-Site `deploy/newapi/tiers.json`
//! (applied to the gateway by `deploy/newapi/configure-tiers.mjs`). Model credits are
//! metered by New API on every call; features that run on this machine are
//! gated here from the account group the last bootstrap reported.

use serde::Deserialize;
use std::sync::OnceLock;

/// A copy of the catalog the gateway and the website use (SomniQ-Site
/// `deploy/newapi/tiers.json`), compiled in. Update both together.
const CATALOG_JSON: &str = include_str!("membership_tiers.json");

/// Tools that build, preview or run a systematic (protocol) literature search.
/// The review workflow's retrieval stages use them too, so gating them gates it.
pub(crate) const SYSTEMATIC_SEARCH_TOOLS: &[&str] = &[
    "LiteratureSearchProtocolCreate",
    "LiteratureSearchPreview",
    "LiteratureSearchExecute",
];

const EXTERNAL_LITERATURE_TOOLS: &[&str] = &["LiteratureSearch", "LiteratureCitations"];

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
    features: TierFeatures,
}

#[derive(Deserialize)]
struct TierName {
    zh: String,
}

#[derive(Deserialize)]
struct TierFeatures {
    #[serde(rename = "systematicSearch")]
    systematic_search: bool,
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

/// Why an account in `group` may not use systematic search, or `None` if it may.
fn systematic_search_denial_for(group: &str) -> Option<String> {
    let tier = tier_for_group(group);
    if tier.features.systematic_search {
        return None;
    }
    let lowest = catalog()
        .tiers
        .iter()
        .find(|tier| tier.features.systematic_search)
        .map_or("Plus", |tier| tier.name.zh.as_str());
    Some(format!(
        "系统检索（检索式 + 多数据库 + 预算分配，综述工作流也要用到）需要 {lowest} 及以上会员，当前是{}。普通文献检索不受影响；如需系统检索，请到官网会员页升级。",
        tier.name.zh
    ))
}

/// Why the signed-in account may not use systematic search. A desktop without a
/// managed account (development builds, the devserver, tests) is never gated.
pub(crate) fn systematic_search_denial() -> Option<String> {
    crate::newapi::managed_account_group().and_then(|group| systematic_search_denial_for(&group))
}

fn external_literature_denial_for(group: &str) -> Option<String> {
    let tier = tier_for_group(group);
    (tier.group == catalog().free_group)
        .then(|| "外部文献检索需要 Go 及以上会员；免费版可使用本地文献库。".to_string())
}

pub(crate) fn external_literature_denial() -> Option<String> {
    crate::newapi::managed_account_group().and_then(|group| external_literature_denial_for(&group))
}

/// Refusal for a tool the account's tier does not include, if any.
pub(crate) fn denied_tool_message(tool_name: &str) -> Option<String> {
    if SYSTEMATIC_SEARCH_TOOLS.contains(&tool_name) {
        systematic_search_denial()
    } else if EXTERNAL_LITERATURE_TOOLS.contains(&tool_name) {
        external_literature_denial()
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::{catalog, external_literature_denial_for, systematic_search_denial_for, tier_for_group};

    #[test]
    fn the_shared_catalog_parses_and_declares_every_tier() {
        let groups: Vec<_> = catalog().tiers.iter().map(|tier| tier.group.as_str()).collect();
        assert_eq!(groups, ["default", "go", "plus", "pro"]);
    }

    #[test]
    fn systematic_search_starts_at_plus() {
        assert!(systematic_search_denial_for("plus").is_none());
        assert!(systematic_search_denial_for("pro").is_none());
        let refusal = systematic_search_denial_for("go").expect("Go is refused");
        assert!(refusal.contains("Plus"), "{refusal}");
        assert!(refusal.contains("Go"), "{refusal}");
        assert!(systematic_search_denial_for("default").is_some());
    }

    #[test]
    fn unknown_or_retired_groups_never_count_as_paid() {
        assert_eq!(tier_for_group("vip").group, "default");
        assert_eq!(tier_for_group("").group, "default");
        assert!(systematic_search_denial_for("vip").is_some());
    }

    #[test]
    fn operator_groups_get_the_top_tier() {
        assert_eq!(tier_for_group("千研").group, "pro");
        assert!(systematic_search_denial_for("千研").is_none());
        assert!(external_literature_denial_for("千研").is_none());
    }

    #[test]
    fn external_literature_search_starts_at_go() {
        assert!(external_literature_denial_for("default").is_some());
        assert!(external_literature_denial_for("vip").is_some());
        for group in ["go", "plus", "pro"] {
            assert!(external_literature_denial_for(group).is_none());
        }
    }
}
