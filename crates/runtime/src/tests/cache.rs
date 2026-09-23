use super::*;

#[test]
fn extract_one_writes_simple_file() {
    let tmp = std::env::temp_dir().join(format!("aris-test-{}", rand_suffix()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).unwrap();
    extract_one(&tmp, "tools/foo.py", "print('hi')").unwrap();
    let dst = tmp.join("tools").join("foo.py");
    assert!(dst.is_file(), "{} should exist", dst.display());
    assert_eq!(std::fs::read_to_string(&dst).unwrap(), "print('hi')");
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn extract_one_rejects_absolute_key() {
    let tmp = std::env::temp_dir().join(format!("aris-test-{}", rand_suffix()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).unwrap();
    let err = extract_one(&tmp, "/etc/passwd", "evil").unwrap_err();
    assert!(
        err.contains("absolute") || err.contains("root-dir"),
        "got: {err}"
    );
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn extract_one_rejects_parent_segment() {
    let tmp = std::env::temp_dir().join(format!("aris-test-{}", rand_suffix()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).unwrap();
    let err = extract_one(&tmp, "tools/../escape.py", "evil").unwrap_err();
    assert!(err.contains("parent-dir"), "got: {err}");
    let _ = std::fs::remove_dir_all(&tmp);
}

// Unix only: fs::rename is atomic overwrite. On Windows fs::rename fails
// when target exists; cache contract is "first writer wins with identical
// content", so we don't test overwrite there.
#[cfg(unix)]
#[test]
fn extract_one_overwrites_existing() {
    let tmp = std::env::temp_dir().join(format!("aris-test-{}", rand_suffix()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).unwrap();
    extract_one(&tmp, "tools/x.py", "v1").unwrap();
    extract_one(&tmp, "tools/x.py", "v2").unwrap();
    let got = std::fs::read_to_string(tmp.join("tools/x.py")).unwrap();
    assert_eq!(got, "v2", "should overwrite existing content");
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn extract_one_rejects_root_segment() {
    let tmp = std::env::temp_dir().join(format!("aris-test-{}", rand_suffix()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).unwrap();
    // Leading "/" — Path::new will produce a RootDir component
    let err = extract_one(&tmp, "/tools/x.py", "evil").unwrap_err();
    // Either is_absolute path or root-dir component is caught; both messages OK
    assert!(
        err.contains("absolute") || err.contains("root-dir"),
        "got: {err}"
    );
    let _ = std::fs::remove_dir_all(&tmp);
}

/// v0.4.9 T29: every bundle key cited inside a bundled SKILL.md prose
/// must resolve to an actual entry in BUNDLED_RESOURCES. Guards against
/// the H6 regression where SKILL.md `python3 tools/foo.py` references
/// silently 404'd because foo.py was never bundled.
///
/// Detection rule (deliberately narrow to avoid false positives from
/// prose mentions): we match the runtime-injected `$ARIS_CACHE_DIR/`
/// substitution pattern that v0.4.8+ SKILL.md migrations use, and we
/// match unprefixed `python3 tools/<helper>` literals that survived
/// from the v0.4.7 era. shared-references/* doesn't need direct
/// invocation references; templates/ are read via fs paths not exec.
#[test]
fn bundle_inventory_skill_md_refs_resolve_to_bundled_resources() {
    use regex::Regex;
    let bundled_keys: std::collections::HashSet<&'static str> =
        crate::BUNDLED_RESOURCES.iter().map(|(k, _)| *k).collect();

    // Match either:
    //   "$ARIS_CACHE_DIR/<key>" or "${ARIS_CACHE_DIR:-.}/<key>"
    //   bare "tools/<helper>.{py,sh}" (legacy literal still in some SKILLs)
    let cache_re = Regex::new(
        r#"\$\{?ARIS_CACHE_DIR(?::-[^}]*)?\}?/((?:tools|skills/[a-zA-Z0-9_-]+|shared-references|shared-governance)/[a-zA-Z0-9_./-]+\.(?:py|sh|cjs|tex|cls|bst|md|toml|yaml|yml|json))"#,
    )
    .expect("compile cache_re");
    let legacy_re =
        Regex::new(r#"(?m)\bpython3\s+(?:"|)?(tools/[a-zA-Z0-9_./-]+\.(?:py|sh))(?:"|)?"#)
            .expect("compile legacy_re");

    let mut missing: Vec<(String, String)> = Vec::new();
    for (skill_name, content) in crate::BUNDLED_SKILLS {
        for cap in cache_re.captures_iter(content) {
            let key = &cap[1];
            if !bundled_keys.contains(key) {
                missing.push((skill_name.to_string(), key.to_string()));
            }
        }
        for cap in legacy_re.captures_iter(content) {
            let key = &cap[1];
            if !bundled_keys.contains(key) {
                missing.push((skill_name.to_string(), key.to_string()));
            }
        }
    }

    assert!(
        missing.is_empty(),
        "SKILL.md references {} bundle key(s) that are NOT in BUNDLED_RESOURCES:\n{}",
        missing.len(),
        missing
            .iter()
            .map(|(s, k)| format!("  /{s}: {k}"))
            .collect::<Vec<_>>()
            .join("\n")
    );
}

/// The whole bundle must materialise on disk, not just compile in.
///
/// Non-ASCII keys are the reason this is worth asserting: /soft-copyright ships
/// `软件说明书模板.html` and `申请表字段规则.md`, and a filesystem that mangles
/// those would fail at skill-run time, far from the bundler.
#[test]
fn full_bundle_extracts_including_non_ascii_keys() {
    let tmp = std::env::temp_dir().join(format!("aris-bundle-{}", rand_suffix()));
    let _ = std::fs::remove_dir_all(&tmp);

    let (extracted, failed) = try_extract_to(&tmp).expect("create cache dir");
    assert!(
        failed.is_empty(),
        "per-file extraction failures: {failed:?}"
    );
    assert_eq!(
        extracted.len(),
        crate::BUNDLED_RESOURCES.len(),
        "every bundled resource should extract"
    );

    for (key, content) in crate::BUNDLED_RESOURCES {
        let path = tmp.join(key);
        let got = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read back {}: {e}", path.display()));
        assert_eq!(&got, content, "content mismatch for {key}");
    }

    let _ = std::fs::remove_dir_all(&tmp);
}

/// Every asset file whose extension `build.rs` bundles must actually be in
/// `BUNDLED_RESOURCES` (or be the skill's own `SKILL.md`).
///
/// The bundler skips unknown extensions *silently*, so adding a helper in a
/// language nobody bundled before (`.cjs` for /soft-copyright was the first)
/// ships a SKILL.md whose scripts resolve to nothing at runtime. Filename
/// charset matters too — /soft-copyright's template and reference docs have
/// CJK names, which the regex-based reference tests above cannot see.
///
/// `ALLOWED_EXTS` is duplicated from `build.rs` (a build script's consts are
/// not importable). Drift is one-directional and safe: an extension added
/// there but not here only under-checks; one removed there fails loudly.
#[test]
fn every_bundleable_asset_file_is_actually_bundled() {
    use std::collections::HashSet;

    const ALLOWED_EXTS: &[&str] = &[
        "md", "py", "sh", "tex", "cls", "bst", "toml", "yaml", "yml", "json", "html", "cjs",
    ];
    const EXCLUDED_SKILL_PREFIX: &str = "skills-codex";
    // build.rs bundles these at key `<dir>/<rel>`, dropping the `skills/` segment.
    const SHARED_RESOURCE_DIRS: &[&str] = &["shared-references", "shared-governance"];
    // Only assets/tools/ and assets/skills/ are walked by build.rs. assets/prompts/
    // is `include_str!`d directly by prompt.rs, not routed through the cache.
    const UNBUNDLED_ROOTS: &[&str] = &["prompts/"];

    let assets = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("assets");
    let bundled_keys: HashSet<&'static str> =
        crate::BUNDLED_RESOURCES.iter().map(|(k, _)| *k).collect();
    let bundled_skills: HashSet<&'static str> =
        crate::BUNDLED_SKILLS.iter().map(|(n, _)| *n).collect();

    let mut missing: Vec<String> = Vec::new();
    for entry in walkdir::WalkDir::new(&assets).sort_by_file_name() {
        let entry = entry.expect("walk assets");
        if !entry.file_type().is_file() {
            continue;
        }
        let mut rel = entry
            .path()
            .strip_prefix(&assets)
            .expect("strip assets prefix")
            .to_string_lossy()
            .replace('\\', "/");

        if UNBUNDLED_ROOTS.iter().any(|root| rel.starts_with(root)) {
            continue;
        }

        let ext = entry
            .path()
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        if !ALLOWED_EXTS.contains(&ext) {
            continue;
        }

        // `skills/<name>/...` — the review-snapshot mirrors are excluded from
        // the bundle by design, and SKILL.md lands in BUNDLED_SKILLS instead.
        if let Some(under_skills) = rel.strip_prefix("skills/") {
            let Some((skill, sub)) = under_skills.split_once('/') else {
                continue; // loose file directly under assets/skills/
            };
            if skill.starts_with(EXCLUDED_SKILL_PREFIX) {
                continue;
            }
            if SHARED_RESOURCE_DIRS.contains(&skill) {
                rel = under_skills.to_string();
            } else if sub == "SKILL.md" {
                assert!(
                    bundled_skills.contains(skill),
                    "{rel} exists on disk but /{skill} is not in BUNDLED_SKILLS"
                );
                continue;
            }
        }

        if !bundled_keys.contains(rel.as_str()) {
            missing.push(rel);
        }
    }

    assert!(
        missing.is_empty(),
        "{} asset file(s) have a bundleable extension but are NOT in \
         BUNDLED_RESOURCES — check build.rs ALLOWED_EXTS and the 512KB cap:\n{}",
        missing.len(),
        missing
            .iter()
            .map(|k| format!("  {k}"))
            .collect::<Vec<_>>()
            .join("\n")
    );
}

/// v0.4.11 — verify the SKILLS_SOURCE_COMMIT file recorded by
/// `tools/sync_main_skills.sh` exists and looks like a valid 40-char
/// hex SHA.
///
/// If `origin/main` resolves (CI w/ `fetch-depth: 0`), also check
/// the pin is an ancestor of `origin/main` (warn-only — release
/// commits intentionally outpace the source-commit pin by one).
///
/// Hard-fails if the file is missing or malformed so the next
/// release can't ship a bundle of unknown provenance.
#[test]
fn skills_source_commit_pin_present_and_well_formed() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("assets")
        .join("SKILLS_SOURCE_COMMIT");
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|err| {
        panic!(
            "missing {} ({}). Run `bash tools/sync_main_skills.sh` first; \
             see idea-stage/v0.4.11/sync_plan.md",
            path.display(),
            err
        )
    });
    let commit = raw.trim();
    assert_eq!(
        commit.len(),
        40,
        "SKILLS_SOURCE_COMMIT must be a 40-char SHA, got {:?} ({} chars)",
        commit,
        commit.len()
    );
    assert!(
        commit.chars().all(|c| c.is_ascii_hexdigit()),
        "SKILLS_SOURCE_COMMIT must be lowercase hex, got {:?}",
        commit
    );

    // Best-effort: if git + origin/main is reachable, verify the pin
    // is an ancestor of origin/main. Skipped silently when the
    // current shell can't resolve origin/main (local dev, sandbox).
    let main_check = crate::hidden_command("git")
        .args(["rev-parse", "--verify", "--quiet", "origin/main"])
        .output();
    if let Ok(out) = main_check {
        if out.status.success() {
            let main_sha = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !main_sha.is_empty() && main_sha != commit {
                let ancestor = crate::hidden_command("git")
                    .args(["merge-base", "--is-ancestor", commit, &main_sha])
                    .status();
                if let Ok(status) = ancestor {
                    if !status.success() {
                        eprintln!(
                            "WARN: SKILLS_SOURCE_COMMIT {} is NOT an ancestor of \
                             origin/main {}. The skills bundle may be stale or \
                             diverged. Re-run sync_main_skills.sh before releasing.",
                            commit, main_sha
                        );
                    }
                }
            }
        }
    }
}

/// v0.4.11 — extended helper-reference resolver coverage.
///
/// Existing `bundle_inventory_skill_md_refs_resolve_to_bundled_resources`
/// covers `$ARIS_CACHE_DIR/...` and `python3 tools/...`. Main SKILL.md
/// also uses two more resolver layers which were previously uncovered:
///   - `.aris/tools/<helper>` (canonical resolver Layer 1)
///   - `${ARIS_REPO}/tools/<helper>` or `<ARIS_REPO>/tools/<helper>`
///     (resolver Layer 2 — user override / dev mode)
#[test]
fn skill_md_aris_tools_and_repo_refs_resolve_to_bundled() {
    use regex::Regex;
    use std::collections::HashSet;

    let bundled_keys: HashSet<&'static str> =
        crate::BUNDLED_RESOURCES.iter().map(|(k, _)| *k).collect();

    let aris_tools_re = Regex::new(
        r#"\.aris/(tools/[a-zA-Z0-9_./-]+\.(?:py|sh|tex|cls|bst|md|toml|yaml|yml|json))"#,
    )
    .expect("compile aris_tools_re");
    let repo_tools_re = Regex::new(
        r#"(?:\$\{?ARIS_REPO\}?|<ARIS_REPO>)/(tools/[a-zA-Z0-9_./-]+\.(?:py|sh|tex|cls|bst|md|toml|yaml|yml|json))"#,
    )
    .expect("compile repo_tools_re");

    let mut missing: Vec<(String, String)> = Vec::new();
    for (skill_name, content) in crate::BUNDLED_SKILLS {
        for cap in aris_tools_re.captures_iter(content) {
            let key = &cap[1];
            if !bundled_keys.contains(key) {
                missing.push((skill_name.to_string(), key.to_string()));
            }
        }
        for cap in repo_tools_re.captures_iter(content) {
            let key = &cap[1];
            if !bundled_keys.contains(key) {
                missing.push((skill_name.to_string(), key.to_string()));
            }
        }
    }

    assert!(
        missing.is_empty(),
        "SKILL.md references {} `.aris/tools/...` or `$ARIS_REPO/tools/...` \
         key(s) that are NOT in BUNDLED_RESOURCES:\n{}",
        missing.len(),
        missing
            .iter()
            .map(|(s, k)| format!("  /{s}: {k}"))
            .collect::<Vec<_>>()
            .join("\n")
    );
}

/// v0.4.11 — cross-skill references in SKILL.md should resolve to
/// other bundled skills. Warn-only (not hard fail) because SKILL.md
/// may intentionally mention not-yet-bundled or planned skills, and
/// we don't want to block emergency hot-fixes when main is mid-
/// refactor.
///
/// Run with `cargo test ... -- --nocapture` to see warning output.
#[test]
fn skill_md_cross_skill_references_bundled_warn_only() {
    use regex::Regex;
    use std::collections::HashSet;

    let bundled_names: HashSet<&'static str> =
        crate::BUNDLED_SKILLS.iter().map(|(n, _)| *n).collect();

    let re = Regex::new(
        r#"(?i)\b(?:Use|See|Via|The|Run|Invoke|Calls?|Runs?|Trigger)\s+`?/([a-z][a-z0-9-]+)`?(?P<after>\.?(?:\s+(?:skill|workflow|pipeline)\b|[\s,;:!?)）]|$))"#,
    )
    .expect("compile cross-skill regex");

    let mut unresolved: Vec<(&'static str, String)> = Vec::new();
    for (skill_name, content) in crate::BUNDLED_SKILLS {
        for cap in re.captures_iter(content) {
            let referenced = &cap[1];
            if !bundled_names.contains(referenced) {
                unresolved.push((*skill_name, referenced.to_string()));
            }
        }
    }

    if !unresolved.is_empty() {
        let mut seen: HashSet<(&'static str, String)> = HashSet::new();
        let mut summary: Vec<String> = Vec::new();
        for (s, r) in &unresolved {
            let key = (*s, r.clone());
            if seen.insert(key) {
                summary.push(format!("  /{}: -> /{}", s, r));
            }
        }
        eprintln!(
            "WARN: {} cross-skill reference(s) point to non-bundled \
             skill(s). This is allowed (roadmap mentions, mid-refactor), \
             but verify each before release:\n{}",
            summary.len(),
            summary.join("\n")
        );
    }
}
